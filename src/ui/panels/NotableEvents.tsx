import { useMemo, useState } from "react";
import { Check, Link2, MapPin, Search, Wind } from "lucide-react";

import { MESO_EVENTS, type MesoEvent } from "../../lib/mesoEvents";
import {
  EVENT_CATEGORIES,
  EVENT_COLORS,
  eventDay,
  eventWindowText,
  RADAR_EVENTS,
  searchEvents,
  type EventFilter,
  type RadarEvent,
} from "../../lib/radarEvents";
import { buildViewLink } from "../../lib/viewLink";
import { useAppStore } from "../../store/useAppStore";
import { useArchiveStore } from "../../store/useArchiveStore";
import { useObsStore } from "../../store/useObsStore";
import { useRadarEventStore } from "../../store/useRadarEventStore";
import { archiveWhen } from "./MesoArchive";

const LAYER = "radarEvents";
const MESO_FIRST = Date.UTC(2005, 0, 1) / 1000;
const hm = (u: number) => new Date(u * 1000).toISOString().slice(11, 16);

/** The radar event on the same storm day as a mesoanalysis day, and back. */
const sameDay = (e: RadarEvent, m: MesoEvent) => Math.abs(e.peak - m.at) < 12 * 3600;

function words(q: string): string[] {
  return q.toLowerCase().split(/[\s,]+/).filter(Boolean);
}

function mesoMatches(m: MesoEvent, q: string): boolean {
  const hay = `${m.name} ${m.place} k${m.radar} ${m.radar} ${new Date(m.at * 1000).getUTCFullYear()}`.toLowerCase();
  return words(q).every((w) => hay.includes(w));
}

/** The mesoanalysis at an event's hour, the radar left on the event. */
async function openEnvironment(e: RadarEvent): Promise<void> {
  useArchiveStore.setState({ at: Math.round(e.peak / 3600) * 3600 });
  await useArchiveStore.getState().setMeso(true);
  const obs = useObsStore.getState();
  const product = obs.catalog?.products.find((p) => p.id === obs.field);
  if (product?.group !== "Severe Weather") obs.setField("stp_eff");
}

/**
 * The Archive panel's notable events: radar events (each a window on the radar
 * that saw it) and the mesoanalysis's notable days, one search over both. A
 * radar event opens on its peak scan; a day opens the environment at the hour
 * that mattered and its radar. Each list points at the other where they share
 * a storm day.
 */
