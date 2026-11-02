import { create } from "zustand";

import { BACKEND_BASE } from "../lib/apiConfig";

/**
 * Whether the app can reach its data: the "Offline" / "Weak connection" badge
 * in the status bar and on each pane.
 *
 * Nothing polls just for this. Every fetch goes through a thin wrapper that
 * watches outcomes: a backend request that cannot connect, a 502 whose reason
 * is a network error upstream (the backend reaches NOAA, AWS, NWS for the
 * app), requests timing out. Any of those asks the backend's /api/net/probe
 * (one small HEAD to the Level III bucket) and the answer sets the state:
 *
 *   offline  the backend does not answer, or it cannot reach the internet,
 *            or the browser says there is no network;
 *   weak     the probe is slow (> 2.5 s) or requests keep timing out
 *            (3 in 2 min);
 *   online   otherwise.
 *
 * While offline it asks again every 5 s (weak: every 15 s). Coming back from
 * offline calls the reconnect listeners: the radar fetches the scans it
 * missed and retries the frames that failed (backgroundMode.ts wires them).
 */

export type ConnStatus = "online" | "weak" | "offline";

interface ConnectionState {
  status: ConnStatus;
  /** Why, in a few words: "No network", "Backend not answering", ... */
  reason: string;
  /** When the status last changed (ms). */
  since: number;
  /** The last probe's round trip through the backend to AWS, ms. */
  probeMs: number | null;
}

export const useConnectionStore = create<ConnectionState>(() => ({
  status: "online",
  reason: "",
  since: Date.now(),
  probeMs: null,
}));

/** True while offline: pollers skip their round instead of piling up failures. */
export function connectionDown(): boolean {
  return useConnectionStore.getState().status === "offline";
}

const reconnectSubs = new Set<() => void>();
/** Called when the connection comes back after being offline. */
export function onReconnect(cb: () => void): () => void {
  reconnectSubs.add(cb);
  return () => reconnectSubs.delete(cb);
}

function setStatus(status: ConnStatus, reason = ""): void {
  const prev = useConnectionStore.getState().status;
  if (prev === status && useConnectionStore.getState().reason === reason) return;
  useConnectionStore.setState({ status, reason, since: prev === status ? useConnectionStore.getState().since : Date.now() });
  if (prev === "offline" && status !== "offline") {
    for (const cb of [...reconnectSubs]) {
      try {
        cb();
      } catch {
        /* one listener's failure must not stop the others */
      }
    }
  }
  scheduleRecheck();
}

// -- what the requests say --------------------------------------------------

/** A 502 from the backend whose reason is the network, not the data. */
const NET_RE =
  /max retries|failed to establish|name ?resolution|getaddrinfo|connectionerror|connection (aborted|refused|reset)|network is unreachable|no route to host|remotedisconnected|sslerror|proxyerror/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;

const WINDOW_NET_MS = 60_000;
const WINDOW_TIMEOUT_MS = 120_000;
let netFails: number[] = [];
let timeouts: number[] = [];
let externalFails: number[] = [];

function recent(list: number[], ms: number): number[] {
  const cut = Date.now() - ms;
  return list.filter((t) => t >= cut);
}

function noteTimeout(): void {
  timeouts = recent(timeouts, WINDOW_TIMEOUT_MS);
  timeouts.push(Date.now());
  if (timeouts.length >= 3) void check();
}

function noteNetFail(): void {
  netFails = recent(netFails, WINDOW_NET_MS);
  netFails.push(Date.now());
  if (netFails.length >= 2) void check();
}

