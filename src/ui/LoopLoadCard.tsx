import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { selectObsProduct, useObsStore } from "../store/useObsStore";
import { selectSatProduct, selectSatSatellite, useSatStore } from "../store/useSatStore";

/**
 * Progress of a satellite or analysis loop while its frames come in, with a way
 * to stop it. A loop downloads only once play is pressed. Unlike the archived
 * radar day this does not block the map: a loop
 * loads in seconds and the map stays usable meanwhile. Closing it stops the
 * download -- what is already in stays, and the frame on screen still loads.
 */

/** A loop that is in within this long never shows the card: no flash on a pan. */
const APPEAR_AFTER_MS = 600;

interface Job {
  id: "sat" | "obs";
  title: string;
  detail: string;
  done: number;
  total: number;
  stop: () => void;
}

export function LoopLoadCard() {
  const satOn = useAppStore((s) => s.layers["satellite"]?.visible ?? false);
  const obsOn = useAppStore((s) => s.layers["observations"]?.visible ?? false);

  const satLoaded = useSatStore((s) => s.loopLoaded);
  const satTotal = useSatStore((s) => s.loopTotal);
  const satArmed = useSatStore((s) => s.loopArmed);
  const satProduct = useSatStore(selectSatProduct);
  const satellite = useSatStore(selectSatSatellite);

  const obsLoaded = useObsStore((s) => s.loopLoaded);
  const obsTotal = useObsStore((s) => s.loopTotal);
  const obsArmed = useObsStore((s) => s.loopArmed);
  const obsProduct = useObsStore(selectObsProduct);
  const obsSource = useObsStore((s) => s.catalog?.sources.find((x) => x.id === s.source) ?? null);

  const jobs: Job[] = [];
  if (satOn && satArmed && satTotal > 1 && satLoaded < satTotal) {
    jobs.push({
      id: "sat",
      title: "Loading satellite loop",
      detail: [satellite?.label, satProduct?.label].filter(Boolean).join(" · "),
      done: satLoaded,
      total: satTotal,
      stop: () => useSatStore.getState().stopLoop(),
    });
  }
  if (obsOn && obsArmed && obsTotal > 1 && obsLoaded < obsTotal) {
    jobs.push({
      id: "obs",
      title: "Loading analysis loop",
      detail: [obsSource?.label, obsProduct?.label].filter(Boolean).join(" · "),
      done: obsLoaded,
      total: obsTotal,
      stop: () => useObsStore.getState().stopLoop(),
    });
  }

  // Shown only once a loop has been loading for a moment.
  const loading = jobs.map((j) => j.id).join(",");
  const [visible, setVisible] = useState("");
  useEffect(() => {
    if (!loading) {
      setVisible("");
      return;
    }
    const t = window.setTimeout(() => setVisible(loading), APPEAR_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [loading]);

  const shown = jobs.filter((j) => visible.split(",").includes(j.id));
  if (shown.length === 0) return null;

  return (
    <div className="loopload">
      {shown.map((job) => {
        const pct = Math.round((job.done / job.total) * 100);
        return (
          <div key={job.id} className="dayload__card loopload__card" role="status" aria-live="polite">
            <div className="dayload__head">
              <div className="loopload__text">
                <div className="dayload__title">{job.title}</div>
                <div className="dayload__sub loopload__sub">
                  {job.done} of {job.total} frames{job.detail ? ` · ${job.detail}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="dayload__x"
                onClick={job.stop}
                aria-label="Stop loading the loop"
                title="Stop loading"
              >
                <X size={16} />
              </button>
            </div>
            <div className="dayload__bar loopload__bar">
              <div className="dayload__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="dayload__foot">
              <span className="dayload__pct">{pct}%</span>
              <button type="button" className="dayload__cancel" onClick={job.stop}>
                Stop
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
