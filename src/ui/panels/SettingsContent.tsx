import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  Compass,
  Eye,
  Gauge,
  Layers,
  LayoutPanelLeft,
  Map as MapIcon,
  Megaphone,
  MessageSquareWarning,
  Radar,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Thermometer,
  Trash2,
  Upload,
  Users,
  Wind,
  X,
} from "lucide-react";

import { useShallow } from "zustand/react/shallow";

import { Select } from "../Select";
import { useAppStore } from "../../store/useAppStore";
import { useOnboardingStore } from "../../store/useOnboardingStore";
import { useNexradStore } from "../../store/useNexradStore";
import { usePaletteStore } from "../../store/usePaletteStore";
import { useThemeStore, type ThemeMode } from "../../store/useThemeStore";
import { useChaserStore } from "../../store/useChaserStore";
import { useAlertStore, type AlertCategoryKey } from "../../store/useAlertStore";
import { useObsStore } from "../../store/useObsStore";
import { AGE_UNLIMITED, useSurfaceObsStore } from "../../store/useSurfaceObsStore";
import { layoutIsCustom, useLayoutStore, type Side } from "../../store/useLayoutStore";
import { buildLut, palGradient, parsePal } from "../../lib/pal";
import { INITIAL_VIEW } from "../../map/mapStyle";
import { getMap } from "../../map/mapInstance";
import { DEFAULT_UNIT, UNITS_BY_KIND, UNIT_CHOICES } from "../../lib/radarUnits";
import { SETTINGS_SECTIONS, type SettingDef, type SettingValue } from "../../settings/schema";
import { useSettingsStore } from "../../settings/useSettingsStore";

