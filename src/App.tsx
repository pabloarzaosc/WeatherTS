import { MapView } from "./map/MapView";
import { TopBar } from "./ui/TopBar";
import { TabsBar } from "./ui/TabsBar";
import { DataPanel } from "./ui/DataPanel";
import { StatusBar } from "./ui/StatusBar";
import { ZoomControls } from "./ui/ZoomControls";
import { MeasureTool } from "./ui/MeasureTool";
import { AlertController } from "./ui/AlertController";
import { AlertPanel } from "./ui/AlertPanel";
import { OutlookLegend } from "./ui/OutlookLegend";
import { MslpLegend } from "./ui/MslpLegend";
import { LightningCounter } from "./ui/LightningCounter";
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
import { DayLoadOverlay } from "./ui/DayLoadOverlay";
import { AnimationModal } from "./ui/AnimationModal";
import { UpdateBanner } from "./ui/UpdateBanner";
import { QuickStart } from "./ui/QuickStart";
import { WhatsNew } from "./ui/WhatsNew";
import { StationPanel } from "./ui/StationPanel";
import { useAppStore } from "./store/useAppStore";
import { selectRailOpen, useAlertStore } from "./store/useAlertStore";
import { useLayoutStore } from "./store/useLayoutStore";

export default function App() {
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
        <div className="watermark">
          WEATHER<span>TS</span>
        </div>
        <TopBar />
        <TabsBar />
        {/* top-left corner of the map: swapping the base is a view control */}
        <BasemapPicker />
        <DataPanel />
        <MeasureTool />
        <OutlookLegend />
        <MslpLegend />
        <LightningCounter />
        <AlertPanel />
        <ZoomControls />
        <StatusBar />
        <SoundingViewer />
        <RadarHud />
        {/* radar storm-cell card, anchored to the cell it describes */}
        <StormPopup />
        {/* the radar's own wind profile */}
        <VwpPanel />
        {/* the clicked storm report, in full */}
        <LsrCard />
        {/* the clicked front or pressure centre */}
        <FrontPopup />
        <MapTimeline />
        <DayLoadOverlay />
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
      <QuickStart />
      <WhatsNew />
    </div>
  );
}
