import { useEffect, useState, type ReactNode } from "react";
import { Loader2, WifiOff } from "lucide-react";

import { acceptTerms, completeOAuth, graceRemaining, isElectron, needsConsent, signOut } from "../lib/auth";
import { useAccountGate } from "../store/useAccountGate";
import { useAuthStore } from "../store/useAuthStore";
import { AccountGuard, AccountRequired, GuestWelcome } from "./auth/AccountPrompts";
import { AuthScreen } from "./auth/AuthScreen";
import { ConsentPanel } from "./auth/ConsentPanel";

function graceLabel(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left offline`;
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? "" : "s"} left offline`;
}

/**
 * The boundary between "who are you" and the app.
 *
 * The app opens without an account. Radar, warnings, outlooks and soundings are
 * public feeds; an account is for the part tied to a person -- the handle other
 * chasers see, the position you share, where you are on the map -- and each of
 * those asks for one when someone reaches for it (see store/useAccountGate).
 * Signing in is a screen opened over the app, from the dock or from one of those
 * prompts, and it closes itself the moment it succeeds.
 *
 * Two things still stand in front of the app: a password-reset link, whose
 * session exists only to set a new password, and an account that has not yet
 * agreed to the data notice.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const recovering = useAuthStore((s) => s.recovering);
  const banned = useAuthStore((s) => s.banned);
  const profile = useAuthStore((s) => s.profile);
  const refreshProfile = useAuthStore((s) => s.refreshProfile);
  const init = useAuthStore((s) => s.init);
  const authMode = useAccountGate((s) => s.auth);
  const closeAuth = useAccountGate((s) => s.closeAuth);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  useEffect(() => init(), [init]);

  // The desktop build gets its OAuth answer as a deep link on the protocol it
  // registered, forwarded here by the main process. A browser completes the
  // same flow on its own, from the URL it was redirected to. A link that fails
  // reopens the sign-in screen, so trying again is right there with the error.
  useEffect(() => {
    if (!isElectron) return;
    const api = (window as unknown as {
      electronAPI?: { onAuthCallback?: (cb: (url: string) => void) => void };
    }).electronAPI;
    api?.onAuthCallback?.((url) => {
      void completeOAuth(url).catch((e: { message?: string }) => {
        setLinkError(e?.message ?? "That sign-in link could not be completed.");
        useAccountGate.getState().openAuth("signin");
      });
    });
  }, []);

  // Signed in: nothing that was asking them to sign in is true any more.
  useEffect(() => {
    if (status === "signedIn" || status === "offline") {
      useAccountGate.setState({ auth: null, need: null });
      setLinkError(null);
    }
  }, [status]);

  // A banned account is signed straight back out, and the sign-in screen is
  // where that is explained -- so it opens on its own instead of leaving the
  // person in an app that has quietly forgotten them.
  useEffect(() => {
    if (banned) useAccountGate.getState().openAuth("signin");
  }, [banned]);

  if (status === "checking") {
    return (
      <div className="gate gate--quiet">
        <div className="gate__mark">
          WEATHER<span>TS</span>
        </div>
        <Loader2 size={16} className="gate__spin" />
      </div>
    );
  }

  // A recovery link signs you in, but the only thing that session is for is
  // choosing a new password -- so the app waits behind that form, and the form
  // has no way to close.
  if (recovering) {
    return (
      <>
        {linkError && (
          <div className="gate__linkerr" role="alert">
            {linkError}
          </div>
        )}
        <AuthScreen />
      </>
    );
  }

  // The backstop, and the reason the sign-up step is not the only gate.
  //
  // An account can come into existence without ever passing that step: the
  // Google button on the SIGN IN tab creates one when no account matches, and
  // every account made before this notice existed never saw it. Checking the
  // profile column here catches all of them, because it asks about the account
  // rather than about the screen someone happened to arrive through.
  if (profile && needsConsent(profile)) {
    return (
      <div className="gate">
        <div className="gate__card auth auth--consent auth--consent-solo">
          {consentError && (
            <div className="gate__error" role="alert">
              {consentError}
            </div>
          )}
          <ConsentPanel
            busy={savingConsent}
            acceptLabel="Agree and continue"
            cancelLabel="Sign out"
            onCancel={() => void signOut()}
            onAccept={() => {
              setConsentError(null);
              setSavingConsent(true);
              void acceptTerms(profile.id)
                .then(() => refreshProfile())
                .catch((e: { message?: string }) =>
                  setConsentError(e?.message ?? "That could not be saved. Try again?"),
                )
                .finally(() => setSavingConsent(false));
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {status === "offline" && (
        <div className="gate__offline" role="status">
          <WifiOff size={12} />
          <span>Offline session · {graceLabel(graceRemaining())}</span>
        </div>
      )}
      {children}
      <AccountGuard />
      <GuestWelcome />
      {status === "signedOut" && <AccountRequired />}
      {status === "signedOut" && authMode && (
        <AuthScreen key={authMode} initialMode={authMode} onClose={closeAuth} />
      )}
      {linkError && authMode && (
        <div className="gate__linkerr" role="alert">
          {linkError}
        </div>
      )}
    </>
  );
}
