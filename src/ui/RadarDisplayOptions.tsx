import { useSyncExternalStore } from "react";

import { Select } from "./Select";
import { useSetting, useSettingsStore } from "../settings/useSettingsStore";
import { useNexradStore } from "../store/useNexradStore";
import { useRadarDisplayStore } from "../store/useRadarDisplayStore";
import { useAppStore } from "../store/useAppStore";
import { getActivePaneId, subscribeMaps } from "../map/mapInstance";
import { focusedPaneId } from "../lib/radarDisplayInstall";
import { previewSweep } from "../layers/radarSweep";

// The radar panel's display options beyond smoothing / threshold (display-opts):
// gate filter, flash reflectivity, maximum value trail and opacity for the
// focused pane, and the scan line. Shared options are settings (Settings >
// Radar holds the same keys); the trail and the opacity are per pane.

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`sfc-switch${on ? " is-on" : ""}`}
      onClick={onClick}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span className="sfc-switch__knob" />
    </button>
  );
}

const GATE_MAX = 95;

/** Two thumbs on one track: the low and high reflectivity kept. */
function GateFilter() {
  const set = useSettingsStore((s) => s.set);
  const lo = Number(useSetting<number>("radar.gateLow"));
  const hi = Number(useSetting<number>("radar.gateHigh"));
  const off = lo <= 0 && hi >= GATE_MAX;
  const left = (lo / GATE_MAX) * 100;
  const right = (hi / GATE_MAX) * 100;
  return (
    <div className="sfcobs__field dispopt__gate">
      <span className="sfcobs__label dispopt__row">
        <span>Gate filter</span>
        <span className="dispopt__val">
          {off ? "Off" : `${lo} to ${hi} dBZ`}
          {!off && (
            <button
              type="button"
              className="dispopt__reset"
              onClick={() => {
                set("radar.gateLow", 0);
                set("radar.gateHigh", GATE_MAX);
              }}
            >
              Reset
            </button>
          )}
        </span>
      </span>
      <div className="gatef" style={{ ["--gl" as string]: `${left}%`, ["--gh" as string]: `${right}%` }}>
        <div className="gatef__track" />
        <div className="gatef__fill" />
        <input
          type="range"
          min={0}
          max={GATE_MAX}
          step={1}
          value={lo}
          aria-label="Lowest reflectivity shown"
          onChange={(e) => set("radar.gateLow", Math.min(Number(e.target.value), hi))}
        />
        <input
          type="range"
          min={0}
          max={GATE_MAX}
          step={1}
          value={hi}
          aria-label="Highest reflectivity shown"
          onChange={(e) => set("radar.gateHigh", Math.max(Number(e.target.value), lo))}
        />
      </div>
      <small className="dispopt__note">Hides gates outside the range on reflectivity, and the same gates on velocity and dual-pol of the tilt.</small>
    </div>
  );
}

function FlashOptions() {
  const set = useSettingsStore((s) => s.set);
  const on = useSetting<boolean>("radar.flash");
  const min = Number(useSetting<number>("radar.flashMin"));
  const color = useSetting<string>("radar.flashColor");
  const opacity = Number(useSetting<number>("radar.flashOpacity"));
  return (
    <>
      <div className="sfcobs__toggle-row">
        <span>
          Flash reflectivity
          <small className="dispopt__note dispopt__inline">reflectivity panes</small>
        </span>
        <Toggle on={on} onClick={() => set("radar.flash", !on)} label="Flash reflectivity" />
      </div>
      {on && (
        <div className="dispopt__sub">
          <label className="sfcobs__field">
            <span className="sfcobs__label">
              From <b className="dispopt__num">{min}</b> dBZ
            </span>
            <input type="range" min={20} max={80} step={1} value={min} onChange={(e) => set("radar.flashMin", Number(e.target.value))} />
          </label>
          <div className="dispopt__pair">
            <label className="setx__color">
              <span className="sfcobs__label">Colour</span>
              <input type="color" value={color} onChange={(e) => set("radar.flashColor", e.target.value)} aria-label="Flash colour" />
            </label>
            <label className="sfcobs__field dispopt__grow">
              <span className="sfcobs__label">
                Opacity <b className="dispopt__num">{Math.round(opacity * 100)}%</b>
              </span>
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => set("radar.flashOpacity", Number(e.target.value))} />
            </label>
          </div>
        </div>
      )}
    </>
  );
}

