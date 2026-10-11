import { Radio } from "lucide-react";

import { getMap } from "../../map/mapInstance";
import { MESO_EVENTS, RADAR_ARCHIVE_FROM, type MesoEvent } from "../../lib/mesoEvents";
import { useAppStore } from "../../store/useAppStore";
import { useNexradStore } from "../../store/useNexradStore";
import { selectObsFrame, selectObsProduct, useObsStore } from "../../store/useObsStore";

const LAYER = "observations";
const DAY = 86_400;

/** "2013-05-31" for an instant, in UTC (what a date input holds). */
function isoDay(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** "31 May 2013 23Z". */
function when(unix: number): string {
  const d = new Date(unix * 1000);
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${mo} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}Z`;
}

/** The convective day (12Z to 11Z) an instant falls in, by its start. */
function dayStart(unix: number): number {
  return Math.floor((unix - 12 * 3600) / DAY) * DAY + 12 * 3600;
}

/**
 * The mesoanalysis archive's part of the Models panel: the day to open
 * ("day"), and the days worth opening ("events"). Its hours are the frames of
 * the Hour picker and of the map's timeline, like any analysis's.
 */
export function MesoArchive({ range, part }: { range: { from: number; to: number }; part: "day" | "events" }) {
  const archiveAt = useObsStore((s) => s.archiveAt);
  const setArchiveAt = useObsStore((s) => s.setArchiveAt);
  const frames = useObsStore((s) => s.frames);
  const frame = useObsStore(selectObsFrame);
  const product = useObsStore(selectObsProduct);

  // The day on screen: from its frames once they are here, else the moment picked.
  const shown = frames.length ? frames[0].unix : archiveAt != null ? dayStart(archiveAt) : null;
  const current = frame?.unix ?? archiveAt;
  const picked = MESO_EVENTS.find((e) => shown != null && dayStart(e.at) === shown) ?? null;

  const open = (e: MesoEvent) => {
    const app = useAppStore.getState();
    if (!app.layers[LAYER]?.visible) app.setLayerVisible(LAYER, true);
    // A day picked for its storms opens on what made them, unless a severe
    // product is already on.
    if (product?.group !== "Severe Weather") useObsStore.getState().setField("stp_eff");
    setArchiveAt(e.at);
    getMap()?.flyTo({ center: e.center, zoom: e.zoom, duration: 1200, essential: true });
  };

  const openRadar = (e: MesoEvent) => {
    if (!e.radar) return;
    useAppStore.getState().setLayerVisible("nexrad", true);
    useNexradStore.getState().openAt(e.radar, current ?? e.at);
  };

  const pickDay = (value: string) => {
    if (!value) return;
    const [y, m, d] = value.split("-").map(Number);
    // The afternoon of the day picked: where a severe day's environment peaks.
    const at = Date.UTC(y, m - 1, d, 21) / 1000;
    setArchiveAt(Math.min(Math.max(at, range.from), range.to));
  };

  if (part === "day") {
    return (
      <div className="sfx__block">
        <div className="sfx__head">
          <span>Day</span>
          <b>{current != null ? when(current) : "—"}</b>
        </div>
        <label className="sfcobs__field">
          <input
            type="date"
            value={shown != null ? isoDay(shown) : ""}
            min={isoDay(range.from)}
            max={isoDay(range.to)}
            onChange={(e) => pickDay(e.target.value)}
            aria-label="Day to open"
          />
        </label>
        <div className="sfx__ends">
          <span>
            Opens from 12Z to 11Z the next morning, SPC's convective day, on the afternoon. Every hour since January
            2005: the RUC until May 2012, the RAP since.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="sfx__block">
      <div className="sfx__head">
        <span>Notable days</span>
        <b>{MESO_EVENTS.length}</b>
      </div>
      <div className="mesoev" role="list">
        {MESO_EVENTS.map((e) => (
          <button
            key={e.id}
            type="button"
            role="listitem"
            className={`mesoev__row${picked?.id === e.id ? " is-on" : ""}`}
            onClick={() => open(e)}
            title={`Open ${when(e.at)}`}
          >
            <span className="mesoev__name">{e.name}</span>
            <span className="mesoev__sub">
              <span>{e.place}</span>
              <span className="mesoev__when">{when(e.at)}</span>
            </span>
          </button>
        ))}
      </div>
      {picked && picked.radar && picked.at >= RADAR_ARCHIVE_FROM ? (
        <div className="sfx__chips">
          <button type="button" className="sfx__chip sfx__chip--wide" onClick={() => openRadar(picked)}>
            <Radio size={11} /> Radar from K{picked.radar} at this hour
          </button>
        </div>
      ) : picked ? (
        <div className="sfx__ends">
          <span>The app's radar archive starts in March 2022, so this day has the analysis only.</span>
        </div>
      ) : null}
    </div>
  );
}