// ---------------------------------------------------------------- controls ---

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`switch setx__switch${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`seg__btn${o.v === value ? " is-active" : ""}`}
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One setting: its name and note on the left, its control on the right (or
 *  under it, for sliders), and a reset once it differs from the default. */
function Row({
  label,
  hint,
  control,
  below,
  modified,
  onReset,
}: {
  label: string;
  hint?: string;
  control?: ReactNode;
  below?: ReactNode;
  modified?: boolean;
  onReset?: () => void;
}) {
  return (
    <div className={`setx__row${modified ? " is-modified" : ""}`}>
      <div className="setx__rowmain">
        <div className="setx__text">
          <span className="setx__label">{label}</span>
          {hint && <span className="setx__hint">{hint}</span>}
        </div>
        {modified && onReset && (
          <button type="button" className="setx__reset" onClick={onReset} title="Back to default" aria-label={`Reset ${label}`}>
            <RotateCcw size={11} />
          </button>
        )}
        {control && <div className="setx__control">{control}</div>}
      </div>
      {below}
    </div>
  );
}

function formatSlider(def: Extract<SettingDef, { type: "slider" }>, v: number): string {
  if (def.percent) return `${Math.round(v * 100)}%`;
  const digits = def.step < 0.1 ? 2 : def.step < 1 ? 1 : 0;
  return `${v.toFixed(digits)}${def.unit ?? ""}`;
}

/** A row drawn from settings/schema.ts. */
function SchemaRow({ def }: { def: SettingDef }) {
  const stored = useSettingsStore((s) => s.values[def.key]);
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);
  const value = (stored !== undefined ? stored : def.default) as SettingValue;
  const common = { label: def.label, hint: def.hint, modified: stored !== undefined, onReset: () => reset(def.key) };

  switch (def.type) {
    case "toggle":
      return <Row {...common} control={<Switch on={value as boolean} label={def.label} onChange={(v) => set(def.key, v)} />} />;
    case "color":
      return (
        <Row
          {...common}
          control={
            <label className="setx__color">
              <span className="setx__hex">{String(value).toUpperCase()}</span>
              <input type="color" value={value as string} onChange={(e) => set(def.key, e.target.value)} aria-label={def.label} />
            </label>
          }
        />
      );
    case "select":
      return (
        <Row
          {...common}
          control={
            <Select value={value as string} onChange={(v) => set(def.key, v)} options={def.options} aria-label={def.label} />
          }
        />
      );
    case "slider":
      return (
        <Row
          {...common}
          control={<span className="setx__value">{formatSlider(def, value as number)}</span>}
          below={
            <input
              className="setx__range"
              type="range"
              min={def.min}
              max={def.max}
              step={def.step}
              value={value as number}
              onChange={(e) => set(def.key, Number(e.target.value))}
              aria-label={def.label}
            />
          }
        />
      );
  }
}

// ------------------------------------------------------ settings elsewhere ---
// Options that already live in a product's own store, shown here as well so
// Settings is the one place that has everything. They stay in those stores.

function ThemeRow() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  return (
    <Row
      label="Theme"
      hint="Auto follows your clock: light from 6am to 7pm."
      below={
        <Segmented<ThemeMode>
          value={mode}
          onChange={setMode}
          options={[
            { v: "light", label: "Light" },
            { v: "dark", label: "Dark" },
            { v: "auto", label: "Auto" },
          ]}
        />
      }
    />
  );
}

function MotionRow() {
  const reduce = useAppStore((s) => s.reduceMotion);
  const set = useAppStore((s) => s.setReduceMotion);
  return <Row label="Reduce motion" control={<Switch on={reduce} label="Reduce motion" onChange={set} />} />;
}

function CoordinatesRow() {
  const format = useAppStore((s) => s.coordFormat);
  const set = useAppStore((s) => s.setCoordFormat);
  return (
    <Row
      label="Coordinates"
      control={
        <Segmented
          value={format}
          onChange={set}
          options={[
            { v: "decimal", label: "Decimal" },
            { v: "dms", label: "DMS" },
          ]}
        />
      }
    />
  );
}

function ProjectionRow() {
  const projection = useAppStore((s) => s.projection);
  const set = useAppStore((s) => s.setProjection);
  return (
    <Row
      label="Projection"
      control={
        <Segmented
          value={projection}
          onChange={set}
          options={[
            { v: "mercator", label: "Flat" },
            { v: "globe", label: "Globe" },
          ]}
        />
      }
    />
  );
}

function GuidesBlock() {
  return (
    <div className="set__guides">
      <button type="button" className="set__guide" onClick={() => useOnboardingStore.getState().openQuickStart()}>
        <Compass size={14} />
        <span>
          <b>Quick start</b>
          <i>Re-run the setup pass</i>
        </span>
      </button>
      <button type="button" className="set__guide" onClick={() => useOnboardingStore.getState().openWhatsNew()}>
        <Sparkles size={14} />
        <span>
          <b>What&rsquo;s new</b>
          <i>Release log for every version</i>
        </span>
      </button>
    </div>
  );
}

function ShareRow() {
  const sharing = useChaserStore((s) => s.sharing);
  const setSharing = useChaserStore((s) => s.setSharing);
  const shareError = useChaserStore((s) => s.shareError);
  const status = useChaserStore((s) => s.status);
  return (
    <>
      <Row
        label="Share my position"
        hint="Puts this device on the map for other WeatherTS chasers, under your username. Nothing is recorded; it disappears when you disconnect or switch this off."
        control={<Switch on={sharing} label="Share my position" onChange={setSharing} />}
      />
      {shareError && <div className="sv__notice">{shareError}</div>}
      {status === "error" && !shareError && (
        <div className="sv__notice">Could not join the chaser channel. Sign out and back in, then try again.</div>
      )}
    </>
  );
}

function LayoutBlock() {
  const panelSide = useLayoutStore((s) => s.panelSide);
  const alertSide = useLayoutStore((s) => s.alertSide);
  const setPanelSide = useLayoutStore((s) => s.setPanelSide);
  const setAlertSide = useLayoutStore((s) => s.setAlertSide);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const custom = useLayoutStore(layoutIsCustom);
  const sides = (value: Side, onChange: (s: Side) => void) => (
    <Segmented<Side>
      value={value}
      onChange={onChange}
      options={[
        { v: "left", label: "Left" },
        { v: "right", label: "Right" },
      ]}
    />
  );
  return (
    <>
      <Row label="Data panel side" control={sides(panelSide, setPanelSide)} />
      <Row label="Alert rail side" control={sides(alertSide, setAlertSide)} />
      <Row
        label="Floating tools"
        hint="Drag the product picker, colour scale, zoom stack and readout anywhere on the map."
        control={
          <button type="button" className="setx__btn" onClick={resetLayout} disabled={!custom}>
            <RotateCcw size={12} /> Reset
          </button>
        }
      />
    </>
  );
}

function RadarLiveRows() {
  // One selector each: the radar store changes on every frame of a loop, and a
  // whole-store subscription would redraw Settings with it.
  const smooth = useNexradStore((s) => s.smooth);
  const showRing = useNexradStore((s) => s.showRing);
  const showTracks = useNexradStore((s) => s.showTracks);
  const showReadout = useNexradStore((s) => s.showReadout);
  const autoUpdate = useNexradStore((s) => s.autoUpdate);
  const r = useNexradStore.getState();
  const s = { smooth, showRing, showTracks, showReadout, autoUpdate, setSmooth: r.setSmooth, setShowRing: r.setShowRing, setShowTracks: r.setShowTracks, setShowReadout: r.setShowReadout, setAutoUpdate: r.setAutoUpdate };
  return (
    <>
      <Row label="Smooth radar data" hint="Blend between gates instead of drawing each one." control={<Switch on={s.smooth} label="Smooth radar data" onChange={s.setSmooth} />} />
      <Row label="Range ring" control={<Switch on={s.showRing} label="Range ring" onChange={s.setShowRing} />} />
      <Row label="Storm tracks" control={<Switch on={s.showTracks} label="Storm tracks" onChange={s.setShowTracks} />} />
      <Row label="Value under the pointer" control={<Switch on={s.showReadout} label="Value under the pointer" onChange={s.setShowReadout} />} />
      <Row label="Update with new scans" control={<Switch on={s.autoUpdate} label="Update with new scans" onChange={s.setAutoUpdate} />} />
    </>
  );
}

function UnitRows() {
  const radarUnits = useAppStore((s) => s.radarUnits);
  const setRadarUnit = useAppStore((s) => s.setRadarUnit);
  return (
    <>
      {UNIT_CHOICES.map(({ kind, label }) => {
        const options = UNITS_BY_KIND[kind] ?? [];
        const current = radarUnits[kind] ?? DEFAULT_UNIT[kind] ?? options[0]?.id;
        return (
          <Row
            key={kind}
            label={label}
            control={
              <Select
                value={current}
                onChange={(value) => setRadarUnit(kind, value)}
                aria-label={label}
                options={options.map((o) => ({ value: o.id, label: o.label }))}
              />
            }
          />
        );
      })}
    </>
  );
}

/** Gradient strip of a .pal table, so a bad import is visible at a glance. */
function PalStrip({ pal }: { pal: string }) {
  const table = parsePal(pal);
  if (table.entries.length < 2) return null;
  const { vmin, vmax } = buildLut(table);
  return (
    <div className="palstrip">
      <div className="palstrip__bar" style={{ background: `linear-gradient(to right, ${palGradient(table)})` }} />
      <div className="palstrip__scale">
        <span>{vmin}</span>
        <span>{vmax}</span>
      </div>
    </div>
  );
}

/** Import + manage GRLevelX .pal colour tables for the radar. */
function PaletteBlock() {
  const custom = usePaletteStore((s) => s.custom);
  const overrides = usePaletteStore((s) => s.overrides);
  const add = usePaletteStore((s) => s.add);
  const remove = usePaletteStore((s) => s.remove);
  const setTarget = usePaletteStore((s) => s.setTarget);
  const builtins = useNexradStore((s) => s.palettes);
  const loadCatalog = useNexradStore((s) => s.loadCatalog);
  const repaint = useNexradStore((s) => s.repaint);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  // the built-in list comes from the backend; Settings can be opened first
  useEffect(() => {
    if (!builtins.length) void loadCatalog();
  }, [builtins.length, loadCatalog]);

  const targetOf = (id: string) => Object.entries(overrides).find(([, v]) => v === id)?.[0] ?? "";

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setAdded(null);
    const ok: string[] = [];
    for (const file of Array.from(files)) {
      const res = add(file.name, await file.text());
      if (!res.ok) {
        setError(`${file.name}: ${res.error}`);
        break;
      }
      const where = res.target ? ` → replaces ${res.target}` : " (pick what it replaces below)";
      ok.push(`${file.name}${where}`);
    }
    if (ok.length) {
      setAdded(ok.join(", "));
      repaint(); // the radar may be showing the palette we just replaced
    }
    if (fileRef.current) fileRef.current.value = ""; // re-importing the same file should re-fire
  };

  return (
    <div className="setx__block">
      <p className="setx__hint">
        GRLevelX <code>.pal</code> files, in real data units (dBZ, kt). An imported table replaces a built-in one, so every
        product using it picks it up. A <code>Product:</code> line wires it up automatically.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".pal,text/plain"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button type="button" className="btn-reset" onClick={() => fileRef.current?.click()}>
        <Upload size={14} /> Import .pal file
      </button>
      {error && <div className="sv__notice">{error}</div>}
      {added && !error && <div className="setx__hint" style={{ color: "var(--accent-text)" }}>Imported {added}</div>}
      {custom.length > 0 && (
        <ul className="pallist">
          {custom.map((p) => (
            <li key={p.id} className="pallist__item">
              <div className="pallist__head">
                <span className="pallist__name" title={p.label}>
                  {p.label}
                  {p.product && <em className="pallist__prod"> {p.product}</em>}
                </span>
                <button
                  type="button"
                  className="pallist__del"
                  onClick={() => {
                    remove(p.id);
                    repaint();
                  }}
                  title={`Remove ${p.label}`}
                  aria-label={`Remove ${p.label}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <PalStrip pal={p.pal} />
              <label className="pallist__target">
                <span>Replaces</span>
                <Select
                  value={targetOf(p.id)}
                  onChange={(value) => {
                    setTarget(p.id, value);
                    repaint();
                  }}
                  aria-label="Which product this palette replaces"
                  options={[{ value: "", label: "— not used —" }, ...builtins.map((b) => ({ value: b.id, label: b.label }))]}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ALERT_CATEGORIES: { key: AlertCategoryKey; label: string }[] = [
  { key: "tornado", label: "Tornado alerts on the map" },
  { key: "severe", label: "Severe alerts on the map" },
  { key: "special", label: "Special statements on the map" },
];

