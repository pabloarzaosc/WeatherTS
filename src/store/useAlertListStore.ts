import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { NwsAlert } from "../lib/nwsAlerts";
import { alertGroup, type AlertGroupId, type SeverityFilter } from "../lib/alertGroups";

/**
 * The alert list's view state: what is hidden on the map (whole groups, single
 * types, single alerts), the list-only filters (severity, text, in view), the
 * click-a-point card and the forecast office page.
 *
 * Group and type eyes persist (one localStorage key); hidden single alerts do
 * not -- they expire. The list keeps hidden groups and types listed (eye off),
 * the map drops them (alertsLayer adds them to its filter).
 */

const KEY = "weatherts.alertList";

interface Persisted {
  hiddenGroups: AlertGroupId[];
  hiddenTypes: string[];
  severity: SeverityFilter;
  inView: boolean;
}

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {};
  }
}

export interface AlertPoint {
  lon: number;
  lat: number;
  /** Alert ids drawn under the click, in the order the map gave them. */
  ids: string[];
}

interface AlertListState extends Persisted {
  hiddenIds: string[];
  text: string;
  point: AlertPoint | null;
  /** The office page: open, and which office (null = the list of offices). */
  officeOpen: boolean;
  officeId: string | null;

  toggleGroup: (g: AlertGroupId) => void;
  toggleType: (eventKey: string) => void;
  hideAlert: (id: string, hidden?: boolean) => void;
  showAll: () => void;
  setSeverity: (s: SeverityFilter) => void;
  setText: (t: string) => void;
  setInView: (v: boolean) => void;
  openPoint: (p: AlertPoint | null) => void;
  openOffice: (id: string | null) => void;
  closeOffice: () => void;
}

const saved = load();

export const useAlertListStore = create<AlertListState>()(
  subscribeWithSelector((set) => ({
    hiddenGroups: Array.isArray(saved.hiddenGroups) ? saved.hiddenGroups : [],
    hiddenTypes: Array.isArray(saved.hiddenTypes) ? saved.hiddenTypes : [],
    severity: saved.severity ?? "any",
    inView: saved.inView ?? false,
    hiddenIds: [],
    text: "",
    point: null,
    officeOpen: false,
    officeId: null,

    toggleGroup: (g) =>
      set((s) => ({ hiddenGroups: s.hiddenGroups.includes(g) ? s.hiddenGroups.filter((x) => x !== g) : [...s.hiddenGroups, g] })),
    toggleType: (k) =>
      set((s) => ({ hiddenTypes: s.hiddenTypes.includes(k) ? s.hiddenTypes.filter((x) => x !== k) : [...s.hiddenTypes, k] })),
    hideAlert: (id, hidden = true) =>
      set((s) => ({
        hiddenIds: hidden ? (s.hiddenIds.includes(id) ? s.hiddenIds : [...s.hiddenIds, id]) : s.hiddenIds.filter((x) => x !== id),
      })),
    showAll: () => set({ hiddenGroups: [], hiddenTypes: [], hiddenIds: [] }),
    setSeverity: (severity) => set({ severity }),
    setText: (text) => set({ text }),
    setInView: (inView) => set({ inView }),
    openPoint: (point) => set({ point }),
    openOffice: (officeId) => set({ officeOpen: true, officeId }),
    closeOffice: () => set({ officeOpen: false }),
  })),
);

useAlertListStore.subscribe(
  (s) => [s.hiddenGroups, s.hiddenTypes, s.severity, s.inView] as const,
  ([hiddenGroups, hiddenTypes, severity, inView]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ hiddenGroups, hiddenTypes, severity, inView }));
    } catch {
      /* private window / blocked storage: the eyes just do not persist */
    }
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);

export const eventKey = (event: string): string => (event || "").trim().toLowerCase();

/** Whether the list's eyes (group, type or the alert's own) keep it off the map. */
export function alertHiddenOnMap(a: NwsAlert): boolean {
  const s = useAlertListStore.getState();
  return s.hiddenIds.includes(a.id) || s.hiddenGroups.includes(alertGroup(a)) || s.hiddenTypes.includes(eventKey(a.event));
}
