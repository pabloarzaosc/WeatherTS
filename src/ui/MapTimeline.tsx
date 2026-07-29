import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";

import { useSoundingViewerStore } from "../store/useSoundingViewerStore";
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { selectCurrentModel, useModelStore } from "../store/useModelStore";
import { useMslpStore } from "../store/useMslpStore";

/** Stable empty array so the selector doesn't rerender on every store tick. */
const NO_HOURS: number[] = [];

const PLAY_BASE_MS = 2800;
const PLAY_SPEEDS = [1, 2, 4, 8, 12, 16, 20] as const;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Model-mode fallback axis when no sounding is open yet (hourly forecast steps).
const MODEL_PLACEHOLDER_MAX = 48;

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
  // Model fields (pressure today, more later) scrub forecast hours on this same
  // timeline rather than carrying a second slider of their own.
  const mslpVisible = useAppStore((s) => s.layers["mslp"]?.visible ?? false);
  const modelHours = useModelStore((s) => selectCurrentModel(s)?.hours ?? NO_HOURS);
  const modelHour = useModelStore((s) => s.hour);
  const modelBusy = useMslpStore((s) => s.busy);
  const modelRunIso = useMslpStore((s) => s.runIso);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAY_SPEEDS)[number]>(1);
  const [loop, setLoop] = useState(false);
  const [obsTimes] = useState<number[]>(() => recentSynoptic());

  // What drives the timeline: an open sounding wins; then radar scans (the
  // live product); then a model field; else the closed sounding axis.
  const isRadar = !open && radarVisible && radarScans.length > 0;
  const isModel = !open && !isRadar && mslpVisible && modelHours.length > 0;
  const active = open || isRadar || isModel;
  const effectiveMode: "model" | "raob" = open ? mode : raobVisible ? "raob" : "model";
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
  const value = Math.max(0, Math.min(isRadar ? radarIndex : isModel ? modelIndex : hour, maxHour));
  const selectedUnix = times ? times[value] ?? null : null;
  const canPlay = isRadar || isModel ? maxHour > 0 : active && !!data && maxHour > 0;

  // Keep alerts on the same clock as the scan underneath them: a warning issued
  // after the frame you're looking at shouldn't be drawn over it. Only while
  // radar drives the timeline -- `isRadar` already means no sounding is open, so
  // opening one releases the alerts back to live and closing it re-syncs them.
  useEffect(() => {
    useAlertStore.getState().setTimeFilter(isRadar ? selectedUnix : null);
  }, [isRadar, selectedUnix]);


  const scrub = (h: number) => {
    const clamped = Math.max(0, Math.min(h, maxHour));
    if (isRadar) void useNexradStore.getState().showIndex(clamped);
    else if (isModel) useModelStore.getState().setHour(modelHours[clamped] ?? 0);
    else if (open) setHour(clamped);
    else setPreselectHour(clamped);
  };
  const step = (delta: number) => {
    if (isRadar || isModel) scrub(value + delta);
    else if (open) stepHour(delta);
    else scrub(value + delta);
  };
  const cycleSpeed = () => setSpeed((s) => PLAY_SPEEDS[(PLAY_SPEEDS.indexOf(s) + 1) % PLAY_SPEEDS.length]);
  // Jump to the frame closest to the current real-world time (latest obs for
  // RAOB, nearest forecast hour for models).
  const goNow = () => {
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

    void (isRadar ? runRadar() : isModel ? runModel() : run());
    return () => {
      cancelled = true;
    };
  }, [playing, speed, loop, canPlay, isRadar, isModel, gotoPlaybackHour, setPendingHour]);

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
      : isRaob
        ? fmtObsShort(selectedUnix)
        : `F${String(value).padStart(3, "0")}`;
  const rendering = isRadar ? radarLoading : isModel ? modelBusy : busy && pendingHour != null;
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
