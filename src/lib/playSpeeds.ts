/**
 * The playback speeds the timeline offers, from 1x to 80x.
 *
 * Fine steps low down, where one notch is easy to see (half steps to 3x, then
 * whole ones to 10x), wider ones on the way up. Pablo asked for 80x reached
 * gradually (2026-10-03); the old list jumped 1, 2, 4, 8 and stopped at 20.
 */
export const PLAY_SPEEDS: readonly number[] = [
  1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10,
  12, 14, 16, 18, 20, 24, 28, 32, 36, 40,
  45, 50, 55, 60, 65, 70, 75, 80,
];

/** The listed speed nearest to `v`: a saved setting from an older list. */
export function nearestSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1;
  let best = PLAY_SPEEDS[0];
  for (const s of PLAY_SPEEDS) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

export function speedLabel(v: number): string {
  return `${v}×`;
}
