/**
 * A forecast office from api.weather.gov (public domain, CORS open): its
 * address and phone, the counties and zones it covers, and its latest Area
 * Forecast Discussion, raw and split into sections for reading.
 */

const API = "https://api.weather.gov";
const HEADERS = { Accept: "application/geo+json" };

export interface OfficeInfo {
  id: string;
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  fax: string;
  email: string;
  website: string;
  region: string;
  countyIds: string[];
  zoneIds: string[];
  fireZoneIds: string[];
}

export interface ZoneName {
  id: string;
  name: string;
  state: string;
}

export interface ProductRef {
  id: string;
  issued: string;
}

export interface AfdProduct {
  id: string;
  issued: string;
  text: string;
}

const tail = (url: string): string => url.split("/").pop() ?? url;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: HEADERS, signal });
  if (!r.ok) throw new Error(r.status === 404 ? "Not found at api.weather.gov." : `api.weather.gov answered ${r.status}.`);
  return (await r.json()) as T;
}

const officeCache = new Map<string, OfficeInfo>();

export async function fetchOffice(id: string, signal?: AbortSignal): Promise<OfficeInfo> {
  const hit = officeCache.get(id);
  if (hit) return hit;
  const d = await getJson<Record<string, any>>(`${API}/offices/${encodeURIComponent(id)}`, signal);
  const addr = d.address ?? {};
  const info: OfficeInfo = {
    id: d.id ?? id,
    name: d.name ?? id,
    street: String(addr.streetAddress ?? "").trim(),
    city: addr.addressLocality ?? "",
    state: addr.addressRegion ?? "",
    zip: addr.postalCode ?? "",
    phone: d.telephone ?? "",
    fax: d.faxNumber ?? "",
    email: d.email ?? "",
    website: d.sameAs ?? `https://www.weather.gov/${String(id).toLowerCase()}/`,
    region: String(d.nwsRegion ?? "").toUpperCase(),
    countyIds: (d.responsibleCounties ?? []).map(tail),
    zoneIds: (d.responsibleForecastZones ?? []).map(tail),
    fireZoneIds: (d.responsibleFireZones ?? []).map(tail),
  };
  officeCache.set(id, info);
  return info;
}

const zoneCache = new Map<string, ZoneName>();

/** Names of zones / counties by id: one /zones?id=... call per 60 ids. */
export async function fetchZoneNames(ids: string[], signal?: AbortSignal): Promise<ZoneName[]> {
  const need = ids.filter((id) => !zoneCache.has(id));
  for (let i = 0; i < need.length; i += 60) {
    const chunk = need.slice(i, i + 60);
    const d = await getJson<{ features?: Array<{ properties?: Record<string, any> }> }>(
      `${API}/zones?id=${chunk.join(",")}&include_geometry=false`,
      signal,
    );
    for (const f of d.features ?? []) {
      const p = f.properties ?? {};
      if (p.id) zoneCache.set(p.id, { id: p.id, name: p.name ?? p.id, state: p.state ?? "" });
    }
    for (const id of chunk) if (!zoneCache.has(id)) zoneCache.set(id, { id, name: id, state: "" });
  }
  return ids.map((id) => zoneCache.get(id)!).filter(Boolean);
}

/** The office's Area Forecast Discussions, newest first (ids + issue times). */
export async function fetchAfdList(id: string, signal?: AbortSignal): Promise<ProductRef[]> {
  const d = await getJson<{ "@graph"?: Array<{ id: string; issuanceTime: string }> }>(
    `${API}/products/types/AFD/locations/${encodeURIComponent(id)}`,
    signal,
  );
  return (d["@graph"] ?? []).map((p) => ({ id: p.id, issued: p.issuanceTime }));
}

const productCache = new Map<string, AfdProduct>();

export async function fetchProduct(productId: string, signal?: AbortSignal): Promise<AfdProduct> {
  const hit = productCache.get(productId);
  if (hit) return hit;
  const d = await getJson<{ id: string; issuanceTime: string; productText: string }>(
    `${API}/products/${encodeURIComponent(productId)}`,
    signal,
  );
  const p = { id: d.id, issued: d.issuanceTime, text: d.productText ?? "" };
  productCache.set(productId, p);
  return p;
}