function AlertCategoryRows() {
  const filters = useAlertStore((s) => s.categoryFilters);
  const set = useAlertStore((s) => s.setCategoryFilter);
  return (
    <>
      {ALERT_CATEGORIES.map((c) => (
        <Row key={c.key} label={c.label} control={<Switch on={filters[c.key]} label={c.label} onChange={(v) => set(c.key, v)} />} />
      ))}
    </>
  );
}

function ObservationRows() {
  const showLines = useObsStore((s) => s.showLines);
  const showBarbs = useObsStore((s) => s.showBarbs);
  const showPlaces = useObsStore((s) => s.showPlaces);
  const showEdge = useObsStore((s) => s.showEdge);
  const o = useObsStore.getState();
  const s = { showLines, showBarbs, showPlaces, showEdge, setShowLines: o.setShowLines, setShowBarbs: o.setShowBarbs, setShowPlaces: o.setShowPlaces, setShowEdge: o.setShowEdge };
  return (
    <>
      <Row label="Contour lines" control={<Switch on={s.showLines} label="Contour lines" onChange={s.setShowLines} />} />
      <Row label="Wind barbs" control={<Switch on={s.showBarbs} label="Wind barbs" onChange={s.setShowBarbs} />} />
      <Row label="Places and values" control={<Switch on={s.showPlaces} label="Places and values" onChange={s.setShowPlaces} />} />
      <Row label="Edge of the analysis" control={<Switch on={s.showEdge} label="Edge of the analysis" onChange={s.setShowEdge} />} />
    </>
  );
}

