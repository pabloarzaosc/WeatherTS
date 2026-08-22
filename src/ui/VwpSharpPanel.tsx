import { useState } from "react";
import { AlertTriangle, Loader2, Maximize2, Minimize2 } from "lucide-react";

import { useVwpStore, VWP_MOTION_LABELS, type VwpMotion } from "../store/useVwpStore";

/**
 * The VWP hodograph panel, drawn by the backend.
 *
 * This is one image on purpose. Every number on it -- shear, helicity, the
 * storm-relative wind, Bunkers, Corfidi, EHI, the critical angle -- comes out
 * of SHARPpy's own sharptab on the profile the radar measured, so the panel is
 * rendered where those routines live rather than re-derived in the browser and
 * left to drift from them.
 *
 * The storm motion is the one control that matters: it is the vector every
 * storm-relative quantity on the panel is measured against, so changing it
 * re-renders the whole thing.
 */
export function VwpSharpPanel() {
  const panel = useVwpStore((s) => s.panel);
  const busy = useVwpStore((s) => s.panelBusy);
  const error = useVwpStore((s) => s.panelError);
  const motion = useVwpStore((s) => s.motion);
  const setMotion = useVwpStore((s) => s.setMotion);
  const customDir = useVwpStore((s) => s.customDir);
  const customSpd = useVwpStore((s) => s.customSpd);
  const setCustomMotion = useVwpStore((s) => s.setCustomMotion);
  const [zoom, setZoom] = useState(false);

  return (
    <div className={`vsp${zoom ? " is-zoom" : ""}`}>
      <div className="vsp__bar">
        <span className="vsp__lead">Storm motion</span>
        {(Object.keys(VWP_MOTION_LABELS) as VwpMotion[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`vsp__chip${motion === m ? " is-active" : ""}`}
            onClick={() => setMotion(m)}
            aria-pressed={motion === m}
          >
            {VWP_MOTION_LABELS[m]}
          </button>
        ))}
        {motion === "custom" && (
          <span className="vsp__custom">
            <label>
              dir
              <input
                type="number"
                min={0}
                max={360}
                value={customDir}
                onChange={(e) => setCustomMotion(Number(e.target.value), customSpd)}
              />
            </label>
            <label>
              kt
              <input
                type="number"
                min={0}
                max={200}
                value={customSpd}
                onChange={(e) => setCustomMotion(customDir, Number(e.target.value))}
              />
            </label>
          </span>
        )}
        <span className="vsp__spacer" />
        {busy && <Loader2 size={13} className="spin" />}
        <button
          type="button"
          className="vsp__icon"
          onClick={() => setZoom((v) => !v)}
          title={zoom ? "Fit to panel" : "Full size"}
        >
          {zoom ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>

      {error && (
        <div className="vwp__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && !panel && (
        <div className="vwp__empty">
          {busy ? (
            <>
              <Loader2 size={18} className="spin" />
              <span>Building the hodograph…</span>
            </>
          ) : (
            <span>No VAD to plot.</span>
          )}
        </div>
      )}

      {panel && (
        <div className="vsp__imgwrap">
          <img
            className="vsp__img"
            src={`data:image/png;base64,${panel.image}`}
            alt={`VWP hodograph for ${panel.meta.site}`}
          />
        </div>
      )}
    </div>
  );
}
