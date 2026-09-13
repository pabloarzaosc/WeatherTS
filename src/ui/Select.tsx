import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * The app's dropdown.
 *
 * A native <select> hands its list to the operating system, which draws it in
 * its own light chrome: a white box in the middle of a dark workstation, with
 * no room for the badges and hints the rest of the UI uses. This is the same
 * control drawn by the app -- one place, so every picker matches.
 *
 * It keeps what the native element was good at: keyboard driving (arrows, Home
 * and End, Enter, Escape, type to jump) and a list that stays on screen by
 * flipping above the trigger when it would not fit below.
 */
export interface SelectOption {
  value: string;
  label: string;
  /** Small note on the right: a cycle, a count, "offline". */
  hint?: string;
  disabled?: boolean;
  /** Heading this option sits under, the way <optgroup> grouped them. */
  group?: string;
  /** Draw it as unavailable rather than merely dim. */
  tone?: "muted" | "warn";
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown when the value matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** Extra class on the trigger, for panels that size their fields. */
  className?: string;
  "aria-label"?: string;
  /** A filter box appears once the list is longer than this -- 157 radar sites
   *  are not scrollable in any useful sense. */
  searchFrom?: number;
}

const POP_MAX = 320;

export function Select({
  value,
  onChange,
  options,
  placeholder = "—",
  disabled = false,
  className = "",
  searchFrom = 14,
  ...rest
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<
    { top: number; left: number; width: number; above: boolean; max: number } | null
  >(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? null;
  const searchable = options.length > searchFrom;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q));
  }, [options, query]);

  /** Where the popup goes: under the trigger, or above it when the space below
   *  is too small -- a picker at the bottom of a panel is the common case. */
  const place = useCallback(() => {
    const el = trigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = below < Math.min(POP_MAX, 240) && r.top > below;
    setRect({
      top: above ? Math.max(8, r.top - 6) : r.bottom + 6,
      left: Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - r.width - 8)),
      width: r.width,
      above,
      // Never taller than the room it has: a list that runs off the bottom of
      // the window cannot be scrolled to its end.
      max: Math.max(140, Math.min(POP_MAX, (above ? r.top : below) - 14)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Panels scroll under the popup, so follow the trigger instead of leaving
    // the list floating where it opened.
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  // Callers build their option list inline, so it is a new array on every
  // render. Depending on it here set state, which re-rendered, which made
  // another array: React stopped the component at "maximum update depth".
  // The list and the value are read through refs instead, and the effect runs
  // only when the popup opens or closes.
  const latest = useRef({ options, value });
  latest.current = { options, value };

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const { options: opts, value: current } = latest.current;
    const i = opts.findIndex((o) => o.value === current);
    setActive(i >= 0 ? i : 0);
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  // Keep the active row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector(".uisel__opt.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    trigger.current?.focus();
  };

  const step = (delta: number) => {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + delta + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, shown.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    } else if (!searchable && e.key.length === 1) {
      // Type-ahead, the way the native control jumps to a letter.
      const letter = e.key.toLowerCase();
      const after = shown.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(letter));
      const at = after >= 0 ? after : shown.findIndex((o) => o.label.toLowerCase().startsWith(letter));
      if (at >= 0) setActive(at);
    }
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`uisel${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={rest["aria-label"]}
      >
        <span className={`uisel__value${selected ? "" : " is-empty"}`}>{selected?.label ?? placeholder}</span>
        {selected?.hint && <b className="uisel__hint">{selected.hint}</b>}
        <ChevronDown size={14} />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={pop}
            id={listId}
            className={`uisel__pop${rect.above ? " is-above" : ""}`}
            style={{
              top: rect.above ? undefined : rect.top,
              bottom: rect.above ? window.innerHeight - rect.top : undefined,
              left: rect.left,
              width: rect.width,
              maxHeight: rect.max,
            }}
            onKeyDown={onKeyDown}
          >
            {searchable && (
              <input
                className="uisel__search"
                autoFocus
                value={query}
                placeholder="Type to filter…"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                aria-label="Filter the list"
              />
            )}
            <div className="uisel__list" role="listbox" tabIndex={-1}>
              {shown.map((o, i) => {
                const head = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                return (
                  <div key={`${o.value}-${i}`}>
                    {head && <div className="uisel__group">{head}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={o.value === value}
                      disabled={o.disabled}
                      className={`uisel__opt${i === active ? " is-active" : ""}${
                        o.value === value ? " is-on" : ""
                      }${o.tone ? ` is-${o.tone}` : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(o)}
                    >
                      <Check size={12} className="uisel__check" />
                      <span>{o.label}</span>
                      {o.hint && <b>{o.hint}</b>}
                    </button>
                  </div>
                );
              })}
              {!shown.length && <div className="uisel__empty">Nothing matches that</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
