import { useShellStore } from "../store/useShellStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20:16:43 UTC · 20 May 2013" */
function fmtWhen(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Broadcast mode's caption, top-left of every pane in larger type: the radar,
 * the product and its tilt ("KTLX REF 0.5°") over the scan time. Nothing when
 * the pane shows no radar.
 */
export function BroadcastCaption({ paneId }: { paneId: string }) {
  const on = useShellStore((s) => s.mode === "broadcast");
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const pane = useNexradStore((s) => s.paneRadar[paneId]);
  const loopSite = useNexradStore((s) => s.site);
  const sites = useNexradStore((s) => s.sites);
  const grids = useNexradStore((s) => s.grids);
  const catalog = useNexradStore((s) => s.catalog);
  if (!on || !radarOn || !pane || pane.empty) return null;
  const scan = pane.scan;
  const siteId = pane.site || scan?.meta.site || loopSite;
  if (!siteId) return null;
  const icao = sites.find((x) => x.id === siteId)?.icao ?? siteId;
  const fam = grids.find((f) => f.id === pane.family) ?? catalog.find((f) => f.id === pane.family);
  const name = fam?.short ?? fam?.label ?? pane.family;
  const elev = scan?.meta.elevation;
  const when = scan?.meta.sweepUnix ?? scan?.meta.scanUnix ?? scan?.meta.validUnix ?? null;
  return (
    <div className="bcast-cap">
      <b>
        {icao} {name}
        {elev != null ? ` ${elev.toFixed(1)}°` : ""}
      </b>
      {when != null && <span>{fmtWhen(when)}</span>}
    </div>
  );
}
