import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Globe, Loader2, Map as MapIcon } from "lucide-react";

import {
  CATEGORY_ORDER,
  byRegion,
  latestCycle,
  type ModelInfo,
} from "../lib/modelFields";
import { selectCurrentModel, useModelStore } from "../store/useModelStore";
import { useMslpStore } from "../store/useMslpStore";

/** "+18 h", or "Analysis" at f000 -- which is what f000 actually is. */
function hourLabel(hour: number): string {
  if (hour === 0) return "Analysis";
  if (hour < 24) return `+${hour} h`;
  const d = Math.floor(hour / 24);
  const h = hour % 24;
  return h === 0 ? `+${d} d` : `+${d} d ${h} h`;
}

/**
 * Two-level menu: categories down the side, that category's models grouped by
 * the centre that runs them. A flat list of thirteen entries -- and it only
 * grows -- stops being scannable, and "which models do I have at mesoscale"
 * is the question actually being asked.
 */
function Menu({ models: all, onPick }: { models: ModelInfo[]; onPick: (id: string) => void }) {
  // The one model product this bar drives today is the pressure field, so a
  // model without sea level pressure would be a choice that draws nothing.
  const models = useMemo(() => all.filter((m) => m.mslp !== false), [all]);
  const modelId = useModelStore((s) => s.modelId);
  const categories = useMemo(() => {
    const present = [...new Set(models.map((m) => m.category))];
    return present.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  }, [models]);

  const currentCategory = models.find((m) => m.id === modelId)?.category;
  const [cat, setCat] = useState(() => currentCategory ?? categories[0] ?? "Global");
  const shown = models.filter((m) => m.category === cat);

  return (
    <div className="mdlmenu">
      <div className="mdlmenu__cats">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className={`mdlmenu__cat${c === cat ? " is-on" : ""}`}
            onMouseEnter={() => setCat(c)}
            onFocus={() => setCat(c)}
            onClick={() => setCat(c)}
          >
            {c}
            <ChevronRight size={12} />
          </button>
        ))}
      </div>

      <div className="mdlmenu__list">
        {byRegion(shown).map(([region, list]) => (
          <div key={region} className="mdlmenu__group">
            <span className="mdlmenu__region">{region}</span>
            {list.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mdlmenu__item${m.id === modelId ? " is-on" : ""}`}
                onClick={() => onPick(m.id)}
                title={`${m.org} — ${m.coverage}`}
              >
                <span className="mdlmenu__name">{m.label}</span>
                <b className="mdlmenu__cycle">{String(latestCycle(m)).padStart(2, "0")}z</b>
                <b className="mdlmenu__hours">{String(m.maxHour).padStart(3, "0")}</b>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The model picker. Sits under the category grid because that is the order the
 * work happens in -- pick the product, then the model that feeds it -- and it
 * dims itself when the open category has nothing to do with models.
 *
 * Which model is chosen here; which *hour* is scrubbed on the map timeline at
 * the bottom, alongside radar and soundings. One clock for the whole app beats
 * a second slider in here competing with it.
 */
export function ModelBar({ disabled = false, reason }: { disabled?: boolean; reason?: string }) {
  const models = useModelStore((s) => s.models);
  const hour = useModelStore((s) => s.hour);
  const loading = useModelStore((s) => s.loading);
  const error = useModelStore((s) => s.error);
  const load = useModelStore((s) => s.load);
  const setModel = useModelStore((s) => s.setModel);
  const current = useModelStore(selectCurrentModel);

  // Status of the one model product that exists so far. When satellite lands it
  // reports here too, so the bar always says what the selection produced.
  const busy = useMslpStore((s) => s.busy);
  const run = useMslpStore((s) => s.run);
  const valid = useMslpStore((s) => s.valid);

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // A menu that outlives the thing it belongs to is a bug; close it when the
  // bar is dimmed, and on any click that lands outside.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className={`modelbar${disabled ? " is-disabled" : ""}`} ref={root} aria-disabled={disabled}>
      <div className="modelbar__head">
        <span>Model</span>
        {current && (
          <b title={`${current.org} — ${current.coverage}`}>
            {current.global ? <Globe size={10} /> : <MapIcon size={10} />}
            {current.coverage}
          </b>
        )}
      </div>

      <button
        type="button"
        className="modelbar__trigger"
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span>
          {models.length === 0
            ? loading
              ? "Loading models…"
              : "No models"
            : (current?.label ?? "Select a model")}
        </span>
        {current && <i>{current.category}</i>}
        <ChevronDown size={14} />
      </button>

      {open && !disabled && (
        <Menu
          models={models}
          onPick={(id) => {
            setModel(id);
            setOpen(false);
          }}
        />
      )}

      <div className={`modelbar__foot${error ? " is-error" : ""}`}>
        {disabled ? (
          <span>{reason ?? "This layer does not use a model."}</span>
        ) : error ? (
          <>Model list unavailable: {error}</>
        ) : busy ? (
          <>
            <Loader2 size={11} className="modelbar__spin" /> Building {hourLabel(hour)}…
          </>
        ) : run ? (
          <>
            <span>Init {run}</span>
            <span>
              Valid {valid} · F{String(hour).padStart(3, "0")}
            </span>
          </>
        ) : (
          <span>Enable a model layer — scrub the hour on the map timeline</span>
        )}
      </div>
    </div>
  );
}
