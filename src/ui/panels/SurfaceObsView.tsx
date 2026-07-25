import { useAppStore } from "../../store/useAppStore";
import {
  useSurfaceObsStore,
  type SurfaceDisplayMode,
  type StationElements,
} from "../../store/useSurfaceObsStore";

const LAYER = "surfobs";

const MODES: { id: SurfaceDisplayMode; label: string }[] = [
  { id: "station", label: "Station Plots" },
  { id: "temp", label: "Temperature" },
  { id: "dewp", label: "Dewpoint" },
  { id: "wspd", label: "Wind Speed" },
  { id: "wgst", label: "Wind Gust" },
  { id: "altim", label: "Pressure" },
  { id: "visib", label: "Visibility" },
  { id: "rh", label: "Relative Humidity" },
  { id: "thetae", label: "Theta-e" },
  { id: "id", label: "Station Name" },
];

const ELEMENTS: { key: keyof StationElements; label: string }[] = [
  { key: "wind", label: "Wind barbs" },
  { key: "gust", label: "Gust on barb" },
  { key: "sky", label: "Sky cover" },
  { key: "calm", label: "Calm-wind ring" },
  { key: "temp", label: "Temperature" },
  { key: "dewp", label: "Dewpoint" },
  { key: "visibility", label: "Visibility" },
  { key: "pressure", label: "Pressure" },
  { key: "stationName", label: "Station name" },
];

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`sfc-switch${on ? " is-on" : ""}`}
      onClick={onClick}
      role="switch"
      aria-checked={on}
    >
      <span className="sfc-switch__knob" />
    </button>
  );
}

/** Surface Obs control panel — real METAR station plots. */
export function SurfaceObsView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const displayMode = useSurfaceObsStore((s) => s.displayMode);
  const elements = useSurfaceObsStore((s) => s.elements);
  const spacing = useSurfaceObsStore((s) => s.spacing);
  const size = useSurfaceObsStore((s) => s.size);
  const units = useSurfaceObsStore((s) => s.units);
  const setDisplayMode = useSurfaceObsStore((s) => s.setDisplayMode);
  const toggleElement = useSurfaceObsStore((s) => s.toggleElement);
  const setSpacing = useSurfaceObsStore((s) => s.setSpacing);
  const setSize = useSurfaceObsStore((s) => s.setSize);
  const setUnits = useSurfaceObsStore((s) => s.setUnits);

  const stationMode = displayMode === "station";

  return (
    <div className="sfcobs">
      <div className="sfcobs__enable">
        <span>Enable Surface Obs</span>
        <Toggle on={enabled} onClick={() => setLayerVisible(LAYER, !enabled)} />
      </div>

      <label className="sfcobs__field">
        <span className="sfcobs__label">Display Mode</span>
        <select value={displayMode} onChange={(e) => setDisplayMode(e.target.value as SurfaceDisplayMode)}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="sfcobs__section">Station plot elements</div>
      <div className={`sfcobs__elements${stationMode ? "" : " is-dim"}`}>
        {ELEMENTS.map((el) => (
          <div className="sfcobs__row" key={el.key}>
            <span>{el.label}</span>
            <Toggle on={elements[el.key]} onClick={() => toggleElement(el.key)} />
          </div>
        ))}
      </div>

      <div className="sfcobs__section">Appearance</div>
      <div className="sfcobs__slider">
        <div className="sfcobs__sliderhead">
          <span>Station Spacing</span>
          <b>{spacing} px</b>
        </div>
        <input type="range" min={30} max={140} step={5} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
        <div className="sfcobs__ends">
          <span>Dense</span>
          <span>Sparse</span>
        </div>
      </div>
      <div className="sfcobs__slider">
        <div className="sfcobs__sliderhead">
          <span>Station Size</span>
          <b>{size.toFixed(1)}&times;</b>
        </div>
        <input type="range" min={0.7} max={1.6} step={0.1} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        <div className="sfcobs__ends">
          <span>Small</span>
          <span>Large</span>
        </div>
      </div>

      <div className="sfcobs__row sfcobs__units">
        <span>Units</span>
        <div className="sfcobs__seg">
          <button type="button" className={units === "F" ? "is-active" : ""} onClick={() => setUnits("F")}>°F</button>
          <button type="button" className={units === "C" ? "is-active" : ""} onClick={() => setUnits("C")}>°C</button>
        </div>
      </div>
    </div>
  );
}
