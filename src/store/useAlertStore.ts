import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import { alertCategoryFlags, alertInForceAt, type AlertFeature } from "../lib/nwsAlerts";

export type AlertStatus = "idle" | "loading" | "ready" | "error";

/**
 * The alerts to show right now: everything, or only those in force at the
 * timeline's time. Map and panel both go through this so they can't disagree.
 */
export type AlertCategoryKey = "severe" | "tornado" | "special";

export type AlertCategoryFilters = Record<AlertCategoryKey, boolean>;

export const DEFAULT_ALERT_CATEGORY_FILTERS: AlertCategoryFilters = {
  severe: true,
  tornado: true,
  special: true,
};

/** Shares one definition with the GeoJSON the map filters on. */
export function alertMatchesCategory(feature: AlertFeature, category: AlertCategoryKey): boolean {
  return alertCategoryFlags(feature.alert)[category];
}

export function selectVisibleAlerts(s: {
  features: AlertFeature[];
  timeFilter: number | null;
  categoryFilters: AlertCategoryFilters;
}): AlertFeature[] {
  const timed = s.timeFilter === null ? s.features : s.features.filter((f) => alertInForceAt(f.alert, s.timeFilter!));
  return timed.filter((feature) => {
    if (!s.categoryFilters.tornado && alertMatchesCategory(feature, "tornado")) return false;
    if (!s.categoryFilters.special && alertMatchesCategory(feature, "special")) return false;
    if (!s.categoryFilters.severe && alertMatchesCategory(feature, "severe")) return false;
    return true;
  });
}

/**
 * Whether the docked rail is showing. Clicking a polygon opens it on that
 * alert even with the list dismissed, so this is not just `listOpen`. The app
 * shell and the top bar's toggle both read it, so they can't disagree about
 * whether the map has to give up a column.
 */
export function selectRailOpen(s: {
  active: boolean;
  listOpen: boolean;
  selectedIds: string[];
  selectedId: string | null;
}): boolean {
  return s.active && (s.listOpen || s.selectedIds.length > 0 || s.selectedId !== null);
}

interface AlertState {
  /** Whether the alerts layer is on (drives the controller's fetching). */
  active: boolean;
  features: AlertFeature[];
  selectedId: string | null;
  selectedIds: string[];
  status: AlertStatus;
  message: string | null;
  /**
   * Unix seconds the map should show alerts *as of*, or null for "now".
   * The global timeline sets this while radar drives it, so scrubbing back past
   * an alert's issue time hides it. An open sounding owns the timeline instead,
   * so it leaves this null.
   */
  timeFilter: number | null;
  /**
   * Whether the side list is expanded. Deliberately separate from `active`:
   * dismissing the panel must not touch the layer, so the polygons stay on the
   * map with the whole view free.
   */
  listOpen: boolean;
  /** visibility toggles for broad alert categories */
  categoryFilters: AlertCategoryFilters;
  setCategoryFilter: (k: AlertCategoryKey, v: boolean) => void;
  toggleCategory: (k: AlertCategoryKey) => void;

  setActive: (active: boolean) => void;
  setListOpen: (listOpen: boolean) => void;
  setFeatures: (features: AlertFeature[]) => void;
  setStatus: (status: AlertStatus, message?: string | null) => void;
  select: (selectedId: string | null) => void;
  selectMany: (selectedIds: string[]) => void;
  setTimeFilter: (t: number | null) => void;
}

export const useAlertStore = create<AlertState>()(
  subscribeWithSelector((set) => ({
    active: false,
    features: [],
    selectedId: null,
    selectedIds: [],
    status: "idle",
    message: null,
    timeFilter: null,
    listOpen: true,
    categoryFilters: DEFAULT_ALERT_CATEGORY_FILTERS,

    setActive: (active) => set({ active }),
    setListOpen: (listOpen) => set({ listOpen }),
    setFeatures: (features) => set({ features }),
    setStatus: (status, message = null) => set({ status, message }),
    select: (selectedId) => set({ selectedId, selectedIds: selectedId ? [selectedId] : [] }),
    selectMany: (selectedIds) =>
      set({ selectedIds, selectedId: selectedIds.length > 0 ? selectedIds[0] : null }),
    setTimeFilter: (timeFilter) => set({ timeFilter }),
    setCategoryFilter: (k: AlertCategoryKey, v: boolean) => set((s) => ({ categoryFilters: { ...s.categoryFilters, [k]: v } })),
    toggleCategory: (k: AlertCategoryKey) => set((s) => ({ categoryFilters: { ...s.categoryFilters, [k]: !s.categoryFilters[k] } })),
  })),
);
