import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { frameState, framesRev, subscribeFrames, type FrameState } from "../lib/radarFrameStatus";
import { scanId, useNexradStore } from "../store/useNexradStore";

/**
 * The line under the timeline's scrubber for a radar loop: one stretch per
 * frame, coloured by where the frame is -- grey not downloaded, yellow
 * downloading, blue decoding, the accent once ready, red failed -- with the
 * volume still being written hatched ("Scan in progress"). Ticks mark the
 * frames; a SAILS / MRLE rescan's tick is shorter.
 */

const SAY: Record<FrameState, string> = {
  idle: "not downloaded",
  down: "downloading",
  decode: "decoding",
  ready: "ready",
  failed: "failed (tried again after 1 min, 5 min and when the connection comes back)",
};

/** Frames drawn as ticks up to this many; past it the stretches say enough. */
const TICKS_MAX = 160;

export function RadarFrameStrip() {
  const scans = useNexradStore((s) => s.scans);
  const site = useNexradStore((s) => s.site);
  const product = useNexradStore((s) => s.product);
  useSyncExternalStore(subscribeFrames, framesRev);

  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = scans.length;
  const step = n > 1 ? w / (n - 1) : w;
  const runs: { x0: number; x1: number; st: FrameState | "partial"; from: number; to: number }[] = [];
  if (site && w > 0) {
    scans.forEach((f, i) => {
      const st: FrameState | "partial" = f.partial ? "partial" : frameState(scanId(f.site ?? site, f.product ?? product, f.key));
      const x0 = n > 1 ? Math.max(0, (i - 0.5) * step) : 0;
      const x1 = n > 1 ? Math.min(w, (i + 0.5) * step) : w;
      const last = runs[runs.length - 1];
      if (last && last.st === st) {
        last.x1 = x1;
        last.to = i;
      } else {
        runs.push({ x0, x1, st, from: i, to: i });
      }
    });
  }
  const rescans = scans.some((f) => (f.rep ?? 1) > 1);

  return (
    <svg ref={ref} className="ll-strip" height={10} aria-hidden="true">
      <defs>
        <pattern id="ll-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} className="ll-hatch__bg" />
          <rect width={2} height={4} className="ll-hatch__fg" />
        </pattern>
      </defs>
      {runs.map((r) => (
        <rect
          key={`${r.from}-${r.st}`}
          x={r.x0}
          y={7}
          width={Math.max(1, r.x1 - r.x0)}
          height={3}
          className={`ll-seg ll-seg--${r.st}`}
          fill={r.st === "partial" ? "url(#ll-hatch)" : undefined}
        >
          <title>
            {r.st === "partial"
              ? "Scan in progress"
              : `${r.from === r.to ? `Frame ${r.from + 1}` : `Frames ${r.from + 1}-${r.to + 1}`}: ${SAY[r.st]}`}
          </title>
        </rect>
      ))}
      {site && w > 0 && n > 1 && n <= TICKS_MAX &&
        scans.map((f, i) => {
          const short = (f.rep ?? 1) > 1;
          return (
            <rect
              key={f.key}
              x={Math.min(w - 1, Math.max(0, i * step - 0.5))}
              y={short ? 3.5 : rescans ? 1 : 3}
              width={1}
              height={short ? 2.5 : rescans ? 5 : 3}
              className={`ll-tick${short ? " is-rescan" : ""}`}
            />
          );
        })}
    </svg>
  );
}
