/** How a loop's length and spacing read in a panel. */

/** "6 h", "24 h", "3 d". */
export function spanLabel(hours: number): string {
  return hours > 24 && hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`;
}

/** How far apart a loop's frames are, "10 min" or "3 h"; "" under three frames. */
export function stepLabel(unixes: number[]): string {
  if (unixes.length < 3) return "";
  const gaps = unixes
    .slice(1)
    .map((u, i) => u - unixes[i])
    .sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  return gap >= 3600 && gap % 3600 === 0 ? `${gap / 3600} h` : `${Math.max(1, Math.round(gap / 60))} min`;
}
