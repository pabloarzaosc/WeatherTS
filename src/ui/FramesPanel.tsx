import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Download, Eye, ListVideo, MoreHorizontal, RefreshCw, Trash2, X } from "lucide-react";

import { BACKEND_BASE } from "../lib/apiConfig";
import type { NexradScan } from "../lib/nexrad";
import { cutLabel } from "../lib/radarFrames";
import { frameBytes, frameState, framesRev, subscribeFrames, type FrameState } from "../lib/radarFrameStatus";
import { useDragOffset } from "../lib/useDragOffset";
import { useAppStore } from "../store/useAppStore";
import { check as checkConnection, useConnectionStore } from "../store/useConnectionStore";
import { useFramesStore } from "../store/useFramesStore";
import {
  cachedScan,
  clearFrames,
  pollNexradNow,
  removeFrames,
  removedFrameCount,
  restoreFrames,
  scanId,
  useNexradStore,
} from "../store/useNexradStore";

/**
 * The Frames panel: every frame of the radar loop with its time and state
 * (not loaded / downloading / decoding / loaded / failed -- the same colours
 * as the line under the scrubber). A row opens its details (VCP, tilt, the
 * original file's name, size and source) and a menu: show it, download the
 * original radar file, remove it from the loop. "Clear frames" unloads every
 * frame but the one on screen and the newest; "Restore" brings them back.
 * Live loops add when the radar was last asked for new scans, when it last
 * had one, and "Fetch latest".
 */

interface FileInfo {
  name: string;
  bytes: number | null;
  source: string;
  level: string;
  partial: boolean;
  chunks?: number;
  files?: number;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hms(unix: number): string {
  const d = new Date(unix * 1000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}
function dayOf(unix: number): string {
  const d = new Date(unix * 1000);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}
function ago(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

const STATE_TEXT: Record<FrameState, string> = {
  idle: "Not loaded",
  down: "Downloading",
  decode: "Decoding",
  ready: "Loaded",
  failed: "Failed",
};

/** What the backend says the frame's original file is, once per key. */
const infoCache = new Map<string, FileInfo | string>();

async function fetchInfo(site: string, key: string): Promise<FileInfo> {
  const r = await fetch(`${BACKEND_BASE}/api/radar/file/info?site=${encodeURIComponent(site)}&key=${encodeURIComponent(key)}`);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.detail) detail = String(b.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return (await r.json()) as FileInfo;
}

/** Fetch the original file and hand it to the browser / Electron as a download. */
async function downloadFrame(site: string, key: string): Promise<string> {
  const r = await fetch(`${BACKEND_BASE}/api/radar/file?site=${encodeURIComponent(site)}&key=${encodeURIComponent(key)}`);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.detail) detail = String(b.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  const cd = r.headers.get("Content-Disposition") ?? "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? key.replace(/[^A-Za-z0-9._-]/g, "_");
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return `${name} · ${fmtBytes(blob.size)}`;
}

function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, on]);
  return now;
}

function FrameDetails({ site, product, frame }: { site: string; product: string; frame: NexradScan }) {
  const scan = cachedScan(site, product, frame.key);
  const k = `${site}|${frame.key}`;
  const [info, setInfo] = useState<FileInfo | string | undefined>(() => infoCache.get(k));
  useEffect(() => {
    if (infoCache.has(k)) {
      setInfo(infoCache.get(k));
      return;
    }
    let live = true;
    fetchInfo(site, frame.key)
      .then((i) => {
        if (!i.partial) infoCache.set(k, i);
        if (live) setInfo(i);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (live) setInfo(msg);
      });
    return () => {
      live = false;
    };
  }, [k, site, frame.key]);
  const m = scan?.meta;
  const fi = typeof info === "object" ? info : null;
  return (
    <dl className="frames__dl">
      <dt>VCP</dt>
      <dd>{m?.vcp != null ? `${m.vcp}${m.mode ? ` · ${m.mode}` : ""}` : m ? "—" : "load the frame to read it"}</dd>
      <dt>Tilt</dt>
      <dd>{m?.elevation != null ? `${m.elevation.toFixed(1)}°` : "—"}</dd>
      <dt>File</dt>
      <dd className="frames__mono" title={fi?.name ?? frame.key}>
        {fi?.name ?? (typeof info === "string" ? frame.key : "…")}
      </dd>
      <dt>Size</dt>
      <dd>
        {fi
          ? `${fmtBytes(fi.bytes)}${fi.chunks ? ` · ${fi.chunks} chunks` : ""}${fi.files && fi.files > 1 ? ` · ${fi.files} files` : ""}${fi.partial ? " so far" : ""}`
          : typeof info === "string"
            ? info
            : "…"}
      </dd>
      <dt>Source</dt>
      <dd>{fi ? `${fi.source}` : "—"}</dd>
      <dt>Frame data</dt>
      <dd>{fmtBytes(frameBytes(scanId(site, product, frame.key)))} decoded tilt</dd>
    </dl>
  );
}

