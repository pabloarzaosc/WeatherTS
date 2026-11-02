import { create } from "zustand";

import { BACKEND_BASE } from "../lib/apiConfig";
import { getMap } from "../map/mapInstance";
import { isTdwrId, useNexradStore } from "./useNexradStore";
import { useTimelineStore } from "./useTimelineStore";

/**
 * Storm detections computed by the backend from the radar's own volume
 * (backend/radar_detect.py, GET /api/radar/detections): mesocyclones and weaker
 * circulations, tornado vortex signatures, and tornado debris signatures.
 *
 * The store follows the radar on screen the way the 3D view does: the site the
 * map shows, and the frame the timeline is on (its Level II key when the frame
 * is one, else the volume at or just before its time; the newest volume on the
 * live edge). Panes share the site and the moment, so one result serves them
 * all. A volume takes the backend a few seconds the first time (the download),
 * so while the next one is read the last result stays up, dimmed.
 *
 * Track tails need the volume before: the first answer for a frame comes back
 * untracked, and the store then asks again with `trail` (the backend reads
 * the volume before and links the two) -- markers first, tails a moment later.
 */

export interface DetFeature {
  elev: number;
  heightKm: number;
  vrotKt: number;
  dvKt: number;
  shear: number;
  nrot: number;
  diamKm: number;
  rank: number;
  lat: number;
  lon: number;
}

export interface DetMeso {
  lat: number;
  lon: number;
  azDeg: number;
  rangeKm: number;
  baseKm: number;
  topKm: number;
  depthKm: number;
  nTilts: number;
  rank: number;
  strength: string;
  kind: "meso" | "circulation";
  maxVrotKt: number;
  maxVrotHeightKm: number;
  lowVrotKt: number;
  maxDvKt: number;
  maxShear: number;
  maxNrot: number;
  diamKm: number;
  parts?: number;
  tds: boolean;
  couplet: number | null;
  trackId: number;
  motion: { speedKt: number; toward: number } | null;
  track: { lat: number; lon: number; unix: number; rank: number }[];
  features: DetFeature[];
  hookEcho?: { hook: boolean } | null;
}

export interface DetCouplet {
  lat: number;
  lon: number;
  azDeg: number;
  rangeKm: number;
  elev: number;
  heightKm: number;
  baseKm?: number;
  dvKt: number;
  vrotKt: number;
  vinKt: number;
  voutKt: number;
  gapKm: number;
  nrot: number;
  tilts: number[];
  class: string;
  tvs?: "TVS" | "ETVS" | null;
  /** Why a one-tilt couplet is not believed (class "Unconfirmed"), else null. */
  suspect?: string | null;
  /** Strongest reflectivity within ~1.5 km of the couplet, dBZ. */
  echoDbz?: number | null;
  rank: number;
}

export interface DetDebris {
  lat: number;
  lon: number;
  azDeg: number;
  rangeKm: number;
  baseKm: number;
  topKm: number;
  maxDbz: number;
  minCc: number;
  zdr: number;
  gates: number;
  areaKm2: number;
  tilts: number[];
  rotKm: number;
  rotDvKt: number;
}

export interface Detections {
  site: string;
  siteId: string;
  siteLat: number;
  siteLon: number;
  key: string;
  scanUnix: number | null;
  vcp: number | null;
  dualPol: boolean;
  tilts: number[];
  nyquistKt: number[];
  mesos: DetMeso[];
  couplets: DetCouplet[];
  tds: DetDebris[];
  tracked?: boolean;
  ms: number;
  loadMs: number;
}

/** What is drawn: a column of at least moderate rotation (rank 5 = ~29 kt on
 *  three tilts) that reaches 30 kt somewhere. The weaker ones -- a radar
 *  finds dozens in any storm, and in birds -- stay in the data. */
export function drawnMesos(d: Detections | null): DetMeso[] {
  if (!d) return [];
  return d.mesos.filter((m) => m.rank >= 5 && (m.kind === "meso" || m.maxVrotKt >= 30));
}

