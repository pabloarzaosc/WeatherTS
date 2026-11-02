/**
 * The 3D view's WebGL2 renderer: the voxel box as a 3D texture, ray marched
 * at a reduced render scale and brought up to the canvas with a sharpening
 * filter, plus the box's hairlines. Draws on demand (the panel asks for a
 * frame when something changed); `capture` draws one full-scale frame and
 * reads it back for an export.
 */
import { eyeOf, invert, lookAt, multiply, perspective, type OrbitCamera, type SceneBox, type Vec3 } from "./camera";
import { FULLSCREEN_VS, LINE_FS, LINE_VS, MAX_FLASHES, UPSCALE_FS, VOLUME_FS } from "./shaders";
import type { Lighting } from "./sun";
import type { Volume3D } from "./volume";

export type Style3D = "storm" | "radar";

export interface FlashLight {
  /** Box frame, km; z above the radar's ground (not stretched). */
  x: number;
  y: number;
  z: number;
  intensity: number;
}

export interface RenderParams {
  style: Style3D;
  vScale: number;
  renderScale: number;
  sharpen: number;
  light: Lighting;
  cloudEdge: number;
  cloudBase: number;
  density: number;
  exposure: number;
  opacity: number;
  cone: boolean;
  flashes: FlashLight[];
  /** Sunbeams through the haze (storm look). */
  shafts: boolean;
  /** The map picture under the box (when one is loaded). */
  showGround: boolean;
  /** The vertical cut, or null. */
  cut: CutParams | null;
  bg: [number, number, number];
  ground: [number, number, number];
  grid: [number, number, number];
  line: [number, number, number, number];
}

/** A vertical plane: unit normal (nx, ny) on the ground, offset d (km) of
 *  the plane from the box centre along it. */
export interface CutParams {
  nx: number;
  ny: number;
  d: number;
  away: boolean;
  opacity: number;
}

const BRICK = 4;
/** Frames the still camera averages (jittered each time). */
export const ACCUM_FRAMES = 12;
const NOISE = 32;

/** Tiling value noise (a few octaves) for cloud billows and rain streaks. */
function makeNoise(): Uint8Array {
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out = new Float32Array(NOISE * NOISE * NOISE);
  const octaves: [number, number][] = [[4, 0.5], [8, 0.3], [16, 0.2]];
  for (const [P, wgt] of octaves) {
    const lat = new Float32Array(P * P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const L = (x: number, y: number, z: number) => lat[(((z % P) + P) % P) * P * P + (((y % P) + P) % P) * P + (((x % P) + P) % P)];
    const sm = (t: number) => t * t * (3 - 2 * t);
    for (let z = 0; z < NOISE; z++) {
      for (let y = 0; y < NOISE; y++) {
        for (let x = 0; x < NOISE; x++) {
          const fx = (x / NOISE) * P;
          const fy = (y / NOISE) * P;
          const fz = (z / NOISE) * P;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const iz = Math.floor(fz);
          const tx = sm(fx - ix);
          const ty = sm(fy - iy);
          const tz = sm(fz - iz);
          const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
          const v = lerp(
            lerp(lerp(L(ix, iy, iz), L(ix + 1, iy, iz), tx), lerp(L(ix, iy + 1, iz), L(ix + 1, iy + 1, iz), tx), ty),
            lerp(lerp(L(ix, iy, iz + 1), L(ix + 1, iy, iz + 1), tx), lerp(L(ix, iy + 1, iz + 1), L(ix + 1, iy + 1, iz + 1), tx), ty),
            tz,
          );
          out[(z * NOISE + y) * NOISE + x] += v * wgt;
        }
      }
    }
  }
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(out[i] * 255)));
  return bytes;
}

