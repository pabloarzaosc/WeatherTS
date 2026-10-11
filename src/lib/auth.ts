import { createClient, type Session, type User } from "@supabase/supabase-js";
import { TERMS_VERSION } from "./consent";

/**
 * Accounts: sign-up, sign-in, recovery and the profile behind them.
 *
 * What is in this file is deliberately public. The project URL and the
 * publishable key are designed to ship in clients -- they identify the project,
 * they do not grant anything. Passwords live hashed in Supabase Auth and never
 * touch this repo, the installer, or the app's memory beyond the moment they
 * are typed. Row Level Security is what actually guards the data.
 */

export const SUPABASE_URL = "https://xlwvpzhxpkmuxjtiagwq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_AhX1NQFvuufEV4_3YLNQXQ_uE73b5H2";

export const isElectron = Boolean(
  (window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron,
);

/** Where a provider sends the browser back to once the user has approved.
 *
 *  The desktop build cannot be redirected to a page -- there is no URL bar and
 *  no server -- so it registers a protocol and receives the callback as a deep
 *  link, which the main process forwards to the renderer. */
export const OAUTH_REDIRECT = isElectron
  ? "weatherts://auth-callback"
  : // Back to the app, not the site's root: the web build lives at /app/.
    `${window.location.origin}${import.meta.env.BASE_URL}`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // PKCE, so the code that comes back through a redirect is worthless
    // without the verifier this client kept locally. That is what makes it
    // safe to read a session out of a URL at all, and it is the only flow a
    // desktop deep link can complete honestly.
    flowType: "pkce",
    // The desktop build hands its callback in by hand (see completeOAuth), so
    // it never wants the library racing to parse a URL it did not expect.
    detectSessionInUrl: !isElectron,
    storageKey: "weatherts.auth",
  },
});

/* ------------------------------------------------------------------ legacy */

/**
 * The closed build signed in with a bare username mapped onto a reserved
 * domain. Those accounts still exist, so a sign-in field with no "@" in it is
 * still read that way -- it cannot be a real address, so nothing is ambiguous.
 */
