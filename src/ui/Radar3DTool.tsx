import { useEffect, useRef } from "react";

import { getActivePaneId } from "../map/mapInstance";
import { volumeKey } from "../lib/radarFrames";
import { useNexradStore } from "../store/useNexradStore";
import { useRadar3DStore } from "../store/useRadar3DStore";
import { Radar3DBoxTool } from "./Radar3DBoxTool";
import { Radar3DPanel } from "./Radar3DPanel";
import { AnalysisHost } from "./PaneWindows";

/**
 * The 3D view's link to the radar timeline: while it is open on the radar the
 * map shows, it follows the frame on screen. The newest live frame asks for
 * the newest whole volume (a scan still coming in shows the last whole one);
 * older frames ask for their own volume (its Level II key when it has one).
 * Picking another radar on the same pane clears the box and leaves the view
 * open, empty, asking for a new one.
 */
export function Radar3DTool() {
  const open = useRadar3DStore((s) => s.open);
  const site = useNexradStore((s) => s.site);
  const scans = useNexradStore((s) => s.scans);
  const index = useNexradStore((s) => s.index);
  const live = useNexradStore((s) => s.archiveTime === null && s.archiveDate === null);
  const prev = useRef<{ site: string | null; pane: string | null }>({ site, pane: getActivePaneId() });

  useEffect(() => {
    const pane = getActivePaneId();
    const was = prev.current;
    prev.current = { site, pane };
    if (!open || !site || was.site === site || was.pane !== pane) return;
    // The same pane, another radar (an entry point that switched radar first
    // already moved the view there, so nothing is cleared).
    const s = useRadar3DStore.getState();
    if (s.site !== site) s.changeSite(site);
  }, [open, site]);

  useEffect(() => {
    if (!open || !scans.length) return;
    const scan = scans[Math.min(index, scans.length - 1)];
    // The volume still being written is not a volume yet: the 3D view takes
    // the last whole one. A SAILS rescan frame is its volume's.
    const newest = (live && index >= scans.length - 1) || !!scan?.partial;
    const key = !newest && scan?.key?.startsWith("L2") ? volumeKey(scan.key) : "";
    useRadar3DStore.getState().setFrame(site, newest ? null : (scan?.time ?? null), key);
  }, [open, site, scans, index, live]);

  return open ? (
    <>
      <AnalysisHost kind="r3d">
        <Radar3DPanel />
      </AnalysisHost>
      <Radar3DBoxTool />
    </>
  ) : null;
}
