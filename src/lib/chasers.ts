/**
 * Live chaser positions, over the Supabase Realtime channel the app already
 * has a client for.
 *
 * Presence rather than a table, deliberately. Presence state lives only in the
 * channel while a client is connected: nothing about anybody's whereabouts is
 * written to a database, and a position disappears the moment its owner
 * disconnects. There is therefore no location history to leak, and no rows to
 * clean up. It also means this is only ever "who is out there right now",
 * which is the actual question when you are deciding where to go.
 *
 * Two independent capabilities, kept independent on purpose:
 *   * joining the channel to SEE other chasers
 *   * tracking to BROADCAST yourself
 * Watching without broadcasting is a legitimate thing to want, so seeing others
 * never implies sharing yourself. Broadcasting is opt-in and off by default.
 *
 * TRUST BOUNDARY. Everything in a presence payload is written by the sender and
 * must be treated as a claim, not a fact. The official-chaser badge therefore
 * comes from `profiles` (see loadOfficials), never from the payload -- nobody
 * can promote themselves by editing what they broadcast.
 *
 * The channel is PRIVATE (Realtime Authorization). Joining it is a SELECT on
 * realtime.messages and broadcasting is an INSERT, both restricted to
 * `authenticated` on this topic, so a session token is required and the
 * publishable key on its own no longer lets anyone watch where people are.
 *
 * What that still does NOT cover: the presence KEY is chosen by the client, so
 * a signed-in member could broadcast under an official's username and inherit
 * the badge. Authorization bounds who can try it to people who already hold an
 * issued account -- it does not make presence self-authenticating. Fixing it
 * properly means the server deciding the identity attached to a position
 * rather than the sender asserting it.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";

import { fetchPublicProfiles, supabase, type AccountRole } from "./auth";
import type { Fix } from "./geolocate";

const CHANNEL = "chasers-v1";

/** A position older than this is stale -- the device slept, or lost signal. */
export const STALE_AFTER_MS = 5 * 60_000;

/** Past this, drop the marker entirely rather than leave a grey ghost parked
 *  on the map for the rest of the session. */
export const DROP_AFTER_MS = 20 * 60_000;

/**
 * How often to re-publish an unchanged position.
 *
 * watchPosition only fires when the device MOVES. A chaser parked watching
 * structure therefore stops sending, their timestamp ages, and they grey out
 * on everyone else's map while sitting right there -- which is the exact
 * moment their position matters most. The heartbeat re-sends the last fix so
 * "not moving" stays distinct from "gone".
 */
const HEARTBEAT_MS = 45_000;

/**
 * ...but only while the underlying fix is still believable. If the GPS itself
 * died, re-stamping an old position with a fresh time would be asserting
 * someone is somewhere nobody actually knows they are, so past this the
 * heartbeat stops and they are allowed to go stale honestly.
 */
const HEARTBEAT_MAX_FIX_AGE_MS = 10 * 60_000;

export interface ChaserPresence {
  /** Presence key: the display name, which is also how it's labelled. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  heading: number | null;
  /** Miles per hour, converted here so the UI has one unit to render. */
  speedMph: number | null;
  accuracyM: number | null;
  /** Device clock, unix ms. Clocks differ between devices, so this is only
   *  ever compared against itself to age a fix out, never trusted absolutely. */
  at: number;
  /** What this account is. Decided HERE, by looking the handle up in the
   *  directory -- never read from the broadcast, which the sender writes. */
  role: AccountRole;
  /** Kept as the shorthand the UI already reads for "carries a mark". */
  official: boolean;
  /** Reserved for the live view. Comes from the roster, so only an official
   *  can ever have one. */
  streamUrl: string | null;
  /** Profile picture, also from the roster. Same reasoning as the badge: the
   *  face beside a position has to be the one that genuinely belongs to that
   *  handle, not one the sender chose to attach to itself. */
  avatarUrl: string | null;
}

interface DirEntry {
  displayName: string;
  avatarUrl: string | null;
  role: AccountRole;
  streamUrl: string | null;
}

/** username -> the row that handle really owns. Empty until it loads, and
 *  empty for signed-out clients, which simply means nobody is badged and
 *  everyone draws as a plain marker. */
let directory = new Map<string, DirEntry>();
const lookedUpAt = new Map<string, number>();
const DIRECTORY_TTL_MS = 10 * 60_000;

