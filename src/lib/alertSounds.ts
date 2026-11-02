/**
 * Alert sounds, made with WebAudio: no audio files. Each sound is a short
 * schedule of oscillators and envelopes written into a destination, so the
 * same code plays to the speakers and renders offline (renderAlertSound, used
 * to check them headless).
 *
 * One sound plays at a time: a new one replaces whatever is playing.
 */

import type { AlertSoundId } from "./alertTiers";

type Ctx = BaseAudioContext;

/** One tone with a fast attack and release, so it clicks neither on nor off. */
function tone(
  ctx: Ctx,
  out: AudioNode,
  t: number,
  dur: number,
  freq: number | ((o: OscillatorNode, t: number) => void),
  type: OscillatorType,
  level: number,
  attack = 0.008,
  release = 0.03,
): OscillatorNode {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  if (typeof freq === "number") o.frequency.setValueAtTime(freq, t);
  else freq(o, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + attack);
  g.gain.setValueAtTime(level, Math.max(t + attack, t + dur - release));
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
  return o;
}

/** A soft low-pass, the "small speaker" every sound goes through. */
function speaker(ctx: Ctx, out: AudioNode, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = hz;
  f.Q.value = 0.7;
  f.connect(out);
  return f;
}

/** Each sound: schedules itself at `t0` into `out`, returns its length (s). */
const SOUNDS: Record<Exclude<AlertSoundId, "none">, (ctx: Ctx, out: AudioNode, t0: number) => number> = {
  // Two even beeps: the everyday "something new".
  double: (ctx, out, t0) => {
    const f = speaker(ctx, out, 5000);
    for (let i = 0; i < 2; i++) {
      tone(ctx, f, t0 + i * 0.3, 0.17, 1046.5, "triangle", 0.78);
      tone(ctx, f, t0 + i * 0.3, 0.17, 2093, "sine", 0.12);
    }
    return 0.62;
  },
  // Three quick, higher beeps, twice: more urgent than the double.
  triple: (ctx, out, t0) => {
    const f = speaker(ctx, out, 6000);
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 3; i++) {
        const t = t0 + r * 0.62 + i * 0.14;
        tone(ctx, f, t, 0.085, 1396.9, "square", 0.32, 0.004, 0.02);
      }
    }
    return 1.12;
  },
  // A falling square sweep, three times: the emergency sound.
  alarm: (ctx, out, t0) => {
    const f = speaker(ctx, out, 3200);
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.62;
      tone(ctx, f, t, 0.52, (o, s) => {
        o.frequency.setValueAtTime(1480, s);
        o.frequency.exponentialRampToValueAtTime(420, s + 0.5);
      }, "square", 0.34, 0.006, 0.05);
    }
    return 1.9;
  },
  // A slow rise and fall, like an outdoor warning siren.
  siren1: (ctx, out, t0) => {
    const f = speaker(ctx, out, 2600);
    const dur = 3.2;
    tone(ctx, f, t0, dur, (o, s) => {
      o.frequency.setValueAtTime(420, s);
      o.frequency.linearRampToValueAtTime(1250, s + 1.1);
      o.frequency.setValueAtTime(1250, s + 1.5);
      o.frequency.linearRampToValueAtTime(380, s + dur);
    }, "sawtooth", 0.26, 0.25, 0.6);
    tone(ctx, f, t0, dur, (o, s) => {
      o.frequency.setValueAtTime(421.5, s);
      o.frequency.linearRampToValueAtTime(1253, s + 1.1);
      o.frequency.setValueAtTime(1253, s + 1.5);
      o.frequency.linearRampToValueAtTime(381, s + dur);
    }, "triangle", 0.3, 0.25, 0.6);
    return dur;
  },
  // Fast up-sweeps, one after another.
  siren2: (ctx, out, t0) => {
    const f = speaker(ctx, out, 3500);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.21;
      tone(ctx, f, t, 0.2, (o, s) => {
        o.frequency.setValueAtTime(680, s);
        o.frequency.exponentialRampToValueAtTime(1580, s + 0.19);
      }, "sawtooth", 0.22, 0.005, 0.02);
    }
    return n * 0.21;
  },
  // A rising three-note square arpeggio played twice, then a held two-note
  // chord with a little vibrato, through a narrow old-television band.
  broadcast: (ctx, out, t0) => {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 280;
    hp.connect(speaker(ctx, out, 2400));
    const notes = [587.3, 740, 880];
    for (let r = 0; r < 2; r++) {
      notes.forEach((hz, i) => tone(ctx, hp, t0 + r * 0.42 + i * 0.13, 0.12, hz, "square", 0.22, 0.004, 0.02));
    }
    const hold = t0 + 0.9;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = 5;
    lfo.connect(depth);
    for (const hz of [740, 1108.7]) {
      const o = tone(ctx, hp, hold, 0.95, hz, "square", 0.16, 0.01, 0.15);
      depth.connect(o.frequency);
    }
    lfo.start(hold);
    lfo.stop(hold + 1);
    return 1.9;
  },
  // Two soft bell notes, for the quieter products.
  chime: (ctx, out, t0) => {
    for (const [i, hz] of [1567.98, 1174.66].entries()) {
      const t = t0 + i * 0.32;
      for (const [mult, lvl] of [[1, 0.5], [2.76, 0.12], [5.4, 0.04]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = hz * mult;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(lvl, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 1.1);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 1.15);
      }
    }
    return 1.45;
  },
};

