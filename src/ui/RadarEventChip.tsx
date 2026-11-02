import { eventById, eventDay } from "../lib/radarEvents";
import { useRadarEventStore } from "../store/useRadarEventStore";

/** The notable event a pane is playing, next to its product in the header. */
export function RadarEventChip() {
  const ev = useRadarEventStore((s) => eventById(s.active));
  if (!ev) return null;
  return (
    <span className="panehead__event" title={`${ev.title} · ${ev.place} · ${eventDay(ev)}`}>
      {ev.title}
    </span>
  );
}
