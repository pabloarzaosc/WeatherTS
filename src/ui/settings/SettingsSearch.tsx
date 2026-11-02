import { CornerDownLeft } from "lucide-react";

import { ALERT_COLOR_EVENTS, SETTINGS_SECTIONS, type SettingDef } from "../../settings/schema";
import { FEATURES, PRESETS } from "../../lib/features";
import { UNIT_CHOICES } from "../../lib/radarUnits";
import { KIND_NAMES } from "./ShellSettings";

/**
 * Settings search (ux-shell): one list of results for everything Settings
 * holds -- each schema row, the rows kept in other stores, every feature
 * switch, every alert type and the colour table of every product -- matched
 * on the label AND related words ("mph" finds the speed units, "skew-t" the
 * soundings switch). Picking a result opens its section, scrolls to the row
 * and flashes it; Enter in the box picks the first.
 */

export interface SearchSection {
  id: string;
  label: string;
  schema?: string;
}

export interface SettingHit {
  id: string;
  /** The UI section (SettingsContent UI_SECTIONS id) to open. */
  section: string;
  label: string;
  /** "Radar › Units" */
  path: string;
  /** What the match was, when it was not the label ("speed units"). */
  aka?: string;
  /** The row's label as drawn, to find it after the section opens. */
  rowLabel: string;
  /** The sub-heading the row sits under, when its label is not unique in
   *  the section ("Velocity" is a unit row and a colour table row). */
  scope?: string;
  /** Alert types live on their own pages: open that page first. */
  alertType?: string;
  words: string;
  score?: number;
}

/** More words per setting key, for searches that do not use the label. */
const KEY_WORDS: Record<string, string> = {
  "map.placeLabels": "cities labels names towns",
  "map.labelScale": "font text size labels",
  "map.borderColor": "states countries lines",
  "map.graticuleColor": "lat lon latitude longitude grid",
  "map.nightColor": "terminator day night",
  "radar.siteLabels": "sites markers nexrad icao",
  "radar.siteBlink": "sites labels flash pulse new scan",
  "radar.siteVcp": "sites labels vcp scan strategy volume coverage pattern",
  "radar.siteCity": "sites labels city name place",
  "radar.defaultSite": "home radar start startup favourite favorite site",
  "radar.ringColor": "range ring",
  "alerts.sounds": "audio beep noise sound alarm",
  "alerts.volume": "audio loud quiet",
  "alerts.states": "state filter",
  "alerts.wfos": "office wfo cwa",
  "alerts.flashNew": "blink pulse",
  "timeline.loop": "repeat loop",
  "timeline.speed": "fps frame rate fast slow",
  "timeline.loopDelay": "dwell pause hold last frame",
  "ui.scale": "zoom bigger smaller font text size scale dpi",
  "ui.density": "compact tight spacing padding dense",
};

/** Rows that are not in the schema (they live in other stores), with words. */
const EXTRA_ROWS: { section: string; path: string; label: string; aka?: string; words: string }[] = [
  { section: "general", path: "General", label: "Theme", words: "light dark auto appearance night mode colours colors" },
  { section: "general", path: "General", label: "Reduce motion", words: "animation accessibility transitions" },
  { section: "general", path: "General", label: "Coordinates", words: "decimal dms degrees minutes seconds lat lon" },
  { section: "general", path: "General", label: "Projection", words: "globe flat mercator 3d earth" },
  { section: "general", path: "General › Guides", label: "Quick start", words: "guide setup onboarding tour first run how do you watch preset" },
  { section: "general", path: "General › Guides", label: "What's new", words: "release notes changelog version update" },
  { section: "layout", path: "Layout", label: "Data panel side", words: "panel left right drawer" },
  { section: "layout", path: "Layout", label: "Alert rail side", words: "alerts list left right" },
  { section: "layout", path: "Layout", label: "Floating tools", words: "reset drag picker colour scale zoom position" },
  { section: "radar", path: "Radar › Display", label: "Smooth radar data", words: "interpolate blend gates pixelated" },
  { section: "radar", path: "Radar › Display", label: "Range ring", words: "range circle" },
  { section: "radar", path: "Radar › Display", label: "Storm tracks", words: "cells tracking scit motion" },
  { section: "radar", path: "Radar › Display", label: "Value under the pointer", words: "readout hover cursor value" },
  { section: "radar", path: "Radar › Display", label: "Update with new scans", words: "live auto refresh latest" },
  { section: "alerts", path: "Alerts › On the map", label: "Tornado alerts on the map", words: "tornado category filter" },
  { section: "alerts", path: "Alerts › On the map", label: "Severe alerts on the map", words: "severe thunderstorm category filter" },
  { section: "alerts", path: "Alerts › On the map", label: "Special statements on the map", words: "special weather statement sps category filter" },
  { section: "observations", path: "Models", label: "Wind barbs", words: "barbs wind arrows" },
  { section: "observations", path: "Models", label: "Places and values", words: "labels numbers" },
  { section: "observations", path: "Models", label: "Edge of the analysis", words: "boundary domain outline" },
  { section: "surface", path: "Surface stations", label: "Plot size", words: "station model size bigger" },
  { section: "surface", path: "Surface stations", label: "Space between stations", words: "density declutter spacing" },
  { section: "surface", path: "Surface stations", label: "Oldest observation shown", words: "age stale old time" },
  { section: "surface", path: "Surface stations", label: "Dim older observations", words: "fade stale" },
  { section: "surface", path: "Surface stations › Units", label: "Temperature", aka: "Temperature units", words: "temperature units fahrenheit celsius °f °c degrees" },
  { section: "surface", path: "Surface stations › Units", label: "Wind", aka: "Speed units", words: "speed units mph kt knots m/s km/h wind" },
  { section: "surface", path: "Surface stations › Units", label: "Pressure", aka: "Pressure units", words: "pressure units mb hpa millibar inhg inches" },
  { section: "surface", path: "Surface stations › Units", label: "Visibility", aka: "Distance units", words: "distance units miles mi km kilometres kilometers" },
  { section: "chasers", path: "Chasers", label: "Share my position", words: "location gps broadcast share spotter" },
  { section: "interface", path: "Interface", label: "Minimal UI", words: "hide chrome fullscreen ctrl+\\ clean map only" },
  { section: "interface", path: "Interface", label: "Broadcast mode", words: "stream obs tv projector presentation captions logo" },
  { section: "interface", path: "Interface", label: "Keyboard shortcuts", words: "keys hotkeys keyboard ?" },
];

