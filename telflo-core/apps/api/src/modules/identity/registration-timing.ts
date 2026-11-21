/**
 * Remembers how long recent new-account registrations took after the
 * password hash, so the duplicate-email path can wait a comparable time
 * without writing anything (see registerUser in service.ts for the
 * measurements and the reasoning).
 *
 * `sample()` returns one of the recent observations at random rather than
 * their mean, so the padded duplicate path reproduces the spread of the
 * real path's latency, not just its center: a constant delay would give the
 * duplicate path a visibly tighter distribution than the path it imitates.
 */
export interface RegistrationTimingOptions {
  /** How many recent observations to keep. */
  capacity: number;
  /** Returned until the first observation arrives, e.g. just after startup. */
  fallbackMilliseconds: number;
  /** Uniform in [0, 1). Injectable for tests. */
  random?: () => number;
}

export function createRegistrationTiming(options: RegistrationTimingOptions) {
  const { capacity, fallbackMilliseconds, random = Math.random } = options;
  const observations: number[] = [];
  let next = 0;

  return {
    record(milliseconds: number): void {
      if (observations.length < capacity) {
        observations.push(milliseconds);
      } else {
        observations[next] = milliseconds;
      }
      next = (next + 1) % capacity;
    },

    sample(): number {
      if (observations.length === 0) return fallbackMilliseconds;
      return observations[Math.floor(random() * observations.length)]!;
    },
  };
}
