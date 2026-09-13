import { useEffect, useRef, useState } from "react";
import { ConsentPanel } from "./ConsentPanel";
import { ArrowLeft, Loader2, MailCheck, Radio, Satellite, Siren, Users, Wind, WifiOff, X } from "lucide-react";

import {
  GRACE_DAYS,
  graceRemaining,
  resendVerification,
  sendPasswordReset,
  signInWithPassword,
  signInWithProvider,
  signUpWithPassword,
  updatePassword,
  type AuthError,
  type OAuthProvider,
} from "../../lib/auth";
import { useAuthStore } from "../../store/useAuthStore";

type Mode = "signin" | "signup" | "forgot" | "sent" | "verify" | "reset" | "consent";

const errText = (e: unknown): string =>
  typeof e === "object" && e && "message" in e
    ? String((e as AuthError).message)
    : e instanceof Error
      ? e.message
      : "Something went wrong.";

/** The provider marks. Drawn inline because these are brand assets, not icons
 *  from the icon set, and each has to keep its own colours to be recognised. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.8 6.6-9.5 6.6-16.2z" />
      <path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.8-6.1C1 17 0 20.4 0 24s1 7 2.6 10.2l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.3 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** What the app is, next to the box that asks who you are.
 *
 *  Written as what it does rather than what it promises: the people who install
 *  a radar workstation know what a VAD profile is, and a page of adjectives
 *  would tell them less than one line naming the products. */
