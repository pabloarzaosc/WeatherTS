import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, LocateFixed } from "lucide-react";

import { getMap } from "../../map/mapInstance";
import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import type { SatLegend, SatProduct } from "../../lib/satellite";
import { stepLabel } from "../../lib/loopTime";
import {
  FRAME_COUNTS,
  selectSatFrame,
  selectSatProduct,
  selectSatRegion,
  selectSatSatellite,
  useSatStore,
} from "../../store/useSatStore";

const LAYER = "satellite";

function ago(unix: number | null, now: number): string {
  if (unix == null) return "";
  const min = Math.max(0, Math.round((now - unix) / 60));
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min ago` : `${Math.round(h / 24)} days ago`;
}

function stamp(unix: number | undefined, daily: boolean): string {
  if (unix == null) return "—";
  const d = new Date(unix * 1000);
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  if (daily) return `${d.getUTCDate()} ${mo}`;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${mo} ${hh}:${mm}Z`;
}

function cadenceLabel(s: number): string {
  if (s >= 86400) return "daily";
  if (s >= 3600) return `${Math.round(s / 3600)} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${(s / 60).toFixed(1)} min`;
}

/** A colour ramp or a list of categories, for the Level 2 products. */
function Legend({ legend }: { legend: SatLegend }) {
  if (legend.categories?.length) {
    return (
      <div className="satlegend satlegend--cats">
        {legend.categories.map(([label, colour]) => (
          <span key={label} className="satlegend__cat">
            <i style={{ background: colour }} />
            {label}
          </span>
        ))}
      </div>
    );
  }
  const stops = legend.stops ?? [];
  if (stops.length < 2) return null;
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const pos = (v: number) =>
    legend.log
      ? (Math.log10(Math.max(v, 1e-9)) - Math.log10(Math.max(lo, 1e-9))) /
        (Math.log10(Math.max(hi, 1e-9)) - Math.log10(Math.max(lo, 1e-9)))
      : (v - lo) / (hi - lo);
  const gradient = stops.map(([v, c]) => `${c} ${(pos(v) * 100).toFixed(1)}%`).join(", ");
  const fmt = (v: number) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2));
  const ticks = stops.length > 6 ? [stops[0], stops[Math.floor(stops.length / 2)], stops[stops.length - 1]] : stops;
  return (
    <div className="satlegend">
      <div className="satlegend__bar" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
      <div className="satlegend__ticks">
        {ticks.map(([v]) => (
          <span key={v} style={{ left: `${pos(v) * 100}%` }}>
            {fmt(v)}
          </span>
        ))}
      </div>
      {legend.units && <div className="satlegend__units">{legend.units}</div>}
    </div>
  );
}

/**
 * Fly the map to a lon/lat box. Worked out here rather than with fitBounds:
 * the Pacific regions run past the date line (west of -180), and MapLibre's
 * bounds fold those back and frame the wrong ocean.
 */
function flyToBox(b: [number, number, number, number]) {
  const map = getMap();
  if (!map) return;
  const canvas = map.getCanvas();
  const w = Math.max(200, canvas.clientWidth - 48);
  const h = Math.max(200, canvas.clientHeight - 48);
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
  const lonSpan = Math.max(0.1, b[2] - b[0]);
  const latSpan = Math.max(1e-3, my(b[3]) - my(b[1]));
  const zoom = Math.max(0, Math.min(7, Math.log2((w * 360) / (lonSpan * 512)), Math.log2((h * 2 * Math.PI) / (latSpan * 512))));
  const lon = ((((b[0] + b[2]) / 2 + 180) % 360) + 360) % 360 - 180;
  const lat = ((2 * Math.atan(Math.exp((my(b[1]) + my(b[3])) / 2)) - Math.PI / 2) * 180) / Math.PI;
  map.flyTo({ center: [lon, lat], zoom, duration: 900 });
}

/**
 * Satellite imagery, laid out the way WeatherWise lays it out: a satellite, one
 * of its regions, then a product of that region -- bands, RGB composites and,
 * for GOES, the Level 2 products.
 */
