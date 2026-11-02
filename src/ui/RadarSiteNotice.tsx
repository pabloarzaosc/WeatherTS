import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { distanceKm, fmtAge, fmtKm, placeOf, type SiteAlarm } from "../lib/radarSites";
import { pickRadar } from "../lib/radarSitesInstall";
import { useSetting } from "../settings/useSettingsStore";
import { useNexradStore } from "../store/useNexradStore";
import { siteAgeNow, siteIsDown, siteRow, useRadarSitesStore } from "../store/useRadarSitesStore";

/**
 * Why a radar is down (radar-sites): opened by clicking its red label, or by
 * picking it in the site list or the search. How long it has been quiet, what
 * its RDA reports, the alarms still standing, the forecast office's outage
 * notice, and the nearest radars that are up.
 */

const NOTICE_MAX_AGE_S = 30 * 86400;

function utc(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function alarmTone(a: SiteAlarm): string {
  return a.status === "inoperative" ? "is-red" : "is-yellow";
}

export function RadarSiteNotice() {
  const notice = useRadarSitesStore((s) => s.notice);
  return notice ? <NoticeCard key={notice.site} site={notice.site} x={notice.x} y={notice.y} /> : null;
}

function NoticeCard({ site, x, y }: { site: string; x: number; y: number }) {
  const entry = useRadarSitesStore((s) => s.details[site]);
  useRadarSitesStore((s) => s.feed);
  const sites = useNexradStore((s) => s.sites);
  const close = useRadarSitesStore((s) => s.closeNotice);
  const unit = useSetting<string>("radar.readoutDistance");
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + 14, top: y + 10 });

  const s = sites.find((v) => v.id === site);
  const row = siteRow(site);
  const d = entry?.data;
  const age = d?.age != null && d?.checked ? d.age + Math.max(0, Date.now() / 1000 - d.checked) : siteAgeNow(row);

  // Inside the window, beside the pointer, however tall its reasons come in.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(x + 14, window.innerWidth - r.width - 8));
      const top = Math.max(8, Math.min(y + 10, window.innerHeight - r.height - 8));
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);

  // A part that did not answer in time (the backend gives each 8 s) is asked again.
  const missing = !!d?.errors && Object.keys(d.errors).length > 0;
  const retries = useRef(0);
  useEffect(() => {
    if (!missing || retries.current >= 3) return;
    const t = window.setTimeout(() => {
      retries.current += 1;
      void useRadarSitesStore.getState().loadDetail(site, true);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [missing, d?.checked, site]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    // after the click that opened it
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown, true), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [close]);

  const nearby = useMemo(() => {
    if (!s) return [];
    return sites
      // a NEXRAD's stand-in is another NEXRAD; an airport radar's can be either
      .filter((v) => v.id !== s.id && v.country === s.country && !siteIsDown(v.id) && v.online !== false && (s.type === "TDWR" || v.type !== "TDWR"))
      .map((v) => ({ v, km: distanceKm(s.lat, s.lon, v.lat, v.lon) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);
  }, [s, sites]);

  const notice = d?.notice && d.notice.at && Date.now() / 1000 - d.notice.at < NOTICE_MAX_AGE_S ? d.notice : null;
  const l2 = d?.level2?.lastChunkUnix ?? d?.l2 ?? row?.l2 ?? null;
  const l3 = d?.level3 ?? row?.l3 ?? null;
  const rdaBits = [d?.rda ?? row?.rda, d?.op ?? row?.op].filter(Boolean).join(" · ");
  const alarmSummary = d?.alarm ?? row?.alarm;

  return (
    <div ref={ref} className="sitenotice" style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={`${s?.icao ?? site} is down`}>
      <div className="sitenotice__head">
        <span className="sitedot sitedot--down" />
        <b>{s?.icao ?? site}</b>
        <span className="sitenotice__place">{s ? placeOf(s) : ""}{s?.state ? `, ${s.state}` : ""}</span>
        <button type="button" className="sitenotice__x" onClick={close} title="Close (Esc)">
          <X size={13} />
        </button>
      </div>
      <div className="sitenotice__lead">
        <div>
          Down · no data for <b>{fmtAge(age)}</b>
        </div>
        <small>This radar can't be opened until its data comes back.</small>
      </div>

      <dl className="sitenotice__dl">
        {/* An airport radar's whole story here is Level III (the feed's own time stands behind it). */}
        {s?.type === "TDWR" ? null : (
          <>
            <dt>Level II</dt>
            <dd>{l2 ? `newest ${utc(l2)} · ${fmtAge(Date.now() / 1000 - l2)} ago` : "nothing in the last day"}</dd>
          </>
        )}
        <dt>Level III</dt>
        <dd>{l3 ? `newest ${utc(l3)} · ${fmtAge(Date.now() / 1000 - l3)} ago` : entry?.loading ? "checking…" : "nothing in the last day"}</dd>
        {rdaBits && (
          <>
            <dt>RDA</dt>
            <dd>{rdaBits}</dd>
          </>
        )}
        {alarmSummary && alarmSummary !== "No Alarms" && (
          <>
            <dt>Alarms</dt>
            <dd>{alarmSummary.split("|").join(", ")}</dd>
          </>
        )}
      </dl>

      {entry?.loading && !d && (
        <div className="sitenotice__wait">
          <Loader2 size={12} className="spin" /> Asking the NWS for the radar's alarms and the office's notice…
        </div>
      )}

      {!!d?.alarms?.length && (
        <div className="sitenotice__sec">
          <div className="sitenotice__h">Standing alarms</div>
          <ul className="sitenotice__alarms">
            {d.alarms.slice(0, 6).map((a) => (
              <li key={`${a.message}-${a.at}`} className={alarmTone(a)}>
                <span>{a.message}</span>
                <small>
                  {a.status} · {utc(a.at)}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d && (
        <div className="sitenotice__sec">
          <div className="sitenotice__h">
            Outage notice{notice?.office ? ` from ${notice.office}` : ""}
            {notice?.at ? <small> · {utc(notice.at)}</small> : null}
            {/* the office's last word may be about an earlier outage */}
            {notice?.at && l2 && notice.at < l2 - 3600 ? <small> · from before this outage</small> : null}
          </div>
          {notice ? (
            <p className="sitenotice__text">{notice.text || "(no text)"}</p>
          ) : (
            <p className="sitenotice__none">
              {d.errors?.notice ? "The office's notices could not be read just now." : "No outage notice from the office in the last 30 days."}
            </p>
          )}
        </div>
      )}
      {entry?.error && !d && <p className="sitenotice__none">The reasons could not be read: {entry.error}</p>}

      {nearby.length > 0 && (
        <div className="sitenotice__near">
          <span>Nearest radars up:</span>
          {nearby.map(({ v, km }) => (
            <button
              key={v.id}
              type="button"
              onClick={(e) => {
                if (pickRadar(v.id, { x: e.clientX, y: e.clientY })) close();
              }}
            >
              {v.icao} <small>{fmtKm(km, unit)}</small>
            </button>
          ))}
        </div>
      )}
      <div className="sitenotice__src">NWS radar status feed · Free Text Message (FTM)</div>
    </div>
  );
}
