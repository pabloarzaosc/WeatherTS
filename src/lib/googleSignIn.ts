/**
 * Google sign-in with Google's own button (Google Identity Services).
 *
 * Supabase's OAuth redirect sends Google back to <project>.supabase.co, and
 * Google's account chooser names the domain it returns to: "continue to
 * xlwv...supabase.co", which reads like a phishing page. Google only shows an
 * app's name instead after brand verification, which needs every redirect
 * domain proven ours, and supabase.co is not; Supabase's custom domain that
 * would fix it is a paid add-on. Here the browser gets Google's ID token
 * itself -- the OAuth client's authorized JavaScript origin is weatherts.tech
 * -- and hands it to Supabase with signInWithIdToken, so nothing goes through
 * supabase.co and the chooser names weatherts.tech.
 *
 * Needs a real http(s) origin, so it is the web build's way in; the desktop
 * opens weatherts.tech's sign-in page in the browser (see DesktopLogin).
 */
import type { Session, SupabaseClient } from "@supabase/supabase-js";

/** The same OAuth client Supabase's Google provider uses (public by design). */
export const GOOGLE_CLIENT_ID = "231138881560-dqd045avlg7rjps6fspjdk0lsrak3m8t.apps.googleusercontent.com";

interface GoogleId {
  initialize(cfg: Record<string, unknown>): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

let loading: Promise<GoogleId> | null = null;

function loadGis(): Promise<GoogleId> {
  loading ??= new Promise<GoogleId>((resolve, reject) => {
    const ready = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error("Google sign-in did not load.")));
    if (window.google?.accounts?.id) return ready();
    const s = document.createElement("script");
    // In English like the rest of the app, whatever the browser speaks.
    s.src = "https://accounts.google.com/gsi/client?hl=en";
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error("Google sign-in could not be reached."));
    document.head.appendChild(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Draw Google's button into `el`. A press signs in through `client` and calls
 * `onSession`. The nonce ties the ID token to this page: Google signs its hash
 * into the token, and Supabase checks the plain one against it.
 */
export async function renderGoogleButton(
  el: HTMLElement,
  client: SupabaseClient,
  opts: { dark: boolean; width: number; onSession: (s: Session) => void; onError: (message: string) => void; onStart?: () => void },
): Promise<void> {
  const gis = await loadGis();
  const nonce = crypto.randomUUID();
  gis.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: await sha256Hex(nonce),
    ux_mode: "popup",
    use_fedcm_for_button: true,
    callback: async ({ credential }: { credential?: string }) => {
      if (!credential) return opts.onError("Google did not send a sign-in.");
      opts.onStart?.();
      const { data, error } = await client.auth.signInWithIdToken({ provider: "google", token: credential, nonce });
      if (error || !data.session) return opts.onError(error?.message ?? "Google sign-in did not finish.");
      opts.onSession(data.session);
    },
  });
  el.replaceChildren();
  gis.renderButton(el, {
    type: "standard",
    theme: opts.dark ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "left",
    locale: "en",
    width: Math.max(200, Math.min(400, Math.round(opts.width))),
  });
}
