/**
 * The radar loop's frames as the timeline shows them: the scan list from the
 * backend, with
 *
 *  - each extra SAILS / MRLE scan of the tilt on screen as its own frame
 *    ("Expand SAILS cuts in timeline"; its key gets ":c<k>"), and
 *  - the Level II volume still being written at the end ("Show in-progress
 *    scans"; key "L2P:<vol>:<stamp>"), filling in tilt by tilt.
 *
 * The backend side is backend/level2_live.py. The live status is polled by
 * useRadarLiveStore, which hands it here and asks the radar store to compose
 * its list again.
 */

import { BACKEND_BASE } from "./apiConfig";
import type { NexradScan } from "./nexrad";
import type { PolarScan } from "./radarMesh";

export interface LiveCut {
  angle: number;
  slot: string | null;
  got: number;
  of: number;
  done: boolean;
}

/** GET /api/nexrad/l2/live: the volume being written now. */
export interface LiveStatus {
  site: string;
  vol: number;
  stamp: string;
  unix: number;
  key: string;
  wholeKey: string;
  complete: boolean;
  cutsPlanned: number;
  cutsDone: number;
  cuts: LiveCut[];
  chunks: number;
  chunksPlanned: number;
  bytes: number;
  bytesExpected: number;
  lastChunkUnix: number | null;
  stale: boolean;
  scanned: string[];
  reps: Record<string, number[]>;
}

export async function fetchLiveStatus(site: string, signal?: AbortSignal): Promise<LiveStatus> {
  const r = await fetch(`${BACKEND_BASE}/api/nexrad/l2/live?site=${encodeURIComponent(site)}`, { signal });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.detail) detail = String(b.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return r.json();
}

/** The live status the frames are composed with, for the site it was asked for. */
let live: { site: string; status: LiveStatus } | null = null;
export function setComposeLive(site: string | null, status: LiveStatus | null): void {
  live = site && status ? { site, status } : null;
}
export function composeLive(site: string | null): LiveStatus | null {
  return live && site && live.site === site ? live.status : null;
}

/** How many scans of a tilt the volume's plan has (runs of consecutive cuts). */
export function plannedScans(cuts: LiveCut[], slot: string): number {
  let n = 0;
  let prev: string | null = null;
  for (const c of cuts) {
    if (c.slot === slot && prev !== slot) n++;
    prev = c.slot;
  }
  return n;
}

export interface ComposeOptions {
  /** The tilt slot on screen; null for a product without tilts. */
  slot: string | null;
  expand: boolean;
  inProgress: boolean;
  /** Level II live (not archive, not a Brazilian radar). */
  liveL2: boolean;
  live: LiveStatus | null;
}

/** The timeline's frames from the backend's list (see the module notes). */
export function composeFrames(base: NexradScan[], o: ComposeOptions): NexradScan[] {
  const out: NexradScan[] = [];
  for (const s of base) {
    const times = o.slot !== null ? s.reps?.[o.slot] : undefined;
    if (o.expand && times && times.length > 1) {
      times.forEach((t, k) => {
        out.push({ ...s, key: k === 0 ? s.key : `${s.key}:c${k + 1}`, time: k === 0 ? s.time : t, rep: k + 1, of: times.length });
      });
    } else {
      out.push(s);
    }
  }
  const lv = o.live;
  if (!o.liveL2 || !lv || o.slot === null || lv.stale) return out;
  const last = base[base.length - 1];
  if (base.some((s) => s.key === lv.wholeKey) || (last && lv.unix <= last.time)) return out;
  if (lv.complete) {
    // Whole, but the loop's list has not caught up yet (it is re-read on the
    // next poll): the frame stays, under the whole volume's key.
    return composeFrames([...base, { key: lv.wholeKey, time: lv.unix, reps: lv.reps }], { ...o, live: null });
  }
  if (!o.inProgress) return out;
  const times = lv.reps[o.slot] ?? [];
  const planned = Math.max(times.length, plannedScans(lv.cuts, o.slot));
  const multi = o.expand && planned > 1;
  out.push({ key: lv.key, time: lv.unix, partial: true, ...(multi ? { rep: 1, of: planned } : {}) });
  if (multi) {
    for (let k = 1; k < times.length; k++) {
      out.push({ key: `${lv.key}:c${k + 1}`, time: times[k], partial: true, rep: k + 1, of: planned });
    }
  }
  return out;
}

