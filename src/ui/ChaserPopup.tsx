import { useEffect, useState } from "react";
import { Crosshair, ExternalLink, Navigation, Star, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { isStale } from "../lib/chasers";
import { useChaserStore } from "../store/useChaserStore";
import { ROLE_COLOR, ROLE_LABEL } from "../lib/auth";

/** "just now" / "4 min ago" — how current the position on screen actually is. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round((deg % 360) / 22.5) % 16];

/**
 * The card for a clicked chaser: who they are, how fast and which way, and how
 * fresh the reading is.
 *
 * Anchored by projecting to screen pixels on every map move, with the canvas
 * offset added — project() is relative to the map canvas while this is
 * positioned against the viewport.
 */
export function ChaserPopup() {
  const selectedId = useChaserStore((s) => s.selectedId);
  const select = useChaserStore((s) => s.select);
  const chasers = useChaserStore((s) => s.chasers);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const chaser = chasers.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!chaser) {
      setPos(null);
      return;
    }
    let map = getMap();
    const update = () => {
      map = getMap();
      if (!map) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const p = map.project([chaser.lon, chaser.lat]);
      setPos({ x: p.x + rect.left, y: p.y + rect.top });
    };
    update();
    const bind = (m: ReturnType<typeof getMap>) => {
      m?.on("move", update);
      m?.on("resize", update);
      return () => {
        m?.off("move", update);
        m?.off("resize", update);
      };
    };
    let unbind = bind(map);
    const unsubPanes = subscribeMaps(() => {
      unbind();
      unbind = bind(getMap());
      update();
    });
    return () => {
      unbind();
      unsubPanes();
    };
  }, [chaser]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, select]);

  if (!chaser || !pos) return null;

  const W = 208;
  const H = chaser.streamUrl ? 176 : 140;
  const left = Math.max(8, Math.min(pos.x + 12, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(pos.y - H / 2, window.innerHeight - H - 8));
  const stale = isStale(chaser);

  // Anything worse than a kilometre did not come from a GPS. The threshold is
  // deliberately generous: a poor device fix in a city is still a device fix.
  const coarse = chaser.accuracyM != null && chaser.accuracyM > 1000;

  return (
    <div className={`chpop${chaser.official ? " is-official" : ""}`} style={{ left, top, width: W }}>
      <header className="chpop__head">
        {/* The same picture the marker carries, and from the same place: the
            profile row, not the broadcast. */}
        {chaser.avatarUrl && <img className="chpop__face" src={chaser.avatarUrl} alt="" />}
        <b>
          {chaser.official && <Star size={11} />} {chaser.name}
        </b>
        <button type="button" onClick={() => select(null)} title="Close" aria-label="Close">
          <X size={13} />
        </button>
      </header>

      {chaser.role !== "member" && (
        <div className="chpop__badge" style={{ color: ROLE_COLOR[chaser.role] }}>
          {ROLE_LABEL[chaser.role]}
        </div>
      )}

      <div className="chpop__motion">
        <Navigation
          size={14}
          style={{ transform: `rotate(${chaser.heading ?? 0}deg)`, opacity: chaser.heading == null ? 0.35 : 1 }}
        />
        <span>
          {chaser.heading != null && (chaser.speedMph ?? 0) >= 3
            ? `${compass(chaser.heading)} at ${chaser.speedMph} mph`
            : "Stopped"}
        </span>
      </div>

      <dl className="chpop__rows">
        <dt>Position</dt>
        <dd>
          {/* Three decimals is about a hundred metres, which is the right
              precision for a GPS fix and the wrong precision for the IP
              fallback a device without one falls back to. Printing a city as
              though it were a street corner is the kind of wrong that looks
              exactly like being right, so a coarse fix is rounded to match
              what it actually knows and says how far off it may be. */}
          {coarse
            ? `${chaser.lat.toFixed(1)}, ${chaser.lon.toFixed(1)} ±${Math.round(
                (chaser.accuracyM ?? 0) / 1000,
              )} km`
            : `${chaser.lat.toFixed(3)}, ${chaser.lon.toFixed(3)}`}
        </dd>
        <dt>Updated</dt>
        <dd className={stale ? "is-stale" : undefined}>{ago(chaser.at)}</dd>
      </dl>

      <div className="chpop__acts">
        <button
          type="button"
          className="chpop__act"
          onClick={() => getMap()?.flyTo({ center: [chaser.lon, chaser.lat], zoom: 9, essential: true })}
        >
          <Crosshair size={12} /> Center
        </button>
        {/* Only an official can have a stream: the URL comes from the roster,
            which nothing in the client can write. It opens externally rather
            than embedding — there is no player in the app yet. */}
        {chaser.streamUrl && (
          <a
            className="chpop__act chpop__act--live"
            href={chaser.streamUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={12} /> Watch live
          </a>
        )}
      </div>
    </div>
  );
}
