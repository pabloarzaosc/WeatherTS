import { useEffect } from "react";
import { Crosshair, ExternalLink, X } from "lucide-react";

import { getMap } from "../map/mapInstance";
import { useMesoscaleStore } from "../store/useMesoscaleStore";

const HAZARD_LABEL: Record<string, string> = {
  severe: "Severe weather",
  flood: "Flooding",
  other: "Mesoscale discussion",
};

/** Two centres, two products, and a chaser needs to know which one they are
 *  reading -- SPC writes about severe storms, WPC about the rain. */
const title = (kind: string) =>
  kind === "mpd" ? "Mesoscale Precipitation Discussion" : "Mesoscale Discussion";

/** The whole SPC product, opened from the map card. */
export function MesoscalePanel() {
  const mds = useMesoscaleStore((s) => s.mds);
  const reportId = useMesoscaleStore((s) => s.reportId);
  const close = useMesoscaleStore((s) => s.openReport);

  const md = mds.find((m) => m.id === reportId) ?? null;

  useEffect(() => {
    if (!reportId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportId, close]);

  if (!md) return null;

  return (
    <div
      className="mdrep__back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
    >
      <div className={`mdrep mdrep--${md.hazard}`} role="dialog" aria-label={`${title(md.kind)} ${md.number}`}>
        <header className="mdrep__head">
          <div>
            <b>
              {title(md.kind)} {md.number}
            </b>
            <span className="mdrep__tag">{HAZARD_LABEL[md.hazard] ?? md.hazard}</span>
          </div>
          <button type="button" onClick={() => close(null)} title="Close" aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <dl className="mdrep__rows">
          {md.areas && (
            <>
              <dt>Areas affected</dt>
              <dd>{md.areas}</dd>
            </>
          )}
          {md.concerning && (
            <>
              <dt>Concerning</dt>
              <dd>{md.concerning}</dd>
            </>
          )}
          {md.valid && (
            <>
              <dt>Valid</dt>
              <dd>{md.valid}</dd>
            </>
          )}
        </dl>

        {md.summary && (
          <section className="mdrep__sec">
            <h4>Summary</h4>
            <p>{md.summary}</p>
          </section>
        )}

        {md.discussion && (
          <section className="mdrep__sec">
            <h4>Discussion</h4>
            <p>{md.discussion}</p>
          </section>
        )}

        {/* The product exactly as issued. Monospaced and unreflowed, because
            SPC writes it to a fixed width and the line breaks carry meaning. */}
        <section className="mdrep__sec">
          <h4>Full product</h4>
          <pre className="mdrep__raw">{md.text}</pre>
        </section>

        <div className="mdrep__acts">
          <button
            type="button"
            className="mdrep__act"
            onClick={() => getMap()?.flyTo({ center: [md.lon, md.lat], zoom: 6, essential: true })}
          >
            <Crosshair size={12} /> Center
          </button>
          <a className="mdrep__act" href={md.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={12} /> {md.kind === "mpd" ? "On wpc.ncep.noaa.gov" : "On spc.noaa.gov"}
          </a>
        </div>
      </div>
    </div>
  );
}
