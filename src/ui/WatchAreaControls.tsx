import { Bell, BellOff, Crosshair, Target, X } from "lucide-react";

import { getMap } from "../map/mapInstance";
import { useWatchStore } from "../store/useWatchStore";

const RADII = [50, 100, 150, 250, 400];

/** Set, size and arm the watch area. Lives at the top of the alert rail. */
export function WatchAreaControls() {
  const enabled = useWatchStore((s) => s.enabled);
  const center = useWatchStore((s) => s.center);
  const radiusKm = useWatchStore((s) => s.radiusKm);
  const notify = useWatchStore((s) => s.notify);
  const picking = useWatchStore((s) => s.picking);
  const setEnabled = useWatchStore((s) => s.setEnabled);
  const setCenter = useWatchStore((s) => s.setCenter);
  const setRadiusKm = useWatchStore((s) => s.setRadiusKm);
  const setNotify = useWatchStore((s) => s.setNotify);
  const setPicking = useWatchStore((s) => s.setPicking);

  const useMapCentre = () => {
    const c = getMap()?.getCenter();
    if (c) setCenter([c.lng, c.lat]);
  };

  return (
    <section className={`watch${enabled && center ? " is-on" : ""}`}>
      <header className="watch__head">
        <Target size={12} />
        <span>Watch area</span>
        {center && (
          <button
            type="button"
            className="watch__toggle"
            aria-pressed={enabled}
            onClick={() => setEnabled(!enabled)}
          >
            {enabled ? "ON" : "OFF"}
          </button>
        )}
      </header>

      {!center ? (
        <div className="watch__setup">
          <p>Pick a spot and you will be told when severe weather moves into it.</p>
          <div className="watch__row">
            <button type="button" className="watch__btn" onClick={() => setPicking(!picking)}>
              <Crosshair size={12} /> {picking ? "Click the map…" : "Pick on map"}
            </button>
            <button type="button" className="watch__btn" onClick={useMapCentre}>
              Use current view
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="watch__where">
            <span className="watch__coord">
              {center[1].toFixed(2)}°, {center[0].toFixed(2)}°
            </span>
            <button
              type="button"
              className="watch__icon"
              title={picking ? "Cancel picking" : "Move the centre"}
              onClick={() => setPicking(!picking)}
            >
              <Crosshair size={12} />
            </button>
            <button
              type="button"
              className="watch__icon"
              title="Clear the watch area"
              onClick={() => {
                setCenter(null);
                setEnabled(false);
              }}
            >
              <X size={12} />
            </button>
          </div>

          <div className="watch__radii" role="group" aria-label="Radius">
            {RADII.map((r) => (
              <button
                key={r}
                type="button"
                className={`watch__radius${radiusKm === r ? " is-on" : ""}`}
                onClick={() => setRadiusKm(r)}
              >
                {r}km
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`watch__notify${notify ? " is-on" : ""}`}
            aria-pressed={notify}
            onClick={() => setNotify(!notify)}
          >
            {notify ? <Bell size={12} /> : <BellOff size={12} />}
            {notify ? "Desktop alerts on" : "Desktop alerts off"}
          </button>
        </>
      )}
    </section>
  );
}
