import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";

import { getSetting } from "../settings/useSettingsStore";
import { useSoundingViewerStore } from "../store/useSoundingViewerStore";
import { useAlertStore } from "../store/useAlertStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useLsrStore } from "../store/useLsrStore";
import { useFrontsStore } from "../store/useFrontsStore";
import { obsFramesFailed, obsFramesHere, useObsStore } from "../store/useObsStore";
import { obsSharpBusy, obsSharpReady } from "../layers/modules/obsLayer";
import { satFrameFailed, satFrameHere } from "../layers/modules/satelliteLayer";
import { useSatStore } from "../store/useSatStore";
import { useSurfaceObsStore } from "../store/useSurfaceObsStore";
import { useGlmStore } from "../store/useGlmStore";
import { fhText } from "../lib/observations";
import { nearestSpeed } from "../lib/playSpeeds";
import { clearPlayNext, setPlayNext, type PlayDriver } from "../lib/playAhead";
import { SpeedPicker } from "./SpeedPicker";

/** Frames a play buffers ahead before it steps, like a video: radar scans,
 *  and Models frames. Past BUFFER_MAX_MS of waiting it plays what it has. */
const RADAR_BUFFER = 10;
const RADAR_MESHES_READY = 2;
const BUFFER_MAX_MS = 12_000;
/** Satellite and analyses: frames on this machine before a play of a loop
 *  still downloading starts (anywhere ahead: see runFrames). */
const START_BUFFER = 3;

/** The shortest time a frame is held. Past the speed where frames would come
 *  quicker than this, a play steps over frames instead, so 40x and 80x still
 *  move twice and four times as fast through time -- without it every speed
 *  past about 8x ran at the speed the map could paint and looked the same. */
const MIN_FRAME_MS = 40;

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The share of a Models frame's time that frame i holds, so a play moves
 *  through forecast time at one speed. The GFS steps hourly to +120 h and
 *  three-hourly after; at one dwell a frame, its first five days played at a
 *  third of the speed of the rest (Pablo, 2026-10-03). The ECMWF, GEFS and NBM
 *  widen the same way. The run's own step at its end -- its widest, in every
 *  run here -- takes the full time, a finer step its share. Taken as the median
 *  of the last few steps, so one missing hour at the end (an MRMS file not out)
 *  does not hurry a whole loop; and a gap wider than it never holds longer
 *  than a frame. */
