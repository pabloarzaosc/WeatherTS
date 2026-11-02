import type { ReactNode } from "react";
import { Check, Keyboard } from "lucide-react";

import { FEATURES, PRESETS, type FeatureKind } from "../../lib/features";
import { activeTableId, choicesFor } from "../../lib/colorTables";
import { currentPreset, useFeatureStore } from "../../store/useFeatureStore";
import { useNexradStore } from "../../store/useNexradStore";
import { usePaletteStore } from "../../store/usePaletteStore";
import { useShellStore } from "../../store/useShellStore";
import { Select } from "../Select";

/**
 * Settings blocks of the ux-shell step: the Interface rows (minimal UI,
 * broadcast mode, the shortcut list), Features (presets + a switch per
 * feature) and the colour table each product draws with. Same row markup as
 * SettingsContent's own rows, so they read as one list.
 */

function Row({ label, hint, control }: { label: string; hint?: string; control?: ReactNode }) {
  return (
    <div className="setx__row">
      <div className="setx__rowmain">
        <div className="setx__text">
          <span className="setx__label">{label}</span>
          {hint && <span className="setx__hint">{hint}</span>}
        </div>
        {control && <div className="setx__control">{control}</div>}
      </div>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`switch setx__switch${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
    </button>
  );
}

// ------------------------------------------------------------- interface ---

export function ShellRows() {
  const mode = useShellStore((s) => s.mode);
  const shell = useShellStore.getState();
  return (
    <>
      <Row
        label="Minimal UI"
        hint="Hides the dock, panels, status bar and timeline so the map fills the window. Ctrl+\ or the top edge brings them back."
        control={<Switch on={mode === "minimal"} label="Minimal UI" onChange={(v) => shell.setMode(v ? "minimal" : "normal")} />}
      />
      <Row
        label="Broadcast mode"
        hint="The map alone, with a caption per pane and the logo, for streaming. Kept after a restart; leave with Ctrl+\ or the button at the top edge."
        control={<Switch on={mode === "broadcast"} label="Broadcast mode" onChange={(v) => shell.setMode(v ? "broadcast" : "normal")} />}
      />
      <Row
        label="Keyboard shortcuts"
        hint="Every key the app has. Press ? anywhere."
        control={
          <button type="button" className="setx__btn" onClick={() => shell.setShortcutsOpen(true)}>
            <Keyboard size={12} /> Show
          </button>
        }
      />
    </>
  );
}

// -------------------------------------------------------------- features ---

const KIND_TITLE: Record<FeatureKind, string> = { panel: "Panels", tool: "Tools", layer: "Layers" };

export function FeaturesBlock() {
  const off = useFeatureStore((s) => s.off);
  const setOn = useFeatureStore((s) => s.setOn);
  const applyPreset = useFeatureStore((s) => s.applyPreset);
  const preset = currentPreset(off);
  return (
    <div className="feat">
      <p className="setx__hint">
        Turn off what you never use: its buttons and layers leave the app until you turn it back on. Nothing is deleted.
      </p>
      <div className="feat__presets" role="radiogroup" aria-label="Feature preset">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={preset === p.id}
            className={`feat__preset${preset === p.id ? " is-on" : ""}`}
            onClick={() => applyPreset(p.id)}
            title={p.blurb}
          >
            <span className="feat__mark">{preset === p.id && <Check size={12} />}</span>
            <b>{p.label}</b>
            <i>{p.blurb}</i>
          </button>
        ))}
      </div>
      {preset === "custom" && <p className="setx__hint feat__custom">Your own mix: {off.length} off.</p>}
      {(["panel", "tool", "layer"] as FeatureKind[]).map((kind) => (
        <div key={kind}>
          <h5 className="setx__group">{KIND_TITLE[kind]}</h5>
          {FEATURES.filter((f) => f.kind === kind).map((f) => (
            <Row
              key={f.id}
              label={f.label}
              hint={f.hint}
              control={<Switch on={!off.includes(f.id)} label={f.label} onChange={(v) => setOn(f.id, v)} />}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- colour tables ---

/** The products a colour table can be chosen for, by the kind the backend
 *  draws them as (nexrad_core._KIND_DEFAULT_PALETTE). */
export const KIND_NAMES: [string, string][] = [
  ["ref", "Reflectivity"],
  ["vel", "Velocity"],
  ["srv", "Storm relative velocity"],
  ["sw", "Spectrum width"],
  ["zdr", "Differential reflectivity"],
  ["cc", "Correlation coefficient"],
  ["kdp", "Specific differential phase"],
  ["phi", "Differential phase"],
  ["hca", "Hydrometeor classification"],
  ["tops", "Echo tops"],
  ["vil", "VIL"],
  ["dvil", "VIL density"],
  ["nrot", "Normalized rotation"],
  ["vrot", "Rotational velocity"],
  ["ptds", "Tornado debris (PTDS)"],
  ["mehs", "Hail size (MEHS)"],
  ["posh", "Probability of severe hail"],
  ["precip", "One hour precip"],
  ["storm_precip", "Storm total precip"],
  ["rate", "Rain rate"],
  ["cfp", "Clutter filter power"],
];

export function ProductTables() {
  const tables = useNexradStore((s) => s.palTables);
  const kindDefaults = useNexradStore((s) => s.kindDefaults);
  // Re-render when a choice or a saved palette changes.
  usePaletteStore((s) => s.overrides);
  usePaletteStore((s) => s.custom);
  const select = usePaletteStore((s) => s.select);
  const rows = KIND_NAMES.filter(([kind]) => kindDefaults[kind] && tables[kindDefaults[kind]]);
  if (!rows.length) return <p className="setx__hint">The colour tables load with the radar list.</p>;
  return (
    <>
      <p className="setx__hint">
        The table each product draws with, in every pane. ] and [ step through them on the focused pane; click a pane&apos;s
        colour bar to edit one.
      </p>
      {rows.map(([kind, name]) => {
        const pid = kindDefaults[kind];
        const choices = choicesFor(pid, tables, kindDefaults);
        const active = activeTableId(pid, tables);
        return (
          <Row
            key={kind}
            label={name}
            control={
              <Select
                value={active}
                onChange={(v) => select(pid, v === pid ? null : v)}
                aria-label={`${name} colour table`}
                options={choices.map((c) => ({ value: c.id, label: c.source === "default" ? `Default (${c.label})` : c.label }))}
              />
            }
          />
        );
      })}
    </>
  );
}
