import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Lock, WifiOff } from "lucide-react";

import { GRACE_DAYS, graceRemaining, resumeSession, signIn } from "../lib/auth";

type Phase = "checking" | "locked" | "open";

function graceLabel(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left offline`;
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? "" : "s"} left offline`;
}

/**
 * Gates the app behind a username and password while the build is closed.
 * Renders nothing of the app until a session is accepted, or until a recent
 * one is still inside its offline grace window.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [offline, setOffline] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void resumeSession().then((r) => {
      if (cancelled) return;
      setOffline(r.offline);
      setPhase(r.ok ? "open" : "locked");
      if (!r.ok && r.username) setUsername(r.username);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase === "locked") userRef.current?.focus();
  }, [phase]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await signIn(username, password);
    if (res.ok) {
      setPassword("");
      setOffline(false);
      setPhase("open");
    } else {
      // Falling back to grace here matters: if the server is unreachable the
      // password may well be right, and a dev who signed in last week should
      // not be locked out by an idle project or a dropped connection.
      if (res.reason === "offline" && graceRemaining() > 0) {
        setOffline(true);
        setPhase("open");
      } else {
        setError(res.message);
      }
    }
    setBusy(false);
  }

  if (phase === "checking") {
    return (
      <div className="gate gate--quiet">
        <div className="gate__mark">
          WEATHER<span>TS</span>
        </div>
        <Loader2 size={16} className="gate__spin" />
      </div>
    );
  }

  if (phase === "open") {
    return (
      <>
        {offline && (
          <div className="gate__offline" role="status">
            <WifiOff size={12} />
            <span>Offline session · {graceLabel(graceRemaining())}</span>
          </div>
        )}
        {children}
      </>
    );
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__mark">
          WEATHER<span>TS</span>
        </div>
        <div className="gate__kicker">
          <Lock size={11} /> Closed development build
        </div>

        <label className="gate__field">
          <span>Username</span>
          <input
            ref={userRef}
            type="text"
            value={username}
            placeholder="yourname"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="gate__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <div className="gate__error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="gate__submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={14} className="gate__spin" /> Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>

        <p className="gate__note">
          Accounts are issued by the team — there is no sign-up. A successful sign-in keeps the app
          open offline for {GRACE_DAYS} days.
        </p>
      </form>
    </div>
  );
}