/** "Not expanded" mode: the key of the k-th scan of a frame's tilt (the badge
 *  on the tilt button steps through them). */
export function repKey(frame: NexradScan | undefined, slot: string | null, rep: number): string | null {
  if (!frame || slot === null || rep <= 1 || frame.rep) return null;
  const times = frame.reps?.[slot];
  if (!times || times.length < 2) return null;
  return `${frame.key}:c${Math.min(rep, times.length)}`;
}

/** Bare frame key: the volume, without its rescan suffix. */
export function volumeKey(key: string): string {
  return key.replace(/:c\d+$/, "");
}

/** Which scan of its tilt a frame shows, of how many: an expanded frame's own,
 *  or (not expanded) the badge's pick. Null when the tilt is scanned once. */
export function cutOf(frame: NexradScan | undefined, slot: string | null, rep: number): { rep: number; of: number } | null {
  if (frame?.of && frame.of > 1 && frame.rep) return { rep: frame.rep, of: frame.of };
  const n = slot !== null ? frame?.reps?.[slot]?.length ?? 0 : 0;
  return n > 1 ? { rep: Math.min(Math.max(1, rep), n), of: n } : null;
}

/** Short label for a rescan frame: "cut 2/3". */
export function cutLabel(frame: NexradScan | undefined, slot: string | null, rep: number): string {
  const c = cutOf(frame, slot, rep);
  return c ? `cut ${c.rep}/${c.of}` : "";
}

/**
 * Hold elevation. A volume without the picked tilt (the strategy changed):
 * which tilt to show instead. On: the nearest cut of this volume within 1.5°
 * of the picked angle (null: none, keep the previous picture). Off: the tilt
 * at the same place in this volume's ladder as the picked one had in the last
 * one shown.
 */
export function substituteTilt(
  missing: PolarScan,
  pickedElev: number,
  tilts: { tilt: string | null; elev: number | null }[],
  hold: boolean,
  previous: PolarScan | null,
): { tilt: string; elev: number } | null {
  const ladder = (missing.meta as { elevations?: { elev: number; actual?: number }[] }).elevations ?? [];
  if (!ladder.length) return null;
  const slotFor = (elev: number) => {
    let best: { tilt: string; elev: number } | null = null;
    for (const t of tilts) {
      if (t.tilt === null || t.elev === null) continue;
      if (!best || Math.abs(t.elev - elev) < Math.abs(best.elev - elev)) best = { tilt: t.tilt, elev: t.elev };
    }
    return best && Math.abs(best.elev - elev) <= 0.3 ? best : null;
  };
  if (hold) {
    let pick: { elev: number } | null = null;
    for (const e of ladder) {
      if (Math.abs(e.elev - pickedElev) > 1.5) continue;
      if (!pick || Math.abs(e.elev - pickedElev) < Math.abs(pick.elev - pickedElev)) pick = e;
    }
    return pick ? slotFor(pick.elev) : null;
  }
  const prevLadder = (previous?.meta as { elevations?: { elev: number }[] } | undefined)?.elevations ?? [];
  let at = prevLadder.findIndex((e) => Math.abs(e.elev - pickedElev) < 0.2);
  if (at < 0) {
    // The last picture was itself a stand-in: the picked angle's place in this
    // ladder (above its top cut: the top one).
    const above = ladder.findIndex((e) => e.elev > pickedElev);
    at = Math.max(0, above < 0 ? ladder.length - 1 : above - 1);
  }
  return slotFor(ladder[Math.min(at, ladder.length - 1)].elev);
}
