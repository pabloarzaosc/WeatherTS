import { useSyncExternalStore } from "react";

import { isBrazilSite, isEuropeSite } from "../lib/brazilRadar";
import { framesRev, meanFrameBytes, subscribeFrames } from "../lib/radarFrameStatus";
import { wireOptions } from "../lib/radarOptions";
import { LOOP_MINUTES, useNexradStore } from "../store/useNexradStore";
import { useRadarLiveStore } from "../store/useRadarLiveStore";
import { Select } from "./Select";

/** Typical bytes on the wire for a frame before any has been measured. */
const GUESS_BYTES = { l2: 1_400_000, l3: 260_000 };
/** Typical frames an hour before a loop has been listed. */
const GUESS_PER_HOUR = { l2: 12, l3: 30 };
/** A whole archive Level II volume: 3-6 MB in clear air, 10-16 MB in storms. */
const ARCHIVE_VOLUME_BYTES = 9_000_000;

function label(m: number): string {
  return m < 60 ? `${m} min` : `${m / 60} h`;
}

/**
 * The radar loop's length as a span of time, 30 min to 8 h. Past 4 h the
 * choice says what it costs: about how many frames and how many megabytes,
 * from the frames this loop has already brought in (or a typical one).
 */
export function LoopLength() {
  const site = useNexradStore((s) => s.site);
  const product = useNexradStore((s) => s.product);
  const minutes = useNexradStore((s) => s.loopMinutes);
  const setLoopMinutes = useNexradStore((s) => s.setLoopMinutes);
  const scans = useNexradStore((s) => s.scans);
  useSyncExternalStore(subscribeFrames, framesRev);

  const live = useRadarLiveStore((s) => (s.site && s.site === site ? s.status : null));
  const tilt = useNexradStore((s) => s.tilt);
  const archive = useNexradStore((s) => s.archiveTime !== null || !!s.archiveDate);

  const l2 = product.startsWith("L2");
  const kind = l2 ? "l2" : "l3";
  // Frames an hour as the timeline counts them (SAILS rescans included), and
  // volumes an hour (what Level II downloads come in).
  const rate = (list: typeof scans, guess: number) => {
    if (list.length < 3) return guess;
    const span = (list[list.length - 1].time - list[0].time) / 3600;
    return span > 0.2 ? (list.length - 1) / span : guess;
  };
  const perHour = rate(scans, GUESS_PER_HOUR[kind]);
  const vols = scans.filter((f) => (f.rep ?? 1) === 1 && !f.partial);
  const volsPerHour = rate(vols, GUESS_PER_HOUR[kind]);
  // What the radar data costs to bring in. Level III: the frames as they
  // arrive. Level II live: the chunks of the tilt on screen (each chunk holds
  // one cut, every moment), so the volume's size times its share of the
  // chunks. Level II archive: whole volume files.
  let perVolume = (site && meanFrameBytes(`${site}|${wireOptions(site, product)}|`)) || GUESS_BYTES[kind];
  let unitsPerHour = perHour;
  if (l2 && archive && !isBrazilSite(site)) {
    unitsPerHour = volsPerHour;
    perVolume = ARCHIVE_VOLUME_BYTES;
  } else if (l2 && live && live.chunksPlanned > 1) {
    unitsPerHour = volsPerHour;
    let chunks = 1;
    live.cuts.forEach((c) => {
      if (c.slot === tilt) chunks += c.of;
    });
    perVolume = (live.bytesExpected * Math.max(chunks, 2)) / live.chunksPlanned;
  }
  const cost = (m: number) => {
    const n = Math.round((perHour * m) / 60) + 1;
    const mb = (Math.round((unitsPerHour * m) / 60) * perVolume) / 1e6;
    return `about ${n} frames, ~${mb >= 100 ? Math.round(mb / 10) * 10 : Math.max(1, Math.round(mb))} MB`;
  };

  return (
    <label className="sfcobs__field">
      <span className="sfcobs__label">
        Loop length{isEuropeSite(site) ? " — volumes" : isBrazilSite(site) ? " — the archive volumes" : l2 ? " — Level II volumes" : ""}
      </span>
      <Select
        value={String(minutes)}
        onChange={(value) => setLoopMinutes(Number(value))}
        aria-label="Loop length"
        options={LOOP_MINUTES.map((m) => ({
          value: String(m),
          label: label(m),
          hint: m > 240 ? cost(m) : undefined,
        }))}
      />
      {minutes > 240 && <span className="ll-size">{cost(minutes)} to download</span>}
    </label>
  );
}