let backendBase = "";
function isBackend(url: string): boolean {
  try {
    if (!backendBase) backendBase = new URL(BACKEND_BASE, location.href).href.replace(/\/+$/, "");
    const abs = new URL(url, location.href).href;
    return abs === backendBase || abs.startsWith(`${backendBase}/`);
  } catch {
    return false;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function observeResponse(r: Response, ms: number): void {
  if (r.ok) {
    // The backend answers again: an "offline" that came from it not answering
    // is over -- confirm with a probe rather than trust one cached reply.
    const st = useConnectionStore.getState();
    if (st.status === "offline" && st.reason === BACKEND_DOWN) void check();
    return;
  }
  if (r.status === 504) {
    noteTimeout();
    return;
  }
  if (r.status !== 502 && r.status !== 503) return;
  // The reason is in the body ({"detail": ...}); read a copy, the caller reads its own.
  void r
    .clone()
    .text()
    .then((body) => {
      const text = body.slice(0, 2000);
      if (TIMEOUT_RE.test(text)) noteTimeout();
      else if (NET_RE.test(text)) noteNetFail();
    })
    .catch(() => undefined);
  if (ms > 25_000) noteTimeout();
}

// -- the probe ----------------------------------------------------------------

const BACKEND_DOWN = "The app's data server is not answering";
const NO_INTERNET = "No internet: the data sources cannot be reached";
const NO_NETWORK = "No network connection";
const SLOW_MS = 2500;
const PROBE_TIMEOUT_MS = 12_000;

let realFetch: typeof fetch | null = null;
let checking: Promise<void> | null = null;
let lastCheck = 0;
let recheckTimer: number | null = null;

function scheduleRecheck(): void {
  if (recheckTimer !== null) window.clearTimeout(recheckTimer);
  recheckTimer = null;
  const st = useConnectionStore.getState().status;
  if (st === "online") return;
  recheckTimer = window.setTimeout(() => {
    recheckTimer = null;
    void check(true);
  }, st === "offline" ? 5_000 : 15_000);
}

/** Ask the backend whether it reaches the internet, and how fast. */
export function check(force = false): Promise<void> {
  if (checking) return checking;
  if (!force && Date.now() - lastCheck < 2_500) return Promise.resolve();
  const f = realFetch ?? window.fetch.bind(window);
  checking = (async () => {
    lastCheck = Date.now();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus("offline", NO_NETWORK);
      return;
    }
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await f(`${BACKEND_BASE}/api/net/probe`, { signal: ctl.signal, cache: "no-store" });
      if (r.status === 404) {
        // A backend without the probe still answered.
        setStatus("online");
        return;
      }
      if (!r.ok) throw new Error(`probe ${r.status}`);
      const j = (await r.json()) as { ok: boolean; ms: number };
      useConnectionStore.setState({ probeMs: j.ms });
      if (!j.ok) setStatus("offline", NO_INTERNET);
      else if (j.ms > SLOW_MS) setStatus("weak", `Slow connection: ${(j.ms / 1000).toFixed(1)} s to reach the data`);
      else if (recent(timeouts, WINDOW_TIMEOUT_MS).length >= 3) setStatus("weak", "Requests keep timing out");
      else setStatus("online");
    } catch {
      if (ctl.signal.aborted) setStatus("weak", "The data server is answering slowly");
      else setStatus("offline", BACKEND_DOWN);
    } finally {
      window.clearTimeout(timer);
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}

let installed = false;

/** Wrap fetch to watch outcomes, and follow the browser's online/offline events. */
export function installConnection(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  realFetch = orig;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const backend = isBackend(url);
    const t0 = performance.now();
    try {
      const r = await orig(input, init);
      if (backend) observeResponse(r, performance.now() - t0);
      return r;
    } catch (err) {
      if (!isAbort(err)) {
        if (backend) {
          // Cannot connect to the backend at all: ask now.
          void check(true);
        } else {
          // The browser fetches a few sources itself (NWS, SWPC...). A CORS
          // refusal fails the same way, so only a run of them counts.
          externalFails = recent(externalFails, WINDOW_NET_MS);
          externalFails.push(Date.now());
          if (externalFails.length >= 3) void check();
        }
      }
      throw err;
    }
  };
  window.addEventListener("offline", () => setStatus("offline", NO_NETWORK));
  window.addEventListener("online", () => void check(true));
  if (navigator.onLine === false) setStatus("offline", NO_NETWORK);

  if (import.meta.env.DEV || import.meta.env.VITE_PROBE) {
    (window as unknown as { __conn?: unknown }).__conn = { store: useConnectionStore, check };
  }
}
