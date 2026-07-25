/** Toggle the reduced-motion attribute; CSS disables transitions when set. */
export function applyReduceMotion(reduce: boolean): void {
  document.documentElement.dataset.reduceMotion = reduce ? "true" : "false";
}
