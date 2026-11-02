import { RotateCcw } from "lucide-react";

import { MOTION_RESET, isLevel2Srv, type MotionMode } from "../lib/radarOptions";
import type { PolarScan } from "../lib/radarMesh";
import { useSetting, useSettingsStore } from "../settings/useSettingsStore";
import { isTdwrId, useNexradStore } from "../store/useNexradStore";
import { Select } from "./Select";

// Velocity options in the Radar panel: dealiasing, range-folded gates and,
// while SRV is on screen, the storm motion it takes out. One app-wide choice
// each (Settings > Radar > Velocity); radarOptions.ts carries them to the
// server on the product code and radarKeys.ts reloads the frame on a change.

const DEALIAS = [
  { value: "region", label: "Region-based", hint: "default" },
  { value: "vad", label: "VAD-seeded", hint: "for hurricanes and strong wind fields" },
  { value: "off", label: "Off", hint: "as the radar measured it" },
];

const MODES: { id: MotionMode; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "Track the echoes between this volume and the one before (else the NWS cells' mean motion)" },
  { id: "sti", label: "From STI", title: "The mean motion of the NWS storm cells (Storm Tracking Information)" },
  { id: "manual", label: "Manual", title: "Your own direction and speed" },
];

/** What the server says it took out of this SRV scan. */
interface MotionMeta {
  stormMotionFrom?: number;
  stormMotionKt?: number;
  motionSource?: string;
}

const SOURCE_TEXT: Record<string, string> = {
  track: "echo tracking",
  sti: "NWS storm cells",
  manual: "manual",
  none: "no motion found",
};

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

export function VelocityOptions() {
  const set = useSettingsStore((s) => s.set);
  const dealias = useSetting<string>("radar.dealias");
  const showRf = useSetting<boolean>("radar.showRangeFolded");
  const mode = useSetting<string>("radar.stormMotionMode") as MotionMode;
  const from = useSetting<number>("radar.stormMotionFrom");
  const kt = useSetting<number>("radar.stormMotionKt");
  const product = useNexradStore((s) => s.product);
  const kind = useNexradStore((s) => s.scan?.meta.kind ?? null);
  const site = useNexradStore((s) => s.site);
  const grids = useNexradStore((s) => s.grids);
  const setFamily = useNexradStore((s) => s.setFamily);
  // The SRV scan whose motion we report: the focused pane's, else any pane's.
  const srvScan = useNexradStore((s): PolarScan | null => {
    if (isLevel2Srv(s.product) && s.scan) return s.scan;
    for (const p of Object.values(s.paneRadar)) if (isLevel2Srv(p.product) && p.scan) return p.scan;
    return null;
  });
  const anySrv = useNexradStore((s) => isLevel2Srv(s.product) || Object.values(s.paneRadar).some((p) => isLevel2Srv(p.product)));
  if (!site || site.toUpperCase().startsWith("BR-")) return null;

  const meta = (srvScan?.meta ?? null) as (MotionMeta & Record<string, unknown>) | null;
  const inUse =
    meta && typeof meta.stormMotionFrom === "number" && typeof meta.stormMotionKt === "number"
      ? { from: meta.stormMotionFrom, kt: meta.stormMotionKt, source: meta.motionSource ?? "" }
      : null;
  const manual = mode === "manual";
  // Off manual the sliders show the motion in use, so moving one starts from it.
  const shownFrom = manual ? from : Math.round(inUse?.from ?? from);
  const shownKt = manual ? kt : Math.round(inUse?.kt ?? kt);
  const setManual = (f: number, k: number) => {
    set("radar.stormMotionFrom", Math.round(f) % 360);
    set("radar.stormMotionKt", Math.round(k));
    set("radar.stormMotionMode", "manual");
  };
  const l2Srv = grids.find((f) => f.id === "L2S" && !f.unavailable && !f.checking);
  const level3Srm = kind === "srv" && !isLevel2Srv(product);

  return (
    <>
      <div className="sfcobs__section">Velocity</div>
      {/* An airport radar's velocity is Level III, unfolded by the radar: nothing to choose. */}
      {!isTdwrId(site) && (
      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Dealiasing
          <small className="velopt__note"> Level II velocity, SRV, VROT, debris score</small>
        </span>
        <Select value={dealias} onChange={(v) => set("radar.dealias", v)} aria-label="Dealiasing" options={DEALIAS} />
      </label>
      )}
      <div className="sfcobs__toggle-row">
        <span>
          <i className="velopt__rf" aria-hidden="true" />
          Show range folded
        </span>
        <Toggle on={showRf} onClick={() => set("radar.showRangeFolded", !showRf)} label="Show range folded" />
      </div>

      {level3Srm && (
        <div className="velopt__srm">
          Level III SRM takes out the radar's own storm motion.
          {l2Srv && (
            <button type="button" className="velopt__link" onClick={() => setFamily("L2S")}>
              Use SRV (Level II) to set it
            </button>
          )}
        </div>
      )}

      {anySrv && (
        <div className="velopt__motion">
          <div className="velopt__head">
            <span>Storm motion</span>
            <button
              type="button"
              className="velopt__reset"
              onClick={() => setManual(MOTION_RESET.from, MOTION_RESET.kt)}
              title={`Manual, from ${MOTION_RESET.from}° at ${MOTION_RESET.kt} kt`}
            >
              <RotateCcw size={11} /> Reset
            </button>
          </div>
          <div className="velopt__modes" role="radiogroup" aria-label="Storm motion">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={mode === m.id ? "is-on" : ""}
                title={m.title}
                onClick={() => (m.id === "manual" ? setManual(shownFrom, shownKt) : set("radar.stormMotionMode", m.id))}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="velopt__inuse" aria-live="polite">
            {inUse ? (
              inUse.source === "none" ? (
                "No storm motion found for this scan: SRV shows plain velocity."
              ) : (
                <>
                  In use: from <b>{Math.round(inUse.from)}°</b> at <b>{Math.round(inUse.kt)} kt</b>
                  {SOURCE_TEXT[inUse.source] ? <span> · {SOURCE_TEXT[inUse.source]}</span> : null}
                </>
              )
            ) : (
              "Loading the motion in use…"
            )}
          </div>
          <label className={`sfcobs__field velopt__slider${manual ? "" : " is-dim"}`}>
            <span className="sfcobs__label">
              Direction (storms come from) <b>{shownFrom}°</b>
            </span>
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={shownFrom}
              onChange={(e) => setManual(Number(e.target.value), shownKt)}
              aria-label="Storm motion direction, degrees the storms come from"
            />
          </label>
          <label className={`sfcobs__field velopt__slider${manual ? "" : " is-dim"}`}>
            <span className="sfcobs__label">
              Speed <b>{shownKt} kt</b>
            </span>
            <input
              type="range"
              min={0}
              max={90}
              step={1}
              value={shownKt}
              onChange={(e) => setManual(shownFrom, Number(e.target.value))}
              aria-label="Storm motion speed, knots"
            />
          </label>
        </div>
      )}
    </>
  );
}
