import { useEffect, useMemo, useRef, useState } from "react";
import { Film, RefreshCw, Repeat, Type, X } from "lucide-react";
import { Select } from "./Select";

import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { useSatStore } from "../store/useSatStore";
import { useTimelineStore } from "../store/useTimelineStore";
import {
  MP4_SUPPORTED,
  SIZE_PRESETS,
  selectedIndices,
  useGifStore,
  type AnimFormat,
  type AnimSubject,
} from "../store/useGifStore";
import { fhText } from "../lib/observations";
import {
  GifCancelled,
  downloadBlob,
  estimateDimensions,
  exportAnimation,
  probeMp4Support,
  type GifCancel,
  type GifProgress,
} from "../lib/gifExport";

// The "Customize Animation" dialog + its generation-progress twin. Styled to
// the app (dark, glass), not the light reference the flow was first modelled on.
// Beyond format + range it carries: quick range presets, playback direction
// (forward / boomerang), an info-bar toggle, and an output-size picker -- and
// what to animate: the radar loop, the Models panel's hours, or the satellite.

function fmtLocal(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

const label = (f: AnimFormat) => (f === "mp4" ? "MP4" : "GIF");

const SUBJECTS: [AnimSubject, string][] = [
  ["radar", "Radar"],
  ["models", "Models"],
  ["satellite", "Satellite"],
];

export function AnimationModal() {
  const open = useGifStore((s) => s.open);
  const setOpen = useGifStore((s) => s.setOpen);
  const format = useGifStore((s) => s.format);
  const setFormat = useGifStore((s) => s.setFormat);
  const startIdx = useGifStore((s) => s.startIdx);
  const endIdx = useGifStore((s) => s.endIdx);
  const setRange = useGifStore((s) => s.setRange);
  const step = useGifStore((s) => s.step);
  const setStep = useGifStore((s) => s.setStep);
  const delaySec = useGifStore((s) => s.delaySec);
  const setDelaySec = useGifStore((s) => s.setDelaySec);
  const loop = useGifStore((s) => s.loop);
  const setLoop = useGifStore((s) => s.setLoop);
  const caption = useGifStore((s) => s.caption);
  const setCaption = useGifStore((s) => s.setCaption);
  const scale = useGifStore((s) => s.scale);
  const setScale = useGifStore((s) => s.setScale);

  const subject = useGifStore((s) => s.subject);
  const setSubject = useGifStore((s) => s.setSubject);

  const scans = useNexradStore((s) => s.scans);
  const radarOn = useAppStore((s) => s.layers["nexrad"]?.visible ?? false);
  const obsFrames = useObsStore((s) => s.frames);
  const obsIndex = useObsStore((s) => s.index);
  const obsView = useObsStore((s) => s.view);
  const obsSource = useObsStore((s) => s.catalog?.sources.find((x) => x.id === s.source));
  const obsOn = useAppStore((s) => s.layers.observations?.visible ?? false);
  const satFrames = useSatStore((s) => s.frames);
  const satOn = useAppStore((s) => s.layers.satellite?.visible ?? false);
  const canRadar = radarOn && scans.length > 0;
  const canModels = obsOn && obsFrames.length > 0 && !obsSource?.tracks;
  const canSat = satOn && satFrames.length > 0;
  const available = SUBJECTS.filter(([v]) => (v === "radar" ? canRadar : v === "models" ? canModels : canSat));

  // What the dialog animates: what the timeline is driving when it opens (the
  // radar, when several are on -- as on the timeline), and any one by choice.
  useEffect(() => {
    if (!open) return;
    const driver = useTimelineStore.getState().driver;
    const driving: AnimSubject | null =
      driver === "radar" ? "radar" : driver === "obs" ? "models" : driver === "sat" ? "satellite" : null;
    const ok = available.map(([v]) => v);
    if (driving && ok.includes(driving)) setSubject(driving);
    else if (ok.length > 0 && !ok.includes(useGifStore.getState().subject)) setSubject(ok[0]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = subject === "models";
  const satellite = subject === "satellite";
  /** The frames to pick from, as the timeline has them. */
  const items = useMemo(
    () =>
      models
        ? obsFrames.map((f) => ({ unix: f.unix, text: f.fh != null ? `${fhText(f)} · ${fmtLocal(f.unix)}` : fmtLocal(f.unix) }))
        : satellite
          ? satFrames.map((f) => ({ unix: f.unix, text: fmtLocal(f.unix) }))
          : scans.map((sc) => ({ unix: sc.time, text: fmtLocal(sc.time) })),
    [models, satellite, obsFrames, satFrames, scans],
  );

  const [progress, setProgress] = useState<GifProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = still probing; false = this browser can't actually encode MP4.
  const [mp4Ok, setMp4Ok] = useState<boolean | null>(null);
  const cancel = useRef<GifCancel>({ cancelled: false });

  // Opening (or the loaded loop changing under it) defaults to the whole radar
  // loop -- or, for a model, the next day of its hours from the one on screen.
  useEffect(() => {
    if (!open || items.length === 0) return;
    if (models) {
      const from = Math.max(0, Math.min(obsIndex, items.length - 1));
      setRange(from, Math.min(items.length - 1, from + 24));
    } else setRange(0, items.length - 1);
  }, [open, models, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Actually test-encode MP4 once the dialog is open. `MP4_SUPPORTED` only means
  // the API exists (Firefox has it but no H.264 encoder); this catches that and
  // falls the format back to GIF so the user never hits the muxer error.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void probeMp4Support().then((ok) => {
      if (!alive) return;
      setMp4Ok(ok);
      if (!ok && useGifStore.getState().format === "mp4") setFormat("gif");
    });
    return () => {
      alive = false;
    };
  }, [open, setFormat]);

  const indices = useMemo(
    () => selectedIndices(startIdx, endIdx, step, items.length, loop),
    [startIdx, endIdx, step, items.length, loop],
  );
  const frameCount = indices.length;
  const dims = useMemo(
    () => estimateDimensions(scale, caption, subject),
    [scale, caption, subject, open, frameCount], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fps = delaySec > 0 ? (1 / delaySec).toFixed(1) : "—";

  if (!open) return null;

  const last = items.length - 1;
  const preset = (n: number) => setRange(Math.max(0, last - n + 1), last);
  /** A model's next n hours from the one on screen. */
  const ahead = (n: number) => {
    const from = Math.max(0, Math.min(obsIndex, last));
    setRange(from, Math.min(last, from + n));
  };

  const generate = async () => {
    cancel.current = { cancelled: false };
    setError(null);
    setProgress({ phase: "capturing", done: 0, total: frameCount });
    try {
      const { blob, name } = await exportAnimation(
        { indices, delayMs: Math.round(delaySec * 1000), area: null, format, caption, scale, subject },
        setProgress,
        cancel.current,
      );
      downloadBlob(blob, name);
      setProgress(null);
      setOpen(false);
    } catch (e) {
      setProgress(null);
      if (!(e instanceof GifCancelled)) {
        setError(e instanceof Error ? e.message : "Export failed.");
      }
    }
  };

  // --- generation progress ---
  if (progress) {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="animov" role="dialog" aria-modal="true" aria-label="Generating animation">
        <div className="animod animod--progress">
          <div className="animod__head">
            <h2 className="animod__title">
              <Film size={16} /> Generating {label(format)}
            </h2>
            <button className="animod__x" onClick={() => (cancel.current.cancelled = true)} aria-label="Cancel">
              <X size={18} />
            </button>
          </div>
          <div className="animod__body">
            <div className="animprog__track">
              <div className="animprog__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="animprog__status">
              {progress.phase === "encoding"
                ? `Encoding ${label(format)}…`
                : `Capturing frame ${progress.done}/${progress.total} (${pct}%)`}
            </div>
            <p className="animprog__note">
              Keep this window open and visible while it renders — the frames are captured from
              the live map.
            </p>
          </div>
          <div className="animod__foot">
            <button className="animbtn" onClick={() => (cancel.current.cancelled = true)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const noScans = items.length === 0 || (models && obsView === "models");
  const empty = models
    ? obsView === "models"
      ? "Close Compare models first: the animation records the main map."
      : "Open a model in the Models panel, and switch its layer on, then come back to export it."
    : satellite
      ? "Switch the satellite on and pick a product, then come back to export it."
      : "Load a radar site and let its loop cache first, then come back to export it.";

  // --- customize ---
  return (
    <div className="animov" role="dialog" aria-modal="true" aria-label="Customize animation">
      <div className="animod">
        <div className="animod__head">
          <h2 className="animod__title">
            <Film size={16} /> Export Animation
          </h2>
          <button className="animod__x" onClick={() => setOpen(false)} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="animod__body">
          {available.length > 1 && (
            <div className="animsec">
              <div className="animsec__label">Animate</div>
              <div className="animseg">
                {available.map(([v, text]) => (
                  <button
                    key={v}
                    className={`animseg__btn${subject === v ? " is-on" : ""}`}
                    onClick={() => setSubject(v)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {noScans ? (
            <p className="animprog__note">{empty}</p>
          ) : (
            <>
              <div className="animrow2">
                <div>
                  <div className="animsec__label">Format</div>
                  <div className="animseg">
                    <button
                      className={`animseg__btn${format === "mp4" ? " is-on" : ""}`}
                      onClick={() => setFormat("mp4")}
                      disabled={!MP4_SUPPORTED || mp4Ok === false}
                      title={
                        !MP4_SUPPORTED || mp4Ok === false
                          ? "MP4 needs a Chromium-based browser (Firefox can't encode it) — use GIF here."
                          : ""
                      }
                    >
                      MP4
                    </button>
                    <button
                      className={`animseg__btn${format === "gif" ? " is-on" : ""}`}
                      onClick={() => setFormat("gif")}
                    >
                      GIF
                    </button>
                  </div>
                </div>
                <div>
                  <div className="animsec__label">Size</div>
                  <div className="animseg">
                    {SIZE_PRESETS.map((p) => (
                      <button
                        key={p.scale}
                        className={`animseg__btn${scale === p.scale ? " is-on" : ""}`}
                        onClick={() => setScale(p.scale)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="animsec__label">
                Time Range
                <span className="animpresets">
                  {models
                    ? [12, 24].map((n) =>
                        n <= last ? (
                          <button key={n} className="animchip" onClick={() => ahead(n)}>
                            Next {n}
                          </button>
                        ) : null,
                      )
                    : [10, 30].map((n) =>
                        n <= last + 1 ? (
                          <button key={n} className="animchip" onClick={() => preset(n)}>
                            Last {n}
                          </button>
                        ) : null,
                      )}
                  <button className="animchip" onClick={() => setRange(0, last)}>
                    {models ? "Whole run" : "Full loop"}
                  </button>
                </span>
              </div>
              <div className="animrange">
                <label className="animfield">
                  <span>Start</span>
                  <Select
                    value={String(startIdx)}
                    onChange={(value) => setRange(Math.min(Number(value), endIdx), endIdx)}
                    aria-label="First frame"
                    options={items.map((it, i) => ({ value: String(i), label: it.text }))}
                  />
                </label>
                <label className="animfield">
                  <span>End</span>
                  <Select
                    value={String(endIdx)}
                    onChange={(value) => setRange(startIdx, Math.max(Number(value), startIdx))}
                    aria-label="Last frame"
                    options={items.map((it, i) => ({ value: String(i), label: it.text }))}
                  />
                </label>
              </div>

              <div className="animsec__label animsec__label--slider">
                Frame Step: every {step} {step === 1 ? "frame" : "frames"}
              </div>
              <input
                type="range"
                className="animslider"
                min={1}
                max={Math.max(1, Math.min(10, Math.max(1, endIdx - startIdx)))}
                step={1}
                value={step}
                onChange={(e) => setStep(Number(e.target.value))}
                style={{ "--fill": `${((step - 1) / 9) * 100}%` } as React.CSSProperties}
              />

              <div className="animsec__label animsec__label--slider">
                Frame Delay: {delaySec.toFixed(1)} s <span className="animdim">≈ {fps} fps</span>
              </div>
              <input
                type="range"
                className="animslider"
                min={0.1}
                max={1}
                step={0.1}
                value={delaySec}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                style={{ "--fill": `${((delaySec - 0.1) / 0.9) * 100}%` } as React.CSSProperties}
              />

              <div className="animtoggles">
                <button
                  className={`animtoggle${loop === "boomerang" ? " is-on" : ""}`}
                  onClick={() => setLoop(loop === "boomerang" ? "forward" : "boomerang")}
                  title="Play forward, then back — a seamless loop"
                >
                  <Repeat size={13} /> Boomerang
                </button>
                <button
                  className={`animtoggle${caption ? " is-on" : ""}`}
                  onClick={() => setCaption(!caption)}
                  title="Burn the product / time / colour-scale bar into the frames"
                >
                  <Type size={13} /> Info bar
                </button>
              </div>

              <div className="animsummary">
                <RefreshCw size={13} />
                <span>
                  {frameCount} {frameCount === 1 ? "frame" : "frames"}
                  {dims ? ` · ${dims.w}×${dims.h}` : ""} · {(frameCount * delaySec).toFixed(1)} s{" "}
                  {label(format)}
                </span>
              </div>
              {error && <div className="animsummary animsummary--err">{error}</div>}
            </>
          )}
        </div>

        <div className="animod__foot">
          <button className="animbtn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="animbtn animbtn--go"
            onClick={() => void generate()}
            disabled={noScans || frameCount === 0}
          >
            Generate {label(format)}
          </button>
        </div>
      </div>
    </div>
  );
}
