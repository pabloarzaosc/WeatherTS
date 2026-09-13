import { useEffect, useRef, useState } from "react";
import { currentFix } from "../../lib/geolocate";
import { createPortal } from "react-dom";
import {
  AtSign,
  Check,
  Copy,
  Eye,
  Home,
  ImagePlus,
  MapPin,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react";

import {
  blurHome,
  ROLE_COLOR,
  ROLE_LABEL,
  deleteAccount,
  deleteAvatar,
  isLegacyEmail,
  linkProvider,
  providersOf,
  sendPasswordReset,
  signOutEverywhere,
  unlinkProvider,
  updateEmail,
  updatePassword,
  uploadAvatar,
  usernameAvailable,
  type AuthError,
} from "../../lib/auth";
import { useAuthStore } from "../../store/useAuthStore";

const errText = (e: unknown): string =>
  typeof e === "object" && e && "message" in e
    ? String((e as AuthError).message)
    : e instanceof Error
      ? e.message
      : "Something went wrong.";

const PROVIDER_LABEL: Record<string, string> = {
  email: "Email and password",
  google: "Google",
};

const fmtDate = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "—";

/**
 * The account, and everything its owner can change about it.
 *
 * Standing -- whether the account is active, whether it is an official chaser
 * -- is deliberately absent: those are set by an admin and pinned by a database
 * trigger, so offering them here would be offering a control that does nothing.
 */
export function AccountPanel({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const signOut = useAuthStore((s) => s.signOut);

  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [email, setEmail] = useState(isLegacyEmail(user?.email) ? "" : (user?.email ?? ""));
  const [password, setPassword] = useState("");
  const [homeLabel, setHomeLabel] = useState(profile?.homeLabel ?? "");
  const [confirmText, setConfirmText] = useState("");
  const [danger, setDanger] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [handleFree, setHandleFree] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
    setUsername(profile?.username ?? "");
    setHomeLabel(profile?.homeLabel ?? "");
  }, [profile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Check the handle as it is typed, but only once it differs from the one
  // already owned -- otherwise the panel tells you your own handle is taken.
  useEffect(() => {
    const v = username.trim().toLowerCase();
    if (!v || v === profile?.username) {
      setHandleFree(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void usernameAvailable(v, user?.id).then((free) => {
        if (!cancelled) setHandleFree(free);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [username, profile?.username, user?.id]);

  const run = (tag: string, fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(tag);
    setError(null);
    setDone(null);
    void fn()
      .then((msg) => setDone(msg))
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const providers = providersOf(user);
  const hasPassword = providers.includes("email");
  const hasGoogle = providers.includes("google");
  const dirty =
    displayName.trim() !== (profile?.displayName ?? "") ||
    username.trim().toLowerCase() !== (profile?.username ?? "");

  const pickAvatar = (file: File | undefined) => {
    if (!file || !user) return;
    run("avatar", async () => {
      const previous = profile?.avatarUrl;
      const url = await uploadAvatar(user.id, file);
      await updateProfile({ avatarUrl: url });
      // Only once the new one is safely saved, so a failed write never leaves
      // the account with no picture at all.
      await deleteAvatar(previous);
      return "Picture updated.";
    });
  };

  return createPortal(
    // Rendered into <body> rather than where it is written.
    //
    // The button that opens this lives in the tool dock, and the dock has a
    // z-index, which makes it a stacking context: a dialog left inside it can
    // cover the window yet never rise above anything stacked higher than the
    // dock itself. (Its old home, the top bar, was worse -- a transform left
    // over from its entrance animation turned "cover the window" into "cover
    // the 44px strip".) A portal takes it out of that subtree entirely.
    <div className="acct__backdrop" onClick={onClose}>
      <div className="acct" role="dialog" aria-label="Account" onClick={(e) => e.stopPropagation()}>
        <header className="acct__head">
          <div className="acct__who">
            {profile?.avatarUrl ? (
              <img className="acct__avatar" src={profile.avatarUrl} alt="" />
            ) : (
              <div className="acct__avatar acct__avatar--blank">
                <UserIcon size={18} />
              </div>
            )}
            <div>
              <strong>{profile?.displayName || profile?.username || "Your account"}</strong>
              <span>@{profile?.username ?? "—"}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </header>

        <div className="acct__body">
          <div className="acct__col">
            {profile && profile.role !== "member" && (
              <div className="acct__badge" style={{ color: ROLE_COLOR[profile.role] }}>
                <ShieldCheck size={13} /> {ROLE_LABEL[profile.role]}
              </div>
            )}

            <div className="acct__section">Profile</div>

            <div className="acct__picrow">
              {profile?.avatarUrl ? (
                <img className="acct__pic" src={profile.avatarUrl} alt="" />
              ) : (
                <div className="acct__pic acct__pic--blank">
                  <UserIcon size={26} />
                </div>
              )}
              <div className="acct__picbtns">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(e) => {
                    pickAvatar(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="acct__minor"
                  disabled={!!busy}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy === "avatar" ? (
                    <>
                      <Loader2 size={13} className="gate__spin" /> Uploading…
                    </>
                  ) : (
                    <>
                      <ImagePlus size={13} /> Change picture
                    </>
                  )}
                </button>
                {profile?.avatarUrl && (
                  <button
                    type="button"
                    className="acct__minor"
                    disabled={!!busy}
                    onClick={() =>
                      run("avatarDel", async () => {
                        const previous = profile.avatarUrl;
                        await updateProfile({ avatarUrl: null });
                        await deleteAvatar(previous);
                        return "Picture removed.";
                      })
                    }
                  >
                    Remove
                  </button>
                )}
                <span className="acct__hint">PNG, JPG, WEBP or GIF, up to 2 MB.</span>
              </div>
            </div>

            <label className="gate__field">
              <span>Name</span>
              <input
                value={displayName}
                placeholder="How you want to be shown"
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <label className="gate__field">
              <span>
                Handle
                {handleFree === true && <b className="acct__ok"> · free</b>}
                {handleFree === false && <b className="acct__bad"> · taken</b>}
              </span>
              <input
                value={username}
                placeholder="yourname"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <p className="acct__hint">
              <AtSign size={11} /> Your handle is what other chasers see next to your position. 3-32
              characters, using a-z, 0-9, dot, dash or underscore.
            </p>
            <button
              type="button"
              className="gate__submit"
              disabled={!!busy || !dirty || handleFree === false}
              onClick={() =>
                run("profile", async () => {
                  await updateProfile({ displayName, username });
                  return "Profile saved.";
                })
              }
            >
              {busy === "profile" ? (
                <>
                  <Loader2 size={14} className="gate__spin" /> Saving…
                </>
              ) : (
                "Save profile"
              )}
            </button>

            <div className="acct__section">Sign-in methods</div>
            <div className="acct__methods">
              {providers.map((p) => (
                <span key={p} className="acct__method">
                  <Check size={12} /> {PROVIDER_LABEL[p] ?? p}
                  {providers.length > 1 && (
                    <button
                      type="button"
                      className="acct__unlink"
                      title={`Disconnect ${PROVIDER_LABEL[p] ?? p}`}
                      disabled={!!busy}
                      onClick={() =>
                        run("unlink", async () => {
                          await unlinkProvider(p);
                          return `${PROVIDER_LABEL[p] ?? p} disconnected.`;
                        })
                      }
                    >
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              {providers.length === 0 && <span className="acct__method">—</span>}
            </div>
            {!hasGoogle && (
              <button
                type="button"
                className="acct__minor"
                disabled={!!busy}
                onClick={() =>
                  run("link", async () => {
                    await linkProvider("google");
                    return "Finish connecting in your browser.";
                  })
                }
              >
                Connect Google
              </button>
            )}

            <label className="gate__field">
              <span>
                <Mail size={11} /> Email
                {user?.email_confirmed_at ? (
                  <b className="acct__ok"> · confirmed</b>
                ) : user?.email ? (
                  <b className="acct__bad"> · unconfirmed</b>
                ) : null}
              </span>
              <input
                value={email}
                type="text"
                inputMode="email"
                placeholder="you@example.com"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <button
              type="button"
              className="acct__minor"
              disabled={!!busy || !email.trim() || email.trim() === user?.email}
              onClick={() =>
                run("email", async () => {
                  await updateEmail(email);
                  return "Check both addresses — changing an email needs confirming from each.";
                })
              }
            >
              {busy === "email" ? "Sending…" : "Change email"}
            </button>

            <div className="acct__section">Password</div>
            {hasPassword ? (
              <>
                <label className="gate__field">
                  <span>New password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    placeholder="At least 8 characters"
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={!!busy}
                  />
                </label>
                <button
                  type="button"
                  className="acct__minor"
                  disabled={!!busy || password.length < 8}
                  onClick={() =>
                    run("password", async () => {
                      await updatePassword(password);
                      setPassword("");
                      return "Password changed.";
                    })
                  }
                >
                  {busy === "password" ? "Saving…" : "Change password"}
                </button>
              </>
            ) : (
              <>
                <p className="acct__hint">
                  This account signs in with{" "}
                  {providers.map((p) => PROVIDER_LABEL[p] ?? p).join(" and ")}. Send yourself a
                  reset link to add a password as well.
                </p>
                <button
                  type="button"
                  className="acct__minor"
                  disabled={!!busy || !user?.email}
                  onClick={() =>
                    run("reset", async () => {
                      await sendPasswordReset(user?.email ?? "");
                      return "Reset link sent.";
                    })
                  }
                >
                  {busy === "reset" ? "Sending…" : "Email me a password link"}
                </button>
              </>
            )}

            <div className="acct__section">
              <Home size={11} /> Where you are based
            </div>
            <p className="acct__hint">
              A pin on the map for your patch. Off unless you switch it on, and switched off it is
              not merely hidden — the coordinates are never sent to anyone else at all.
            </p>
            <label className="gate__field">
              <span>Place name</span>
              <input
                value={homeLabel}
                placeholder="Norman, OK"
                onChange={(e) => setHomeLabel(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <div className="acct__homerow">
              <span className="acct__coords">
                <MapPin size={11} />
                {profile?.homeLat != null && profile?.homeLon != null
                  ? `${profile.homeLat.toFixed(2)}, ${profile.homeLon.toFixed(2)}`
                  : "no pin set"}
              </span>
              <button
                type="button"
                className="acct__minor"
                disabled={!!busy}
                onClick={() =>
                  run("home", async () => {
                    // A home pin is stored to about a kilometre either way, so
                    // a city-level network fix is no worse here than a precise
                    // one -- this is the one place the fallback costs nothing.
                    const fix = await currentFix({
                      enableHighAccuracy: false,
                      timeout: 15000,
                    }).catch(() => {
                      throw new Error("Could not read your location.");
                    });
                    // Rounded before it is stored, not before it is shown: what
                    // is written down is already the coarse version, so there is
                    // no precise copy sitting in the database to leak later.
                    await updateProfile({
                      homeLat: blurHome(fix.lat),
                      homeLon: blurHome(fix.lon),
                      homeLabel,
                    });
                    return "Pin set to about a kilometre of where you are.";
                  })
                }
              >
                {busy === "home" ? "Reading…" : "Use my location"}
              </button>
              {profile?.homeLat != null && (
                <button
                  type="button"
                  className="acct__minor"
                  disabled={!!busy}
                  onClick={() =>
                    run("homeClear", async () => {
                      await updateProfile({
                        homeLat: null,
                        homeLon: null,
                        homeLabel: null,
                        homePublic: false,
                      });
                      return "Pin removed.";
                    })
                  }
                >
                  Remove pin
                </button>
              )}
            </div>
            <label className="acct__switch">
              <input
                type="checkbox"
                checked={Boolean(profile?.homePublic)}
                disabled={!!busy || profile?.homeLat == null}
                onChange={(e) =>
                  run("homePublic", async () => {
                    await updateProfile({ homePublic: e.target.checked, homeLabel });
                    return e.target.checked
                      ? "Your pin is on the map for everyone."
                      : "Your pin is private again.";
                  })
                }
              />
              <span>
                Show my pin to everyone
                <small>
                  Turn on the <b>Chaser home pins</b> layer to see it, yours included.
                </small>
              </span>
            </label>

            <div className="acct__section">
              <Eye size={11} /> What everyone can see
            </div>
            <ul className="acct__public">
              <li>
                <span>Picture</span>
                <b>{profile?.avatarUrl ? "Yes" : "None set"}</b>
              </li>
              <li>
                <span>Name</span>
                <b>{profile?.displayName || "— (your handle is shown instead)"}</b>
              </li>
              <li>
                <span>Handle</span>
                <b>@{profile?.username ?? "—"}</b>
              </li>
              <li>
                <span>Role</span>
                <b>{ROLE_LABEL[profile?.role ?? "member"]}</b>
              </li>
              <li>
                <span>Where you are based</span>
                <b>
                  {profile?.homePublic && profile?.homeLat != null
                    ? profile.homeLabel || `${profile.homeLat.toFixed(2)}, ${profile.homeLon?.toFixed(2)}`
                    : "Private"}
                </b>
              </li>
              <li>
                <span>Live position</span>
                <b>Only while you switch sharing on</b>
              </li>
            </ul>
            <p className="acct__hint">
              Your email, your password and your account id are never shown to other accounts.
            </p>

            <div className="acct__section">This account</div>
            <div className="acct__facts">
              <div>
                <span>Member since</span>
                <b>{fmtDate(profile?.createdAt ?? user?.created_at)}</b>
              </div>
              <div>
                <span>Account id</span>
                <b className="acct__id">
                  {user?.id ?? "—"}
                  <button
                    type="button"
                    title="Copy"
                    onClick={() => {
                      void navigator.clipboard?.writeText(user?.id ?? "");
                      setDone("Account id copied.");
                    }}
                  >
                    <Copy size={11} />
                  </button>
                </b>
              </div>
            </div>
            <button
              type="button"
              className="acct__minor"
              disabled={!!busy}
              onClick={() =>
                run("global", async () => {
                  await signOutEverywhere();
                  return "Signed out everywhere.";
                })
              }
            >
              Sign out on every device
            </button>

            <div className="acct__section acct__section--danger">Danger zone</div>
            {!danger ? (
              <button type="button" className="acct__minor" onClick={() => setDanger(true)}>
                <Trash2 size={13} /> Delete this account
              </button>
            ) : (
              <div className="acct__danger">
                <p>
                  This removes the account, its handle and its profile for good. Nothing is kept and
                  there is no undo. Type <b>{profile?.username}</b> to confirm.
                </p>
                <input
                  value={confirmText}
                  placeholder={profile?.username ?? ""}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <div className="acct__dangerbtns">
                  <button
                    type="button"
                    className="acct__minor"
                    onClick={() => {
                      setDanger(false);
                      setConfirmText("");
                    }}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="acct__signout"
                    disabled={!!busy || confirmText.trim() !== profile?.username}
                    onClick={() =>
                      run("delete", async () => {
                        await deleteAccount();
                        return "Account deleted.";
                      })
                    }
                  >
                    {busy === "delete" ? "Deleting…" : "Delete for good"}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="gate__error" role="alert">
                {error}
              </div>
            )}
            {done && !error && (
              <div className="auth__note-live" role="status">
                {done}
              </div>
            )}
          </div>
        </div>

        <footer className="acct__foot">
          <button type="button" className="acct__signout" onClick={() => void signOut()}>
            <LogOut size={14} /> Sign out
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
