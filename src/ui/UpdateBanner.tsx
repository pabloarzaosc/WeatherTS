import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";

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

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showUpToDate, setShowUpToDate] = useState(false);

  useEffect(() => {
    const a = api();
    if (!a) return;

    a.onUpdateStatus((s: string) => {
      if (s === "checking") setStatus("checking");
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

    a.onUpdateProgress((p: { percent: number }) => {
      setProgress(p.percent);
    });

    a.onUpdateDownloaded(() => {
      setStatus("downloaded");
    });

    a.onUpdateError(() => {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 6000);
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
        {info.releaseNotes && (
          <div className="update-banner__notes">
            <div className="update-banner__notes-label">Changelog</div>
            <div className="update-banner__notes-body">
              {info.releaseNotes}
            </div>
          </div>
        )}
        <div className="update-banner__actions">
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={() => api()?.downloadUpdate()}
          >
            <Download size={13} />
            Download &amp; install
          </button>
          <button
            type="button"
            className="update-banner__btn"
            onClick={() => {
              window.open(
                `https://github.com/pabloarzaosc/WeatherTS/releases/latest`,
                "_blank"
              );
            }}
          >
            <ExternalLink size={13} />
            View on GitHub
          </button>
        </div>
      </div>
    );
  }

  // Downloading progress
  if (status === "downloading" || (status === "available" && progress > 0)) {
    return (
      <div className="update-banner">
        <div className="update-banner__head">
          <Download size={16} />
          <span className="update-banner__title">
            Downloading update...
          </span>
          <span className="update-banner__pct">{Math.round(progress)}%</span>
        </div>
        <div className="update-banner__bar">
          <div
            className="update-banner__bar-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
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