function Intro() {
  const lines: { icon: React.ReactNode; head: string; body: string }[] = [
    {
      icon: <Radio size={15} />,
      head: "Every NEXRAD product",
      body: "Level II and Level III, all tilts, looped and scrubbable back through the archive.",
    },
    {
      icon: <Siren size={15} />,
      head: "Warnings as they are issued",
      body: "NWS alerts, SPC outlooks and mesoscale discussions, drawn on the scan they belong to.",
    },
    {
      icon: <Satellite size={15} />,
      head: "Soundings by SHARPpy",
      body: "Model, radiosonde and aircraft profiles, rendered by the tool forecasters actually use.",
    },
    {
      icon: <Wind size={15} />,
      head: "Storm tracks and VAD winds",
      body: "SCIT cells with their forecast swath, and the radar's own wind profile over time.",
    },
    {
      icon: <Users size={15} />,
      head: "Chasers on one map",
      body: "Share where you are and see who else is out, under the handle your account gives you.",
    },
  ];

  return (
    <aside className="gate__intro">
      <h1 className="gate__introhead">
        A storm-chasing workstation, not a weather app.
      </h1>
      <p className="gate__introlead">
        Radar, warnings and soundings in one window, off the same public feeds the National Weather
        Service publishes.
      </p>
      <ul className="gate__introlist">
        {lines.map((l) => (
          <li key={l.head}>
            <span className="gate__introicon">{l.icon}</span>
            <div>
              <b>{l.head}</b>
              <span>{l.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="gate__introfoot">
        Free while it is being built, and open without an account. An account is what puts your
        handle, your picture and your position on the map.
      </p>
    </aside>
  );
}

/**
 * Signing in, signing up, recovering a password and confirming an address.
 * Opened over the app -- from the dock, or from the prompt a guest gets on
 * reaching for something that needs an account -- and on its own only for a
 * password reset, the one thing a recovery session is for.
 *
 * One component on purpose. These screens share a card, a busy flag and an
 * error line, and every one of them is a step in the same errand -- splitting
 * them apart would mean passing that state around for no gain.
 */
export function AuthScreen({
  initialMode = "signin",
  onClose,
}: {
  /** Where it opens. "signup" starts at the data notice, as the tab does. */
  initialMode?: "signin" | "signup";
  /** Given whenever the screen is opened over the app -- every time but a
   *  password reset. Signing in is optional, so there has to be a way back. */
  onClose?: () => void;
} = {}) {
  const recovering = useAuthStore((s) => s.recovering);
  const setRecovering = useAuthStore((s) => s.setRecovering);
  const banned = useAuthStore((s) => s.banned);

  const [mode, setMode] = useState<Mode>(
    recovering ? "reset" : initialMode === "signup" ? "consent" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Agreed to on this screen, before the account exists. The profile column is
  // what the app checks from then on; this only unlocks the form in front of
  // it, and is deliberately not persisted -- closing the window and coming
  // back should show the notice again, not a remembered "yes".
  const [consented, setConsented] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (recovering) setMode("reset");
  }, [recovering]);

  useEffect(() => {
    first.current?.focus();
    setError(null);
    setNote(null);
  }, [mode]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const closer = onClose ? (
    <button type="button" className="gate__close" onClick={onClose}>
      <X size={13} /> Continue without an account
    </button>
  ) : null;

  const run = async (tag: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(tag);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = errText(e);
      setError(msg);
      if (typeof e === "object" && e && (e as AuthError).needsVerification) setMode("verify");
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "signin") {
      void run("submit", async () => {
        await signInWithPassword(email, password);
        setPassword("");
      });
    } else if (mode === "signup") {
      void run("submit", async () => {
        const { needsVerification } = await signUpWithPassword(email, password, { displayName });
        setPassword("");
        if (needsVerification) setMode("verify");
      });
    } else if (mode === "forgot") {
      void run("submit", async () => {
        await sendPasswordReset(email);
        setMode("sent");
      });
    } else if (mode === "reset") {
      void run("submit", async () => {
        await updatePassword(password);
        setPassword("");
        setRecovering(false);
      });
    }
  };

  const oauth = (provider: OAuthProvider) =>
    void run(provider, async () => {
      await signInWithProvider(provider);
      setNote("Finish signing in in your browser — this window will pick it up.");
    });

  const busyBtn = (tag: string, label: string, working: string) =>
    busy === tag ? (
      <>
        <Loader2 size={14} className="gate__spin" /> {working}
      </>
    ) : (
      label
    );

  const back = (to: Mode, label: string) => (
    <button type="button" className="auth__link auth__back" onClick={() => setMode(to)}>
      <ArrowLeft size={12} /> {label}
    </button>
  );

  // The notice takes the whole card. It is not a paragraph beside a form: it
  // is the step, and the form does not exist until it is done.
  if (mode === "consent") {
    return (
      <div className="gate">
        {closer}
        <div className="gate__split">
          <Intro />
          <div className="gate__card auth auth--consent">
            <ConsentPanel
              onAccept={() => {
                setConsented(true);
                setMode("signup");
              }}
              onCancel={() => setMode("signin")}
              cancelLabel="Cancel"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      {closer}
      <div className="gate__split">
        <Intro />
        <form className="gate__card auth" onSubmit={submit}>
        <div className="gate__mark">
          WEATHER<span>TS</span>
        </div>

        {/* --------------------------------------------------------- notices */}
        {banned && (
          <div className="gate__error" role="alert">
            This account no longer has access.
          </div>
        )}

        {/* -------------------------------------------------- email + password */}
        {(mode === "signin" || mode === "signup") && (
          <>
            <div className="auth__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signin"}
                className={`auth__tab${mode === "signin" ? " is-on" : ""}`}
                onClick={() => setMode("signin")}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signup"}
                className={`auth__tab${mode === "signup" ? " is-on" : ""}`}
                onClick={() => setMode(consented ? "signup" : "consent")}
              >
                Create account
              </button>
            </div>

            <div className="auth__providers">
              <button type="button" className="auth__provider" onClick={() => oauth("google")} disabled={!!busy}>
                {busy === "google" ? <Loader2 size={14} className="gate__spin" /> : <GoogleMark />}
                Continue with Google
              </button>
            </div>

            <div className="auth__or">
              <span>or</span>
            </div>

            {mode === "signup" && (
              <label className="gate__field">
                <span>Name</span>
                <input
                  ref={mode === "signup" ? first : undefined}
                  name="name"
                  autoComplete="name"
                  value={displayName}
                  placeholder="How you want to be shown"
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={!!busy}
                />
              </label>
            )}

            <label className="gate__field">
              <span>Email</span>
              <input
                ref={mode === "signin" ? first : undefined}
                name="email"
                autoComplete="username"
                type="text"
                inputMode="email"
                value={email}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!busy}
              />
            </label>

            <label className="gate__field">
              <span>Password</span>
              <input
                name="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                type="password"
                value={password}
                placeholder={mode === "signup" ? "At least 8 characters" : ""}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!!busy}
              />
            </label>

            {mode === "signin" && (
              <button type="button" className="auth__link auth__forgot" onClick={() => setMode("forgot")}>
                Forgot your password?
              </button>
            )}
          </>
        )}

        {/* ----------------------------------------------------------- forgot */}
        {mode === "forgot" && (
          <>
            <div className="auth__title">Reset your password</div>
            <p className="auth__lead">
              We will email you a link. Opening it brings you back here to set a new one.
            </p>
            <label className="gate__field">
              <span>Email</span>
              <input
                ref={first}
                name="email"
                autoComplete="username"
                type="text"
                inputMode="email"
                value={email}
                placeholder="you@example.com"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!busy}
              />
            </label>
          </>
        )}

        {mode === "sent" && (
          <>
            <div className="auth__icon">
              <MailCheck size={26} />
            </div>
            <div className="auth__title">Check your email</div>
            <p className="auth__lead">
              If an account exists for <b>{email}</b>, a reset link is on its way. The link opens
              this app and asks for a new password.
            </p>
          </>
        )}

        {/* ----------------------------------------------------------- verify */}
        {mode === "verify" && (
          <>
            <div className="auth__icon">
              <MailCheck size={26} />
            </div>
            <div className="auth__title">Confirm your email</div>
            <p className="auth__lead">
              We sent a confirmation link to <b>{email || "your address"}</b>. Open it and you are
              in — you can leave this window where it is.
            </p>
            <button
              type="button"
              className="gate__submit"
              disabled={!!busy || !email}
              onClick={() =>
                void run("resend", async () => {
                  await resendVerification(email);
                  setNote("Sent again.");
                })
              }
            >
              {busyBtn("resend", "Send it again", "Sending…")}
            </button>
          </>
        )}

        {/* ------------------------------------------------------------ reset */}
        {mode === "reset" && (
          <>
            <div className="auth__title">Set a new password</div>
            <p className="auth__lead">This link signed you in. Choose the password you will use next time.</p>
            <label className="gate__field">
              <span>New password</span>
              <input
                ref={first}
                name="password"
                autoComplete="new-password"
                type="password"
                value={password}
                placeholder="At least 8 characters"
                onChange={(e) => setPassword(e.target.value)}
                disabled={!!busy}
              />
            </label>
          </>
        )}

        {error && (
          <div className="gate__error" role="alert">
            {error}
          </div>
        )}
        {note && !error && (
          <div className="auth__note-live" role="status">
            {note}
          </div>
        )}

        {mode !== "verify" && mode !== "sent" && (
          <button type="submit" className="gate__submit" disabled={!!busy}>
            {busyBtn(
              "submit",
              mode === "signin"
                ? "Sign in"
                : mode === "signup"
                  ? "Create account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Save password",
              mode === "signin" ? "Signing in…" : "Working…",
            )}
          </button>
        )}

        {(mode === "forgot" || mode === "sent" || mode === "verify") && back("signin", "Back to sign in")}

        {mode === "signup" && (
          <p className="gate__note">
            Creating an account gives you a handle other chasers see when you share your position.
            You can change it any time from your account.
          </p>
        )}
        {graceRemaining() > 0 && (
          <p className="gate__note gate__note--grace">
            <WifiOff size={11} /> A signed-in session keeps the app open offline for {GRACE_DAYS} days.
          </p>
        )}
        </form>
      </div>
    </div>
  );
}
