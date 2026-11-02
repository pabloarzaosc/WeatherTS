import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import type { RadarMesh } from "../lib/radarMesh";

// MapLibre custom WebGL layer that draws the radar mesh. Colour is baked into
// each vertex, so the shaders are a pass-through and a palette change is just a
// buffer re-upload -- no re-render on the server.
// Technique adapted from SparkRadar (c) Tyler G (@tgranz), used with permission.

/**
 * The vertex shader for one projection.
 *
 * The mesh is in Web Mercator (0..1) and used to be multiplied straight by the
 * projection matrix. That only means anything under Mercator: on the globe the
 * same matrix projects a unit sphere, so those numbers put the scan nowhere
 * near Earth and the radar was simply missing. MapLibre gives custom layers
 * its own projection code for exactly this -- `projectTile`, which takes a
 * mercator 0..1 position under either projection -- plus a define naming the
 * projection. With it the scan follows the map onto the globe and back,
 * including the blend MapLibre runs between the two while zooming.
 */
const vertexSource = (shader: CustomRenderMethodInput["shaderData"]) => `
precision highp float;
${shader.define}
${shader.vertexShaderPrelude}
attribute vec2 a_pos;
attribute vec4 a_color;
attribute float a_value;
varying vec4 v_color;
varying float v_value;
void main() {
  v_color = a_color;
  v_value = a_value;
  gl_Position = projectTile(a_pos);
}`;

const FRAG = `
precision highp float;
uniform float u_opacity;
// Flash reflectivity (display-opts): gates at or above u_flashMin take the
// flash colour, mixed by its opacity, while u_flashOn is set (half of every
// second -- the blink is the layer redrawing with it on, then off).
uniform float u_flashOn;
uniform float u_flashMin;
uniform vec4 u_flashColor;
varying vec4 v_color;
varying float v_value;
void main() {
  vec3 rgb = v_color.rgb;
  if (u_flashOn > 0.5 && v_value >= u_flashMin) rgb = mix(rgb, u_flashColor.rgb, u_flashColor.a);
  // premultiply nothing -- straight alpha, scaled by the layer opacity
  gl_FragColor = vec4(rgb, v_color.a * u_opacity);
}`;

interface Program {
  program: WebGLProgram;
  aPos: number;
  aColor: number;
  aValue: number;
  uFlashOn: WebGLUniformLocation | null;
  uFlashMin: WebGLUniformLocation | null;
  uFlashColor: WebGLUniformLocation | null;
  // Null where a projection's shader has no such uniform (Mercator uses only
  // the matrix); setting a null location is a no-op in WebGL.
  uMatrix: WebGLUniformLocation | null;
  uFallback: WebGLUniformLocation | null;
  uTileMercator: WebGLUniformLocation | null;
  uClipping: WebGLUniformLocation | null;
  uTransition: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("[nexrad-gl]", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function link(gl: WebGLRenderingContext, shader: CustomRenderMethodInput["shaderData"]): Program | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource(shader));
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = vs && fs ? gl.createProgram() : null;
  if (!program) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs!);
  gl.attachShader(program, fs!);
  gl.linkProgram(program);
  // Flagged for deletion now; they go when the program does.
  gl.deleteShader(vs!);
  gl.deleteShader(fs!);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("[nexrad-gl]", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    aPos: gl.getAttribLocation(program, "a_pos"),
    aColor: gl.getAttribLocation(program, "a_color"),
    aValue: gl.getAttribLocation(program, "a_value"),
    uFlashOn: gl.getUniformLocation(program, "u_flashOn"),
    uFlashMin: gl.getUniformLocation(program, "u_flashMin"),
    uFlashColor: gl.getUniformLocation(program, "u_flashColor"),
    uMatrix: gl.getUniformLocation(program, "u_projection_matrix"),
    uFallback: gl.getUniformLocation(program, "u_projection_fallback_matrix"),
    uTileMercator: gl.getUniformLocation(program, "u_projection_tile_mercator_coords"),
    uClipping: gl.getUniformLocation(program, "u_projection_clipping_plane"),
    uTransition: gl.getUniformLocation(program, "u_projection_transition"),
    uOpacity: gl.getUniformLocation(program, "u_opacity"),
  };
}