/* ------------------------------------------------------------ formatting --- */

export interface AfdSection {
  title: string;
  /** "Issued at 443 PM CDT Sun Oct 25 2026" / "(Rest of today and tonight)". */
  sub: string[];
  /** Paragraphs; each either prose (line breaks undone) or a list / table kept as is. */
  blocks: Array<{ kind: "p" | "pre" | "list"; text: string }>;
  /** The forecaster's name or initials that closes a section, when there is one. */
  author: string;
}

export interface AfdDoc {
  /** "Area Forecast Discussion", "National Weather Service Norman OK", time. */
  head: string[];
  sections: AfdSection[];
}

const isTitle = (l: string) => /^\.[A-Z0-9][A-Z0-9 /&()'-]*\.{3}/.test(l);

/**
 * Split an AFD into its dotted sections (.KEY MESSAGES..., .SHORT TERM...),
 * undo the 69-column wrapping of prose, keep tables (aligned columns) and
 * bullet lists as they are, and drop the WMO header lines and the && / $$
 * separators. Anything it cannot place stays in the raw view.
 */
export function formatAfd(text: string): AfdDoc {
  const lines = text.replace(/\r/g, "").split("\n");
  // Drop the transmission header: "000", "FXUS64 KOUN 252309", "AFDOUN".
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\d{3}\s*$/.test(lines[i]) || /^[A-Z]{4}\d{2} [A-Z]{4} \d{6}/.test(lines[i]) || /^[A-Z0-9]{4,6}\s*$/.test(lines[i]))) i++;
  const head: string[] = [];
  while (i < lines.length && !isTitle(lines[i].trim())) {
    const l = lines[i].trim();
    if (l) head.push(l);
    i++;
  }
  const sections: AfdSection[] = [];
  let cur: AfdSection | null = null;
  let para: string[] = [];
  const flush = () => {
    if (!cur || para.length === 0) {
      para = [];
      return;
    }
    const raw = para.join("\n");
    const listy = para.every((l) => /^\s*([-*]|\d+\.)\s|^\s{2,}\S/.test(l)) && /^\s*([-*]|\d+\.)\s/.test(para[0]);
    const tabular = para.some((l) => /\S {3,}\S/.test(l.trim())) || para.some((l) => /^[A-Z]{3,}\s+\d/.test(l.trim()) && /\d+\s+\d+/.test(l));
    if (listy) cur.blocks.push({ kind: "list", text: raw });
    else if (tabular) cur.blocks.push({ kind: "pre", text: raw });
    else cur.blocks.push({ kind: "p", text: para.map((l) => l.trim()).join(" ") });
    para = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (isTitle(t)) {
      flush();
      const m = t.match(/^\.([^.]+(?:\.[^.]+)*?)\.{3}\s*(.*)$/);
      cur = { title: (m?.[1] ?? t).trim(), sub: [], blocks: [], author: "" };
      if (m?.[2]) {
        if (/^(\(.*\)|(Issued|Updated) at .*)$/i.test(m[2])) cur.sub.push(m[2]);
        else para.push(m[2]);
      }
      sections.push(cur);
      // "Issued at ..." and "(Rest of today and tonight)" right under the title
      while (i + 1 < lines.length && /^(\(.*\)|Issued at .*|Updated at .*)$/i.test(lines[i + 1].trim())) {
        cur.sub.push(lines[i + 1].trim());
        i++;
      }
      continue;
    }
    if (t === "&&" || t === "$$") {
      flush();
      // a lone short line before the separator is the forecaster's signature
      if (cur && cur.blocks.length) {
        const last = cur.blocks[cur.blocks.length - 1];
        if (last.kind === "p" && /^[A-Z][A-Za-z.'/ -]{0,24}$/.test(last.text) && !/[.:]$/.test(last.text)) {
          cur.author = last.text;
          cur.blocks.pop();
        }
      }
      continue;
    }
    if (!cur) continue;
    if (!t) flush();
    else para.push(line);
  }
  flush();
  return { head, sections: sections.filter((s) => s.blocks.length || s.sub.length) };
}
