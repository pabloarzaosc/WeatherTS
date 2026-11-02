// GRLevelX .pal colour tables, parsed client-side so a palette change is just a
// recolour of the existing mesh (no server round-trip).
//
// The real format (what you download from wxtools.org and friends) is:
//
//   Product: BR
//   Units:   DBZ
//   Step:    5
//   Color:   5   0 0 100   11 232 217
//   Color:  20  11 232 217  0 100 0
//   Color:  40 255 255 0
//   SolidColor: 60 255 255 255
//   RF: 119 0 125
//
// Two things make it more than "value r g b":
//   * an entry may carry TWO colours -- the segment from this entry's value to
//     the next one ramps from the first to the second. With one colour it ramps
//     to the *next entry's* colour instead. That's how a table gets a hard break
//     (segment ends dark red at 60, next segment starts white at 60).
//   * `Color4:`/`SolidColor4:` add an alpha channel, `SolidColor:` holds a flat
//     colour across the segment.
//
// Bare `value r g b [a]` lines are also accepted: that's the shorthand the
// built-in tables use.

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number; // 0..255
}

export interface PalEntry {
  v: number;
  c1: RGBA;
  c2: RGBA | null; // segment end colour; null = ramp to the next entry's c1
  solid: boolean;
}

export interface PalTable {
  entries: PalEntry[]; // ascending by value
  product: string | null; // e.g. "BR" -- what the table is meant to colour
  units: string | null; // e.g. "DBZ"
  step: number | null; // legend tick spacing
  rf: RGBA | null; // range-folded colour
  /** `Scale:` / `Offset:` as written. NOT applied to the stops: in GR and WCT
   *  files they convert the source program's internal units (m/s, mm, km) into
   *  the table's units, which is what our decoder already hands over. The
   *  importer (colorTables.ts) reads them to tell what units a file is in. */
  scale: number | null;
  offset: number | null;
}

const rgba = (r: number, g: number, b: number, a = 255): RGBA => ({ r, g, b, a });

/** GR writes alpha as 0-255, but 0-1 shows up in the wild too. */
function normAlpha(a: number): number {
  if (!Number.isFinite(a)) return 255;
  return a <= 1 ? Math.round(a * 255) : a;
}

export function parsePal(text: string): PalTable {
  const entries: PalEntry[] = [];
  let product: string | null = null;
  let units: string | null = null;
  let step: number | null = null;
  let rf: RGBA | null = null;
  let scale: number | null = null;
  let offset: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(";")[0].trim();
    if (!line) continue;

    const kw = /^(\w+4?)\s*:\s*(.*)$/.exec(line);
    if (kw) {
      const key = kw[1].toLowerCase();
      const rest = kw[2].trim();
      const n = rest.split(/[\s,]+/).map(Number);

      if (key === "product") {
        product = rest.toUpperCase();
        continue;
      }
      if (key === "units") {
        units = rest.toUpperCase();
        continue;
      }
      if (key === "step") {
        if (Number.isFinite(n[0])) step = n[0];
        continue;
      }
      if (key === "rf") {
        if (n.length >= 3) rf = rgba(n[0], n[1], n[2]);
        continue;
      }
      if (key === "scale") {
        if (Number.isFinite(n[0]) && n[0] !== 0) scale = n[0];
        continue;
      }
      if (key === "offset") {
        if (Number.isFinite(n[0])) offset = n[0];
        continue;
      }

      const solid = key.startsWith("solidcolor");
      const isColor = solid || key.startsWith("color");
      if (!isColor) continue; // Label:, Decimals:, Legend: ... -- not ours to use

      const withAlpha = key.endsWith("4");
      const stride = withAlpha ? 4 : 3;
      const v = n[0];
      if (!Number.isFinite(v) || !Number.isFinite(n[1])) continue;

      const c1 = rgba(n[1], n[2], n[3], withAlpha ? normAlpha(n[4]) : 255);
      // A second colour only counts if it's complete. A stray trailing number
      // (someone writing `Color: 0 0 0 0` meaning alpha, which is Color4:'s job)
      // must not become a half-parsed colour -- that yields rgba(0,NaN,NaN),
      // which silently invalidates the whole CSS gradient it lands in.
      const o = 1 + stride;
      const c2 =
        n.length >= o + stride && n.slice(o, o + stride).every(Number.isFinite)
          ? rgba(n[o], n[o + 1], n[o + 2], withAlpha ? normAlpha(n[o + 3]) : 255)
          : null;
      entries.push({ v, c1, c2, solid });
      continue;
    }

    // bare shorthand: value r g b [a]
    const n = line.split(/[\s,]+/).map(Number);
    if (n.length < 4 || n.slice(0, 4).some((x) => !Number.isFinite(x))) continue;
    entries.push({
      v: n[0],
      c1: rgba(n[1], n[2], n[3], n.length >= 5 ? normAlpha(n[4]) : 255),
      c2: null,
      solid: false,
    });
  }

  entries.sort((a, b) => a.v - b.v);
  return { entries, product, units, step, rf, scale, offset };
}

