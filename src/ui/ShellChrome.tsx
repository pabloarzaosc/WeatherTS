import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Maximize2, Pause, Play, Tv, X } from "lucide-react";

import { useShellStore } from "../store/useShellStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { useFeature } from "../store/useFeatureStore";
import { PRODUCT_KEYS } from "../lib/radarKeys";
import { BrandMark } from "./BrandMark";
import { useAppStore } from "../store/useAppStore";
import { basemapInfo } from "../map/basemaps";

/**
 * The shell around the map (ux-shell): the bar that comes back at the top
 * edge in minimal UI and broadcast mode, the broadcast logo, and the keyboard
 * shortcut list ("?"). Rendered once, outside the HUD, so the CSS that hides
 * the HUD in those modes never hides these.
 */
export function ShellChrome() {
  return (
    <>
      <TopEdgeBar />
      <BroadcastLogo />
      <ShortcutsOverlay />
    </>
  );
}

/** How close to the top edge the pointer has to come, and how long the bar
 *  stays after it leaves. */
const EDGE_PX = 6;
const LINGER_MS = 1400;

function TopEdgeBar() {
  const mode = useShellStore((s) => s.mode);
  const playing = useTimelineStore((s) => s.playing);
  const broadcastOn = useFeature("broadcast");
  const [shown, setShown] = useState(false);
  const bar = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    setShown(false);
    if (mode === "normal") return;
    const onMove = (e: PointerEvent) => {
      const over = !!bar.current && bar.current.contains(e.target as Node);
      if (e.clientY <= EDGE_PX || over) {
        window.clearTimeout(timer.current);
        timer.current = 0;
        setShown(true);
      } else if (!timer.current) {
        timer.current = window.setTimeout(() => {
          timer.current = 0;
          setShown(false);
        }, LINGER_MS);
      }
    };
    // Leaving the window over the top edge counts as reaching it.
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget && e.clientY <= EDGE_PX) setShown(true);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      window.clearTimeout(timer.current);
      timer.current = 0;
    };
  }, [mode]);

  if (mode === "normal") return null;
  const shell = useShellStore.getState();
  return (
    <div
      ref={bar}
      className={`shellbar${shown ? " is-shown" : ""}`}
      role="toolbar"
      aria-label={mode === "broadcast" ? "Broadcast mode" : "Minimal UI"}
    >
      {mode === "minimal" ? (
        <>
          <button
            type="button"
            className="shellbar__btn"
            onClick={() => window.dispatchEvent(new CustomEvent("weatherts:toggle-play"))}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <span className="shellbar__sep" />
          <button type="button" className="shellbar__btn shellbar__btn--wide" onClick={() => shell.setMode("normal")}>
            <Maximize2 size={14} />
            <span>Show the interface</span>
            <kbd>Ctrl</kbd>
            <kbd>\</kbd>
          </button>
          {broadcastOn && (
            <button type="button" className="shellbar__btn shellbar__btn--wide" onClick={() => shell.setMode("broadcast")}>
              <Tv size={14} />
              <span>Broadcast mode</span>
            </button>
          )}
        </>
      ) : (
        <button type="button" className="shellbar__btn shellbar__btn--wide" onClick={() => shell.setMode("normal")}>
          <X size={14} />
          <span>Leave broadcast mode</span>
          <kbd>Ctrl</kbd>
          <kbd>\</kbd>
        </button>
      )}
      <button
        type="button"
        className="shellbar__btn"
        onClick={() => shell.setShortcutsOpen(true)}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        <Keyboard size={14} />
      </button>
    </div>
  );
}

/** The right-click menu's way in and out: "Broadcast mode" from the full
 *  interface, "Leave broadcast mode" / "Show the interface" from the others. */
export function ShellMenuItem({ onDone }: { onDone: () => void }) {
  const mode = useShellStore((s) => s.mode);
  const broadcastOn = useFeature("broadcast");
  if (mode === "normal" && !broadcastOn) return null;
  const next = mode === "normal" ? "broadcast" : "normal";
  return (
    <button
      type="button"
      className="mapmenu__item"
      onClick={() => {
        useShellStore.getState().setMode(next);
        onDone();
      }}
    >
      {mode === "normal" ? <Tv size={15} /> : mode === "broadcast" ? <X size={15} /> : <Maximize2 size={15} />}
      {mode === "normal" ? "Broadcast mode" : mode === "broadcast" ? "Leave broadcast mode" : "Show the interface"}
      {mode !== "normal" && <span className="mapmenu__hint">Ctrl+\</span>}
    </button>
  );
}

