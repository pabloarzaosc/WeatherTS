import { useAppStore } from "../store/useAppStore";
import { useMslpStore } from "../store/useMslpStore";
import { selectCurrentModel, useModelStore } from "../store/useModelStore";

/**
 * The corner stamp that says what is drawn over the map. Exists so the chart
 * still identifies itself with the sidebar closed -- and because a pressure
 * analysis with no units on it is just a pile of lines.
 */
export function MslpLegend() {
  const on = useAppStore((s) => s.layers["mslp"]?.visible ?? false);
  const interval = useMslpStore((s) => s.interval);
  const run = useMslpStore((s) => s.run);
  const valid = useMslpStore((s) => s.valid);
  const error = useMslpStore((s) => s.error);
  const model = useModelStore(selectCurrentModel);
  const hour = useModelStore((s) => s.hour);

  if (!on || error) return null;

  return (
    <div className="mslp-legend">
      <div className="mslp-legend__times">
        {run && <span>{model?.label ?? "Model"} init: {run}</span>}
        {valid && (
          <span>
            Valid: {valid} F{String(hour).padStart(3, "0")}
          </span>
        )}
      </div>
      <div className="mslp-legend__tag">
        MSLP (hPa) <b>[line]</b> <i>every {interval}</i>
      </div>
    </div>
  );
}