/** Flash reflectivity: gates >= min blink in this colour (alpha = its opacity). */
export interface FlashStyle {
  min: number;
  rgba: [number, number, number, number];
}

// One clock for every flashing layer: each half second the phase flips and
// the maps showing a flash redraw.
const flashing = new Set<NexradGlLayer>();
let flashTimer: ReturnType<typeof setInterval> | null = null;
let flashPhase = false;
const phaseNow = () => Math.floor(performance.now() / 500) % 2 === 0;
function flashTick() {
  const ph = phaseNow();
  if (ph === flashPhase) return;
  flashPhase = ph;
  for (const l of flashing) l.repaint();
}
function trackFlash(l: NexradGlLayer, on: boolean) {
  if (on) flashing.add(l);
  else flashing.delete(l);
  if (flashing.size && !flashTimer) flashTimer = setInterval(flashTick, 100);
  else if (!flashing.size && flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
}

export class NexradGlLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  // One program per projection variant, compiled the first time that variant
  // is drawn. `null` records a variant that failed, so it is not retried (and
  // logged) on every frame.
  private programs = new Map<string, Program | null>();
  private posBuf: WebGLBuffer | null = null;
  private colBuf: WebGLBuffer | null = null;
  /** Per-vertex values, uploaded only while this layer flashes. */
  private valBuf: WebGLBuffer | null = null;
  private valuesOf: RadarMesh | null = null;
  private flash: FlashStyle | null = null;
  private count = 0;
  private pending: RadarMesh | null = null;
  // The mesh currently uploaded to the GPU. The store bumps meshRev on every
  // frame, but with the mesh cache a scrubbed-back or looping frame hands back
  // the SAME object -- re-uploading its ~12 MB of buffers then was pure waste
  // and a big part of the per-frame stall. Skip when the object is unchanged.
  private uploaded: RadarMesh | null = null;
  private opacity = 1;

  constructor(id = "nexrad-gl") {
    this.id = id;
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.posBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
    this.valBuf = gl.createBuffer();
    if (this.flash) trackFlash(this, true);
    if (this.pending) {
      const m = this.pending;
      this.pending = null;
      this.setMesh(m);
    }
  }

  onRemove(): void {
    const gl = this.gl;
    this.map = null;
    if (!gl) return;
    if (this.posBuf) gl.deleteBuffer(this.posBuf);
    if (this.colBuf) gl.deleteBuffer(this.colBuf);
    if (this.valBuf) gl.deleteBuffer(this.valBuf);
    trackFlash(this, false);
    this.valuesOf = null;
    this.valBuf = null;
    for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program);
    this.programs.clear();
    this.gl = null;
    this.posBuf = null;
    this.colBuf = null;
    this.count = 0;
    // The GL buffers are gone, so the next add must re-upload even the same mesh.
    this.uploaded = null;
  }

  /** Upload geometry + colour (called on a new scan). */
  setMesh(mesh: RadarMesh | null): void {
    const gl = this.gl;
    if (!gl) {
      this.pending = mesh; // layer not added yet
      return;
    }
    if (!mesh) {
      this.uploaded = null;
      this.count = 0;
      this.map?.triggerRepaint();
      return;
    }
    // Same object already on the GPU (a cache hit re-shown): nothing to upload,
    // just make sure it's drawn.
    if (mesh === this.uploaded) {
      this.map?.triggerRepaint();
      return;
    }
    this.uploaded = mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    this.count = mesh.vertexCount;
    if (this.flash) this.uploadValues();
    this.map?.triggerRepaint();
  }

  /** The uploaded mesh's values, for the flash test in the shader. */
  private uploadValues(): void {
    const gl = this.gl;
    const m = this.uploaded;
    if (!gl || !this.valBuf || !m || m === this.valuesOf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valBuf);
    gl.bufferData(gl.ARRAY_BUFFER, m.values.subarray(0, m.vertexCount), gl.STATIC_DRAW);
    this.valuesOf = m;
  }

  /** Flash reflectivity on (a style) or off (null). */
  setFlash(style: FlashStyle | null): void {
    const same = JSON.stringify(style) === JSON.stringify(this.flash);
    this.flash = style;
    if (this.gl) trackFlash(this, !!style);
    if (style) this.uploadValues();
    if (!same) this.map?.triggerRepaint();
  }

  /** Redraw (the flash clock). */
  repaint(): void {
    this.map?.triggerRepaint();
  }

  /** Re-upload only the colours (the instant palette swap). */
  setColors(mesh: RadarMesh): void {
    const gl = this.gl;
    if (!gl || !this.colBuf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    this.map?.triggerRepaint();
  }

  setOpacity(o: number): void {
    this.opacity = Math.max(0, Math.min(1, o));
    this.map?.triggerRepaint();
  }

  /**
   * panes-compare: draw only between two shares of the canvas width (the
   * pane's product left of the divider, the compared one right of it); null
   * draws everywhere. A scissor box, so nothing outside it is even shaded.
   */
  private clip: [number, number] | null = null;
  setClip(clip: [number, number] | null): void {
    const same = clip === this.clip || (!!clip && !!this.clip && clip[0] === this.clip[0] && clip[1] === this.clip[1]);
    this.clip = clip;
    if (!same) this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext, args: CustomRenderMethodInput): void {
    if (this.count === 0) return;
    const clip = this.clip;
    if (clip) {
      const w = gl.drawingBufferWidth;
      const x0 = Math.round(Math.max(0, Math.min(1, clip[0])) * w);
      const x1 = Math.round(Math.max(0, Math.min(1, clip[1])) * w);
      if (x1 <= x0) return;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, 0, x1 - x0, gl.drawingBufferHeight);
    }
    try {
      this.draw(gl, args);
    } finally {
      // MapLibre keeps the scissor test off and never caches it.
      if (clip) gl.disable(gl.SCISSOR_TEST);
    }
  }

  private draw(gl: WebGLRenderingContext, args: CustomRenderMethodInput): void {
    const variant = args.shaderData.variantName;
    if (!this.programs.has(variant)) this.programs.set(variant, link(gl, args.shaderData));
    const p = this.programs.get(variant);
    if (!p) return;

    const proj = args.defaultProjectionData;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uMatrix, false, proj.mainMatrix);
    gl.uniformMatrix4fv(p.uFallback, false, proj.fallbackMatrix);
    gl.uniform4f(p.uTileMercator, ...proj.tileMercatorCoords);
    gl.uniform4f(p.uClipping, ...proj.clippingPlane);
    gl.uniform1f(p.uTransition, proj.projectionTransition);
    gl.uniform1f(p.uOpacity, this.opacity);
    const fl = this.flash;
    const flashNow = !!fl && this.valuesOf === this.uploaded && p.aValue >= 0 && phaseNow();
    gl.uniform1f(p.uFlashOn, flashNow ? 1 : 0);
    if (fl) {
      gl.uniform1f(p.uFlashMin, fl.min);
      gl.uniform4f(p.uFlashColor, ...fl.rgba);
    }
    if (p.aValue >= 0) {
      if (flashNow) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.valBuf);
        gl.enableVertexAttribArray(p.aValue);
        gl.vertexAttribPointer(p.aValue, 1, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(p.aValue);
        gl.vertexAttrib1f(p.aValue, -1e9);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.enableVertexAttribArray(p.aColor);
    // normalised bytes -> vec4 in 0..1
    gl.vertexAttribPointer(p.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);

    // Leave the attribute slots as MapLibre expects to find them.
    gl.disableVertexAttribArray(p.aPos);
    gl.disableVertexAttribArray(p.aColor);
    if (p.aValue >= 0) gl.disableVertexAttribArray(p.aValue);
  }
}
