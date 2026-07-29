import { AlertTriangle, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { SATS, WINDOWS, useLightningStore } from "../../store/useLightningStore";
import { lagLabel } from "../../lib/lightning";
import { getActivePaneId } from "../../map/mapInstance";

const LAYER = "lightning";

/** Live GOES GLM lightning: the flash layer's controls. */
export function LightningView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const minutes = useLightningStore((s) => s.minutes);
  const sat = useLightningStore((s) => s.sat);
  const sizeByEnergy = useLightningStore((s) => s.sizeByEnergy);
  const counter = useLightningStore((s) => s.counter);
  const sync = useLightningStore((s) => s.sync);
  const followNewest = useLightningStore((s) => s.followNewest);
  const panes = useLightningStore((s) => s.panes);

  const busy = useLightningStore((s) => s.busy);
  const error = useLightningStore((s) => s.error);
  const count = useLightningStore((s) => s.count);
  const perMinute = useLightningStore((s) => s.perMinute);
  const newestUnix = useLightningStore((s) => s.newestUnix);
  const granules = useLightningStore((s) => s.granules);
  const satellites = useLightningStore((s) => s.satellites);

  const setMinutes = useLightningStore((s) => s.setMinutes);
  const setSat = useLightningStore((s) => s.setSat);
  const setSizeByEnergy = useLightningStore((s) => s.setSizeByEnergy);
  const setCounter = useLightningStore((s) => s.setCounter);
  const setSync = useLightningStore((s) => s.setSync);
  const setFollowNewest = useLightningStore((s) => s.setFollowNewest);
  const setPaneVisible = useLightningStore((s) => s.setPaneVisible);

  const activePane = getActivePaneId();
  const paneOn = !activePane || panes[activePane] !== false;
  // With sync off the switch owns the focused pane only, so it has to report
  // that pane's state rather than the layer's.
  const shown = sync ? enabled : enabled && paneOn;

  const toggle = () => {
    if (sync) {
      setLayerVisible(LAYER, !enabled);
      return;
    }
    // Unsynced: the layer stays on for the other panes; only this one flips.
    if (!enabled) {
      setLayerVisible(LAYER, true);
      if (activePane) setPaneVisible(activePane, true);
      return;
    }
    if (activePane) setPaneVisible(activePane, !paneOn);
    else setLayerVisible(LAYER, false);
  };

  return (
    <div className="sfx">
      <LayerPower label="Lightning strikes" on={shown} error={!!error} onToggle={toggle} />

      <div className={`sfx__status${error ? " is-error" : ""}`}>
        {busy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Decoding GLM granules…
          </>
        ) : error ? (
          <>
            <AlertTriangle size={13} /> {error}
          </>
        ) : enabled && count > 0 ? (
          <>
            {count.toLocaleString()} flashes · {perMinute.toLocaleString()}/min · {lagLabel(newestUnix)} behind
          </>
        ) : (
          <>Ready</>
        )}
      </div>

      {enabled && count > 0 && !error && (
        <div className="sfx__block sfx__block--tight">
          <div className="mslp__meta">
            <div>
              <span>Source</span>
              <b>{satellites.join(" + ") || "GLM"}</b>
            </div>
            <div>
              <span>Granules</span>
              <b>{granules}</b>
            </div>
          </div>
        </div>
      )}

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Trailing window</span>
          <b>{minutes} min</b>
        </div>
        <div className="sfx__chips">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`sfx__chip${w === minutes ? " is-on" : ""}`}
              aria-pressed={w === minutes}
              onClick={() => setMinutes(w)}
            >
              {w} min
            </button>
          ))}
        </div>
        <div className="sfx__ends">
          <span>Just now</span>
          <span>Slow first load</span>
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Coverage</span>
        </div>
        <div className="sfx__presets">
          {SATS.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.hint}
              className={`sfx__preset${s.id === sat ? " is-on" : ""}`}
              onClick={() => setSat(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Display</span>
        </div>
        <div className="sfx__chips">
          <button
            type="button"
            className={`sfx__chip${counter ? " is-on" : ""}`}
            aria-pressed={counter}
            onClick={() => setCounter(!counter)}
          >
            Counter on map
          </button>
          <button
            type="button"
            className={`sfx__chip${sizeByEnergy ? " is-on" : ""}`}
            aria-pressed={sizeByEnergy}
            onClick={() => setSizeByEnergy(!sizeByEnergy)}
          >
            Size by energy
          </button>
          <button
            type="button"
            className={`sfx__chip${followNewest ? " is-on" : ""}`}
            aria-pressed={followNewest}
            onClick={() => setFollowNewest(!followNewest)}
          >
            Follow newest
          </button>
          <button
            type="button"
            className={`sfx__chip${sync ? " is-on" : ""}`}
            aria-pressed={sync}
            onClick={() => setSync(!sync)}
          >
            Sync panels
          </button>
        </div>
        <div className="lit__legend">
          <span>Age</span>
          <div className="lit__ramp" />
          <i>now</i>
          <b>{minutes} min</b>
        </div>
        <div className="mslp__note">
          {sync
            ? "Switching lightning on or off applies to every panel."
            : "Only the focused panel changes; the others keep what they have."}
        </div>
      </div>
    </div>
  );
}