/** A low-discrepancy sub-pixel offset for frame n of the average (Halton 2, 3). */
function halton(n: number, b: number): number {
  let f = 1;
  let r = 0;
  let i = n;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

export interface GroundGeo {
  center: [number, number];
  merc: [number, number, number, number];
  halfKm: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`3D view shader: ${log}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`3D view program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Uniforms {
  const out: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    out[name] = gl.getUniformLocation(p, info.name);
  }
  return out;
}

export interface VolumeInfo {
  hx: number;
  hy: number;
  topKm: number;
  radar: [number, number];
  /** Heart of the strongest echo (km, z real), or null without echo. */
  core: Vec3 | null;
  /** Value at code 1 and code 254. */
  valRange: [number, number];
}

/** Pack the codes for the GPU: r = value x echo (0-255 over codes 1..254),
 *  g = echo, b = seen. Linear filtering then gives r/g = the mean of the
 *  echoing neighbours, g = how much echo, b = how much was seen. */
export function packVolume(codes: Uint8Array): Uint8Array {
  const out = new Uint8Array(codes.length * 4);
  const scale = 255 / 253;
  for (let i = 0, o = 0; i < codes.length; i++, o += 4) {
    const c = codes[i];
    if (c === 255) continue;
    out[o + 2] = 255;
    if (c > 0) {
      out[o] = Math.round((c - 1) * scale);
      out[o + 1] = 255;
    }
  }
  return out;
}

/** Bricks of 4^3 voxels: r = the highest code seen in the brick and its
 *  neighbours, g = 255 when any of them was not seen. */
export function buildOccupancy(codes: Uint8Array, nx: number, ny: number, nz: number): { data: Uint8Array; bx: number; by: number; bz: number } {
  const bx = Math.ceil(nx / BRICK);
  const by = Math.ceil(ny / BRICK);
  const bz = Math.ceil(nz / BRICK);
  const raw = new Uint8Array(bx * by * bz * 2);
  for (let k = 0; k < nz; k++) {
    const kb = (k / BRICK) | 0;
    for (let j = 0; j < ny; j++) {
      const jb = (j / BRICK) | 0;
      const row = (k * ny + j) * nx;
      const brow = (kb * by + jb) * bx;
      for (let i = 0; i < nx; i++) {
        const c = codes[row + i];
        if (c === 0) continue;
        const o = (brow + ((i / BRICK) | 0)) * 2;
        if (c === 255) raw[o + 1] = 255;
        else if (c > raw[o]) raw[o] = c;
      }
    }
  }
  // Dilate by one brick: a sample near a brick's edge filters in its neighbour.
  const data = new Uint8Array(raw.length);
  for (let k = 0; k < bz; k++) {
    for (let j = 0; j < by; j++) {
      for (let i = 0; i < bx; i++) {
        let m = 0;
        let u = 0;
        for (let dk = -1; dk <= 1; dk++) {
          const kk = k + dk;
          if (kk < 0 || kk >= bz) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= by) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= bx) continue;
              const o = ((kk * by + jj) * bx + ii) * 2;
              if (raw[o] > m) m = raw[o];
              if (raw[o + 1] > u) u = raw[o + 1];
            }
          }
        }
        const o = ((k * by + j) * bx + i) * 2;
        data[o] = m;
        data[o + 1] = u;
      }
    }
  }
  return { data, bx, by, bz };
}

/** The strongest echo's heart: the centroid of the voxels near the top of the
 *  box's values (reflectivity), or of all echo for other moments. */
function findCore(v: Volume3D): Vec3 | null {
  const h = v.header;
  const { nx, ny, nz } = h;
  const codes = v.codes;
  let max = 0;
  for (let i = 0; i < codes.length; i++) if (codes[i] !== 255 && codes[i] > max) max = codes[i];
  if (max === 0) return null;
  const isRef = h.kind === "ref";
  const lo = isRef ? Math.max(1, max - Math.round(15 / ((h.vmax - h.vmin) / 253))) : 1;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const c = codes[row + i];
        if (c === 0 || c === 255 || c < lo) continue;
        sx += i;
        sy += j;
        sz += k;
        n++;
      }
    }
  }
  if (!n) return null;
  return [
    -h.halfXKm + ((sx / n + 0.5) * 2 * h.halfXKm) / nx,
    -h.halfYKm + ((sy / n + 0.5) * 2 * h.halfYKm) / ny,
    (sz / n + 0.5) * h.dzKm,
  ];
}

