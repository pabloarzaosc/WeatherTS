/**
 * The order a loop's frames are fetched in: every eighth frame first, then the
 * ones between them, halving the gap each round -- so a play started while
 * the loop downloads runs over the whole span from the start, sharper each
 * time round, instead of over a first stretch that grows while the rest waits.
 * `order` is the loop in play order; its first frame stays first.
 */
export function spreadOrder<T>(order: readonly T[], widest = 8): T[] {
  const out: T[] = [];
  const taken = new Array<boolean>(order.length).fill(false);
  for (let step = widest; step >= 1; step = Math.floor(step / 2)) {
    for (let i = 0; i < order.length; i += step) {
      if (!taken[i]) {
        taken[i] = true;
        out.push(order[i]);
      }
    }
  }
  return out;
}
