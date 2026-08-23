import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  Database,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  MapPin,
  Network,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import {
  CONSENT_SECTIONS,
  CONSENT_STATEMENT,
  CONSENT_SUMMARY,
  type ConsentPoint,
} from "../../lib/consent";

/**
 * The data notice, and the checkbox that gates an account behind it.
 *
 * Two rules shape this component. The button stays dead until the box is
 * ticked, because that is what "you have to accept" means. And the box itself
 * stays dead until the text has been scrolled to the end -- not to be
 * obstructive, but because a consent someone could give without the text ever
 * having moved is a consent to nothing, and this notice has a section in it
 * about broadcasting your position to strangers.
 *
 * Everything else here exists to make the reading survivable: the gist up top
 * so nobody starts blind, an icon per section so the shape of the document is
 * visible while scrolling, a rail that fills as you go, and the one section
 * worth not skimming drawn as a callout instead of another block of grey.
 */

const SECTION_ICON: Record<string, typeof Lock> = {
  why: UserRound,
  signup: Database,
  google: KeyRound,
  location: MapPin,
  network: Network,
  never: EyeOff,
  retention: Trash2,
  who: ShieldCheck,
};

const VIS_ICON: Record<NonNullable<ConsentPoint["visibility"]>, typeof Lock> = {
  private: Lock,
  public: Globe,
  shared: Users,
};

const VIS_LABEL: Record<NonNullable<ConsentPoint["visibility"]>, string> = {
  private: "Only you",
  public: "Anyone",
  shared: "While you share",
};

const SUMMARY_ICON = { private: Lock, public: Eye, never: EyeOff };

export function ConsentPanel({
  onAccept,
  onCancel,
  busy,
  cancelLabel = "Back",
  acceptLabel = "Agree and continue",
}: {
  onAccept: () => void;
  onCancel: () => void;
  busy?: boolean;
  cancelLabel?: string;
  acceptLabel?: string;
}) {
  const [agreed, setAgreed] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const [progress, setProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A notice short enough not to scroll is already read; without this the
  // checkbox would be permanently disabled on a tall window.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      const travel = el.scrollHeight - el.clientHeight;
      const pct = travel <= 0 ? 1 : Math.min(1, el.scrollTop / travel);
      setProgress(pct);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  const toEnd = () => {
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="consent">
      <header className="consent__head">
        <span className="consent__seal">
          <ShieldCheck size={17} />
        </span>
        <div className="consent__headtext">
          <h2 className="consent__title">Before you create an account</h2>
          <p className="consent__sub">
            Everything WeatherTS would know about you, in full. Nothing here is hidden in a link.
          </p>
        </div>
      </header>

      <div className="consent__rail" aria-hidden="true">
        <span className="consent__railfill" style={{ transform: `scaleX(${progress})` }} />
      </div>

      <div className="consent__body">
        <div className="consent__scroll" ref={scrollRef} tabIndex={0}>
          <div className="consent__summary">
            {CONSENT_SUMMARY.map((card) => {
              const Icon = SUMMARY_ICON[card.tone];
              return (
                <div className={`consent__card is-${card.tone}`} key={card.tone}>
                  <Icon size={13} />
                  <b>{card.head}</b>
                  <span>{card.body}</span>
                </div>
              );
            })}
          </div>

          {CONSENT_SECTIONS.map((section, i) => {
            const Icon = SECTION_ICON[section.id] ?? Database;
            return (
              <section
                className={`consent__sec${section.emphasis ? " is-emphasis" : ""}`}
                key={section.id}
              >
                <h3 className="consent__sectitle">
                  <span className="consent__secicon">
                    <Icon size={13} />
                  </span>
                  {section.title}
                  <span className="consent__secnum">
                    {i + 1}/{CONSENT_SECTIONS.length}
                  </span>
                </h3>

                {section.intro && <p className="consent__intro">{section.intro}</p>}

                {section.paragraphs?.map((p, j) => (
                  <p className="consent__para" key={j}>
                    {p}
                  </p>
                ))}

                {section.points && (
                  <ul className="consent__points">
                    {section.points.map((point) => {
                      const VIcon = point.visibility ? VIS_ICON[point.visibility] : null;
                      return (
                        <li className="consent__point" key={point.term}>
                          <div className="consent__pointhead">
                            <b>{point.term}</b>
                            {point.optional && <span className="consent__tag">optional</span>}
                            {point.visibility && VIcon && (
                              <span className={`consent__vis is-${point.visibility}`}>
                                <VIcon size={10} />
                                {VIS_LABEL[point.visibility]}
                              </span>
                            )}
                          </div>
                          <p className="consent__pointdesc">{point.detail}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        {/* Fades the last line rather than cutting it, so there is always a
            visible cue that the document continues. Gone once it does not. */}
        <div className={`consent__fade${readToEnd ? " is-done" : ""}`} aria-hidden="true" />

        {!readToEnd && (
          <button type="button" className="consent__jump" onClick={toEnd}>
            <ArrowDown size={12} />
            Skip to the end
          </button>
        )}
      </div>

      <div className="consent__foot">
        <label className={`consent__agree${readToEnd ? "" : " is-locked"}`}>
          <input
            type="checkbox"
            checked={agreed}
            disabled={!readToEnd || !!busy}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span className="consent__box" aria-hidden="true">
            {agreed && <Check size={12} strokeWidth={3} />}
          </span>
          <span className="consent__agreetext">
            {CONSENT_STATEMENT}
            {!readToEnd && <em className="consent__lockhint">Read to the end to enable this.</em>}
          </span>
        </label>

        <div className="consent__acts">
          <button type="button" className="auth__link" onClick={onCancel} disabled={!!busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="auth__submit consent__accept"
            onClick={onAccept}
            disabled={!agreed || !!busy}
          >
            {busy ? "Saving…" : acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
