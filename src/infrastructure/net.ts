/* Small network-robustness helpers. Ideas (not code) ported from jiji262/douyin-downloader's
 * control/ layer: fixed-backoff retry, treat empty/blocked as retryable, gentle paced jitter. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Human-ish pacing: base + up to `jitter` random ms (anti-throttle, like their rate_limiter). */
export const pace = (base = 0, jitter = 500) => sleep(base + Math.floor(Math.random() * jitter));

interface RetryOpts {
  delays?: number[];                       // wait AFTER each failed attempt; length = max retries
  retryable?: (e: unknown) => boolean;     // return false to stop early (terminal errors)
  onRetry?: (attempt: number, e: unknown) => void;
}

/** Fixed-backoff retry. Default [1s,2s,5s] = their control/retry_handler delays. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const delays = opts.delays ?? [1000, 2000, 5000];
  let last: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === delays.length || (opts.retryable && !opts.retryable(e))) break;
      opts.onRetry?.(attempt + 1, e);
      await sleep(delays[attempt]);
    }
  }
  throw last;
}
