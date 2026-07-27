import { createClient } from "@supabase/supabase-js";

/**
 * Sign-in for the closed development build.
 *
 * What is in this file is deliberately public. The project URL and the
 * publishable key are designed to ship in clients -- they identify the project,
 * they do not grant anything. Every password lives hashed in Supabase Auth and
 * is never in the repo, the installer, or this app's memory beyond the moment
 * it is typed. Row Level Security is what actually guards the data; the key
 * only gets you as far as the login form.
 *
 * Scope note: this gates the interface, not the data. The app carries its own
 * backend and works offline, so someone determined can unpack the installer and
 * strip the gate. It keeps out people who merely have the installer, which is
 * the stated goal while the app is in development.
 */

const SUPABASE_URL = "https://xlwvpzhxpkmuxjtiagwq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_AhX1NQFvuufEV4_3YLNQXQ_uE73b5H2";

/**
 * Supabase Auth is built around email addresses; the devs sign in with a plain
 * username. `.invalid` is reserved by RFC 2606 and can never be a real domain,
 * so these addresses cannot collide with a mailbox or accidentally receive mail.
 */
const USER_DOMAIN = "users.weatherts.invalid";

export const usernameToEmail = (username: string) =>
  `${username.trim().toLowerCase()}@${USER_DOMAIN}`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Nothing signs in through a redirect, and parsing the URL for tokens would
    // only add a way for a crafted link to influence the session.
    detectSessionInUrl: false,
    storageKey: "weatherts.auth",
  },
});

/** How long a successful sign-in keeps the app open without reaching the server. */
export const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
const K_GRACE = "weatherts.auth.lastVerified";
const K_WHO = "weatherts.auth.username";

function readNumber(key: string): number | null {
  try {
    const v = window.localStorage.getItem(key);
    return v ? Number(v) || null : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a browser with storage blocked simply loses the grace period */
  }
}

function drop(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const cachedUsername = () => {
  try {
    return window.localStorage.getItem(K_WHO);
  } catch {
    return null;
  }
};

/** Milliseconds of grace left, or 0 once it has run out. */
export function graceRemaining(): number {
  const at = readNumber(K_GRACE);
  if (!at) return 0;
  return Math.max(0, at + GRACE_MS - Date.now());
}

export type AuthOutcome =
  | { ok: true; username: string }
  | { ok: false; reason: "credentials" | "revoked" | "offline"; message: string };

/**
 * Verifies a username and password against Supabase, then confirms the account
 * is still allowed in. A disabled profile is signed straight back out so a
 * revoked dev cannot keep a live session.
 */
export async function signIn(username: string, password: string): Promise<AuthOutcome> {
  const clean = username.trim().toLowerCase();
  if (!clean || !password) {
    return { ok: false, reason: "credentials", message: "Enter a username and password." };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(clean),
    password,
  });

  if (error) {
    // Anything that is not a rejected credential -- DNS failure, a paused
    // project, no network -- is reported as offline so the caller can fall back
    // to the grace period instead of accusing the user of a wrong password.
    const status = (error as { status?: number }).status;
    if (status === 400 || status === 401) {
      return { ok: false, reason: "credentials", message: "Wrong username or password." };
    }
    return {
      ok: false,
      reason: "offline",
      message: "Could not reach the sign-in server.",
    };
  }

  const uid = data.session?.user.id;
  if (!uid) {
    return { ok: false, reason: "credentials", message: "Wrong username or password." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("username, active")
    .eq("id", uid)
    .maybeSingle();

  if (profile && profile.active === false) {
    await supabase.auth.signOut();
    return { ok: false, reason: "revoked", message: "This account no longer has access." };
  }

  const name = profile?.username ?? clean;
  write(K_GRACE, String(Date.now()));
  write(K_WHO, name);
  return { ok: true, username: name };
}

/**
 * Whether the app may open without asking again: a stored session that Supabase
 * still accepts, or one verified recently enough to be inside the grace window.
 * The grace exists because the free tier pauses an idle project, and because a
 * desktop weather tool that refuses to open offline would be worse than the
 * problem it solves.
 */
export async function resumeSession(): Promise<{ ok: boolean; username: string | null; offline: boolean }> {
  const { data } = await supabase.auth.getSession();
  const who = cachedUsername();

  if (data.session) {
    write(K_GRACE, String(Date.now()));
    return { ok: true, username: who, offline: false };
  }
  if (graceRemaining() > 0) return { ok: true, username: who, offline: true };
  return { ok: false, username: who, offline: false };
}

export async function signOut(): Promise<void> {
  drop(K_GRACE);
  await supabase.auth.signOut().catch(() => {});
}
