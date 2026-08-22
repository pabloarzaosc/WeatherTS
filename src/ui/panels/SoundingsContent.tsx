import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CloudUpload,
  GitCompare,
  History,
  Loader2,
  Radio,
  Search,
  Star,
  Table2,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

import {
  type RiskScanResult,
  type RiskStation,
  type SoundingResult,
  type SoundingSource,
  type SoundingStation,
  type TimeSeriesResult,
  type VwpResult,
} from "../../lib/soundingApi";
import {
  deleteSoundingHistory,
  getSoundingFavorites,
  getSoundingHistory,
  loadSoundingHistory,
  toggleSoundingFavorite,
  type SoundingHistoryEntry,
} from "../../lib/soundingStorage";
import { generateSoundingSummary } from "../../lib/soundingSummary";
import { SoundingPlotOptions } from "./SoundingPlotOptions";
import { AcarsView } from "./AcarsView";
import {
  CompareTab,
  RiskTab,
  TrendsTab,
  UploadTab,
  VwpTab,
  type Station as ToolStation,
} from "./SoundingToolTabs";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";

type Mode = "analysis" | "risk" | "compare" | "timeseries" | "vwp" | "upload";


interface CompositeResult {
  image: string;
  meta?: Record<string, unknown>;
}

interface EnsembleResult {
  image?: string;
  params?: SoundingResult["params"];
  members?: number | unknown[];
  hours?: number[];
  errors?: string[] | null;
  meta?: Record<string, unknown>;
}

const MODES: Array<{ id: Mode; label: string; icon: ReactNode }> = [
  { id: "analysis", label: "Analyze", icon: <Activity size={14} /> },
  { id: "risk", label: "Risk", icon: <Zap size={14} /> },
  { id: "compare", label: "Compare", icon: <GitCompare size={14} /> },
  { id: "timeseries", label: "Trends", icon: <TrendingUp size={14} /> },
  { id: "vwp", label: "VWP", icon: <Radio size={14} /> },
  { id: "upload", label: "Upload", icon: <CloudUpload size={14} /> },
];

const MODELS = ["rap", "hrrr", "nam", "namnest", "gfs"];
const HOUR_PRESETS: Record<string, number[]> = {
  "0-6 h": [0, 1, 2, 3, 4, 5, 6],
  "0-12 h": [0, 1, 2, 3, 6, 9, 12],
  "0-24 h": [0, 3, 6, 9, 12, 15, 18, 21, 24],
  "0-48 h": [0, 6, 12, 18, 24, 30, 36, 42, 48],
};

const PARAMETER_GROUPS: Array<{
  title: string;
  items: Array<{ key: keyof SoundingResult["params"]; label: string; unit?: string; digits?: number }>;
}> = [
  {
    title: "Thermodynamic",
    items: [
      { key: "sbCape", label: "SBCAPE", unit: "J/kg" },
      { key: "mlCape", label: "MLCAPE", unit: "J/kg" },
      { key: "muCape", label: "MUCAPE", unit: "J/kg" },
      { key: "mlCin", label: "MLCIN", unit: "J/kg" },
      { key: "mlLclM", label: "MLLCL", unit: "m" },
      { key: "dcape", label: "DCAPE", unit: "J/kg" },
      { key: "lr03", label: "LR 0-3", unit: "C/km", digits: 1 },
      { key: "lr36", label: "LR 3-6", unit: "C/km", digits: 1 },
      { key: "pwat", label: "PWAT", unit: "mm", digits: 1 },
    ],
  },
  {
    title: "Kinematic",
    items: [
      { key: "bwd1km", label: "BWD 0-1", unit: "kt" },
      { key: "bwd3km", label: "BWD 0-3", unit: "kt" },
      { key: "bwd6km", label: "BWD 0-6", unit: "kt" },
      { key: "srh1km", label: "SRH 0-1", unit: "m2/s2" },
      { key: "srh3km", label: "SRH 0-3", unit: "m2/s2" },
      { key: "esrh", label: "Eff SRH", unit: "m2/s2" },
      { key: "ebwd", label: "Eff BWD", unit: "kt" },
      { key: "criticalAngle", label: "Critical Angle", unit: "deg" },
    ],
  },
  {
    title: "Composites",
    items: [
      { key: "stp", label: "STP", digits: 1 },
      { key: "stpEff", label: "Eff STP", digits: 1 },
      { key: "scp", label: "SCP", digits: 1 },
      { key: "ship", label: "SHIP", digits: 1 },
      { key: "dcp", label: "DCP", digits: 1 },
      { key: "ehi01", label: "EHI 0-1", digits: 2 },
      { key: "vgp", label: "VGP", digits: 2 },
      { key: "brn", label: "BRN", digits: 1 },
    ],
  },
  {
    title: "Specialized",
    items: [
      { key: "wmsi", label: "WMSI", digits: 1 },
      { key: "mdpi", label: "MDPI", digits: 1 },
      { key: "maxGust", label: "Max Gust", unit: "kt", digits: 1 },
      { key: "fosbergFwi", label: "Fosberg", digits: 1 },
      { key: "haines", label: "Haines" },
      { key: "hdw", label: "HDW", digits: 1 },
      { key: "frzLevel", label: "FRZ", unit: "m" },
      { key: "wbo", label: "WB0", unit: "m" },
    ],
  },
];



