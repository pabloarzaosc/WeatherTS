import { List, Star } from "lucide-react";

import { CLASS_LABEL, classLine, fmtAge, operatorOf, placeOf, TDWR_NOTE, typeOf, US_STATES, vcpInfo, countryName } from "../lib/radarSites";
import { isBrazilSite } from "../lib/brazilRadar";
import { useNexradStore } from "../store/useNexradStore";
import { siteAgeNow, siteClass, siteRow, useRadarSitesStore } from "../store/useRadarSitesStore";
import { useSetting, useSettingsStore } from "../settings/useSettingsStore";

/**
 * The radar's own block in the radar panel (radar-sites): its name with the
 * favourite star, its live standing, its scan strategy (VCP), and a folded
 * "Site information": operator, type, range, scan interval, products.
 */

/** The favourite star of a radar. */
export function SiteStar({ id, size = 13 }: { id: string; size?: number }) {
  const on = useRadarSitesStore((s) => s.favourites.includes(id));
  const toggle = useRadarSitesStore((s) => s.toggleFavourite);
  return (
    <button
      type="button"
      className={`sitestar${on ? " is-on" : ""}`}
      aria-pressed={on}
      title={on ? "Remove from favourites" : "Add to favourites"}
      onClick={() => toggle(id)}
    >
      <Star size={size} />
    </button>
  );
}

/** Opens the site list. */
export function AllRadarsButton() {
  const setOpen = useRadarSitesStore((s) => s.setListOpen);
  return (
    <button type="button" className="siteinfo__all" onClick={() => setOpen(true)} title="Every radar in a table: sort, filter, favourites">
      <List size={12} /> All radars
    </button>
  );
}

/** Median minutes between the loop's scans in its newest hour. */
function scanEveryMin(times: number[]): number | null {
  const t = [...new Set(times)].sort((a, b) => a - b);
  const last = t.at(-1);
  if (last == null) return null;
  const hour = t.filter((x) => x >= last - 3600);
  const d: number[] = [];
  for (let i = 1; i < hour.length; i++) d.push(hour[i] - hour[i - 1]);
  if (d.length < 2) return null;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] / 60;
}