/**
 * Who these handles actually are, straight from the database.
 *
 * Everything a peer is *shown as* -- their name, their face, their badge --
 * is read here rather than from what they broadcast. A presence payload is
 * written by its sender, so trusting it for any of this would let anyone
 * arrive wearing someone else's picture. The most an impostor can still do is
 * broadcast under another handle entirely; see the note on presence keys in the
 * module docstring.
 */
async function loadDirectory(names: string[], force = false): Promise<boolean> {
  const now = Date.now();
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))].filter(
    (n) => force || now - (lookedUpAt.get(n) ?? 0) > DIRECTORY_TTL_MS,
  );
  if (!wanted.length) return false;

  // Through public_profiles, which is the boundary: it serves the handle, the
  // name, the face and the official flag, and nothing else about anybody.
  const rows = await fetchPublicProfiles(wanted);
  if (!rows.length && wanted.length) {
    // Could be a failed request or genuinely unknown handles. Either way, do
    // not blank what is already known -- a slightly stale face beats everyone
    // losing theirs on one bad response.
    for (const n of wanted) lookedUpAt.set(n, now);
    return false;
  }
  for (const row of rows) {
    directory.set(row.username.toLowerCase(), {
      displayName: row.displayName?.trim() || row.username,
      avatarUrl: row.avatarUrl,
      role: row.role,
      streamUrl: row.streamUrl,
    });
  }
  // Handles with no row are remembered as looked-up too, or an unknown name on
  // the channel would re-query on every presence event.
  for (const n of wanted) lookedUpAt.set(n, now);
  return true;
}

/** Drop everything known about people, so the next sync re-reads it. Called
 *  when the signed-in account changes -- a different session may see different
 *  rows, and a stale directory would show the previous user's view. */
export function forgetDirectory(): void {
  directory = new Map();
  lookedUpAt.clear();
}

/** Officials currently on the channel, for the roster UI. */
export function officialCount(list: ChaserPresence[]): number {
  return list.filter((c) => c.role === "chaser").length;
}

const MPS_TO_MPH = 2.236936;

interface Payload {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  heading?: unknown;
  speed?: unknown;
  accuracy?: unknown;
  at?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function toChaser(key: string, raw: Payload): ChaserPresence | null {
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const speed = num(raw.speed);
  const claimed = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : key;
  // The roster is keyed on the username, and the presence key IS the username
  // while sharing. Anything the payload says about being official is discarded.
  const who = directory.get(claimed.toLowerCase());
  return {
    id: key,
    name: who?.displayName ?? claimed,
    lat,
    lon,
    heading: num(raw.heading),
    speedMph: speed === null ? null : Math.round(speed * MPS_TO_MPH),
    accuracyM: num(raw.accuracy),
    at: num(raw.at) ?? Date.now(),
    role: who?.role ?? "member",
    official: (who?.role ?? "member") !== "member",
    streamUrl: who?.role === "chaser" ? who.streamUrl : null,
    avatarUrl: who?.avatarUrl ?? null,
  };
}

export type ChaserListener = (chasers: ChaserPresence[]) => void;
export type StatusListener = (status: "joining" | "live" | "error") => void;

let channel: RealtimeChannel | null = null;
let onChasers: ChaserListener = () => {};
let onStatus: StatusListener = () => {};
/** Who we are broadcasting as, or null while only watching. */
let sharingAs: string | null = null;
let lastFix: Fix | null = null;

function emit() {
  if (!channel) {
    onChasers([]);
    return;
  }
  const state = channel.presenceState<Payload>();

  // Anyone on the channel we have not looked up yet gets looked up, and the
  // list is emitted again once their name and face are known. Doing it here
  // rather than on join is what makes a chaser who arrives later show up as
  // themselves instead of as a bare handle.
  const seen = Object.keys(state);
  void loadDirectory(seen).then((learned) => {
    if (learned) emit();
  });

  const out: ChaserPresence[] = [];
  for (const [key, entries] of Object.entries(state)) {
    // Own broadcast comes back through presence too; the map already has a
    // "you are here" marker, so listing it again would be a phantom chaser.
    if (sharingAs !== null && key === sharingAs) continue;
    const newest = entries[entries.length - 1];
    if (!newest) continue;
    const c = toChaser(key, newest);
    // A position nobody has refreshed in twenty minutes is not information.
    if (c && Date.now() - c.at <= DROP_AFTER_MS) out.push(c);
  }
  // Officials first: they are the ones worth following, and on a busy day the
  // list is long enough that alphabetical order would bury them.
  out.sort((a, b) =>
    a.official === b.official ? a.name.localeCompare(b.name) : a.official ? -1 : 1,
  );
  onChasers(out);
}

/** Start watching the channel. Safe to call when already joined. */
export async function joinChasers(listeners: {
  onChasers: ChaserListener;
  onStatus?: StatusListener;
}): Promise<void> {
  onChasers = listeners.onChasers;
  onStatus = listeners.onStatus ?? (() => {});
  if (channel) {
    emit();
    return;
  }
  // Two callers can ask in the same moment -- signing in, and the Chasers layer
  // that sign-in switches back on -- and everything below awaits before
  // `channel` is set. Without this both would build a channel on the topic and
  // the second one's .on() would throw. The later caller waits for the first.
  if (joining) return joining;
  joining = connect().finally(() => {
    joining = null;
  });
  return joining;
}

let joining: Promise<void> | null = null;

async function connect(): Promise<void> {
  onStatus("joining");

  // supabase.channel() hands back the EXISTING channel when one is already
  // registered under this topic, and .on() throws once that channel has been
  // subscribed. A hot reload, or a leave whose teardown hadn't finished, is
  // enough to land here holding a live one -- so clear the topic first rather
  // than assume our own `channel` variable is the whole truth.
  for (const existing of supabase.getChannels()) {
    if (existing.topic === `realtime:${CHANNEL}`) {
      await supabase.removeChannel(existing);
    }
  }

  // Hand Realtime the current session before joining. The channel is private,
  // so the server checks this token against the policies on realtime.messages;
  // without it the join is refused, which is the point -- the publishable key
  // alone is no longer enough to watch where people are.
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) supabase.realtime.setAuth(token);