function timeShare(frames: { unix: number }[], i: number): number {
  const n = frames.length;
  if (n < 3 || i < 0 || i >= n - 1) return 1;
  const tail: number[] = [];
  for (let k = n - 1; k > 0 && tail.length < 5; k--) tail.push(frames[k].unix - frames[k - 1].unix);
  tail.sort((a, b) => a - b);
  const full = tail[Math.floor(tail.length / 2)];
  const gap = frames[i + 1].unix - frames[i].unix;
  if (!(full > 0) || !(gap > 0)) return 1;
  return Math.min(1, gap / full);
}

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
  const satDaily = useSatStore(
    (s) => (s.catalog?.satellites.find((x) => x.id === s.sat)?.regions.find((r) => r.id === s.region)?.cadence ?? 0) >= 86400,
  );
  const obsVisible = useAppStore((s) => s.layers["observations"]?.visible ?? false);
  const obsFrames = useObsStore((s) => s.frames);
  const obsForecast = useObsStore((s) => s.catalog?.sources.find((x) => x.id === s.source)?.forecast ?? false);
  const obsArchive = useObsStore((s) => !!s.catalog?.sources.find((x) => x.id === s.source)?.archive);
  const obsIndex = useObsStore((s) => s.index);
  const obsBusy = useObsStore((s) => s.busy);
  const lsrVisible = useAppStore((s) => s.layers["lsr"]?.visible ?? false);
  const surfVisible = useAppStore((s) => s.layers["surfobs"]?.visible ?? false);
  const glmVisible = useAppStore((s) => s.layers["glm"]?.visible ?? false);
  const frontsVisible = useAppStore((s) => s.layers["fronts"]?.visible ?? false);
  const frontFrames = useFrontsStore((s) => s.frames);
  const frontIndex = useFrontsStore((s) => s.index);
  const frontBusy = useFrontsStore((s) => s.busy);
  const lsrEndUnix = useLsrStore((s) => s.endUnix);
  const lsrBusy = useLsrStore((s) => s.busy);

  const [playing, setPlaying] = useState(false);
  // Where playback starts comes from Settings; the buttons change it for the session.
  const [speed, setSpeed] = useState<number>(() => nearestSpeed(Number(getSetting<string>("timeline.speed"))));
  const [loop, setLoop] = useState(() => getSetting<boolean>("timeline.loop"));
  const [obsTimes] = useState<number[]>(() => recentSynoptic());
  const [lsrNow] = useState<number>(() => Date.now() / 1000);
  const lsrTimes = recentQuarterHours(lsrEndUnix ?? lsrNow);

  // What drives the timeline: an open sounding wins; then radar scans (the
  // live product); then the analyses, storm reports and fronts; else the
  // closed sounding axis.
  const isRadar = !open && radarVisible && radarScans.length > 0;
  // Satellite is observed too, and its scans are the axis when radar is off.
  const isSat = !open && !isRadar && satVisible && satFrames.length > 0;
  // The analyses are an observed product like radar, and their hours ARE the
  // axis -- so they take it before any forecast clock does.
  const isObs = !open && !isRadar && !isSat && obsVisible && obsFrames.length > 0;
  // Storm reports drive the axis only when nothing more specific does; the rest
  // of the time they FOLLOW whatever does (see the sync effect below), which is
  // what keeps every product on one clock.
  const isLsr = !open && !isRadar && !isSat && !isObs && lsrVisible;
  // Fronts drive the axis when nothing more specific does; the frames ARE the
  // axis (3-hourly analyses plus the 12 h and 24 h progs), so there is no grid
  // to invent.
  const isFronts =
    !open && !isRadar && !isSat && !isObs && !isLsr && frontsVisible && frontFrames.length > 0;
  const active = open || isRadar || isSat || isObs || isLsr || isFronts;
  // Which axis the closed viewer would use. Area soundings scrub forecast hours
  // exactly like a point sounding, so only RAOB (and ACARS, which is observed)
  // need the observation axis.
  const effectiveMode = open ? mode : raobVisible ? "raob" : "model";
  const isRaob = !isRadar && effectiveMode === "raob";

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
    isRadar || isSat || isObs || isLsr || isFronts
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
  // deliberate look at the past -- both still filter. The same holds for every
  // OBSERVED loop's newest frame (the latest analysis or mosaic, the storm
  // reports up to now, the latest surface analysis of the fronts, the latest
  // balloon run): it stands for now. A forecast hour never does.
  const lastFrontAnalysis = frontFrames.reduce((b, f, i) => (f.kind === "analysis" ? i : b), -1);
  const atLiveEdge =
    (isRadar && radarArchiveDay === null && value >= maxHour) ||
    (isSat && value >= maxHour) ||
    (isObs && !obsForecast && !obsArchive && value >= maxHour) ||
    (isLsr && value >= maxHour) ||
    (isFronts && value === lastFrontAnalysis) ||
    (!active && isRaob && value >= maxHour);

  // Keep alerts on the same clock as whatever the timeline shows: a warning
  // issued after the frame you're looking at shouldn't be drawn over it, and one
  // that expires before a forecast hour shouldn't be drawn over that. Every
  // timeline with a play button drives it -- radar, the Models frames, storm
  // reports, fronts, a sounding -- and the whole span goes to the alerts too, so
  // they read it ahead and a play finds each frame's alerts already here.
  const followsTime = active || isRaob;
  const spanFirst = followsTime && times && times.length > 1 ? times[0] : null;
  const spanLast = followsTime && times && times.length > 1 ? times[times.length - 1] : null;
  useEffect(() => {
    const alerts = useAlertStore.getState();
    // While a play runs, the newest frame is a time like the others: "now"
    // there swapped the map's alerts for the live set and back on every lap.
    alerts.setTimeFilter(followsTime && (!atLiveEdge || playing) ? selectedUnix : null);
    alerts.setTimeRange(spanFirst !== null && spanLast !== null ? [spanFirst, spanLast] : null);
  }, [followsTime, atLiveEdge, playing, selectedUnix, spanFirst, spanLast]);

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
    useFrontsStore.getState().goToUnix(isRadar || open ? selectedUnix : null);
  }, [frontsVisible, isFronts, isRadar, open, selectedUnix]);

  // The analyses are observed too: while something else drives the axis they
  // park on the frame nearest the instant on screen, so a radar loop scrubbed
  // back to 21Z shows the 21Z analysis.
  useEffect(() => {
    if (!obsVisible || isObs) return;
    if (isRadar || isSat) useObsStore.getState().goToUnix(selectedUnix);
  }, [obsVisible, isObs, isRadar, isSat, selectedUnix]);

  // Satellite follows radar the same way: the scan nearest the radar frame.
  useEffect(() => {
    if (!satVisible || isSat) return;
    useSatStore.getState().goToUnix(isRadar ? selectedUnix : null);
  }, [satVisible, isSat, isRadar, selectedUnix]);

  useEffect(() => {
    if (!lsrVisible || isLsr) return;
    const follows = isRadar || isSat || isObs;
    useLsrStore.getState().setEndUnix(follows ? selectedUnix : null);
  }, [lsrVisible, isLsr, isRadar, isSat, isObs, selectedUnix]);

  // The station plots too: at a past radar, satellite or analysis frame (or a
  // storm-report time) each station shows the report it had made by then, not
  // its newest one -- a storm on a scan from an hour ago used to sit over
  // reports from now, and a gauge under it read dry. At the live edge, and at
  // a forecast hour, they are the newest.
  useEffect(() => {
    const follows = isRadar || isSat || isLsr || (isObs && !obsForecast);
    useSurfaceObsStore
      .getState()
      .setAtUnix(surfVisible && follows && !atLiveEdge && selectedUnix != null ? Math.floor(selectedUnix) : null);
  }, [surfVisible, isRadar, isSat, isLsr, isObs, obsForecast, atLiveEdge, selectedUnix]);

  // Lightning too: at a past frame the flashes are those of the minutes before
  // it, so a loop shows each scan's own lightning; at the live edge, now.
  useEffect(() => {
    const follows = isRadar || isSat || isLsr || (isObs && !obsForecast);
    useGlmStore
      .getState()
      .setAtUnix(glmVisible && follows && !atLiveEdge && selectedUnix != null ? Math.floor(selectedUnix) : null);
  }, [glmVisible, isRadar, isSat, isLsr, isObs, obsForecast, atLiveEdge, selectedUnix]);
  // And the loop's whole span, so its flashes are downloading before the play
  // reaches them.
  useEffect(() => {
    const follows = isRadar || isSat || isLsr || (isObs && !obsForecast);
    useGlmStore
      .getState()
      .setSpan(glmVisible && follows && spanFirst !== null && spanLast !== null ? [spanFirst, spanLast] : null);
  }, [glmVisible, isRadar, isSat, isLsr, isObs, obsForecast, spanFirst, spanLast]);


  const scrub = (h: number) => {
    const clamped = Math.max(0, Math.min(h, maxHour));
    if (isRadar) void useNexradStore.getState().showIndex(clamped);
    else if (isSat) useSatStore.getState().setIndex(clamped);
    else if (isObs) useObsStore.getState().setIndex(clamped);
    else if (isLsr) useLsrStore.getState().setEndUnix(times?.[clamped] ?? null);
    else if (isFronts) useFrontsStore.getState().setIndex(clamped);
    else if (open) setHour(clamped);
    else setPreselectHour(clamped);
  };
  const step = (delta: number) => {
    if (isRadar || isSat || isObs || isLsr || isFronts) scrub(value + delta);
    else if (open) stepHour(delta);
    else scrub(value + delta);
  };
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
    /** What this play told the layers it will show next (lib/playAhead). */
    let published: ((index: number) => number) | null = null;
    const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    /** About one frame of the screen. A timer, not requestAnimationFrame: that
     *  one stops while the window is covered, and the play with it. */
    const aFrame = () => wait(16);

    // Radar: frames are cached and meshed locally (~65 ms), but a cold one still
    // has to be fetched, so keep waiting for the commit before advancing --
    // same rule as soundings: never run ahead of what's drawn.
    // Play pressed on the last frame plays from the first, repeat on or off:
    // with repeat off, the end check took the frame it started on for the end
    // of the play and stopped at once -- play on the live scan did nothing.
    //
    // It also buffers, like a video. A scan not yet cached costs its download
    // at the moment it is due, so the first pass through a loop stepped at the
    // speed of downloads -- 800 ms a frame where the setting says 250 -- and
    // only ran smoothly the second time round. Play holds instead (the loading
    // card shows the loop coming in) until the next RADAR_BUFFER scans are
    // cached, then plays at its own pace; the warm-up runs well ahead of that.
    async function runRadar() {
      let stepped = false;
      let buffering = true;
      let bufferSince = performance.now();
      const nextOf = (index: number, max: number) => (index >= max ? 0 : index + 1);
      /** How many scans after the one on screen pass `ok`, in play order. */
      const countAhead = (rs: ReturnType<typeof useNexradStore.getState>, want: number, ok: (i: number) => boolean) => {
        const max = Math.max(rs.scans.length - 1, 0);
        let i = rs.index;
        let n = 0;
        while (n < want) {
          i = nextOf(i, max);
          if (!ok(i)) break;
          n++;
        }
        return n;
      };
      // The warm-up runs outward from the scan on screen, and play usually
      // starts on the newest -- whose "ahead" is the start of the loop, warmed
      // last. Aim it where the play is going; it also builds the meshes there.
      {
        const rs = useNexradStore.getState();
        rs.prefetch(nextOf(rs.index, Math.max(rs.scans.length - 1, 0)));
      }
      // A clock, as in runFrames: it runs at the speed asked and each step
      // shows the scan due by it, stepping over scans while the map cannot
      // keep up. Buffering stops it.
      let shownAt = performance.now();
      let shown = useNexradStore.getState().index;
      let clockScan = shown;
      let clockAt = performance.now();
      while (!cancelled) {
        if (buffering) {
          const rs = useNexradStore.getState();
          const want = Math.min(RADAR_BUFFER, Math.max(rs.scans.length - 1, 0));
          // The data of the next RADAR_BUFFER scans, and the meshes of the next
          // few: the rest are built on the workers as the play goes.
          const meshes = Math.min(RADAR_MESHES_READY, want);
          const done =
            (rs.warm >= rs.scans.length || countAhead(rs, want, rs.isWarmAt) >= want) &&
            countAhead(rs, meshes, rs.isMeshedAt) >= meshes;
          if (!done && performance.now() - bufferSince < BUFFER_MAX_MS) {
            await wait(120);
            continue;
          }
          buffering = false;
          clockScan = rs.index;
          clockAt = performance.now();
        }
        const per = getSetting<number>("timeline.radarMs") / speed;
        {
          const at = useNexradStore.getState().index;
          // Moved by hand: the clock starts again from there.
          if (at !== shown) {
            shown = at;
            clockScan = at;
            clockAt = performance.now();
          }
          const nextDue = clockAt + (at + 1 - clockScan) * per;
          await wait(Math.max(0, nextDue - performance.now(), MIN_FRAME_MS - (performance.now() - shownAt)));
        }
        if (cancelled) return;
        const rs = useNexradStore.getState();
        const max = Math.max(rs.scans.length - 1, 0);
        const atEnd = rs.index >= max;
        if (atEnd && !loop && stepped) {
          setPlaying(false);
          return;
        }
        // The scan due by the clock; never past the newest.
        const due = clockScan + Math.floor((performance.now() - clockAt) / per);
        const target = atEnd ? 0 : Math.min(Math.max(rs.index + 1, due), max);
        // Caught up with the warm-up: hold for another buffer's worth, asking
        // for the scans from here on first.
        if (!rs.isWarmAt(target) && rs.warm < rs.scans.length) {
          rs.prefetch(target);
          buffering = true;
          bufferSince = performance.now();
          continue;
        }
        stepped = true;
        shownAt = performance.now();
        const ok = await rs.showIndex(target);
        if (cancelled) return;
        if (!ok) {
          setPlaying(false);
          return;
        }
        shown = target;
        if (atEnd) {
          clockScan = target;
          clockAt = shownAt;
        }
      }
    }

    async function run() {
      let stepped = false;
      while (!cancelled) {
        await wait(getSetting<number>("timeline.soundingMs") / speed);
        if (cancelled) return;
        const st = useSoundingViewerStore.getState();
        if (!st.data) return;
        const max = Math.max(st.data.meta.forecastMaxHour ?? st.data.meta.nTimes - 1, 0);
        const atEnd = st.hour >= max;
        if (atEnd && !((loop || !stepped) && max > 0)) {
          setPlaying(false);
          return;
        }
        stepped = true;
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
    // Storm reports step the 15-minute grid; each frame is a
    // fresh window fetch, so wait for it to land before advancing.
    async function runLsr() {
      let stepped = false;
      while (!cancelled) {
        await wait(getSetting<number>("timeline.lsrMs") / speed);
        if (cancelled) return;
        const ls = useLsrStore.getState();
        const current = ls.endUnix ?? lsrTimes[lsrTimes.length - 1];
        const i = Math.max(0, lsrTimes.indexOf(current));
        const atEnd = i >= lsrTimes.length - 1;
        if (atEnd && !loop && stepped) {
          setPlaying(false);
          return;
        }
        stepped = true;
        ls.setEndUnix(lsrTimes[atEnd ? 0 : i + 1]);
        await wait(120);
        for (let k = 0; k < 250 && useLsrStore.getState().busy; k++) {
          if (cancelled) return;
          await wait(100);
        }
      }
    }

    // The analyses play while the rest of the loop downloads, in order, like a
    // video buffering: the next frame shows as soon as it is on this machine,
    // play holds only while it is still coming, and a frame that failed is
    // stepped past. The loop downloads from the frame on screen onward, twelve
    // at a time, so on a cold run the frames arrive about as fast as they are
    // played. (It used to step onto the next frame and wait there for that one
    // download.) With `here` left out, every frame counts as here.
    async function runFrames(
      read: () => { index: number; length: number; busy: boolean },
      go: (i: number) => void,
      /** Time frame i stays on screen at 1x, read each step so a change in
       *  Settings lands mid-loop. It runs from the moment the frame is put on
       *  screen, so the paint is inside it rather than added on top. */
      dwell: (i: number) => number,
      /** First frame of the loop; the end wraps back here. */
      first = 0,
      /** Whether frame i can be shown at once. */
      here: (i: number) => boolean = () => true,
      /** Whether everything the loop will bring has come (made, or failed). */
      settled: () => boolean = () => true,
      /** Whether frame i failed to come: stepped past rather than waited on. */
      failed: (i: number) => boolean = () => false,
      /** Whose frames these are, for the layers that ready them ahead. */
      driver?: PlayDriver,
    ) {
      /** The next frame after `index` to show -- round to `first` when looping,
       *  past any that failed; -1 while the next one is still on its way.
       *  While the loop downloads (`loading`) it also steps past frames not here
       *  yet, and goes round even with looping off: the play keeps its speed
       *  over what has come instead of stopping at the gap. The loop downloads
       *  spread over its whole span (lib/loopOrder), so what has come covers it
       *  all, a little coarser in time until the rest is in. Holding at the gap
       *  (for six frames, then slowing down to the download's pace instead)
       *  read as the loop freezing every few seconds: an MRMS loop of 240
       *  frames comes in at ~1.3 a second, the play shows 2.5 (Pablo, 2026-09-26). */
      const nextFrom = (index: number, length: number, loading = false): number => {
        const order: number[] = [];
        for (let i = index + 1; i < length; i++) order.push(i);
        if (loop || loading) for (let i = first; i < Math.min(index, length); i++) order.push(i);
        for (const i of order) {
          if (here(i)) return i;
          if (!failed(i) && !loading) return -1;
        }
        return -1;
      };
      // Pressing play on the newest frame means "play the loop", not "stop at
      // once because this is the end": start from its first frame here.
      {
        const { index, length } = read();
        if (length > 0 && (index >= length - 1 || index < first)) {
          // The first frame that is here -- or the first one, when none has
          // come yet (a loop just starting to download): staying on the newest
          // frame, the loop below took it for the end and stopped the play.
          // Not the newest itself: it is here (it is on screen), and going
          // "back" to it stayed at the end.
          let to = first;
          for (let i = first; i < length - 1; i++) {
            if (here(i)) {
              to = i;
              break;
            }
          }
          go(to);
          await wait(60);
        }
      }
      /** Frames here in the rest of the loop, in play order, up to `want`
       *  (past the ones still downloading: see nextFrom). */
      const readyAhead = (index: number, length: number, want: number): number => {
        let n = 0;
        let i = index;
        for (let k = 0; k < length && n < want; k++) {
          i = i + 1 < length ? i + 1 : first;
          if (i === index) break;
          if (here(i)) n++;
        }
        return n;
      };
      /** Where each frame starts on the play's clock, in ms at this speed:
       *  [i] for frame i, [length] for the end of the loop. */
      const starts = (length: number): number[] => {
        const p = [0];
        for (let k = 0; k < length; k++) p.push(p[k] + dwell(k) / speed);
        return p;
      };
      /** The last frame due by clock time `c`: after `index`, short of the end. */
      const dueBy = (p: number[], index: number, c: number): number => {
        let t = index + 1;
        while (t + 1 < p.length - 1 && p[t + 1] <= c) t++;
        return t;
      };
      /** How long a step really takes, smoothed: the layers ready the frames a
       *  step that long lands on (lib/playAhead), not the next in a row. */
      let stepMs = MIN_FRAME_MS;
      if (driver) {
        published = (i: number) => {
          const length = read().length;
          if (i >= length - 1) return first;
          const p = starts(length);
          return dueBy(p, i, p[i] + Math.max(stepMs, p[i + 1] - p[i]));
        };
        setPlayNext(driver, published);
      }
      // At the start it holds until a few frames are here rather than stepping
      // each one the moment it lands, which read as a stutter at the start of
      // every play. From then on it never holds while anything is here.
      let buffering = true;
      let bufferSince = performance.now();
      let shownAt = performance.now();
      let shown = read().index;
      // The play keeps a clock, like a video: it runs at the speed asked, and
      // each step shows the frame due by it. While the map keeps up, that is
      // every frame; when a frame takes longer to draw than its share of time,
      // the clock has moved on and the play steps over frames rather than fall
      // behind -- at 80x a model loop covers time at 80x on any machine, not
      // at whatever the map can paint (it got a third of that, 2026-10-03).
      // Waits for frames still to come stop the clock, like a video
      // buffering, so a cold loop drops nothing.
      let clockFrame = shown;
      let clockAt = performance.now();
      const anchor = (i: number) => {
        clockFrame = i;
        clockAt = performance.now();
      };
      /** Waits with the clock stopped. */
      const hold = async (ms: number) => {
        const from = performance.now();
        await wait(ms);
        clockAt += performance.now() - from;
      };
      while (!cancelled) {
        if (buffering) {
          const { index, length } = read();
          const want = Math.min(START_BUFFER, Math.max(length - 1, 0));
          if (!settled() && readyAhead(index, length, want) < want && performance.now() - bufferSince < BUFFER_MAX_MS) {
            await wait(100);
            continue;
          }
          buffering = false;
          anchor(index);
        }
        const { index, length } = read();
        if (length === 0) return;
        // Moved by hand: the clock starts again from there.
        if (index !== shown) {
          shown = index;
          anchor(index);
        }
        const loading = !settled();
        const p = starts(length);
        if (index >= length - 1 && !loop && !loading) {
          await wait(Math.max(0, p[length] - p[index] - (performance.now() - shownAt)));
          setPlaying(false);
          return;
        }
        // The next frame's time on the clock, and never sooner than
        // MIN_FRAME_MS after this one went up.
        const nextDue = clockAt + p[index + 1] - p[clockFrame];
        await wait(Math.max(0, nextDue - performance.now(), MIN_FRAME_MS - (performance.now() - shownAt)));
        if (cancelled) return;
        if (read().index !== index || read().length !== length) continue;
        let next: number;
        if (index >= length - 1) {
          // Round to the start (looping, or the loop still coming in).
          next = nextFrom(index, length, loading);
          if (next < 0) {
            await hold(100);
            continue;
          }
        } else {
          const t = dueBy(p, index, p[clockFrame] + (performance.now() - clockAt));
          if (here(t)) next = t;
          else if (failed(t)) {
            // Failed on the way: past it, or onto it the plain way, which asks
            // for it again, rather than wait forever.
            const past = nextFrom(t, length, loading);
            next = past > t ? past : t;
          } else if (loading) {
            // Not here yet while the loop downloads: whatever is next that is
            // (lib/loopOrder spreads the download over the whole span), and
            // with nothing, wait for anything.
            next = nextFrom(index, length, true);
            if (next < 0) {
              await hold(100);
              continue;
            }
          } else {
            // All has come but this one is not ready to show (its sharp
            // picture: SHARP_GRACE_MS at most): wait for it.
            await hold(16);
            continue;
          }
        }
        const stepped = performance.now() - shownAt;
        go(next);
        shown = next;
        shownAt = performance.now();
        if (next < index) anchor(next);
        stepMs = stepMs * 0.7 + Math.min(Math.max(stepped, MIN_FRAME_MS), 1000) * 0.3;
        // The layers start their paint as the index changes; a frame of the
        // screen later, busy says whether it is done (it used to be a flat
        // 60 ms, more than the whole of a frame at 20x).
        await aFrame();
        for (let k = 0; k < 900 && read().busy; k++) {
          if (cancelled) return;
          await aFrame();
        }
      }
    }

    // Fronts step frame by frame; each is already in memory, so the only wait
    // is the paint.
    async function runFronts() {
      let stepped = false;
      while (!cancelled) {
        await wait(getSetting<number>("timeline.frontsMs") / speed);
        if (cancelled) return;
        const fs = useFrontsStore.getState();
        const atEnd = fs.index >= fs.frames.length - 1;
        if (atEnd && !loop && stepped) {
          setPlaying(false);
          return;
        }
        stepped = true;
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
            0,
            (i) => {
              const f = useSatStore.getState().frames[i];
              return !!f && satFrameHere(f.time);
            },
            () => {
              const s = useSatStore.getState();
              return s.loopTotal === 0 || s.loopLoaded >= s.loopTotal;
            },
            (i) => {
              const f = useSatStore.getState().frames[i];
              return !!f && satFrameFailed(f.time);
            },
            "sat",
          )
      : isObs
        ? runFrames(
            () => {
              const s = useObsStore.getState();
              return { index: s.index, length: s.frames.length, busy: s.busy };
            },
            (i) => useObsStore.getState().setIndex(i),
            // The whole timeline is the loop now -- its length is picked in
            // the panel -- and its frames are made ahead of the play. Each
            // frame holds its share of the time, so forecast time moves at one
            // speed through runs whose step widens (see timeShare).
            (i) => getSetting<number>("timeline.obsMs") * timeShare(useObsStore.getState().frames, i),
            0,
            (i) => {
              const s = useObsStore.getState();
              const f = s.frames[i];
              const want = f ? `${s.source}|${s.field}|${f.key}` : "";
              // Zoomed in, a frame is ready once its sharp picture is too.
              return !!f && obsFramesHere.has(want) && obsSharpReady(want);
            },
            () => {
              const s = useObsStore.getState();
              return (s.loopTotal === 0 || s.loopLoaded >= s.loopTotal) && !obsSharpBusy();
            },
            (i) => {
              const s = useObsStore.getState();
              const f = s.frames[i];
              return !!f && obsFramesFailed.has(`${s.source}|${s.field}|${f.key}`);
            },
            "obs",
          )
          : isLsr
            ? runLsr()
            : isFronts
              ? runFronts()
              : run());
    return () => {
      cancelled = true;
      if (published) clearPlayNext(published);
    };
  }, [playing, speed, loop, canPlay, isRadar, isSat, isObs, isLsr, isFronts, gotoPlaybackHour, setPendingHour]);

  // Stopping a loop's download from its loading card pauses the play: frames
  // that will not arrive are not worth waiting on.
  useEffect(() => {
    const offObs = useObsStore.subscribe((s, prev) => {
      if (s.loopStops !== prev.loopStops) setPlaying(false);
    });
    const offSat = useSatStore.subscribe((s, prev) => {
      if (s.loopStops !== prev.loopStops) setPlaying(false);
    });
    return () => {
      offObs();
      offSat();
    };
  }, []);

  // The analyses layer hides its zoom detail while a loop plays.
  useEffect(() => {
    useObsStore.getState().setPlaying(playing && isObs);
  }, [playing, isObs]);
  useEffect(() => {
    useSatStore.getState().setPlaying(playing && isSat);
  }, [playing, isSat]);

  // The rest of the app follows a play through here (the loading card shows a
  // radar loop coming in), and its Stop pauses it.
  const driver = isRadar ? "radar" : isSat ? "sat" : isObs ? "obs" : isLsr ? "lsr" : isFronts ? "fronts" : active ? "sounding" : null;
  useEffect(() => {
    useTimelineStore.getState().setPlaying(playing, driver);
  }, [playing, driver]);
  useEffect(() => useTimelineStore.subscribe((s, prev) => {
    if (s.stops !== prev.stops) setPlaying(false);
  }), []);

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

  // Observed products read as a clock time; a model forecast leads with its hour.
  const obsFrame = isObs ? obsFrames[value] : undefined;
  const chip = isSat && satDaily
    ? fmtObsShort(selectedUnix)
    : isRadar || isSat || isObs
    ? `${obsFrame?.fh != null ? `${fhText(obsFrame)} · ` : ""}${fmtScan(selectedUnix)}`
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
          if (!playing && isObs) useObsStore.getState().armLoop();
          if (!playing && isSat) useSatStore.getState().armLoop();
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
      <SpeedPicker speed={speed} onChange={setSpeed} disabled={!canPlay} />

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
