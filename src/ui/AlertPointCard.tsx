import { useEffect, useMemo, useState } from "react";
import { Navigation, Radar, X } from "lucide-react";

import { useAlertListStore } from "../store/useAlertListStore";
import { useAlertStore } from "../store/useAlertStore";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { getMap, subscribeMaps } from "../map/mapInstance";
import { haversine, formatDistance } from "../lib/measure";
import { alertBounds, type AlertFeature } from "../lib/nwsAlerts";
import { alertDrawColor, motionOf, tierOf } from "../lib/alertStyle";
import { alertWfo, motionText } from "../lib/alertTiers";
import { agePhrase, alertTags, compareAlerts, expiryPhrase } from "../lib/alertGroups";
import { OfficeLink } from "./ForecastOfficePanel";

/**
 * Click inside alert polygons: every alert drawn at that point, worst first,
 * with its age, time to expiry, hail / wind / tornado tags, tier and storm
 * motion, and the two radars nearest the point to switch to. A row opens the
 * full text in the alert rail. Anchored to the point like the detection card.
 */

const FILL = "alerts-fill";
const W = 300;

export function AlertPointCard() {
  const point = useAlertListStore((s) => s.point);
  const openPoint = useAlertListStore((s) => s.openPoint);
  const features = useAlertStore((s) => s.features);
  const timeFilter = useAlertStore((s) => s.timeFilter);
  const sites = useNexradStore((s) => s.sites);
  const activeSite = useNexradStore((s) => s.site);
  const selectSite = useNexradStore((s) => s.selectSite);
  const loadCatalog = useNexradStore((s) => s.loadCatalog);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [, setTick] = useState(0);

  const lon = point?.lon;
  const lat = point?.lat;

  useEffect(() => {
    if (lon === undefined || lat === undefined) {
      setPos(null);
      return;
    }
    void loadCatalog();
    const update = () => {
      const map = getMap();
      if (!map) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const q = map.project([lon, lat]);
      setPos({ x: q.x + rect.left, y: q.y + rect.top });
    };
    // A click on the map outside every alert closes the card.
    const onMapClick = (e: { point: { x: number; y: number } }) => {
      const m = getMap();
      if (!m || !m.getLayer(FILL)) return openPoint(null);
      if (m.queryRenderedFeatures([e.point.x, e.point.y], { layers: [FILL] }).length === 0) openPoint(null);
    };
    const bind = () => {
      const m = getMap();
      m?.on("move", update);
      m?.on("resize", update);
      m?.on("click", onMapClick);
      return () => {
        m?.off("move", update);
        m?.off("resize", update);
        m?.off("click", onMapClick);
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
      if (e.key === "Escape") openPoint(null);
    };
    window.addEventListener("keydown", onKey);
    // ages and countdowns move with the clock
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      unbind();
      unsubPanes();
      window.removeEventListener("keydown", onKey);
      window.clearInterval(t);
    };
  }, [lon, lat, openPoint, loadCatalog]);

  const list = useMemo(() => {
    if (!point) return [] as AlertFeature[];
    const want = new Set(point.ids);
    return features.filter((f) => want.has(f.alert.id)).sort((a, b) => compareAlerts(a.alert, b.alert));
  }, [point, features]);

  const radars = useMemo(() => {
    if (lon === undefined || lat === undefined) return [];
    return sites
      .filter((s) => s.online !== false && s.type !== "TDWR" && Number.isFinite(s.lat) && Number.isFinite(s.lon) && !String(s.id).startsWith("BR"))
      .map((s) => ({ s, m: haversine([lon, lat], [s.lon, s.lat]) }))
      .sort((a, b) => a.m - b.m)
      .slice(0, 2);
  }, [sites, lon, lat]);

  if (!point || !pos) return null;
  if (!list.length) return null;

  const now = timeFilter !== null ? timeFilter * 1000 : Date.now();
  const GAP = 14;
  const flip = pos.x + GAP + W > window.innerWidth - 8;
  const left = Math.max(8, flip ? pos.x - GAP - W : pos.x + GAP);
  // near the point, but always room for a row and the radars
  const top = Math.max(8, Math.min(pos.y - 30, window.innerHeight - 300));
  const H = window.innerHeight - top - 8;

  const openOne = (id: string) => {
    useAlertStore.getState().selectMany([id]);
    openPoint(null);
  };
  const focus = (f: AlertFeature) => {
    const b = alertBounds(f.geometry);
    const map = getMap();
    if (map && b) map.fitBounds(b, { padding: 64, maxZoom: 10.5, duration: 700, essential: true });
  };
  const chooseRadar = (id: string) => {
    setLayerVisible("nexrad", true);
    selectSite(id);
  };

  return (
    <div className="alpt" style={{ left, top, width: W, maxHeight: H }} role="dialog" aria-label="Alerts at this point">
      <header className="alpt__head">
        <b>
          {list.length} alert{list.length === 1 ? "" : "s"} here
        </b>
        <span>
          {Math.abs(point.lat).toFixed(2)}°{point.lat >= 0 ? "N" : "S"} {Math.abs(point.lon).toFixed(2)}°{point.lon >= 0 ? "E" : "W"}
        </span>
        <button type="button" onClick={() => openPoint(null)} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <div className="alpt__list">
        {list.map((f) => {
          const a = f.alert;
          const color = alertDrawColor(a);
          const tier = tierOf(a);
          const tags = alertTags(a);
          const motion = motionOf(a);
          return (
            <div key={a.id} className="alpt__row" style={{ ["--al" as string]: color }}>
              <button type="button" className="alpt__main" onClick={() => openOne(a.id)} title="Full text in the alert panel">
                <span className="alpt__top">
                  <b>{a.event}</b>
                  {tier && (
                    <span className="al-tierchip" style={{ ["--chip" as string]: color }} title={tier.hint}>
                      {tier.label}
                    </span>
                  )}
                </span>
                <span className="alpt__times">
                  {agePhrase(a, now)} · {expiryPhrase(a, now)}
                </span>
                {tags.length > 0 && (
                  <span className="alpt__tags">
                    {tags.map((t) => (
                      <span key={t.key} className={`alpt__tag${t.hot ? " is-hot" : ""}`}>
                        {t.text}
                      </span>
                    ))}
                  </span>
                )}
                {motion && motion.kt > 0 && (
                  <span className="alpt__motion">
                    <Navigation size={11} style={{ transform: `rotate(${motion.towardDeg - 45}deg)` }} /> {motionText(motion)}
                  </span>
                )}
              </button>
              <div className="alpt__foot">
                <OfficeLink wfo={alertWfo(a)} className="wfo-link" />
                <button type="button" className="wfo-link" onClick={() => focus(f)}>
                  Focus on map
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {radars.length > 0 && (
        <footer className="alpt__radars">
          <span className="alpt__label">
            <Radar size={12} /> Nearest radars
          </span>
          <div className="al-radars">
          {radars.map(({ s, m }) => (
            <button
              key={s.id}
              type="button"
              className={`al-radar${activeSite === s.id ? " is-active" : ""}`}
              onClick={() => chooseRadar(s.id)}
              title={`Load ${s.icao} (${s.name})`}
            >
              <span className="al-radar__icao">{s.icao}</span>
              <span className="al-radar__name">{s.name}</span>
              <span className="al-radar__dist">{formatDistance(m, "imperial")}</span>
            </button>
          ))}
          </div>
        </footer>
      )}
      {list.length > 1 && (
        <button type="button" className="alpt__all" onClick={() => (useAlertStore.getState().selectMany(list.map((f) => f.alert.id)), openPoint(null))}>
          Open all {list.length} in the alert panel
        </button>
      )}
    </div>
  );
}
