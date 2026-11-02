import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { allMaps, getActivePaneId, paneIdOf } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { loadScan, useNexradStore } from "../store/useNexradStore";
import { useCompareStore } from "../store/useCompareStore";
import { useSetting } from "../settings/useSettingsStore";
import { HCA_CLASSES } from "../lib/hca";
import { formatValue, toDisplay, unitFor, type UnitOption } from "../lib/radarUnits";
import type { PolarScan } from "../lib/radarMesh";
import {
  beamHeightKm,
  beamWidthKm,
  efOdds,
  findCouplet,
  fmtHeight,
  fmtRange,
  fmtShort,
  probeScan,
  type Couplet,
  type ReadoutDistance,
} from "../lib/radarProbe";

/** Products whose readout looks for a rotation couplet around the pointer. */
const COUPLET_KINDS = new Set(["vel", "srv", "nrot"]);
/** Products in a speed unit, which quote the scan's Nyquist velocity. */
const SPEED_KINDS = new Set(["vel", "srv", "sw"]);
const SEARCH_KM = 5;
const W = 252;
const GAP = 22;
/** Clicks, drags and right-clicks the map does not get while Shift is held. */
const BLOCKED = ["mousedown", "pointerdown", "click", "dblclick", "contextmenu", "touchstart"] as const;

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function mapAt(x: number, y: number): MapLibreMap | null {
  for (const m of allMaps()) {
    const r = m.getContainer().getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m;
  }
  return null;
}