function asImageSrc(image?: string | null) {
  if (!image) return "";
  return image.startsWith("data:image") ? image : `data:image/png;base64,${image}`;
}

function fmt(value: unknown, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return value.toFixed(digits);
}

function valueText(value: unknown, unit?: string, digits = 0) {
  const main = fmt(value, digits);
  return unit && main !== "--" ? `${main} ${unit}` : main;
}

function stationName(stations: SoundingStation[], id: string) {
  const station = stations.find((item) => item.id === id.toUpperCase());
  return station?.name ?? id.toUpperCase();
}

function titleForMode(mode: Mode) {
  return MODES.find((item) => item.id === mode)?.label ?? "Soundings";
}

function memberCount(value: number | unknown[] | undefined, fallback: number) {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return fallback;
}


function SummaryBlock({ result }: { result: SoundingResult }) {
  const summary = generateSoundingSummary(result.params, result.meta);
  return (
    <div className="snd-summary">
      <div className="snd-threat" style={{ borderColor: summary.color }}>
        <span className="snd-threat__dot" style={{ background: summary.color }} />
        <div>
          <strong>{summary.level}</strong>
          <span>{summary.threats.length ? summary.threats.join(" / ") : "No focused severe signal"}</span>
        </div>
      </div>
      {summary.sections.map((section) => (
        <section key={section.id} className="snd-brief">
          <h4>{section.title}</h4>
          <p>{section.text}</p>
          <div className="snd-facts">
            {section.facts.map((item) => (
              <span key={`${section.id}-${item.label}`}>
                <b>{item.label}</b>
                {item.value}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParameterGrid({ result }: { result: SoundingResult }) {
  return (
    <div className="snd-paramgrid">
      {PARAMETER_GROUPS.map((group) => (
        <section key={group.title} className="snd-paramgroup">
          <h4>{group.title}</h4>
          {group.items.map((item) => (
            <div key={String(item.key)} className="snd-paramrow">
              <span>{item.label}</span>
              <b>{valueText(result.params[item.key], item.unit, item.digits ?? 0)}</b>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function RiskTable({
  result,
  onLoad,
}: {
  result: RiskScanResult;
  onLoad: (station: RiskStation) => void;
}) {
  return (
    <div className="snd-tablewrap">
      <table className="snd-table">
        <thead>
          <tr>
            <th>Station</th>
            <th>STP</th>
            <th>SCP</th>
            <th>SHIP</th>
            <th>DCP</th>
            <th>CAPE</th>
            <th>SRH</th>
            <th>BWD</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {result.stations.slice(0, 40).map((station) => (
            <tr key={station.id}>
              <td>
                <b>{station.id}</b>
                <span>{station.name}</span>
              </td>
              <td>{station.stp.toFixed(2)}</td>
              <td>{station.scp.toFixed(2)}</td>
              <td>{station.ship.toFixed(2)}</td>
              <td>{station.dcp.toFixed(2)}</td>
              <td>{station.cape}</td>
              <td>{station.srh}</td>
              <td>{station.bwd}</td>
              <td>
                <button type="button" className="snd-mini" onClick={() => onLoad(station)}>
                  Load
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export function SoundingsContent() {
  const [mode, setMode] = useState<Mode>("analysis");
  const [stations, setStations] = useState<SoundingStation[]>([]);
  const [stationSearch, setStationSearch] = useState("");
  const [station, setStation] = useState("OUN");
  const [source, setSource] = useState<SoundingSource>("obs");
  const [model, setModel] = useState("rap");
  const [fhour, setFhour] = useState(0);
  const [date, setDate] = useState("");
  const [usePoint, setUsePoint] = useState(false);
  const [lat, setLat] = useState("35.22");
  const [lon, setLon] = useState("-97.44");
  const [smoothing, setSmoothing] = useState(0);
  const [stormDir, setStormDir] = useState("");
  const [stormSpeed, setStormSpeed] = useState("");
  const [surfaceTemp, setSurfaceTemp] = useState("");
  const [surfaceDewpoint, setSurfaceDewpoint] = useState("");
  const [surfaceWindSpeed, setSurfaceWindSpeed] = useState("");
  const [surfaceWindDir, setSurfaceWindDir] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => getSoundingFavorites());
  const [history, setHistory] = useState<SoundingHistoryEntry[]>(() => getSoundingHistory());

  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [result, setResult] = useState<SoundingResult | null>(null);
  const [riskResult, setRiskResult] = useState<RiskScanResult | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesResult | null>(null);
  const [compareResults, setCompareResults] = useState<SoundingResult[] | null>(null);
  const [composite, setComposite] = useState<CompositeResult | null>(null);
  const [ensemble, setEnsemble] = useState<EnsembleResult | null>(null);
  const [vwp, setVwp] = useState<VwpResult | null>(null);

  // The station list comes from the file the map layer already draws from, not
  // from the external service: that host is down, so the search box sat empty
  // and every station id read as unknown.
  useEffect(() => {
    let cancelled = false;
    void fetch(`${import.meta.env.BASE_URL}data/raob-stations.geojson`)
      .then((r) => r.json())
      .then((fc: { features?: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }> }) => {
        if (cancelled) return;
        setStations(
          (fc.features ?? []).map((f) => ({
            id: String(f.properties.id),
            name: String(f.properties.name ?? f.properties.id),
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
            wmo: f.properties.wmo,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setStations([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredStations = useMemo(() => {
    const q = stationSearch.trim().toUpperCase();
    const favored = new Set(favorites);
    return stations
      .filter((item) => {
        if (!q) return true;
        return item.id.includes(q) || item.name.toUpperCase().includes(q);
      })
      .sort((a, b) => {
        const af = favored.has(a.id) ? 0 : 1;
        const bf = favored.has(b.id) ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 36);
  }, [favorites, stationSearch, stations]);

  const selectedStation = useMemo(
    () => stations.find((item) => item.id === station.toUpperCase()) ?? null,
    [station, stations],
  );

  const selectedHours = HOUR_PRESETS["0-12 h"];

  const resetOutputs = () => {
    setError(null);
    setResult(null);
    setRiskResult(null);
    setTimeSeries(null);
    setCompareResults(null);
    setComposite(null);
    setEnsemble(null);
    setVwp(null);
  };


  const runWithState = async (label: string, fn: () => Promise<void>) => {
    setLoading(label);
    setError(null);
    setWorkbenchOpen(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  };

  /**
   * Open the sounding in the app's own viewer.
   *
   * This panel was written against an external analysis service that is no
   * longer up -- every request to it answers 503, and the panel then tried to
   * parse the HTML error page as JSON ("Unexpected token '<'"). The app already
   * renders soundings itself, through SHARPpy on our backend, with the parcel
   * and storm-motion controls above; so the button now drives that instead of
   * a dead host.
   */
  /**
   * Find a station by whatever the user typed.
   *
   * The panel's ids came from the old service, which used bare three-letter
   * ids (OUN); our own list carries ICAO for the US sites (KOUN). Matching
   * exactly meant the default station reported itself as unknown.
   */
  const findStation = (raw: string) => {
    const id = raw.trim().toUpperCase();
    if (!id) return undefined;
    return (
      stations.find((s) => s.id.toUpperCase() === id) ??
      stations.find((s) => s.id.toUpperCase() === `K${id}`) ??
      stations.find((s) => id.startsWith("K") && s.id.toUpperCase() === id.slice(1)) ??
      stations.find((s) => (s.wmo ?? "").toUpperCase() === id)
    );
  };

  const runSounding = (stationOverride?: string) =>
    runWithState("Opening sounding", async () => {
      resetOutputs();
      const viewer = useSoundingViewerStore.getState();
      const id = (stationOverride ?? station).toUpperCase();

      if (source === "obs") {
        const hit = findStation(id);
        if (!hit) throw new Error(`Unknown station ${id}. Pick one from the search above.`);
        viewer.openRaob({ id: hit.id, name: hit.name, lat: hit.lat, lon: hit.lon, wmo: hit.wmo });
        return;
      }

      // Model sources are a point forecast: the station is just a location.
      const hit = findStation(id);
      const plat = usePoint ? Number(lat) : hit?.lat;
      const plon = usePoint ? Number(lon) : hit?.lon;
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) {
        throw new Error("No coordinates for that station — switch on Point sounding and enter lat/lon.");
      }
      viewer.setModel(model);
      viewer.openAt(plat as number, plon as number);
      if (fhour > 0) viewer.setHour(fhour);
    });









  const loadRiskStation = (item: RiskStation) => {
    setStation(item.id);
    setMode("analysis");
    void runSounding(item.id);
  };

  const loadHistoryItem = async (entry: SoundingHistoryEntry) => {
    setLoading("Loading history");
    setError(null);
    setWorkbenchOpen(true);
    try {
      const loaded = await loadSoundingHistory(entry.id);
      if (!loaded) throw new Error("History entry was not found");
      resetOutputs();
      setResult({
        image: loaded.image ?? undefined,
        meta: loaded.meta,
        params: loaded.params,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  };

  const toggleFavorite = () => {
    setFavorites(toggleSoundingFavorite(station));
  };


  return (
    <div className="soundings">
      <div className="snd-modegrid">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`snd-mode${mode === item.id ? " is-active" : ""}`}
            onClick={() => setMode(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <SoundingPlotOptions />
      <AcarsView />

      <section className="snd-section">
          <div className="snd-labelrow">
            <span>Station</span>
            <button
              type="button"
              className={`snd-star${favorites.includes(station.toUpperCase()) ? " is-on" : ""}`}
              onClick={toggleFavorite}
              title="Toggle favorite station"
            >
              <Star size={13} />
            </button>
          </div>
          <div className="snd-stationbox">
            <Search size={13} />
            <input
              value={stationSearch}
              placeholder={`${station.toUpperCase()} - ${selectedStation?.name ?? "Search stations"}`}
              onChange={(event) => setStationSearch(event.target.value)}
            />
          </div>
          {stationSearch && (
            <div className="snd-stationlist">
              {filteredStations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === station.toUpperCase() ? "is-active" : ""}
                  onClick={() => {
                    setStation(item.id);
                    setStationSearch("");
                  }}
                >
                  <b>{item.id}</b>
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          )}

          <label className="snd-inputlabel">
            Station ID
            <input value={station} onChange={(event) => setStation(event.target.value.toUpperCase())} />
          </label>
      </section>

      {(mode === "analysis" || mode === "timeseries") && (
        <section className="snd-section">
          <div className="snd-row2">
            <label className="snd-inputlabel">
              Source
              <select value={source} onChange={(event) => setSource(event.target.value as SoundingSource)}>
                <option value="obs">Observed RAOB</option>
                <option value="psu">PSU BUFKIT</option>
                <option value="bufkit">Iowa State BUFKIT</option>
              </select>
            </label>
            <label className="snd-inputlabel">
              Model
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {MODELS.map((item) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="snd-row2">
            <label className="snd-inputlabel">
              Date UTC
              <input value={date} placeholder="YYYYMMDDHH" onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="snd-inputlabel">
              F-hour
              <input type="number" min={0} max={84} value={fhour} onChange={(event) => setFhour(Number(event.target.value))} />
            </label>
          </div>
        </section>
      )}

      {mode === "analysis" && (
        <>
          <section className="snd-section">
            <button
              type="button"
              className={`snd-switch${usePoint ? " is-on" : ""}`}
              onClick={() => setUsePoint(!usePoint)}
              role="switch"
              aria-checked={usePoint}
            >
              <span />
              Point sounding
            </button>
            {usePoint && (
              <div className="snd-row2">
                <label className="snd-inputlabel">
                  Lat
                  <input value={lat} onChange={(event) => setLat(event.target.value)} />
                </label>
                <label className="snd-inputlabel">
                  Lon
                  <input value={lon} onChange={(event) => setLon(event.target.value)} />
                </label>
              </div>
            )}
            <label className="snd-inputlabel">
              Smoothing
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={smoothing}
                onChange={(event) => setSmoothing(Number(event.target.value))}
              />
              <span className="snd-hint">{smoothing.toFixed(1)} sigma</span>
            </label>
          </section>

          <section className="snd-section">
            <h4 className="snd-sectiontitle">Storm Motion</h4>
            <div className="snd-row2">
              <label className="snd-inputlabel">
                Dir
                <input value={stormDir} placeholder="deg" onChange={(event) => setStormDir(event.target.value)} />
              </label>
              <label className="snd-inputlabel">
                Speed
                <input value={stormSpeed} placeholder="kt" onChange={(event) => setStormSpeed(event.target.value)} />
              </label>
            </div>
          </section>

          <section className="snd-section">
            <h4 className="snd-sectiontitle">Surface Edit</h4>
            <div className="snd-row2">
              <input value={surfaceTemp} placeholder="Temp C" onChange={(event) => setSurfaceTemp(event.target.value)} />
              <input value={surfaceDewpoint} placeholder="Dew C" onChange={(event) => setSurfaceDewpoint(event.target.value)} />
            </div>
            <div className="snd-row2">
              <input value={surfaceWindSpeed} placeholder="Wind kt" onChange={(event) => setSurfaceWindSpeed(event.target.value)} />
              <input value={surfaceWindDir} placeholder="Wind deg" onChange={(event) => setSurfaceWindDir(event.target.value)} />
            </div>
          </section>

          <button type="button" className="snd-primary" onClick={() => void runSounding()} disabled={!!loading}>
            {loading ? <Loader2 size={14} className="spin" /> : <Activity size={14} />}
            Analyze sounding
          </button>
        </>
      )}

      {mode === "risk" && <RiskTab stations={stations as ToolStation[]} />}
      {mode === "compare" && <CompareTab findStation={findStation} />}
      {mode === "timeseries" && <TrendsTab station={station} findStation={findStation} />}
      {mode === "vwp" && <VwpTab />}
      {mode === "upload" && <UploadTab />}


      <section className="snd-section">
        <h4 className="snd-sectiontitle">
          <History size={13} />
          History
        </h4>
        <div className="snd-history">
          {history.length === 0 && <span className="snd-muted">No saved soundings yet.</span>}
          {history.slice(0, 8).map((entry) => (
            <div key={entry.id} className="snd-historyrow">
              <button type="button" onClick={() => void loadHistoryItem(entry)}>
                <b>{entry.meta.station ?? "CUSTOM"}</b>
                <span>{entry.meta.date ?? new Date(entry.timestamp).toLocaleString()}</span>
              </button>
              <button
                type="button"
                title="Delete"
                onClick={() => {
                  deleteSoundingHistory(entry.id);
                  setHistory(getSoundingHistory());
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {workbenchOpen && (
        <div className="sounding-workbench" role="region" aria-label="Sounding workbench">
          <div className="snd-workbench__head">
            <div>
              <span>{titleForMode(mode)}</span>
              <strong>
                {result?.meta.stationName ||
                  riskResult?.date ||
                  timeSeries?.stationName ||
                  ensemble?.meta?.station?.toString() ||
                  vwp?.radar ||
                  stationName(stations, station)}
              </strong>
            </div>
            <button type="button" className="snd-close" onClick={() => setWorkbenchOpen(false)}>
              <X size={16} />
            </button>
          </div>

          {loading && (
            <div className="snd-loading">
              <Loader2 size={22} className="spin" />
              <span>{loading}</span>
            </div>
          )}

          {error && (
            <div className="snd-error">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          )}

          {!loading && result && (
            <div className="snd-resultgrid">
              {result.image && (
                <div className="snd-plot">
                  <img src={asImageSrc(result.image)} alt="Sounding plot" />
                </div>
              )}
              <div className="snd-side">
                <div className="snd-meta">
                  <span>{result.meta.station ?? "CUSTOM"}</span>
                  <span>{result.meta.source?.toUpperCase()}</span>
                  <span>{result.meta.date}</span>
                  <span>{result.meta.levels ?? 0} levels</span>
                </div>
                <SummaryBlock result={result} />
              </div>
              <ParameterGrid result={result} />
            </div>
          )}

          {!loading && riskResult && (
            <>
              <div className="snd-meta snd-meta--wide">
                <span>{riskResult.model ?? "Observed"}</span>
                <span>{riskResult.date}</span>
                <span>{riskResult.stations.length} stations</span>
              </div>
              <RiskTable result={riskResult} onLoad={loadRiskStation} />
            </>
          )}



          {!loading && compareResults && (
            <div className="snd-comparegrid">
              {compareResults.map((item, index) => (
                <section key={`${item.meta.station}-${index}`} className="snd-comparecard">
                  <h4>
                    {item.meta.station} <span>{item.meta.date}</span>
                  </h4>
                  {item.image && <img src={asImageSrc(item.image)} alt={`Sounding ${item.meta.station ?? index + 1}`} />}
                  <div className="snd-comparestats">
                    <span>STP {fmt(item.params.stp, 1)}</span>
                    <span>SCP {fmt(item.params.scp, 1)}</span>
                    <span>CAPE {fmt(item.params.muCape)}</span>
                    <span>BWD {fmt(item.params.bwd6km)} kt</span>
                  </div>
                </section>
              ))}
              {composite?.image && (
                <section className="snd-comparecard snd-comparecard--wide">
                  <h4>Composite Overlay</h4>
                  <img src={asImageSrc(composite.image)} alt="Composite sounding overlay" />
                </section>
              )}
            </div>
          )}

          {!loading && ensemble?.image && (
            <div className="snd-plot snd-plot--solo">
              <img src={asImageSrc(ensemble.image)} alt="Forecast sounding plume" />
              <div className="snd-meta snd-meta--wide">
                <span>{String(ensemble.meta?.model ?? model.toUpperCase())}</span>
                <span>{memberCount(ensemble.members, selectedHours.length)} members</span>
                <span>{ensemble.hours?.map((hour) => `f${String(hour).padStart(3, "0")}`).join(" ")}</span>
              </div>
            </div>
          )}

          {!loading && vwp?.image && (
            <div className="snd-plot snd-plot--solo">
              <img src={asImageSrc(vwp.image)} alt={`VWP ${vwp.radar}`} />
            </div>
          )}

          {!loading && !error && !result && !riskResult && !timeSeries && !compareResults && !ensemble && !vwp && (
            <div className="snd-emptyline">
              <Table2 size={22} />
              Run a sounding tool to populate this workbench.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
