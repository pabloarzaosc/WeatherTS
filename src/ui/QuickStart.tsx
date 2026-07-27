import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { AGE_UNLIMITED, ELEMENT_PRESETS, useSurfaceObsStore } from "../store/useSurfaceObsStore";
import {
  markQuickStartDone,
  markVersionSeen,
  quickStartDone,
  useOnboardingStore,
} from "../store/useOnboardingStore";

const api = () => (window as unknown as { electronAPI?: { getVersion?: () => Promise<string> } }).electronAPI;

type UnitSystem = "imperial" | "metric";

const LAYER_CHOICES: { id: string; label: string; blurb: string }[] = [
  { id: "nws-alerts", label: "Severe alerts", blurb: "Live NWS warnings, watches and advisories" },
  { id: "surfobs", label: "Surface observations", blurb: "METAR station plots" },
  { id: "nexrad", label: "Radar", blurb: "Single-site NEXRAD, pick a site on the map" },
];

const FRESHNESS_CHOICES: { id: number; label: string; detail: string }[] = [
  { id: AGE_UNLIMITED, label: "No limit", detail: "Keep all observations the feed returns" },
  { id: 180, label: "3 hours", detail: "Drop older readings for a fresher map" },
  { id: 60, label: "1 hour", detail: "Focus on the latest trends" },
];

/**
 * First-run setup. Deliberately not a tour: it applies real settings as you go,
 * so a new install lands configured rather than merely explained. Everything it
 * sets is reachable later from the panels, and it never blocks -- skipping
 * leaves the defaults untouched.
 */