/** The trail and the opacity of the focused pane. */
function PaneOptions() {
  useSyncExternalStore(subscribeMaps, getActivePaneId);
  const paneCount = useNexradStore((s) => Object.keys(s.paneRadar).length);
  const id = focusedPaneId();
  const trail = useRadarDisplayStore((s) => !!s.trail[id]);
  const own = useRadarDisplayStore((s) => s.opacity[id]);
  const toggleTrail = useRadarDisplayStore((s) => s.toggleTrail);
  const setOpacity = useRadarDisplayStore((s) => s.setPaneOpacity);
  const layerOpacity = useAppStore((s) => s.layers.nexrad?.opacity ?? 0.85);
  const shown = own ?? layerOpacity;
  const where = paneCount > 1 ? "this pane" : null;
  return (
    <>
      <div className="sfcobs__toggle-row">
        <span>
          Maximum value trail <kbd className="dispopt__kbd">T</kbd>
          {where && <small className="dispopt__note dispopt__inline">{where}</small>}
        </span>
        <Toggle on={trail} onClick={() => toggleTrail(id)} label="Maximum value trail" />
      </div>
      {trail && (
        <small className="dispopt__note dispopt__sub">
          Each point keeps its highest value since the loop's first frame: hail cores, rotation and debris paths.
        </small>
      )}
      <label className="sfcobs__field">
        <span className="sfcobs__label dispopt__row">
          <span>
            Opacity <b className="dispopt__num">{Math.round(shown * 100)}%</b>
            {where && <small className="dispopt__note dispopt__inline">{where}</small>}
          </span>
          {own != null && (
            <button type="button" className="dispopt__reset" onClick={() => setOpacity(id, null)}>
              Same as layer
            </button>
          )}
        </span>
        <input type="range" min={0} max={1} step={0.05} value={shown} onChange={(e) => setOpacity(id, Number(e.target.value))} />
      </label>
    </>
  );
}

const LINE_MODES = [
  { value: "never", label: "Never" },
  { value: "new", label: "When a new scan arrives" },
  { value: "always", label: "Always" },
];
const SOUNDS = [
  { value: "off", label: "Off" },
  { value: "start", label: "When a sweep starts" },
  { value: "update", label: "Every update" },
];
const EFFECTS = [
  { value: "blip", label: "Radar blip" },
  { value: "tone", label: "Sweep tone" },
  { value: "tick", label: "Soft tick" },
];

function ScanLineOptions() {
  const set = useSettingsStore((s) => s.set);
  const mode = useSetting<string>("radar.scanLine");
  const color = useSetting<string>("radar.scanLineColor");
  const marks = useSetting<string>("radar.scanMarksColor");
  const every = Number(useSetting<number>("radar.scanMarksKm"));
  const sound = useSetting<string>("radar.scanSound");
  const effect = useSetting<string>("radar.scanSoundEffect");
  const volume = Number(useSetting<number>("radar.scanSoundVolume"));
  return (
    <>
      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Scan line <small className="dispopt__note dispopt__inline">live radar</small>
        </span>
        <Select value={mode} onChange={(v) => set("radar.scanLine", v)} aria-label="Scan line" options={LINE_MODES} />
      </label>
      {mode !== "never" && (
        <div className="dispopt__sub">
          <div className="dispopt__pair">
            <label className="setx__color">
              <span className="sfcobs__label">Sweep</span>
              <input type="color" value={color} onChange={(e) => set("radar.scanLineColor", e.target.value)} aria-label="Sweep colour" />
            </label>
            <label className="setx__color">
              <span className="sfcobs__label">Marks</span>
              <input type="color" value={marks} onChange={(e) => set("radar.scanMarksColor", e.target.value)} aria-label="Increment marks colour" />
            </label>
          </div>
          <label className="sfcobs__field">
            <span className="sfcobs__label">
              Marks every <b className="dispopt__num">{every}</b> km
            </span>
            <input type="range" min={10} max={50} step={5} value={every} onChange={(e) => set("radar.scanMarksKm", Number(e.target.value))} />
          </label>
          <label className="sfcobs__field">
            <span className="sfcobs__label">Sound</span>
            <Select value={sound} onChange={(v) => set("radar.scanSound", v)} aria-label="Sweep sound" options={SOUNDS} />
          </label>
          {sound !== "off" && (
            <div className="dispopt__pair">
              <label className="sfcobs__field dispopt__grow">
                <span className="sfcobs__label">Effect</span>
                <Select value={effect} onChange={(v) => set("radar.scanSoundEffect", v)} aria-label="Sound effect" options={EFFECTS} />
              </label>
              <label className="sfcobs__field dispopt__grow">
                <span className="sfcobs__label">
                  Volume <b className="dispopt__num">{Math.round(volume * 100)}%</b>
                </span>
                <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => set("radar.scanSoundVolume", Number(e.target.value))} />
              </label>
            </div>
          )}
          <button type="button" className="setx__btn dispopt__preview" onClick={() => previewSweep()}>
            Preview
          </button>
        </div>
      )}
    </>
  );
}

export function RadarDisplayOptions() {
  return (
    <>
      <GateFilter />
      <FlashOptions />
      <PaneOptions />
      <ScanLineOptions />
    </>
  );
}
