import { useEffect } from "react";
import { MapView } from "./map/MapView";
import { Dock } from "./ui/Dock";
import { SearchBar } from "./ui/SearchBar";
import { DataPanel } from "./ui/DataPanel";
import { StatusBar } from "./ui/StatusBar";
import { ZoomControls } from "./ui/ZoomControls";
import { MeasureTool } from "./ui/MeasureTool";
import { CrossSectionTool } from "./ui/CrossSectionTool";
import { HydrographPanel } from "./ui/HydrographPanel";
import { SpaceDashboard } from "./ui/space/SpaceDashboard";
import { SpaceMapHud } from "./ui/space/SpaceMapHud";
import { TropicalDashboard } from "./ui/tropical/TropicalDashboard";
import { TropicalMapHud } from "./ui/tropical/TropicalMapHud";
import { DrawTool } from "./ui/DrawTool";
import { AlertController } from "./ui/AlertController";
import { AlertPanel } from "./ui/AlertPanel";
import { OutlookLegend } from "./ui/OutlookLegend";
import { BasemapPicker } from "./ui/BasemapPicker";
import { MapContextMenu } from "./ui/sounding/MapContextMenu";
import { SoundingViewer } from "./ui/sounding/SoundingViewer";
import { AreaSoundingOverlay } from "./ui/sounding/AreaSoundingOverlay";
import { AreaBoxTool } from "./ui/sounding/AreaBoxTool";
import { StormPopup } from "./ui/StormPopup";
import { VwpPanel } from "./ui/VwpPanel";
import { LsrCard } from "./ui/LsrCard";
import { FrontPopup } from "./ui/FrontPopup";
import { MapTimeline } from "./ui/MapTimeline";
import { RadarHud } from "./ui/RadarHud";
import { RadarReadout } from "./ui/RadarReadout";
import { ObsReadout } from "./ui/ObsReadout";
import { ObsCompare } from "./ui/ObsCompare";
import { RunStrip } from "./ui/RunStrip";
import { DayLoadOverlay } from "./ui/DayLoadOverlay";
import { LoopLoadCard } from "./ui/LoopLoadCard";
import { AnimationModal } from "./ui/AnimationModal";
import { UpdateBanner } from "./ui/UpdateBanner";
import { QuickStart } from "./ui/QuickStart";
import { WhatsNew } from "./ui/WhatsNew";
import { StationPanel } from "./ui/StationPanel";
import { StormCellPanel } from "./ui/StormCellPanel";
import { ChaserController } from "./ui/ChaserController";
import { ChaserPopup } from "./ui/ChaserPopup";
import { MesoscalePopup } from "./ui/MesoscalePopup";
import { MesoscalePanel } from "./ui/MesoscalePanel";
import { useAppStore } from "./store/useAppStore";
import { selectRailOpen, useAlertStore } from "./store/useAlertStore";
import { useLayoutStore } from "./store/useLayoutStore";

/** The app's phone layout, where the side panel and the alert rail are sheets over the map. */
const PHONE = "(max-width: 820px), (max-height: 500px)";

/**
 * On a phone both side surfaces are full-height sheets over the map, so with
 * both open they lie on top of each other -- the catalog's buttons over the
 * alert list's. Opening one there puts the other away.
 */
function usePhoneSheets() {
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const closeRail = () => {
      const a = useAlertStore.getState();
      a.setListOpen(false);
      a.select(null);
    };
    const unPanel = useAppStore.subscribe(
      (s) => s.leftPanelOpen,
      (open) => {
        if (open && mq.matches && selectRailOpen(useAlertStore.getState())) closeRail();
      },
    );
    const unRail = useAlertStore.subscribe(selectRailOpen, (open) => {
      if (open && mq.matches && useAppStore.getState().leftPanelOpen) useAppStore.getState().toggleLeftPanel();
    });
    // Both open already: at start, or a window narrowed into the phone layout.
    const settle = () => {
      if (mq.matches && useAppStore.getState().leftPanelOpen && selectRailOpen(useAlertStore.getState())) closeRail();
    };
    settle();
    mq.addEventListener("change", settle);
    return () => {
      unPanel();
      unRail();
      mq.removeEventListener("change", settle);
    };
  }, []);
}