export function QuickStart() {
  const open = useOnboardingStore((s) => s.quickStartOpen);
  const close = useOnboardingStore((s) => s.closeQuickStart);
  const openWhatsNew = useOnboardingStore((s) => s.openWhatsNew);

  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const layers = useAppStore((s) => s.layers);

  const setTempUnits = useSurfaceObsStore((s) => s.setTempUnits);
  const setWindUnits = useSurfaceObsStore((s) => s.setWindUnits);
  const setPresUnits = useSurfaceObsStore((s) => s.setPresUnits);
  const setVisUnits = useSurfaceObsStore((s) => s.setVisUnits);
  const setElementsPreset = useSurfaceObsStore((s) => s.setElementsPreset);
  const setMaxAgeMin = useSurfaceObsStore((s) => s.setMaxAgeMin);
  const setFadeStale = useSurfaceObsStore((s) => s.setFadeStale);
  const tempUnits = useSurfaceObsStore((s) => s.tempUnits);
  const elements = useSurfaceObsStore((s) => s.elements);
  const maxAgeMin = useSurfaceObsStore((s) => s.maxAgeMin);

  const [step, setStep] = useState(0);
  const system: UnitSystem = tempUnits === "F" ? "imperial" : "metric";

  // Offer itself once, on a genuinely fresh install.
  useEffect(() => {
    if (quickStartDone()) return;
    useOnboardingStore.getState().openQuickStart();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function applySystem(next: UnitSystem) {
    if (next === "imperial") {
      setTempUnits("F");
      setWindUnits("kt");
      setPresUnits("inHg");
      setVisUnits("mi");
    } else {
      setTempUnits("C");
      setWindUnits("ms");
      setPresUnits("mb");
      setVisUnits("km");
    }
  }

  function finish() {
    markQuickStartDone();
    // A fresh install has not "missed" anything, so treat the running version
    // as already read -- otherwise What's New would pop straight afterwards.
    void api()
      ?.getVersion?.()
      .then((v) => v && markVersionSeen(v))
      .catch(() => {});
    close();
  }

  function goBack() {
    setStep((n) => Math.max(0, n - 1));
  }

  function goNext() {
    setStep((n) => Math.min(steps.length - 1, n + 1));
  }

  if (!open) return null;

  const steps = [
    {
      key: "units",
      title: "Pick your units",
      lede: "Applies across station plots and readouts. Every unit can be changed individually later.",
      body: (
        <div className="qs__choices">
          {(
            [
              { id: "imperial", label: "Imperial", detail: "°F · knots · inHg · miles" },
              { id: "metric", label: "Metric", detail: "°C · m/s · millibars · kilometres" },
            ] as { id: UnitSystem; label: string; detail: string }[]
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              className={`qs__choice${system === o.id ? " is-on" : ""}`}
              onClick={() => applySystem(o.id)}
            >
              <span className="qs__choice-mark">{system === o.id && <Check size={13} />}</span>
              <span className="qs__choice-text">
                <b>{o.label}</b>
                <i>{o.detail}</i>
              </span>
            </button>
          ))}
        </div>
      ),
    },
    {
      key: "layers",
      title: "Choose what loads on the map",
      lede: "Turn these on now or leave them off — the Catalog has them either way.",
      body: (
        <div className="qs__choices">
          {LAYER_CHOICES.map((l) => {
            const on = layers[l.id]?.visible ?? false;
            return (
              <button
                key={l.id}
                type="button"
                className={`qs__choice${on ? " is-on" : ""}`}
                onClick={() => setLayerVisible(l.id, !on)}
              >
                <span className="qs__choice-mark">{on && <Check size={13} />}</span>
                <span className="qs__choice-text">
                  <b>{l.label}</b>
                  <i>{l.blurb}</i>
                </span>
              </button>
            );
          })}
        </div>
      ),
    },
    {
      key: "surface-defaults",
      title: "Tune station plots before you start",
      lede: "Set a practical Surface Obs default now so the map opens how you like it.",
      body: (
        <div className="qs__choices">
          {ELEMENT_PRESETS.map((p) => {
            const on = (Object.keys(p.elements) as (keyof typeof p.elements)[]).every((k) => p.elements[k] === elements[k]);
            return (
              <button key={p.id} type="button" className={`qs__choice${on ? " is-on" : ""}`} onClick={() => setElementsPreset(p.elements)}>
                <span className="qs__choice-mark">{on && <Check size={13} />}</span>
                <span className="qs__choice-text">
                  <b>{p.label}</b>
                  <i>{p.hint}</i>
                </span>
              </button>
            );
          })}
          {FRESHNESS_CHOICES.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`qs__choice${maxAgeMin === o.id ? " is-on" : ""}`}
              onClick={() => {
                setMaxAgeMin(o.id);
                setFadeStale(o.id !== AGE_UNLIMITED);
              }}
            >
              <span className="qs__choice-mark">{maxAgeMin === o.id && <Check size={13} />}</span>
              <span className="qs__choice-text">
                <b>{o.label}</b>
                <i>{o.detail}</i>
              </span>
            </button>
          ))}
        </div>
      ),
    },
    {
      key: "workflow",
      title: "Quick workflow tips",
      lede: "You can do most tasks from two places: Catalog and Layers.",
      body: (
        <ul className="qs__tips">
          <li>
            <b>Catalog</b> turns data sources on/off and opens each product view.
          </li>
          <li>
            <b>Layers</b> controls draw order and opacity for what is visible.
          </li>
          <li>
            <b>Settings</b> holds layout, motion, palette and this guide.
          </li>
        </ul>
      ),
    },
    {
      key: "done",
      title: "You are set up",
      lede: "Your defaults are saved. You can change everything later without restarting.",
      body: (
        <ul className="qs__tips">
          <li>
            Surface observations are ready with your chosen units and freshness.
          </li>
          <li>
            Use What's New to see every shipped update in one place.
          </li>
          <li>
            If you skip now, you can reopen Quick Start from Settings → Guides.
          </li>
        </ul>
      ),
    },
  ];

  const last = step === steps.length - 1;
  const s = steps[step];

  return (
    <div className="qs" role="dialog" aria-modal="true" aria-label="Quick start">
      <div className="qs__scrim" onClick={finish} />
      <div className="qs__panel">
        <button type="button" className="qs__close" onClick={finish} aria-label="Close">
          <X size={15} />
        </button>

        <div className="qs__rail" aria-hidden="true">
          {steps.map((st, i) => (
            <span key={st.key} className={`qs__pip${i === step ? " is-on" : ""}${i < step ? " is-done" : ""}`} />
          ))}
        </div>

        <div className="qs__main">
          <div className="qs__step" key={s.key}>
            <span className="qs__kicker">
              Quick start · {step + 1} of {steps.length}
            </span>
            <h2>{s.title}</h2>
            <p className="qs__lede">{s.lede}</p>
            <div className="qs__body">{s.body}</div>
          </div>
        </div>

        <footer className="qs__foot">
          <button type="button" className="qs__skip" onClick={finish}>
            Skip setup
          </button>
          <div className="qs__nav">
            {step > 0 && (
              <button type="button" className="qs__btn" onClick={goBack}>
                <ChevronLeft size={14} /> Back
              </button>
            )}
            {last ? (
              <button
                type="button"
                className="qs__btn qs__btn--primary"
                onClick={() => {
                  finish();
                  openWhatsNew();
                }}
              >
                Finish
              </button>
            ) : (
              <button type="button" className="qs__btn qs__btn--primary" onClick={goNext}>
                Continue <ChevronRight size={14} />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