export function RadarSiteInfo() {
  const siteId = useNexradStore((s) => s.site);
  const sites = useNexradStore((s) => s.sites);
  const scan = useNexradStore((s) => s.scan);
  const scans = useNexradStore((s) => s.scans);
  const grids = useNexradStore((s) => s.grids);
  const product = useNexradStore((s) => s.product);
  const archive = useNexradStore((s) => s.archiveTime !== null || s.archiveDate !== null);
  useRadarSitesStore((s) => s.feed);
  const defaultSite = useSetting<string>("radar.defaultSite");
  const setSetting = useSettingsStore((s) => s.set);

  const s = siteId ? sites.find((x) => x.id === siteId) : undefined;
  if (!siteId || !s) return null;

  const row = siteRow(siteId);
  const cls = siteClass(siteId);
  const brazil = isBrazilSite(siteId);
  const tdwr = s.type === "TDWR";
  const vcp = scan?.meta.vcp != null ? String(scan.meta.vcp) : row?.vcp ?? null;
  const info = vcpInfo(vcp);
  const every = scanEveryMin(scans.map((x) => x.time));
  const now = grids.filter((f) => !f.unavailable && !f.checking);
  const live = now.filter((f) => f.group !== "derived");
  const derived = now.length - live.length;
  const isDefault = !!defaultSite && [s.icao, s.id].includes(defaultSite.trim().toUpperCase());
  const statusText = cls === "none" ? (archive ? "Archive · the live standing applies to now" : "Reading the radar's status…") : classLine(row, siteAgeNow(row));

  return (
    <div className="siteinfo">
      <div className="siteinfo__top">
        <SiteStar id={s.id} />
        <b className="siteinfo__id">{s.icao}</b>
        <span className="siteinfo__place">
          {placeOf(s)}
          {s.state && s.state.trim() ? `, ${s.state}` : ""}
        </span>
      </div>
      <div className={`siteinfo__status is-${cls}`} title={row?.alarm && row.alarm !== "No Alarms" ? `RDA alarms: ${row.alarm.split("|").join(", ")}` : undefined}>
        <span className={`sitedot sitedot--${cls}`} />
        <span>{statusText}</span>
        {cls === "down" && (
          <button
            type="button"
            className="siteinfo__why"
            onClick={(e) => useRadarSitesStore.getState().openNotice(s.id, e.clientX, e.clientY)}
          >
            Why?
          </button>
        )}
      </div>
      {tdwr && <div className="siteinfo__tdwr">{TDWR_NOTE}</div>}
      {vcp && (
        <div className="siteinfo__vcp">
          <span>Scan strategy</span>
          <b>VCP {vcp}</b>
          <small>
            {info?.label}
            {/* "Clear Air Mode" beside "Clear air" says it twice */}
            {scan?.meta.mode && !scan.meta.mode.toLowerCase().startsWith((info?.label ?? "").split(/[\s·]/)[0].toLowerCase())
              ? ` · ${scan.meta.mode}`
              : ""}
          </small>
        </div>
      )}

      <details className="siteinfo__more">
        <summary>Site information</summary>
        <dl className="siteinfo__dl">
          <dt>Operator</dt>
          <dd>{operatorOf(s)}</dd>
          <dt>Type</dt>
          <dd>{brazil ? typeOf(s) : tdwr ? "TDWR · C-band Doppler, single polarization" : "WSR-88D · S-band Doppler, dual polarization"}</dd>
          {!brazil && (
            <>
              <dt>Range</dt>
              <dd>{tdwr ? "Reflectivity and velocity 89 km · long-range reflectivity 417 km" : "Reflectivity 460 km · velocity 300 km"}</dd>
            </>
          )}
          <dt>Scan interval</dt>
          <dd>
            {every != null ? `a new ${scan?.meta.productLabel ?? product} scan every ${every < 10 ? every.toFixed(1) : Math.round(every)} min` : "—"}
            {info?.minutes ? ` · a VCP ${vcp} volume takes about ${info.minutes} min` : ""}
          </dd>
          <dt>Products</dt>
          <dd>
            {live.length ? `${live.length} now: ${live.map((f) => f.short ?? f.label).join(", ")}` : "—"}
            {derived > 0 ? ` · ${derived} more derived from its Level II` : ""}
          </dd>
          <dt>Location</dt>
          <dd>
            {Math.abs(s.lat).toFixed(3)}° {s.lat >= 0 ? "N" : "S"}, {Math.abs(s.lon).toFixed(3)}° {s.lon >= 0 ? "E" : "W"}
            {s.elev != null ? ` · ${Math.round(s.elev)} m` : ""}
            {s.state && US_STATES[s.state] ? ` · ${US_STATES[s.state]}` : ` · ${countryName(s.country)}`}
          </dd>
          {s.tz && (
            <>
              <dt>Time zone</dt>
              <dd>{s.tz}</dd>
            </>
          )}
          {row && (
            <>
              <dt>RDA</dt>
              <dd>
                {[row.rda, row.op, row.mode].filter(Boolean).join(" · ") || "—"}
                {row.alarm ? ` · ${row.alarm === "No Alarms" ? "no alarms" : `alarms: ${row.alarm.split("|").join(", ")}`}` : ""}
              </dd>
              <dt>Data</dt>
              <dd>
                {CLASS_LABEL[row.st]} · latency {row.lat != null ? `${row.lat.toFixed(1)} s` : "—"}
                {row.age != null ? ` · newest ${fmtAge(siteAgeNow(row))} ago` : ""}
              </dd>
            </>
          )}
        </dl>
        <div className="siteinfo__actions">
          {isDefault ? (
            <button type="button" className="siteinfo__btn" onClick={() => setSetting("radar.defaultSite", "")} title="The map opens with no radar picked">
              Default radar ✓ · clear
            </button>
          ) : (
            <button type="button" className="siteinfo__btn" onClick={() => setSetting("radar.defaultSite", s.icao)} title="The radar the map opens on when no radar was open">
              Make {s.icao} the default radar
            </button>
          )}
          {archive && <span className="siteinfo__note">Showing the archive</span>}
        </div>
      </details>
    </div>
  );
}
