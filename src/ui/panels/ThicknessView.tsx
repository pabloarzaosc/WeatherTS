import { AlertTriangle, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { THICK_DIVIDER, THICK_INTERVALS, useThicknessStore } from "../../store/useThicknessStore";
import { selectCurrentModel, useModelStore } from "../../store/useModelStore";

const LAYER = "thickness";

/** 1000-500 hPa thickness: the dashed lines that go over the isobars. */
export function ThicknessView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const model = useModelStore(selectCurrentModel);

  const interval = useThicknessStore((s) => s.interval);
  const labels = useThicknessStore((s) => s.labels);
  const lineWidth = useThicknessStore((s) => s.lineWidth);
  const busy = useThicknessStore((s) => s.busy);
  const error = useThicknessStore((s) => s.error);
  const run = useThicknessStore((s) => s.run);
  const counts = useThicknessStore((s) => s.counts);

  const setInterval = useThicknessStore((s) => s.setInterval);
  const setLabels = useThicknessStore((s) => s.setLabels);
  const setLineWidth = useThicknessStore((s) => s.setLineWidth);

  // A model that publishes no 500 or 1000 hPa height cannot draw this at all.
  const unsupported = model !== null && model.thickness === false;

  return (
    <div className="sfx">
      <LayerPower
        label="1000–500 hPa thickness"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      <div className={`sfx__status${error || unsupported ? " is-error" : ""}`}>
        {unsupported ? (
          <>
            <AlertTriangle size={13} /> {model?.label} does not publish the two heights this needs
          </>
        ) : busy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Contouring {model?.label ?? "model"}…
          </>
        ) : error ? (
          <>
            <AlertTriangle size={13} /> {error}
          </>
        ) : enabled && run ? (
          <>{counts.lines} lines</>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Line interval</span>
          <b>{interval} dam</b>
        </div>
        <div className="sfx__chips">
          {THICK_INTERVALS.map((v) => (
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
          <span>Draw</span>
        </div>
        <div className="sfx__chips">
          <button
            type="button"
            className={`sfx__chip${labels ? " is-on" : ""}`}
            aria-pressed={labels}
            onClick={() => setLabels(!labels)}
          >
            Values on the lines
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
          How deep the air between 1000 and 500 hPa is, which is the same as how warm it is on
          average: blue below {THICK_DIVIDER} dam, red above. The {THICK_DIVIDER} dam line is drawn
          heavier — it is the rough divide between rain and snow, and the reason forecasters put
          this field over the isobars.
        </div>
      </div>
    </div>
  );
}
