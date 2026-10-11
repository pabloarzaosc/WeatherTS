import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { IS_WEB } from "../../lib/apiConfig";
import { fetchStationNetworks, saveInmetToken, type StationNetworksStatus } from "../../lib/surfaceObs";
import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import { StationSearch } from "../station/StationSearch";
import {
  useSurfaceObsStore,
  ELEMENT_PRESETS,
  AGE_UNLIMITED,
  type SurfaceDisplayMode,
  type StationElements,
  type StationNetworks,
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
  { id: "precip", label: "Rain, last hour" },
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
  { key: "weather", label: "Weather" },
  { key: "rain", label: "Rain" },
];

const NETWORKS: { key: keyof StationNetworks; label: string; hint: string }[] = [
  { key: "metar", label: "Airports", hint: "METAR: the full report, flight category, visibility and sky" },
  { key: "synop", label: "Official", hint: "WMO synoptic stations worldwide, and INMET's automatic network with a token" },
  { key: "mesonet", label: "Mesonets & personal", hint: "NOAA MADIS: state and road networks, RAWS, and personal stations (CWOP)" },
];

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/**
 * Which networks are plotted, and INMET's token. Brazil's automatic stations
 * (520 of them) need a personal token, free from INMET by e-mail; it is kept
 * by the backend on this machine.
 */
function NetworkBlock() {
  const networks = useSurfaceObsStore((s) => s.networks);
  const toggleNetwork = useSurfaceObsStore((s) => s.toggleNetwork);
  const [status, setStatus] = useState<StationNetworksStatus | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      fetchStationNetworks()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    void read();
    const t = window.setInterval(read, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const save = (value: string) => {
    setSaving(true);
    setError(null);
    saveInmetToken(value)
      .then((s) => {
        setStatus(s);
        setToken("");
        if (s.inmet.error) setError(s.inmet.error);
      })
      .catch((err) => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setSaving(false));
  };

  const count = (k: keyof StationNetworks) =>
    k === "synop"
      ? (status?.synop.stations ?? 0) + (status?.inmet.stations ?? 0)
      : k === "mesonet"
        ? (status?.mesonet.stations ?? 0)
        : null;

  return (
    <div className="sfx__block">
      <div className="sfx__head">
        <span>Networks</span>
      </div>
      <div className="sfx__chips">
        {NETWORKS.map((n) => {
          const c = count(n.key);
          return (
            <button
              key={n.key}
              type="button"
              title={n.hint}
              className={`sfx__chip${networks[n.key] ? " is-on" : ""}`}
              aria-pressed={networks[n.key]}
              onClick={() => toggleNetwork(n.key)}
            >
              {n.label}
              {c ? <em className="sfx__count">{fmtCount(c)}</em> : null}
            </button>
          );
        })}
      </div>
      <div className="sfx__head sfx__head--sub">
        <span>INMET (Brazil)</span>
        <b>
          {status?.inmet.configured
            ? status.inmet.stations
              ? `${status.inmet.stations} stations`
              : "token saved"
            : "no token"}
        </b>
      </div>
      {IS_WEB ? null : status?.inmet.configured ? (
        <button type="button" className="sfx__chip sfx__chip--wide" disabled={saving} onClick={() => save("")}>
          {saving ? "Working..." : "Remove the INMET token"}
        </button>
      ) : (
        <form
          className="sfx__token"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) save(token.trim());
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your INMET token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" disabled={saving || !token.trim()}>
            {saving ? <Loader2 size={12} className="sfx__status-spin" /> : "Save"}
          </button>
        </form>
      )}
      <p className="sfx__note">
        INMET's 520 automatic stations need a personal token: free, asked for by e-mail to{" "}
        <b>cadastro.act@inmet.gov.br</b>.{" "}
        {IS_WEB ? "Enter yours in the desktop app: the web version cannot keep one." : "It stays on this computer."}
      </p>
      {(error || status?.inmet.error) && (
        <p className="sfx__note is-error">
          <AlertTriangle size={11} /> {error || status?.inmet.error}
        </p>
      )}
    </div>
  );
}

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

/** Surface Obs control panel -- station plots from every network. */
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
  const layerBusy = useSurfaceObsStore((s) => s.layerBusy);
  const layerError = useSurfaceObsStore((s) => s.layerError);
  const layerLastUpdatedAt = useSurfaceObsStore((s) => s.layerLastUpdatedAt);
  const atUnix = useSurfaceObsStore((s) => s.atUnix);
  const unavailable = useSurfaceObsStore((s) => s.unavailable);

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

  const stationMode = displayMode === "station";
  const activeElements = ELEMENTS.filter((e) => elements[e.key]).length;
  const activePreset = ELEMENT_PRESETS.find((p) =>
    (Object.keys(p.elements) as (keyof StationElements)[]).every((k) => p.elements[k] === elements[k]),
  );
  const updatedLabel = layerLastUpdatedAt
    ? new Date(layerLastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  // Following the timeline to a past frame: say which instant, and which
  // networks keep nothing from then (MADIS about five days, the AWC fifteen).
  const atLabel =
    atUnix != null
      ? `${new Date(atUnix * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`
      : null;
  const NET_NAMES: Record<string, string> = { metar: "airports", mesonet: "mesonets", synop: "official stations" };
  const missing = unavailable.map((n) => NET_NAMES[n] ?? n);

  return (
    <div className="sfx">
      <LayerPower
        label="Surface observations"
        on={enabled}
        error={!!layerError}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />
      <div className={`sfx__status${layerError ? " is-error" : ""}`}>
        {layerBusy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Syncing observations...
          </>
        ) : layerError ? (
          <>
            <AlertTriangle size={13} /> Could not refresh observations: {layerError}
          </>
        ) : enabled && atLabel ? (
          <>
            Reports as of {atLabel}, the frame on the timeline
            {missing.length ? ` · none kept that long from the ${missing.join(" and ")}` : ""}
          </>
        ) : enabled && updatedLabel ? (
          <>Updated at {updatedLabel}</>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Stations</span>
        </div>
        <StationSearch />
      </div>

      <NetworkBlock />

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Field</span>
        </div>
        <Select
          className="sfx__select"
          value={displayMode}
          onChange={(value) => setDisplayMode(value as SurfaceDisplayMode)}
          aria-label="What to draw"
          options={MODES.map((m) => ({ value: m.id, label: m.label }))}
        />
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
