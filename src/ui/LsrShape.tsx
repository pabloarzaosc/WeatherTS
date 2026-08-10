import { LSR_COLORS, LSR_SHAPES, LSR_SHAPE_PATHS, type LsrCategory } from "../lib/lsr";

/**
 * The category's marker, drawn from the very same path the map icon uses.
 * A legend that redraws its own approximation of a marker drifts from the map
 * the moment either changes; this cannot.
 */
export function LsrShape({
  cat,
  size = 12,
  dim = false,
}: {
  cat: LsrCategory;
  size?: number;
  dim?: boolean;
}) {
  const color = LSR_COLORS[cat] ?? LSR_COLORS.other;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flex: "none", opacity: dim ? 0.4 : 1 }}
    >
      <path
        d={LSR_SHAPE_PATHS[LSR_SHAPES[cat] ?? "pin"]}
        fill={color}
        stroke="rgba(6,10,16,0.85)"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}
