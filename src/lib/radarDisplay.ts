// Radar display transforms, applied to a pane's scan just before its mesh is
// built (useNexradStore showIndex -> build):
//
//  - Gate filter (settings radar.gateLow / radar.gateHigh, 0..95 dBZ = off):
//    gates whose REFLECTIVITY is outside [low, high] are hidden. A reflectivity
//    pane tests its own values; velocity, dual-pol, NROT, VROT ... test the
//    reflectivity of the same tilt at the same time, gate by gate, so the same
//    gates go on every pane. With the low end on, a gate with no reflectivity
//    at all (clear air, below the radar's floor) is hidden too.
//  - Maximum value trail (per pane, T key): each point keeps the highest value
//    it has had since the loop's first frame -- hail cores leave their swath,
//    NROT / VROT / PTDS the rotation or debris path. Computed here in the
//    browser over the loop's frames, every frame resampled onto the FIRST
//    frame's polar grid (same radar, so azimuth/range line up exactly).
//
// The fold is done in code space: each frame's 256 codes are mapped once into
// the first frame's codes (identity when the tables match, as they do within a
// product), and a gate keeps whichever code ranks higher by value. No float
// arrays per frame, no per-gate encoding.
//
// This module reads settings only and takes everything radar-store shaped as
// callbacks: the store imports it, so it must not import the store back
// (radarDisplayInstall.ts wires the reloads).

import { getSetting } from "../settings/useSettingsStore";
import type { PolarScan } from "./radarMesh";

export interface DisplayCtx {
  paneId: string | null;
  /** The pane's radar and the product / frame key actually drawn. */
  site: string;
  product: string;
  key: string;
  scan: PolarScan;
  /** Scan of another product of this radar. */
  load: (product: string, key: string) => Promise<PolarScan>;
  /** The key of `product` that goes with the frame on screen. */
  refKey: (product: string) => Promise<string>;
  /** The trail is on for this pane: this pane's product's keys over the loop
   *  from its first frame up to the one on screen, oldest first. Null when the
   *  pane cannot have a trail (another radar than the loop's). */
  trailKeys: (() => Promise<string[]>) | null;
}

export interface Displayed {
  scan: PolarScan;
  /** Appended to the mesh cache key: "" when nothing changed. */
  tag: string;
}

const GATE_MAX = 95;

/** The gate filter's [low, high] dBZ, or null when it is off (0..95). */
export function gateFilter(): [number, number] | null {
  let lo = Number(getSetting<number>("radar.gateLow"));
  let hi = Number(getSetting<number>("radar.gateHigh"));
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = GATE_MAX;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo <= 0 && hi >= GATE_MAX) return null;
  return [lo, hi];
}

/** The reflectivity code of the same tilt for a tilted product, or null
 *  (whole-volume products: echo tops, VIL, precipitation ... are left alone). */
export function refCodeFor(product: string): string | null {
  // A TDWR's velocity: the reflectivity of the same tilt is TZ<tilt>.
  if (/^TV[012]$/.test(product)) return `TZ${product[2]}`;
  // Level III: N<tilt><family>, e.g. N0G velocity -> N0B.
  let m = /^N([0-9A-Z])([A-Z])$/.exec(product);
  if (m) return m[2] === "B" ? null : `N${m[1]}B`;
  // Level II per-tilt moments and the derived per-tilt products (velocity
  // options ride along as "_..." suffixes: L2G0_V).
  m = /^L2(G|C|X|W|P|F|K|S|VROT|PTDS|U|Q)([0-9A-Z])(?:_[0-9A-Z.-]+)*$/.exec(product);
  if (m) return `L2B${m[2]}`;
  return null;
}

// ---------------------------------------------------------------------------
// Grid helpers

/** Azimuth bin of each 0.1 deg of the circle (-1 = no radial there). */
const azCache = new WeakMap<PolarScan, Int32Array>();
function azLookup(scan: PolarScan): Int32Array {
  const hit = azCache.get(scan);
  if (hit) return hit;
  const { az } = scan;
  const nAz = scan.meta.nAz;
  const out = new Int32Array(3600).fill(-1);
  for (let a = 0; a < nAz; a++) {
    const lo = az[a];
    let hi = az[a + 1];
    if (hi < lo) hi += 360;
    for (let i = Math.ceil(lo * 10 - 0.5); i + 0.5 < hi * 10; i++) out[((i % 3600) + 3600) % 3600] = a;
  }
  azCache.set(scan, out);
  return out;
}

