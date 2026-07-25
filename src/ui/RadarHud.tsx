import { useAppStore } from "../store/useAppStore";
import { RadarProductPanel } from "./RadarProductPanel";

// The on-map radar chrome. The colour scale lives inside each pane (see
// MapPane), so all that's left here is the product/tilt picker, top-right.
// Only mounted while the radar layer is on.

export function RadarHud() {
  const on = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  if (!on) return null;
  return <RadarProductPanel />;
}
