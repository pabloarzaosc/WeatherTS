import { useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../../lib/auth";
import { GoogleButton } from "./GoogleButton";

/**
 * weatherts.tech/app/?desktop-login=1: where the Windows app signs in with
 * Google. The app opens this page in the browser; Google's button signs in
 * here (so Google's chooser names weatherts.tech, see lib/googleSignIn.ts);
 * the session goes back to the app through the weatherts:// deep link, which
 * the app already completes (completeOAuth reads tokens from the fragment).
 *
 * The client here keeps the session in memory and never refreshes it, because
 * the session is the app's. Were this page to keep it and refresh it later,
 * Supabase would see one refresh token used twice and end the session in the
 * app as well.
 */
const handoff = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "weatherts.desktop-login" },
});

export const isDesktopLogin = () => new URLSearchParams(window.location.search).has("desktop-login");

export function DesktopLogin() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const handOver = (s: Session) => {
    const p = new URLSearchParams({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: String(s.expires_in),
      token_type: s.token_type,
    });
    const url = `weatherts://auth-callback#${p}`;
    setLink(url);
    setBusy(false);
    window.location.href = url;
  };

  return (
    <div className="gate desktop-login">
      <div className="gate__card auth desktop-login__card">
        <img className="desktop-login__logo" src="./logo.png" alt="WeatherTS" />
        <h1>Sign in to WeatherTS for Windows</h1>
        {!link ? (
          <>
            <p>Choose your Google account. WeatherTS on your computer signs in as soon as you do.</p>
            {busy ? (
              <p className="desktop-login__busy">
                <Loader2 size={14} className="gate__spin" /> Signing in…
              </p>
            ) : (
              <GoogleButton
                client={handoff}
                onStart={() => {
                  setError(null);
                  setBusy(true);
                }}
                onSession={handOver}
                onError={(m) => {
                  setBusy(false);
                  setError(m);
                }}
              />
            )}
            {error && (
              <div className="gate__error" role="alert">
                {error}
              </div>
            )}
          </>
        ) : (
          <>
            <p>Signed in. WeatherTS should come to the front by itself; if it does not, open it with the button below.</p>
            <a className="auth__provider desktop-login__open" href={link}>
              Open WeatherTS
            </a>
            <p className="desktop-login__note">You can close this tab.</p>
          </>
        )}
      </div>
    </div>
  );
}
