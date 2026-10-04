import { useEffect, useRef, useState } from "react";

import { PLAY_SPEEDS, speedLabel } from "../lib/playSpeeds";

/** One click away: the speeds people reach for. */
const QUICK = [1, 2, 5, 10, 20, 40, 80];

/**
 * The timeline's speed control. The button shows the speed and opens a slider
 * over every step from 1x to 80x, with the usual ones as chips under it. The
 * wheel over the button moves one step without opening anything -- the quick
 * way to nudge a loop that is already playing.
 *
 * It replaced a button that cycled through seven speeds: thirty steps by
 * clicking round would have been a chore.
 */
export function SpeedPicker({
  speed,
  onChange,
  disabled,
}: {
  speed: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const at = Math.max(0, PLAY_SPEEDS.indexOf(speed));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // A quick scroll sends several wheel events before the next render: step from
  // the last speed asked for, not the one on screen, or notches are lost.
  const latest = useRef(speed);
  latest.current = speed;
  const nudge = (d: number) => {
    const i = Math.max(0, PLAY_SPEEDS.indexOf(latest.current));
    latest.current = PLAY_SPEEDS[Math.min(PLAY_SPEEDS.length - 1, Math.max(0, i + d))];
    onChange(latest.current);
  };

  return (
    <div className="speedpick" ref={root}>
      <button
        type="button"
        className={`maptimeline__speed${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        onWheel={(e) => {
          if (!disabled) nudge(e.deltaY < 0 ? 1 : -1);
        }}
        disabled={disabled}
        title="Playback speed (scroll to change)"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {speedLabel(speed)}
      </button>

      {open && (
        <div className="speedpick__pop" role="dialog" aria-label="Playback speed">
          <div className="speedpick__head">
            <span>Playback speed</span>
            <b>{speedLabel(speed)}</b>
          </div>
          <input
            type="range"
            className="speedpick__range"
            min={0}
            max={PLAY_SPEEDS.length - 1}
            step={1}
            value={at}
            onChange={(e) => onChange(PLAY_SPEEDS[Number(e.target.value)])}
            aria-label="Playback speed"
            aria-valuetext={speedLabel(speed)}
            autoFocus
          />
          <div className="speedpick__scale">
            <span>{speedLabel(PLAY_SPEEDS[0])}</span>
            <span>{speedLabel(PLAY_SPEEDS[PLAY_SPEEDS.length - 1])}</span>
          </div>
          <div className="speedpick__quick">
            {QUICK.map((v) => (
              <button
                key={v}
                type="button"
                className={`speedpick__chip${v === speed ? " is-on" : ""}`}
                onClick={() => onChange(v)}
              >
                {speedLabel(v)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