export function tvsOf(d: Detections | null): DetCouplet[] {
  return d ? d.couplets.filter((c) => c.tvs === "TVS" || c.tvs === "ETVS") : [];
}

export type DetSelection =
  | { type: "meso"; trackId: number }
  | { type: "tvs"; rank: number }
  | { type: "tds"; index: number };

interface Want {
  site: string;
  key: string;
  at: number | null;
  /** The frame's own time (for picking a kept result while one loads). */
  frame: number | null;
}

interface DetectionsState {
  /** Panes with the layer on; the store follows the radar while > 0. */
  attached: number;
  data: Detections | null;
  /** True while `data` is an earlier volume than the frame on screen. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  selected: DetSelection | null;
  /** The track the map follows, while locked on. */
  lockTrackId: number | null;

  attach: () => void;
  /** `keep`: the layer goes straight back on (a style swap); what is shown stays. */
  detach: (keep?: boolean) => void;
  select: (sel: DetSelection | null) => void;
  lockOn: (trackId: number | null) => void;
}

const wantKey = (w: Want) => `${w.site}|${w.key || (w.at === null ? "newest" : Math.round(w.at))}`;

/** Results by "site|volume key", and which volume each asked-for frame turned out to be. */
const byVolume = new Map<string, Detections>();
const byWant = new Map<string, string>();
const tried = new Set<string>(); // trail asked for, by volume key
const KEEP = 120;

let want: Want | null = null;
let inflight: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubs: (() => void)[] = [];

/** The site the shown result is for (as the radar store names it). */
let dataSite: string | null = null;

function keep(site: string, d: Detections, wk: string | null) {
  const vk = `${site}|${d.key}`;
  byVolume.delete(vk);
  byVolume.set(vk, d);
  if (wk) byWant.set(wk, vk);
  while (byVolume.size > KEEP) byVolume.delete(byVolume.keys().next().value as string);
  while (byWant.size > KEEP * 4) byWant.delete(byWant.keys().next().value as string);
}

