import { useNexradStore } from "../store/useNexradStore";
import { useRadarLiveStore } from "../store/useRadarLiveStore";

/**
 * Under a pane's title: the Level II volume streaming in ("Streaming KTLX ·
 * cut 5 of 12 · 7.0 / 10.6 MB") while a live Level II product is shown, and
 * what the pane is showing instead of the frame asked for -- "1.3° isn't
 * scanned yet" on the in-progress volume (the previous volume is drawn), or
 * Hold elevation's substitute when the scan strategy has no such tilt.
 */
export function RadarLiveNote({ paneId }: { paneId: string }) {
  const pane = useNexradStore((s) => s.paneRadar[paneId]);
  const site = useNexradStore((s) => s.site);
  const live = useRadarLiveStore((s) => (s.site && s.site === site ? s.status : null));
  // A past moment with no frames: the reason, on the map as well as the panels.
  const noFrames = useNexradStore((s) =>
    (s.archiveTime !== null || s.archiveDate !== null) && !s.scans.length && !s.loading ? s.error : null,
  );

  const streaming = !!live && !live.complete && !live.stale && !!pane?.product.startsWith("L2");
  const meta = pane?.scan?.meta;
  // An added radar (archive-l2) with nothing in the loop's window says why.
  const note = meta?.pendingNote ?? meta?.holdNote ?? (pane?.site ? pane.note : null) ?? (pane?.empty ? null : noFrames) ?? undefined;
  if (!streaming && !note) return null;

  const mb = (b: number) => (b / 1e6).toFixed(1);
  return (
    <div className="ll-pane" aria-live="polite">
      {streaming && live && (
        <div className="ll-pane__stream" title="The Level II volume the radar is scanning now, as it reaches the live feed">
          <span className="ll-pane__dot" aria-hidden="true" />
          Streaming {live.site} · cut {Math.min(live.cutsDone + 1, live.cutsPlanned)} of {live.cutsPlanned} ·{" "}
          {mb(live.bytes)} / {mb(live.bytesExpected)} MB
        </div>
      )}
      {note && (
        <div className={`ll-pane__note${meta?.pendingNote ? " is-pending" : ""}`}>
          {note}
          {meta?.pendingNote ? " · showing the previous scan" : ""}
        </div>
      )}
    </div>
  );
}