/** Speed and other units per radar unit row. */
const UNIT_WORDS: Record<string, [string, string]> = {
  vel: ["Speed units", "speed units mph kt knots m/s km/h"],
  srv: ["Speed units", "speed units mph kt knots m/s km/h"],
  sw: ["Speed units", "speed units mph kt knots m/s"],
  tops: ["Height units", "height units kft km ft feet metres"],
  precip: ["Rain units", "rain units inches in mm"],
  storm_precip: ["Rain units", "rain units inches in mm"],
  mehs: ["Hail units", "hail units inches in mm"],
  rate: ["Rain rate units", "rain units in/h mm/h"],
};

const KIND_PATH: Record<string, string> = { panel: "Panels", tool: "Tools", layer: "Layers" };

let cache: { key: string; hits: SettingHit[] } | null = null;

function schemaHits(sections: SearchSection[]): SettingHit[] {
  const out: SettingHit[] = [];
  for (const sec of sections) {
    if (!sec.schema) continue;
    const schema = SETTINGS_SECTIONS.find((s) => s.id === sec.schema);
    for (const item of schema?.items ?? []) {
      const d = item as SettingDef;
      out.push({
        id: `s:${d.key}`,
        section: sec.id,
        label: d.label,
        path: [sec.label, d.group].filter(Boolean).join(" › "),
        rowLabel: d.label,
        words: [d.hint, d.group, KEY_WORDS[d.key], d.type === "select" ? d.options.map((o) => o.label).join(" ") : ""].filter(Boolean).join(" "),
      });
    }
  }
  return out;
}

/** Every searchable thing, built once per section list. */
export function settingsIndex(sections: SearchSection[]): SettingHit[] {
  const key = sections.map((s) => s.id).join(",");
  if (cache?.key === key) return cache.hits;
  // Order matters: equal scores keep it (the radar units before the station
  // plot units, a setting before the long lists).
  const hits: SettingHit[] = [
    ...UNIT_CHOICES.map(({ kind, label }) => ({
      id: `u:${kind}`,
      section: "radar",
      label,
      path: "Radar › Units",
      scope: "Units",
      aka: UNIT_WORDS[kind]?.[0] ?? "Units",
      rowLabel: label,
      words: UNIT_WORDS[kind]?.[1] ?? "units",
    })),
    ...EXTRA_ROWS.map((r) => ({ id: `x:${r.section}:${r.label}`, section: r.section, label: r.label, path: r.path, aka: r.aka, rowLabel: r.label, words: r.words })),
    ...schemaHits(sections),
    ...KIND_NAMES.map(([kind, name]) => ({
      id: `t:${kind}`,
      section: "radar",
      label: `${name} colour table`,
      path: "Radar › Colour tables",
      scope: "Colour tables",
      rowLabel: name,
      words: `palette color colour table pal ${kind}`,
    })),
    ...PRESETS.map((p) => ({
      id: `p:${p.id}`,
      section: "features",
      label: `${p.label} preset`,
      path: "Features › Presets",
      rowLabel: p.label,
      words: `preset ${p.blurb}`,
    })),
    ...FEATURES.map((f) => ({
      id: `f:${f.id}`,
      section: "features",
      label: f.label,
      path: `Features › ${KIND_PATH[f.kind]}`,
      aka: "Feature switch",
      rowLabel: f.label,
      words: `feature switch show hide turn off ${f.hint} ${f.words ?? ""}`,
    })),
    ...ALERT_COLOR_EVENTS.map((e) => ({
      id: `a:${e.event}`,
      section: "alerts",
      label: e.label,
      path: `Alerts › Alert types › ${e.group}`,
      aka: "Alert type",
      rowLabel: e.label,
      alertType: e.event,
      words: "alert type colour color outline fill flash sound",
    })),
  ];
  cache = { key, hits };
  return hits;
}

