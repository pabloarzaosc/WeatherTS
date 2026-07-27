import { useEffect, useRef, useState } from "react";
import { Compass, RotateCcw, Sparkles, Trash2, Upload } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useOnboardingStore } from "../../store/useOnboardingStore";
import { useNexradStore } from "../../store/useNexradStore";
import { usePaletteStore } from "../../store/usePaletteStore";
import { layoutIsCustom, useLayoutStore, type Side } from "../../store/useLayoutStore";
import { buildLut, palGradient, parsePal } from "../../lib/pal";
import { INITIAL_VIEW } from "../../map/mapStyle";
import { getMap } from "../../map/mapInstance";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`seg__btn${o.v === value ? " is-active" : ""}`}
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`switch${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{label}</span>
    </button>
  );
}

/** Gradient strip of a .pal table, so a bad import is visible at a glance. */
function PalStrip({ pal }: { pal: string }) {
  const table = parsePal(pal);
  if (table.entries.length < 2) return null;
  const { vmin, vmax } = buildLut(table);
  return (
    <div className="palstrip">
      <div
        className="palstrip__bar"
        style={{ background: `linear-gradient(to right, ${palGradient(table)})` }}
      />
      <div className="palstrip__scale">
        <span>{vmin}</span>
        <span>{vmax}</span>
      </div>
    </div>
  );
}

/** Import + manage user .pal colour tables for the radar. */
function PaletteSettings() {
  const custom = usePaletteStore((s) => s.custom);
  const overrides = usePaletteStore((s) => s.overrides);
  const add = usePaletteStore((s) => s.add);
  const remove = usePaletteStore((s) => s.remove);
  const setTarget = usePaletteStore((s) => s.setTarget);
  const builtins = useNexradStore((s) => s.palettes);
  const loadCatalog = useNexradStore((s) => s.loadCatalog);
  const repaint = useNexradStore((s) => s.repaint);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  // the built-in list comes from the backend; Settings can be opened first
  useEffect(() => {
    if (!builtins.length) void loadCatalog();
  }, [builtins.length, loadCatalog]);

  const targetOf = (id: string) => Object.entries(overrides).find(([, v]) => v === id)?.[0] ?? "";

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setAdded(null);
    const ok: string[] = [];
    for (const file of Array.from(files)) {
      const res = add(file.name, await file.text());
      if (!res.ok) {
        setError(`${file.name}: ${res.error}`);
        break;
      }
      const where = res.target ? ` → replaces ${res.target}` : " (pick what it replaces below)";
      ok.push(`${file.name}${where}`);
    }
    if (ok.length) {
      setAdded(ok.join(", "));
      repaint(); // the radar may be showing the palette we just replaced
    }
    if (fileRef.current) fileRef.current.value = ""; // re-importing the same file should re-fire
  };

  const changeTarget = (id: string, target: string) => {
    setTarget(id, target);
    repaint();
  };

  const onRemove = (id: string) => {
    remove(id);
    repaint();
  };

  return (
    <section className="content__sec">
      <h4 className="content__label">Radar color palettes</h4>
      <p className="content__hint">
        GRLevelX <code>.pal</code> files — <code>Color: value r g b</code> lines, in real data units (dBZ, kt).
        An imported table <em>replaces</em> a built-in one, so every product using it picks it up. If the file
        has a <code>Product:</code> line we wire it up automatically.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".pal,text/plain"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button type="button" className="btn-reset" onClick={() => fileRef.current?.click()}>
        <Upload size={14} /> Import .pal file
      </button>

      {error && <div className="sv__notice">{error}</div>}
      {added && !error && (
        <div className="content__hint" style={{ color: "var(--accent)" }}>
          Imported {added}
        </div>
      )}

      {custom.length === 0 ? (
        <div className="content__hint">No custom palettes yet.</div>
      ) : (
        <ul className="pallist">
          {custom.map((p) => (
            <li key={p.id} className="pallist__item">
              <div className="pallist__head">
                <span className="pallist__name" title={p.label}>
                  {p.label}
                  {p.product && <em className="pallist__prod"> {p.product}</em>}
                </span>
                <button
                  type="button"
                  className="pallist__del"
                  onClick={() => onRemove(p.id)}
                  title={`Remove ${p.label}`}
                  aria-label={`Remove ${p.label}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <PalStrip pal={p.pal} />
              <label className="pallist__target">
                <span>Replaces</span>
                <select value={targetOf(p.id)} onChange={(e) => changeTarget(p.id, e.target.value)}>
                  <option value="">— not used —</option>
                  {builtins.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Settings panel — app preferences. */
/** Where the docked regions sit, and a way back from any arrangement. */
function LayoutSettings() {
  const panelSide = useLayoutStore((s) => s.panelSide);
  const alertSide = useLayoutStore((s) => s.alertSide);
  const setPanelSide = useLayoutStore((s) => s.setPanelSide);
  const setAlertSide = useLayoutStore((s) => s.setAlertSide);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const custom = useLayoutStore(layoutIsCustom);

  const Sides = ({ value, onChange }: { value: Side; onChange: (s: Side) => void }) => (
    <div className="laysides">
      {(["left", "right"] as const).map((s) => (
        <button
          key={s}
          type="button"
          className={`layside${value === s ? " is-on" : ""}`}
          onClick={() => onChange(s)}
        >
          {s === "left" ? "Left" : "Right"}
        </button>
      ))}
    </div>
  );

  return (
    <section className="content__sec">
      <h4 className="content__label">Layout</h4>
      <p className="content__hint">
        Drag the product picker, colour scale, zoom stack and pixel readout anywhere on
        the map. The two docked columns choose a side here.
      </p>

      <div className="content__row">
        <span className="content__rowlabel">Data panel</span>
        <Sides value={panelSide} onChange={setPanelSide} />
      </div>
      <div className="content__row">
        <span className="content__rowlabel">Alert rail</span>
        <Sides value={alertSide} onChange={setAlertSide} />
      </div>

      <button type="button" className="layreset" onClick={resetLayout} disabled={!custom}>
        <RotateCcw size={13} /> Reset layout
      </button>
    </section>
  );
}

export function SettingsContent() {
  const reduceMotion = useAppStore((s) => s.reduceMotion);
  const setReduceMotion = useAppStore((s) => s.setReduceMotion);
  const coordFormat = useAppStore((s) => s.coordFormat);
  const setCoordFormat = useAppStore((s) => s.setCoordFormat);
  const setProjection = useAppStore((s) => s.setProjection);

  const resetDefaults = () => {
    setProjection("mercator");
    setReduceMotion(false);
    setCoordFormat("decimal");
    getMap()?.flyTo({
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      bearing: 0,
      pitch: 0,
      essential: true,
    });
  };

  return (
    <div className="content">
      <LayoutSettings />

      <section className="content__sec">
        <h4 className="content__label">Motion</h4>
        <Toggle on={reduceMotion} label="Reduce motion" onChange={setReduceMotion} />
      </section>

      <section className="content__sec">
        <h4 className="content__label">Coordinates</h4>
        <Segmented
          value={coordFormat}
          onChange={setCoordFormat}
          options={[
            { v: "decimal", label: "Decimal" },
            { v: "dms", label: "DMS" },
          ]}
        />
      </section>

      <PaletteSettings />

      <section className="content__sec">
        <h4 className="content__label">Guides</h4>
        <div className="set__guides">
          <button
            type="button"
            className="set__guide"
            onClick={() => useOnboardingStore.getState().openQuickStart()}
          >
            <Compass size={14} />
            <span>
              <b>Quick start</b>
              <i>Re-run the setup pass</i>
            </span>
          </button>
          <button
            type="button"
            className="set__guide"
            onClick={() => useOnboardingStore.getState().openWhatsNew()}
          >
            <Sparkles size={14} />
            <span>
              <b>What&rsquo;s new</b>
              <i>Release log for every version</i>
            </span>
          </button>
        </div>
      </section>

      <button type="button" className="btn-reset" onClick={resetDefaults}>
        <RotateCcw size={14} /> Restore defaults
      </button>
    </div>
  );
}