let ctx: AudioContext | null = null;
interface Voice {
  gain: GainNode;
  id: AlertSoundId;
  endsAt: number;
}
let voice: Voice | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

/**
 * Browsers start audio suspended until the page is used. The first click or
 * key anywhere wakes it, so a warning that arrives later can sound even when
 * the window is hidden by then. (Electron allows it from the start.)
 */
export function installAudioUnlock(): void {
  const wake = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
  };
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);
}

/** Fade out and drop whatever is playing. */
export function stopAlertSound(): void {
  if (!voice || !ctx) return;
  const g = voice.gain;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.linearRampToValueAtTime(0, t + 0.04);
  window.setTimeout(() => g.disconnect(), 80);
  voice = null;
}

/** What is playing now, or null. */
export function playingAlertSound(): AlertSoundId | null {
  if (!voice || !ctx) return null;
  return ctx.currentTime < voice.endsAt ? voice.id : null;
}

/** Play `id` at `volume` (0-1), replacing anything playing. */
export function playAlertSound(id: AlertSoundId, volume = 0.7): boolean {
  if (id === "none" || !(id in SOUNDS)) return false;
  const c = context();
  if (!c) return false;
  if (c.state === "suspended") void c.resume().catch(() => {});
  stopAlertSound();
  const gain = c.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume)) * 0.6;
  gain.connect(c.destination);
  const t0 = c.currentTime + 0.03;
  const len = SOUNDS[id](c, gain, t0);
  voice = { gain, id, endsAt: t0 + len };
  const mine = voice;
  window.setTimeout(() => {
    if (voice === mine) {
      gain.disconnect();
      voice = null;
    }
  }, (len + 0.4) * 1000);
  if (import.meta.env.DEV) soundLog.push({ id, at: Date.now(), state: c.state });
  return true;
}

/** Every sound played, for headless checks (DEV only). */
export const soundLog: { id: AlertSoundId; at: number; state: string }[] = [];

/** Render a sound offline: its length, loudness and how much of it changes
 *  pitch -- enough to tell the sounds apart in a test. */
export async function renderAlertSound(id: Exclude<AlertSoundId, "none">): Promise<{
  seconds: number;
  rms: number;
  peak: number;
  zeroCrossHz: number[];
}> {
  const rate = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(rate * 3.6), rate);
  const g = off.createGain();
  g.connect(off.destination);
  const len = SOUNDS[id](off, g, 0);
  const buf = await off.startRendering();
  const d = buf.getChannelData(0);
  let sum = 0;
  let peak = 0;
  for (const v of d) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  // Rough pitch in 0.1 s windows: zero crossings / 2 per second.
  const win = Math.round(rate * 0.1);
  const zeroCrossHz: number[] = [];
  for (let i = 0; i + win <= Math.ceil(rate * len); i += win) {
    let n = 0;
    for (let j = i + 1; j < i + win; j++) if (d[j - 1] < 0 !== d[j] < 0) n++;
    zeroCrossHz.push(Math.round((n / 2) * 10));
  }
  return { seconds: len, rms: Math.sqrt(sum / Math.ceil(rate * len)), peak, zeroCrossHz };
}