const norm = (s: string) => s.toLowerCase();

/** The results for a query, best first. Every word of the query has to match. */
export function searchSettings(query: string, sections: SearchSection[], limit = 40): SettingHit[] {
  const q = norm(query.trim());
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const out: SettingHit[] = [];
  for (const h of settingsIndex(sections)) {
    const label = norm(h.label);
    const rest = norm(`${h.words} ${h.aka ?? ""}`);
    const path = norm(h.path);
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (label.startsWith(w)) score += 100;
      else if (label.split(/[\s(/·-]+/).some((t) => t.startsWith(w))) score += 70;
      else if (label.includes(w)) score += 50;
      else if (rest.split(/\s+/).some((t) => t.startsWith(w))) score += 30;
      else if (rest.includes(w)) score += 15;
      else if (path.includes(w)) score += 8;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (label === q) score += 200;
    // Plain settings before the long lists of alert types and tables.
    if (h.alertType || h.id.startsWith("t:")) score -= 5;
    out.push({ ...h, score });
  }
  // Array.sort is stable: equal scores stay in index order.
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out.slice(0, limit);
}

export function SettingsResults({
  results,
  active,
  onPick,
  onHover,
}: {
  results: SettingHit[];
  active: number;
  onPick: (h: SettingHit) => void;
  onHover: (i: number) => void;
}) {
  if (!results.length) return <p className="setsr__empty">No setting matches. Try another word, like “units” or “sound”.</p>;
  return (
    <ul className="setsr" role="listbox" aria-label="Settings found">
      {results.map((h, i) => (
        <li
          key={h.id}
          role="option"
          aria-selected={i === active}
          className={`setsr__item${i === active ? " is-active" : ""}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(h);
          }}
        >
          <span className="setsr__label">
            {h.label}
            {h.aka && <em> · {h.aka}</em>}
          </span>
          <span className="setsr__path">{h.path}</span>
          {i === active && <CornerDownLeft size={12} className="setsr__enter" aria-hidden="true" />}
        </li>
      ))}
    </ul>
  );
}

/**
 * After the section has opened: scroll to the row and flash it. Looks for the
 * row by its label inside the section; an alert type is first opened on its
 * own page. Falls back to the section's head.
 */
export function revealSetting(h: SettingHit, tries = 12): void {
  const sec = document.querySelector<HTMLElement>(`.setx__sec[data-sec="${h.section}"]`);
  const want = h.rowLabel.trim().toLowerCase();
  let row: HTMLElement | null = null;
  // What to scroll to: the row, or an opened alert type page's head (the
  // page is taller than the drawer).
  let anchor: HTMLElement | null = null;
  if (sec) {
    // Under its sub-heading when the label repeats in the section.
    const scope = h.scope
      ? ([...sec.querySelectorAll<HTMLElement>("h5.setx__group")].find((g) => g.textContent?.trim() === h.scope)?.parentElement ?? null)
      : sec;
    if (h.alertType) {
      const head = [...sec.querySelectorAll<HTMLElement>(".atype__head")].find(
        (el) => el.querySelector(".atype__name")?.textContent?.trim().toLowerCase() === want,
      );
      row = (head?.closest(".atype") as HTMLElement | null) ?? head ?? null;
      anchor = head ?? null;
    } else if (h.id.startsWith("p:")) {
      row = [...sec.querySelectorAll<HTMLElement>(".feat__preset")].find((el) => el.querySelector("b")?.textContent?.trim().toLowerCase() === want) ?? null;
    } else if (scope) {
      const labels = [...scope.querySelectorAll<HTMLElement>(".setx__label")];
      row = labels.find((el) => el.textContent?.trim().toLowerCase() === want)?.closest(".setx__row") as HTMLElement | null;
    }
  }
  if (!row && tries > 0) {
    // The section (or an alert type's page) is still rendering.
    window.setTimeout(() => revealSetting(h, tries - 1), 60);
    return;
  }
  const target = row ?? sec?.querySelector<HTMLElement>(".setx__head") ?? null;
  if (!target) return;
  (anchor ?? target).scrollIntoView({ block: anchor ? "start" : "center", behavior: "smooth" });
  target.classList.remove("is-flash");
  // Restart the animation even when the same row is picked twice.
  void target.offsetWidth;
  target.classList.add("is-flash");
  window.setTimeout(() => target.classList.remove("is-flash"), 2200);
}
