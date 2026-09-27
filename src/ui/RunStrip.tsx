import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Pause, Play, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { useObsStore } from "../store/useObsStore";
import { fetchObsStrip, fhText, prefetchObsLoop, type ObsStripRun } from "../lib/observations";
import { describe } from "../lib/patience";

// Compare runs: the main map at one valid time, and along the bottom the runs
// that forecast it, oldest first -- F048 from the run two days before down to
// F001 from the last one. Picking a run shows its forecast for that same
// moment; play steps through them all, which is how the forecast for the
// moment changed as it came nearer.
//
// The moment is the one on the timeline. The runs and all their hours are
// fetched once, and which of them reach the moment is worked out here, so the
// strip keeps up with the timeline -- scrubbing or playing, a moment 30 hours
// ahead is reached only by the long runs (HRRR 00/06/12/18Z) and the strip
// shortens at once. Picking a run loads that run's hours into the timeline,
// with the dot staying on the same moment.

/** How long each run stays up while playing, once its picture is drawn. */
const HOLD_MS = 900;
/** A run whose picture has not come by then is skipped while playing. */
const GIVE_UP_MS = 12_000;
/** New runs come out through the day: the list is fetched again this often. */
const REFRESH_MS = 3 * 60_000;
/** A list answered without its newest runs is asked for again after this. */
const PARTIAL_RETRY_MS = 2_500;
/** The moment has to sit still this long before its runs' pictures are made ahead. */
const SETTLE_MS = 700;

interface Chip {
  run: string;
  title: string;
  key: string;
  sub: string;
}

