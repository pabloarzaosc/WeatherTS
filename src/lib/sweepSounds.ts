// The scan line's sounds (layers/radarSweep.ts): three short WebAudio effects,
// synthesised here -- no audio files.
//
//   blip  a sonar-like ping: a sine falling an octave, with a quiet fifth above
//   tone  a soft rising triangle sweep through a low-pass, half a second
//   tick  a dry click: a few milliseconds of band-passed noise
//
// Its own AudioContext (the alert sounds keep theirs), woken by the first
// click or key like theirs.

export type SweepSoundId = "blip" | "tone" | "tick";

type Ctx = BaseAudioContext;

function blip(ctx: Ctx, out: AudioNode, t: number): number {
  const parts: [number, number][] = [[1240, 1], [1860, 0.18]];
  for (const [hz, amp] of parts) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(hz / 2, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * amp, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.34);
  }
  return 0.34;
}

function tone(ctx: Ctx, out: AudioNode, t: number): number {
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(320, t);
  o.frequency.exponentialRampToValueAtTime(880, t + 0.5);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(1400, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.32, t + 0.12);
  g.gain.linearRampToValueAtTime(0.22, t + 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
  o.connect(lp).connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.64);
  return 0.64;
}

let noise: AudioBuffer | null = null;
function tick(ctx: Ctx, out: AudioNode, t: number): number {
  const len = Math.ceil(ctx.sampleRate * 0.03);
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    // A fixed pseudo-random burst, so every tick sounds the same.
    let x = 12345;
    for (let i = 0; i < len; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (x / 0x3fffffff - 1) * Math.exp(-i / (len / 6));
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(2600, t);
  bp.Q.setValueAtTime(1.4, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.9, t);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
  return 0.03;
}

const SOUNDS: Record<SweepSoundId, (ctx: Ctx, out: AudioNode, t: number) => number> = { blip, tone, tick };

let ctx: AudioContext | null = null;
function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

let unlocked = false;
export function installSweepAudioUnlock(): void {
  if (unlocked) return;
  unlocked = true;
  const wake = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
  };
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);
}

/** What was played, newest last (a test reads it). */
export const sweepSoundLog: { id: SweepSoundId; at: number; state: string }[] = [];

export function playSweepSound(id: SweepSoundId, volume = 0.5): boolean {
  const c = context();
  const make = SOUNDS[id];
  if (!c || !make || volume <= 0) return false;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const g = c.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume));
  g.connect(c.destination);
  const len = make(c, g, c.currentTime + 0.01);
  setTimeout(() => g.disconnect(), (len + 0.2) * 1000);
  sweepSoundLog.push({ id, at: Date.now(), state: c.state });
  if (sweepSoundLog.length > 50) sweepSoundLog.shift();
  return true;
}

/** Render one effect offline: length, loudness, rough pitch -- for tests. */
export async function renderSweepSound(id: SweepSoundId): Promise<{ seconds: number; rms: number; peak: number; zeroCrossHz: number }> {
  const rate = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(rate * 0.8), rate);
  const g = off.createGain();
  g.connect(off.destination);
  const len = SOUNDS[id](off, g, 0);
  const buf = await off.startRendering();
  const d = buf.getChannelData(0);
  const n = Math.ceil(rate * len);
  let sum = 0;
  let peak = 0;
  let zc = 0;
  for (let i = 0; i < n; i++) {
    sum += d[i] * d[i];
    peak = Math.max(peak, Math.abs(d[i]));
    if (i && d[i - 1] < 0 !== d[i] < 0) zc++;
  }
  return { seconds: len, rms: Math.sqrt(sum / n), peak, zeroCrossHz: Math.round(zc / 2 / len) };
}
