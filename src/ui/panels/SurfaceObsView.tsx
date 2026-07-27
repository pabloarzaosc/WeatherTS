import { AlertTriangle, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import {
  useSurfaceObsStore,
  ELEMENT_PRESETS,
  AGE_UNLIMITED,
  GUST_HL_OFF,
  type SurfaceDisplayMode,
  type StationElements,
} from "../../store/useSurfaceObsStore";

const LAYER = "surfobs";

const MODES: { id: SurfaceDisplayMode; label: string }[] = [
  { id: "station", label: "Station plot" },
  { id: "temp", label: "Temperature" },
  { id: "dewp", label: "Dewpoint" },
  { id: "wspd", label: "Wind speed" },
  { id: "wgst", label: "Wind gust" },
  { id: "altim", label: "Pressure" },
  { id: "visib", label: "Visibility" },
  { id: "rh", label: "Relative humidity" },
  { id: "thetae", label: "Theta-e" },
  { id: "id", label: "Station name" },
];

const ELEMENTS: { key: keyof StationElements; label: string }[] = [
  { key: "wind", label: "Barbs" },
  { key: "gust", label: "Gust" },
  { key: "sky", label: "Sky" },
  { key: "calm", label: "Calm ring" },
  { key: "temp", label: "Temp" },
  { key: "dewp", label: "Dewpoint" },
  { key: "visibility", label: "Visibility" },
  { key: "pressure", label: "Pressure" },
  { key: "stationName", label: "Name" },
];

/** Segmented unit picker. Small on purpose: four of these sit side by side. */
function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="sfx__seg">
      <span className="sfx__seg-label">{label}</span>
      <div className="sfx__seg-track" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            className={value === v ? "is-on" : ""}
            aria-pressed={value === v}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Surface Obs control panel -- real METAR station plots. */
export function SurfaceObsView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const displayMode = useSurfaceObsStore((s) => s.displayMode);
  const elements = useSurfaceObsStore((s) => s.elements);
  const spacing = useSurfaceObsStore((s) => s.spacing);
  const size = useSurfaceObsStore((s) => s.size);
  const tempUnits = useSurfaceObsStore((s) => s.tempUnits);
  const windUnits = useSurfaceObsStore((s) => s.windUnits);
  const presUnits = useSurfaceObsStore((s) => s.presUnits);
  const visUnits = useSurfaceObsStore((s) => s.visUnits);
  const maxAgeMin = useSurfaceObsStore((s) => s.maxAgeMin);
  const fadeStale = useSurfaceObsStore((s) => s.fadeStale);
  const gustHighlight = useSurfaceObsStore((s) => s.gustHighlight);
  const layerBusy = useSurfaceObsStore((s) => s.layerBusy);
  const layerError = useSurfaceObsStore((s) => s.layerError);
  const layerLastUpdatedAt = useSurfaceObsStore((s) => s.layerLastUpdatedAt);

  const setDisplayMode = useSurfaceObsStore((s) => s.setDisplayMode);
  const toggleElement = useSurfaceObsStore((s) => s.toggleElement);
  const setElementsPreset = useSurfaceObsStore((s) => s.setElementsPreset);
  const setSpacing = useSurfaceObsStore((s) => s.setSpacing);
  const setSize = useSurfaceObsStore((s) => s.setSize);
  const setTempUnits = useSurfaceObsStore((s) => s.setTempUnits);
  const setWindUnits = useSurfaceObsStore((s) => s.setWindUnits);
  const setPresUnits = useSurfaceObsStore((s) => s.setPresUnits);
  const setVisUnits = useSurfaceObsStore((s) => s.setVisUnits);
  const setMaxAgeMin = useSurfaceObsStore((s) => s.setMaxAgeMin);
  const setFadeStale = useSurfaceObsStore((s) => s.setFadeStale);
  const setGustHighlight = useSurfaceObsStore((s) => s.setGustHighlight);

  const stationMode = displayMode === "station";
  const activeElements = ELEMENTS.filter((e) => elements[e.key]).length;
  const activePreset = ELEMENT_PRESETS.find((p) =>
    (Object.keys(p.elements) as (keyof StationElements)[]).every((k) => p.elements[k] === elements[k]),
  );
  const updatedLabel = layerLastUpdatedAt
    ? new Date(layerLastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="sfx">
      <button
        type="button"
        className={`sfx__power${enabled ? " is-on" : ""}`}
        aria-pressed={enabled}
        onClick={() => setLayerVisible(LAYER, !enabled)}
      >
        <span className="sfx__power-dot" />
        <span className="sfx__power-txt">Surface observations</span>
        <span className="sfx__power-state">{enabled ? "LIVE" : "OFF"}</span>
      </button>
      <div className={`sfx__status${layerError ? " is-error" : ""}`}>
        {layerBusy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Syncing observations...
          </>
        ) : layerError ? (
          <>
            <AlertTriangle size={13} /> Could not refresh observations: {layerError}
          </>
        ) : enabled && updatedLabel ? (
          <>Updated at {updatedLabel}</>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Field</span>
        </div>
        <select
          className="sfx__select"
          value={displayMode}
          onChange={(e) => setDisplayMode(e.target.value as SurfaceDisplayMode)}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className={`sfx__block${stationMode ? "" : " is-dim"}`}>
        <div className="sfx__head">
          <span>Preset</span>
        </div>
        <div className="sfx__presets">
          {ELEMENT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              className={`sfx__preset${activePreset?.id === p.id ? " is-on" : ""}`}
              onClick={() => setElementsPreset(p.elements)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="sfx__head sfx__head--sub">
          <span>Plot elements</span>
          <b>
            {activeElements}/{ELEMENTS.length}
          </b>
        </div>
        <div className="sfx__chips">
          {ELEMENTS.map((el) => (
            <button
              key={el.key}
              type="button"
              className={`sfx__chip${elements[el.key] ? " is-on" : ""}`}
              aria-pressed={elements[el.key]}
              onClick={() => toggleElement(el.key)}
            >
              {el.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Units</span>
        </div>
        <div className="sfx__units">
          <Seg label="Temp" value={tempUnits} options={[["F", "°F"], ["C", "°C"]]} onChange={setTempUnits} />
          <Seg
            label="Wind"
            value={windUnits}
            options={[["kt", "kt"], ["mph", "mph"], ["ms", "m/s"]]}
            onChange={setWindUnits}
          />
          <Seg label="Pressure" value={presUnits} options={[["mb", "mb"], ["inHg", "inHg"]]} onChange={setPresUnits} />
          <Seg label="Visibility" value={visUnits} options={[["mi", "mi"], ["km", "km"]]} onChange={setVisUnits} />
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Freshness</span>
          <b>{maxAgeMin === AGE_UNLIMITED ? "no limit" : `${maxAgeMin} min`}</b>
        </div>
        <input
          className="sfx__range"
          type="range"
          min={0}
          max={360}
          step={15}
          value={maxAgeMin}
          onChange={(e) => setMaxAgeMin(Number(e.target.value))}
        />
        <div className="sfx__ends">
          <span>No limit</span>
          <span>6 h</span>
        </div>
        <button
          type="button"
          className={`sfx__chip sfx__chip--wide${fadeStale ? " is-on" : ""}`}
          aria-pressed={fadeStale}
          onClick={() => setFadeStale(!fadeStale)}
        >
          Fade ageing observations
        </button>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Gust highlight</span>
          <b>{gustHighlight === GUST_HL_OFF ? "off" : `≥ ${gustHighlight} kt`}</b>
        </div>
        <input
          className="sfx__range"
          type="range"
          min={0}
          max={80}
          step={5}
          value={gustHighlight}
          onChange={(e) => setGustHighlight(Number(e.target.value))}
        />
        <div className="sfx__ends">
          <span>Off</span>
          <span>80 kt</span>
        </div>
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Density</span>
          <b>{spacing} px</b>
        </div>
        <input
          className="sfx__range"
          type="range"
          min={30}
          max={140}
          step={5}
          value={spacing}
          onChange={(e) => setSpacing(Number(e.target.value))}
        />
        <div className="sfx__ends">
          <span>Dense</span>
          <span>Sparse</span>
        </div>

        <div className="sfx__head sfx__head--sub">
          <span>Plot size</span>
          <b>{size.toFixed(1)}&times;</b>
        </div>
        <input
          className="sfx__range"
          type="range"
          min={0.7}
          max={1.6}
          step={0.1}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        />
        <div className="sfx__ends">
          <span>Small</span>
          <span>Large</span>
        </div>
      </div>
    </div>
  );
}
