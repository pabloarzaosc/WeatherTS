import { useMrmsStore } from "../store/useMrmsStore";
import { useAppStore } from "../store/useAppStore";

/**
 * The scale for whatever MRMS product is on screen.
 *
 * The stops come from the backend rather than from a table repeated here: the
 * same colormap object that coloured the pixels also produces this ramp, so
 * the legend cannot drift from the image it explains. That matters more here
 * than for the radar, where one palette covers a handful of products -- MRMS
 * spans a hundred, across quantities as unlike as dBZ, inches and s⁻¹.
 */

const LAYER = "mrms";

/**
 * Labels on round numbers, positioned where those numbers actually fall.
 *
 * Dividing the range into equal parts gives ticks like -20, 4, 28, 51, 75 --
 * arithmetically correct and unreadable, because nobody holds "28 dBZ" as a
 * landmark. Snapping the step to 1, 2, 2.5 or 5 times a power of ten gives
 * -20, 0, 20, 40, 60 instead, and the eye lands on the number it was looking
 * for. Each label then carries its own position, since round ticks no longer
 * sit at even fractions of the bar.
 */
function tickValues(vmin: number, vmax: number): { value: number; pct: number }[] {
  const span = vmax - vmin;
  if (!Number.isFinite(span) || span <= 0) return [];

  const rough = span / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;

  const out: { value: number; pct: number }[] = [];
  const first = Math.ceil(vmin / step) * step;
  for (let v = first; v <= vmax + step * 1e-6; v += step) {
    // Floating point leaves 0.30000000000000004 lying around; the label is
    // rounded anyway, but the position should use the value it prints.
    const value = Math.abs(v) < step * 1e-9 ? 0 : v;
    out.push({ value, pct: ((value - vmin) / span) * 100 });
  }
  return out;
}

/** Decimals enough to tell one tick from the next, and no more. */
function fmt(v: number, step: number): string {
  if (step < 0.01) return v.toFixed(3);
  if (step < 0.1) return v.toFixed(2);
  if (step < 1) return v.toFixed(1);
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return String(Math.round(v));
}

export function MrmsColorBar() {
  const on = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const meta = useMrmsStore((s) => s.meta);

  if (!on || !meta || !meta.bar?.length) return null;

  const ticks = tickValues(meta.vmin, meta.vmax);
  const span = meta.vmax - meta.vmin;
  const stepSpan = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : span;

  return (
    <div className="mrmsbar" aria-label={`${meta.label} scale`}>
      <div className="mrmsbar__head">
        <b>{meta.label}</b>
        {meta.units && <span className="mrmsbar__unit">{meta.units}</span>}
      </div>
      <div
        className="mrmsbar__ramp"
        style={{ background: `linear-gradient(to right, ${meta.bar.join(",")})` }}
      />
      <div className="mrmsbar__ticks">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="mrmsbar__tick"
            style={{
              left: `${t.pct}%`,
              // The end labels would otherwise hang off the bar; they anchor to
              // their edge instead of centring on a point that is not there.
              transform:
                t.pct <= 1 ? "none" : t.pct >= 99 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {fmt(t.value, stepSpan)}
          </span>
        ))}
      </div>
    </div>
  );
}
