import { AlertTriangle, Loader2 } from "lucide-react";

import { ACARS_WINDOWS, useAcarsStore, type AcarsWindow } from "../../store/useAcarsStore";

/** Cut-offs offered for "hide the stale ones". Null is the whole window. */
const AGE_CHOICES: { v: number | null; label: string }[] = [
  { v: null, label: "any age" },
  { v: 30, label: "30 min" },
  { v: 60, label: "1 h" },
  { v: 120, label: "2 h" },
  { v: 240, label: "4 h" },
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

function fmtUpdated(ms: number | null): string {
  if (!ms) return "never";
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? "just now" : `${min} min ago`;
}

/**
 * ACARS feed settings, inside the Sounding panel.
 *
 * Not a category of its own: an aircraft ascent is a sounding, so its controls
 * belong with the other soundings rather than behind a separate button.
 *
 * Everything except the window filters the map in place rather than refetching:
 * MADIS publishes hourly, so asking it again for a narrower slice of the same
 * hour would spend a request to receive the same rows.
 */
export function AcarsView() {
  const windowH = useAcarsStore((s) => s.windowH);
  const setWindowH = useAcarsStore((s) => s.setWindowH);
  const maxAgeMin = useAcarsStore((s) => s.maxAgeMin);
  const setMaxAgeMin = useAcarsStore((s) => s.setMaxAgeMin);
  const minLevels = useAcarsStore((s) => s.minLevels);
  const setMinLevels = useAcarsStore((s) => s.setMinLevels);
  const showLabels = useAcarsStore((s) => s.showLabels);
  const setShowLabels = useAcarsStore((s) => s.setShowLabels);

  const busy = useAcarsStore((s) => s.busy);
  const error = useAcarsStore((s) => s.error);
  const total = useAcarsStore((s) => s.total);
  const shown = useAcarsStore((s) => s.shown);
  const lastUpdatedAt = useAcarsStore((s) => s.lastUpdatedAt);

  return (
    <div className="sfcobs">
      <div className="sfcobs__section">Aircraft (ACARS) feed</div>

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <label className="sfcobs__field">
        <span className="sfcobs__label">Window — how far back to look</span>
        <select
          value={windowH}
          onChange={(e) => setWindowH(Number(e.target.value) as AcarsWindow)}
        >
          {ACARS_WINDOWS.map((h) => (
            <option key={h} value={h}>
              last {h} h
            </option>
          ))}
        </select>
      </label>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          Ascents are sparse away from the hubs — a longer window trades
          currency for coverage.
        </span>
      </div>

      <div className="sfcobs__section">Filters</div>

      <label className="sfcobs__field">
        <span className="sfcobs__label">Hide profiles older than</span>
        <select
          value={maxAgeMin === null ? "" : String(maxAgeMin)}
          onChange={(e) => setMaxAgeMin(e.target.value === "" ? null : Number(e.target.value))}
        >
          {AGE_CHOICES.map((c) => (
            <option key={c.label} value={c.v === null ? "" : c.v}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Minimum levels{" "}
          <b style={{ fontFamily: "var(--mono)" }}>{minLevels === 0 ? "any" : minLevels}</b>
        </span>
        <input
          type="range"
          min={0}
          max={60}
          step={5}
          value={minLevels}
          onChange={(e) => setMinLevels(Number(e.target.value))}
        />
      </label>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          A six-level ascent is a climb-out that stopped, not a sounding worth
          opening.
        </span>
      </div>

      <div className="sfcobs__toggle-row">
        <span>Airport identifiers</span>
        <Toggle on={showLabels} onClick={() => setShowLabels(!showLabels)} />
      </div>

      <div className="sfcobs__section">
        Feed{busy && <Loader2 size={12} className="spin" style={{ marginLeft: 6 }} />}
      </div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          {shown} shown of {total} airports · updated {fmtUpdated(lastUpdatedAt)}
        </span>
      </div>
    </div>
  );
}