// ---------------------------------------------------------------------------
// Writing tables back out (colour table editor, Export .pal, the importer's
// Fix Scale). The output is plain GR syntax, so it opens in GR and here alike.
// ---------------------------------------------------------------------------

/** A number as a .pal writes it: no float noise, no trailing zeros. */
export function palNum(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const s = Number(v.toFixed(4)).toString();
  return s === "-0" ? "0" : s;
}

const rgbText = (c: RGBA) => `${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}`;
const rgbaText = (c: RGBA) => `${rgbText(c)} ${Math.round(c.a)}`;

export interface PalHeader {
  product?: string | null;
  units?: string | null;
  step?: number | null;
  scale?: number | null;
  offset?: number | null;
  rf?: RGBA | null;
  /** First line, as a `;` comment. */
  comment?: string | null;
}

/** Entries (+ header) as .pal text. A colour with any transparency is written
 *  as Color4/SolidColor4 so the alpha survives the trip. */
export function writePal(entries: PalEntry[], h: PalHeader = {}): string {
  const out: string[] = [];
  if (h.comment) out.push(`; ${h.comment.replace(/\r?\n/g, " ")}`);
  if (h.product) out.push(`Product: ${h.product}`);
  if (h.units) out.push(`Units: ${h.units}`);
  if (h.step && h.step > 0) out.push(`Step: ${palNum(h.step)}`);
  if (h.scale != null) out.push(`Scale: ${palNum(h.scale)}`);
  if (h.offset != null) out.push(`Offset: ${palNum(h.offset)}`);
  if (h.rf) out.push(`RF: ${rgbText(h.rf)}`);
  for (const e of [...entries].sort((a, b) => a.v - b.v)) {
    const alpha = e.c1.a < 255 || (e.c2 !== null && e.c2.a < 255);
    const kw = `${e.solid ? "SolidColor" : "Color"}${alpha ? "4" : ""}`;
    const col = alpha ? rgbaText : rgbText;
    const second = !e.solid && e.c2 ? `  ${col(e.c2)}` : "";
    out.push(`${kw}: ${palNum(e.v)}  ${col(e.c1)}${second}`);
  }
  return `${out.join("\n")}\n`;
}

/** Deep copy, so an edit never reaches a table someone else holds. */
export function cloneEntries(entries: PalEntry[]): PalEntry[] {
  return entries.map((e) => ({ v: e.v, c1: { ...e.c1 }, c2: e.c2 ? { ...e.c2 } : null, solid: e.solid }));
}

/** Every stop moved from v to v * scale + offset (the colour scale and offset,
 *  and the importer's unit fixes). A negative scale would turn the table
 *  around; it is kept positive by the callers. */
export function moveEntries(entries: PalEntry[], scale: number, offset: number): PalEntry[] {
  return cloneEntries(entries).map((e) => ({ ...e, v: e.v * scale + offset }));
}

/** The stops alone, as one comparable string: two files with the same colours
 *  at the same values are the same table whatever their names and comments. */
export function palSignature(entries: PalEntry[]): string {
  return entries
    .map((e) => `${palNum(e.v)}:${rgbaText(e.c1)}${e.c2 ? `>${rgbaText(e.c2)}` : ""}${e.solid ? "s" : ""}`)
    .join("|");
}

/**
 * A 256-entry RGBA lookup baked from the table across [vmin, vmax].
 * Colouring a vertex is then an index + 4 array reads.
 */
