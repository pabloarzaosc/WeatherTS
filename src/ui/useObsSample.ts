import { useEffect, useRef, useState } from "react";

import { fetchObsValue } from "../lib/observations";
import { useAppStore } from "../store/useAppStore";
import { selectObsFrame, useObsStore } from "../store/useObsStore";

/**
 * The analysed value under the pointer.
 *
 * The grid lives on the server -- the map only ever sees a picture of it -- so
 * the number is asked for rather than read locally. The ask is cheap (the
 * server keeps the decoded field and answers from memory in a millisecond) but
 * a mouse move is not: the request is held back until the pointer settles, and
 * the one in flight is dropped the moment it moves again.
 */
const SETTLE_MS = 110;

export interface ObsSample {
  /** "91 °F" — the value with its unit, ready to print. */
  text: string;
  /** Which product it is, for the second line. */
  label: string;
  /** The wind and the contoured variable at the same point, when drawn. */
  extra: string | null;
}

export function useObsSample(): ObsSample | null {
  const visible = useAppStore((s) => s.layers["observations"]?.visible ?? false);
  const cursor = useAppStore((s) => s.cursor);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const frame = useObsStore(selectObsFrame);
  const busy = useObsStore((s) => s.busy);

  const [sample, setSample] = useState<ObsSample | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // A new product, source or hour clears the card at once. Kept until the next
  // answer, the previous one sat under the pointer labelled "Significant
  // Tornado Parameter" while the panel said 2m Temperature.
  useEffect(() => {
    ctrl.current?.abort();
    setSample(null);
  }, [source, field, frame?.key]);

  useEffect(() => {
    // While the frame is still being drawn there is nothing to read yet; the
    // server answers "pending" rather than downloading for a pointer move.
    if (!visible || !cursor || !frame || busy) {
      if (!visible || !cursor || !frame) setSample(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      ctrl.current?.abort();
      const mine = new AbortController();
      ctrl.current = mine;
      try {
        const out = await fetchObsValue(
          { source, field, key: frame.key, lat: cursor.lat, lon: cursor.lng },
          mine.signal,
        );
        if (mine.signal.aborted) return;
        if (out.key !== frame.key || out.field !== field) return;
        setSample(
          out.value == null
            ? null
            : {
                text: out.text ?? `${Math.round(out.value)}${out.unit ? ` ${out.unit}` : ""}`,
                label: out.label,
                extra: out.extra,
              },
        );
      } catch {
        // A dropped probe is not worth a message; the next move asks again.
        if (!mine.signal.aborted) setSample(null);
      }
    }, SETTLE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [visible, cursor, source, field, frame, busy]);

  useEffect(() => () => ctrl.current?.abort(), []);

  return visible ? sample : null;
}
