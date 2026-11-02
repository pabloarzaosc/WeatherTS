import { useEffect } from "react";
import { AlertTriangle, Layers, Loader2, Radio } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { DetectionsOverlayRow } from "../RadarDetectionsCard";
import { RadarOfficeRow } from "../ForecastOfficePanel";
import { Select } from "../Select";
import { useNexradStore } from "../../store/useNexradStore";
import { LoopLength } from "../LoopLength";
import { FramesButton } from "../FramesPanel";
import { getMap } from "../../map/mapInstance";
import { isBrazilSite } from "../../lib/brazilRadar";
import { useObsStore } from "../../store/useObsStore";
import { useProductInfoStore } from "../../store/useProductInfoStore";
import { VelocityOptions } from "../VelocityOptions";
import { RadarDisplayOptions } from "../RadarDisplayOptions";
import { AllRadarsButton, RadarSiteInfo } from "../RadarSiteInfo";
import { siteClass, siteIsDown, useRadarSitesStore } from "../../store/useRadarSitesStore";

/** A radar's live standing as a hint in the site picker (radar-sites). */
function siteHint(id: string): string | undefined {
  const c = siteClass(id);
  return c === "down" ? "down" : c === "stale" ? "no new data" : c === "late" ? "late" : undefined;
}

/** Opens the product info panel; the Shift readout needs no switch. */
function ProductInfoRow() {
  const open = useProductInfoStore((s) => s.open);
  const setOpen = useProductInfoStore((s) => s.setOpen);
  return (
    <div className="sfcobs__toggle-row">
      <span>
        Product info
        <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>hold Shift over the map for the full readout</small>
      </span>
      <Toggle on={open} onClick={() => setOpen(!open)} />
    </div>
  );
}

const LAYER = "nexrad";

/** The national mosaic's most-used products, one click from the radar: each
 *  opens on the Models layer, where the rest of MRMS and its loop are. */
const MOSAIC: { source: string; field: string; label: string }[] = [
  { source: "mrms", field: "mr_cref", label: "Composite reflectivity" },
  { source: "mrms", field: "mr_rms", label: "Rain / mix / snow" },
  { source: "mrms", field: "mr_mesh240", label: "Hail swaths (4 h)" },
  { source: "mrms", field: "mr_rot240", label: "Rotation tracks (4 h)" },
  { source: "mrms", field: "mr_cg5", label: "Lightning density" },
  { source: "mrms", field: "mr_et18", label: "Echo tops" },
  { source: "mrms", field: "mr_ro24h", label: "24-h rainfall" },
  { source: "mrms-flash", field: "mf_arimax", label: "Flash flood (ARI)" },
];

