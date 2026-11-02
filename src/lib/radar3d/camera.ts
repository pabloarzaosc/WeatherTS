/**
 * The 3D view's camera: an orbit around a target point in the box frame
 * (km; x east, y north, z up -- z already stretched by the vertical scale).
 * Yaw is the compass direction the camera looks toward; pitch is how far it
 * looks down (negative looks up).
 */

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

const RAD = Math.PI / 180;

export interface OrbitCamera {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  fovDeg: number;
}

export function eyeOf(c: OrbitCamera): Vec3 {
  const y = c.yaw * RAD;
  const p = c.pitch * RAD;
  // Looking toward `yaw`, down by `pitch`: the eye sits behind and above.
  const fx = Math.cos(p) * Math.sin(y);
  const fy = Math.cos(p) * Math.cos(y);
  const fz = -Math.sin(p);
  return [c.target[0] - fx * c.distance, c.target[1] - fy * c.distance, c.target[2] - fz * c.distance];
}

/** Aim the orbit so its eye is at `eye`, looking at `target`. */
export function lookFrom(eye: Vec3, target: Vec3, fovDeg: number): OrbitCamera {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const distance = Math.max(0.5, Math.hypot(dx, dy, dz));
  const yaw = Math.atan2(dx, dy) / RAD;
  const pitch = -Math.asin(Math.max(-1, Math.min(1, dz / distance))) / RAD;
  return { target, distance, yaw, pitch, fovDeg };
}

export function perspective(fovDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDeg * RAD) / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** View matrix with z up. */
export function lookAt(eye: Vec3, target: Vec3): Mat4 {
  const f = norm(sub(target, eye));
  let up: Vec3 = [0, 0, 1];
  if (Math.abs(dot(f, up)) > 0.999) up = [0, 1, 0];
  const s = norm(cross(f, up));
  const u = cross(s, f);
  const m = new Float32Array(16);
  m[0] = s[0];
  m[4] = s[1];
  m[8] = s[2];
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[12] = -dot(s, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  }
  return o;
}

export function invert(m: Mat4): Mat4 | null {
  const inv = new Float32Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

/** A box's extents for the presets: half sizes (km) and its displayed top. */
export interface SceneBox {
  hx: number;
  hy: number;
  top: number;
  radar: Vec3;
  /** The heart of the strongest echo, if any (display frame). */
  core: Vec3 | null;
}

export type CameraPreset = "overview" | "ground" | "radar";

export function presetCamera(p: CameraPreset, box: SceneBox, fovDeg: number): OrbitCamera {
  const span = Math.max(box.hx, box.hy);
  const focus: Vec3 = box.core ? [box.core[0], box.core[1], Math.min(box.top * 0.35, 4)] : [0, 0, box.top * 0.2];
  if (p === "overview") {
    return { target: [0, 0, box.top * 0.15], distance: span * 2.6, yaw: 25, pitch: 38, fovDeg };
  }
  if (p === "ground") {
    // Standing on the ground south-southwest of the storm, looking up at it.
    const d = span * 1.5;
    const yaw = 20;
    const eye: Vec3 = [focus[0] - Math.sin(yaw * RAD) * d, focus[1] - Math.cos(yaw * RAD) * d, 0.25];
    return lookFrom(eye, [focus[0], focus[1], box.top * 0.28], fovDeg);
  }
  // From the radar: its antenna, looking at the storm (or across the box when
  // the radar sits in the middle of it).
  const r = box.radar;
  let tgt: Vec3 = [focus[0], focus[1], box.top * 0.2];
  if (Math.hypot(tgt[0] - r[0], tgt[1] - r[1]) < span * 0.15) tgt = [r[0], r[1] + span * 0.8, box.top * 0.15];
  // A few km behind the antenna and a little above it, so the view is the
  // radar's own line of sight rather than the inside of the rain around it.
  const dx = tgt[0] - r[0];
  const dy = tgt[1] - r[1];
  const l = Math.hypot(dx, dy) || 1;
  const back = Math.min(6, span * 0.12);
  return lookFrom([r[0] - (dx / l) * back, r[1] - (dy / l) * back, 0.6], tgt, fovDeg);
}
