import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";

import { getSetting } from "../settings/useSettingsStore";
import { useSoundingViewerStore } from "../store/useSoundingViewerStore";
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { selectCurrentModel, useModelStore } from "../store/useModelStore";
import { useMslpStore } from "../store/useMslpStore";
import { useLsrStore } from "../store/useLsrStore";
import { useFrontsStore } from "../store/useFrontsStore";
import { useObsStore } from "../store/useObsStore";
import { useSatStore } from "../store/useSatStore";

/** Stable empty array so the selector doesn't rerender on every store tick. */
const NO_HOURS: number[] = [];

const PLAY_SPEEDS = [1, 2, 4, 8, 12, 16, 20] as const;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Model-mode fallback axis when no sounding is open yet (hourly forecast steps).
const MODEL_PLACEHOLDER_MAX = 48;
const STEP_15MIN_S = 15 * 60;
const HISTORY_24H_S = 24 * 60 * 60;

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

/** A 24-hour axis on a 15-minute grid ending at the given instant. Storm
 * reports step this grid; each frame shows the window ending there. */
function recentQuarterHours(endUnix: number): number[] {
  const end = Math.floor(endUnix / STEP_15MIN_S) * STEP_15MIN_S;
  const count = HISTORY_24H_S / STEP_15MIN_S + 1;
  return Array.from({ length: count }, (_, i) => end - (count - 1 - i) * STEP_15MIN_S);
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
  const radarArchiveDay = useNexradStore((s) => s.archiveDate);
  // Model fields (pressure today, more later) scrub forecast hours on this same
  // timeline rather than carrying a second slider of their own.
  const satVisible = useAppStore((s) => s.layers["satellite"]?.visible ?? false);
  const satFrames = useSatStore((s) => s.frames);
  const satIndex = useSatStore((s) => s.index);
  const satBusy = useSatStore((s) => s.busy);
  const obsVisible = useAppStore((s) => s.layers["observations"]?.visible ?? false);
  const obsFrames = useObsStore((s) => s.frames);
  const obsIndex = useObsStore((s) => s.index);
  const obsBusy = useObsStore((s) => s.busy);
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
  // Where playback starts comes from Settings; the buttons change it for the session.
  const [speed, setSpeed] = useState<(typeof PLAY_SPEEDS)[number]>(() => {
    const wanted = Number(getSetting<string>("timeline.speed"));
    return PLAY_SPEEDS.find((v) => v === wanted) ?? 1;
  });
  const [loop, setLoop] = useState(() => getSetting<boolean>("timeline.loop"));
  const [obsTimes] = useState<number[]>(() => recentSynoptic());
  const [lsrNow] = useState<number>(() => Date.now() / 1000);
  const lsrTimes = recentQuarterHours(lsrEndUnix ?? lsrNow);

  // What drives the timeline: an open sounding wins; then radar scans (the
  // live product); then a model field; else the closed sounding axis.
  const isRadar = !open && radarVisible && radarScans.length > 0;
  // The analyses are an observed product like radar, and their hours ARE the
  // axis -- so they take it before any forecast clock does.
  // Satellite next: its frames are minutes apart, finer than any analysis, so
  // when both are on the loop is the axis and the analysis follows it.
  const isSat = !open && !isRadar && satVisible && satFrames.length > 0;
  const isObs = !open && !isRadar && !isSat && obsVisible && obsFrames.length > 0;
  const isModel = !open && !isRadar && !isSat && !isObs && mslpVisible && modelHours.length > 0;
  // Storm reports drive the axis only when nothing more specific does; the rest
  // of the time they FOLLOW whatever does (see the sync effect below), which is
  // what keeps every product on one clock.
  const isLsr = !open && !isRadar && !isSat && !isObs && !isModel && lsrVisible;
  // Fronts drive the axis when nothing more specific does; the frames ARE the
  // axis (3-hourly analyses plus the 12 h and 24 h progs), so there is no grid
  // to invent.
  const isFronts =
    !open && !isRadar && !isSat && !isObs && !isModel && !isLsr && frontsVisible && frontFrames.length > 0;
  const active = open || isRadar || isSat || isObs || isModel || isLsr || isFronts;
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
  } else if (isSat) {
    times = satFrames.map((f) => f.unix);
    maxHour = Math.max(satFrames.length - 1, 0);
  } else if (isObs) {
    // The analysis hours the server still holds, oldest first.
    times = obsFrames.map((f) => f.unix);
    maxHour = Math.max(obsFrames.length - 1, 0);
  } else if (isModel) {
    // Forecast hours become real clock times off the run, so the readout and
    // NOW behave the same as they do for every other context.
    const base = modelRunIso ? Date.parse(modelRunIso) / 1000 : null;
    times = base ? modelHours.map((h) => base + h * 3600) : null;
    maxHour = Math.max(modelHours.length - 1, 0);
  } else if (isFronts) {
    times = frontFrames.map((f) => f.validUnix ?? 0);
    maxHour = Math.max(frontFrames.length - 1, 0);
  } else if (isLsr) {
    // A 15-minute grid -- reports arrive irregularly,
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
  const lsrIndex = isLsr
    ? Math.max(0, lsrTimes.indexOf(lsrEndUnix ?? lsrTimes[lsrTimes.length - 1]))
    : 0;
  const value = Math.max(
    0,
    Math.min(
      isRadar
        ? radarIndex
        : isSat
          ? Math.max(satIndex, 0)
          : isObs
          ? Math.max(obsIndex, 0)
          : isModel
          ? modelIndex
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
    isRadar || isSat || isObs || isModel || isLsr || isFronts
      ? maxHour > 0
      : active && !!data && maxHour > 0;

  // Parked on the newest frame of a live loop, the timeline is not showing a
  // past instant -- it is showing "now, as fresh as this radar gets". Radars
  // publish on their own clocks and some run minutes behind, so pinning the
  // alert filter to that frame's exact timestamp hid every warning issued
  // since the volume was made: switch to a site whose newest scan is twenty
  // minutes old and twenty minutes of warnings vanished off the map. Worse,
  // it is not the same set from radar to radar, which is what made it look
  // like alerts came and went with the site picker.
  //
  // An archive day is genuinely history, and a scrubbed-back frame is a
  // deliberate look at the past -- both still filter.
  const atLiveEdge = isRadar && radarArchiveDay === null && value >= maxHour;

  // Keep alerts on the same clock as the scan underneath them: a warning issued
  // after the frame you're looking at shouldn't be drawn over it. Only while
  // radar drives the timeline -- `isRadar` already means no sounding is open, so
  // opening one releases the alerts back to live and closing it re-syncs them.
  useEffect(() => {
    useAlertStore.getState().setTimeFilter(isRadar && !atLiveEdge ? selectedUnix : null);
  }, [isRadar, atLiveEdge, selectedUnix]);

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
    useFrontsStore.getState().goToUnix(isRadar || isModel || open ? selectedUnix : null);
  }, [frontsVisible, isFronts, isRadar, isModel, open, selectedUnix]);

  // Satellite and the analyses are observed too: while something else drives
  // the axis they park on the frame nearest the instant on screen, so a radar
  // loop scrubbed back to 21Z shows the 21Z visible and the 21Z analysis.
  useEffect(() => {
    if (!satVisible || isSat) return;
    useSatStore.getState().goToUnix(isRadar || isObs ? selectedUnix : null);
  }, [satVisible, isSat, isRadar, isObs, selectedUnix]);

  useEffect(() => {
    if (!obsVisible || isObs) return;
    if (isRadar || isSat) useObsStore.getState().goToUnix(selectedUnix);
  }, [obsVisible, isObs, isRadar, isSat, selectedUnix]);

  useEffect(() => {
    if (!lsrVisible || isLsr) return;
    const follows = isRadar || isSat || isObs;
    useLsrStore.getState().setEndUnix(follows ? selectedUnix : null);
  }, [lsrVisible, isLsr, isRadar, isSat, isObs, selectedUnix]);


  const scrub = (h: number) => {
    const clamped = Math.max(0, Math.min(h, maxHour));
    if (isRadar) void useNexradStore.getState().showIndex(clamped);
    else if (isSat) useSatStore.getState().setIndex(clamped);
    else if (isObs) useObsStore.getState().setIndex(clamped);
    else if (isModel) useModelStore.getState().setHour(modelHours[clamped] ?? 0);
    else if (isLsr) useLsrStore.getState().setEndUnix(times?.[clamped] ?? null);
    else if (isFronts) useFrontsStore.getState().setIndex(clamped);
    else if (open) setHour(clamped);
    else setPreselectHour(clamped);
  };
  const step = (delta: number) => {
    if (isRadar || isSat || isObs || isModel || isLsr || isFronts) scrub(value + delta);
    else if (open) stepHour(delta);
    else scrub(value + delta);
  };
  const cycleSpeed = () => setSpeed((s) => PLAY_SPEEDS[(PLAY_SPEEDS.indexOf(s) + 1) % PLAY_SPEEDS.length]);
  // Jump to the frame closest to the current real-world time (latest obs for
  // RAOB, nearest forecast hour for models).
  const goNow = () => {
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
        await wait(getSetting<number>("timeline.radarMs") / speed);
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
        await wait(getSetting<number>("timeline.soundingMs") / speed);
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
        await wait(getSetting<number>("timeline.modelMs") / speed);
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

    // Storm reports step the 15-minute grid; each frame is a
    // fresh window fetch, so wait for it to land before advancing.
    async function runLsr() {
      while (!cancelled) {
        await wait(getSetting<number>("timeline.lsrMs") / speed);
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

    // Satellite and the analyses step, then hold until the frame is on the map:
    // a loop must never run ahead of what is drawn.
    async function runFrames(
      read: () => { index: number; length: number; busy: boolean },
      go: (i: number) => void,
      /** Time per frame at 1x, read each step so a change in Settings lands mid-loop. */
      dwell: () => number,
      /** First frame of the loop; the end wraps back here. */
      first = 0,
    ) {
      // Pressing play on the newest frame means "play the loop", not "stop at
      // once because this is the end": start from its first frame.
      {
        const { index, length } = read();
        if (length > 0 && (index >= length - 1 || index < first)) {
          go(first);
          await wait(60);
        }
      }
      while (!cancelled) {
        await wait(dwell() / speed);
        if (cancelled) return;
        const { index, length } = read();
        if (length === 0) return;
        const atEnd = index >= length - 1;
        if (atEnd && !loop) {
          setPlaying(false);
          return;
        }
        go(atEnd ? first : index + 1);
        await wait(60);
        for (let k = 0; k < 300 && read().busy; k++) {
          if (cancelled) return;
          await wait(50);
        }
      }
    }

    // Fronts step frame by frame; each is already in memory, so the only wait
    // is the paint.
    async function runFronts() {
      while (!cancelled) {
        await wait(getSetting<number>("timeline.frontsMs") / speed);
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
      : isSat
        ? runFrames(
            () => {
              const s = useSatStore.getState();
              return { index: s.index, length: s.frames.length, busy: s.busy };
            },
            (i) => useSatStore.getState().setIndex(i),
            () => getSetting<number>("timeline.satMs"),
          )
      : isObs
        ? runFrames(
            () => {
              const s = useObsStore.getState();
              return { index: s.index, length: s.frames.length, busy: s.busy };
            },
            (i) => useObsStore.getState().setIndex(i),
            // The whole timeline is the loop now -- its length is picked in the
            // panel -- and its frames are made ahead, so it steps like satellite.
            () => getSetting<number>("timeline.obsMs"),
          )
      : isModel
        ? runModel()
          : isLsr
            ? runLsr()
            : isFronts
              ? runFronts()
              : run());
    return () => {
      cancelled = true;
    };
  }, [playing, speed, loop, canPlay, isRadar, isSat, isObs, isModel, isLsr, isFronts, gotoPlaybackHour, setPendingHour]);

  // Stopping a loop's download from its loading card pauses the play: frames
  // that will not arrive are not worth waiting on.
  useEffect(() => {
    const offSat = useSatStore.subscribe((s, prev) => {
      if (s.loopStops !== prev.loopStops) setPlaying(false);
    });
    const offObs = useObsStore.subscribe((s, prev) => {
      if (s.loopStops !== prev.loopStops) setPlaying(false);
    });
    return () => {
      offSat();
      offObs();
    };
  }, []);

  // The analyses layer hides its zoom detail while a loop plays.
  useEffect(() => {
    useObsStore.getState().setPlaying(playing && isObs);
    useSatStore.getState().setPlaying(playing && isSat);
  }, [playing, isObs]);

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

  // Observed products read as a clock time, not a forecast hour.
  const chip = isRadar || isSat || isObs
    ? fmtScan(selectedUnix)
    : isModel
      ? `F${String(modelHour).padStart(3, "0")}`
      : isFronts
        ? (frontFrames[value]?.kind === "forecast" ? frontFrames[value]?.label ?? "PROG" : "ANALYSIS")
      : isLsr
        ? fmtScan(selectedUnix)
      : isRaob
        ? fmtObsShort(selectedUnix)
        : `F${String(value).padStart(3, "0")}`;
  const rendering = isRadar
    ? radarLoading
    : isSat
      ? satBusy
    : isObs
      ? obsBusy
      : isModel
      ? modelBusy
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
        onClick={() => {
          // Play after a stopped download means "load it after all".
          // Play is what downloads a loop: the area on screen, now.
          if (!playing && isSat) useSatStore.getState().armLoop();
          if (!playing && isObs) useObsStore.getState().armLoop();
          setPlaying((v) => !v);
        }}
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
