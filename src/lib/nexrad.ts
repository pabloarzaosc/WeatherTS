// Client for the NEXRAD Level III radar backend. The backend decodes the scan
// (Unidata S3 -> MetPy) and ships the raw polar data; the colouring and drawing
// happen in the browser (see radarMesh.ts / nexradGlLayer.ts).

import { BACKEND_BASE } from './apiConfig';
const BASE = BACKEND_BASE;

export interface NexradSite {
  id: string; // 3-letter (S3 prefix), e.g. "ATX"
  icao: string; // display, e.g. "KATX"
  name: string;
  lat: number;
  lon: number;
  country: string | null;
  online?: boolean;
}

export interface NexradProduct {
  id: string;
  label: string;
  units: string;
}
export interface NexradPalette {
  id: string;
  label: string;
}

export interface TiltOption {
  code: string; // wire product code, e.g. "N0B"
  tilt: string | null; // slot char ("0","A","1","B","2","3"); null = no tilts
  elev: number | null; // nominal VCP elevation for the label
  /** Level II only: this cut really is 0.5° (the low, split cuts). */
  superRes?: boolean;
}

/** A moment (reflectivity, velocity, ...) and the cuts it's published at. */
export interface ProductFamily {
  id: string;
  label: string;
  units: string;
  kind: string;
  tilts: TiltOption[];
  /** Level II can serve this field at 0.5° (720 radials). */
  superRes?: boolean;
  /** Tilt slots where Level II is actually super-res (the low, split cuts). */
  superResTilts?: string[];
  /** Toolbox button label, e.g. "REF", "SRM". */
  short?: string;
  source?: "level2" | "level3";
}

/**
 * The single product list the picker shows. Each moment appears once, already
 * resolved to its best source: Level III for almost everything (it carries the
 * loop and the archive), Level II only where it genuinely wins (CC, ZDR, SW,
 * PHI, CFP). The `source` on each family says which one it ended up being.
 */
export type ProductGrids = ProductFamily[];

/**
 * The wire code for a family+tilt. The backend already resolves the source --
 * Level II wherever it carries the field, Level III otherwise -- so the tilt
 * option's `code` is authoritative and there's nothing to choose here.
 */
export function wireCode(fam: ProductFamily, tiltSlot: string | null): string | null {
  const opt = fam.tilts.find((t) => t.tilt === tiltSlot) ?? fam.tilts[0];
  return opt?.code ?? null;
}

export interface NexradScan {
  key: string;
  time: number; // unix seconds (UTC)
}

export interface PaletteDef {
  label: string;
  pal: string; // raw .pal table
}

/** The .pal tables + which one each product kind defaults to. Fetched once. */
export async function fetchPaletteTables(): Promise<{
  palettes: Record<string, PaletteDef>;
  kindDefaults: Record<string, string>;
}> {
  const r = await fetch(`${BASE}/api/nexrad/palettes.json`);
  if (!r.ok) throw new Error(`palettes ${r.status}`);
  return r.json();
}

/** Raw polar scan (binary) for client-side GPU rendering. */
export async function fetchScanData(
  site: string,
  product: string,
  key = "",
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url =
    `${BASE}/api/nexrad/data?site=${encodeURIComponent(site)}` +
    `&product=${encodeURIComponent(product)}` +
    (key ? `&key=${encodeURIComponent(key)}` : "");
  const r = await fetch(url, { signal });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.detail) detail = String(b.detail);
    } catch {
      /* binary endpoint -> body may not be JSON */
    }
    throw new Error(detail);
  }
  return r.arrayBuffer();
}

export async function fetchNexradSites(): Promise<NexradSite[]> {
  const r = await fetch(`${BASE}/api/nexrad/sites`, { cache: "no-store" });
  if (!r.ok) throw new Error(`sites ${r.status}`);
  return (await r.json()).sites;
}

export async function fetchNexradMeta(): Promise<{
  products: NexradProduct[];
  catalog: ProductFamily[];
  grids: ProductGrids;
  palettes: NexradPalette[];
  defaultProduct: string;
}> {
  const r = await fetch(`${BASE}/api/nexrad/meta`);
  if (!r.ok) throw new Error(`meta ${r.status}`);
  return r.json();
}

// --- Storm attributes (SCIT cells + mesocyclones) --------------------------

export interface StormCell {
  id: string;
  lon: number;
  lat: number;
  xKm: number;
  yKm: number;
  rangeKm: number;
  azimuthDeg: number;
  headingDeg: number | null;
  headingCompass: string | null;
  speedMph: number | null;
  speedKt: number | null;
  /** Past positions, newest first, as [lon, lat]. */
  past: [number, number][];
  /** The current position followed by the 15/30/45/60-minute forecast
   *  positions, as [lon, lat]. Shorter when SCIT published fewer steps. */
  forecast: [number, number][];

  // --- hail (Level III product 59) ---------------------------------------
  // Absent when the hail algorithm did not evaluate the cell -- it reports
  // UNKNOWN past roughly 130 nm, which is not the same as "no hail".
  probHailPct?: number;
  probSevereHailPct?: number;
  maxHailSizeIn?: number;
  /** The size is a below-threshold reading, shown as "<0.50" not "0.50". */
  hailSizeBelowThreshold?: boolean;

  // --- structure (Level III product 62) -----------------------------------
  cellTopKft?: number;
  cellBaseKft?: number;
  cellBaseBelowThreshold?: boolean;
  vilKgM2?: number;
  maxRefDbz?: number;
  maxRefHeightKft?: number;
}

