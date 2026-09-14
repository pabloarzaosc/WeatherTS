import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, LocateFixed } from "lucide-react";

import { getMap } from "../../map/mapInstance";
import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import type { SatProduct } from "../../lib/satellite";
import {
  LOOP_HOURS,
  spanLabel,
  stepLabel,
  selectSatFrame,
  selectSatProduct,
  selectSatSatellite,
  useSatStore,
} from "../../store/useSatStore";

const LAYER = "satellite";

/** The order kinds are listed in under a satellite. */
const KIND_ORDER = ["Visible", "Infrared", "Water Vapor", "RGB", "Cloud", "Lightning", "Precipitation", "Fire", "Derived"];

function ago(unix: number | null, now: number): string {
  if (unix == null) return "";
  const min = Math.max(0, Math.round((now - unix) / 60));
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min ago` : `${Math.round(h / 24)} days ago`;
}

/** Satellite imagery: pick a satellite, then one of its products, then how long a loop. */
export function SatelliteView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const catalog = useSatStore((s) => s.catalog);
  const productId = useSatStore((s) => s.product);
  const hours = useSatStore((s) => s.hours);
  const frames = useSatStore((s) => s.frames);
  const index = useSatStore((s) => s.index);
  const stale = useSatStore((s) => s.stale);
  const busy = useSatStore((s) => s.busy);
  const loopLoaded = useSatStore((s) => s.loopLoaded);
  const loopTotal = useSatStore((s) => s.loopTotal);
  const loopArmed = useSatStore((s) => s.loopArmed);
  const error = useSatStore((s) => s.error);
  const setProduct = useSatStore((s) => s.setProduct);
  const setHours = useSatStore((s) => s.setHours);
  const setIndex = useSatStore((s) => s.setIndex);
  const product = useSatStore(selectSatProduct);
  const satellite = useSatStore(selectSatSatellite);
  const frame = useSatStore(selectSatFrame);

  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    void useSatStore.getState().load();
    const t = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const products = useMemo(
    () => (catalog?.products ?? []).filter((p) => p.sat === satellite?.id),
    [catalog, satellite],
  );
  const kinds = useMemo(() => {
    const byKind = new Map<string, SatProduct[]>();
    for (const p of products) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
    return [...byKind.entries()].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  }, [products]);

  // Changing satellite keeps the kind of picture where the new one has it:
  // IR on GOES-East to IR on Himawari, not to whatever happens to be first.
  const pickSatellite = (satId: string) => {
    const choices = (catalog?.products ?? []).filter((p) => p.sat === satId);
    if (!choices.length) return;
    const same = choices.find((p) => p.kind === product?.kind) ?? choices[0];
    setProduct(same.id);
  };

  const latest = frames.length ? frames[frames.length - 1].unix : null;
  const step = useMemo(() => stepLabel(frames.map((f) => f.unix)), [frames]);
  // nowCOAST keeps hours, not days: a week asked of it is the few hours it has.
  const kept = frames.length >= 2 ? (frames[frames.length - 1].unix - frames[0].unix) / 3600 : 0;
  const shortArchive = !product?.daily && frames.length >= 2 && hours >= 12 && kept < hours * 0.6;
  const span =
    frames.length >= 2 ? `${frames[0].label} → ${frames[frames.length - 1].label}` : frames[0]?.label ?? "—";

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
            <Loader2 size={13} className="sfx__status-spin" /> {frame.label} · loading loop {loopLoaded}/{loopTotal}
          </>
        ) : enabled && frame ? (
          <>
            {frame.label} · newest {ago(latest, now)}
          </>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Satellite</span>
          {satellite && <b>{satellite.region}</b>}
        </div>
        <Select
          value={satellite?.id ?? ""}
          onChange={pickSatellite}
          aria-label="Satellite"
          options={(catalog?.satellites ?? []).map((s) => ({
            value: s.id,
            label: s.label,
            // Only the cadence beside the name: the full detail squeezed the
            // name itself down to "GOES Ea…".
            hint: s.detail.split("·").pop()?.trim(),
            group: s.region,
          }))}
          placeholder="Satellite"
        />
        {satellite && (
          <div className="sfx__ends">
            <span>{satellite.detail}</span>
          </div>
        )}
        <div className="sfx__chips">
          <button
            type="button"
            className="sfx__chip"
            disabled={!satellite}
            onClick={() => satellite && getMap()?.flyTo({ center: satellite.view.center, zoom: satellite.view.zoom })}
          >
            <LocateFixed size={11} style={{ marginRight: 4, verticalAlign: "-1px" }} />
            Show its coverage
          </button>
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Product</span>
          <b>{products.length}</b>
        </div>
        <div className="obstree">
          <div className="obstree__body sattree">
            {kinds.map(([kind, list]) => (
              <div key={kind} className="obstree__sub">
                <div className="obstree__subname">{kind}</div>
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`obstree__item${p.id === productId ? " is-on" : ""}`}
                    aria-pressed={p.id === productId}
                    title={p.note || p.label}
                    onClick={() => setProduct(p.id)}
                  >
                    <span className="obstree__label">{p.label}</span>
                    {p.daily && <span className="obstree__where">daily</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {product?.note && (
          <div className="sfx__ends">
            <span>{product.note}</span>
          </div>
        )}
      </div>

      <div className={`sfx__block${product?.daily ? " is-dim" : ""}`}>
        <div className="sfx__head">
          <span>Loop</span>
          <b>
            {product?.daily ? "last 10 days" : spanLabel(hours)}
            {!product?.daily && step ? ` · every ${step}` : ""}
          </b>
        </div>
        <div className="sfx__chips">
          {LOOP_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              className={`sfx__chip${h === hours ? " is-on" : ""}`}
              aria-pressed={h === hours}
              disabled={product?.daily}
              onClick={() => setHours(h)}
            >
              {spanLabel(h)}
            </button>
          ))}
        </div>
        {stale ? (
          <div className="sfx__ends">
            <span>Nothing in the last {spanLabel(hours)} — showing the latest frames there are.</span>
          </div>
        ) : shortArchive ? (
          <div className="sfx__ends">
            <span>This source keeps only about the last {spanLabel(Math.max(1, Math.round(kept)))}.</span>
          </div>
        ) : null}
        {!product?.daily && (
          <div className="sfx__ends">
            <span>Press play to download the loop for the area on screen.</span>
          </div>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Frame</span>
          <b>{frames.length ? `${index + 1} / ${frames.length}` : "—"}</b>
        </div>
        <Select
          value={String(index)}
          onChange={(value) => setIndex(Number(value))}
          disabled={!frames.length}
          aria-label="Satellite frame"
          options={frames.map((f, i) => ({ value: String(i), label: f.label }))}
          placeholder="—"
        />
        <div className="sfx__ends">
          <span>{span}</span>
          <span>{frames.length} frames</span>
        </div>
      </div>

      <div className="sfx__block sfx__block--tight">
        <div className="mslp__note">
          Every frame is a step on the map timeline at the bottom, and the loop follows new images in
          as they arrive. Tiles come straight from the agencies: {product?.attribution ?? "NASA, NOAA and EUMETSAT"}.
        </div>
      </div>
    </div>
  );
}
