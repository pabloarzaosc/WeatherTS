import { useAppStore } from "../../store/useAppStore";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";
import {
  PARCELS,
  PARCEL_LABELS,
  STORM_MOTIONS,
  STORM_MOTION_LABELS,
  useSoundingViewStore,
  type Parcel,
  type StormMotion,
} from "../../store/useSoundingViewStore";

/**
 * Parcel and storm-motion controls for the open sounding.
 *
 * These are re-renders, not client-side toggles: the plot is SHARPpy's own
 * SPCWidget rendered server-side, so every change here is a fetch. Each one is
 * cached per setting on the server, so going back to a parcel you already
 * looked at is instant.
 */
export function SoundingPlotOptions() {
  const parcel = useSoundingViewStore((s) => s.parcel);
  const setParcel = useSoundingViewStore((s) => s.setParcel);
  const parcelPressure = useSoundingViewStore((s) => s.parcelPressure);
  const setParcelPressure = useSoundingViewStore((s) => s.setParcelPressure);
  const motion = useSoundingViewStore((s) => s.motion);
  const setMotion = useSoundingViewStore((s) => s.setMotion);
  const motionDir = useSoundingViewStore((s) => s.motionDir);
  const setMotionDir = useSoundingViewStore((s) => s.setMotionDir);
  const motionSpd = useSoundingViewStore((s) => s.motionSpd);
  const setMotionSpd = useSoundingViewStore((s) => s.setMotionSpd);
  const reset = useSoundingViewStore((s) => s.reset);

  const raobOn = useAppStore((s) => s.layers.raob?.visible ?? false);
  const acarsOn = useAppStore((s) => s.layers.acars?.visible ?? false);
  const vwpOn = useAppStore((s) => s.layers.vwp?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const open = useSoundingViewerStore((s) => s.open);
  const load = useSoundingViewerStore((s) => s.load);
  const busy = useSoundingViewerStore((s) => s.busy);

  // The viewer holds one rendered image; changing an option means asking for a
  // new one. Nothing to redraw when no sounding is open -- the setting is still
  // kept, and applies to the next sounding opened.
  const apply = (fn: () => void) => {
    fn();
    if (open) void load();
  };

  return (
    <>
      {/* The launch sites belong next to the sounding controls, not buried in
          the layer list: picking a station on the map is how you open one. */}
      <section className="snd-section">
        <div className="snd-labelrow">
          <span>Show on map</span>
        </div>
        <div className="snd-parcels">
          <button
            type="button"
            className={`snd-chip${raobOn ? " is-active" : ""}`}
            onClick={() => setLayerVisible("raob", !raobOn)}
            aria-pressed={raobOn}
            title="Upper-air radiosonde launch sites — click a dot for its observed sounding"
          >
            RAOB stations
          </button>
          <button
            type="button"
            className={`snd-chip${acarsOn ? " is-active" : ""}`}
            onClick={() => setLayerVisible("acars", !acarsOn)}
            aria-pressed={acarsOn}
            title="Airports with a recent aircraft ascent — click a dot for its profile"
          >
            ACARS airports
          </button>
          <button
            type="button"
            className={`snd-chip${vwpOn ? " is-active" : ""}`}
            onClick={() => setLayerVisible("vwp", !vwpOn)}
            aria-pressed={vwpOn}
            title="Radars as wind profiles — click a dot for its VAD winds on model thermodynamics"
          >
            VAD radars
          </button>
        </div>
      </section>

      <section className="snd-section">
        <div className="snd-labelrow">
          <span>Parcel</span>
          <button type="button" className="snd-star" onClick={() => apply(reset)} title="Back to defaults">
            reset
          </button>
        </div>
        {/* Without this the chips look broken: they DO take effect, but with no
            sounding open there is no image to redraw, so nothing moves. */}
        {!open && (
          <p className="snd-note">
            Applies to the next sounding you open — right-click the map, or click
            a station dot.
          </p>
        )}
        <div className="snd-parcels">
          {PARCELS.map((p) => (
            <button
              key={p}
              type="button"
              className={`snd-chip${parcel === p ? " is-active" : ""}`}
              onClick={() => apply(() => setParcel(p as Parcel))}
              aria-pressed={parcel === p}
            >
              {PARCEL_LABELS[p]}
            </button>
          ))}
        </div>
        {parcel === "USER" && (
          <label className="snd-inputlabel">
            Parcel pressure (mb)
            <input
              type="number"
              min={100}
              max={1100}
              value={parcelPressure}
              onChange={(e) => setParcelPressure(Number(e.target.value))}
              onBlur={() => apply(() => {})}
            />
          </label>
        )}
      </section>

      <section className="snd-section">
        <div className="snd-labelrow">
          <span>Storm motion</span>
          {busy && <span style={{ color: "var(--text-faint)", fontSize: 10 }}>rendering…</span>}
        </div>
        <div className="snd-parcels">
          {STORM_MOTIONS.map((m) => (
            <button
              key={m}
              type="button"
              className={`snd-chip${motion === m ? " is-active" : ""}`}
              onClick={() => apply(() => setMotion(m as StormMotion))}
              aria-pressed={motion === m}
            >
              {STORM_MOTION_LABELS[m]}
            </button>
          ))}
        </div>
        {motion === "custom" && (
          <div className="snd-row2">
            <label className="snd-inputlabel">
              Direction (°)
              <input
                type="number"
                value={motionDir}
                onChange={(e) => setMotionDir(Number(e.target.value))}
                onBlur={() => apply(() => {})}
              />
            </label>
            <label className="snd-inputlabel">
              Speed (kt)
              <input
                type="number"
                min={0}
                value={motionSpd}
                onChange={(e) => setMotionSpd(Number(e.target.value))}
                onBlur={() => apply(() => {})}
              />
            </label>
          </div>
        )}
      </section>
    </>
  );
}
