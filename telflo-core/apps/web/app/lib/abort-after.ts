/**
 * A signal that aborts after `milliseconds` (a fake timer in tests), and how
 * to stand it down: `clear()` once the request has settled, `abort()` to end
 * it at once. The hang guard of the browser's requests, which have no timeout
 * of their own: the Testing tab's reads, the suites', the definitions' and
 * the templates', and the fleet screens'. Its own module, so the fleet
 * screens needn't import the testing store.
 */
export function abortAfter(milliseconds: number): { signal: AbortSignal; clear: () => void; abort: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}
