import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Play, RotateCcw, Search, Square, X } from "lucide-react";

import { Select } from "../Select";
import {
  ALERT_COLOR_EVENTS,
  FLASH_OPTIONS,
  SETTING_DEFS,
  SOUND_OPTIONS,
  alertColorKey,
  alertTierKey,
  alertTypeKey,
  type AlertTypeProp,
  type SettingValue,
} from "../../settings/schema";
import { useSettingsStore } from "../../settings/useSettingsStore";
import { ALERT_TIERS, HAZARD_GROUPS, hazardOf, type AlertSoundId, type TierDef } from "../../lib/alertTiers";
import { playAlertSound, playingAlertSound, stopAlertSound } from "../../lib/alertSounds";
import { getSetting } from "../../settings/useSettingsStore";

const PROPS: AlertTypeProp[] = ["on", "line", "border", "fill", "flash", "flashColor", "sound"];

/** Every settings key of one type. */
const typeKeys = (event: string) => [alertColorKey(event), ...PROPS.map((p) => alertTypeKey(event, p))];
const tierKeys = (t: TierDef) => [alertTierKey(t.id, "color"), alertTierKey(t.id, "sound")];

/** The tiers drawn on a type's page. */
function tiersOf(label: string): TierDef[] {
  return ALERT_TIERS.filter((t) => t.of === label || (t.family === "watch" && /watch/i.test(label)));
}

function useValue<T extends SettingValue>(key: string): [T, (v: T) => void] {
  const stored = useSettingsStore((s) => s.values[key]);
  const set = useSettingsStore((s) => s.set);
  const value = (stored !== undefined ? stored : SETTING_DEFS[key]?.default) as T;
  return [value, (v: T) => set(key, v)];
}

