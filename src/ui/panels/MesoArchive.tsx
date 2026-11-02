import { MESO_EVENTS } from "../../lib/mesoEvents";
import { useArchiveStore } from "../../store/useArchiveStore";

const DAY = 86_400;

/** "31 May 2013 23Z". */
export function archiveWhen(unix: number, minutes = false): string {
  const d = new Date(unix * 1000);
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${mo} ${d.getUTCFullYear()} ${hh}${minutes ? `:${mm}` : ""}Z`;
}

/** The convective day (12Z to 11Z) an instant falls in, by its start. */
function dayStart(unix: number): number {
  return Math.floor((unix - 12 * 3600) / DAY) * DAY + 12 * 3600;
}

/**
 * The days worth opening: one click turns the mesoanalysis and the radar on at
 * the hour that mattered and puts the map over it.
 */
export function NotableDays() {
  const at = useArchiveStore((s) => s.at);
  const openEvent = useArchiveStore((s) => s.openEvent);
  const picked = MESO_EVENTS.find((e) => dayStart(e.at) === dayStart(at)) ?? null;

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
            onClick={() => void openEvent(e)}
            title={`Open ${archiveWhen(e.at)} with the K${e.radar} radar`}
          >
            <span className="mesoev__name">{e.name}</span>
            <span className="mesoev__sub">
              <span>
                {e.place} · K{e.radar}
              </span>
              <span className="mesoev__when">{archiveWhen(e.at)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="sfx__ends">
        <span>Opens the mesoanalysis at the hour that mattered and the radar that saw it.</span>
      </div>
    </div>
  );
}