/** For each row of `to`, the row of `from` under its centre azimuth. */
function rowMap(to: PolarScan, from: PolarScan): Int32Array {
  const look = azLookup(from);
  const { az } = to;
  const n = to.meta.nAz;
  const out = new Int32Array(n);
  for (let a = 0; a < n; a++) {
    const lo = az[a];
    let hi = az[a + 1];
    if (hi < lo) hi += 360;
    const mid = ((lo + hi) / 2) % 360;
    out[a] = look[Math.min(3599, Math.floor(mid * 10))];
  }
  return out;
}

/** For each gate of `to`, the gate of `from` at its centre range (-1 = none). */
function gateMap(to: PolarScan, from: PolarScan): Int32Array {
  const n = to.meta.nGates;
  const out = new Int32Array(n);
  const { rangeStartKm: rs, gateWidthKm: gw } = to.meta;
  const { rangeStartKm: frs, gateWidthKm: fgw, nGates: fn } = from.meta;
  for (let g = 0; g < n; g++) {
    const r = rs + (g + 0.5) * gw;
    const sg = Math.floor((r - frs) / fgw);
    out[g] = sg >= 0 && sg < fn ? sg : -1;
  }
  return out;
}

/** A code meaning "no data" in this scan's table (not the range-folded one). */
function noDataCode(scan: PolarScan): number {
  const rf = scan.meta.rfCode;
  for (let c = 0; c < 256; c++) if (!Number.isFinite(scan.lut[c]) && c !== rf) return c;
  return 0;
}

// ---------------------------------------------------------------------------
// Gate filter

function outside(v: number, lo: number, hi: number): boolean {
  if (!Number.isFinite(v)) return lo > 0; // no echo: below any low end
  return (lo > 0 && v < lo) || (hi < GATE_MAX && v > hi);
}

/** A reflectivity scan filtered by its own values. */
function maskSelf(scan: PolarScan, lo: number, hi: number): PolarScan {
  const hide = new Uint8Array(256);
  const rf = scan.meta.rfCode;
  for (let c = 0; c < 256; c++) hide[c] = c !== rf && Number.isFinite(scan.lut[c]) && outside(scan.lut[c], lo, hi) ? 1 : 0;
  const nd = noDataCode(scan);
  const src = scan.codes;
  const codes = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) codes[i] = hide[src[i]] ? nd : src[i];
  return { ...scan, codes, meta: { ...scan.meta, gateFiltered: [lo, hi] } };
}

/** Any scan filtered by the reflectivity of the same tilt (`ref`). */
function maskByRef(scan: PolarScan, ref: PolarScan, lo: number, hi: number): PolarScan {
  const rows = rowMap(scan, ref);
  const gates = gateMap(scan, ref);
  const nd = noDataCode(scan);
  const rf = scan.meta.rfCode;
  // Per reflectivity code: is it outside the range?
  const bad = new Uint8Array(256);
  for (let c = 0; c < 256; c++) bad[c] = outside(ref.lut[c], lo, hi) ? 1 : 0;
  const { nAz, nGates } = scan.meta;
  const rn = ref.meta.nGates;
  const src = scan.codes;
  const rc = ref.codes;
  const codes = new Uint8Array(src);
  const noRow = lo > 0; // where the reflectivity scan has no radial, nothing is known: low end hides
  for (let a = 0; a < nAz; a++) {
    const sr = rows[a];
    const o = a * nGates;
    if (sr < 0) {
      if (noRow) for (let g = 0; g < nGates; g++) if (src[o + g] !== rf) codes[o + g] = nd;
      continue;
    }
    const ro = sr * rn;
    for (let g = 0; g < nGates; g++) {
      const c = src[o + g];
      if (c === rf) continue; // range folded stays (its own switch)
      const rg = gates[g];
      const out = rg < 0 ? noRow : bad[rc[ro + rg]] === 1;
      if (out) codes[o + g] = nd;
    }
  }
  return { ...scan, codes, meta: { ...scan.meta, gateFiltered: [lo, hi] } };
}

// ---------------------------------------------------------------------------
// Maximum value trail