function Toggle({ k, label }: { k: string; label: string }) {
  const [on, set] = useValue<boolean>(k);
  return (
    <button type="button" className={`switch setx__switch${on ? " is-on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)}>
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
    </button>
  );
}

function Colour({ k, label }: { k: string; label: string }) {
  const [v, set] = useValue<string>(k);
  return (
    <label className="setx__color">
      <span className="setx__hex">{v.toUpperCase()}</span>
      <input type="color" value={v} onChange={(e) => set(e.target.value)} aria-label={label} />
    </label>
  );
}

function Range({ k, label }: { k: string; label: string }) {
  const [v, set] = useValue<number>(k);
  const def = SETTING_DEFS[k];
  if (!def || def.type !== "slider") return null;
  return (
    <span className="atype__range">
      <input className="setx__range" type="range" min={def.min} max={def.max} step={def.step} value={v} onChange={(e) => set(Number(e.target.value))} aria-label={label} />
      <span className="setx__value">{v === 0 ? "None" : `${v.toFixed(1)}×`}</span>
    </span>
  );
}

function Choice({ k, label, options }: { k: string; label: string; options: { value: string; label: string }[] }) {
  const [v, set] = useValue<string>(k);
  return <Select value={v} onChange={set} options={options} aria-label={label} />;
}

/** Plays the sound picked in `k`; pressed again while it plays, stops it. */
function Preview({ k, label }: { k: string; label: string }) {
  const [v] = useValue<string>(k);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (playing && playingAlertSound()) {
      stopAlertSound();
      setPlaying(false);
      return;
    }
    if (playAlertSound(v as AlertSoundId, getSetting<number>("alerts.volume"))) {
      setPlaying(true);
      window.setTimeout(() => setPlaying(false), 3400);
    }
  };
  return (
    <button type="button" className="atype__play" onClick={toggle} disabled={v === "none"} title={`Play ${label}`} aria-label={`Play ${label}`}>
      {playing ? <Square size={11} /> : <Play size={11} />}
    </button>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="atype__line">
      <span className="atype__label">{label}</span>
      <span className="atype__ctl">{children}</span>
    </div>
  );
}

function TierRow({ t }: { t: TierDef }) {
  const values = useSettingsStore((s) => s.values);
  const reset = useSettingsStore((s) => s.reset);
  const keys = tierKeys(t);
  const modified = keys.some((k) => values[k] !== undefined);
  const color = (values[keys[0]] as string | undefined) ?? t.color;
  return (
    <div className="atype__tier" title={t.hint}>
      <span className="atype__tiername">
        <span className="atype__chip" style={{ ["--chip" as string]: color }}>
          {t.label}
        </span>
        {(t.family === "watch" || t.family === "pds") && <span className="atype__tierof">{t.of}</span>}
        {modified && (
          <button type="button" className="setx__reset" onClick={() => keys.forEach(reset)} title="Back to default" aria-label={`Reset ${t.label}`}>
            <RotateCcw size={11} />
          </button>
        )}
      </span>
      <Colour k={keys[0]} label={`${t.of} ${t.label} colour`} />
      <span className="atype__tiersound">
        <Choice k={keys[1]} label={`${t.of} ${t.label} sound`} options={SOUND_OPTIONS} />
        <Preview k={keys[1]} label={`${t.of} ${t.label} sound`} />
      </span>
    </div>
  );
}

function TypePage({ event, label, open, onToggle }: { event: string; label: string; open: boolean; onToggle: () => void }) {
  const values = useSettingsStore((s) => s.values);
  const reset = useSettingsStore((s) => s.reset);
  const keys = typeKeys(event);
  const modified = keys.some((k) => values[k] !== undefined);
  const color = (values[keys[0]] as string | undefined) ?? (SETTING_DEFS[keys[0]]?.default as string);
  const shown = (values[alertTypeKey(event, "on")] as boolean | undefined) ?? true;
  const sound = (values[alertTypeKey(event, "sound")] as string | undefined) ?? (SETTING_DEFS[alertTypeKey(event, "sound")]?.default as string);
  const tiers = tiersOf(label);
  return (
    <div className={`atype${open ? " is-open" : ""}${shown ? "" : " is-off"}`}>
      <button type="button" className="atype__head" onClick={onToggle} aria-expanded={open}>
        <span className="atype__swatch" style={{ background: color }} />
        <span className="atype__name">{label}</span>
        {!shown && <span className="atype__tag">Hidden</span>}
        {sound !== "none" && <span className="atype__tag">Sound</span>}
        {modified && <span className="atype__tag atype__tag--mod">Modified</span>}
        <ChevronDown size={13} className="atype__chev" />
      </button>
      {open && (
        <div className="atype__body">
          <Line label="Show this type">
            <Toggle k={alertTypeKey(event, "on")} label={`Show ${label}`} />
          </Line>
          <Line label="Colour">
            <Colour k={keys[0]} label={`${label} colour`} />
          </Line>
          <Line label="Outline width">
            <Range k={alertTypeKey(event, "line")} label={`${label} outline width`} />
          </Line>
          <Line label="Dark edge">
            <Toggle k={alertTypeKey(event, "border")} label={`${label} dark edge`} />
          </Line>
          <Line label="Fill strength">
            <Range k={alertTypeKey(event, "fill")} label={`${label} fill strength`} />
          </Line>
          <Line label="Flash when new">
            <Choice k={alertTypeKey(event, "flash")} label={`${label} flash`} options={FLASH_OPTIONS} />
            <Colour k={alertTypeKey(event, "flashColor")} label={`${label} flash colour`} />
          </Line>
          <Line label="Sound">
            <Choice k={alertTypeKey(event, "sound")} label={`${label} sound`} options={SOUND_OPTIONS} />
            <Preview k={alertTypeKey(event, "sound")} label={`${label} sound`} />
          </Line>
          {tiers.length > 0 && (
            <div className="atype__tiers">
              <span className="atype__sub">Intensity levels</span>
              {tiers.map((t) => (
                <TierRow key={t.id} t={t} />
              ))}
            </div>
          )}
          {(modified || tiers.some((t) => tierKeys(t).some((k) => values[k] !== undefined))) && (
            <button
              type="button"
              className="setx__btn atype__resetall"
              onClick={() => {
                keys.forEach(reset);
                tiers.forEach((t) => tierKeys(t).forEach(reset));
              }}
            >
              <RotateCcw size={12} /> Reset {label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

let pendingType: string | null = null;

/** Open one alert type's page (from the Settings search); it is picked up
 *  when the Alerts section mounts, or at once when it is already open. */
export function openAlertTypePage(event: string): void {
  pendingType = event;
  window.dispatchEvent(new CustomEvent("weatherts:alert-type-page"));
}

/**
 * The per-type alert settings: every NWS product under its hazard, each with
 * its own page (shown, colour, outline, dark edge, fill, flash, sound) and, for
 * the tiered ones, its intensity levels. A search box narrows the types.
 */
export function AlertTypeSettings({ query: outer }: { query?: string }) {
  const [own, setOwn] = useState("");
  const [openType, setOpenType] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(["severe"]));
  // ux-shell: the Settings search opens one type's page (openAlertTypePage).
  useEffect(() => {
    const take = () => {
      const ev = pendingType;
      if (!ev) return;
      pendingType = null;
      const label = ALERT_COLOR_EVENTS.find((e) => e.event === ev)?.label ?? ev;
      setOwn("");
      setOpenType(ev);
      setOpenGroups((prev) => new Set(prev).add(hazardOf(label)));
    };
    take();
    window.addEventListener("weatherts:alert-type-page", take);
    return () => window.removeEventListener("weatherts:alert-type-page", take);
  }, []);
  const values = useSettingsStore((s) => s.values);
  const reset = useSettingsStore((s) => s.reset);
  const q = (own || outer || "").trim().toLowerCase();

  const groups = useMemo(() => {
    return HAZARD_GROUPS.map((g) => ({
      ...g,
      types: ALERT_COLOR_EVENTS.filter((e) => hazardOf(e.label) === g.id).filter(
        (e) => !q || e.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q),
      ),
    })).filter((g) => g.types.length > 0);
  }, [q]);

  const allKeys = useMemo(
    () => [...ALERT_COLOR_EVENTS.flatMap((e) => typeKeys(e.event)), ...ALERT_TIERS.flatMap(tierKeys)],
    [],
  );
  const changed = allKeys.filter((k) => values[k] !== undefined).length;

  return (
    <div className="atypes">
      <div className="atypes__search">
        <Search size={13} />
        <input type="search" value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Search alert types" aria-label="Search alert types" />
        {own && (
          <button type="button" className="setx__clear" onClick={() => setOwn("")} aria-label="Clear alert type search">
            <X size={12} />
          </button>
        )}
      </div>
      {groups.length === 0 && <p className="atypes__empty">No alert type matches.</p>}
      {groups.map((g) => {
        const open = Boolean(q) || openGroups.has(g.id);
        const mods = g.types.filter((e) => typeKeys(e.event).some((k) => values[k] !== undefined)).length;
        return (
          <section key={g.id} className={`atypes__group${open ? " is-open" : ""}`}>
            <button
              type="button"
              className="atypes__ghead"
              aria-expanded={open}
              onClick={() =>
                setOpenGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(g.id)) next.delete(g.id);
                  else next.add(g.id);
                  return next;
                })
              }
            >
              <span>{g.label}</span>
              <span className="atypes__count">{g.types.length}</span>
              {mods > 0 && <span className="atype__tag atype__tag--mod">{mods} modified</span>}
              <ChevronDown size={13} className="atype__chev" />
            </button>
            {open &&
              g.types.map((e) => (
                <TypePage
                  key={e.event}
                  event={e.event}
                  label={e.label}
                  open={openType === e.event}
                  onToggle={() => setOpenType((cur) => (cur === e.event ? null : e.event))}
                />
              ))}
          </section>
        );
      })}
      {!q && (
        <div className="atypes__tiers">
          <span className="atype__sub">Intensity levels of watches and other warnings</span>
          {ALERT_TIERS.filter((t) => t.family === "watch" || t.family === "pds").map((t) => (
            <TierRow key={t.id} t={t} />
          ))}
        </div>
      )}
      {changed > 0 && (
        <button type="button" className="setx__btn setx__btn--section" onClick={() => allKeys.forEach(reset)}>
          <RotateCcw size={12} /> Reset every alert type ({changed} changed)
        </button>
      )}
    </div>
  );
}