export class Radar3DRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private volProg: WebGLProgram;
  private upProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private volU: Uniforms;
  private upU: Uniforms;
  private lineU: Uniforms;
  private vao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private volTex: WebGLTexture | null = null;
  private occTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture;
  private noiseTex: WebGLTexture;
  private groundTex: WebGLTexture;
  private groundGeo: GroundGeo | null = null;
  private sceneFloat = false;
  private sceneFbo: WebGLFramebuffer;
  private sceneTex: WebGLTexture;
  private sceneW = 0;
  private sceneH = 0;
  private bricks: [number, number, number] = [1, 1, 1];
  info: VolumeInfo | null = null;
  lost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("This computer's graphics do not offer WebGL2, which the 3D view needs.");
    this.gl = gl;
    this.volProg = program(gl, FULLSCREEN_VS, VOLUME_FS);
    this.upProg = program(gl, FULLSCREEN_VS, UPSCALE_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.volU = uniforms(gl, this.volProg);
    this.upU = uniforms(gl, this.upProg);
    this.lineU = uniforms(gl, this.lineProg);
    this.vao = gl.createVertexArray()!;
    this.lineVao = gl.createVertexArray()!;
    this.lineBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    const loc = gl.getAttribLocation(this.lineProg, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(2048));

    this.noiseTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, NOISE, NOISE, NOISE, 0, gl.RED, gl.UNSIGNED_BYTE, makeNoise());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);

    this.groundTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.groundTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // The still-camera average wants more than 8 bits per channel.
    this.sceneFloat = !!gl.getExtension("EXT_color_buffer_float");

    this.sceneTex = gl.createTexture()!;
    this.sceneFbo = gl.createFramebuffer()!;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  setVolume(v: Volume3D): VolumeInfo {
    const gl = this.gl;
    const h = v.header;
    const packed = packVolume(v.codes);
    if (!this.volTex) this.volTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, h.nx, h.ny, h.nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed);
    // Mips: the storm look samples a little above level 0 (a softer cloud)
    // and a coarse level for how much storm surrounds a point.
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);

    const occ = buildOccupancy(v.codes, h.nx, h.ny, h.nz);
    if (!this.occTex) this.occTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.occTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, occ.bx, occ.by, occ.bz, 0, gl.RG, gl.UNSIGNED_BYTE, occ.data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.bricks = [occ.bx, occ.by, occ.bz];

    this.info = {
      hx: h.halfXKm,
      hy: h.halfYKm,
      topKm: h.topKm,
      radar: [h.radarXKm, h.radarYKm],
      core: findCore(v),
      valRange: [h.lut[1] ?? h.vmin, h.lut[254] ?? h.vmax],
    };
    return this.info;
  }

  /** Forget the volume (a new box is on its way) and clear the canvas. */
  clear(bg: [number, number, number]): void {
    this.info = null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  setLut(rgba: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 2, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  /** The map picture under the box (null: none). */
  setGround(img: HTMLCanvasElement | null, geo: GroundGeo | null): void {
    const gl = this.gl;
    if (!img || !geo) {
      this.groundGeo = null;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.groundTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
    this.groundGeo = geo;
  }

  /** The largest picture this context takes. */
  maxTexture(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  /** The box in display space for camera presets. */
  sceneBox(vScale: number): SceneBox | null {
    const i = this.info;
    if (!i) return null;
    return {
      hx: i.hx,
      hy: i.hy,
      top: i.topKm * vScale,
      radar: [i.radar[0], i.radar[1], 0],
      core: i.core ? [i.core[0], i.core[1], i.core[2] * vScale] : null,
    };
  }

  /** Sizes the scene texture; true when it was (re)made (its average is gone). */
  private ensureScene(w: number, h: number): boolean {
    if (w === this.sceneW && h === this.sceneH) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    if (this.sceneFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
    if (this.sceneFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.sceneFloat = false;
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sceneW = w;
    this.sceneH = h;
    return true;
  }

  /** One frame into `target` (null = the canvas) of w x h pixels. `frame` > 0
   *  blends this jittered frame into the average of the ones before (weight
   *  1 / (frame + 1), never under `minWeight`); returns the frame drawn (0
   *  when the average had to restart). */
  private draw(target: WebGLFramebuffer | null, w: number, h: number, cam: OrbitCamera, p: RenderParams, scale: number, frame = 0, minWeight = 0): number {
    const gl = this.gl;
    const info = this.info;
    if (!info || !this.volTex || !this.occTex || this.lost) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, w, h);
      gl.clearColor(p.bg[0], p.bg[1], p.bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return 0;
    }
    const sw = Math.max(16, Math.round(w * scale));
    const sh = Math.max(16, Math.round(h * scale));
    if (this.ensureScene(sw, sh)) frame = 0;
    const eye = eyeOf(cam);
    const view = lookAt(eye, cam.target);
    const span = Math.max(info.hx, info.hy, info.topKm * p.vScale);
    const proj = perspective(cam.fovDeg, w / h, Math.max(0.02, cam.distance * 0.002), cam.distance + span * 30);
    const vp = multiply(proj, view);
    const inv = invert(vp);
    if (!inv) return 0;
    const top = info.topKm * p.vScale;

    // Pass 1: the march, at the render scale.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, sw, sh);
    const weight = frame > 0 ? Math.max(minWeight, 1 / (frame + 1)) : 1;
    if (weight < 1) {
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, weight);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.useProgram(this.volProg);
    const u = this.volU;
    gl.uniformMatrix4fv(u.uInvViewProj, false, inv);
    gl.uniform3fv(u.uEye, eye);
    gl.uniform3f(u.uBox, info.hx, info.hy, top);
    gl.uniform3f(u.uBricks, this.bricks[0], this.bricks[1], this.bricks[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.uniform1i(u.uVol, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.occTex);
    gl.uniform1i(u.uOcc, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u.uLut, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
    gl.uniform1i(u.uNoise, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.groundTex);
    gl.uniform1i(u.uGroundTex, 4);
    const g = p.showGround ? this.groundGeo : null;
    gl.uniform1f(u.uGroundOn, g ? 1 : 0);
    gl.uniform2f(u.uGeoCenter, g ? g.center[0] : 0, g ? g.center[1] : 0);
    gl.uniform4f(u.uGeoMerc, g ? g.merc[0] : 0, g ? g.merc[1] : 1, g ? g.merc[2] : 0, g ? g.merc[3] : 1);
    gl.uniform1f(u.uGroundHalf, g ? g.halfKm : 1);
    const c = p.cut;
    gl.uniform4f(u.uCut, c ? c.nx : 1, c ? c.ny : 0, c ? c.d : 0, c ? 1 : 0);
    gl.uniform2f(u.uCutMode, c?.away ? 1 : 0, c ? c.opacity : 0);
    gl.uniform1f(u.uShafts, p.shafts ? 1 : 0);
    gl.uniform1f(u.uFrame, frame);
    gl.uniform2f(u.uJitter, frame > 0 ? ((halton(frame, 2) - 0.5) * 2) / sw : 0, frame > 0 ? ((halton(frame, 3) - 0.5) * 2) / sh : 0);
    gl.uniform1i(u.uStyle, p.style === "storm" ? 0 : 1);
    gl.uniform2f(u.uValRange, info.valRange[0], info.valRange[1]);
    gl.uniform1f(u.uVScale, p.vScale);
    // About half a voxel per step (voxels are 0.25-1.25 km across).
    const hStep = Math.min((2 * info.hx) / (this.bricks[0] * BRICK), (2 * info.hy) / (this.bricks[1] * BRICK));
    const vStep = (info.topKm / (this.bricks[2] * BRICK)) * p.vScale;
    gl.uniform1f(u.uStep, Math.max(0.12, 0.6 * Math.min(hStep, vStep * 1.5)));
    // Bricks whose strongest echo cannot draw are skipped.
    let skip = 0.5 / 255;
    if (p.style === "storm") {
      const [v0, v1] = info.valRange;
      const need = Math.min(p.cloudEdge - 5, 24);
      const code = 1 + ((need - v0) / (v1 - v0 || 1)) * 253;
      skip = Math.max(0.5, Math.min(254, code)) / 255;
    }
    gl.uniform1f(u.uSkip, skip);
    gl.uniform1f(u.uCone, p.cone ? 1 : 0);
    gl.uniform3fv(u.uSunDir, p.light.dir);
    gl.uniform3fv(u.uSunColor, p.light.color);
    gl.uniform3fv(u.uAmbient, p.light.ambient);
    gl.uniform3fv(u.uZenith, p.light.zenith);
    gl.uniform3fv(u.uHorizon, p.light.horizon);
    gl.uniform1f(u.uCloudEdge, p.cloudEdge);
    gl.uniform1f(u.uCloudBase, p.cloudBase);
    gl.uniform1f(u.uDensity, p.density);
    gl.uniform1f(u.uExposure, p.exposure);
    const fl = new Float32Array(MAX_FLASHES * 4);
    const nf = Math.min(MAX_FLASHES, p.flashes.length);
    for (let i = 0; i < nf; i++) {
      const f = p.flashes[i];
      fl.set([f.x, f.y, f.z * p.vScale, f.intensity], i * 4);
    }
    gl.uniform4fv(u.uFlash, fl);
    gl.uniform1i(u.uFlashCount, nf);
    gl.uniform3f(u.uRadar, info.radar[0], info.radar[1], 0);
    gl.uniform3fv(u.uBg, p.bg);
    gl.uniform3fv(u.uGround, p.ground);
    gl.uniform3fv(u.uGrid, p.grid);
    gl.uniform1f(u.uOpacity, p.opacity);
    gl.uniform1f(u.uLod, p.style === "storm" ? 0.55 : 0);
    gl.uniform1f(u.uGridKm, span > 120 ? 50 : span > 40 ? 10 : 5);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);

    // Pass 2: up to full size, sharpened.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.upProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.upU.uSrc, 0);
    gl.uniform2f(this.upU.uTexel, 1 / sw, 1 / sh);
    gl.uniform1f(this.upU.uSharp, scale < 0.999 ? p.sharpen : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: the box's edges and the radar's mast, as hairlines.
    const { hx, hy } = info;
    const [rx, ry] = info.radar;
    const pts = [
      -hx, -hy, top, hx, -hy, top, hx, -hy, top, hx, hy, top, hx, hy, top, -hx, hy, top, -hx, hy, top, -hx, -hy, top,
      -hx, -hy, 0, -hx, -hy, top, hx, -hy, 0, hx, -hy, top, hx, hy, 0, hx, hy, top, -hx, hy, 0, -hx, hy, top,
    ];
    if (Math.abs(rx) <= hx && Math.abs(ry) <= hy) pts.push(rx, ry, 0, rx, ry, Math.min(top, 1.2 * p.vScale));
    gl.useProgram(this.lineProg);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(this.lineU.uViewProj, false, vp);
    gl.uniform4fv(this.lineU.uColor, p.line);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, pts.length / 3);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return frame;
  }

  /** Draw a frame on the canvas. */
  render(cam: OrbitCamera, p: RenderParams, frame = 0, minWeight = 0): number {
    return this.draw(null, this.canvas.width, this.canvas.height, cam, p, p.renderScale, frame, minWeight);
  }

  /** Draw one full-scale frame of w x h and read it back (rows top first). */
  capture(cam: OrbitCamera, p: RenderParams, w: number, h: number): ImageData {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // A few jittered frames averaged: no grain in the picture kept.
    for (let f = 0; f < 8; f++) this.draw(fbo, w, h, cam, p, 1, f);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }

  /** Average time of n frames at the current size, each waited for (a
   *  one-pixel read back: gl.finish does not block in Chrome). */
  benchmark(cam: OrbitCamera, p: RenderParams, n = 20): number {
    const gl = this.gl;
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.render(cam, p);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      this.render({ ...cam, yaw: cam.yaw + i * 2 }, p);
      sync();
    }
    return (performance.now() - t0) / n;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.volTex) gl.deleteTexture(this.volTex);
    if (this.occTex) gl.deleteTexture(this.occTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.noiseTex);
    gl.deleteTexture(this.groundTex);
    gl.deleteTexture(this.sceneTex);
    gl.deleteFramebuffer(this.sceneFbo);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteProgram(this.volProg);
    gl.deleteProgram(this.upProg);
    gl.deleteProgram(this.lineProg);
    // No loseContext(): React's development double mount hands the same
    // canvas (and so the same context) to a second renderer straight away.
  }
}