/** The broadcast logo, and in both modes the basemap credit the hidden
 *  status bar used to carry. */
function BroadcastLogo() {
  const mode = useShellStore((s) => s.mode);
  const basemapId = useAppStore((s) => s.basemapId);
  if (mode === "normal") return null;
  const credit = basemapInfo(basemapId).attribution;
  return (
    <div className={`bcast-corner bcast-corner--${mode}`} aria-hidden="true">
      {mode === "broadcast" && (
        <div className="bcast-logo">
          <BrandMark size={34} />
          <span>WeatherTS</span>
        </div>
      )}
      {credit && <small className="bcast-credit">{credit}</small>}
    </div>
  );
}

// ------------------------------------------------------------- shortcuts ---

type Keys = string[];
interface Group {
  title: string;
  rows: [Keys, ReactNode][];
}

const KEY_GROUPS: Group[] = [
  {
    title: "Loop",
    rows: [
      [["Space"], "Play or pause"],
      [["←", "→"], "Previous / next frame"],
    ],
  },
  {
    title: "Tilts and panes",
    rows: [
      [["↑", "↓"], "Tilt up / down in the focused pane"],
      [["Shift", "↑", "↓"], "Tilt up / down in every pane"],
      [["1", "…", "6"], "Focus pane A to F"],
    ],
  },
  {
    title: "Display",
    rows: [
      [["T"], "Trail: the strongest value of the loop, focused pane"],
      [["]", "["], "Next / previous colour table"],
      [["Shift"], "Hold over the radar: the full readout"],
    ],
  },
  {
    title: "App",
    rows: [
      [["/"], "Search a place"],
      [["Ctrl", "\\"], "Minimal UI on / off; leaves broadcast mode"],
      [["?"], "This list"],
      [["Esc"], "Close a card or panel, cancel a tool"],
    ],
  },
  {
    title: "While a tool is open",
    rows: [
      [["P", "L", "A", "C", "R", "T", "E"], "Draw: pen, line, arrow, circle, rectangle, text, eraser"],
      [["Ctrl", "Z"], "Undo (Draw, colour table editor)"],
      [["Ctrl", "Y"], "Redo"],
      [["←", "→"], "Colour table editor: move the stop (Shift: ten steps)"],
      [["Delete"], "Colour table editor: remove the stop"],
      [["←", "→"], "Compare divider, when focused: move it (Shift: further)"],
    ],
  },
];

function KeyCaps({ keys }: { keys: Keys }) {
  return (
    <span className="kbdlist__keys">
      {keys.map((k, i) =>
        k === "…" ? (
          <span key={i} className="kbdlist__to">
            to
          </span>
        ) : (
          <kbd key={i}>{k}</kbd>
        ),
      )}
    </span>
  );
}

function ShortcutsOverlay() {
  const open = useShellStore((s) => s.shortcutsOpen);
  const close = () => useShellStore.getState().setShortcutsOpen(false);
  const card = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) card.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="kbdlist" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="kbdlist__scrim" onClick={close} />
      <div className="kbdlist__card" ref={card} tabIndex={-1}>
        <header className="kbdlist__head">
          <Keyboard size={15} />
          <strong>Keyboard shortcuts</strong>
          <span className="kbdlist__note">Ignored while you type in a field.</span>
          <button type="button" className="kbdlist__x" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <div className="kbdlist__body">
          <section className="kbdlist__group kbdlist__group--products">
            <h4>Radar products · focused pane</h4>
            <ul className="kbdlist__grid">
              {PRODUCT_KEYS.map((k) => (
                <li key={k.key}>
                  <kbd>{k.key}</kbd>
                  <span>{k.name}</span>
                </li>
              ))}
            </ul>
          </section>
          {KEY_GROUPS.map((g) => (
            <section key={g.title} className="kbdlist__group">
              <h4>{g.title}</h4>
              <ul>
                {g.rows.map(([keys, what], i) => (
                  <li key={i}>
                    <KeyCaps keys={keys} />
                    <span>{what}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