const LEGACY_DOMAIN = "users.weatherts.invalid";
const asEmail = (input: string) => {
  const v = input.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${LEGACY_DOMAIN}`;
};
/** True for the placeholder addresses the closed build issued. */
export const isLegacyEmail = (email: string | null | undefined) =>
  Boolean(email && email.toLowerCase().endsWith(`@${LEGACY_DOMAIN}`));

/* ------------------------------------------------------------------ roles */

/** What an account is, as far as everyone else is concerned.
 *
 *  Set by an admin from the SQL editor and pinned by a database trigger, so
 *  nothing a client sends can change its own. That is the whole reason the
 *  mark means anything: a badge a peer could award itself would be decoration.
 */
export type AccountRole = "member" | "chaser" | "developer" | "tester";

export const isRole = (v: unknown): AccountRole =>
  v === "chaser" || v === "developer" || v === "tester" ? v : "member";

/** The letter drawn on the map. Members carry none -- most accounts are
 *  members, and a mark everyone has marks nobody. */
export const ROLE_LETTER: Record<AccountRole, string> = {
  member: "",
  chaser: "C",
  developer: "D",
  tester: "T",
};

/** Far enough apart to tell at a glance on a map that is mostly greens and
 *  reds already: green for a chaser, yellow for a developer, violet for a
 *  tester -- the one hue radar reflectivity never reaches. */
export const ROLE_COLOR: Record<AccountRole, string> = {
  member: "#7dd3fc",
  chaser: "#22c55e",
  developer: "#facc15",
  tester: "#a78bfa",
};

export const ROLE_LABEL: Record<AccountRole, string> = {
  member: "Member",
  chaser: "WeatherTS chaser",
  developer: "Developer",
  tester: "Tester",
};

/* ----------------------------------------------------------------- profile */

export interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: AccountRole;
  active: boolean;
  createdAt: string;
  /** Where this account is based. Only ever leaves the owner's own row when
   *  homePublic is true -- the database view drops the coordinates otherwise,
   *  so a private pin is not merely hidden, it is not sent. */
  homeLat: number | null;
  homeLon: number | null;
  homeLabel: string | null;
  homePublic: boolean;
  /** When this account accepted the data notice, and which wording. Null on an
   *  account that has not -- the app blocks in front of the notice until it
   *  has, which is what makes the consent real rather than decorative. */
  termsAcceptedAt: string | null;
  termsVersion: string | null;
}

interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  active: boolean;
  created_at: string;
  home_lat: number | null;
  home_lon: number | null;
  home_label: string | null;
  home_public: boolean;
  terms_accepted_at: string | null;
  terms_version: string | null;
}

const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  role: isRole(r.role),
  active: r.active,
  createdAt: r.created_at,
  homeLat: r.home_lat,
  homeLon: r.home_lon,
  homeLabel: r.home_label,
  homePublic: r.home_public,
  termsAcceptedAt: r.terms_accepted_at,
  termsVersion: r.terms_version,
});

const PROFILE_COLS =
  "id, username, display_name, avatar_url, role, active, created_at, home_lat, home_lon, home_label, home_public, terms_accepted_at, terms_version";

export async function fetchProfile(uid: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select(PROFILE_COLS)
    .eq("id", uid)
    .maybeSingle();
  return data ? toProfile(data as ProfileRow) : null;
}

export const USERNAME_RULE = /^[a-z0-9._-]{3,32}$/;

/** Free to take? A handle is public, so this is a plain lookup. */
export async function usernameAvailable(username: string, selfId?: string): Promise<boolean> {
  const v = username.trim().toLowerCase();
  if (!USERNAME_RULE.test(v)) return false;
  // Through the view, because a signed-in account can no longer read another
  // account's row directly -- and "is this taken" must still be answerable.
  const { data } = await supabase
    .from("public_profiles")
    .select("id")
    .eq("username", v)
    .maybeSingle();
  return !data || (Boolean(selfId) && (data as { id: string }).id === selfId);
}

export type ProfileEdit = {
  username?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  homeLat?: number | null;
  homeLon?: number | null;
  homeLabel?: string | null;
  homePublic?: boolean;
};

/** About 1.1 km at the equator, less as you go poleward.
 *
 *  A home pin is meant to say "this is my patch", and a chaser's own town is
 *  the useful answer. Two decimals is that answer; six would be their driveway,
 *  published to every account in the app and written down rather than expiring
 *  like a live position does. */
export const blurHome = (v: number) => Math.round(v * 100) / 100;

/**
 * Save the parts of a profile its owner is allowed to change.
 *
 * Standing -- `active`, `role`, `stream_url` -- is pinned back to
 * its previous value by a database trigger, so sending it here changes nothing
 * rather than being quietly trusted.
 */
export async function saveProfile(uid: string, edit: ProfileEdit): Promise<Profile> {
  const patch: Record<string, unknown> = {};
  if (edit.username !== undefined) {
    const v = edit.username.trim().toLowerCase();
    if (!USERNAME_RULE.test(v)) {
      throw new Error("A handle is 3-32 characters, using a-z, 0-9, dot, dash or underscore.");
    }
    patch.username = v;
  }
  if (edit.displayName !== undefined) patch.display_name = edit.displayName?.trim() || null;
  if (edit.avatarUrl !== undefined) patch.avatar_url = edit.avatarUrl?.trim() || null;
  if (edit.homeLat !== undefined) patch.home_lat = edit.homeLat;
  if (edit.homeLon !== undefined) patch.home_lon = edit.homeLon;
  if (edit.homeLabel !== undefined) patch.home_label = edit.homeLabel?.trim() || null;
  if (edit.homePublic !== undefined) patch.home_public = edit.homePublic;

  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", uid)
    .select(PROFILE_COLS)
    .single();
  if (error) {
    // 23505 is the unique index on username; everything else is reported as-is.
    if ((error as { code?: string }).code === "23505") throw new Error("That handle is taken.");
    throw new Error(error.message);
  }
  return toProfile(data as ProfileRow);
}

/* ----------------------------------------------------------- public view */

/** What any signed-in account may see about another. */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: AccountRole;
  /** A chaser's live stream, when they have one. Served only for role
   *  'chaser', so it cannot arrive on anybody else. */
  streamUrl: string | null;
  homeLat: number | null;
  homeLon: number | null;
  homeLabel: string | null;
}

interface PublicRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  stream_url: string | null;
  home_lat: number | null;
  home_lon: number | null;
  home_label: string | null;
}

const toPublic = (r: PublicRow): PublicProfile => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  role: isRole(r.role),
  streamUrl: r.stream_url,
  homeLat: r.home_lat,
  homeLon: r.home_lon,
  homeLabel: r.home_label,
});

const PUBLIC_COLS =
  "id, username, display_name, avatar_url, role, stream_url, home_lat, home_lon, home_label";

/** Look up accounts by handle -- the map's directory. */
/**
 * Record that this account accepted the data notice.
 *
 * Written against the profile rather than kept in the client, because a
 * consent that only ever existed in React state cannot answer "did they
 * agree, and to which wording" the day it matters. The version travels with
 * the timestamp so a later revision can re-ask exactly the people who have
 * not seen it.
 */
export async function acceptTerms(uid: string): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ terms_accepted_at: new Date().toISOString(), terms_version: TERMS_VERSION })
    .eq("id", uid)
    .select(PROFILE_COLS)
    .single();
  if (error) throw readable(error);
  return toProfile(data as ProfileRow);
}

/** Whether this profile still owes us an agreement -- never accepted, or
 *  accepted an older wording than the one now shipping. */
export const needsConsent = (p: Profile | null): boolean =>
  !!p && (!p.termsAcceptedAt || p.termsVersion !== TERMS_VERSION);

export async function fetchPublicProfiles(usernames: string[]): Promise<PublicProfile[]> {
  const names = [...new Set(usernames.map((n) => n.toLowerCase()).filter(Boolean))];
  if (!names.length) return [];
  const { data, error } = await supabase
    .from("public_profiles")
    .select(PUBLIC_COLS)
    .in("username", names);
  if (error || !data) return [];
  return (data as PublicRow[]).map(toPublic);
}

/** Everyone who has chosen to show where they are based. */
export async function fetchPublicHomes(): Promise<PublicProfile[]> {
  const { data, error } = await supabase
    .from("public_profiles")
    .select(PUBLIC_COLS)
    .eq("home_public", true)
    .not("home_lat", "is", null);
  if (error || !data) return [];
  return (data as PublicRow[]).map(toPublic);
}

/* ------------------------------------------------------------------ admin */

/**
 * Hand someone a role.
 *
 * The database checks the caller is a developer; this does not. A check the
 * client performs is a check the client can skip, so the button being hidden
 * from members is a courtesy and the function refusing them is the rule.
 */
export async function setAccountRole(
  target: string,
  role: AccountRole,
): Promise<{ handle: string; role: AccountRole }> {
  const { data, error } = await supabase.rpc("set_account_role", {
    target: target.trim(),
    new_role: role,
  });
  if (error) throw new Error(error.message);
  const row = (data as { handle: string; role: string }[] | null)?.[0];
  if (!row) throw new Error("No account with that handle or id.");
  return { handle: row.handle, role: isRole(row.role) };
}

/** Everyone carrying a mark, for the admin list. */
export async function fetchBadgedAccounts(): Promise<PublicProfile[]> {
  const { data, error } = await supabase
    .from("public_profiles")
    .select(PUBLIC_COLS)
    .neq("role", "member")
    .order("username");
  if (error || !data) return [];
  return (data as PublicRow[]).map(toPublic);
}

/* -------------------------------------------------------------- signing in */

export type AuthError = { message: string; needsVerification?: boolean };

/** Supabase reports most refusals as a 400 with a terse message. These are the
 *  ones worth saying differently, because the fix is different. */
function readable(error: { message: string; status?: number; code?: string }): AuthError {
  const m = error.message.toLowerCase();
  if (m.includes("email not confirmed")) {
    return { message: "Confirm your email address first — check your inbox.", needsVerification: true };
  }
  if (m.includes("invalid login credentials")) return { message: "Wrong email or password." };
  if (m.includes("user already registered")) return { message: "There is already an account with that email." };
  if (m.includes("password should be")) return { message: "That password is too short — use at least 8 characters." };
  if (m.includes("rate limit") || error.status === 429) {
    return { message: "Too many attempts. Wait a minute and try again." };
  }
  if (error.status === 0 || m.includes("failed to fetch") || m.includes("network")) {
    return { message: "Could not reach the sign-in server." };
  }
  return { message: error.message };
}

/**
 * Sign in with a password, but only into a confirmed address.
 *
 * Supabase can be told to enforce this project-wide, and it should be. This
 * check is here as well because the two answer different questions: the project
 * setting decides whether a session is issued at all, and this decides whether
 * THIS app opens for one. Without it, turning the setting off for any reason
 * would silently let unconfirmed addresses in through the front door.
 *
 * An account that signed up through Google is confirmed by definition -- Google
 * already proved the address -- so nothing here gets in its way.
 */
export async function signInWithPassword(emailOrUsername: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: asEmail(emailOrUsername),
    password,
  });
  if (error) throw readable(error);

  const user = data.session?.user;
  if (user && !user.email_confirmed_at && !user.confirmed_at) {
    // Do not leave the session lying around: it would be picked up on the next
    // reload and open the app for an address nobody has proven.
    await supabase.auth.signOut().catch(() => {});
    throw {
      message: "Confirm your email address first — check your inbox.",
      needsVerification: true,
    } as AuthError;
  }
  return data.session;
}

/**
 * Create an account.
 *
 * Whether this returns a session depends on a project setting, not on us: with
 * email confirmations on, Supabase returns a user and no session and the person
 * has to click the link first. The caller is told which happened rather than
 * having to guess from a null.
 */
export async function signUpWithPassword(
  email: string,
  password: string,
  opts: { displayName?: string; username?: string } = {},
): Promise<{ session: Session | null; needsVerification: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      emailRedirectTo: OAUTH_REDIRECT,
      data: {
        full_name: opts.displayName?.trim() || undefined,
        username: opts.username?.trim().toLowerCase() || undefined,
      },
    },
  });
  if (error) throw readable(error);
  return { session: data.session, needsVerification: !data.session };
}

export async function resendVerification(email: string) {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: OAUTH_REDIRECT },
  });
  if (error) throw readable(error);
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: OAUTH_REDIRECT,
  });
  if (error) throw readable(error);
}

/** Set a new password. Valid while a recovery link's session is live, and from
 *  the account panel for someone already signed in. */
export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw readable(error);
}

export async function updateEmail(email: string) {
  const { error } = await supabase.auth.updateUser(
    { email: email.trim().toLowerCase() },
    { emailRedirectTo: OAUTH_REDIRECT },
  );
  if (error) throw readable(error);
}

/* ----------------------------------------------------------------- oauth */

/** Only Google today. Apple needs a paid developer account to issue the
 *  Services ID and key it signs with, so the button would be a dead end. */
export type OAuthProvider = "google";

/**
 * Hand off to a provider.
 *
 * In a browser this simply navigates. On the desktop the sign-in page has to
 * open in the real browser -- providers refuse embedded webviews, and rightly
 * so, since the user cannot see the address bar to know what they are typing
 * into. The redirect comes back as a deep link, which completeOAuth finishes.
 */
/** Where the desktop signs in with Google: weatherts.tech's own page, in the
 *  browser, which hands the session back through the weatherts:// deep link.
 *  Supabase's redirect would show Google's chooser "continue to
 *  <project>.supabase.co" (see lib/googleSignIn.ts). */
export const DESKTOP_LOGIN_URL = "https://weatherts.tech/app/?desktop-login=1";

export async function signInWithProvider(provider: OAuthProvider) {
  if (isElectron && provider === "google") {
    window.open(DESKTOP_LOGIN_URL, "_blank");
    return DESKTOP_LOGIN_URL;
  }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: isElectron },
  });
  if (error) throw readable(error);
  if (isElectron && data?.url) window.open(data.url, "_blank");
  return data?.url ?? null;
}

/**
 * Finish a deep-linked sign-in.
 *
 * The code is useless on its own -- exchanging it needs the PKCE verifier this
 * client stored when it started the flow -- so a link arriving from anywhere
 * else simply fails to exchange rather than signing anyone in.
 */
export async function completeOAuth(callbackUrl: string): Promise<Session | null> {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  const params = new URLSearchParams(url.search || url.hash.replace(/^#/, ""));
  const code = params.get("code");
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw readable(error);
    return data.session;
  }
  // Some providers still come back with the tokens inline.
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (access_token && refresh_token) {
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) throw readable(error);
    return data.session;
  }
  const desc = params.get("error_description");
  if (desc) throw { message: desc } as AuthError;
  return null;
}

/* ------------------------------------------------------------- identities */

/** Attach another way of signing in to the account that is already open. */
export async function linkProvider(provider: OAuthProvider) {
  const { data, error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: isElectron },
  });
  if (error) throw readable(error);
  if (isElectron && data?.url) window.open(data.url, "_blank");
}

/**
 * Detach one.
 *
 * Refused when it is the last one left, because an account with no way in is
 * not an account -- Supabase rejects it too, but saying so here means the
 * button can be disabled instead of failing when pressed.
 */
export async function unlinkProvider(provider: string) {
  const { data, error: listErr } = await supabase.auth.getUserIdentities();
  if (listErr) throw readable(listErr);
  const identities = data?.identities ?? [];
  if (identities.length <= 1) {
    throw { message: "This is the only way into the account — add another first." } as AuthError;
  }
  const target = identities.find((i) => i.provider === provider);
  if (!target) throw { message: "That sign-in method is not on this account." } as AuthError;
  const { error } = await supabase.auth.unlinkIdentity(target);
  if (error) throw readable(error);
}

/* ----------------------------------------------------------------- avatar */

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Upload a profile picture and point the profile at it.
 *
 * Stored under a folder named after the account id, which is what the storage
 * policy checks -- so the path is not a detail, it is the permission. The name
 * carries a timestamp because the URL is public and cached: overwriting one
 * file would leave every viewer looking at the old picture.
 */
export async function uploadAvatar(uid: string, file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > AVATAR_MAX_BYTES) throw new Error("That image is over 2 MB.");
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${uid}/${Date.now()}.${ext || "png"}`;

  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}