const signed = (u: UnitOption, kt: number) => {
  const v = Math.round(toDisplay(u, kt));
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)} ${u.label}`;
};
const plain = (u: UnitOption, kt: number) => `${Math.round(toDisplay(u, kt))} ${u.label}`;

const KT: UnitOption = { id: "kt", label: "kt", factor: 1, decimals: 0, step: 20 };

/**
 * Hold Shift over the radar: a crosshair and a box with everything the radar
 * knows about that gate -- the value (velocity with the scan's Nyquist, "RF"
 * on a range-folded gate), how far out it is, how high and how wide the beam
 * is there and how long its gates are. Over velocity, storm-relative velocity
 * and NROT it also finds the strongest inbound and outbound gates within 5 km
 * and reads the couplet: delta-V, their distance, azimuthal shear, Vrot and
 * the damage-rating odds that Vrot carries if a tornado is on the ground.
 *
 * The map takes no clicks while Shift is held, so reading a couplet never
 * drops a marker or starts a box zoom.
 */
/** One gate's value in words, as the readout prints it (the compared half). */
function gateText(scan: PolarScan, p: ReturnType<typeof probeScan>, radarUnits: Parameters<typeof unitFor>[1]): { text: string; note: string | null } {
  const m = scan.meta;
  if (p.status === "rf") return { text: "RF", note: "range folded" };
  if (p.status === "nodata") return { text: "No echo", note: null };
  if (p.status === "outside") return { text: "Out of range", note: null };
  const v = p.value as number;
  if (m.kind === "hca") return { text: HCA_CLASSES[Math.round(v)] ?? `class ${Math.round(v)}`, note: null };
  if (m.kind === "vel" || m.kind === "srv") return { text: signed(unitFor(m.kind, radarUnits) ?? KT, v), note: null };
  if (m.kind === "nrot") return { text: v.toFixed(2), note: null };
  const dec = m.kind === "cc" ? 2 : m.kind === "sw" ? 0 : 1;
  return { text: formatValue(v, m.kind, m.units, radarUnits, dec), note: null };
}

export function ShiftReadout() {
  const [shift, setShift] = useState(false);
  const [ptr, setPtr] = useState<{ x: number; y: number; overMap: boolean } | null>(null);
  const [, setTick] = useState(0);
  const activeRef = useRef(false);

  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const radarUnits = useAppStore((s) => s.radarUnits);
  const paneRadar = useNexradStore((s) => s.paneRadar);
  const focusedScan = useNexradStore((s) => s.scan);
  const sys = (useSetting<string>("radar.readoutDistance") === "km" ? "km" : "mi") as ReadoutDistance;

  // Shift and the pointer. The pointer is only state while Shift is down, so
  // an ordinary mouse move costs nothing here.
  const ptrRef = useRef<{ x: number; y: number; overMap: boolean } | null>(null);
  const shiftRef = useRef(false);
  useEffect(() => {
    const set = (on: boolean) => {
      shiftRef.current = on;
      setShift(on);
      if (on) setPtr(ptrRef.current);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !isTyping() && !shiftRef.current) set(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") set(false);
    };
    const off = () => set(false);
    const move = (e: MouseEvent) => {
      const t = e.target as Element | null;
      ptrRef.current = { x: e.clientX, y: e.clientY, overMap: !!t?.closest?.(".maplibregl-map") };
      // A Shift pressed while another window had focus never sent its keydown.
      if (e.shiftKey !== shiftRef.current && !isTyping()) set(e.shiftKey);
      else if (shiftRef.current) setPtr(ptrRef.current);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    window.addEventListener("mousemove", move, { passive: true });
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", off);
      window.removeEventListener("mousemove", move);
    };
  }, []);

  // The map is read-only while the readout is up.
  useEffect(() => {
    const block = (e: Event) => {
      if (!activeRef.current) return;
      const t = e.target as Element | null;
      if (!t?.closest?.(".maplibregl-map")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    for (const ev of BLOCKED) window.addEventListener(ev, block, { capture: true, passive: false });
    return () => {
      for (const ev of BLOCKED) window.removeEventListener(ev, block, { capture: true });
    };
  }, []);

  const map = ptr ? mapAt(ptr.x, ptr.y) : null;
  const paneId = map ? paneIdOf(map) : null;
  const paneScan = paneId ? paneRadar[paneId]?.scan ?? null : null;
  const scan: PolarScan | null =
    paneScan ?? (paneId === null || paneId === getActivePaneId() || !paneRadar[paneId] ? focusedScan : null);
  // Compare (panes-compare): the pane's second product, read at the same spot.
  const cmpScan = useCompareStore((s) => (paneId && s.slots[paneId] ? s.views[paneId]?.scan ?? null : null));
  const active = !!(shift && ptr?.overMap && map && radarOn && scan);
  activeRef.current = active;

  useEffect(() => {
    document.body.classList.toggle("sro-on", active);
    return () => document.body.classList.remove("sro-on");
  }, [active]);

  // A wheel zoom under a still pointer moves the map under the crosshair.
  useEffect(() => {
    if (!active || !map) return;
    const bump = () => setTick((n) => n + 1);
    map.on("move", bump);
    return () => {
      map.off("move", bump);
    };
  }, [active, map]);

  // NROT is not a velocity: its couplet is read from the velocity scan it was
  // computed from (same key), fetched once and cached like any frame.
  const meta = scan?.meta;
  const velFor = meta?.kind === "nrot" && meta.derivedFrom ? `${meta.site}|${meta.derivedFrom}|${meta.key}` : null;
  const [velScan, setVelScan] = useState<{ id: string; scan: PolarScan } | null>(null);
  useEffect(() => {
    if (!velFor || !active || velScan?.id === velFor) return;
    const [site, product, key] = velFor.split("|");
    let live = true;
    loadScan(site, product, key)
      .then((s) => live && setVelScan({ id: velFor, scan: s }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [velFor, active, velScan?.id]);

  if (!active || !map || !scan || !ptr || !meta) return null;

  const rect = map.getCanvas().getBoundingClientRect();
  const ll = map.unproject([ptr.x - rect.left, ptr.y - rect.top]);
  const p = probeScan(scan, ll.lat, ll.lng);

  // ---- the gate ----
  const speedUnit = unitFor(meta.kind === "nrot" ? "vel" : meta.kind, radarUnits) ?? KT;
  let valueText: string;
  let valueNote: string | null = null;
  if (p.status === "rf") {
    valueText = "RF";
    valueNote = "range folded";
  } else if (p.status === "nodata") {
    valueText = "No echo";
  } else if (p.status === "outside") {
    valueText = "Out of range";
  } else if (meta.kind === "hca") {
    valueText = HCA_CLASSES[Math.round(p.value as number)] ?? `class ${Math.round(p.value as number)}`;
  } else if (meta.kind === "vel" || meta.kind === "srv") {
    valueText = signed(speedUnit, p.value as number);
  } else if (meta.kind === "nrot") {
    valueText = (p.value as number).toFixed(2);
  } else {
    const dec = meta.kind === "cc" ? 2 : meta.kind === "sw" ? 0 : 1;
    valueText = formatValue(p.value as number, meta.kind, meta.units, radarUnits, dec);
  }
  const nyq =
    SPEED_KINDS.has(meta.kind) && meta.nyquistKt
      ? `Nyquist ${plain(speedUnit, meta.nyquistKt)}`
      : null;

  const tilted = meta.tilt != null && meta.elevation != null;
  const heightKm = tilted ? beamHeightKm(p.rangeKm, meta.elevation as number) : null;
  const beamKm = meta.beamWidthDeg ? beamWidthKm(p.rangeKm, meta.beamWidthDeg) : null;

  // ---- the compared product (panes-compare) ----
  const cmpMeta = cmpScan?.meta;
  const cp2 = cmpScan ? probeScan(cmpScan, ll.lat, ll.lng) : null;
  const cmpText = cmpScan && cp2 ? gateText(cmpScan, cp2, radarUnits) : null;
  // REF | VEL: the couplet comes off the velocity half.
  const cmpVel = !COUPLET_KINDS.has(meta.kind) && cmpMeta && (cmpMeta.kind === "vel" || cmpMeta.kind === "srv") ? cmpScan : null;

  // ---- the couplet ----
  const velSrc = cmpVel ?? (meta.kind === "nrot" ? (velScan?.id === velFor ? velScan?.scan : null) : scan);
  const wantCouplet = (COUPLET_KINDS.has(meta.kind) || !!cmpVel) && p.status !== "outside";
  // A circle round the radar itself takes in both sides of the mean wind,
  // which is a "pair" that has nothing to do with rotation.
  const nearRadar = p.rangeKm < SEARCH_KM * 1.5;
  const cp: Couplet | null =
    wantCouplet && velSrc && !nearRadar ? findCouplet(velSrc, ll.lat, ll.lng, SEARCH_KM) : null;
  const odds = cp?.vrotKt != null ? efOdds(cp.vrotKt) : null;

  // ---- placement ----
  const estH = 128 + (cmpText ? 34 : 0) + (wantCouplet ? (cp?.dvKt != null ? 132 : 40) : 0);
  const flipX = ptr.x + GAP + W > window.innerWidth - 8;
  const left = flipX ? ptr.x - GAP - W : ptr.x + GAP;
  let top = ptr.y + GAP;
  if (top + estH > window.innerHeight - 8) top = Math.max(8, ptr.y - GAP - estH);

  const proj = (lat: number, lon: number) => {
    const q = map.project([lon, lat]);
    return { x: q.x + rect.left, y: q.y + rect.top };
  };
  const ringPx = wantCouplet
    ? Math.hypot(
        proj(ll.lat, ll.lng + SEARCH_KM / (111.32 * Math.cos((ll.lat * Math.PI) / 180))).x - ptr.x,
        0,
      )
    : 0;
  const pin = cp?.vin ? proj(cp.vin.lat, cp.vin.lon) : null;
  const pout = cp?.vout ? proj(cp.vout.lat, cp.vout.lon) : null;
  const cross =
    `M${ptr.x - 18} ${ptr.y}H${ptr.x - 5}M${ptr.x + 5} ${ptr.y}H${ptr.x + 18}` +
    `M${ptr.x} ${ptr.y - 18}V${ptr.y - 5}M${ptr.x} ${ptr.y + 5}V${ptr.y + 18}`;
  const dia = (km: number) => (sys === "km" ? `${km.toFixed(2)} km` : `${(km / 1.609344).toFixed(2)} mi`);

  return (
    <>
      <svg className="sro-x" width={window.innerWidth} height={window.innerHeight} aria-hidden>
        {ringPx > 0 && <circle className="sro-x__ring" cx={ptr.x} cy={ptr.y} r={ringPx} />}
        {pin && pout && <line className="sro-x__pair" x1={pin.x} y1={pin.y} x2={pout.x} y2={pout.y} />}
        {pin && <circle className="sro-x__in" cx={pin.x} cy={pin.y} r={5} />}
        {pout && <circle className="sro-x__out" cx={pout.x} cy={pout.y} r={5} />}
        <g className="sro-x__cross">
          <path className="cas" d={cross} />
          <path d={cross} />
        </g>
      </svg>
      <div className="sro" style={{ left, top, width: W }} aria-live="off">
        <div className="sro__head">
          <b>{meta.site}</b>
          <span>{meta.productLabel}</span>
          {meta.elevation != null && tilted && <span className="sro__tilt">{meta.elevation.toFixed(1)}°</span>}
        </div>
        <div className={`sro__value${p.status === "rf" ? " is-rf" : ""}`}>
          <span>{valueText}</span>
          {valueNote && <small>{valueNote}</small>}
          {nyq && <small>{nyq}</small>}
        </div>
        {cmpMeta && cmpText && (
          <div className={`sro__value sro__value--cmp${cp2?.status === "rf" ? " is-rf" : ""}`}>
            <span>{cmpText.text}</span>
            <small>
              {cmpMeta.productLabel}
              {cmpMeta.elevation != null ? ` ${cmpMeta.elevation.toFixed(1)}°` : ""}
            </small>
            {cmpText.note && <small>{cmpText.note}</small>}
          </div>
        )}
        <dl className="sro__grid">
          <dt>Range</dt>
          <dd>
            {fmtRange(p.rangeKm, sys)} <i>at {Math.round(p.azimuth) % 360}°</i>
          </dd>
          {heightKm != null && (
            <>
              <dt>Beam height</dt>
              <dd>
                {fmtHeight(heightKm, sys)} <i>above radar</i>
              </dd>
            </>
          )}
          {beamKm != null && (
            <>
              <dt>Beam width</dt>
              <dd>{fmtShort(beamKm, sys)}</dd>
            </>
          )}
          <dt>Gate length</dt>
          <dd>{fmtShort(meta.gateWidthKm, sys)}</dd>
        </dl>
        {wantCouplet && (
          <div className="sro__cp">
            {nearRadar ? (
              <div className="sro__note">Too close to the radar to read a couplet.</div>
            ) : !velSrc ? (
              <div className="sro__note">Loading the velocity scan…</div>
            ) : cp?.dvKt == null ? (
              <div className="sro__note">No inbound and outbound pair within {sys === "km" ? "5 km" : "3 mi"}</div>
            ) : (
              <>
                <dl className="sro__grid sro__grid--4">
                  <dt>Vin</dt>
                  <dd className="sro__in">{signed(speedUnit, cp.vin!.v)}</dd>
                  <dt>Vout</dt>
                  <dd className="sro__out">{signed(speedUnit, cp.vout!.v)}</dd>
                  <dt>ΔV</dt>
                  <dd>{plain(speedUnit, cp.dvKt)}</dd>
                  <dt>Dia</dt>
                  <dd>{dia(cp.diaKm as number)}</dd>
                </dl>
                {cp.unfolded && (
                  <div className="sro__note">
                    Unfolded across the Nyquist velocity ({plain(speedUnit, velSrc.meta.nyquistKt as number)}).
                  </div>
                )}
                <dl className="sro__grid">
                  <dt>AzShear</dt>
                  <dd>
                    {(cp.azShear as number).toFixed(1)} <i>×10⁻³ s⁻¹</i>
                  </dd>
                  <dt>Vrot</dt>
                  <dd>
                    {plain(speedUnit, cp.vrotKt as number)}
                    {speedUnit.id !== "kt" && <i> ({Math.round(cp.vrotKt as number)} kt)</i>}
                  </dd>
                </dl>
                {odds ? (
                  <>
                    <div className="sro__odds">
                      <span>
                        EF1+ <b>{odds.ef1}%</b>
                      </span>
                      <span>
                        EF2+ <b>{odds.ef2}%</b>
                      </span>
                      <span>
                        EF3+ <b>{odds.ef3}%</b>
                      </span>
                    </div>
                    <div className="sro__note">
                      Odds if a tornado is on the ground (after Smith et al. 2015, Thompson et al. 2017).
                    </div>
                  </>
                ) : (
                  <div className="sro__note">Vrot under 20 kt: no damage-rating odds.</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
