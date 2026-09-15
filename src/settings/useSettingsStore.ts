import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

import { ALERT_COLOR_EVENTS, alertColorKey, SETTING_DEFS, SETTINGS_SECTIONS, type SettingValue } from "./schema";
import { setEventColorResolver } from "../lib/nwsAlerts";

/**
 * The values of every setting in settings/schema.ts that has been changed.
 *
 * Only edits are stored: a setting left alone has no entry and reads as its
 * default, so a default changed in the schema reaches everyone who never
 * touched it.
 */
interface SettingsState {
  values: Record<string, SettingValue>;
  set: (key: string, value: SettingValue) => void;
  reset: (key: string) => void;
  resetSection: (sectionId: string) => void;
  resetAll: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        values: {},
        set: (key, value) => {
          const def = SETTING_DEFS[key];
          if (!def) return;
          const values = { ...get().values };
          if (value === def.default) delete values[key];
          else values[key] = value;
          set({ values });
        },
        reset: (key) => {
          if (!(key in get().values)) return;
          const values = { ...get().values };
          delete values[key];
          set({ values });
        },
        resetSection: (sectionId) => {
          const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
          if (!section) return;
          const values = { ...get().values };
          for (const item of section.items) delete values[item.key];
          set({ values });
        },
        resetAll: () => set({ values: {} }),
      }),
      {
        name: "weatherts-settings",
        version: 1,
        partialize: (s) => ({ values: s.values }),
        // A setting removed from the schema is dropped rather than carried on.
        merge: (persisted, current) => {
          const incoming = (persisted as Partial<SettingsState> | undefined)?.values ?? {};
          const values: Record<string, SettingValue> = {};
          for (const [k, v] of Object.entries(incoming)) {
            if (SETTING_DEFS[k] && typeof v === typeof SETTING_DEFS[k].default) values[k] = v;
          }
          return { ...current, values };
        },
      },
    ),
  ),
);

/** A setting's current value, outside React. */
export function getSetting<T extends SettingValue>(key: string): T {
  const v = useSettingsStore.getState().values[key];
  return (v !== undefined ? v : SETTING_DEFS[key]?.default) as T;
}

/** A setting's current value, in a component; re-renders when it changes. */
export function useSetting<T extends SettingValue>(key: string): T {
  return useSettingsStore((s) => (s.values[key] !== undefined ? s.values[key] : SETTING_DEFS[key]?.default)) as T;
}

// The alert list and the map share one colour per product: the list asks
// nwsAlerts, and nwsAlerts asks here for anything the user has recoloured.
const ALERT_KEYS = new Map(ALERT_COLOR_EVENTS.map((e) => [e.event, alertColorKey(e.event)]));
setEventColorResolver((normalizedEvent) => {
  const key = ALERT_KEYS.get(normalizedEvent);
  return key ? (useSettingsStore.getState().values[key] as string | undefined) : undefined;
});
