import { useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import {
  FRONT_COLORS,
  FRONT_DESCRIPTIONS,
  FRONT_KINDS,
  FRONT_LABELS,
  type FrontKind,
} from "../../lib/fronts";
import { useFrontsStore } from "../../store/useFrontsStore";

const LAYER = "fronts";

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

/** Surface analysis panel: which chart, which features, and what they mean. */
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

  useEffect(() => {
    if (enabled && !frames.length && !busy) void useFrontsStore.getState().load();
  }, [enabled, frames.length, busy]);

  const frame = frames[index];

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

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Chart{frame ? ` — ${frame.kind === "forecast" ? "forecast" : "analysis"}` : ""}
        </span>
        <select
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          disabled={!frames.length}
        >
          {frames.map((f, i) => (
            <option key={f.id} value={i}>
              {f.kind === "forecast" ? f.label : "Analysis"} — {fmtValid(f.validUnix)}
            </option>
          ))}
          {!frames.length && <option value={-1}>—</option>}
        </select>
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
            <b>{frame?.counts?.[k] ?? 0}</b>
          </button>
        ))}
      </div>
      <div className="sfcobs__toggle-row">
        <span>
          Pressure centres
          {frame ? (
            <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>
              {(frame.counts.high ?? 0) + (frame.counts.low ?? 0)}
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

      {busy && !frames.length && (
        <div className="sfcobs__row">
          <span>
            <Loader2 size={13} className="spin" /> Reading the coded bulletin…
          </span>
        </div>
      )}
    </div>
  );
}