export function NotableEvents() {
  const query = useRadarEventStore((s) => s.query);
  const filter = useRadarEventStore((s) => s.filter);
  const list = useRadarEventStore((s) => s.list);
  const active = useRadarEventStore((s) => s.active);
  const { setQuery, setFilter, setList, load } = useRadarEventStore.getState();
  const onMap = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const archiveAt = useArchiveStore((s) => s.at);
  const [copied, setCopied] = useState(false);

  const events = useMemo(() => searchEvents(query, filter), [query, filter]);
  const days = useMemo(() => MESO_EVENTS.filter((m) => mesoMatches(m, query)), [query]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: RADAR_EVENTS.length, couplets: RADAR_EVENTS.filter((e) => e.dvKt != null).length };
    for (const e of RADAR_EVENTS) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, []);
  const dayOn = MESO_EVENTS.find((m) => Math.floor(m.at / 86400) === Math.floor(archiveAt / 86400))?.id ?? null;

  const filters: Array<{ id: EventFilter; label: string }> = [
    { id: "all", label: "All" },
    ...EVENT_CATEGORIES.map((c) => ({ id: c.id as EventFilter, label: c.plural })),
    { id: "couplets", label: "Strongest couplets" },
  ];

  const copy = () => {
    const link = buildViewLink();
    if (!link || !navigator.clipboard) return;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  return (
    <div className="sfx__block">
      <div className="sfx__head">
        <span>Notable events</span>
        <b>{list === "radar" ? `${events.length} / ${RADAR_EVENTS.length}` : `${days.length} / ${MESO_EVENTS.length}`}</b>
      </div>

      <div className="evl__tabs" role="tablist" aria-label="Which events">
        <button type="button" role="tab" aria-selected={list === "radar"} className={`evl__tab${list === "radar" ? " is-on" : ""}`}
                onClick={() => setList("radar")}>
          Radar events <em>{RADAR_EVENTS.length}</em>
        </button>
        <button type="button" role="tab" aria-selected={list === "meso"} className={`evl__tab${list === "meso" ? " is-on" : ""}`}
                onClick={() => setList("meso")}>
          Mesoanalysis days <em>{MESO_EVENTS.length}</em>
        </button>
      </div>

      <label className="evl__search">
        <Search size={13} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Place, radar, year or name"
          aria-label="Search notable events"
          spellCheck={false}
        />
      </label>

      {list === "radar" && (
        <>
          <div className="sfx__chips evl__cats">
            {filters.map((f) => (
              <button key={f.id} type="button" className={`sfx__chip${filter === f.id ? " is-on" : ""}`} onClick={() => setFilter(f.id)}>
                {f.id !== "all" && f.id !== "couplets" && <i className="evl__dot" style={{ background: EVENT_COLORS[f.id] }} />}
                {f.label}
                <em className="sfx__count">{counts[f.id] ?? 0}</em>
              </button>
            ))}
          </div>
          <label className="evl__map">
            <input type="checkbox" checked={onMap} onChange={(e) => useAppStore.getState().setLayerVisible(LAYER, e.target.checked)} />
            <MapPin size={12} /> Show on map
            <span>{onMap ? "click a dot to load it" : "these events as dots"}</span>
          </label>

          <div className="mesoev evl__list" role="list">
            {events.length === 0 && <div className="evl__none">No event matches.</div>}
            {events.map((e) => {
              const on = e.id === active;
              const meso = MESO_EVENTS.find((m) => sameDay(e, m));
              return (
                <div key={e.id} role="listitem" className={`evl__item${on ? " is-on" : ""}`}>
                  <button
                    type="button"
                    className={`mesoev__row evl__row${on ? " is-on" : ""}`}
                    onClick={() => void load(e.id)}
                    title={`Load ${eventWindowText(e)} from K${e.site}, on the peak scan`}
                  >
                    <span className="mesoev__name">
                      <i className="evl__dot" style={{ background: EVENT_COLORS[e.category] }} />
                      {e.title}
                      {filter === "couplets" && e.dvKt != null && <span className="evl__dv">{e.dvKt} kt</span>}
                    </span>
                    <span className="mesoev__sub">
                      <span>
                        {e.place} · K{e.site}
                      </span>
                      <span className="mesoev__when">{eventDay(e)}</span>
                    </span>
                  </button>
                  {on && (
                    <div className="evl__detail">
                      <p>{e.text}</p>
                      <div className="evl__facts">
                        <span>{eventWindowText(e)}</span>
                        <span>peak {hm(e.peak)}Z</span>
                        <span>{e.volumes} Level II volumes · {e.mb >= 1000 ? `${(e.mb / 1000).toFixed(1)} GB` : `${e.mb} MB`}</span>
                        {e.dvKt != null && e.dvAt != null && <span>couplet {e.dvKt} kt at {hm(e.dvAt)}Z</span>}
                      </div>
                      <div className="evl__acts">
                        {e.peak >= MESO_FIRST && (
                          <button type="button" className="sfx__chip" onClick={() => void openEnvironment(e)}
                                  title={meso ? `The environment: ${meso.name}` : "The mesoanalysis at the peak hour"}>
                            <Wind size={11} /> Environment
                          </button>
                        )}
                        <button type="button" className="sfx__chip" onClick={copy} title="A link that opens this event at this scan">
                          {copied ? <Check size={11} /> : <Link2 size={11} />} {copied ? "Link copied" : "Copy link"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sfx__ends">
            <span>
              One click loads the event's window on the radar that saw it, on its peak scan; picking another radar loads
              the same window from there. Level II before March 2022, Level III after.
            </span>
          </div>
        </>
      )}

      {list === "meso" && (
        <>
          <div className="mesoev" role="list">
            {days.length === 0 && <div className="evl__none">No day matches.</div>}
            {days.map((m) => {
              const ev = RADAR_EVENTS.find((e) => sameDay(e, m));
              return (
                <div key={m.id} role="listitem" className="evl__item">
                  <button
                    type="button"
                    className={`mesoev__row${dayOn === m.id ? " is-on" : ""}`}
                    onClick={() => void useArchiveStore.getState().openEvent(m)}
                    title={`Open ${archiveWhen(m.at)} with the K${m.radar} radar`}
                  >
                    <span className="mesoev__name">{m.name}</span>
                    <span className="mesoev__sub">
                      <span>
                        {m.place} · K{m.radar}
                      </span>
                      <span className="mesoev__when">{archiveWhen(m.at)}</span>
                    </span>
                  </button>
                  {ev && (
                    <button type="button" className="evl__link" onClick={() => void load(ev.id)}
                            title={`Load the radar event: ${ev.title}, ${eventWindowText(ev)}`}>
                      <i className="evl__dot" style={{ background: EVENT_COLORS[ev.category] }} /> Radar event
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sfx__ends">
            <span>Opens the mesoanalysis at the hour that mattered and the radar that saw it.</span>
          </div>
        </>
      )}
    </div>
  );
}
