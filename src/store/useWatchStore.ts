import { create } from "zustand";

/**
 * The watch area: a point and a radius that decides which alerts matter to this
 * user. Highlights them on the map and in the rail, and is what desktop
 * notifications fire on.
 *
 * A circle rather than a drawn shape on purpose -- it is set with one click,
 * costs one distance test per alert, and needs no drawing tool. Nothing
 * downstream assumes a circle, so a drawn area can replace `matches` later.
 */

const K_STATE = "weatherts.watch";

export interface WatchSettings {
  enabled: boolean;
  /** [lon, lat], or null until the user picks a spot. */
  center: [number, number] | null;
  radiusKm: number;
}

const DEFAULTS: WatchSettings = {
  enabled: false,
  center: null,
  radiusKm: 150,
};

function load(): WatchSettings {
  try {
    const raw = window.localStorage.getItem(K_STATE);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<WatchSettings>;
    return {
      ...DEFAULTS,
      ...p,
      // A half-written centre would break every distance test downstream.
      center:
        Array.isArray(p.center) && p.center.length === 2 && p.center.every((n) => Number.isFinite(n))
          ? [p.center[0], p.center[1]]
          : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(s: WatchSettings): void {
  try {
    window.localStorage.setItem(
      K_STATE,
      JSON.stringify({
        enabled: s.enabled,
        center: s.center,
        radiusKm: s.radiusKm,
      }),
    );
  } catch {
    /* the watch area is a convenience; never let storage break the app */
  }
}

interface WatchState extends WatchSettings {
  /** True while the map is waiting for the user to click a centre. */
  picking: boolean;
  setEnabled: (v: boolean) => void;
  setCenter: (c: [number, number] | null) => void;
  setRadiusKm: (km: number) => void;
  setPicking: (v: boolean) => void;
}

export const useWatchStore = create<WatchState>((set, get) => {
  const persist = (patch: Partial<WatchSettings>) => {
    set(patch as never);
    const s = get();
    save({
      enabled: s.enabled,
      center: s.center,
      radiusKm: s.radiusKm,
    });
  };

  return {
    ...load(),
    picking: false,
    setEnabled: (enabled) => persist({ enabled }),
    // Picking a spot is only ever done to use it, so turn the area on with it.
    setCenter: (center) => persist(center ? { center, enabled: true } : { center }),
    setRadiusKm: (radiusKm) => persist({ radiusKm }),
    setPicking: (picking) => set({ picking }),
  };
});
