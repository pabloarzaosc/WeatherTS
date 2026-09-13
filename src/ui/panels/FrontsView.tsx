import { useEffect, useMemo } from "react";
import { AlertTriangle, Globe2, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useModelStore } from "../../store/useModelStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import { ModelBar } from "../ModelBar";
import { PressureView } from "./PressureView";
import { CATEGORY_ORDER, type ModelInfo } from "../../lib/modelFields";
import {
  DEFAULT_FRONTS_MODEL,
  FRONT_COLORS,
  FRONT_DESCRIPTIONS,
  FRONT_KINDS,
  FRONT_LABELS,
  FRONT_REGIONS,
  modelServesRegion,
  type FrontKind,
  type FrontRegion,
  type FrontSource,
} from "../../lib/fronts";
import { selectFrontView, sourceOf, sourcesFor, useFrontsStore } from "../../store/useFrontsStore";

const LAYER = "fronts";

const SOURCE_CHOICE: Record<FrontSource, string> = { wpc: "WPC analysis", gfs: "Model" };

const serves = (m: ModelInfo, r: FrontRegion) => modelServesRegion(m.global ? null : m.footprint, r);

/** "Europe", "Europe and Asia", "Europe, Asia and Oceania". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

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

function fmtValid(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}Z`;
}

/**
 * A miniature of the real symbology, so the legend shows the line the map draws
 * rather than a coloured swatch the reader has to translate.
 */
function FrontSample({ kind }: { kind: FrontKind }) {
  const lineColor = kind === "stationary" ? FRONT_COLORS.cold : FRONT_COLORS[kind];
  const triColor = kind === "stationary" ? FRONT_COLORS.cold : FRONT_COLORS[kind];
  const bumpColor = kind === "stationary" ? FRONT_COLORS.warm : FRONT_COLORS[kind];
  const hasTri = kind === "cold" || kind === "stationary" || kind === "occluded";
  const hasBump = kind === "warm" || kind === "stationary" || kind === "occluded";
  // On a stationary front the pips sit on OPPOSITE flanks; everywhere else they
  // share one side, exactly as the map draws them.
  const bumpBelow = kind === "stationary";

  return (
    <svg width={42} height={17} viewBox="0 0 42 17" aria-hidden="true" style={{ flex: "none" }}>
      <line
        x1={1}
        x2={41}
        y1={9}
        y2={9}
        stroke={lineColor}
        strokeWidth={2}
        strokeDasharray={kind === "trough" ? "4 3" : undefined}
      />
      {hasTri && <path d="M9 9L17 9L13 2Z" fill={triColor} />}
      {hasBump && (
        <path
          d={bumpBelow ? "M25 9a4 4 0 0 0 8 0Z" : "M25 9a4 4 0 0 1 8 0Z"}
          fill={bumpColor}
        />
      )}
    </svg>
  );
}

/** Surface analysis panel: where in the world, from which source and model,
 *  which chart, which features, and what they mean. */