/** Remove the stored file, if the avatar is one of ours. A picture that came
 *  from Google lives on Google's servers and is simply forgotten instead. */
export async function deleteAvatar(url: string | null | undefined): Promise<void> {
  if (!url || !url.includes("/storage/v1/object/public/avatars/")) return;
  const path = url.split("/storage/v1/object/public/avatars/")[1];
  if (!path) return;
  await supabase.storage.from("avatars").remove([decodeURIComponent(path)]);
}

/* ---------------------------------------------------------------- leaving */

/** Sign out of this device only, or of every device the account is open on. */
export async function signOutEverywhere(): Promise<void> {
  await supabase.auth.signOut({ scope: "global" }).catch(() => {});
}

/**
 * Close the account for good.
 *
 * The row in auth.users goes, and the profile with it through the foreign
 * key's cascade. There is no undo and nothing keeps a copy.
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await supabase.rpc("delete_own_account");
  if (error) throw new Error(error.message);
  await supabase.auth.signOut().catch(() => {});
}

/* --------------------------------------------------------------- session */

/** How long a verified sign-in keeps the app open without reaching the server.
 *  A desktop weather tool that refuses to open in a dead zone would be worse
 *  than the problem it solves. */
export const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
const K_GRACE = "weatherts.auth.lastVerified";
const K_WHO = "weatherts.auth.username";

const read = (k: string) => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the grace period is simply lost */
  }
};
const drop = (k: string) => {
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

/** The handle last signed in with, for anything that needs a name before the
 *  profile has loaded (or while offline). */
export const cachedUsername = () => read(K_WHO);

export function graceRemaining(): number {
  const at = Number(read(K_GRACE)) || 0;
  return at ? Math.max(0, at + GRACE_MS - Date.now()) : 0;
}

export function markVerified(username: string | null) {
  write(K_GRACE, String(Date.now()));
  if (username) write(K_WHO, username);
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb: (session: Session | null) => void) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

/** Which ways this account can sign in, for the account panel. */
export function providersOf(user: User | null): string[] {
  const ids = (user?.identities ?? []).map((i) => i.provider);
  return [...new Set(ids)];
}

export async function signOut(): Promise<void> {
  drop(K_GRACE);
  drop(K_WHO);
  await supabase.auth.signOut().catch(() => {});
}