function FrameMenu({
  onShow,
  onDownload,
  onRemove,
  canRemove,
  close,
}: {
  onShow: () => void;
  onDownload: () => void;
  onRemove: () => void;
  canRemove: boolean;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [close]);
  return (
    <div ref={ref} className="frames__menu" role="menu">
      <button type="button" role="menuitem" onClick={onShow}>
        <Eye size={13} /> Show this frame
      </button>
      <button type="button" role="menuitem" onClick={onDownload}>
        <Download size={13} /> Download radar file
      </button>
      <button type="button" role="menuitem" onClick={onRemove} disabled={!canRemove}>
        <Trash2 size={13} /> Remove from loop
      </button>
    </div>
  );
}

export function FramesPanel() {
  const open = useFramesStore((s) => s.open);
  const setOpen = useFramesStore((s) => s.setOpen);
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const site = useNexradStore((s) => s.site);
  const product = useNexradStore((s) => s.product);
  const scans = useNexradStore((s) => s.scans);
  const index = useNexradStore((s) => s.index);
  const tilt = useNexradStore((s) => (s.product.startsWith("L2") ? s.tilt : null));
  const rep = useNexradStore((s) => s.sailsRep);
  const archive = useNexradStore((s) => s.archiveTime !== null || !!s.archiveDate);
  const autoUpdate = useNexradStore((s) => s.autoUpdate);
  useNexradStore((s) => s.warm); // re-read the cache as frames come in
  const lastChecked = useFramesStore((s) => (s.site === site ? s.lastChecked : null));
  const lastNew = useFramesStore((s) => (s.site === site ? s.lastNew : null));
  const conn = useConnectionStore((s) => s.status);
  useSyncExternalStore(subscribeFrames, framesRev);
  const drag = useDragOffset("frames");
  const now = useNow(1000, open);

  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Newest first: the end of a live loop is what people come here for.
  const rows = useMemo(() => scans.map((f, i) => ({ f, i })).reverse(), [scans]);

  if (!open) return null;
  const removed = removedFrameCount();
  const live = !archive;

  let loaded = 0;
  let wire = 0;
  const states = new Map<string, FrameState>();
  if (site) {
    for (const { f } of rows) {
      const id = scanId(site, product, f.key);
      let st = frameState(id);
      const hit = cachedScan(site, product, f.key);
      if (st === "ready" && !hit) st = "idle"; // evicted since
      if (hit) {
        st = "ready";
        loaded++;
        wire += frameBytes(id) ?? 0;
      }
      states.set(f.key, st);
    }
  }
  const newest = scans[scans.length - 1];

  const show = (i: number) => {
    void useNexradStore.getState().showIndex(i);
    setMenu(null);
  };
  const download = (key: string) => {
    if (!site) return;
    setMenu(null);
    setBusy((b) => ({ ...b, [key]: "Downloading the radar file…" }));
    downloadFrame(site, key)
      .then((txt) => setBusy((b) => ({ ...b, [key]: `Downloaded ${txt}` })))
      .catch((e: unknown) => setBusy((b) => ({ ...b, [key]: `Download failed: ${e instanceof Error ? e.message : String(e)}` })));
  };
  const remove = (key: string) => {
    setMenu(null);
    if (selected === key) setSelected(null);
    removeFrames([key]);
  };
  const fetchLatest = () => {
    if (useConnectionStore.getState().status === "offline") {
      // The poll skips while offline; ask whether it is back instead.
      setNote("Offline: checking the connection");
      void checkConnection(true);
      return;
    }
    setFetching(true);
    setNote(null);
    const before = useNexradStore.getState().scans.at(-1)?.key;
    pollNexradNow()
      .then(() => {
        const after = useNexradStore.getState().scans.at(-1)?.key;
        setNote(after && after !== before ? "New scan added" : "No newer scan yet");
      })
      .finally(() => setFetching(false));
  };

  return (
    <div ref={drag.ref} className={`frames${drag.dragging ? " is-dragging" : ""}`} style={drag.style} role="dialog" aria-label="Frames">
      <div className="frames__head" {...drag.handle}>
        <ListVideo size={14} />
        <b>Frames</b>
        <span className="frames__sub">
          {site ? `${site} · ${scans.length} frame${scans.length === 1 ? "" : "s"} · ${loaded} loaded${wire ? ` · ${fmtBytes(wire)}` : ""}` : "No radar"}
        </span>
        <button type="button" className="frames__x" onClick={() => setOpen(false)} title="Close">
          <X size={14} />
        </button>
      </div>

      {site && live && (
        <div className="frames__live">
          <div className="frames__livetext">
            <span>
              Newest scan <b>{newest ? `${hms(newest.time)}` : "—"}</b>
              {newest ? ` · ${ago(newest.time * 1000, now)}` : ""}
            </span>
            <span>
              Last found new data <b>{lastNew ? ago(lastNew, now) : "not yet"}</b> · checked {ago(lastChecked, now)}
              {!autoUpdate ? " · auto update off" : ""}
              {conn === "offline" ? " · offline" : ""}
            </span>
            {note && <span className="frames__note">{note}</span>}
          </div>
          <button type="button" className="frames__btn" onClick={fetchLatest} disabled={fetching} title="Ask the radar feed for new scans now">
            <RefreshCw size={13} className={fetching ? "is-spinning" : ""} />
            {fetching ? "Fetching…" : "Fetch latest"}
          </button>
        </div>
      )}
      {site && !live && <div className="frames__live frames__live--archive">Archive loop · the scans don't change</div>}

      <div className="frames__list" role="list">
        {!site || !radarOn ? (
          <div className="frames__empty">Turn the radar on to see its loop.</div>
        ) : rows.length === 0 ? (
          <div className="frames__empty">No frames yet.</div>
        ) : (
          rows.map(({ f, i }) => {
            const st = states.get(f.key) ?? "idle";
            const isSel = selected === f.key;
            const cut = cutLabel(f, tilt, rep);
            const multiDay = scans.length > 1 && dayOf(scans[0].time) !== dayOf(scans[scans.length - 1].time);
            return (
              <div key={f.key} className={`frames__row${isSel ? " is-open" : ""}${i === index ? " is-shown" : ""}`} role="listitem">
                <div className="frames__line">
                  <button
                    type="button"
                    className="frames__main"
                    onClick={() => setSelected(isSel ? null : f.key)}
                    onDoubleClick={() => show(i)}
                    aria-expanded={isSel}
                    title="Details (double-click: show this frame)"
                  >
                    <span className={`frames__dot is-${f.partial ? "partial" : st}`} aria-hidden="true" />
                    <span className="frames__time">
                      {multiDay && <small>{dayOf(f.time)} </small>}
                      {hms(f.time)}
                    </span>
                    <span className="frames__tags">
                      {cut && <span className="frames__tag">{cut}</span>}
                      {f.partial && <span className="frames__tag is-partial">scanning</span>}
                    </span>
                    <span className={`frames__state is-${st}${i === index ? " is-shown" : ""}`}>
                      {i === index && st === "ready" ? "On screen" : STATE_TEXT[st]}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="frames__more"
                    onClick={() => setMenu(menu === f.key ? null : f.key)}
                    title="Frame menu"
                    aria-haspopup="menu"
                    aria-expanded={menu === f.key}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {menu === f.key && (
                    <FrameMenu
                      onShow={() => show(i)}
                      onDownload={() => download(f.key)}
                      onRemove={() => remove(f.key)}
                      canRemove={scans.length > 1}
                      close={() => setMenu(null)}
                    />
                  )}
                </div>
                {busy[f.key] && <div className="frames__busy">{busy[f.key]}</div>}
                {isSel && site && <FrameDetails site={site} product={product} frame={f} />}
              </div>
            );
          })
        )}
      </div>

      <div className="frames__foot">
        <button
          type="button"
          className="frames__btn"
          onClick={() => {
            const n = clearFrames();
            setNote(n ? `Cleared ${n} frame${n === 1 ? "" : "s"}` : null);
          }}
          disabled={!site || scans.length < 3}
          title="Unload every frame but the one on screen and the newest"
        >
          <Trash2 size={13} /> Clear frames
        </button>
        {removed > 0 && (
          <span className="frames__removed">
            {removed} removed
            <button type="button" className="frames__link" onClick={() => restoreFrames()}>
              Restore
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** A row in the Radar panel that opens the Frames panel. */
export function FramesButton() {
  const toggle = useFramesStore((s) => s.toggle);
  const open = useFramesStore((s) => s.open);
  const n = useNexradStore((s) => s.scans.length);
  return (
    <div className="sfcobs__toggle-row">
      <span>
        Frames
        <small style={{ color: "var(--text-faint)", marginLeft: 6 }}>
          {n} in the loop
        </small>
      </span>
      <button type="button" className={`frames__open${open ? " is-on" : ""}`} onClick={toggle} aria-pressed={open}>
        {open ? "Close" : "Open"}
      </button>
    </div>
  );
}
