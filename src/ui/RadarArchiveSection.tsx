import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { isTdwrId, useNexradStore } from "../store/useNexradStore";
import { getMap, PRIMARY_PANE } from "../map/mapInstance";
import {
  ARCHIVE_FIRST_DAY,
  fetchArchiveDay,
  fmtBytes,
  hmsZ,
  pickSpans,
  type ArchiveDay,
} from "../lib/radarArchive";
import { Select } from "./Select";

/**
 * "Open NEXRAD archive" (archive-l2): a radar and a UTC day, every volume the
 * radar wrote that day listed -- back to 1991 -- ticked and loaded; the first
 * scan shows at once and the rest follow. Below it, the radars in the loop:
 * "Add radar" puts another radar's scans over the same stretch into the loop,
 * in a pane of its own.
 */

const K_SITE = "weatherts.archiveL2.site";
const K_DATE = "weatherts.archiveL2.date";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* only not remembered */
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The NEXRAD nearest the middle of the map. */
function nearestSite(): string | null {
  const sites = useNexradStore.getState().sites;
  const c = getMap()?.getCenter();
  if (!sites.length || !c) return null;
  const k = Math.cos((c.lat * Math.PI) / 180);
  let best: string | null = null;
  let dist = Infinity;
  for (const s of sites) {
    if (s.type === "TDWR") continue;
    const d = (s.lat - c.lat) ** 2 + ((s.lon - c.lng) * k) ** 2;
    if (d < dist) {
      dist = d;
      best = s.id;
    }
  }
  return best;
}