export interface StormMeso {
  id: string;
  lon: number;
  lat: number;
  stormId: string | null;
  tvs: boolean;
  rangeKm: number;
}

export interface StormReport {
  meta: {
    site: string;
    siteLat: number;
    siteLon: number;
    maxRangeKm: number;
    validUnix: number | null;
    key: string | null;
    cellCount: number;
    mesoCount: number;
    /** How many cells came back with hail/structure attributes. 0 during
     *  archive playback, where the live feed cannot answer. */
    attributedCount: number;
  };
  cells: StormCell[];
  mesos: StormMeso[];
}

/** `unix` picks the storm scan nearest that instant, so the tracks follow the
 *  radar loop instead of always showing the latest volume. */
export async function fetchNexradStorms(
  site: string,
  unix?: number | null,
  signal?: AbortSignal,
): Promise<StormReport> {
  const url =
    `${BASE}/api/nexrad/storms?site=${encodeURIComponent(site)}` +
    (unix != null ? `&unix=${Math.round(unix)}` : "");
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`storms ${r.status}`);
  return r.json();
}

/** One volume's worth of a cell's attributes, for the trend charts. */
export interface StormCellSample {
  unix: number;
  probHailPct?: number;
  probSevereHailPct?: number;
  maxHailSizeIn?: number;
  hailSizeBelowThreshold?: boolean;
  cellTopKft?: number;
  cellBaseKft?: number;
  cellBaseBelowThreshold?: boolean;
  vilKgM2?: number;
  maxRefDbz?: number;
  maxRefHeightKft?: number;
}

/**
 * How one cell's hail and structure changed over recent volumes, oldest first.
 * An empty list is normal: the feed reaches back about a day, and a cell only
 * appears in the scans it was actually tracked in.
 */
export async function fetchStormCellHistory(
  site: string,
  cell: string,
  volumes?: number,
  signal?: AbortSignal,
): Promise<StormCellSample[]> {
  const url =
    `${BASE}/api/nexrad/storms/history?site=${encodeURIComponent(site)}` +
    `&cell=${encodeURIComponent(cell)}` +
    (volumes != null ? `&volumes=${Math.round(volumes)}` : "");
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`storm history ${r.status}`);
  const d = (await r.json()) as { samples?: StormCellSample[] };
  return d.samples ?? [];
}

// --- VAD wind profile ------------------------------------------------------

export interface VwpLevel {
  altFt: number;
  altM: number;
  u: number | null;
  v: number | null;
  wCmS: number | null;
  dirDeg: number;
  spdKt: number;
  rmsKt: number | null;
  divE3: number | null;
  srngNm: number | null;
  elevDeg: number | null;
}

export interface VwpColumn {
  unix: number | null;
  key: string;
  levels: VwpLevel[];
}

export interface VwpReport {
  meta: {
    site: string;
    siteLat: number;
    siteLon: number;
    columns: number;
    heightsFt: number[];
    validUnix: number | null;
    maxKt: number | null;
    maxAltFt: number | null;
    maxDirDeg: number | null;
    source: string;
  };
  columns: VwpColumn[];
}

/** The whole VWP hodograph panel, rendered server-side with SHARPpy. */
export interface VwpPanelVec {
  dir: number;
  spd: number;
}

export interface VwpPanelRow {
  label: string;
  shear: VwpPanelVec | null;
  srh: number | null;
  srWind: VwpPanelVec | null;
  ehi: number | null;
}

export interface VwpPanelReport {
  image: string;
  meta: {
    site: string;
    lat: number;
    lon: number;
    validUnix: number | null;
    motion: string;
    vadTopAglM: number;
    vadLevels: number;
    thermoModel: string | null;
    note: string;
  };
  motions: Record<string, VwpPanelVec>;
  rows: VwpPanelRow[];
  critical: number | null;
}

export async function fetchVwpPanel(
  site: string,
  motion: string,
  custom: { dir: number; spd: number } | null,
  signal?: AbortSignal,
): Promise<VwpPanelReport> {
  const q = new URLSearchParams({ site, motion });
  if (motion === "custom" && custom) {
    q.set("motionDir", String(custom.dir));
    q.set("motionSpd", String(custom.spd));
  }
  const r = await fetch(`${BASE}/api/nexrad/vwp/panel?${q.toString()}`, { signal });
  if (!r.ok) {
    let detail = `vwp panel ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await r.json()) as VwpPanelReport;
}

export async function fetchNexradVwp(
  site: string,
  columns = 12,
  signal?: AbortSignal,
): Promise<VwpReport> {
  const r = await fetch(
    `${BASE}/api/nexrad/vwp?site=${encodeURIComponent(site)}&columns=${columns}`,
    { signal },
  );
  if (!r.ok) {
    let detail = `vwp ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json();
}

/** Scans available for a UTC date ("" = today/live). `limit` thins them evenly. */
export async function fetchNexradScans(
  site: string,
  product: string,
  date: string,
  limit = 0,
  /** Unix seconds: archive playback starts here. 0/undefined = live. */
  start = 0,
): Promise<{ scans: NexradScan[]; archiveStart: string }> {
  const url =
    `${BASE}/api/nexrad/scans?site=${encodeURIComponent(site)}` +
    `&product=${encodeURIComponent(product)}` +
    (date ? `&date=${encodeURIComponent(date)}` : "") +
    (limit ? `&limit=${limit}` : "") +
    (start ? `&start=${start}` : "");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`scans ${r.status}`);
  return r.json();
}