function SurfaceRows() {
  // Picked field by field: the store also carries the layer's fetch status,
  // which changes on every refresh.
  const s = useSurfaceObsStore(
    useShallow((st) => ({
      size: st.size, setSize: st.setSize, spacing: st.spacing, setSpacing: st.setSpacing,
      maxAgeMin: st.maxAgeMin, setMaxAgeMin: st.setMaxAgeMin, fadeStale: st.fadeStale, setFadeStale: st.setFadeStale,
      tempUnits: st.tempUnits, setTempUnits: st.setTempUnits, windUnits: st.windUnits, setWindUnits: st.setWindUnits,
      presUnits: st.presUnits, setPresUnits: st.setPresUnits, visUnits: st.visUnits, setVisUnits: st.setVisUnits,
    })),
  );
  return (
    <>
      <Row
        label="Plot size"
        control={<span className="setx__value">{s.size.toFixed(2)}×</span>}
        below={<input className="setx__range" type="range" min={0.6} max={2} step={0.05} value={s.size} onChange={(e) => s.setSize(Number(e.target.value))} aria-label="Plot size" />}
      />
      <Row
        label="Space between stations"
        control={<span className="setx__value">{s.spacing} px</span>}
        below={<input className="setx__range" type="range" min={20} max={160} step={5} value={s.spacing} onChange={(e) => s.setSpacing(Number(e.target.value))} aria-label="Space between stations" />}
      />
      <Row
        label="Oldest observation shown"
        control={<span className="setx__value">{s.maxAgeMin === AGE_UNLIMITED ? "no limit" : `${s.maxAgeMin} min`}</span>}
        below={<input className="setx__range" type="range" min={0} max={360} step={15} value={s.maxAgeMin} onChange={(e) => s.setMaxAgeMin(Number(e.target.value))} aria-label="Oldest observation shown" />}
      />
      <Row label="Dim older observations" control={<Switch on={s.fadeStale} label="Dim older observations" onChange={s.setFadeStale} />} />
      <Row label="Temperature" control={<Segmented value={s.tempUnits} onChange={s.setTempUnits} options={[{ v: "F", label: "°F" }, { v: "C", label: "°C" }]} />} />
      <Row label="Wind" control={<Segmented value={s.windUnits} onChange={s.setWindUnits} options={[{ v: "kt", label: "kt" }, { v: "mph", label: "mph" }, { v: "ms", label: "m/s" }]} />} />
      <Row label="Pressure" control={<Segmented value={s.presUnits} onChange={s.setPresUnits} options={[{ v: "mb", label: "mb" }, { v: "inHg", label: "inHg" }]} />} />
      <Row label="Visibility" control={<Segmented value={s.visUnits} onChange={s.setVisUnits} options={[{ v: "mi", label: "mi" }, { v: "km", label: "km" }]} />} />
    </>
  );
}

