import { create } from "zustand";

import {
  fetchBrazilStations,
  fetchHydrograph,
  fetchRiverContext,
  fetchRiverGauges,
  type Hydrograph,
  type RiverContext,
  type RiverGauge,
  type RiverGauges,
  type RiverNet,
} from "../lib/rivers";
import { describe } from "../lib/patience";

/**
 * River gauges: the whole map's list (NWS for the US; SGB's alert stations
 * and ANA's telemetry for Brazil), which ones are drawn, and the gauge whose
 * hydrograph is open.
 */

/** "levels": gauges with flood levels set; "flooding": at action/atenção or
 *  above, now or in the forecast; "all": every gauge, out of service ones
 *  included. ANA's stations, which have no levels, follow their own switch. */
export type RiverFilter = "levels" | "flooding" | "all";

/** The NWS refreshes stages every 15 min to an hour; the map follows. */
const POLL_MS = 10 * 60_000;

let pollTimer: number | null = null;
let listCtrl: AbortController | null = null;
let brCtrl: AbortController | null = null;
let hydroCtrl: AbortController | null = null;
let ctxCtrl: AbortController | null = null;

interface RiverState {
  data: RiverGauges | null;
  busy: boolean;
  error: string | null;
  brazil: RiverGauges | null;
  brBusy: boolean;
  brError: string | null;
  /** Every gauge of both lists, the index the map's features point into. */
  all: RiverGauge[];
  filter: RiverFilter;
  networks: Record<RiverNet, boolean>;
  /** The National Water Model raster on the map (NWM_PRODUCTS id), or none. */
  nwm: string | null;
  /** The gauge whose hydrograph is open. */
  selected: string | null;
  hydro: Hydrograph | null;
  hydroBusy: boolean;
  hydroError: string | null;
  /** Around the open gauge: the river's chain, the normal flow, the rain. */
  context: RiverContext | null;

  setFilter: (f: RiverFilter) => void;
  setNetwork: (net: RiverNet, on: boolean) => void;
  setNwm: (id: string | null) => void;
  load: () => Promise<void>;
  select: (lid: string | null) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

function merge(us: RiverGauges | null, br: RiverGauges | null): RiverGauge[] {
  return [...(us?.gauges ?? []), ...(br?.gauges ?? [])];
}

export const useRiverStore = create<RiverState>((set, get) => ({
  data: null,
  busy: false,
  error: null,
  brazil: null,
  brBusy: false,
  brError: null,
  all: [],
  filter: "levels",
  networks: { nws: true, sgb: true, ana: true },
  nwm: null,
  selected: null,
  hydro: null,
  hydroBusy: false,
  hydroError: null,
  context: null,

  setFilter: (filter) => set({ filter }),
  setNetwork: (net, on) => set((s) => ({ networks: { ...s.networks, [net]: on } })),
  setNwm: (nwm) => set({ nwm }),

  load: async () => {
    listCtrl?.abort();
    brCtrl?.abort();
    const ctrl = new AbortController();
    const bctrl = new AbortController();
    listCtrl = ctrl;
    brCtrl = bctrl;
    set({ busy: true, brBusy: true });
    // The two lists come and fail apart: Brazil's sources being down must not
    // take the US map with them, nor the other way round.
    const us = fetchRiverGauges(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) set({ data, busy: false, error: null, all: merge(data, get().brazil) });
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) set({ busy: false, error: describe(err, "The NWS river gauge service") });
      });
    const br = fetchBrazilStations(bctrl.signal)
      .then((brazil) => {
        if (!bctrl.signal.aborted) set({ brazil, brBusy: false, brError: null, all: merge(get().data, brazil) });
      })
      .catch((err) => {
        if (!bctrl.signal.aborted) set({ brBusy: false, brError: describe(err, "Brazil's river stations (SGB, ANA)") });
      });
    await Promise.all([us, br]);
  },

  select: (lid) => {
    hydroCtrl?.abort();
    ctxCtrl?.abort();
    if (!lid) {
      set({ selected: null, hydro: null, hydroBusy: false, hydroError: null, context: null });
      return;
    }
    const ctrl = new AbortController();
    hydroCtrl = ctrl;
    set({ selected: lid, hydroBusy: true, hydroError: null, hydro: get().hydro?.lid === lid ? get().hydro : null });
    fetchHydrograph(lid, ctrl.signal)
      .then((hydro) => {
        if (!ctrl.signal.aborted) set({ hydro, hydroBusy: false });
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) set({ hydroBusy: false, hydroError: describe(err, "The river gauge service") });
      });
    // The context on its own: the chain walks NWPS one gauge at a time, and
    // the screen must not wait for it.
    const cctrl = new AbortController();
    ctxCtrl = cctrl;
    if (get().context?.lid !== lid) set({ context: null });
    fetchRiverContext(lid, cctrl.signal)
      .then((context) => {
        if (!cctrl.signal.aborted) set({ context });
      })
      .catch(() => {
        /* the screen goes without it */
      });
  },

  startPolling: () => {
    if (pollTimer != null) return;
    pollTimer = window.setInterval(() => void get().load(), POLL_MS);
  },
  stopPolling: () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
  },
}));

/** Whether the map draws a gauge, under the filter and the network switches. */
export function gaugeShown(g: RiverGauge, filter: RiverFilter, networks: Record<RiverNet, boolean>): boolean {
  const net = g.net ?? "nws";
  if (!networks[net]) return false;
  const rank = (s: string | null | undefined) =>
    s === "major" ? 4 : s === "moderate" ? 3 : s === "minor" ? 2 : s === "action" ? 1 : 0;
  if (filter === "flooding") return rank(g.status) > 0 || rank(g.fstatus) > 0;
  // ANA's telemetry has no levels: its switch alone decides.
  if (net === "ana" || filter === "all") return true;
  return g.status !== "not_defined" && g.status !== "out_of_service";
}
