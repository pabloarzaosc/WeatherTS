import { useEffect, useState, type CSSProperties } from "react";
import { MapPin, RefreshCw } from "lucide-react";

import { NOW_GROUPS, NOW_PRODUCT_NAMES, type NowGroupId, type NowItem, type NowProduct } from "../../lib/nowFeed";
import { shortSpan } from "../../lib/alertGroups";
import { openNowItem, useNowStore } from "../../store/useNowStore";
import { useLocalWeatherStore } from "../../store/useLocalWeatherStore";

/**
 * Now: what is happening across the US at this minute, biggest first --
 * warnings (several on one storm merged into one line), watches, the last
 * hour's storm reports, SPC's risk today and tomorrow, and a notable radar
 * event from this week in past years. A line opens the radar nearest it on
 * the product that shows the hazard best.
 */

const PROD_SHORT: Record<NowProduct, string> = { B: "REF", G: "VEL", C: "CC" };
const SHOW = 3;

const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function when(item: NowItem, nowMs: number): string {
  if (item.group === "archive") return item.at ? String(new Date(item.at).getUTCFullYear()) : "";
  if (item.group === "outlook") return item.id === "o:1" ? "Day 1" : "Day 2";
  if (!item.at) return "";
  const d = nowMs - item.at;
  return d < 60_000 ? "now" : shortSpan(d);
}

function Row({ item, nowMs, busy, onOpen }: { item: NowItem; nowMs: number; busy: boolean; onOpen: (i: NowItem) => void }) {
  const product = item.eventId ? "Open the event on the radar archive" : `Open the nearest radar on ${NOW_PRODUCT_NAMES[item.product]}`;
  return (
    <button
      type="button"
      className={`now__row${item.serious ? " is-serious" : ""}${busy ? " is-busy" : ""}`}
      style={{ "--now-c": item.color } as CSSProperties}
      onClick={() => onOpen(item)}
      title={product}
    >
      <span className="now__stripe" aria-hidden />
      <span className="now__text">
        <span className="now__title">{item.title}</span>
        <span className="now__sub">{item.sub}</span>
        {item.tags.length > 0 && (
          <span className="now__tags">
            {item.tags.slice(0, 3).map((t) => (
              <span key={t.key} className={`now__tag${t.hot ? " is-hot" : ""}`}>
                {t.text}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="now__meta">
        <span className="now__prod">{item.eventId ? "ARCH" : PROD_SHORT[item.product]}</span>
        <span className="now__ago">{when(item, nowMs)}</span>
      </span>
    </button>
  );
}

function Group({ id, nowMs, busy, onOpen }: { id: NowGroupId; nowMs: number; busy: string | null; onOpen: (i: NowItem) => void }) {
  const g = NOW_GROUPS.find((x) => x.id === id)!;
  const list = useNowStore((s) => s.items[id]);
  const error = useNowStore((s) => s.errors[id]);
  const expanded = useNowStore((s) => !!s.expanded[id]);
  const toggle = useNowStore((s) => s.toggle);
  const loading = useNowStore((s) => (id === "warnings" || id === "watches" ? s.status === "loading" : !s.fullDone));
  const serious = list.filter((i) => i.serious).length;
  const shown = expanded ? list : list.slice(0, SHOW);
  return (
    <section className="now__group" aria-label={g.label}>
      <header className="now__head">
        <span>{g.label}</span>
        {serious > 0 && (
          <b className="now__count" title={`${serious} of the most serious`}>
            {serious}
          </b>
        )}
        <em>{list.length || ""}</em>
      </header>
      {error && <div className="now__err">Could not load: {error}</div>}
      {!error && list.length === 0 && <div className="now__empty">{loading ? "Loading…" : g.empty}</div>}
      {shown.map((item) => (
        <Row key={item.id} item={item} nowMs={nowMs} busy={busy === item.id} onOpen={onOpen} />
      ))}
      {list.length > SHOW && (
        <button type="button" className="now__more" onClick={() => toggle(id)}>
          {expanded ? "Show fewer" : `Show ${list.length - SHOW} more`}
        </button>
      )}
    </section>
  );
}

export function NowView() {
  const status = useNowStore((s) => s.status);
  const updated = useNowStore((s) => s.updated);
  const at = useNowStore((s) => s.at);
  const refresh = useNowStore((s) => s.refresh);
  const setOpen = useNowStore((s) => s.setOpen);
  const openMine = useLocalWeatherStore((s) => s.openMine);
  const [tick, setTick] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setOpen(true);
    const t = window.setInterval(() => setTick(Date.now()), 20_000);
    return () => {
      window.clearInterval(t);
      setOpen(false);
    };
  }, [setOpen]);

  const nowMs = at != null ? at * 1000 : tick;
  const onOpen = (item: NowItem) => {
    setBusy(item.id);
    openNowItem(item)
      .then((text) => setNote(text))
      .catch((e: unknown) => setNote(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="now">
      <div className="now__bar">
        <span className={`now__live${status === "error" ? " is-err" : ""}${at != null ? " is-then" : ""}`}>
          <i aria-hidden />
          {at != null ? `As of ${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")}Z` : "Live"}
        </span>
        <span className="now__upd">{updated ? `Updated ${hm(updated)} · every minute` : "Loading…"}</span>
        <button type="button" className="now__icon" onClick={() => void refresh(true)} title="Refresh now" aria-label="Refresh now">
          <RefreshCw size={13} className={status === "loading" ? "stn__spin" : ""} />
        </button>
      </div>
      <button type="button" className="now__mine" onClick={() => void openMine()}>
        <MapPin size={14} />
        My local weather
      </button>
      {note && <div className="now__note">{note}</div>}
      {NOW_GROUPS.map((g) => (
        <Group key={g.id} id={g.id} nowMs={nowMs} busy={busy} onOpen={onOpen} />
      ))}
      <p className="now__src">
        NWS alerts (api.weather.gov), storm reports (NWS via IEM), SPC outlooks. A line opens the nearest radar: CC for a tornado on
        the ground, velocity for tornado and wind threats, reflectivity for hail, flooding and outlooks.
      </p>
    </div>
  );
}
