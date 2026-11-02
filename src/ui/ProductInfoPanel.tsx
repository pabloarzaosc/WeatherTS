import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MapMouseEvent } from "maplibre-gl";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { getActivePaneId, getMap, subscribeMaps } from "../map/mapInstance";
import { useNexradStore } from "../store/useNexradStore";
import { useProductInfoStore, type InfoBlock } from "../store/useProductInfoStore";
import { useSetting } from "../settings/useSettingsStore";
import { useDragOffset } from "../lib/useDragOffset";
import { HCA_CLASSES } from "../lib/hca";
import { formatValue, toDisplay, unitFor } from "../lib/radarUnits";
import { beamHeightKm, fmtHeight, fmtRange, fmtShort, probeScan, type ReadoutDistance } from "../lib/radarProbe";

const utc = (unix: number | null | undefined, secs = true) => {
  if (unix == null || !Number.isFinite(unix)) return "—";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${secs ? `:${p(d.getUTCSeconds())}` : ""}Z`
  );
};
const hms = (unix: number | null | undefined) => (unix == null ? "—" : utc(unix).slice(11));

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function Block({
  id,
  title,
  summary,
  children,
}: {
  id: InfoBlock;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const folded = useProductInfoStore((s) => !!s.folded[id]);
  const toggle = useProductInfoStore((s) => s.toggleFold);
  return (
    <section className={`pinfo__blk${folded ? " is-folded" : ""}`}>
      <button type="button" className="pinfo__bh" onClick={() => toggle(id)} aria-expanded={!folded}>
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <b>{title}</b>
        {folded && <span className="pinfo__sum">{summary}</span>}
      </button>
      {!folded && <dl className="pinfo__dl">{children}</dl>}
    </section>
  );
}

/**
 * What the scan on screen is: when it was taken and how (Scan), how finely it
 * samples (Sampling), the radar that took it (Radar), and the gate under the
 * pointer (Pointer). Each block folds to a one-line summary; the folds are
 * remembered. Follows the focused pane.
 */
export function ProductInfoPanel() {
  const open = useProductInfoStore((s) => s.open);
  const setOpen = useProductInfoStore((s) => s.setOpen);
  const scan = useNexradStore((s) => s.scan);
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const radarUnits = useAppStore((s) => s.radarUnits);
  const sys = (useSetting<string>("radar.readoutDistance") === "km" ? "km" : "mi") as ReadoutDistance;
  const drag = useDragOffset("productInfo");
  // The pointer over the focused pane only, and only while it is there: it
  // clears when the pointer leaves the map, when another pane takes focus and
  // when the radar changes (a stale spot read "Out of range 5247 mi").
  const pane = useSyncExternalStore(subscribeMaps, getActivePaneId);
  const site = scan?.meta.site ?? null;
  const [cursor, setCursor] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    setCursor(null);
    const map = open ? getMap() : null;
    if (!map) return;
    const move = (e: MapMouseEvent) => setCursor({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    const out = () => setCursor(null);
    map.on("mousemove", move);
    map.on("mouseout", out);
    return () => {
      map.off("mousemove", move);
      map.off("mouseout", out);
    };
  }, [open, pane, site]);

  if (!open) return null;
  const m = scan?.meta;

  const head = (
    <div className="pinfo__head" {...drag.handle} title="Drag to move">
      <b>Product info</b>
      {m && (
        <span className="pinfo__sub">
          {m.site} · {m.product}
        </span>
      )}
      <button
        type="button"
        className="pinfo__x"
        aria-label="Close product info"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(false)}
      >
        <X size={13} />
      </button>
    </div>
  );

  if (!m || !radarOn) {
    return (
      <div ref={drag.ref} className={`pinfo${drag.dragging ? " is-dragging" : ""}`} style={drag.style}>
        {head}
        <div className="pinfo__empty">{radarOn ? "No radar scan loaded." : "The radar layer is off."}</div>
      </div>
    );
  }

  const speed = unitFor("vel", radarUnits);
  // A product built from the volume (composite, tops, VIL, VROT, debris
  // score) has no one sweep's Nyquist velocity or unambiguous range: the
  // backend's meta carries the surveillance cut's, which would mislead.
  const sweepless = !!m.derived && m.kind !== "vel" && m.kind !== "srv";
  const nyq = m.nyquistKt && !sweepless
    ? speed
      ? `${toDisplay(speed, m.nyquistKt).toFixed(0)} ${speed.label}`
      : `${m.nyquistKt.toFixed(0)} kt`
    : "—";
  const isL2 = m.source === "level2" || m.product.startsWith("L2");
  const tilt = m.tilt != null && m.elevation != null ? `${m.elevation.toFixed(2)}°` : "—";
  const vcp = m.vcp ? `${m.vcp}${m.mode ? ` · ${m.mode}` : ""}` : "—";
  const rangeTxt = `${fmtRange(m.rangeStartKm, sys)} – ${fmtRange(m.maxRangeKm, sys)}`;
  const band = m.band ? `${m.band} band${m.freqMHz ? ` · ${(m.freqMHz / 1000).toFixed(3)} GHz` : ""}` : "—";
  const altM = m.siteAmslM != null ? m.siteAmslM + (m.feedhornM ?? 0) : null;
  const alt = altM != null ? `${fmtHeight(altM / 1000, sys)} MSL` : "—";
  const loc = `${Math.abs(m.siteLat).toFixed(3)}°${m.siteLat >= 0 ? "N" : "S"} ${Math.abs(m.siteLon).toFixed(3)}°${m.siteLon >= 0 ? "E" : "W"}`;

  // The pointer: the focused pane's gate under the cursor.
  const p = cursor ? probeScan(scan!, cursor.lat, cursor.lng) : null;
  let val = "—";
  if (p?.status === "rf") val = "RF (range folded)";
  else if (p?.status === "nodata") val = "No echo";
  else if (p?.status === "outside") val = "Out of range";
  else if (p?.status === "ok") {
    const v = p.value as number;
    val =
      m.kind === "hca"
        ? (HCA_CLASSES[Math.round(v)] ?? `class ${Math.round(v)}`)
        : m.kind === "nrot"
          ? v.toFixed(2)
          : formatValue(v, m.kind, m.units, radarUnits, m.kind === "cc" ? 2 : m.kind === "vel" || m.kind === "srv" ? 0 : 1);
  }
  // Outside the scan, range and height mean nothing.
  const inside = !!p && p.status !== "outside";
  const ptrRange = inside ? fmtRange(p.rangeKm, sys) : "—";
  const ptrAz = p ? `${Math.round(p.azimuth) % 360}°` : "—";
  const ptrH =
    inside && m.tilt != null && m.elevation != null ? fmtHeight(beamHeightKm(p.rangeKm, m.elevation), sys) : "—";
  const ptrSummary = !p ? "Move over the map" : inside ? `${val} · ${ptrRange}` : val;

  return (
    <div ref={drag.ref} className={`pinfo${drag.dragging ? " is-dragging" : ""}`} style={drag.style}>
      {head}
      <Block id="scan" title="Scan" summary={`${m.vcp ? `VCP ${m.vcp} · ` : ""}${tilt} · ${hms(m.sweepUnix ?? m.scanUnix)}`}>
        <Row k="Product" v={m.productLabel} />
        <Row k="Volume" v={utc(m.scanUnix)} />
        <Row k="Sweep" v={m.sweepUnix ? utc(m.sweepUnix) : "—"} />
        <Row k="VCP" v={vcp} />
        <Row k="Tilt" v={tilt} />
        <Row k="Nyquist" v={nyq} />
        <Row k="Source" v={isL2 ? "Level II" : "Level III"} />
      </Block>
      <Block
        id="sampling"
        title="Sampling"
        summary={`${m.nAz} × ${m.nGates} · ${fmtShort(m.gateWidthKm, sys)} · ${fmtRange(m.maxRangeKm, sys)}`}
      >
        <Row k="Radials" v={`${m.nAz}${m.nAz >= 720 ? " (0.5° super-res)" : ""}`} />
        <Row k="Gates" v={m.nGates} />
        <Row k="Gate spacing" v={fmtShort(m.gateWidthKm, sys)} />
        <Row k="Range" v={rangeTxt} />
        {m.unambRangeKm != null && !sweepless && <Row k="Unambiguous" v={fmtRange(m.unambRangeKm, sys)} />}
      </Block>
      <Block
        id="radar"
        title="Radar"
        summary={`${m.site} · ${m.band ? `${m.band} band` : "—"} · ${m.beamWidthDeg ? `${m.beamWidthDeg}°` : "—"}`}
      >
        <Row k="Site" v={m.site} />
        <Row k="Band" v={band} />
        <Row k="Beam width" v={m.beamWidthDeg ? `${m.beamWidthDeg}°` : "—"} />
        <Row k="Location" v={loc} />
        <Row k="Antenna" v={alt} />
      </Block>
      <Block id="pointer" title="Pointer" summary={ptrSummary}>
        <Row k="Value" v={val} />
        <Row k="Range" v={ptrRange} />
        <Row k="Azimuth" v={ptrAz} />
        <Row k="Beam height" v={ptrH} />
      </Block>
    </div>
  );
}