  channel = supabase.channel(CHANNEL, {
    config: {
      private: true,
      presence: { key: sharingAs ?? crypto.randomUUID() },
    },
  });
  channel
    .on("presence", { event: "sync" }, emit)
    .on("presence", { event: "join" }, emit)
    .on("presence", { event: "leave" }, emit)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        onStatus("live");
        // A share switched on before the channel existed still has to start.
        if (sharingAs && lastFix) void pushFix(lastFix);
        emit();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        onStatus("error");
      }
    });
}

export async function leaveChasers(): Promise<void> {
  stopHeartbeat();
  const ch = channel;
  channel = null;
  sharingAs = null;
  lastFix = null;
  onChasers([]);
  if (ch) await supabase.removeChannel(ch);
}

/**
 * Begin broadcasting as `name`.
 *
 * The presence key is the name, so a second device signed in as the same person
 * replaces the first rather than appearing twice. Rejoins the channel because
 * the key is fixed when the channel is created.
 */
export async function startSharing(name: string): Promise<void> {
  const wasJoined = channel !== null;
  sharingAs = name;
  if (wasJoined) {
    const ch = channel;
    channel = null;
    if (ch) await supabase.removeChannel(ch);
    await joinChasers({ onChasers, onStatus });
  }
}

/** Stop broadcasting but keep watching. */
export async function stopSharing(): Promise<void> {
  if (!sharingAs) return;
  stopHeartbeat();
  sharingAs = null;
  lastFix = null;
  const ch = channel;
  if (ch) {
    await ch.untrack();
    // Rejoin under an anonymous key so the name is no longer the presence key.
    channel = null;
    await supabase.removeChannel(ch);
    await joinChasers({ onChasers, onStatus });
  }
}

/** Publish a new fix. No-op unless sharing is on and the channel is up. */
export async function pushFix(fix: Fix): Promise<void> {
  lastFix = fix;
  await publish(fix.at);
  startHeartbeat();
}

async function publish(at: number): Promise<void> {
  const fix = lastFix;
  if (!channel || !sharingAs || !fix) return;
  await channel.track({
    name: sharingAs,
    // Five decimals is about a metre. Anything finer is noise the GPS did not
    // actually resolve, and it would only make the broadcast more precise
    // about someone's whereabouts than the reading behind it justifies.
    lat: Number(fix.lat.toFixed(5)),
    lon: Number(fix.lon.toFixed(5)),
    heading: fix.heading,
    speed: fix.speed,
    accuracy: fix.accuracy,
    at,
  });
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!sharingAs || !lastFix) {
      stopHeartbeat();
      return;
    }
    // Still parked at a fix we can vouch for: say so with a current timestamp.
    if (Date.now() - lastFix.at <= HEARTBEAT_MAX_FIX_AGE_MS) {
      void publish(Date.now());
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** True when a fix is too old to be worth drawing. */
export function isStale(c: ChaserPresence, now = Date.now()): boolean {
  return now - c.at > STALE_AFTER_MS;
}
