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

const VERT = `
precision highp float;
uniform mat4 u_matrix;
attribute vec2 a_pos;
attribute vec4 a_color;
varying vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform float u_opacity;
varying vec4 v_color;
void main() {
  // premultiply nothing -- straight alpha, scaled by the layer opacity
  gl_FragColor = vec4(v_color.rgb, v_color.a * u_opacity);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("[nexrad-gl]", gl.getShaderInfoLog(s));
  }
  return s;
}

export class NexradGlLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private posBuf: WebGLBuffer | null = null;
  private colBuf: WebGLBuffer | null = null;
  private aPos = 0;
  private aColor = 0;
  private uMatrix: WebGLUniformLocation | null = null;
  private uOpacity: WebGLUniformLocation | null = null;
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
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    this.program = program;
    this.aPos = gl.getAttribLocation(program, "a_pos");
    this.aColor = gl.getAttribLocation(program, "a_color");
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.uOpacity = gl.getUniformLocation(program, "u_opacity");
    this.posBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
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
    if (this.program) gl.deleteProgram(this.program);
    this.gl = null;
    this.program = null;
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

  render(gl: WebGLRenderingContext, args: CustomRenderMethodInput): void {
    if (!this.program || this.count === 0) return;
    gl.useProgram(this.program);
    // maplibre v5 hands the MVP in via the render args, not a bare matrix
    gl.uniformMatrix4fv(this.uMatrix, false, args.defaultProjectionData.mainMatrix);
    gl.uniform1f(this.uOpacity, this.opacity);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.enableVertexAttribArray(this.aColor);
    // normalised bytes -> vec4 in 0..1
    gl.vertexAttribPointer(this.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
}