// ------------------------------------------------------------------ layout ---

interface Extra {
  /** Words the search matches for this block. */
  terms: string;
  group?: string;
  render: () => ReactNode;
}

interface UiSection {
  id: string;
  label: string;
  icon: ReactNode;
  description?: string;
  /** Rows kept in other stores, drawn before the schema's. */
  before?: Extra[];
  /** The schema section whose rows follow. */
  schema?: string;
  after?: Extra[];
}

const UI_SECTIONS: UiSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings2 size={14} />,
    description: "Theme, motion, coordinates and the guides.",
    before: [
      { terms: "theme light dark auto", render: () => <ThemeRow /> },
      { terms: "reduce motion animation", render: () => <MotionRow /> },
      { terms: "coordinates decimal dms degrees", render: () => <CoordinatesRow /> },
      { terms: "projection globe flat mercator", render: () => <ProjectionRow /> },
      { terms: "guides quick start what's new release", group: "Guides", render: () => <GuidesBlock /> },
    ],
  },
  {
    id: "layout",
    label: "Layout",
    icon: <LayoutPanelLeft size={14} />,
    description: "Where the panels sit.",
    before: [{ terms: "layout panel side alert rail left right floating tools reset", render: () => <LayoutBlock /> }],
  },
  { id: "map", label: "Map", icon: <MapIcon size={14} />, schema: "map" },
  {
    id: "radar",
    label: "Radar",
    icon: <Radar size={14} />,
    before: [
      { terms: "smooth range ring storm tracks value pointer readout update scans", group: "Display", render: () => <RadarLiveRows /> },
    ],
    schema: "radar",
    after: [
      { terms: "units velocity kt knots m/s mph", group: "Units", render: () => <UnitRows /> },
      { terms: "palette colour color table pal grlevelx import", group: "Colour palettes", render: () => <PaletteBlock /> },
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    icon: <AlertTriangle size={14} />,
    before: [{ terms: "category tornado severe special map filter", group: "On the map", render: () => <AlertCategoryRows /> }],
    schema: "alerts",
  },
  { id: "lsr", label: "Storm reports", icon: <Megaphone size={14} />, schema: "lsr" },
  { id: "md", label: "Mesoscale discussions", icon: <MessageSquareWarning size={14} />, schema: "md" },
  { id: "outlooks", label: "Outlooks", icon: <Layers size={14} />, schema: "outlooks" },
  {
    id: "observations",
    label: "Observations",
    icon: <Eye size={14} />,
    description: "HRRR, RAP and RTMA analyses.",
    before: [{ terms: "contour lines wind barbs places values edge analysis", render: () => <ObservationRows /> }],
  },
  {
    id: "surface",
    label: "Surface stations",
    icon: <Wind size={14} />,
    description: "METAR station plots.",
    before: [
      { terms: "metar station plot size spacing declutter age stale units temperature wind pressure visibility", render: () => <SurfaceRows /> },
    ],
  },
  { id: "pressure", label: "Pressure & thickness", icon: <Gauge size={14} />, schema: "pressure" },
  { id: "markers", label: "Soundings & profilers", icon: <Thermometer size={14} />, schema: "markers" },
  {
    id: "chasers",
    label: "Chasers",
    icon: <Users size={14} />,
    before: [{ terms: "share position broadcast location chasers", render: () => <ShareRow /> }],
    schema: "chasers",
  },
  { id: "timeline", label: "Timeline & playback", icon: <Clock size={14} />, schema: "timeline" },
];