function whenText(unix: number): string {
  const d = new Date(unix * 1000);
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${wd} ${d.getUTCDate()} ${mo} ${String(d.getUTCHours()).padStart(2, "0")}Z`;
}

export function RunStrip() {
  const view = useObsStore((s) => s.view);
  const setView = useObsStore((s) => s.setView);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const catalog = useObsStore((s) => s.catalog);
  const frame = useObsStore((s) => s.frames[s.index]);
  const timelinePlaying = useObsStore((s) => s.playing);
  const drawn = useObsStore((s) => s.drawn);
  const busy = useObsStore((s) => s.busy);
  const on = useAppStore((s) => s.layers.observations?.visible ?? false);

  const src = catalog?.sources.find((s) => s.id === source);
  const active = view === "runs" && on && !!src?.forecast && !src.tracks;
  const unix = frame?.unix;
  const onScreen = frame?.run;
  // A tropical model's strip is the runs made for the storm on screen.
  const tropical = src?.group === "Tropical";
  const storm = tropical ? onScreen?.split("~")[1] : undefined;
  const stormRun = useRef<string | undefined>(undefined);
  stormRun.current = tropical ? onScreen : undefined;

  const [runs, setRuns] = useState<ObsStripRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [playing, setPlaying] = useState(false);
  const row = useRef<HTMLDivElement | null>(null);

  // The colour bars sit where the strip goes; they move up while it is open.
  useEffect(() => {
    document.documentElement.classList.toggle("has-runstrip", active);
    return () => document.documentElement.classList.remove("has-runstrip");
  }, [active]);

  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  // Another model starts from nothing: its runs are not these.
  useEffect(() => {
    setRuns(null);
  }, [source, storm]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setRefresh((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  // The runs and every hour of each that is out. The server answers at once
  // with the runs that need no looking up; the newest, still coming out, are
  // looked up behind that answer and picked up by asking again shortly.
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    let again = 0;
    setError(null);
    fetchObsStrip(source, ctrl.signal, stormRun.current)
      .then((got) => {
        if (ctrl.signal.aborted) return;
        setRuns(got.runs);
        if (got.partial) again = window.setTimeout(() => setRefresh((n) => n + 1), PARTIAL_RETRY_MS);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(describe(err, "The runs"));
      });
    return () => {
      ctrl.abort();
      window.clearTimeout(again);
    };
  }, [active, source, storm, refresh]);

  // Which of them reach the moment on the timeline, and at what hour of each.
  const chips = useMemo<Chip[] | null>(() => {
    if (!runs || unix == null) return null;
    const out: Chip[] = [];
    for (const r of runs) {
      const f = r.frames.find((x) => x.unix === unix);
      if (f) out.push({ run: r.run, title: r.title, key: f.key, sub: fhText(f) });
    }
    return out;
  }, [runs, unix]);

  // Their pictures made ahead once the moment sits still, so stepping through
  // them is a swap -- not while the timeline plays, and not over a loop of the
  // timeline's own still downloading (one loop is made at a time).
  useEffect(() => {
    if (!active || timelinePlaying || !chips || chips.length < 2) return;
    const timer = window.setTimeout(() => {
      const s = useObsStore.getState();
      if (s.loopKeys.length && s.loopLoaded < s.loopTotal) return;
      prefetchObsLoop(
        source,
        field,
        chips.map((c) => c.key),
      ).catch(() => {
        /* each is made when picked instead */
      });
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [active, timelinePlaying, chips, source, field]);

  const n = chips?.length ?? 0;
  const at = chips ? chips.findIndex((c) => c.run === onScreen) : -1;

  const pick = (i: number) => {
    const c = chips?.[i];
    if (!c || unix == null) return;
    useObsStore.getState().setRun(c.run, unix);
  };

  // Playing: each run held a moment once its picture is on the map, then the
  // next, oldest to newest and round again.
  useEffect(() => {
    if (!playing || !chips || chips.length < 2 || unix == null) return;
    if (at < 0) {
      useObsStore.getState().setRun(chips[0].run, unix);
      return;
    }
    const next = () => useObsStore.getState().setRun(chips[(at + 1) % chips.length].run, unix);
    const ready = !busy && drawn === `${source}|${field}|${chips[at].key}`;
    const timer = window.setTimeout(next, ready ? HOLD_MS : GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, chips, at, busy, drawn, source, field, unix]);

  // The timeline playing takes over: two plays at once fight over the map.
  useEffect(() => {
    if (timelinePlaying) setPlaying(false);
  }, [timelinePlaying]);

  // The run on screen kept in sight in a long strip.
  useEffect(() => {
    if (at < 0) return;
    const el = row.current?.children[at] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [at]);

  if (!active) return null;

  const step = (by: number) => {
    setPlaying(false);
    if (!n) return;
    pick(at < 0 ? (by > 0 ? 0 : n - 1) : (at + by + n) % n);
  };

  return (
    <section className="runstrip" aria-label="Compare runs">
      <div className="runstrip__when">
        <span>Runs forecasting</span>
        <b>{unix != null ? whenText(unix) : "—"}</b>
        <span>{chips ? `${n} run${n === 1 ? "" : "s"}, oldest first` : "Finding the runs…"}</span>
      </div>
      <div className="runstrip__ctrl">
        <button type="button" onClick={() => step(-1)} disabled={n < 2} aria-label="Older run" title="Older run">
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          disabled={n < 2 || timelinePlaying}
          aria-label={playing ? "Stop" : "Play through the runs"}
          title={playing ? "Stop" : "Play through the runs, oldest to newest"}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" onClick={() => step(1)} disabled={n < 2} aria-label="Newer run" title="Newer run">
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="runstrip__chips" ref={row}>
        {error ? (
          <span className="runstrip__msg">{error}</span>
        ) : !chips ? (
          <span className="runstrip__msg">
            <Loader2 size={12} className="sfx__status-spin" /> Finding this model's runs…
          </span>
        ) : !n ? (
          <span className="runstrip__msg">No run of this model reaches this hour yet.</span>
        ) : (
          chips.map((c, i) => (
            <button
              key={c.run}
              type="button"
              className={`runstrip__chip${i === at ? " is-on" : ""}`}
              aria-pressed={i === at}
              onClick={() => {
                setPlaying(false);
                pick(i);
              }}
              title={`${c.sub} of the ${c.title} run`}
            >
              <span>{c.title}</span>
              <b>{c.sub}</b>
              {i === at && busy && !timelinePlaying && <Loader2 size={10} className="sfx__status-spin" />}
            </button>
          ))
        )}
      </div>
      <button type="button" className="runstrip__close" onClick={() => setView("single")} aria-label="Back to one map">
        <X size={14} />
      </button>
    </section>
  );
}
