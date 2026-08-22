import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { useNexradStore } from "../../store/useNexradStore";
import { useVwpStore } from "../../store/useVwpStore";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";
import {
  KEY_PARAMS,
  fetchStationParams,
  fmtParam,
  mapLimit,
  uploadSounding,
  type ProfileResult,
} from "../../lib/soundingTools";

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  wmo?: string;
}

function Err({ msg }: { msg: string }) {
  return (
    <div className="sfcobs__error" role="alert">
      <AlertTriangle size={14} />
      <span>{msg}</span>
    </div>
  );
}

function zulu(unix: number | null): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}Z`;
}

/** A column per profile, a row per parameter. */
function ParamTable({ results }: { results: ProfileResult[] }) {
  return (
    <div className="sndtool__table">
      <table>
        <thead>
          <tr>
            <th />
            {results.map((r, i) => (
              <th key={i}>
                {r.label}
                <small>{zulu(r.validUnix)}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KEY_PARAMS.map((p) => (
            <tr key={p.key}>
              <th>
                {p.label}
                {p.unit && <small>{p.unit}</small>}
              </th>
              {results.map((r, i) => (
                <td key={i}>{fmtParam(r.params[p.key] as number, p.digits ?? 1)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useJob() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Up to four stations, their parameters side by side. */
export function CompareTab({
  findStation,
}: {
  findStation: (s: string) => Station | undefined;
}) {
  const [ids, setIds] = useState(["", "", "", ""]);
  const [results, setResults] = useState<ProfileResult[]>([]);
  const { busy, error, run } = useJob();

  const go = () =>
    void run(async () => {
      const typed = ids.map((s) => s.trim()).filter(Boolean);
      const missing = typed.filter((s) => !findStation(s));
      if (missing.length) throw new Error(`Unknown station: ${missing.join(", ")}`);
      const list = typed.map((s) => findStation(s)!) as Station[];
      if (list.length < 2) throw new Error("Enter at least two stations.");
      setResults(await mapLimit(list, 3, (s) => fetchStationParams(s)));
    });

  return (
    <>
      <div className="sfcobs__section">Compare stations</div>
      {ids.map((v, i) => (
        <label className="snd-inputlabel" key={i}>
          #{i + 1}
          <input
            value={v}
            placeholder={i < 2 ? "Station id" : "optional"}
            onChange={(e) =>
              setIds(ids.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)))
            }
          />
        </label>
      ))}
      <button type="button" className="snd-primary" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : null} Compare profiles
      </button>
      {error && <Err msg={error} />}
      {results.length > 0 && <ParamTable results={results} />}
    </>
  );
}

/** One station across the observed window, so a trend is visible. */
export function TrendsTab({
  station,
  findStation,
}: {
  station: string;
  findStation: (s: string) => Station | undefined;
}) {
  const [results, setResults] = useState<ProfileResult[]>([]);
  const { busy, error, run } = useJob();

  const go = () =>
    void run(async () => {
      const hit = findStation(station);
      if (!hit) throw new Error(`Unknown station ${station}.`);
      // Ask for the newest first: its response carries the axis, which is how
      // many observations this station actually has. Assuming a fixed eight
      // was wrong the moment the axis stopped being fixed.
      const newest = await fetchStationParams(hit);
      const n = Math.min(newest.axisLength ?? 1, 12);
      const hours = Array.from({ length: n }, (_, i) => n - 1 - i);
      const all = await mapLimit(hours, 3, async (h) => {
        try {
          return await fetchStationParams(hit, h);
        } catch {
          // A cycle the station skipped is a gap in the trend, not a failure.
          return null;
        }
      });
      const got = all.filter(Boolean) as ProfileResult[];
      if (!got.length) throw new Error(`No observations for ${hit.id} in the window.`);
      setResults(got);
    });

  return (
    <>
      <div className="sfcobs__section">Trend across the observed window</div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          {station || "—"} · the last eight 00Z/12Z cycles, newest first.
        </span>
      </div>
      <button type="button" className="snd-primary" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : null} Load trend
      </button>
      {error && <Err msg={error} />}
      {results.length > 0 && <ParamTable results={results} />}
    </>
  );
}

/** Rank a bounded set of stations by how favourable they look right now. */
export function RiskTab({ stations }: { stations: Station[] }) {
  const [results, setResults] = useState<{ s: Station; r: ProfileResult }[]>([]);
  const [progress, setProgress] = useState("");
  const { busy, error, run } = useJob();

  const go = () =>
    void run(async () => {
      // Bounded on purpose: one request per station, and the useful answer is
      // which of the plains sites look best, not all 922 of them.
      const pool = stations
        .filter((s) => s.lat > 25 && s.lat < 50 && s.lon > -105 && s.lon < -80)
        .slice(0, 24);
      if (!pool.length) throw new Error("No stations in the scan area.");
      let done = 0;
      const out = await mapLimit(pool, 4, async (s) => {
        try {
          const r = await fetchStationParams(s, 9999, undefined, false);
          return { s, r };
        } catch {
          return null;
        } finally {
          done += 1;
          setProgress(`${done}/${pool.length}`);
        }
      });
      const ok = (out.filter(Boolean) as { s: Station; r: ProfileResult }[]).sort(
        (a, b) => Number(b.r.params.stp_eff ?? 0) - Number(a.r.params.stp_eff ?? 0),
      );
      if (!ok.length) throw new Error("No station in the scan area reported.");
      setResults(ok);
    });

  return (
    <>
      <div className="sfcobs__section">Severe risk scan</div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          The latest observation at up to 24 central-US sites, ranked by
          effective-layer STP. {busy && progress}
        </span>
      </div>
      <button type="button" className="snd-primary" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : null} Scan
      </button>
      {error && <Err msg={error} />}
      {results.length > 0 && (
        <div className="sndtool__rank">
          {results.map(({ s, r }) => (
            <button
              key={s.id}
              type="button"
              className="sndtool__rankrow"
              onClick={() => useSoundingViewerStore.getState().openRaob(s)}
            >
              <b>{s.id}</b>
              <span>{s.name}</span>
              <i>
                STP {fmtParam(r.params.stp_eff as number, 1)} · SCP{" "}
                {fmtParam(r.params.scp as number, 1)} · MLCAPE{" "}
                {fmtParam(r.params.mlcape as number, 0)}
              </i>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Paste a sounding, get it through the same SHARPpy pipeline. */
export function UploadTab() {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const { busy, error, run } = useJob();

  const go = () =>
    void run(async () => {
      const r = await uploadSounding(text, title);
      setResult(r);
      setImage(r.image);
    });

  return (
    <>
      <div className="sfcobs__section">Paste a sounding</div>
      <label className="snd-inputlabel">
        Title
        <input value={title} placeholder="Optional" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <textarea
        className="sndtool__paste"
        value={text}
        placeholder="One level per line: pressure height temp dewpoint wind-dir wind-speed. A SHARPpy %RAW% block works too."
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className="snd-primary" onClick={go} disabled={busy || !text.trim()}>
        {busy ? <Loader2 size={14} className="spin" /> : null} Analyze paste
      </button>
      {error && <Err msg={error} />}
      {result && (
        <>
          <div className="sfcobs__row">
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
              {result.levels} levels read
            </span>
          </div>
          <ParamTable results={[result]} />
          {image && (
            <img
              className="sndtool__img"
              src={`data:image/png;base64,${image}`}
              alt="Uploaded sounding"
            />
          )}
        </>
      )}
    </>
  );
}

/** The radar's own wind profile, which the app already fetches. */
export function VwpTab() {
  const site = useNexradStore((s) => s.site);
  const vwpOpen = useVwpStore((s) => s.open);
  const setVwpOpen = useVwpStore((s) => s.setOpen);

  return (
    <>
      <div className="sfcobs__section">VAD wind profile</div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          {site
            ? `The wind profile ${site} is measuring, from its own velocity data.`
            : "Pick a radar site first — the VWP comes from the radar, not from a sounding."}
        </span>
      </div>
      <button
        type="button"
        className="snd-primary"
        disabled={!site}
        onClick={() => (vwpOpen ? setVwpOpen(false) : setVwpOpen(true, site ?? undefined))}
      >
        {vwpOpen ? "Hide" : "Show"} VWP for {site ?? "—"}
      </button>
    </>
  );
}