const SCHEMA_BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));

const matches = (query: string, ...texts: (string | undefined)[]) =>
  texts.some((t) => t?.toLowerCase().includes(query));

function Section({ section, query, open, onToggle }: { section: UiSection; query: string; open: boolean; onToggle: () => void }) {
  const schema = section.schema ? SCHEMA_BY_ID.get(section.schema) : undefined;
  const values = useSettingsStore((s) => s.values);
  const resetSection = useSettingsStore((s) => s.resetSection);
  const changed = schema ? schema.items.filter((i) => values[i.key] !== undefined).length : 0;
  const description = section.description ?? schema?.description;

  // While searching, a section whose name matches shows everything in it;
  // otherwise only the rows that match.
  const q = query.trim().toLowerCase();
  const whole = !q || matches(q, section.label, description);
  const pick = (extras: Extra[] | undefined) => (extras ?? []).filter((e) => whole || matches(q, e.terms, e.group));
  const before = pick(section.before);
  const after = pick(section.after);
  const items = (schema?.items ?? []).filter((i) => whole || matches(q, i.label, i.hint, i.group));
  if (q && before.length + after.length + items.length === 0) return null;
  const expanded = open || Boolean(q);

  // Rows under their sub-headings, in order, a heading written once per run.
  const blocks: { group?: string; node: ReactNode; key: string }[] = [
    ...before.map((e, i) => ({ group: e.group, node: e.render(), key: `b${i}` })),
    ...items.map((d) => ({ group: d.group, node: <SchemaRow def={d} />, key: d.key })),
    ...after.map((e, i) => ({ group: e.group, node: e.render(), key: `a${i}` })),
  ];

  return (
    <section className={`setx__sec${expanded ? " is-open" : ""}`}>
      <button type="button" className="setx__head" onClick={onToggle} aria-expanded={expanded}>
        <span className="setx__icon">{section.icon}</span>
        <span className="setx__title">{section.label}</span>
        {changed > 0 && <span className="setx__badge">{changed} changed</span>}
        <ChevronDown size={14} className="setx__chev" />
      </button>
      {expanded && (
        <div className="setx__body">
          {description && <p className="setx__desc">{description}</p>}
          {blocks.map((b, i) => (
            <div key={b.key}>
              {b.group && b.group !== blocks[i - 1]?.group && <h5 className="setx__group">{b.group}</h5>}
              {b.node}
            </div>
          ))}
          {changed > 0 && (
            <button type="button" className="setx__btn setx__btn--section" onClick={() => resetSection(schema!.id)}>
              <RotateCcw size={12} /> Reset {section.label.toLowerCase()} to defaults
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The Settings drawer: every option in the app, by function, with a search. */
export function SettingsContent() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["general"]));
  const resetAll = useSettingsStore((s) => s.resetAll);
  const setProjection = useAppStore((s) => s.setProjection);
  const setReduceMotion = useAppStore((s) => s.setReduceMotion);
  const setCoordFormat = useAppStore((s) => s.setCoordFormat);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const setSharing = useChaserStore((s) => s.setSharing);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const restoreEverything = () => {
    resetAll();
    setProjection("mercator");
    setReduceMotion(false);
    setCoordFormat("decimal");
    setThemeMode("auto");
    // Restoring defaults must never leave a location broadcast running.
    setSharing(false);
    getMap()?.flyTo({ center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom, bearing: 0, pitch: 0, essential: true });
  };

  return (
    <div className="content setx">
      <div className="setx__search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
        />
        {query && (
          <button type="button" className="setx__clear" onClick={() => setQuery("")} aria-label="Clear search">
            <X size={13} />
          </button>
        )}
      </div>

      {UI_SECTIONS.map((section) => (
        <Section key={section.id} section={section} query={query} open={open.has(section.id)} onToggle={() => toggle(section.id)} />
      ))}

      <div className="setx__foot">
        <button type="button" className="btn-reset" onClick={() => setOpen(new Set(UI_SECTIONS.map((s) => s.id)))}>
          Open every section
        </button>
        <button type="button" className="btn-reset" onClick={restoreEverything}>
          <RotateCcw size={14} /> Restore all defaults
        </button>
      </div>
    </div>
  );
}