export function FrontsView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const frames = useFrontsStore((s) => s.frames);
  const index = useFrontsStore((s) => s.index);
  const setIndex = useFrontsStore((s) => s.setIndex);
  const kinds = useFrontsStore((s) => s.kinds);
  const toggleKind = useFrontsStore((s) => s.toggleKind);
  const showCentres = useFrontsStore((s) => s.showCentres);
  const setShowCentres = useFrontsStore((s) => s.setShowCentres);
  const busy = useFrontsStore((s) => s.busy);
  const error = useFrontsStore((s) => s.error);
  const meta = useFrontsStore((s) => s.meta);
  const regions = useFrontsStore((s) => s.regions);
  const toggleRegion = useFrontsStore((s) => s.toggleRegion);
  const setWorld = useFrontsStore((s) => s.setWorld);
  const regionSources = useFrontsStore((s) => s.regionSources);
  const setRegionSource = useFrontsStore((s) => s.setRegionSource);
  const bySource = useFrontsStore((s) => s.bySource);
  const autoModel = useFrontsStore((s) => s.autoModel);
  const setAutoModel = useFrontsStore((s) => s.setAutoModel);
  const view = useFrontsStore(selectFrontView);

  // The model catalogue is shared with the pressure picker; it may not have
  // been asked for yet if this panel is opened first.
  const models = useModelStore((s) => s.models);
  useEffect(() => {
    void useModelStore.getState().load();
  }, []);

  // The marked regions whose fronts come from a model -- what the model has to
  // have data over.
  const autoRegions = useMemo(
    () => FRONT_REGIONS.filter((r) => regions.includes(r.id) && sourceOf(r, regionSources) === "gfs"),
    [regions, regionSources],
  );
  const allFrontModels = useMemo(() => models.filter((m) => m.fronts), [models]);
  // Only models with data over at least one of those regions: HRRR is offered
  // for North America, never for Europe. With none marked the pick has no
  // effect yet, so nothing is hidden.
  const frontModels = useMemo(
    () => allFrontModels.filter((m) => !autoRegions.length || autoRegions.some((r) => serves(m, r))),
    [allFrontModels, autoRegions],
  );
  const byCategory = useMemo(() => {
    const cats = [...new Set(frontModels.map((m) => m.category))].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
    );
    return cats.map((c) => [c, frontModels.filter((m) => m.category === c)] as const);
  }, [frontModels]);
  const model = models.find((m) => m.id === autoModel);
  const modelLabel = model?.label ?? bySource.gfs.meta?.modelLabel ?? autoModel;

  // A pick without data over the marked regions -- or one the catalogue no
  // longer offers for fronts -- would only ever draw nothing.
  useEffect(() => {
    if (frontModels.length && !frontModels.some((m) => m.id === autoModel)) setAutoModel(DEFAULT_FRONTS_MODEL);
  }, [frontModels, autoModel, setAutoModel]);

  // Load what an open panel needs -- but not again after a failure. Without
  // the `error` check this re-fired the moment a failure cleared `busy`: one
  // request after another, against a server that was often the reason for
  // the failure. After an error, asking again is the Retry button.
  useEffect(() => {
    if (enabled && regions.length && !frames.length && !busy && !error) void useFrontsStore.getState().load();
  }, [enabled, regions.length, frames.length, busy, error]);

  const frame = frames[index];
  const world = regions.length === FRONT_REGIONS.length;
  const sources = sourcesFor(regions, regionSources);
  const automatic = sources.includes("gfs");
  const readingWpc = sources.includes("wpc") && bySource.wpc.busy && !bySource.wpc.frames.length;
  const readingModel = automatic && bySource.gfs.busy && !bySource.gfs.frames.length;
  const choosable = FRONT_REGIONS.filter((r) => r.sources.length > 1 && regions.includes(r.id));
  const autoNames = autoRegions.map((r) => r.label);
  const uncovered = model ? autoRegions.filter((r) => !serves(model, r)) : [];

  let note = "Pick a region to see its fronts.";
  if (regions.length) {
    const parts: string[] = [];
    if (sources.includes("wpc")) parts.push("North America is WPC forecasters' own analysis.");
    if (autoRegions.length) {
      parts.push(
        `${listOf(autoNames)} ${autoRegions.length > 1 ? "are" : "is"} found automatically in ${modelLabel}: ` +
          "right about where the systems are, less exact than a hand-drawn chart, and without occlusions or troughs.",
      );
      if (allFrontModels.length && frontModels.length < allFrontModels.length) {
        parts.push(`Listed: the ${frontModels.length} of ${allFrontModels.length} models with data over ${listOf(autoNames)}.`);
      }
      if (uncovered.length) {
        parts.push(
          `${modelLabel} has no data over ${listOf(uncovered.map((r) => r.label))}, so ` +
            `${uncovered.length > 1 ? "those stay" : "it stays"} empty.`,
        );
      }
    } else {
      parts.push("Set it to Model, or mark another region, to choose a model.");
    }
    note = parts.join(" ");
  }

  return (
    <div className="sfcobs">
      <LayerPower
        label="Surface Fronts"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button
            type="button"
            className="sfcobs__retry"
            onClick={() => void useFrontsStore.getState().load()}
          >
            Retry
          </button>
        </div>
      )}

      <div className="sfcobs__section">Regions</div>
      <div className="frontsv__regions">
        <button
          type="button"
          className={`frontsv__region frontsv__region--world${world ? " is-on" : ""}`}
          onClick={() => setWorld(!world)}
          aria-pressed={world}
        >
          <Globe2 size={13} />
          <span>Whole world</span>
        </button>
        {FRONT_REGIONS.map((r) => {
          const on = regions.includes(r.id);
          const src = sourceOf(r, regionSources);
          return (
            <button
              key={r.id}
              type="button"
              className={`frontsv__region${on ? " is-on" : ""}`}
              onClick={() => toggleRegion(r.id)}
              aria-pressed={on}
              title={src === "wpc" ? "Drawn by WPC forecasters" : `Found automatically in ${modelLabel}`}
            >
              <span>{r.label}</span>
              <em>{src === "wpc" ? "WPC" : "AUTO"}</em>
            </button>
          );
        })}
      </div>

      {choosable.map((r) => {
        const current = sourceOf(r, regionSources);
        return (
          <div key={r.id} className="frontsv__source">
            <span>{r.label} from</span>
            <div className="seg" role="group" aria-label={`${r.label} fronts from`}>
              {r.sources.map((src) => (
                <button
                  key={src}
                  type="button"
                  className={`seg__btn${current === src ? " is-active" : ""}`}
                  aria-pressed={current === src}
                  onClick={() => setRegionSource(r.id, src)}
                >
                  {SOURCE_CHOICE[src]}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <label className="sfcobs__field frontsv__model">
        <span className="sfcobs__label">Automatic fronts from</span>
        <Select
          value={autoModel}
          onChange={setAutoModel}
          disabled={!autoRegions.length || !frontModels.length}
          placeholder={modelLabel}
          aria-label="Automatic fronts from"
          options={byCategory.flatMap(([category, list]) =>
            list.map((m) => ({ value: m.id, label: m.label, hint: m.coverage, group: category })),
          )}
        />
      </label>
      <p className="frontsv__note">{note}</p>

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Chart{frame ? ` — ${frame.kind === "forecast" ? "forecast" : "analysis"}` : ""}
        </span>
        <Select
          value={String(index)}
          onChange={(value) => setIndex(Number(value))}
          disabled={!frames.length}
          aria-label="Chart"
          options={frames.map((f, i) => ({
            value: String(i),
            label: f.kind === "forecast" ? f.label : "Analysis",
            hint: fmtValid(f.validUnix),
          }))}
        />
      </label>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          {meta
            ? `${meta.analyses} analyses + ${meta.forecasts} progs — scrub on the timeline`
            : "…"}
        </span>
      </div>

      <div className="sfcobs__section">Features</div>
      <div className="frontsv__kinds">
        {FRONT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`frontsv__kind${kinds[k] ? " is-on" : ""}`}
            onClick={() => toggleKind(k)}
            aria-pressed={kinds[k]}
            title={FRONT_DESCRIPTIONS[k]}
          >
            <FrontSample kind={k} />
            <span>{FRONT_LABELS[k]}</span>
            <b>{view.counts[k] ?? 0}</b>
          </button>
        ))}
      </div>
      <div className="sfcobs__toggle-row">
        <span>
          Pressure centres
          {frame ? (
            <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>
              {(view.counts.high ?? 0) + (view.counts.low ?? 0)}
            </small>
          ) : null}
        </span>
        <Toggle on={showCentres} onClick={() => setShowCentres(!showCentres)} />
      </div>

      <div className="sfcobs__section">What they mean</div>
      <div className="frontsv__ref">
        {FRONT_KINDS.map((k) => (
          <div key={k} className="frontsv__desc">
            <FrontSample kind={k} />
            <div>
              <b>{FRONT_LABELS[k]}</b>
              <span>{FRONT_DESCRIPTIONS[k]}</span>
            </div>
          </div>
        ))}
      </div>

      {(readingWpc || readingModel) && (
        <div className="sfcobs__row">
          <span>
            <Loader2 size={13} className="spin" />{" "}
            {readingWpc && readingModel
              ? `Reading WPC's bulletin and finding fronts in ${modelLabel}…`
              : readingModel
                ? `Finding fronts in ${modelLabel}…`
                : "Reading the coded bulletin…"}
          </span>
        </div>
      )}

      <div className="sfcobs__section">Pressure</div>
      <p className="frontsv__note">
        The other half of a surface chart: isobars and the H / L centres, from any model that
        publishes sea level pressure. It has its own model and its own hour on the timeline, so the
        pressure pattern can come from a model while the fronts stay WPC's.
      </p>
      <ModelBar />
      <PressureView />
    </div>
  );
}