export default function App() {
  usePhoneSheets();
  // The HUD's left inset (--map-left) has to follow the panel, or the product
  // picker and colour bar stay parked in the panel's old column once it closes.
  const leftPanelOpen = useAppStore((s) => s.leftPanelOpen);
  // Same idea on the right: the alert rail is a column, so the map and every
  // right-anchored HUD element shrink by --alert-w while it's open.
  const alertsOpen = useAlertStore(selectRailOpen);
  // Which side each docked region took. The CSS turns these into --pad-left /
  // --pad-right, and everything over the map follows from those two.
  const panelSide = useLayoutStore((s) => s.panelSide);
  const alertSide = useLayoutStore((s) => s.alertSide);
  return (
    <div
      className={`app${leftPanelOpen ? "" : " app--panel-closed"}${
        alertsOpen ? " app--alerts-open" : ""
      }`}
      data-panel={panelSide}
      data-alerts={alertSide}
    >
      <MapView />
      {/* alerts orchestration (fetches NWS data; renders nothing) */}
      <AlertController />
      {/* HUD overlay: click-through container; each child re-enables pointer events */}
      <div className="hud">
        {/* The tool dock replaces the top bar and the tab strip: every control
            that sat in a row across the top now lives down one edge, and the
            drawers slide out of it. */}
        <Dock />
        {/* search floats on the map now that there is no bar to live in */}
        <div className="mapsearch">
          <SearchBar />
        </div>
        {/* top-left corner of the map: swapping the base is a view control */}
        <BasemapPicker />
        <DataPanel />
        <MeasureTool />
        <CrossSectionTool />
        <HydrographPanel />
        <SpaceMapHud />
        <TropicalMapHud />
        <SpaceDashboard />
        <TropicalDashboard />
        <DrawTool />
        <OutlookLegend />
        <AlertPanel />
        <ZoomControls />
        <StatusBar />
        <SoundingViewer />
        <RadarHud />
        {/* the gate value under the pointer, pinned to the pointer */}
        <RadarReadout />
        <ObsReadout />
        {/* the Models compare views: models side by side, or the runs of one */}
        <ObsCompare />
        <RunStrip />
        {/* radar storm-cell card, anchored to the cell it describes */}
        <StormPopup />
        <ChaserPopup />
        {/* the clicked SPC mesoscale discussion */}
        <MesoscalePopup />
        {/* the radar's own wind profile */}
        <VwpPanel />
        {/* the clicked storm report, in full */}
        <LsrCard />
        {/* the clicked front or pressure centre */}
        <FrontPopup />
        <MapTimeline />
        <DayLoadOverlay />
        {/* an analysis loop loading, with a way to stop it */}
        <LoopLoadCard />
        <UpdateBanner />
      </div>
      {/* map right-click menu (renders its own fixed overlay) */}
      <MapContextMenu />
      {/* footprint of an open area-averaged sounding (draws on the map, renders nothing) */}
      <AreaSoundingOverlay />
      {/* drag-to-draw the area a sounding averages over */}
      <AreaBoxTool />
      {/* the Customize Animation dialog (top-bar video icon) */}
      <AnimationModal />
      {/* first-run setup and the release log; both self-mount and stay hidden
          until they have a reason to appear, or Settings opens them */}
      {/* full METAR report, opened from the map card */}
      <StationPanel />
      {/* full storm-cell report with the per-scan trends, likewise from its card */}
      <StormCellPanel />
      {/* joins the chaser channel and, only when opted in, broadcasts this device */}
      <ChaserController />
      {/* the full SPC discussion, opened from its card */}
      <MesoscalePanel />
      <QuickStart />
      <WhatsNew />
    </div>
  );
}
