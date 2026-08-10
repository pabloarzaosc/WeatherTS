import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";

import { useSoundingViewerStore } from "../store/useSoundingViewerStore";
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { selectCurrentModel, useModelStore } from "../store/useModelStore";
import { useMslpStore } from "../store/useMslpStore";
import { useLightningStore } from "../store/useLightningStore";
import { useLsrStore } from "../store/useLsrStore";
import { useFrontsStore } from "../store/useFrontsStore";

/** Stable empty array so the selector doesn't rerender on every store tick. */
const NO_HOURS: number[] = [];

const PLAY_BASE_MS = 2800;
const PLAY_SPEEDS = [1, 2, 4, 8, 12, 16, 20] as const;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Model-mode fallback axis when no sounding is open yet (hourly forecast steps).
const MODEL_PLACEHOLDER_MAX = 48;
const LIGHTNING_STEP_S = 15 * 60;
const LIGHTNING_HISTORY_S = 24 * 60 * 60;

function fmtValid(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}Z`;
}

function fmtObsShort(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  return `${d.getUTCDate()}·${String(d.getUTCHours()).padStart(2, "0")}Z`;
}

// Radar scan time: HH:MMZ (scans are ~4 min apart).
function fmtScan(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

// Recent 00Z/12Z synoptic times (mirrors the backend), ascending. Used as the
// RAOB time axis before any station is opened.
function recentSynoptic(count = 8): number[] {
  const now = new Date();
  const h = now.getUTCHours() < 12 ? 0 : 12;
  const latest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h) / 1000;
  const times: number[] = [];
  for (let k = 0; k < count; k++) times.push(latest - k * 12 * 3600);
  return times.sort((a, b) => a - b);
}

/** Lightning history is sampled every 15 minutes, with each frame showing the
 * configured trailing window ending at that timestamp. */
function recentLightning(endUnix: number): number[] {
  const end = Math.floor(endUnix / LIGHTNING_STEP_S) * LIGHTNING_STEP_S;
  const count = LIGHTNING_HISTORY_S / LIGHTNING_STEP_S + 1;
  return Array.from({ length: count }, (_, i) => end - (count - 1 - i) * LIGHTNING_STEP_S);
}

/**
 * Global forecast/observation timeline pinned to the bottom of the map. It is
 * always visible and adapts to the active context: a model sounding scrubs
 * forecast hours; a RAOB scrubs observation times. With no sounding open it
 * still shows the axis for the current mode (RAOB if the RAOB layer is on) and
 * pre-selects the time the next opened sounding will start at.
 */
export function MapTimeline() {
  const open = useSoundingViewerStore((s) => s.open);
  const mode = useSoundingViewerStore((s) => s.mode);
  const hour = useSoundingViewerStore((s) => s.hour);
  const data = useSoundingViewerStore((s) => s.data);
  const busy = useSoundingViewerStore((s) => s.busy);
  const pendingHour = useSoundingViewerStore((s) => s.pendingHour);
  const setHour = useSoundingViewerStore((s) => s.setHour);
  const stepHour = useSoundingViewerStore((s) => s.stepHour);
  const gotoPlaybackHour = useSoundingViewerStore((s) => s.gotoPlaybackHour);
  const setPreselectHour = useSoundingViewerStore((s) => s.setPreselectHour);
  const setPendingHour = useSoundingViewerStore((s) => s.setPendingHour);
  const raobVisible = useAppStore((s) => s.layers["raob"]?.visible ?? false);
  const radarVisible = useAppStore((s) => s.layers["nexrad"]?.visible ?? false);
  const radarScans = useNexradStore((s) => s.scans);
  const radarIndex = useNexradStore((s) => s.index);
  const radarLoading = useNexradStore((s) => s.loading);
  const lightningVisible = useAppStore((s) => s.layers["lightning"]?.visible ?? false);
  const lightningEndUnix = useLightningStore((s) => s.endUnix);
  const lightningBusy = useLightningStore((s) => s.busy);
  const lightningUpdatedAt = useLightningStore((s) => s.updatedAt);
  // Model fields (pressure today, more later) scrub forecast hours on this same
  // timeline rather than carrying a second slider of their own.
  const lsrVisible = useAppStore((s) => s.layers["lsr"]?.visible ?? false);
  const frontsVisible = useAppStore((s) => s.layers["fronts"]?.visible ?? false);
  const frontFrames = useFrontsStore((s) => s.frames);
  const frontIndex = useFrontsStore((s) => s.index);
  const frontBusy = useFrontsStore((s) => s.busy);
  const lsrEndUnix = useLsrStore((s) => s.endUnix);
  const lsrBusy = useLsrStore((s) => s.busy);
  const mslpVisible = useAppStore((s) => s.layers["mslp"]?.visible ?? false);
  const modelHours = useModelStore((s) => selectCurrentModel(s)?.hours ?? NO_HOURS);
  const modelHour = useModelStore((s) => s.hour);
  const modelBusy = useMslpStore((s) => s.busy);
  const modelRunIso = useMslpStore((s) => s.runIso);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAY_SPEEDS)[number]>(1);
  const [loop, setLoop] = useState(false);
  const [obsTimes] = useState<number[]>(() => recentSynoptic());
  const liveLightningEnd = lightningUpdatedAt ?? Date.now() / 1000;
  const lightningTimes = recentLightning(lightningEndUnix ?? liveLightningEnd);
  const [lsrNow] = useState<number>(() => Date.now() / 1000);
  const lsrTimes = recentLightning(lsrEndUnix ?? lsrNow);

  // What drives the timeline: an open sounding wins; then radar scans (the
  // live product); then a model field; else the closed sounding axis.
  const isRadar = !open && radarVisible && radarScans.length > 0;
  const isModel = !open && !isRadar && mslpVisible && modelHours.length > 0;
  const isLightning = !open && !isRadar && !isModel && lightningVisible;
  // Storm reports drive the axis only when nothing more specific does; the rest
  // of the time they FOLLOW whatever does (see the sync effect below), which is
  // what keeps every product on one clock.
  const isLsr = !open && !isRadar && !isModel && !isLightning && lsrVisible;
  // Fronts drive the axis when nothing more specific does; the frames ARE the
  // axis (3-hourly analyses plus the 12 h and 24 h progs), so there is no grid
  // to invent.
  const isFronts =
    !open && !isRadar && !isModel && !isLightning && !isLsr && frontsVisible && frontFrames.length > 0;
  const active = open || isRadar || isModel || isLightning || isLsr || isFronts;
  // Which axis the closed viewer would use. Area soundings scrub forecast hours
  // exactly like a point sounding, so only RAOB (and ACARS, which is observed)
  // need the observation axis.
  const effectiveMode = open ? mode : raobVisible ? "raob" : "model";
  const isRaob = !isRadar && !isModel && effectiveMode === "raob";

  // Time axis for the current context.
  let times: number[] | null = null;
  let maxHour = 0;
  if (isRadar) {
    times = radarScans.map((s) => s.time);
    maxHour = Math.max(radarScans.length - 1, 0);
  } else if (isModel) {
    // Forecast hours become real clock times off the run, so the readout and
    // NOW behave the same as they do for every other context.
    const base = modelRunIso ? Date.parse(modelRunIso) / 1000 : null;
    times = base ? modelHours.map((h) => base + h * 3600) : null;
    maxHour = Math.max(modelHours.length - 1, 0);
  } else if (isLightning) {
    times = lightningTimes;
    maxHour = lightningTimes.length - 1;
  } else if (isFronts) {
    times = frontFrames.map((f) => f.validUnix ?? 0);
    maxHour = Math.max(frontFrames.length - 1, 0);
  } else if (isLsr) {
    // Same 15-minute grid the lightning axis uses -- reports arrive irregularly,
    // so a regular clock is the only sensible axis.
    times = lsrTimes;
    maxHour = lsrTimes.length - 1;
  } else if (open && data) {
    times = data.meta.times ?? null;
    maxHour = Math.max(data.meta.forecastMaxHour ?? (times ? times.length - 1 : 0), 0);
  } else if (isRaob) {
    times = obsTimes;
    maxHour = obsTimes.length - 1;
  } else {
    times = null;
    maxHour = MODEL_PLACEHOLDER_MAX;
  }

  const modelIndex = isModel ? Math.max(0, modelHours.indexOf(modelHour)) : 0;
  const lightningIndex = isLightning
    ? Math.max(0, lightningTimes.indexOf(lightningEndUnix ?? lightningTimes[lightningTimes.length - 1]))
    : 0;
  const lsrIndex = isLsr
    ? Math.max(0, lsrTimes.indexOf(lsrEndUnix ?? lsrTimes[lsrTimes.length - 1]))
    : 0;
  const value = Math.max(
    0,
    Math.min(
      isRadar
        ? radarIndex
        : isModel
          ? modelIndex
          : isLightning
            ? lightningIndex
            : isLsr
              ? lsrIndex
              : isFronts
                ? Math.max(frontIndex, 0)
                : hour,
      maxHour,
    ),
  );
  const selectedUnix = times ? times[value] ?? null : null;
  const canPlay =
    isRadar || isModel || isLightning || isLsr || isFronts
      ? maxHour > 0
      : active && !!data && maxHour > 0;

  // Keep alerts on the same clock as the scan underneath them: a warning issued
  // after the frame you're looking at shouldn't be drawn over it. Only while
  // radar drives the timeline -- `isRadar` already means no sounding is open, so
  // opening one releases the alerts back to live and closing it re-syncs them.
  useEffect(() => {
    useAlertStore.getState().setTimeFilter(isRadar ? selectedUnix : null);
  }, [isRadar, selectedUnix]);

  // Storm reports ride the same clock: while an OBSERVED product drives the
  // axis, the LSR window ends at the frame on screen, so a report filed after it
  // is not drawn over it.
  //
  // Two deliberate exclusions. When LSR drives the axis itself the scrub IS the
  // window, and writing to it here would immediately undo the user's own drag.
  // And a model/sounding clock is a FORECAST time, which a window of observed
  // reports cannot meaningfully end at -- those stay live.
  // Fronts ride the same clock: while another product drives the axis, the
  // analysis or prog nearest the frame on screen is the one drawn.
  useEffect(() => {
    if (!frontsVisible || isFronts) return;
    useFrontsStore.getState().goToUnix(isRadar || isLightning || isModel || open ? selectedUnix : null);
  }, [frontsVisible, isFronts, isRadar, isLightning, isModel, open, selectedUnix]);

  useEffect(() => {
    if (!lsrVisible || isLsr) return;
    const follows = isRadar || isLightning;
    useLsrStore.getState().setEndUnix(follows ? selectedUnix : null);
  }, [lsrVisible, isLsr, isRadar, isLightning, selectedUnix]);


  const scrub = (h: number) => {
    const clamped = Math.max(0, Math.min(h, maxHour));
    if (isRadar) void useNexradStore.getState().showIndex(clamped);
    else if (isModel) useModelStore.getState().setHour(modelHours[clamped] ?? 0);
    else if (isLightning) useLightningStore.getState().setEndUnix(times?.[clamped] ?? null);
    else if (isLsr) useLsrStore.getState().setEndUnix(times?.[clamped] ?? null);
    else if (isFronts) useFrontsStore.getState().setIndex(clamped);
    else if (open) setHour(clamped);
    else setPreselectHour(clamped);
  };
  const step = (delta: number) => {
    if (isRadar || isModel || isLightning || isLsr || isFronts) scrub(value + delta);
    else if (open) stepHour(delta);
    else scrub(value + delta);
  };
  const cycleSpeed = () => setSpeed((s) => PLAY_SPEEDS[(PLAY_SPEEDS.indexOf(s) + 1) % PLAY_SPEEDS.length]);
  // Jump to the frame closest to the current real-world time (latest obs for
  // RAOB, nearest forecast hour for models).
  const goNow = () => {
    if (isLightning) {
      useLightningStore.getState().setEndUnix(null);
      return;
    }
    if (isLsr) {
      useLsrStore.getState().setEndUnix(null);
      return;
    }
    if (isFronts) {
      useFrontsStore.getState().goToUnix(null);
      return;
    }
    if (!times || times.length === 0) {
      scrub(0);
      return;
    }
    const now = Date.now() / 1000;
    let best = 0;
    let bestDiff = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(t - now);
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    });
    scrub(best);
  };

  // Autoplay: pace each step, then wait for the frame to load before advancing
  // (the timeline never runs ahead of the rendered frame).
  useEffect(() => {
    if (!playing || !canPlay) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

    // Radar: frames are cached and meshed locally (~65 ms), but a cold one still
    // has to be fetched, so keep waiting for the commit before advancing --
    // same rule as soundings: never run ahead of what's drawn.
    async function runRadar() {
      while (!cancelled) {
        await wait(700 / speed);
        if (cancelled) return;
        const rs = useNexradStore.getState();
        const max = Math.max(rs.scans.length - 1, 0);
        const atEnd = rs.index >= max;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        const ok = await rs.showIndex(atEnd ? 0 : rs.index + 1);
        if (cancelled) return;
        if (!ok) {
          setPlaying(false);
          return;
        }
      }
    }

    async function run() {
      while (!cancelled) {
        await wait(PLAY_BASE_MS / speed);
        if (cancelled) return;
        const st = useSoundingViewerStore.getState();
        if (!st.data) return;
        const max = Math.max(st.data.meta.forecastMaxHour ?? st.data.meta.nTimes - 1, 0);
        const atEnd = st.hour >= max;
        if (atEnd && !(loop && max > 0)) {
          setPlaying(false);
          return;
        }
        const target = atEnd ? 0 : st.hour + 1;
        setPendingHour(target);
        const ok = await st.gotoPlaybackHour(target);
        setPendingHour(null);
        if (cancelled) return;
        if (!ok) {
          setPlaying(false);
          return;
        }
      }
    }
    // Model fields: each hour is a fresh contour job on the backend, so wait for
    // the draw to commit before stepping instead of queueing requests.
    async function runModel() {
      while (!cancelled) {
        await wait(600 / speed);
        if (cancelled) return;
        const ms = useModelStore.getState();
        const hours = selectCurrentModel(ms)?.hours ?? [];
        if (hours.length === 0) return;
        const i = hours.indexOf(ms.hour);
        const atEnd = i >= hours.length - 1;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        ms.setHour(hours[atEnd ? 0 : Math.max(i, 0) + 1]);
        // Give the layer a tick to flip `busy`, then hold until it clears.
        await wait(80);
        for (let k = 0; k < 250 && useMslpStore.getState().busy; k++) {
          if (cancelled) return;
          await wait(100);
        }
      }
    }

    // Lightning frames fetch a trailing window ending at each timeline step.
    async function runLightning() {
      while (!cancelled) {
        await wait(900 / speed);
        if (cancelled) return;
        const ls = useLightningStore.getState();
        const current = ls.endUnix ?? lightningTimes[lightningTimes.length - 1];
        const i = Math.max(0, lightningTimes.indexOf(current));
        const atEnd = i >= lightningTimes.length - 1;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        ls.setEndUnix(lightningTimes[atEnd ? 0 : i + 1]);
        await wait(80);
        for (let k = 0; k < 250 && useLightningStore.getState().busy; k++) {
          if (cancelled) return;
          await wait(100);
        }
      }
    }

    // Storm reports step the same 15-minute grid as lightning; each frame is a
    // fresh window fetch, so wait for it to land before advancing.
    async function runLsr() {
      while (!cancelled) {
        await wait(900 / speed);
        if (cancelled) return;
        const ls = useLsrStore.getState();
        const current = ls.endUnix ?? lsrTimes[lsrTimes.length - 1];
        const i = Math.max(0, lsrTimes.indexOf(current));
        const atEnd = i >= lsrTimes.length - 1;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        ls.setEndUnix(lsrTimes[atEnd ? 0 : i + 1]);
        await wait(120);
        for (let k = 0; k < 250 && useLsrStore.getState().busy; k++) {
          if (cancelled) return;
          await wait(100);
        }
      }
    }

    // Fronts step frame by frame; each is already in memory, so the only wait
    // is the paint.
    async function runFronts() {
      while (!cancelled) {
        await wait(1100 / speed);
        if (cancelled) return;
        const fs = useFrontsStore.getState();
        const atEnd = fs.index >= fs.frames.length - 1;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        fs.setIndex(atEnd ? 0 : fs.index + 1);
      }
    }

    void (isRadar
      ? runRadar()
      : isModel
        ? runModel()
        : isLightning
          ? runLightning()
          : isLsr
            ? runLsr()
            : isFronts
              ? runFronts()
              : run());
    return () => {
      cancelled = true;
    };
  }, [playing, speed, loop, canPlay, isRadar, isModel, isLightning, isLsr, isFronts, gotoPlaybackHour, setPendingHour]);

  // Stop playing if the context can no longer play (e.g. viewer closed).
  useEffect(() => {
    if (!canPlay && playing) setPlaying(false);
  }, [canPlay, playing]);

  // Keyboard scrubbing works anywhere (not just when the viewer is focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const chip = isRadar
    ? fmtScan(selectedUnix)
    : isModel
      ? `F${String(modelHour).padStart(3, "0")}`
      : isFronts
        ? (frontFrames[value]?.kind === "forecast" ? frontFrames[value]?.label ?? "PROG" : "ANALYSIS")
      : isLightning || isLsr
        ? fmtScan(selectedUnix)
      : isRaob
        ? fmtObsShort(selectedUnix)
        : `F${String(value).padStart(3, "0")}`;
  const rendering = isRadar
    ? radarLoading
    : isModel
      ? modelBusy
      : isLightning
        ? lightningBusy
        : isLsr
          ? lsrBusy
        : isFronts
          ? frontBusy
          : busy && pendingHour != null;
  const progress = maxHour > 0 ? (value / maxHour) * 100 : 0;

  return (
    <div className={`maptimeline${active ? "" : " is-idle"}`}>
      <button
        type="button"
        className="maptimeline__play"
        onClick={() => setPlaying((v) => !v)}
        disabled={!canPlay}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button
        type="button"
        className={`maptimeline__icbtn${loop ? " is-active" : ""}`}
        onClick={() => setLoop((v) => !v)}
        disabled={!canPlay}
        title={loop ? "Loop: on" : "Loop: off"}
        aria-pressed={loop}
      >
        <Repeat size={15} />
      </button>
      <button
        type="button"
        className="maptimeline__speed"
        onClick={cycleSpeed}
        disabled={!canPlay}
        title="Playback speed"
      >
        {speed}&times;
      </button>

      <span className="maptimeline__sep" />

      <button type="button" className="maptimeline__step maptimeline__step--edge" onClick={() => scrub(0)} disabled={value <= 0} title="First frame">
        <SkipBack size={15} />
      </button>
      <button type="button" className="maptimeline__step" onClick={() => step(-1)} disabled={value <= 0} title="Previous (Left arrow)">
        <ChevronLeft size={16} />
      </button>
      <input
        type="range"
        className="maptimeline__scrub sv__scrub"
        min={0}
        max={maxHour}
        value={value}
        onChange={(e) => scrub(Number(e.target.value))}
        style={{ "--sv-progress": `${progress}%` } as React.CSSProperties}
      />
      <button type="button" className="maptimeline__step" onClick={() => step(1)} disabled={value >= maxHour} title="Next (Right arrow)">
        <ChevronRight size={16} />
      </button>
      <button type="button" className="maptimeline__step maptimeline__step--edge" onClick={() => scrub(maxHour)} disabled={value >= maxHour} title="Last frame">
        <SkipForward size={15} />
      </button>

      <button type="button" className="maptimeline__now" onClick={goNow} title="Jump to current time">
        NOW
      </button>

      <div className="maptimeline__readout">
        <b className="maptimeline__chip">{rendering ? `···${chip}` : chip}</b>
        <span className="maptimeline__valid">{fmtValid(selectedUnix)}</span>
      </div>
    </div>
  );
}
