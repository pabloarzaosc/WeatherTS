/**
 * Waiting on the local backend without waiting forever.
 *
 * A request to it that never answers is worse than one that fails: the panel
 * sat on "Ready" with no catalogue and nothing ever asked again. These give
 * every call a deadline, and the calls that a layer cannot work without a few
 * more tries, spaced out, before they give up.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** `signal`, and also aborted once `ms` have gone by. */
export function within(ms: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Call `fn` until it succeeds, waiting twice as long after each failure.
 *  Throws the last error once `tries` have failed. */
export async function retrying<T>(
  fn: () => Promise<T>,
  opts: { tries: number; firstWaitMs: number; maxWaitMs: number; onRetry?: (failures: number) => void },
): Promise<T> {
  for (let failures = 0; ; ) {
    try {
      return await fn();
    } catch (err) {
      failures += 1;
      if (failures >= opts.tries) throw err;
      opts.onRetry?.(failures);
      await sleep(Math.min(opts.maxWaitMs, opts.firstWaitMs * 2 ** (failures - 1)));
    }
  }
}

/** An error as a sentence for a panel's status line. */
export function describe(err: unknown, what: string): string {
  if (err instanceof DOMException && err.name === "TimeoutError") return `${what} took too long to answer`;
  if (err instanceof TypeError) return `${what} is not reachable`;
  return err instanceof Error ? err.message : String(err);
}
