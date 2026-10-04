import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { GLM_WINDOWS, useGlmStore } from "../../store/useGlmStore";
import { GLM_AGES, GLM_SATS } from "../../lib/glm";
import { LayerPower } from "../LayerPower";

const LAYER = "glm";

function hms(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

function age(s: number): string {
  if (s < 90) return `${Math.max(0, Math.round(s))} s`;
  return `${Math.round(s / 60)} min`;
}

/** The lightning panel: how much is flashing, over what window, from which
 *  satellite, and what the colours mean. */
export function LightningView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const sat = useGlmStore((s) => s.sat);
  const setSat = useGlmStore((s) => s.setSat);
  const minutes = useGlmStore((s) => s.minutes);
  const setMinutes = useGlmStore((s) => s.setMinutes);
  const data = useGlmStore((s) => s.data);
  const busy = useGlmStore((s) => s.busy);
  const error = useGlmStore((s) => s.error);
  const atUnix = useGlmStore((s) => s.atUnix);

  // Ages count from the window's end; live, that end is the moment it was
  // asked for, so the newest flash ages between refreshes.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!enabled || atUnix != null) return;
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, [enabled, atUnix]);

  const stats = useMemo(() => {
    if (!data || data.count === 0) return { lastMin: 0, newest: null as number | null };
    let lastMin = 0;
    let newest = Infinity;
    for (let i = 0; i < data.count; i++) {
      const a = data.values[i * 4 + 2];
      if (a < 60) lastMin += 1;
      if (a < newest) newest = a;
    }
    return { lastMin, newest };
  }, [data]);

  const info = data?.info;
  const drift = info && info.live ? Math.max(0, now - info.end) : 0;
  const status = !info
    ? busy
      ? "Loading…"
      : ""
    : info.live
      ? info.latest
        ? `Live · NOAA's files reach ${hms(info.latest)}`
        : "Live"
      : `Ending at the frame on the timeline · ${hms(info.end)}`;

  return (
    <div className="sfcobs lsrv glmv">
      <LayerPower
        label="Lightning (GLM)"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" className="sfcobs__retry" onClick={() => void useGlmStore.getState().load()}>
            Retry
          </button>
        </div>
      )}

      <div className="lsrv__tiles glmv__tiles">
        <div className={`lsrv__tile glmv__tile${data?.count ? "" : " is-empty"}`}>
          <span className="glmv__label">Flashes</span>
          <b>{data ? data.count.toLocaleString("en-US") : "–"}</b>
          <small>last {minutes} min</small>
        </div>
        <div className={`lsrv__tile glmv__tile${stats.lastMin ? "" : " is-empty"}`}>
          <span className="glmv__label">Last minute</span>
          <b>{data ? stats.lastMin.toLocaleString("en-US") : "–"}</b>
          <small>flashes</small>
        </div>
        <div className={`lsrv__tile glmv__tile${stats.newest != null ? "" : " is-empty"}`}>
          <span className="glmv__label">Newest</span>
          <b>{stats.newest != null ? age(stats.newest + drift) : "–"}</b>
          <small>ago</small>
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Window</span>
          <em>{status}</em>
        </div>
        <div className="lsrv__seg" role="group" aria-label="Time window">
          {GLM_WINDOWS.map((m) => (
            <button
              key={m}
              type="button"
              className={minutes === m ? "is-on" : ""}
              onClick={() => setMinutes(m)}
              aria-pressed={minutes === m}
              title={`Flashes of the last ${m} minutes`}
            >
              {m} min
            </button>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Satellite</span>
          <em>{info && info.pending > 0 ? `downloading ${info.pending} of ${info.files} files` : ""}</em>
        </div>
        <div className="lsrv__seg lsrv__seg--sev" role="group" aria-label="Satellite">
          {GLM_SATS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={sat === s.id ? "is-on" : ""}
              onClick={() => setSat(s.id)}
              aria-pressed={sat === s.id}
              title={s.title}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Age</span>
        </div>
        <div className="glmv__key" aria-label="Colour by age">
          {GLM_AGES.map((a) => (
            <span key={a.label} className="glmv__keyitem">
              <i style={{ background: a.color }} />
              {a.label}
            </span>
          ))}
        </div>
      </div>

      <p className="glmv__note">
        Every flash, in-cloud and cloud-to-ground, seen from orbit by the GOES lightning mappers: GOES-East over the
        Americas and the Atlantic, GOES-West over the Pacific to Hawaii. NOAA publishes them about 25 seconds after they
        happen.
      </p>
    </div>
  );
}
