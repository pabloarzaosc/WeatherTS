import { useEffect, useState, type ReactNode } from "react";
import { LocateFixed, MapPin, Radio, UserRound, Users } from "lucide-react";

import { getLayerModules } from "../../layers/registry";
import { useAccountGate, type AccountFeature } from "../../store/useAccountGate";
import { useAppStore } from "../../store/useAppStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useChaserStore } from "../../store/useChaserStore";
import { useOnboardingStore } from "../../store/useOnboardingStore";

/* ------------------------------------------------------------------ guard */

/** Account-only layers the guard switched off, to switch back on at sign-in.
 *  Kept at module level so it survives the gate swapping the app out for the
 *  data notice on the way in. */
const heldBack = new Set<string>();

/**
 * Keeps a visitor without an account out of what needs one, without asking
 * them anything (renders nothing).
 *
 * The Chasers layer is on by default and sharing is remembered across
 * restarts, so a guest -- or someone whose session ran out -- would otherwise
 * open the app with switches reading "on" for things that cannot run. They go
 * off quietly here; the prompt waits until someone actually reaches for one.
 * Signing in puts back the layers this took away. Sharing stays off, because a
 * location broadcast is never resumed without being asked for again.
 */
export function AccountGuard() {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    const app = useAppStore.getState();
    if (status === "signedOut") {
      for (const m of getLayerModules()) {
        if (m.requiresAccount && app.layers[m.id]?.visible) {
          heldBack.add(m.id);
          app.setLayerVisible(m.id, false);
        }
      }
      if (useChaserStore.getState().sharing) useChaserStore.getState().setSharing(false);
    } else if (status === "signedIn" || status === "offline") {
      for (const id of heldBack) app.setLayerVisible(id, true);
      heldBack.clear();
    }
  }, [status]);

  return null;
}

/* ---------------------------------------------------------------- dialogs */

function Dialog({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="acctask" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="acctask__scrim" onClick={onClose} />
      <div className="acctask__card">{children}</div>
    </div>
  );
}

/** The same three ways out of every account prompt: not now, sign in, create one. */
function Actions({ dismissLabel, onDismiss }: { dismissLabel: string; onDismiss: () => void }) {
  const openAuth = useAccountGate((s) => s.openAuth);
  return (
    <footer className="acctask__foot">
      <button type="button" className="qs__skip" onClick={onDismiss}>
        {dismissLabel}
      </button>
      <div className="qs__nav">
        <button
          type="button"
          className="qs__btn"
          onClick={() => {
            onDismiss();
            openAuth("signin");
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          className="qs__btn qs__btn--primary"
          autoFocus
          onClick={() => {
            onDismiss();
            openAuth("signup");
          }}
        >
          Create account
        </button>
      </div>
    </footer>
  );
}

const NEEDS: Record<AccountFeature, { icon: ReactNode; title: string; body: string }> = {
  location: {
    icon: <LocateFixed size={17} />,
    title: "Finding you on the map needs an account",
    body:
      "It reads this device's position, and when the device can't answer, looks your IP address up " +
      "with an outside service. Both are covered by the data notice you agree to when you create an " +
      "account, so they only run for accounts.",
  },
  share: {
    icon: <Radio size={17} />,
    title: "Sharing your position needs an account",
    body:
      "Other chasers see you under your account's handle. Without an account there is no name to put " +
      "on your marker, and nothing that ties the position to you.",
  },
  chasers: {
    icon: <Users size={17} />,
    title: "Seeing other chasers needs an account",
    body:
      "Live positions are only exchanged between signed-in accounts, so everyone on that map knows " +
      "who can see where they are.",
  },
  homes: {
    icon: <MapPin size={17} />,
    title: "Home pins need an account",
    body:
      "Where chasers say they are based is part of their account profiles, and WeatherTS shows those " +
      "pins to other accounts.",
  },
};

/**
 * What a visitor without an account sees on reaching for something that needs
 * one. It says what the account is FOR in this case: "sign up to continue" with
 * no reason reads as a paywall, and this is not one.
 */
export function AccountRequired() {
  const need = useAccountGate((s) => s.need);
  const dismiss = useAccountGate((s) => s.dismiss);
  if (!need) return null;
  const n = NEEDS[need];
  return (
    <Dialog labelledBy="acctask-title" onClose={dismiss}>
      <span className="acctask__icon">{n.icon}</span>
      <span className="acctask__kicker">Account needed</span>
      <h2 id="acctask-title">{n.title}</h2>
      <p className="acctask__lede">{n.body}</p>
      <p className="acctask__free">
        An account is free while WeatherTS is being built, and everything else keeps working without one.
      </p>
      <Actions dismissLabel="Not now" onDismiss={dismiss} />
    </Dialog>
  );
}

const K_WELCOMED = "weatherts.guestWelcome.shown";
const welcomedThisLaunch = () => {
  try {
    return window.sessionStorage.getItem(K_WELCOMED) === "1";
  } catch {
    return false;
  }
};
const markWelcomed = () => {
  try {
    window.sessionStorage.setItem(K_WELCOMED, "1");
  } catch {
    /* storage blocked: the note may show again, which is harmless */
  }
};

const PERKS: { icon: ReactNode; text: string }[] = [
  { icon: <Radio size={15} />, text: "Share your position with other chasers, under your own handle" },
  { icon: <Users size={15} />, text: "See who else is out, and where chasers are based" },
  { icon: <LocateFixed size={15} />, text: "Jump to where you are on the map" },
  { icon: <UserRound size={15} />, text: "A profile of your own: name, picture and home pin" },
];

/**
 * The note for someone opening the app without an account: everything public
 * works, and an account is still the better way to use it.
 *
 * Once per launch, a moment after the map appears, and never on top of Quick
 * Start, What's New or a prompt already up -- it waits for those to close. Not
 * for someone who opened the app signed in and then signed out: they have an
 * account and know it.
 */
export function GuestWelcome() {
  const status = useAuthStore((s) => s.status);
  const quickStartOpen = useOnboardingStore((s) => s.quickStartOpen);
  const whatsNewOpen = useOnboardingStore((s) => s.whatsNewOpen);
  const promptUp = useAccountGate((s) => s.auth !== null || s.need !== null);
  const [openedAsGuest] = useState(() => useAuthStore.getState().status === "signedOut");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!openedAsGuest || status !== "signedOut" || welcomedThisLaunch()) return;
    if (quickStartOpen || whatsNewOpen || promptUp) return;
    const t = window.setTimeout(() => {
      markWelcomed();
      setOpen(true);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [openedAsGuest, status, quickStartOpen, whatsNewOpen, promptUp]);

  if (!open || status !== "signedOut") return null;
  const close = () => setOpen(false);
  return (
    <Dialog labelledBy="guest-welcome-title" onClose={close}>
      <span className="acctask__kicker">Using WeatherTS without an account</span>
      <h2 id="guest-welcome-title">It's better with an account</h2>
      <p className="acctask__lede">
        Radar, warnings, outlooks and soundings all work as they are. An account adds the part of WeatherTS
        that is about people:
      </p>
      <ul className="acctask__perks">
        {PERKS.map((p) => (
          <li key={p.text}>
            {p.icon}
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
      <Actions dismissLabel="Continue without an account" onDismiss={close} />
    </Dialog>
  );
}