interface TrailAcc {
  id: string;
  grid: PolarScan; // the first frame: grid, table, meta
  rank: Int16Array; // rank of each code of grid.lut by value (-1 = no data)
  sorted: { v: number; c: number }[]; // finite table entries by value
  noData: number;
  codes: Uint8Array; // running maximum, in grid's codes
  keys: string[]; // the keys folded in, in order
  snaps: Map<number, Uint8Array>; // codes after keys[0..n] -- for scrubbing back
}

const SNAP_EVERY = 8;
const accs = new Map<string, TrailAcc>();

function newAcc(id: string, first: PolarScan): TrailAcc {
  const sorted: { v: number; c: number }[] = [];
  const rf = first.meta.rfCode;
  for (let c = 0; c < 256; c++) if (c !== rf && Number.isFinite(first.lut[c])) sorted.push({ v: first.lut[c], c });
  sorted.sort((a, b) => a.v - b.v);
  const rank = new Int16Array(256).fill(-1);
  sorted.forEach((e, i) => (rank[e.c] = i));
  const noData = noDataCode(first);
  return {
    id, grid: first, rank, sorted, noData,
    codes: new Uint8Array(first.codes.length).fill(noData),
    keys: [], snaps: new Map(),
  };
}

/** The grid's code nearest to a value (exact when the tables match). */
function encode(acc: TrailAcc, v: number): number {
  if (!Number.isFinite(v)) return acc.noData;
  const s = acc.sorted;
  if (!s.length) return acc.noData;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].v <= v) lo = mid;
    else hi = mid - 1;
  }
  const a = s[lo];
  const b = s[Math.min(lo + 1, s.length - 1)];
  return Math.abs(b.v - v) < Math.abs(a.v - v) ? b.c : a.c;
}

/** Fold one frame into the running maximum. */
function foldFrame(acc: TrailAcc, frame: PolarScan): void {
  const g = acc.grid;
  const codeMap = new Uint8Array(256);
  const rf = frame.meta.rfCode;
  for (let c = 0; c < 256; c++) codeMap[c] = c === rf ? acc.noData : encode(acc, frame.lut[c]);
  const same = frame.az === g.az || (frame.meta.nAz === g.meta.nAz && frame.meta.nGates === g.meta.nGates &&
    frame.meta.rangeStartKm === g.meta.rangeStartKm && frame.meta.gateWidthKm === g.meta.gateWidthKm &&
    Math.abs(frame.az[0] - g.az[0]) < 0.05);
  const { rank, codes } = acc;
  const src = frame.codes;
  const { nAz, nGates } = g.meta;
  if (same) {
    for (let i = 0; i < codes.length; i++) {
      const c = codeMap[src[i]];
      if (rank[c] > rank[codes[i]]) codes[i] = c;
    }
    return;
  }
  const rows = rowMap(g, frame);
  const gates = gateMap(g, frame);
  const fn = frame.meta.nGates;
  for (let a = 0; a < nAz; a++) {
    const sr = rows[a];
    if (sr < 0) continue;
    const so = sr * fn;
    const o = a * nGates;
    for (let k = 0; k < nGates; k++) {
      const sg = gates[k];
      if (sg < 0) continue;
      const c = codeMap[src[so + sg]];
      if (rank[c] > rank[codes[o + k]]) codes[o + k] = c;
    }
  }
}

/** A frame with something to fold: not a tilt still to come, not "Not scanned at ...". */
function usable(s: PolarScan): boolean {
  return !s.meta.pending && !(s.meta.elevation == null && /^Not scanned/.test(s.meta.note ?? ""));
}

const locks = new Map<string, Promise<unknown>>();

