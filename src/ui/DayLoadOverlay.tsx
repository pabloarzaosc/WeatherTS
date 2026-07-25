import { X } from "lucide-react";

import { useNexradStore } from "../store/useNexradStore";

// Blocking overlay while a whole archived day is pulled down. A day is ~400
// scans / ~70 MB, so it is deliberately modal: the loop is only worth playing
// once every frame is cached, and the user needs a way out.

export function DayLoadOverlay() {
  const dayLoad = useNexradStore((s) => s.dayLoad);
  const archiveDate = useNexradStore((s) => s.archiveDate);
  const cancel = useNexradStore((s) => s.cancelDayLoad);

  if (!dayLoad) return null;

  const { done, total } = dayLoad;
  // total is 0 for the moment between picking a day and the list arriving
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="dayload" role="dialog" aria-modal="true" aria-label="Loading archived day">
      <div className="dayload__card">
        <div className="dayload__head">
          <div>
            <div className="dayload__title">Loading {archiveDate}</div>
            <div className="dayload__sub">
              {total > 0 ? `${done} of ${total} scans` : "Finding scans…"}
            </div>
          </div>
          <button type="button" className="dayload__x" onClick={cancel} aria-label="Cancel">
            <X size={16} />
          </button>
        </div>

        <div className="dayload__bar">
          <div
            className={`dayload__fill${total > 0 ? "" : " dayload__fill--idle"}`}
            style={total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>

        <div className="dayload__foot">
          <span className="dayload__pct">{total > 0 ? `${pct}%` : ""}</span>
          <button type="button" className="dayload__cancel" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
