import { AlertTriangle, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { INTERVALS, SMOOTHING, useMslpStore } from "../../store/useMslpStore";
import { selectCurrentModel, useModelStore } from "../../store/useModelStore";

const LAYER = "mslp";

/** Mean sea level pressure: isobars and the H/L centres. */
export function PressureView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const model = useModelStore(selectCurrentModel);
  const hour = useModelStore((s) => s.hour);

  const interval = useMslpStore((s) => s.interval);
  const centres = useMslpStore((s) => s.centres);
  const labels = useMslpStore((s) => s.labels);
  const lineWidth = useMslpStore((s) => s.lineWidth);
  const smoothing = useMslpStore((s) => s.smoothing);
  const busy = useMslpStore((s) => s.busy);
  const error = useMslpStore((s) => s.error);
  const run = useMslpStore((s) => s.run);
  const valid = useMslpStore((s) => s.valid);
  const counts = useMslpStore((s) => s.counts);

  const setInterval = useMslpStore((s) => s.setInterval);
  const setCentres = useMslpStore((s) => s.setCentres);
  const setLabels = useMslpStore((s) => s.setLabels);
  const setLineWidth = useMslpStore((s) => s.setLineWidth);
  const setSmoothing = useMslpStore((s) => s.setSmoothing);

  return (
    <div className="sfx">
      <LayerPower
        label="Mean sea level pressure"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      <div className={`sfx__status${error ? " is-error" : ""}`}>
        {busy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Contouring {model?.label ?? "model"}…
          </>
        ) : error ? (
          <>
            <AlertTriangle size={13} /> {error}
          </>
        ) : enabled && run ? (
          <>
            {counts.isobars} isobars · {counts.centres} centres
          </>
        ) : (
          <>Ready</>
        )}
      </div>

      {enabled && run && !error && (
        <div className="sfx__block sfx__block--tight">
          <div className="mslp__meta">
            <div>
              <span>Init</span>
              <b>{run}</b>
            </div>
            <div>
              <span>Valid</span>
              <b>{valid}</b>
            </div>
            <div>
              <span>Hour</span>
              <b>F{String(hour).padStart(3, "0")}</b>
            </div>
          </div>
        </div>
      )}

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Isobar interval</span>
          <b>{interval} hPa</b>
        </div>
        <div className="sfx__chips">
          {INTERVALS.map((v) => (
            <button
              key={v}
              type="button"
              className={`sfx__chip${v === interval ? " is-on" : ""}`}
              aria-pressed={v === interval}
              onClick={() => setInterval(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="sfx__ends">
          <span>Detailed</span>
          <span>Broad</span>
        </div>

        <div className="sfx__head sfx__head--sub">
          <span>Detail</span>
          <b>{SMOOTHING.find((s) => s.value === smoothing)?.label ?? `${smoothing}×`}</b>
        </div>
        <div className="sfx__chips">
          {SMOOTHING.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`sfx__chip${s.value === smoothing ? " is-on" : ""}`}
              aria-pressed={s.value === smoothing}
              onClick={() => setSmoothing(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="sfx__ends">
          <span>Every wave kept</span>
          <span>Analysis-clean</span>
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Draw</span>
        </div>
        <div className="sfx__chips">
          <button
            type="button"
            className={`sfx__chip${centres ? " is-on" : ""}`}
            aria-pressed={centres}
            onClick={() => setCentres(!centres)}
          >
            H / L centres
          </button>
          <button
            type="button"
            className={`sfx__chip${labels ? " is-on" : ""}`}
            aria-pressed={labels}
            onClick={() => setLabels(!labels)}
          >
            Isobar values
          </button>
        </div>

        <div className="sfx__head sfx__head--sub">
          <span>Line weight</span>
          <b>{lineWidth.toFixed(1)}&times;</b>
        </div>
        <input
          className="sfx__range"
          type="range"
          min={0.6}
          max={2}
          step={0.1}
          value={lineWidth}
          onChange={(e) => setLineWidth(Number(e.target.value))}
        />
        <div className="sfx__ends">
          <span>Fine</span>
          <span>Heavy</span>
        </div>
      </div>

      <div className="sfx__block sfx__block--tight">
        <div className="mslp__note">
          The model is chosen in the sidebar picker above; the forecast hour is scrubbed on the map
          timeline at the bottom, next to radar and soundings. Both drive every model product, not
          just this one.
        </div>
      </div>
    </div>
  );
}