async function trailScan(ctx: DisplayCtx, keys: string[]): Promise<PolarScan | null> {
  if (keys.length < 2) return null; // one frame: the frame itself
  const id = `${ctx.site}|${ctx.product}`;
  const run = async (): Promise<PolarScan | null> => {
    let acc = accs.get(id);
    // A new first frame (a live loop moved on, another window): start again.
    if (!acc || acc.keys[0] !== keys[0]) {
      const first = await ctx.load(ctx.product, keys[0]).catch(() => null);
      if (!first || !usable(first)) return null;
      acc = newAcc(id, first);
      accs.set(id, acc);
    }
    const a = acc;
    // How much of what is folded in is still the start of this list.
    let common = 0;
    while (common < a.keys.length && common < keys.length && a.keys[common] === keys[common]) common++;
    if (common < a.keys.length) {
      // Scrubbed back (or the list changed): the newest snapshot at or before.
      let best = -1;
      for (const n of a.snaps.keys()) if (n <= common && n > best) best = n;
      if (best > 0) {
        a.codes.set(a.snaps.get(best)!);
        a.keys.length = best;
      } else {
        a.codes.fill(a.noData);
        a.keys.length = 0;
      }
      for (const n of [...a.snaps.keys()]) if (n > a.keys.length) a.snaps.delete(n);
    }
    for (let i = a.keys.length; i < keys.length; i++) {
      const s = i === keys.length - 1 && keys[i] === ctx.key ? ctx.scan : await ctx.load(ctx.product, keys[i]).catch(() => null);
      if (s && usable(s)) foldFrame(a, s);
      a.keys.push(keys[i]);
      if (a.keys.length % SNAP_EVERY === 0) a.snaps.set(a.keys.length, a.codes.slice());
    }
    const meta = {
      ...ctx.scan.meta,
      nAz: a.grid.meta.nAz,
      nGates: a.grid.meta.nGates,
      rangeStartKm: a.grid.meta.rangeStartKm,
      gateWidthKm: a.grid.meta.gateWidthKm,
      rfCode: undefined,
      trailFrames: keys.length,
    };
    return { az: a.grid.az, lut: a.grid.lut, codes: a.codes.slice(), meta };
  };
  // One fold at a time per product: panes and frames asking together queue.
  const p = (locks.get(id) ?? Promise.resolve()).then(run, run);
  locks.set(id, p.catch(() => undefined));
  return p;
}

/** Drop the running trails (a new radar, a product nobody shows any more). */
export function clearTrails(): void {
  locks.clear();
  accs.clear();
}

// ---------------------------------------------------------------------------

/** Finished display scans by mesh tag, so a looping frame is not recomputed. */
const shown = new Map<string, PolarScan>();
const SHOWN_MAX = 24;
function remember(tag: string, scan: PolarScan): PolarScan {
  shown.set(tag, scan);
  while (shown.size > SHOWN_MAX) {
    const k = shown.keys().next().value;
    if (k === undefined) break;
    shown.delete(k);
  }
  return scan;
}

/**
 * The scan a pane should draw: its frame with the trail and the gate filter
 * applied, and the tag that tells its mesh apart in the mesh cache.
 */
export async function displayScan(ctx: DisplayCtx): Promise<Displayed> {
  const { scan } = ctx;
  if (scan.meta.pending) return { scan, tag: "" };
  const gf = gateFilter();
  const isRef = scan.meta.kind === "ref";
  const refCode = gf && !isRef ? refCodeFor(ctx.product) : null;
  const keys = ctx.trailKeys ? await ctx.trailKeys() : null;
  const trail = !!keys && keys.length > 1;
  if (!gf && !trail) return { scan, tag: "" };

  let refKey: string | null = null;
  if (refCode) refKey = ctx.product.startsWith("L2") ? ctx.key : await ctx.refKey(refCode).catch(() => "");
  const tag =
    (trail ? `|tr:${keys![0]}>${keys![keys!.length - 1]}#${keys!.length}` : "") +
    (gf && (isRef || refKey) ? `|gf${gf[0]}-${gf[1]}${refKey ? `@${refKey}` : ""}` : "");
  if (!tag) return { scan, tag: "" };
  const hit = shown.get(`${ctx.site}|${ctx.product}|${ctx.key}${tag}`);
  if (hit) return { scan: hit, tag };

  let out = scan;
  if (trail) out = (await trailScan(ctx, keys!)) ?? scan;
  if (gf) {
    if (isRef) out = maskSelf(out, gf[0], gf[1]);
    else if (refCode && refKey) {
      const ref = await ctx.load(refCode, refKey).catch(() => null);
      // The same tilt at (nearly) the same time, or nothing is filtered.
      const t0 = scan.meta.scanUnix ?? scan.meta.validUnix ?? 0;
      const t1 = ref?.meta.scanUnix ?? ref?.meta.validUnix ?? 0;
      if (ref && !ref.meta.pending && ref.meta.kind === "ref" && Math.abs(t0 - t1) <= 240) out = maskByRef(out, ref, gf[0], gf[1]);
    }
  }
  if (out === scan) return { scan, tag: "" };
  return { scan: remember(`${ctx.site}|${ctx.product}|${ctx.key}${tag}`, out), tag };
}
