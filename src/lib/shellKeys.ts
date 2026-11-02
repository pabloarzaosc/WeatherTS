// App-wide keys of the shell (ux-shell), installed once from main.tsx:
//   ?        the keyboard shortcut list
//   /        search a place (brings the interface back first)
//   Ctrl+\   minimal UI on / off; leaves broadcast mode
//   Esc      closes the shortcut list
// Space and the left/right arrows (play, frames) live in MapTimeline, the
// radar letters and up/down tilts in radarKeys.ts.

import { useShellStore } from "../store/useShellStore";

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  return !!el.closest?.('[role="listbox"], [role="menu"], [role="combobox"]');
}

/** Ctrl+\ on any layout: US "\" (Backslash) and the ISO / ABNT key beside
 *  left Shift (IntlBackslash) both count. */
const isBackslash = (e: KeyboardEvent) => e.key === "\\" || e.code === "Backslash" || e.code === "IntlBackslash";

/** Put the caret in the place search. */
export function focusSearch(): void {
  const shell = useShellStore.getState();
  if (shell.mode !== "normal") shell.setMode("normal");
  // The search is display:none in the other modes: wait a frame for it.
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".mapsearch .search__input, .search__input");
    input?.focus();
    input?.select();
  });
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const shell = useShellStore.getState();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && isBackslash(e)) {
    e.preventDefault();
    if (!e.repeat) shell.toggleMinimal();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" && shell.shortcutsOpen) {
    // Captured: the list closes, nothing behind it does.
    e.preventDefault();
    e.stopPropagation();
    shell.setShortcutsOpen(false);
    return;
  }
  if (typing(e.target)) return;
  if (e.key === "?") {
    e.preventDefault();
    shell.setShortcutsOpen(!shell.shortcutsOpen);
    return;
  }
  if (e.key === "/" && !e.repeat) {
    e.preventDefault();
    shell.setShortcutsOpen(false);
    focusSearch();
  }
}

declare global {
  interface Window {
    __shellKeysOff?: () => void;
  }
}

/** Install the shell keys. Safe to call again (HMR). */
export function installShellKeys(): void {
  window.__shellKeysOff?.();
  window.addEventListener("keydown", onKey, true);
  window.__shellKeysOff = () => window.removeEventListener("keydown", onKey, true);
}
