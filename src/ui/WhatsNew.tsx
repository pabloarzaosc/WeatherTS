import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";

import {
  fetchReleases,
  RELEASES_URL,
  type ReleaseEntry,
} from "../lib/releaseNotes";
import {
  getSeenVersion,
  markVersionSeen,
  quickStartDone,
  useOnboardingStore,
} from "../store/useOnboardingStore";
import { appVersion as runningVersion } from "../lib/appVersion";


function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The release log. Reads the same GitHub releases the updater installs from,
 * so there is no hand-kept changelog in the app to fall out of step.
 */
export function WhatsNew() {
  const open = useOnboardingStore((s) => s.whatsNewOpen);
  const close = useOnboardingStore((s) => s.closeWhatsNew);

  const [releases, setReleases] = useState<ReleaseEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Volunteer itself once per version, so the log is seen after an update
  // without having to go looking for it. Held back while Quick Start is still
  // pending: a first-run user should not meet two panels at once.
  useEffect(() => {
    let cancelled = false;
    void runningVersion()
      .then((v) => {
        if (cancelled || !v) return;
        setAppVersion(v);
        if (getSeenVersion() !== v && quickStartDone()) {
          useOnboardingStore.getState().openWhatsNew();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setError(null);
    setReleases(null);
    fetchReleases(ac.signal)
      .then((list) => {
        setReleases(list);
        setSelected((prev) => prev ?? list[0]?.version ?? null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [open, reloadKey]);

  // Closing counts as having read it, so the panel stops volunteering itself
  // until the next version arrives.
  useEffect(() => {
    if (open || !appVersion) return;
    markVersionSeen(appVersion);
  }, [open, appVersion]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const current = useMemo(
    () => releases?.find((r) => r.version === selected) ?? releases?.[0] ?? null,
    [releases, selected],
  );

  if (!open) return null;

  return (
    <div className="wn" role="dialog" aria-modal="true" aria-label="What's New">
      <div className="wn__scrim" onClick={close} />
      <div className="wn__panel">
        <header className="wn__top">
          <div className="wn__title">
            <span className="wn__kicker">Release log</span>
            <h2>What&rsquo;s New</h2>
          </div>
          {appVersion && <span className="wn__badge">running {appVersion}</span>}
          <button type="button" className="wn__close" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </header>

        {error && (
          <div className="wn__state">
            <p>Could not reach the release log.</p>
            <span>{error}</span>
            <button type="button" className="wn__btn" onClick={() => setReloadKey((k) => k + 1)}>
              <RefreshCw size={13} /> Try again
            </button>
          </div>
        )}

        {!error && !releases && (
          <div className="wn__state">
            <p>Loading releases…</p>
          </div>
        )}

        {!error && releases && releases.length === 0 && (
          <div className="wn__state">
            <p>No published releases yet.</p>
          </div>
        )}

        {!error && releases && releases.length > 0 && (
          <div className="wn__body">
            <nav className="wn__index" aria-label="Versions">
              {releases.map((r) => (
                <button
                  key={r.version}
                  type="button"
                  className={`wn__ver${current?.version === r.version ? " is-on" : ""}`}
                  onClick={() => setSelected(r.version)}
                >
                  <b>{r.version}</b>
                  <span>{formatDate(r.published)}</span>
                  {appVersion === r.version && <i className="wn__dot" title="Installed" />}
                </button>
              ))}
            </nav>

            <article className="wn__notes">
              {current && (
                <>
                  <div className="wn__notes-head">
                    <h3>{current.title}</h3>
                    <span>
                      {formatDate(current.published)}
                      {appVersion === current.version ? " · installed" : ""}
                    </span>
                  </div>
                  <div className="wn__notes-body">
                    {current.notes || "No notes were published for this release."}
                  </div>
                  <a className="wn__btn wn__btn--link" href={current.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} /> Open on GitHub
                  </a>
                </>
              )}
            </article>
          </div>
        )}

        <footer className="wn__foot">
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            All releases
          </a>
          <button type="button" className="wn__btn wn__btn--primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