export function SatelliteView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const catalog = useSatStore((s) => s.catalog);
  const productId = useSatStore((s) => s.product);
  const count = useSatStore((s) => s.count);
  const frames = useSatStore((s) => s.frames);
  const index = useSatStore((s) => s.index);
  const bounds = useSatStore((s) => s.bounds);
  const flyRequest = useSatStore((s) => s.flyRequest);
  const busy = useSatStore((s) => s.busy);
  const loopLoaded = useSatStore((s) => s.loopLoaded);
  const loopTotal = useSatStore((s) => s.loopTotal);
  const loopArmed = useSatStore((s) => s.loopArmed);
  const error = useSatStore((s) => s.error);
  const select = useSatStore((s) => s.select);
  const setCount = useSatStore((s) => s.setCount);
  const satellite = useSatStore(selectSatSatellite);
  const region = useSatStore(selectSatRegion);
  const product = useSatStore(selectSatProduct);
  const frame = useSatStore(selectSatFrame);

  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    void useSatStore.getState().load();
    const t = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // A region just picked: fly there once where it is is known (the moving
  // boxes learn it with their first frame list).
  const flown = useRef(flyRequest);
  useEffect(() => {
    if (flyRequest === flown.current) return;
    const b = bounds ?? region?.bounds ?? null;
    if (!b) return;
    flown.current = flyRequest;
    flyToBox(b);
  }, [flyRequest, bounds, region]);

  // The product picked (here, or kept across a satellite switch) is scrolled
  // into the list's view: 72 products do not fit.
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = tree.current?.querySelector<HTMLElement>(".obstree__item.is-on");
    if (on && tree.current) {
      const t = tree.current;
      const top = on.offsetTop - t.offsetTop;
      if (top < t.scrollTop || top + on.offsetHeight > t.scrollTop + t.clientHeight) {
        t.scrollTop = Math.max(0, top - t.clientHeight / 2);
      }
    }
  }, [productId, region?.id, satellite?.id]);

  const groups = useMemo(() => {
    const order = catalog?.productGroups ?? [];
    const by = new Map<string, SatProduct[]>();
    for (const p of region?.products ?? []) by.set(p.group, [...(by.get(p.group) ?? []), p]);
    return order.filter((g) => by.has(g.id)).map((g) => ({ ...g, products: by.get(g.id)! }));
  }, [catalog, region]);

  const daily = (region?.cadence ?? 0) >= 86400;
  const latest = frames.length ? frames[frames.length - 1].unix : null;
  const step = useMemo(() => stepLabel(frames.map((f) => f.unix)), [frames]);
  const span =
    frames.length >= 2
      ? `${stamp(frames[0].unix, daily)} → ${stamp(frames[frames.length - 1].unix, daily)}`
      : stamp(frames[0]?.unix, daily);

  const flyToRegion = () => {
    const b = bounds ?? region?.bounds;
    if (b) flyToBox(b);
  };

  return (
    <div className="sfx">
      <LayerPower label="Satellite" on={enabled} error={!!error} onToggle={() => setLayerVisible(LAYER, !enabled)} />

      <div className={`sfx__status${error ? " is-error" : ""}`}>
        {busy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Loading {product?.label ?? "imagery"}…
          </>
        ) : error ? (
          <>
            <AlertTriangle size={13} /> {error}
          </>
        ) : enabled && frame && loopArmed && loopTotal > 0 && loopLoaded < loopTotal ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> {stamp(frame.unix, daily)} · loading loop{" "}
            {loopLoaded}/{loopTotal}
          </>
        ) : enabled && frame ? (
          <>
            {stamp(frame.unix, daily)} · newest {ago(latest, now)}
          </>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Satellite</span>
          {satellite && <b>{satellite.group}</b>}
        </div>
        <Select
          value={satellite?.id ?? ""}
          onChange={(v) => select({ sat: v })}
          aria-label="Satellite"
          options={(catalog?.satellites ?? []).map((s) => ({
            value: s.id,
            label: s.label,
            hint: s.detail,
            group: s.group,
          }))}
          placeholder="Satellite"
        />
        {satellite?.note && (
          <div className="sfx__ends">
            <span>{satellite.note}</span>
          </div>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Region</span>
          {region && <b>every {cadenceLabel(region.cadence)}</b>}
        </div>
        <div className="sfx__chips">
          {(satellite?.regions ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              className={`sfx__chip${r.id === region?.id ? " is-on" : ""}`}
              aria-pressed={r.id === region?.id}
              title={r.note || r.label}
              onClick={() => select({ region: r.id })}
            >
              {r.label}
            </button>
          ))}
          <button type="button" className="sfx__chip" disabled={!(bounds ?? region?.bounds)} onClick={flyToRegion}>
            <LocateFixed size={11} style={{ marginRight: 4, verticalAlign: "-1px" }} />
            Show
          </button>
        </div>
        {region?.note && (
          <div className="sfx__ends">
            <span>{region.note}</span>
          </div>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Product</span>
          <b>{region?.products.length ?? 0}</b>
        </div>
        <div className="obstree">
          <div className="obstree__body sattree" ref={tree}>
            {groups.map((g) => (
              <div key={g.id} className="obstree__sub">
                <div className="obstree__subname">{g.label}</div>
                {g.products.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`obstree__item${p.id === productId ? " is-on" : ""}`}
                    aria-pressed={p.id === productId}
                    title={p.note || p.label}
                    onClick={() => select({ product: p.id })}
                  >
                    <span className="obstree__label">{p.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {product && (
          <div className="sfx__ends">
            <span>{product.note}</span>
          </div>
        )}
        {product?.legend && <Legend legend={product.legend} />}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Frames</span>
          <b>
            {count}
            {step ? ` · every ${step}` : ""}
          </b>
        </div>
        <div className="sfx__chips">
          {FRAME_COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              className={`sfx__chip${n === count ? " is-on" : ""}`}
              aria-pressed={n === count}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="sfx__ends">
          <span>{span}</span>
          <span>{frames.length ? `${index + 1} / ${frames.length}` : "—"}</span>
        </div>
        <div className="sfx__ends">
          <span>Press play to download the loop for the area on screen.</span>
        </div>
      </div>

      <div className="sfx__block sfx__block--tight">
        <div className="mslp__note">
          Every frame is a step on the map timeline at the bottom, and the loop follows new scans in as they
          arrive. {product?.source ? `This product: ${product.source}.` : ""}
        </div>
      </div>
    </div>
  );
}