export interface PalLut {
  lut: Uint8Array; // steps * 4 (LUT_STEPS unless asked otherwise)
  vmin: number;
  vmax: number;
  /** Categories (the hydrometeor classes): coloured from the table at the
   *  exact value. The 256 samples sit between the class codes -- 60 rounds to
   *  the sample at 59.96, which is the class below -- so a ramp's LUT painted
   *  rain as wet snow. A handful of distinct values, so each is looked up once. */
  exact?: { entries: PalEntry[]; cache: Map<number, number> };
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** Colour at a value, following the segment rules above. */
function sample(entries: PalEntry[], v: number, out: Uint8Array, off: number): void {
  const last = entries.length - 1;
  if (v <= entries[0].v) {
    const c = entries[0].c1;
    out[off] = c.r; out[off + 1] = c.g; out[off + 2] = c.b; out[off + 3] = c.a;
    return;
  }
  if (v >= entries[last].v) {
    const e = entries[last];
    const c = e.c2 ?? e.c1;
    out[off] = c.r; out[off + 1] = c.g; out[off + 2] = c.b; out[off + 3] = c.a;
    return;
  }

  let i = 0;
  while (i < last && entries[i + 1].v <= v) i++;
  const e = entries[i];
  if (e.solid) {
    const c = e.c1;
    out[off] = c.r; out[off + 1] = c.g; out[off + 2] = c.b; out[off + 3] = c.a;
    return;
  }
  const end = e.c2 ?? entries[i + 1].c1;
  const span = entries[i + 1].v - e.v;
  const t = span === 0 ? 0 : (v - e.v) / span;
  out[off] = lerp(e.c1.r, end.r, t);
  out[off + 1] = lerp(e.c1.g, end.g, t);
  out[off + 2] = lerp(e.c1.b, end.b, t);
  out[off + 3] = lerp(e.c1.a, end.a, t);
}

/** The table's colour at one exact value -- no LUT rounding, for keys that
 *  name a single value (a class code) rather than draw a ramp. */
export function colorAt(table: PalTable, v: number): RGBA {
  const px = new Uint8Array(4);
  if (table.entries.length === 0) return rgba(0, 0, 0, 0);
  sample(table.entries, v, px, 0);
  return rgba(px[0], px[1], px[2], px[3]);
}

/** Samples in a radar colour lookup: one per ~0.07 dBZ on a 75 dBZ table. */
export const LUT_STEPS = 1024;

export function buildLut(table: PalTable, steps = LUT_STEPS, categorical = false): PalLut {
  const { entries } = table;
  if (entries.length === 0) throw new Error("empty palette");
  const vmin = entries[0].v;
  const vmax = entries[entries.length - 1].v;
  const span = vmax - vmin || 1;
  const w = span / (steps - 1);
  const lut = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    // lookup() rounds, so sample i answers for values up to half a step
    // either side of its own. It is taken just past the TOP of that window:
    // a value sitting exactly on a hard break (a 60.0 dBZ gate where a band
    // starts at 60) then gets the band above, as the table says, not the
    // colour the band below ends in. Sampled at its middle, about one gate in
    // five of a stepped table (Winter, Steps, SolidColor bands) took the
    // wrong band. Radar values come in steps (0.5 dBZ, 0.5 m/s, 1/16 dB)
    // wider than a sample, so a value just under a break still lands below.
    sample(entries, i === 0 ? vmin : vmin + (i + 0.5) * w + w * 1e-6, lut, i * 4);
  }
  return categorical ? { lut, vmin, vmax, exact: { entries, cache: new Map() } } : { lut, vmin, vmax };
}

/** Value -> RGBA (0..255). Out-of-range clamps; NaN is fully transparent. */
export function lookup(p: PalLut, v: number, out: Uint8Array, off = 0): void {
  if (!Number.isFinite(v)) {
    out[off] = out[off + 1] = out[off + 2] = out[off + 3] = 0;
    return;
  }
  if (p.exact) {
    let packed = p.exact.cache.get(v);
    if (packed === undefined) {
      const px = new Uint8Array(4);
      sample(p.exact.entries, v, px, 0);
      packed = ((px[0] << 24) | (px[1] << 16) | (px[2] << 8) | px[3]) >>> 0;
      p.exact.cache.set(v, packed);
    }
    out[off] = packed >>> 24;
    out[off + 1] = (packed >>> 16) & 255;
    out[off + 2] = (packed >>> 8) & 255;
    out[off + 3] = packed & 255;
    return;
  }
  const n = p.lut.length / 4 - 1;
  const t = (v - p.vmin) / (p.vmax - p.vmin || 1);
  const i = Math.max(0, Math.min(n, Math.round(t * n))) * 4;
  out[off] = p.lut[i];
  out[off + 1] = p.lut[i + 1];
  out[off + 2] = p.lut[i + 2];
  out[off + 3] = p.lut[i + 3];
}

/**
 * Legend tick values across [vmin,vmax]. `Step:` from the .pal wins; otherwise
 * a round-ish interval aiming for ~8-12 labels. Shared so the exported GIF's
 * scale is labelled identically to the on-screen colour bar.
 */
export function palTicks(vmin: number, vmax: number, step: number | null): number[] {
  const span = vmax - vmin;
  let s = step && step > 0 ? step : 0;
  if (!s || span / s > 24) {
    const raw = span / 10;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    s = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  }
  const out: number[] = [];
  const start = Math.ceil(vmin / s) * s;
  for (let v = start; v <= vmax + 1e-9; v += s) {
    // guard float drift so we don't emit 19.999999
    out.push(Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(6)));
  }
  return out;
}

/** CSS gradient stops for a legend, honouring hard breaks. */
export function palGradient(table: PalTable): string {
  const { entries } = table;
  if (entries.length < 2) return "";
  const vmin = entries[0].v;
  const vmax = entries[entries.length - 1].v;
  const span = vmax - vmin || 1;
  const pct = (v: number) => (((v - vmin) / span) * 100).toFixed(3);
  const css = (c: RGBA) => `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`;

  const parts: string[] = [];
  entries.forEach((e, i) => {
    const next = entries[i + 1];
    parts.push(`${css(e.c1)} ${pct(e.v)}%`);
    if (!next) return;
    if (e.solid) {
      // hold the colour right up to the next stop
      parts.push(`${css(e.c1)} ${pct(next.v)}%`);
    } else if (e.c2) {
      // the segment ends on its own colour -- emit it so the break is visible
      parts.push(`${css(e.c2)} ${pct(next.v)}%`);
    }
  });
  return parts.join(", ");
}