function MosaicShortcuts() {
  const obsOn = useAppStore((s) => s.layers.observations?.visible ?? false);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const open = (m: (typeof MOSAIC)[number]) => {
    const obs = useObsStore.getState();
    if (obs.source !== m.source) obs.setSource(m.source);
    useObsStore.getState().setField(m.field);
    if (!useAppStore.getState().layers.observations?.visible) useAppStore.getState().setLayerVisible("observations", true);
  };
  return (
    <>
      <div className="sfcobs__section">National mosaic · MRMS</div>
      <div className="radarv__mosaic">
        {MOSAIC.map((m) => {
          const on = obsOn && source === m.source && field === m.field;
          return (
            <button
              key={m.field}
              type="button"
              className={on ? "is-on" : ""}
              aria-pressed={on}
              onClick={() => open(m)}
              title="Every radar merged, every two minutes -- drawn on the Models layer"
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Layers size={11} /> 130+ more MRMS products under Models
        </span>
      </div>
    </>
  );
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
  const product = useNexradStore((s) => s.product);
  const archiveTime = useNexradStore((s) => s.archiveTime);
  const setArchiveTime = useNexradStore((s) => s.setArchiveTime);
  const archiveDate = useNexradStore((s) => s.archiveDate);
  const setArchiveDate = useNexradStore((s) => s.setArchiveDate);
  const isL2 = product.startsWith("L2");
  const showRing = useNexradStore((s) => s.showRing);
  const setShowRing = useNexradStore((s) => s.setShowRing);
  const showTracks = useNexradStore((s) => s.showTracks);
  const setShowTracks = useNexradStore((s) => s.setShowTracks);
  const storms = useNexradStore((s) => s.storms);
  const smooth = useNexradStore((s) => s.smooth);
  const setSmooth = useNexradStore((s) => s.setSmooth);
  const showReadout = useNexradStore((s) => s.showReadout);
  const setShowReadout = useNexradStore((s) => s.setShowReadout);
  const threshold = useNexradStore((s) => s.threshold);
  const setThreshold = useNexradStore((s) => s.setThreshold);
  const autoUpdate = useNexradStore((s) => s.autoUpdate);
  const setAutoUpdate = useNexradStore((s) => s.setAutoUpdate);
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

  const usSites = sites.filter((s) => s.country === "US" && s.type !== "TDWR");
  const tdwrSites = sites.filter((s) => s.type === "TDWR");
  const brVolumes = sites.filter((s) => isBrazilSite(s.id));
  const otherSites = sites.filter((s) => s.country !== "US" && !isBrazilSite(s.id));
  // radar-sites: favourites first, and each radar's live standing as its hint
  useRadarSitesStore((s) => s.feed);
  const favourites = useRadarSitesStore((s) => s.favourites);
  const favSites = favourites.map((id) => sites.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
  const inArchive = archiveTime !== null || archiveDate !== null;

  /** One picker for every radar: a NEXRAD, or the Brazilian radar kept from
   *  an archive volume, both open in the radar viewer. */
  const pick = (value: string) => {
    const id = value || null;
    selectSite(id);
    if (id) {
      if (!enabled) setLayerVisible(LAYER, true);
      jumpTo(id);
    }
  };

  return (
    <div className="sfcobs">
      <LayerPower
        label="Radar"
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
        <span className="sfcobs__label siteinfo__label">
          Radar site ({sites.length})
          <AllRadarsButton />
        </span>
        <Select
          value={site ?? ""}
          aria-label="Radar site"
          options={[
            { value: "", label: "— pick a radar (or click one on the map) —" },
            ...(favSites.length ? [{ value: "__fav", label: "Favourites", disabled: true }] : []),
            ...favSites.map((s) => ({
              value: s.id,
              label: `${s.icao} — ${s.name}`,
              hint: siteHint(s.id),
              disabled: siteIsDown(s.id),
              tone: siteIsDown(s.id) ? ("warn" as const) : undefined,
            })),
            ...(brVolumes.length ? [{ value: "__br", label: "Brazil", disabled: true }] : []),
            ...brVolumes.map((s) => ({
              value: s.id,
              label: `${s.icao} — ${s.name}`,
              hint: s.live ? "live" : "archive",
            })),
            ...(brVolumes.length ? [{ value: "__us", label: "United States", disabled: true }] : []),
            ...usSites.map((s) => ({
              value: s.id,
              label: `${s.icao} — ${s.name}`,
              hint: siteHint(s.id) ?? (s.online === false ? "offline" : undefined),
              disabled: siteIsDown(s.id) || (s.online === false && !inArchive),
              tone: siteIsDown(s.id) || s.online === false ? ("warn" as const) : undefined,
            })),
            ...(tdwrSites.length ? [{ value: "__tdwr", label: "TDWR · airport radars", disabled: true }] : []),
            ...tdwrSites.map((s) => ({
              value: s.id,
              label: `${s.icao} — ${s.name}`,
              hint: siteHint(s.id) ?? (s.online === false ? "offline" : undefined),
              disabled: siteIsDown(s.id) || (s.online === false && !inArchive),
              tone: siteIsDown(s.id) || s.online === false ? ("warn" as const) : undefined,
            })),
            ...(otherSites.length ? [{ value: "__other", label: "Other", disabled: true }] : []),
            ...otherSites.map((s) => ({
              value: s.id,
              label: `${s.icao} — ${s.name}`,
              hint: siteHint(s.id) ?? (s.online === false ? "offline" : undefined),
              disabled: siteIsDown(s.id) || (s.online === false && !inArchive),
              tone: siteIsDown(s.id) || s.online === false ? ("warn" as const) : undefined,
            })),
          ]}
          onChange={pick}
        />
      </label>

      {/* The radar's name + star, its live standing, VCP and the folded
          Site information (radar-sites: RadarSiteInfo.tsx). */}
      <RadarSiteInfo />

      {/* The NWS office whose area holds this radar: its page (ForecastOfficePanel). */}
      <RadarOfficeRow />

      {/* The loop as a span of time, 30 min to 8 h (LoopLength.tsx). */}
      <LoopLength />
      {/* Every frame of the loop: state, details, download, remove (FramesPanel.tsx). */}
      <FramesButton />

      {/* Products + tilt now live on the map, top-right (RadarProductPanel):
          the grids here were cramped and duplicated that control. */}

      <MosaicShortcuts />

      <div className="sfcobs__section">Overlays</div>
      <div className="sfcobs__toggle-row">
        <span>Range ring</span>
        <Toggle on={showRing} onClick={() => setShowRing(!showRing)} />
      </div>
      <div className="sfcobs__toggle-row">
        <span>
          Storm tracks
          {storms ? (
            <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>
              {storms.meta.cellCount} cell{storms.meta.cellCount === 1 ? "" : "s"}
              {storms.meta.mesoCount ? `, ${storms.meta.mesoCount} meso` : ""}
            </small>
          ) : null}
        </span>
        <Toggle on={showTracks} onClick={() => setShowTracks(!showTracks)} />
      </div>
      <DetectionsOverlayRow />

      <div className="sfcobs__section">Display</div>
      <div className="sfcobs__toggle-row">
        <span>
          Value at cursor
          <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>
            {scan?.meta.units || "dBZ"} + height
          </small>
        </span>
        <Toggle on={showReadout} onClick={() => setShowReadout(!showReadout)} />
      </div>
      <ProductInfoRow />
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
      {/* Gate filter, flash, trail, pane opacity, scan line (display-opts). */}
      <RadarDisplayOptions />
      <VelocityOptions />

      <div className="sfcobs__section">Timeline</div>
      <div className="sfcobs__toggle-row">
        <span>Auto update</span>
        <Toggle on={autoUpdate} onClick={() => setAutoUpdate(!autoUpdate)} />
      </div>
      {/* A Level II day comes out of the whole archive (archive-l2, back to
          1991) and loads from the frame on screen outward; Level III's from
          March 2022, warmed before play. */}
      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Whole day{archiveDate ? " — every scan" : ""}
        </span>
        <input
          type="date"
          value={archiveDate ?? ""}
          min={isL2 ? "1991-06-01" : tdwrSites.some((s) => s.id === site) ? "2013-06-25" : "2022-03-01"}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => void setArchiveDate(e.target.value || null, null)}
        />
      </label>

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Start from{archiveTime !== null ? " — archive" : " — live"}
        </span>
        <input
          type="datetime-local"
          value={archiveTime !== null ? toLocalInput(archiveTime) : ""}
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
          {scan.meta.note && (
            <div className="sfcobs__row">
              <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{scan.meta.note}</span>
            </div>
          )}
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
            Pick a site above, click one on the map, or press and hold on the map for the nearest.
          </span>
        </div>
      )}
    </div>
  );
}
