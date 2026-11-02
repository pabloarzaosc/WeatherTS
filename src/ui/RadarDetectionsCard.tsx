import { useEffect, useState } from "react";
import { Crosshair, Loader2, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import {
  drawnMesos,
  tvsOf,
  useDetectionsStore,
  vrotTone,
  type DetCouplet,
  type DetDebris,
  type DetMeso,
  type Detections,
} from "../store/useDetectionsStore";

/**
 * The card for a clicked radar detection (radarDetectionsLayer), and the
 * Overlays row that switches the layer from the Radar panel.
 *
 * Anchored the way the storm-cell card is: the detection's lon/lat projected
 * on the focused pane's map on every move, so it stays beside its marker.
 */

const LAYER = "radar-detections";
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * 111.2, (a.lon - b.lon) * 111.2 * k);
};
const f1 = (v: number) => v.toFixed(1);
const utc = (unix: number | null) =>
  unix === null ? "" : new Date(unix * 1000).toISOString().slice(11, 19) + " UTC";

type Picked =
  | { type: "meso"; m: DetMeso }
  | { type: "tvs"; c: DetCouplet }
  | { type: "tds"; t: DetDebris };

function picked(d: Detections | null): Picked | null {
  const sel = useDetectionsStore.getState().selected;
  if (!d || !sel) return null;
  if (sel.type === "meso") {
    const m = d.mesos.find((q) => q.trackId === sel.trackId);
    return m ? { type: "meso", m } : null;
  }
  if (sel.type === "tvs") {
    const c = d.couplets.find((q) => q.rank === sel.rank);
    return c ? { type: "tvs", c } : null;
  }
  const t = d.tds[sel.index];
  return t ? { type: "tds", t } : null;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Range({ d, p }: { d: Detections; p: { rangeKm: number; azDeg: number } }) {
  return (
    <>
      {Math.round(p.rangeKm)} km {compass(p.azDeg)} of {d.site} <small>({Math.round(p.azDeg)}°)</small>
    </>
  );
}

function MesoBody({ d, m }: { d: Detections; m: DetMeso }) {
  const lock = useDetectionsStore((s) => s.lockTrackId);
  const lockOn = useDetectionsStore((s) => s.lockOn);
  const tvs = tvsOf(d).find((c) => dist(c, m) <= 5);
  const tds = m.tds ? d.tds.find((t) => dist(t, m) <= 6) : undefined;
  const tilts = m.features.map((f) => f.elev);
  return (
    <>
      <dl className="detcard__grid">
        <Row k="Vrot">
          <b>{f1(m.maxVrotKt)} kt</b> <small>at {f1(m.maxVrotHeightKm)} km</small>
        </Row>
        <Row k="Low-level">{f1(m.lowVrotKt)} kt</Row>
        <Row k="Delta-V">{f1(m.maxDvKt)} kt</Row>
        <Row k="Shear">
          {(m.maxShear * 1000).toFixed(1)} ×10⁻³ s⁻¹ <small>NROT {m.maxNrot.toFixed(2)}</small>
        </Row>
        <Row k="Base / top">
          {f1(m.baseKm)} – {f1(m.topKm)} km <small>ARL</small>
        </Row>
        <Row k="Depth">
          {f1(m.depthKm)} km <small>Ø {f1(m.diamKm)} km</small>
        </Row>
        <Row k="Range">
          <Range d={d} p={m} />
        </Row>
        <Row k="Tilts">
          {tilts.length} <small>{tilts.join(", ")}°</small>
        </Row>
        <Row k="Motion">
          {m.motion ? (
            <>
              {Math.round(m.motion.speedKt)} kt toward {compass(m.motion.toward)}{" "}
              <small>({Math.round(m.motion.toward)}°)</small>
            </>
          ) : d.tracked ? (
            <small>New this volume</small>
          ) : (
            <small>Tracking from the volume before…</small>
          )}
        </Row>
        {tvs ? (
          <Row k={tvs.tvs === "TVS" ? "TVS" : "ETVS"}>
            {Math.round(tvs.dvKt)} kt across {f1(tvs.gapKm)} km
          </Row>
        ) : null}
        {tds ? (
          <Row k="Debris">
            {Math.round(tds.maxDbz)} dBZ, CC {tds.minCc.toFixed(2)}, ZDR {f1(tds.zdr)}{" "}
            <small>to {f1(tds.topKm)} km</small>
          </Row>
        ) : null}
      </dl>
      <div className="detcard__actions">
        <button
          type="button"
          className={`detcard__btn${lock === m.trackId ? " is-on" : ""}`}
          onClick={() => lockOn(lock === m.trackId ? null : m.trackId)}
          title="Keep the map centred on this detection as it moves"
        >
          <Crosshair size={13} /> {lock === m.trackId ? "Unlock" : "Lock on"}
        </button>
        {m.track?.length ? <span className="detcard__note">{m.track.length} earlier position{m.track.length === 1 ? "" : "s"}</span> : null}
      </div>
    </>
  );
}

function TvsBody({ d, c }: { d: Detections; c: DetCouplet }) {
  return (
    <dl className="detcard__grid">
      <Row k="Delta-V">
        <b>{f1(c.dvKt)} kt</b> <small>{c.class}</small>
      </Row>
      <Row k="Vrot">{f1(c.vrotKt)} kt</Row>
      <Row k="In / out">
        {f1(c.vinKt)} / {f1(c.voutKt)} kt
      </Row>
      <Row k="Across">{f1(c.gapKm)} km</Row>
      <Row k="Base">
        {f1(c.baseKm ?? c.heightKm)} km <small>ARL, strongest at {f1(c.heightKm)} km</small>
      </Row>
      <Row k="Range">
        <Range d={d} p={c} />
      </Row>
      <Row k="Tilts">
        {c.tilts.length} <small>{c.tilts.join(", ")}°</small>
      </Row>
      <Row k="NROT">{c.nrot.toFixed(2)}</Row>
    </dl>
  );
}

function TdsBody({ d, t }: { d: Detections; t: DetDebris }) {
  return (
    <dl className="detcard__grid">
      <Row k="Max dBZ">
        <b>{f1(t.maxDbz)}</b>
      </Row>
      <Row k="Min CC">
        <b>{t.minCc.toFixed(3)}</b>
      </Row>
      <Row k="ZDR">{f1(t.zdr)} dB <small>median</small></Row>
      <Row k="Size">
        {t.gates} gates <small>{f1(t.areaKm2)} km²</small>
      </Row>
      <Row k="Base / top">
        {f1(t.baseKm)} – {f1(t.topKm)} km <small>ARL</small>
      </Row>
      <Row k="Range">
        <Range d={d} p={t} />
      </Row>
      <Row k="Tilts">
        {t.tilts.length} <small>{t.tilts.join(", ")}°</small>
      </Row>
      <Row k="Rotation">
        {Math.round(t.rotDvKt)} kt couplet <small>{f1(t.rotKm)} km away</small>
      </Row>
    </dl>
  );
}

const TITLES = {
  meso: (p: DetMeso) => (p.kind === "meso" ? "Mesocyclone" : "Circulation"),
  tvs: (p: DetCouplet) => (p.tvs === "TVS" ? "Tornado vortex signature" : "Elevated TVS"),
  tds: () => "Debris signature (TDS)",
};

export function RadarDetectionsCard() {
  const data = useDetectionsStore((s) => s.data);
  const selected = useDetectionsStore((s) => s.selected);
  const select = useDetectionsStore((s) => s.select);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const p = selected ? picked(data) : null;
  const at = p ? (p.type === "meso" ? p.m : p.type === "tvs" ? p.c : p.t) : null;
  const lat = at?.lat;
  const lon = at?.lon;

  useEffect(() => {
    if (lat === undefined || lon === undefined) {
      setPos(null);
      return;
    }
    const update = () => {
      const map = getMap();
      if (!map) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const q = map.project([lon, lat]);
      setPos({ x: q.x + rect.left, y: q.y + rect.top });
    };
    const bind = () => {
      const m = getMap();
      m?.on("move", update);
      m?.on("resize", update);
      return () => {
        m?.off("move", update);
        m?.off("resize", update);
      };
    };
    update();
    let unbind = bind();
    const unsubPanes = subscribeMaps(() => {
      unbind();
      unbind = bind();
      update();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unbind();
      unsubPanes();
      window.removeEventListener("keydown", onKey);
    };
  }, [lat, lon, select]);

  if (!p || !pos || !data) return null;

  const W = 268;
  const H = 300;
  const GAP = 16;
  const flip = pos.x + GAP + W > window.innerWidth - 8;
  const left = Math.max(8, flip ? pos.x - GAP - W : pos.x + GAP);
  const top = Math.max(8, Math.min(pos.y - 40, window.innerHeight - H - 8));
  const tone =
    p.type === "meso" ? vrotTone(p.m.maxVrotKt) : p.type === "tvs" ? vrotTone(p.c.vrotKt) : "debris";
  const strength = p.type === "meso" ? p.m.strength : p.type === "tvs" ? p.c.tvs : null;

  return (
    <div className="detcard" style={{ left, top, width: W }} role="dialog" aria-label="Radar detection">
      <header className="detcard__head">
        <span className={`detcard__swatch tone-${tone}`} aria-hidden="true" />
        <b>{p.type === "meso" ? TITLES.meso(p.m) : p.type === "tvs" ? TITLES.tvs(p.c) : TITLES.tds()}</b>
        {strength ? <span className="detcard__chip">{strength}</span> : null}
        <button type="button" onClick={() => select(null)} title="Close" aria-label="Close">
          <X size={14} />
        </button>
      </header>
      {p.type === "meso" ? <MesoBody d={data} m={p.m} /> : p.type === "tvs" ? <TvsBody d={data} c={p.c} /> : <TdsBody d={data} t={p.t} />}
      <footer className="detcard__foot">
        {data.site} volume {utc(data.scanUnix)} · from Level II
        {p.type === "meso" && (p.m.parts ?? 1) > 1 ? ` · ${p.m.parts} columns joined` : ""}
      </footer>
    </div>
  );
}

/** The "Detections" row in the Radar panel's Overlays: the layer switch, what
 *  the volume on screen holds, and the key to the shapes and colours. */
export function DetectionsOverlayRow() {
  const on = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const data = useDetectionsStore((s) => s.data);
  const loading = useDetectionsStore((s) => s.loading);
  const error = useDetectionsStore((s) => s.error);
  const mesos = drawnMesos(data);
  const nMeso = mesos.filter((m) => m.kind === "meso").length;
  const nTvs = tvsOf(data).length;
  const nTds = data?.tds.length ?? 0;
  const airport = useNexradStore((s) => s.sites.some((x) => x.id === s.site && x.type === "TDWR"));
  let note: React.ReactNode = null;
  if (on) {
    if (airport) note = "NEXRAD radars only";
    else if (loading && !data) note = <><Loader2 size={11} className="spin" /> reading the volume</>;
    else if (error && !data) note = "not available here";
    else if (data)
      note = `${nMeso} meso${nMeso === 1 ? "" : "s"}${mesos.length > nMeso ? `, ${mesos.length - nMeso} circ.` : ""}, ${nTvs} TVS${data.dualPol ? `, ${nTds} TDS` : ""}`;
  }
  return (
    <>
      <div className="sfcobs__toggle-row">
        <span>
          Detections
          {note ? <small className="detrow__note">{note}</small> : null}
        </span>
        <button
          type="button"
          className={`sfc-switch${on ? " is-on" : ""}`}
          onClick={() => setLayerVisible(LAYER, !on)}
          role="switch"
          aria-checked={on}
          title="Mesocyclones, TVS and debris computed from the radar's own volume"
        >
          <span className="sfc-switch__knob" />
        </button>
      </div>
      {on ? (
        <div className="detlegend" aria-label="Detection key">
          <span><i className="detlegend__shape is-circle" /> Meso</span>
          <span><i className="detlegend__shape is-ring" /> Circ.</span>
          <span><i className="detlegend__shape is-tri" /> TVS</span>
          <span><i className="detlegend__shape is-diamond" /> TDS</span>
          <span className="detlegend__ramp">
            <i className="tone-orange" />30<i className="tone-red" />50<i className="tone-magenta" />65<i className="tone-purple" />80 kt
          </span>
        </div>
      ) : null}
    </>
  );
}
