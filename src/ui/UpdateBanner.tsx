import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { notesToText, RELEASES_URL } from "../lib/releaseNotes";

interface UpdateInfo {
  version: string;
  releaseNotes: string;
  releaseName: string;
}

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "up-to-date";

const api = () => (window as any).electronAPI;

/** Bytes as MB/GB. The installer is ~285 MB, so MB is the useful unit. */
function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [rate, setRate] = useState<number | null>(null);
  const [bytes, setBytes] = useState<{ done: number; total: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showUpToDate, setShowUpToDate] = useState(false);

  useEffect(() => {
    const a = api();
    if (!a) return;

    a.onUpdateStatus((s: string) => {
      if (s === "checking") setStatus("checking");
      // "downloading" used to fall through here, so the banner stayed on the
      // "Download & install" button after the click and only switched once the
      // first progress event arrived -- which can be a long wait, or never.
      if (s === "downloading") setStatus("downloading");
      if (s === "up-to-date") {
        setStatus("up-to-date");
        setShowUpToDate(true);
        setTimeout(() => setShowUpToDate(false), 4000);
      }
    });

    a.onUpdateAvailable((updateInfo: UpdateInfo) => {
      setInfo(updateInfo);
      setStatus("available");
      setDismissed(false);
    });

    a.onUpdateProgress((p: { percent: number; bytesPerSecond?: number; transferred?: number; total?: number }) => {
      setStatus("downloading");
      setProgress(p.percent);
      setRate(p.bytesPerSecond ?? null);
      setBytes(p.transferred != null && p.total != null ? { done: p.transferred, total: p.total } : null);
    });

    a.onUpdateDownloaded(() => {
      setStatus("downloaded");
    });

    a.onUpdateError(() => {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 6000);
    });

    // Main starts its own check on a timer, which may well resolve before this
    // component exists -- that push would then reach nobody. So pull whatever
    // it already found. Optional-chained because older builds lack the channel.
    a.getPendingUpdate?.().then((pending: UpdateInfo | null) => {
      if (!pending) return;
      setInfo(pending);
      setStatus("available");
      setDismissed(false);
    });
  }, []);

  if (dismissed && status !== "downloaded") return null;

  // Compact "checking" / "up-to-date" toast
  if (status === "checking") {
    return (
      <div className="update-toast">
        <RefreshCw size={14} className="update-toast__spin" />
        <span>Checking for updates...</span>
      </div>
    );
  }

  if (showUpToDate && status === "up-to-date") {
    return (
      <div className="update-toast update-toast--ok">
        <span>You're on the latest version</span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="update-toast update-toast--err">
        <span>Update check failed</span>
      </div>
    );
  }

  // Full banner: update available
  if (status === "available" && info) {
    const notes = notesToText(info.releaseNotes || "");
    return (
      <div className="update-banner">
        <button
          type="button"
          className="update-banner__close"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
        <div className="update-banner__head">
          <Download size={16} />
          <span className="update-banner__title">
            Update available: {info.releaseName}
          </span>
        </div>
        {notes && (
          <div className="update-banner__notes">
            <div className="update-banner__notes-label">Changelog</div>
            <div className="update-banner__notes-body">{notes}</div>
          </div>
        )}
        <div className="update-banner__actions">
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={() => {
              // Switch the banner on the click rather than waiting for main to
              // echo a status back. Connecting to GitHub and getting the first
              // byte takes a moment, and a button that looks inert for that long
              // reads as broken.
              setStatus("downloading");
              setProgress(0);
              setRate(null);
              setBytes(null);
              api()?.downloadUpdate();
            }}
          >
            <Download size={13} />
            Download &amp; install
          </button>
          <button
            type="button"
            className="update-banner__btn"
            onClick={() => {
              window.open(`${RELEASES_URL}/latest`, "_blank");
            }}
          >
            <ExternalLink size={13} />
            View on GitHub
          </button>
        </div>
      </div>
    );
  }

  // Downloading. Until the first progress event lands there is no percentage to
  // show, so the bar runs indeterminate rather than sitting at a frozen 0%.
  if (status === "downloading" || (status === "available" && progress > 0)) {
    const started = progress > 0;
    return (
      <div className="update-banner">
        <div className="update-banner__head">
          <Download size={16} />
          <span className="update-banner__title">
            {started ? "Downloading update" : "Starting download…"}
          </span>
          {started && <span className="update-banner__pct">{Math.round(progress)}%</span>}
        </div>
        <div className={`update-banner__bar${started ? "" : " is-indeterminate"}`}>
          <div
            className="update-banner__bar-fill"
            style={started ? { width: `${progress}%` } : undefined}
          />
        </div>
        {started && (
          <div className="update-banner__meta">
            {bytes && (
              <span>
                {fmtSize(bytes.done)} of {fmtSize(bytes.total)}
              </span>
            )}
            {rate != null && rate > 0 && <span>{fmtSize(rate)}/s</span>}
          </div>
        )}
      </div>
    );
  }

  // Downloaded — ready to install
  if (status === "downloaded") {
    return (
      <div className="update-banner update-banner--ready">
        <div className="update-banner__head">
          <Download size={16} />
          <span className="update-banner__title">
            Update ready to install
          </span>
        </div>
        <div className="update-banner__actions">
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={() => api()?.installUpdate()}
          >
            Restart &amp; install now
          </button>
          <button
            type="button"
            className="update-banner__btn"
            onClick={() => setDismissed(true)}
          >
            Later
          </button>
        </div>
      </div>
    );
  }

  return null;
}