export function RadarArchiveSection() {
  const sites = useNexradStore((s) => s.sites);
  const loopSite = useNexradStore((s) => s.site);
  const archiveDate = useNexradStore((s) => s.archiveDate);
  const archivePick = useNexradStore((s) => s.archivePick);
  const loaded = useNexradStore((s) => s.scans.length);
  const paneRadar = useNexradStore((s) => s.paneRadar);
  const radarError = useNexradStore((s) => s.error);

  const [site, setSite] = useState<string>(() => read(K_SITE) ?? useNexradStore.getState().site ?? "");
  const [date, setDate] = useState<string>(() => read(K_DATE) ?? todayIso());
  const [day, setDay] = useState<ArchiveDay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState("");
  const lastClick = useRef<number | null>(null);

  // A radar to start from: the one on the map, else the nearest.
  useEffect(() => {
    if (site || !sites.length) return;
    const s = useNexradStore.getState().site ?? nearestSite();
    if (s) setSite(s);
  }, [site, sites.length]);

  // The day's volumes.
  useEffect(() => {
    if (!site || !date) return;
    const ctrl = new AbortController();
    setBusy(true);
    setError(null);
    setDay(null);
    setPicked(new Set());
    lastClick.current = null;
    fetchArchiveDay(site, date, ctrl.signal)
      .then((d) => setDay(d))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [site, date]);

  const volumes = useMemo(() => day?.volumes ?? [], [day]);
  const loadable = useMemo(() => volumes.filter((v) => !v.partial), [volumes]);
  const pickedBytes = useMemo(
    () => volumes.reduce((n, v) => n + (picked.has(v.key) ? v.size : 0), 0),
    [volumes, picked],
  );
  const dayBytes = useMemo(() => loadable.reduce((n, v) => n + v.size, 0), [loadable]);
  // Grouped by hour: a day is 150-300 rows.
  const hours = useMemo(() => {
    const out: { hour: number; rows: { v: (typeof volumes)[number]; i: number }[] }[] = [];
    volumes.forEach((v, i) => {
      const h = new Date(v.time * 1000).getUTCHours();
      if (!out.length || out[out.length - 1].hour !== h) out.push({ hour: h, rows: [] });
      out[out.length - 1].rows.push({ v, i });
    });
    return out;
  }, [volumes]);

  const siteOptions = useMemo(
    () =>
      [...sites]
        .filter((s) => !s.id.startsWith("BR-"))
        .sort((a, b) => a.icao.localeCompare(b.icao))
        .map((s) => ({ value: s.id, label: `${s.icao} ${s.name}`, hint: s.online ? undefined : "retired / off" })),
    [sites],
  );
  const icao = (id: string | null | undefined) => (id ? (sites.find((s) => s.id === id)?.icao ?? id) : "");

  const toggle = (i: number, shift: boolean) => {
    const v = volumes[i];
    if (!v || v.partial) return;
    const next = new Set(picked);
    const on = !picked.has(v.key);
    if (shift && lastClick.current !== null) {
      const [a, b] = [Math.min(lastClick.current, i), Math.max(lastClick.current, i)];
      for (let j = a; j <= b; j++) if (!volumes[j].partial) (on ? next.add(volumes[j].key) : next.delete(volumes[j].key));
    } else if (on) next.add(v.key);
    else next.delete(v.key);
    lastClick.current = i;
    setPicked(next);
  };

  const toggleHour = (rows: { v: (typeof volumes)[number] }[]) => {
    const keys = rows.filter((r) => !r.v.partial).map((r) => r.v.key);
    const all = keys.every((k) => picked.has(k));
    const next = new Set(picked);
    for (const k of keys) (all ? next.delete(k) : next.add(k));
    setPicked(next);
  };

  /** Load the ticked volumes (or the whole day) on this radar. */
  const load = (whole: boolean) => {
    if (!site || !day) return;
    const pick = whole ? null : pickSpans(volumes, picked);
    if (!whole && !pick?.length) return;
    const app = useAppStore.getState();
    if (!app.layers.nexrad?.visible) app.setLayerVisible("nexrad", true);
    const nex = useNexradStore.getState();
    if (nex.site !== site) {
      // The day first, then the radar: its first list is then this day's.
      nex.stopAutoRefresh();
      useNexradStore.setState({ archiveDate: day.date, archivePick: pick, archiveTime: null, archiveFocus: null, scans: [], index: 0 });
      nex.selectSite(site);
    } else {
      void nex.setArchiveDate(day.date, pick);
    }
  };

  const extras = Object.entries(paneRadar)
    .filter(([, p]) => !!p.site && p.site !== loopSite)
    .sort(([a], [b]) => a.localeCompare(b));
  const paneNo = (id: string) => Object.keys(paneRadar).sort().indexOf(id) + 1;

  const addRadar = (id: string) => {
    const nex = useNexradStore.getState();
    if (!id || !nex.site || id === nex.site || extras.some(([, p]) => p.site === id)) return;
    const app = useAppStore.getState();
    const grow = app.paneCount === 1 ? 2 : app.paneCount === 2 ? 3 : app.paneCount === 3 ? 4 : app.paneCount === 4 ? 6 : null;
    if (grow) {
      // The first new pane (ids run pane-0, pane-1, ...) takes the radar as it opens.
      nex.queuePaneRadar(`pane-${app.paneCount}`, id);
      app.setPaneCount(grow);
    } else {
      const free = Object.keys(nex.paneRadar)
        .sort()
        .reverse()
        .find((p) => p !== PRIMARY_PANE && !nex.paneRadar[p].site);
      if (free) nex.setPaneRadar(free, id);
    }
    setAdding("");
  };

  const shownDay = archiveDate && loopSite;
  const tdwrPick = sites.some((s) => s.id === site && s.type === "TDWR");
  const rowWord = tdwrPick ? "scans" : "volumes";
  const statusLine = busy ? (
    <>
      <Loader2 size={13} className="sfx__status-spin" /> Listing {icao(site)} {date}…
    </>
  ) : error ? (
    <>
      <AlertTriangle size={13} /> {error}
    </>
  ) : day ? (
    loadable.length ? (
      <>
        {loadable.length} {rowWord} · {fmtBytes(dayBytes)}
        {volumes.length > loadable.length ? ` · ${volumes.length - loadable.length} fragment${volumes.length - loadable.length > 1 ? "s" : ""}` : ""}
      </>
    ) : (
      <>No {rowWord} archived for {icao(site)} on {date}.</>
    )
  ) : (
    <>Pick a radar and a day</>
  );

  return (
    <>
      <div className="sfx__block arl2">
        <div className="sfx__head">
          <span>{tdwrPick ? "Open TDWR archive" : "Open NEXRAD archive"}</span>
          {shownDay && <b>{icao(loopSite)} · {archiveDate}{archivePick ? "" : " · whole day"}</b>}
        </div>
        <div className="arl2__pick">
          <Select
            value={site}
            onChange={(v) => {
              setSite(v);
              write(K_SITE, v);
            }}
            aria-label="Archive radar"
            options={siteOptions}
            placeholder="Radar"
          />
          <label className="sfcobs__field">
            <input
              type="date"
              value={date}
              min={ARCHIVE_FIRST_DAY}
              max={todayIso()}
              onChange={(e) => {
                if (!e.target.value) return;
                setDate(e.target.value);
                write(K_DATE, e.target.value);
              }}
              aria-label="Archive day (UTC)"
            />
          </label>
        </div>
        <div className={`sfx__status${error ? " is-error" : ""}`}>{statusLine}</div>

        {loadable.length > 0 && (
          <>
            <div className="arl2__bar">
              <button type="button" className="arl2__link" onClick={() => setPicked(new Set(loadable.map((v) => v.key)))}>
                All
              </button>
              <button type="button" className="arl2__link" onClick={() => setPicked(new Set())} disabled={!picked.size}>
                None
              </button>
              <span className="arl2__sum">
                {picked.size ? `${picked.size} ticked · ${fmtBytes(pickedBytes)}` : "Tick scans · shift-click for a run"}
              </span>
            </div>
            <div className="arl2__list" role="list" aria-label={`${icao(site)} volumes on ${date}`}>
              {hours.map(({ hour, rows }) => {
                const keys = rows.filter((r) => !r.v.partial).map((r) => r.v.key);
                const n = keys.filter((k) => picked.has(k)).length;
                return (
                  <div key={hour} className="arl2__hour">
                    <label className="arl2__hourhead">
                      <input
                        type="checkbox"
                        checked={n > 0 && n === keys.length}
                        ref={(el) => {
                          if (el) el.indeterminate = n > 0 && n < keys.length;
                        }}
                        onChange={() => toggleHour(rows)}
                        disabled={!keys.length}
                      />
                      <span>{String(hour).padStart(2, "0")}Z</span>
                      <em>{rows.length}</em>
                    </label>
                    {rows.map(({ v, i }) => (
                      <label
                        key={v.key}
                        role="listitem"
                        className={`arl2__row${v.partial ? " is-frag" : ""}${picked.has(v.key) ? " is-on" : ""}`}
                        title={v.partial ? "A fragment of a volume: not loadable" : v.key.slice(4)}
                        onClick={(e) => {
                          e.preventDefault();
                          toggle(i, e.shiftKey);
                        }}
                      >
                        <input type="checkbox" checked={picked.has(v.key)} disabled={v.partial} readOnly tabIndex={-1} />
                        <span className="arl2__time">{hmsZ(v.time)}</span>
                        <span className="arl2__size">{v.partial ? "fragment" : fmtBytes(v.size)}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="sfx__chips arl2__go">
              <button type="button" className="sfx__chip is-on" onClick={() => load(false)} disabled={!picked.size}>
                Load selected{picked.size ? ` (${picked.size})` : ""}
              </button>
              <button type="button" className="sfx__chip" onClick={() => load(true)}>
                Load whole day
              </button>
            </div>
          </>
        )}
        <div className="sfx__ends">
          <span>
            {shownDay && radarError
              ? radarError
              : shownDay
                ? `${loaded} frames in the loop. The first scan shows at once and the rest load from there. Picking another radar loads it over the same stretch, near the time on screen.`
                : tdwrPick
                  ? "An airport radar's Level III scans from the public archive on AWS, since about 2020 at most sites: reflectivity, velocity and long-range reflectivity at its three tilts, VIL. The list shows its lowest tilt's scans; the loop follows the product on screen."
                  : "Level II volumes from the public NEXRAD archive on AWS, any day since June 1991: reflectivity, velocity and width at every tilt, dual-pol from 2011-2013, every Level II and derived product, the cross-section, detections and the 3D view."}
          </span>
        </div>
      </div>

      <div className="sfx__block arl2">
        <div className="sfx__head">
          <span>Radars in the loop</span>
          {loopSite && <b>{1 + extras.length}</b>}
        </div>
        {loopSite ? (
          <ul className="arl2__radars">
            <li>
              <b>{icao(loopSite)}</b>
              <span>the loop's radar{extras.length ? ` · pane ${paneNo(PRIMARY_PANE)}` : ""}</span>
            </li>
            {extras.map(([id, p]) => (
              <li key={id}>
                <b>{icao(p.site)}</b>
                <span>pane {paneNo(id)} · its newest scan at each frame</span>
                <button
                  type="button"
                  className="arl2__x"
                  onClick={() => useNexradStore.getState().setPaneRadar(id, null)}
                  aria-label={`Take ${icao(p.site)} out of the loop`}
                  title="Take out of the loop"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="sfx__ends">
            <span>No radar on the map yet.</span>
          </div>
        )}
        {loopSite && (
          <div className="arl2__add">
            <Select
              value={adding}
              onChange={setAdding}
              aria-label="Radar to add"
              // NEXRAD only: a pane on its own TDWR keeps a product that radar may not have.
              options={siteOptions.filter((o) => o.value !== loopSite && !isTdwrId(o.value) && !extras.some(([, p]) => p.site === o.value))}
              placeholder="Add radar…"
            />
            <button type="button" className="sfx__chip" onClick={() => addRadar(adding)} disabled={!adding}>
              <Plus size={11} /> Add
            </button>
          </div>
        )}
        <div className="sfx__ends">
          <span>
            Another radar's scans over the same stretch join the loop in a pane of their own; each pane shows its radar's
            newest scan at the loop's time.
          </span>
        </div>
      </div>
    </>
  );
}
