import { useEffect, useMemo, useState } from "react";
import { Download, Film, FolderOpen, Image as ImageIcon, Type, Video, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { useGifStore } from "../store/useGifStore";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { paneLetter } from "../store/usePaneStore";
import { useSatStore } from "../store/useSatStore";
import { useTimelineStore } from "../store/useTimelineStore";
import {
  EXPORT_SIZES,
  FPS_MAX,
  FPS_MIN,
  openExport,
  useExportStore,
  type ExportKind,
  type ExportSize,
} from "../store/useExportStore";
import { videoKind } from "../lib/gifExport";
import {
  canShowInFolder,
  cancelExport,
  exportDims,
  frameDelayMs,
  loopSubject,
  runExport,
  showInFolder,
} from "../lib/viewExport";

/**
 * The Export page: what is on screen as an image, the whole loop as a GIF or
 * a video -- for the pane it was opened from, or every pane together in place.
 * Opened from a pane's menu, the map's right-click menu and the dock's Export.
 * The work is src/lib/viewExport.ts; the Customize Animation dialog
 * (AnimationModal) stays for a range of frames, a step, a boomerang.
 */

const SIZE_LABEL: Record<ExportSize, string> = { "640": "640", "960": "960", "1280": "1280", full: "Full" };
const SUBJECT_LABEL = { radar: "radar loop", models: "model run", satellite: "satellite loop" } as const;

/** "Export…" in a pane's menu and the map's right-click menu. */
export function ExportMenuItem({ paneId, onDone, itemClass }: { paneId: string | null; onDone: () => void; itemClass: string }) {
  return (
    <button
      type="button"
      className={itemClass}
      onClick={() => {
        // From a pane's own menu: that pane, with "All panes" one click away.
        openExport(paneId, false);
        onDone();
      }}
      title="Save this view as an image, or the loop as a GIF or a video"
    >
      <Download size={15} />
      Export…
    </button>
  );
}

function Progress({ kind }: { kind: ExportKind }) {
  const job = useExportStore((s) => s.job);
  if (!job || job.kind !== kind) return null;
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const text =
    job.phase === "saving"
      ? "Saving…"
      : job.phase === "encoding"
        ? kind === "gif"
          ? "Encoding the GIF…"
          : "Encoding the video…"
        : kind === "image"
          ? "Drawing…"
          : job.total > 0
            ? `Frame ${job.done} of ${job.total}`
            : "Starting…";
  return (
    <div className="exp__prog" role="status">
      <div className="exp__track">
        <div className="exp__fill" style={{ width: `${job.phase === "capturing" ? pct : 100}%` }} />
      </div>
      <span className="exp__progtext">{text}</span>
      {job.phase !== "saving" && (
        <button type="button" className="exp__cancel" onClick={cancelExport}>
          Cancel
        </button>
      )}
    </div>
  );
}

function Outcome({ kind }: { kind: ExportKind }) {
  const result = useExportStore((s) => s.result);
  const error = useExportStore((s) => s.error);
  if (error && error.kind === kind) return <div className="exp__err">{error.message}</div>;
  if (!result || result.kind !== kind) return null;
  return (
    <div className="exp__done">
      <span className="exp__name" title={result.path ?? result.name}>
        {result.path ? "Saved" : "Downloaded"} {result.name}
      </span>
      {result.path && canShowInFolder() && (
        <button type="button" className="exp__link" onClick={() => showInFolder(result.path!)}>
          <FolderOpen size={13} /> Show in folder
        </button>
      )}
      {result.note && <span className="exp__note">{result.note}</span>}
    </div>
  );
}

function Row({
  kind,
  icon,
  title,
  sub,
  action,
  disabled,
}: {
  kind: ExportKind;
  icon: React.ReactNode;
  title: string;
  sub: string;
  action: string;
  disabled?: string | null;
}) {
  const job = useExportStore((s) => s.job);
  return (
    <section className={`exp__row${job?.kind === kind ? " is-busy" : ""}`}>
      <div className="exp__rowhead">
        <span className="exp__icon">{icon}</span>
        <div className="exp__what">
          <b>{title}</b>
          <span>{disabled ?? sub}</span>
        </div>
        <button
          type="button"
          className="animbtn animbtn--go exp__go"
          disabled={!!job || !!disabled}
          onClick={() => void runExport(kind)}
        >
          {action}
        </button>
      </div>
      <Progress kind={kind} />
      <Outcome kind={kind} />
    </section>
  );
}

export function ExportPage() {
  const open = useExportStore((s) => s.open);
  const paneId = useExportStore((s) => s.paneId);
  const all = useExportStore((s) => s.all);
  const caption = useExportStore((s) => s.caption);
  const size = useExportStore((s) => s.size);
  const speed = useExportStore((s) => s.speed);
  const fps = useExportStore((s) => s.fps);
  const job = useExportStore((s) => s.job);
  const paneCount = useAppStore((s) => s.paneCount);
  // What the loop is: re-read when any of the loops change.
  const scans = useNexradStore((s) => s.scans.length);
  const obsFrames = useObsStore((s) => s.frames.length);
  const satFrames = useSatStore((s) => s.frames.length);
  const tlSpeed = useTimelineStore((s) => s.speed);
  const layers = useAppStore((s) => s.layers);
  const [video, setVideo] = useState<"mp4" | "webm" | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void videoKind().then((v) => alive && setVideo(v));
    return () => {
      alive = false;
    };
  }, [open]);

  // Esc closes (and stops a run).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cancelExport();
      useExportStore.getState().close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const multi = all && paneCount > 1;
  const loop = useMemo(() => (open ? loopSubject() : null), [open, scans, obsFrames, satFrames, layers]); // eslint-disable-line react-hooks/exhaustive-deps
  const imgDims = useMemo(() => (open ? exportDims("image", multi, paneId, size) : null), [open, multi, paneId, size, paneCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const animDims = useMemo(() => (open ? exportDims("gif", multi, paneId, size) : null), [open, multi, paneId, size, paneCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const delay = loop ? frameDelayMs(loop.subject) : speed === "fps" ? 1000 / fps : 700 / (tlSpeed || 1);
  const loopFps = loop ? (1000 / frameDelayMs(loop.subject)).toFixed(1) : null;
  const dimText = (d: { w: number; h: number } | null) => (d ? `${d.w} × ${d.h}` : "");
  const loopText = loop
    ? `Whole ${SUBJECT_LABEL[loop.subject]} · ${loop.frames} frame${loop.frames === 1 ? "" : "s"} · ${dimText(animDims)} · ${(delay / 1000).toFixed(2)} s a frame`
    : "";
  const noLoop = loop ? null : "Load a radar loop, a model or the satellite first: there is no loop to record yet.";
  const close = () => {
    cancelExport();
    useExportStore.getState().close();
  };

  return (
    <div className="animov" role="dialog" aria-modal="true" aria-label="Export" onMouseDown={(e) => e.target === e.currentTarget && !job && close()}>
      <div className="animod exp">
        <div className="animod__head">
          <h2 className="animod__title">
            <Download size={16} /> Export
            <span className="exp__scope">{multi ? `all ${paneCount} panes` : paneCount > 1 ? `Pane ${paneLetter(paneId)}` : ""}</span>
          </h2>
          <button className="animod__x" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="animod__body">
          <div className="exp__opts">
            {paneCount > 1 && (
              <div className="animseg" role="group" aria-label="What to export">
                <button
                  type="button"
                  className={`animseg__btn${!multi ? " is-on" : ""}`}
                  disabled={!!job}
                  onClick={() => useExportStore.getState().setAll(false)}
                >
                  This pane ({paneLetter(paneId)})
                </button>
                <button
                  type="button"
                  className={`animseg__btn${multi ? " is-on" : ""}`}
                  disabled={!!job}
                  onClick={() => useExportStore.getState().setAll(true)}
                >
                  All {paneCount} panes
                </button>
              </div>
            )}
            <button
              type="button"
              className={`animtoggle${caption ? " is-on" : ""}`}
              disabled={!!job}
              aria-pressed={caption}
              onClick={() => useExportStore.getState().setCaption(!caption)}
              title="What each pane shows and when, top left"
            >
              <Type size={13} /> Caption
            </button>
          </div>

          <Row
            kind="image"
            icon={<ImageIcon size={16} />}
            title="Image"
            sub={`PNG · ${dimText(imgDims)} · the screen's resolution`}
            action="Save image"
          />
          <Row
            kind="gif"
            icon={<Film size={16} />}
            title="GIF"
            sub={loopText}
            action="Make GIF"
            disabled={noLoop}
          />
          <Row
            kind="video"
            icon={<Video size={16} />}
            title="Video"
            sub={`${video === "webm" ? "WebM (no MP4 encoder here)" : video === null ? "No video encoder here" : "MP4"} · ${loopText.replace(/^Whole [^·]+· /, "")}`}
            action="Make video"
            disabled={noLoop ?? (video === null ? "This browser can't record video: make a GIF instead." : null)}
          />

          <div className="exp__set">
            <span className="exp__setlabel">Size</span>
            <div className="animseg" role="group" aria-label="GIF and video size">
              {EXPORT_SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`animseg__btn${size === s ? " is-on" : ""}`}
                  disabled={!!job}
                  onClick={() => useExportStore.getState().setSize(s)}
                  title={s === "full" ? "The screen's resolution, at most 1920 px on the long side" : `${s} px on the long side`}
                >
                  {SIZE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="exp__set">
            <span className="exp__setlabel">Speed</span>
            <div className="animseg" role="group" aria-label="GIF and video speed">
              <button
                type="button"
                className={`animseg__btn${speed === "loop" ? " is-on" : ""}`}
                disabled={!!job}
                onClick={() => useExportStore.getState().setSpeed("loop")}
              >
                Loop speed{speed === "loop" && loopFps ? ` · ${loopFps} fps` : ""}
              </button>
              <button
                type="button"
                className={`animseg__btn${speed === "fps" ? " is-on" : ""}`}
                disabled={!!job}
                onClick={() => useExportStore.getState().setSpeed("fps")}
              >
                Frame rate
              </button>
            </div>
          </div>
          {speed === "fps" && (
            <label className="exp__fps">
              <input
                type="range"
                className="animslider"
                min={FPS_MIN}
                max={FPS_MAX}
                step={1}
                value={fps}
                disabled={!!job}
                onChange={(e) => useExportStore.getState().setFps(Number(e.target.value))}
                style={{ "--fill": `${((fps - FPS_MIN) / (FPS_MAX - FPS_MIN)) * 100}%` } as React.CSSProperties}
                aria-label="Frames per second"
              />
              <span>{fps} fps</span>
            </label>
          )}
          <p className="exp__hint">
            GIF and video hold the last frame a second longer. Up to 1920 px on the long side.
          </p>
        </div>

        <div className="animod__foot">
          <button
            type="button"
            className="animbtn"
            disabled={!!job}
            onClick={() => {
              useExportStore.getState().close();
              useGifStore.getState().setOpen(true);
            }}
            title="Pick a range of frames, a step, a boomerang"
          >
            Custom animation…
          </button>
          <button type="button" className="animbtn" onClick={close}>
            {job ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Saved weatherts-....png · Show in folder", after every save. */
export function ExportToast() {
  const toast = useExportStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => useExportStore.getState().dismissToast(), toast.path ? 10_000 : 6_000);
    return () => window.clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="exp-toast" role="status">
      <span className="exp-toast__text">
        {toast.path ? "Saved" : "Downloaded"} <b>{toast.name}</b>
      </span>
      {toast.path && canShowInFolder() && (
        <button type="button" className="exp-toast__btn" onClick={() => showInFolder(toast.path!)}>
          <FolderOpen size={13} /> Show in folder
        </button>
      )}
      <button type="button" className="exp-toast__x" aria-label="Dismiss" onClick={() => useExportStore.getState().dismissToast()}>
        <X size={13} />
      </button>
    </div>
  );
}