async function fetchDetections(w: Want, trail: boolean, signal?: AbortSignal): Promise<Detections> {
  const q = new URLSearchParams({ site: w.site });
  if (w.key) q.set("key", w.key);
  else if (w.at !== null) q.set("at", String(Math.round(w.at)));
  if (trail) q.set("trail", "1");
  const res = await fetch(`${BACKEND_BASE}/api/radar/detections?${q}`, { signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as Detections;
}

/** The frame the radar shows now, as a request. An airport radar has no
 *  detections to ask for: they are computed from NEXRAD volumes. */
function currentWant(): Want | null {
  const s = useNexradStore.getState();
  if (!s.site || !s.scans.length || isTdwrId(s.site)) return null;
  return wantAt(Math.min(s.index, s.scans.length - 1));
}

/** Frame `i` of the radar's loop as a request. */
function wantAt(i: number): Want | null {
  const s = useNexradStore.getState();
  if (!s.site || !s.scans.length || isTdwrId(s.site)) return null;
  const scan = s.scans[i];
  const live = s.archiveTime === null && s.archiveDate === null;
  const newest = live && i >= s.scans.length - 1;
  const key = !newest && scan?.key?.startsWith("L2") ? scan.key : "";
  return { site: s.site, key, at: newest ? null : (scan?.time ?? null), frame: scan?.time ?? null };
}

/** A kept result for this frame, or failing that the nearest kept volume at or
 *  just before it (shown dimmed until the frame's own answer is in). */
function resolveKept(w: Want): { d: Detections; exact: boolean } | null {
  const vk = byWant.get(wantKey(w));
  const hit = vk ? byVolume.get(vk) : undefined;
  if (hit) return { d: hit, exact: true };
  if (w.frame === null) return null;
  let best: Detections | null = null;
  const prefix = `${w.site}|`;
  for (const [vk, d] of byVolume) {
    if (!vk.startsWith(prefix)) continue;
    if (d.scanUnix === null || d.scanUnix > w.frame + 60 || w.frame - d.scanUnix > 8 * 60) continue;
    if (!best || (best.scanUnix ?? 0) < d.scanUnix) best = d;
  }
  return best ? { d: best, exact: false } : null;
}

function show(d: Detections | null, stale: boolean, site: string | null = want?.site ?? null) {
  dataSite = d ? site : null;
  const st = useDetectionsStore.getState();
  let selected = st.selected;
  if (selected && d) {
    const sel = selected;
    const ok =
      sel.type === "meso"
        ? d.mesos.some((m) => m.trackId === sel.trackId)
        : st.data?.key === d.key; // a TVS or debris pick holds only on its volume
    if (!ok) selected = null;
  } else if (!d) selected = null;
  useDetectionsStore.setState({ data: d, stale, selected });
  // Locked on: the map follows the detection's track.
  const lock = useDetectionsStore.getState().lockTrackId;
  if (lock !== null && d && !stale) {
    const m = d.mesos.find((q) => q.trackId === lock);
    const map = getMap();
    if (m && map) map.easeTo({ center: [m.lon, m.lat], duration: 700 });
  }
}

// While the loop plays, the volumes just ahead of the frame on screen are
// asked for too (a small queue, three at a time), so a loop fills in on its
// first pass instead of only ever answering the frame it has already left.
// A site change cancels them.
const AHEAD = 4;
const AHEAD_AT_ONCE = 3;
const ahead = new Set<string>(); // want keys being read ahead
// How long a read-ahead takes and how fast the loop steps: the queue starts
// as many frames ahead as the loop moves while one request runs, so its
// answers land as the loop gets there instead of just after it has passed.
let reqMs = 4000;
let frameMs = 700;
let lastStepAt = 0;
let lastStepIdx = -1;

function noteStep(index: number) {
  const now = performance.now();
  if (lastStepIdx >= 0 && index === lastStepIdx + 1 && now - lastStepAt < 5000) {
    frameMs = 0.7 * frameMs + 0.3 * (now - lastStepAt);
  }
  lastStepIdx = index;
  lastStepAt = now;
}
let aheadSite: string | null = null;
let aheadCtrl: AbortController | null = null;

function cancelAhead() {
  aheadCtrl?.abort();
  aheadCtrl = null;
  ahead.clear();
  aheadSite = null;
}

function pumpAhead() {
  if (!want || !useTimelineStore.getState().playing) return;
  const s = useNexradStore.getState();
  const n = s.scans.length;
  if (n < 2 || s.site !== want.site) return;
  if (aheadSite !== want.site) {
    cancelAhead();
    aheadSite = want.site;
  }
  if (!aheadCtrl) aheadCtrl = new AbortController();
  const ctrl = aheadCtrl;
  const cur = Math.min(s.index, n - 1);
  const lead = Math.max(1, Math.min(n - 1, Math.ceil(reqMs / Math.max(100, frameMs))));
  for (let k = lead; k < lead + Math.min(AHEAD, n - 1) && ahead.size < AHEAD_AT_ONCE; k++) {
    const w = wantAt((cur + k) % n);
    if (!w) continue;
    const wk = wantKey(w);
    if (byWant.has(wk) || ahead.has(wk) || inflight === wk) continue;
    ahead.add(wk);
    const t0 = performance.now();
    fetchDetections(w, false, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        reqMs = 0.6 * reqMs + 0.4 * (performance.now() - t0);
        keep(w.site, d, wk);
        // The loop got there first: show it now.
        if (want && wantKey(want) === wk) show(d, false);
      })
      .catch(() => {
        /* the frame's own request will report it */
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        ahead.delete(wk);
        pumpAhead();
      });
  }
}

function pump() {
  pumpAhead();
  if (inflight || !want) return;
  const w = want;
  const wk = wantKey(w);
  // Already being read ahead: that answer shows it.
  if (ahead.has(wk)) return;
  const vk = byWant.get(wk);
  const kept = vk ? byVolume.get(vk) : undefined;
  const playing = useTimelineStore.getState().playing;
  // The frame is answered; while still, ask for the trail once.
  const trail = !!kept && !kept.tracked && kept.mesos.length > 0 && !playing && !tried.has(vk as string);
  if (kept && !trail) return;
  if (kept) tried.add(vk as string);
  inflight = wk;
  if (!kept) useDetectionsStore.setState({ loading: true });
  fetchDetections(w, trail)
    .then((d) => {
      keep(w.site, d, wk);
      if (want && wantKey(want) === wk) {
        useDetectionsStore.setState({ error: null });
        show(d, false);
      }
    })
    .catch((e: unknown) => {
      if (want && wantKey(want) === wk && !trail) {
        useDetectionsStore.setState({ error: e instanceof Error ? e.message : String(e) });
        if (dataSite !== w.site) show(null, false);
      }
    })
    .finally(() => {
      inflight = null;
      useDetectionsStore.setState({ loading: false });
      pump();
    });
}

/** The radar moved on (another frame, site or mode): show what is kept for
 *  it and ask for the rest. Debounced so a scrub asks only where it stops. */
function follow() {
  const w = currentWant();
  const prevSite = want?.site;
  want = w;
  if (!w) {
    show(null, false);
    return;
  }
  if (prevSite && prevSite !== w.site) {
    useDetectionsStore.setState({ lockTrackId: null, error: null });
    cancelAhead();
  }
  const kept = resolveKept(w);
  if (kept) show(kept.d, !kept.exact);
  else if (dataSite !== w.site) show(null, false);
  else if (useDetectionsStore.getState().data) useDetectionsStore.setState({ stale: true });
  // Playing, the frames change faster than the debounce: read ahead now.
  if (useTimelineStore.getState().playing) noteStep(useNexradStore.getState().index);
  pumpAhead();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, kept?.exact ? 0 : 250);
}

