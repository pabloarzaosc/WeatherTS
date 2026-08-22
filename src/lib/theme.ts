import type { ThemeMode } from "../store/useThemeStore";

/** Toggle the reduced-motion attribute; CSS disables transitions when set. */
export function applyReduceMotion(reduce: boolean): void {
  document.documentElement.dataset.reduceMotion = reduce ? "true" : "false";
}

export type ResolvedTheme = "light" | "dark";

/** Local-clock daylight window used by "auto" -- not sunrise/sunset, just a
 *  plain wall-clock split, so it needs no location permission. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 19;

/** Turn a theme preference into the concrete light/dark to render, reading
 *  the visitor's own clock (not UTC) for "auto". */
export function resolveTheme(mode: ThemeMode, now: Date = new Date()): ResolvedTheme {
  if (mode !== "auto") return mode;
  const hour = now.getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? "light" : "dark";
}

/** Stamp the resolved theme on <html>; every color in theme.css keys off this. */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}
