import { useAppStore } from "../store/useAppStore";
import { MapPane } from "./MapPane";
import { PRIMARY_PANE } from "./mapInstance";

/**
 * The map area. One pane is the normal case; split-screen tiles 2/4/6 panes,
 * each a full map with the whole layer stack. Every pane shares the camera and
 * the timeline -- only the radar product differs -- so the windows compare the
 * same moment side by side.
 *
 * The per-map lifecycle lives in MapPane; this component only decides how many
 * there are and how they're laid out.
 */
export function MapView() {
  const paneCount = useAppStore((s) => s.paneCount);
  const ids = Array.from({ length: paneCount }, (_, i) => (i === 0 ? PRIMARY_PANE : `pane-${i}`));

  return (
    <div className={`map-canvas map-canvas--panes-${paneCount}`}>
      {ids.map((id) => (
        <MapPane key={id} id={id} />
      ))}
    </div>
  );
}