function start() {
  unsubs.push(
    useNexradStore.subscribe((s, p) => {
      if (
        s.site !== p.site ||
        s.scans !== p.scans ||
        s.index !== p.index ||
        s.archiveTime !== p.archiveTime ||
        s.archiveDate !== p.archiveDate
      )
        follow();
    }),
    // Stopping the loop is when the trail is worth asking for.
    useTimelineStore.subscribe((s, p) => {
      if (p.playing && !s.playing) pump();
      else if (!p.playing && s.playing) pumpAhead();
    }),
  );
  follow();
}

function stop() {
  for (const u of unsubs) u();
  unsubs = [];
  if (timer) clearTimeout(timer);
  timer = null;
  want = null;
  cancelAhead();
  useDetectionsStore.setState({ data: null, stale: false, selected: null, lockTrackId: null, loading: false, error: null });
}

export const useDetectionsStore = create<DetectionsState>((set, get) => ({
  attached: 0,
  data: null,
  stale: false,
  loading: false,
  error: null,
  selected: null,
  lockTrackId: null,

  attach: () => {
    const n = get().attached + 1;
    set({ attached: n });
    if (n === 1 && !unsubs.length) start();
  },
  detach: (keep) => {
    const n = Math.max(0, get().attached - 1);
    set({ attached: n });
    if (n === 0 && !keep) stop();
  },
  select: (selected) => set({ selected }),
  lockOn: (trackId) => {
    set({ lockTrackId: trackId });
    const d = get().data;
    const m = trackId !== null ? d?.mesos.find((q) => q.trackId === trackId) : undefined;
    const map = getMap();
    if (m && map) map.easeTo({ center: [m.lon, m.lat], duration: 600 });
  },
}));

/** Colour step by rotational velocity (kt): the tokens in detections.css. */
export function vrotTone(kt: number): "weak" | "orange" | "red" | "magenta" | "purple" {
  if (kt >= 80) return "purple";
  if (kt >= 65) return "magenta";
  if (kt >= 50) return "red";
  if (kt >= 30) return "orange";
  return "weak";
}
