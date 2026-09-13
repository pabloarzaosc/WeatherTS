import { useEffect, useMemo, useRef, useState } from "react";
import { Film, RefreshCw, Repeat, Type, X } from "lucide-react";
import { Select } from "./Select";

import { useNexradStore } from "../store/useNexradStore";
import {
  MP4_SUPPORTED,
  SIZE_PRESETS,
  selectedIndices,
  useGifStore,
  type AnimFormat,
} from "../store/useGifStore";
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
// (forward / boomerang), an info-bar toggle, and an output-size picker.

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

  const scans = useNexradStore((s) => s.scans);

  const [progress, setProgress] = useState<GifProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = still probing; false = this browser can't actually encode MP4.
  const [mp4Ok, setMp4Ok] = useState<boolean | null>(null);
  const cancel = useRef<GifCancel>({ cancelled: false });

  // Opening (or the loaded loop changing under it) defaults to the whole loop.
  useEffect(() => {
    if (!open || scans.length === 0) return;
    setRange(0, scans.length - 1);
  }, [open, scans.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
    () => selectedIndices(startIdx, endIdx, step, scans.length, loop),
    [startIdx, endIdx, step, scans.length, loop],
  );
  const frameCount = indices.length;
  const dims = useMemo(() => estimateDimensions(scale, caption), [scale, caption, open, frameCount]);
  const fps = delaySec > 0 ? (1 / delaySec).toFixed(1) : "—";

  if (!open) return null;

  const last = scans.length - 1;
  const preset = (n: number) => setRange(Math.max(0, last - n + 1), last);

  const generate = async () => {
    cancel.current = { cancelled: false };
    setError(null);
    setProgress({ phase: "capturing", done: 0, total: frameCount });
    try {
      const { blob, name } = await exportAnimation(
        { indices, delayMs: Math.round(delaySec * 1000), area: null, format, caption, scale },
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

  const noScans = scans.length === 0;

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
          {noScans ? (
            <p className="animprog__note">Load a radar site and let its loop cache first, then come back to export it.</p>
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
                  {[10, 30].map((n) =>
                    n <= last + 1 ? (
                      <button key={n} className="animchip" onClick={() => preset(n)}>
                        Last {n}
                      </button>
                    ) : null,
                  )}
                  <button className="animchip" onClick={() => setRange(0, last)}>
                    Full loop
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
                    options={scans.map((s, i) => ({ value: String(i), label: fmtLocal(s.time) }))}
                  />
                </label>
                <label className="animfield">
                  <span>End</span>
                  <Select
                    value={String(endIdx)}
                    onChange={(value) => setRange(startIdx, Math.max(Number(value), startIdx))}
                    aria-label="Last frame"
                    options={scans.map((s, i) => ({ value: String(i), label: fmtLocal(s.time) }))}
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
                  title="Play forward, then back — a seamless radar loop"
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
