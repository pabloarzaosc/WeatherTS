import { useEffect } from "react";
import { AlertTriangle, Loader2, Radio } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { frameChoicesFor, useNexradStore } from "../../store/useNexradStore";
import { getMap } from "../../map/mapInstance";

const LAYER = "nexrad";

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

/** unix seconds -> the "YYYY-MM-DDTHH:mm" a datetime-local input wants, in local time. */
function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The slider bounds for the threshold, from the product's own scale. */
function thresholdRange(vmin: number, vmax = 80): [number, number] {
  return [Math.floor(vmin), Math.ceil(vmax)];
}
const DEFAULT_THRESHOLD = 5;

function fmtValid(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/** Radar panel — NEXRAD single-site Level III: site + archive. */
export function RadarView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const sites = useNexradStore((s) => s.sites);
  const site = useNexradStore((s) => s.site);
  const scans = useNexradStore((s) => s.scans);
  const scan = useNexradStore((s) => s.scan);
  const warm = useNexradStore((s) => s.warm);
  const frames = useNexradStore((s) => s.frames);
  const product = useNexradStore((s) => s.product);
  const archiveTime = useNexradStore((s) => s.archiveTime);
  const setArchiveTime = useNexradStore((s) => s.setArchiveTime);
  const archiveDate = useNexradStore((s) => s.archiveDate);
  const setArchiveDate = useNexradStore((s) => s.setArchiveDate);
  const isL2 = product.startsWith("L2");
  const showRing = useNexradStore((s) => s.showRing);
  const setShowRing = useNexradStore((s) => s.setShowRing);
  const smooth = useNexradStore((s) => s.smooth);
  const setSmooth = useNexradStore((s) => s.setSmooth);
  const threshold = useNexradStore((s) => s.threshold);
  const setThreshold = useNexradStore((s) => s.setThreshold);
  const autoUpdate = useNexradStore((s) => s.autoUpdate);
  const setAutoUpdate = useNexradStore((s) => s.setAutoUpdate);
  const setFrames = useNexradStore((s) => s.setFrames);
  const loading = useNexradStore((s) => s.loading);
  const error = useNexradStore((s) => s.error);
  const loadCatalog = useNexradStore((s) => s.loadCatalog);
  const selectSite = useNexradStore((s) => s.selectSite);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const jumpTo = (id: string) => {
    const s = sites.find((x) => x.id === id);
    if (s) getMap()?.flyTo({ center: [s.lon, s.lat], zoom: 7.2, essential: true });
  };

  const usSites = sites.filter((s) => s.country === "US");

  return (
    <div className="sfcobs">
      <div className={`sfcobs__enable${error ? " is-error" : ""}`}>
        <span>{error ? "Radar not working" : "Enable Radar"}</span>
        <Toggle
          on={enabled}
          onClick={() => setLayerVisible(LAYER, !enabled)}
        />
      </div>

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button
            type="button"
            className="sfcobs__retry"
            onClick={() => {
              // Clear first so the panel shows the attempt rather than sitting
              // on the stale message; loadCatalog restores it if it fails again.
              useNexradStore.setState({ error: null });
              void useNexradStore.getState().loadCatalog();
            }}
          >
            Retry
          </button>
        </div>
      )}

      <label className="sfcobs__field">
        <span className="sfcobs__label">Radar site ({usSites.length})</span>
        <select
          value={site ?? ""}
          onChange={(e) => {
            const id = e.target.value || null;
            selectSite(id);
            if (id) {
              if (!enabled) setLayerVisible(LAYER, true);
              jumpTo(id);
            }
          }}
        >
          <option value="">— pick a site (or click one on the map) —</option>
          {usSites.map((s) => (
            <option
              key={s.id}
              value={s.id}
              disabled={s.online === false}
              style={{ color: s.online === false ? "#d33" : undefined }}
            >
              {s.icao} — {s.name}{s.online === false ? " (offline)" : ""}
            </option>
          ))}
        </select>
      </label>

      {scan?.meta.vcp != null && (
        <div className="sfcobs__vcp">
          <div className="sfcobs__row">
            <span>VCP</span>
            <b style={{ fontFamily: "var(--mono)" }}>{scan.meta.vcp}</b>
          </div>
          {scan.meta.mode && (
            <div className="sfcobs__row">
              <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{scan.meta.mode}</span>
            </div>
          )}
        </div>
      )}

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Loop length{product.startsWith("L2") ? " — super-res, ~7 MB/frame" : ""}
        </span>
        <select value={frames} onChange={(e) => setFrames(Number(e.target.value))}>
          {frameChoicesFor(product).map((n) => (
            <option key={n} value={n}>
              {n} frames{n >= 200 ? " (heavy)" : ""}
            </option>
          ))}
        </select>
      </label>

      {/* Products + tilt now live on the map, top-right (RadarProductPanel):
          the grids here were cramped and duplicated that control. */}

      <div className="sfcobs__section">Display</div>
      <div className="sfcobs__toggle-row">
        <span>Range ring</span>
        <Toggle on={showRing} onClick={() => setShowRing(!showRing)} />
      </div>
      <div className="sfcobs__toggle-row">
        <span>Smooth radar data</span>
        <Toggle on={smooth} onClick={() => setSmooth(!smooth)} />
      </div>
      <div className="sfcobs__toggle-row">
        <span>Threshold</span>
        <Toggle
          on={threshold !== null}
          onClick={() => setThreshold(threshold === null ? DEFAULT_THRESHOLD : null)}
        />
      </div>
      {threshold !== null && (
        <label className="sfcobs__field">
          <span className="sfcobs__label">
            Hide below <b style={{ fontFamily: "var(--mono)" }}>{threshold.toFixed(1)}</b>{" "}
            {scan?.meta.units}
          </span>
          <input
            type="range"
            min={thresholdRange(scan?.meta.vmin ?? -30)[0]}
            max={thresholdRange(scan?.meta.vmax ?? 80)[1]}
            step={0.5}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
      )}

      <div className="sfcobs__section">Timeline</div>
      <div className="sfcobs__toggle-row">
        <span>Auto update</span>
        <Toggle on={autoUpdate} onClick={() => setAutoUpdate(!autoUpdate)} />
      </div>
      {/* Level 2 frames are whole ~7 MB volumes and the source keeps only ~48 h,
          so a whole day (~2 GB) simply isn't on offer -- the control goes away
          rather than sitting there failing. */}
      {!isL2 && (
        <label className="sfcobs__field">
          <span className="sfcobs__label">
            Whole day{archiveDate ? " — every scan" : ""}
          </span>
          <input
            type="date"
            value={archiveDate ?? ""}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => void setArchiveDate(e.target.value || null)}
          />
        </label>
      )}

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Start from{archiveTime !== null ? " — archive" : " — live"}
          {isL2 ? " (last 48 h)" : ""}
        </span>
        <input
          type="datetime-local"
          value={archiveTime !== null ? toLocalInput(archiveTime) : ""}
          min={isL2 ? toLocalInput(Math.floor(Date.now() / 1000) - 48 * 3600) : undefined}
          max={toLocalInput(Math.floor(Date.now() / 1000))}
          onChange={(e) => {
            const v = e.target.value;
            setArchiveTime(v ? Math.floor(new Date(v).getTime() / 1000) : null);
          }}
        />
      </label>
      {(archiveTime !== null || archiveDate) && (
        <div className="sfcobs__row">
          <button
            type="button"
            className="sfcobs__live"
            onClick={() => {
              setArchiveTime(null);
              void setArchiveDate(null);
            }}
          >
            <Radio size={11} /> Back to live
          </button>
        </div>
      )}

      {!error && <div className="sfcobs__section">Scan</div>}
      {loading && (
        <div className="sfcobs__row">
          <span>
            <Loader2 size={13} className="spin" /> Loading scan…
          </span>
        </div>
      )}
      {!loading && !error && scan && (
        <>
          <div className="sfcobs__row">
            <span>{scan.meta.site}</span>
            <b style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{fmtValid(scan.meta.validUnix)}</b>
          </div>
          <div className="sfcobs__row">
            <span>{scan.meta.productLabel}</span>
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
              {scan.meta.elevation !== null ? `${scan.meta.elevation.toFixed(1)}° ` : ""}
              {scan.meta.units}
            </span>
          </div>
          <div className="sfcobs__row">
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
              {scans.length} scans — scrub/play on the timeline
            </span>
          </div>
          <div className="sfcobs__row">
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
              {warm >= scans.length ? (
                <>All {scans.length} frames cached — playback is instant</>
              ) : (
                <>
                  Caching frames… {warm}/{scans.length}
                </>
              )}
            </span>
          </div>
          {archiveTime === null && (
            <div className="sfcobs__row">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--accent)" }}>
                <Radio size={11} />
                Live — auto-updates on each new scan
              </span>
            </div>
          )}
        </>
      )}
      {!loading && !error && !scan && !site && (
        <div className="sfcobs__row">
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            Pick a site above or click a blue dot on the map.
          </span>
        </div>
      )}
    </div>
  );
}
