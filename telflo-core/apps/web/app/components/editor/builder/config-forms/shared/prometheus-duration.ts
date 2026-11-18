/*
 * Prometheus' durations (D9d decision 12; Preflight ruling 30), for the
 * prometheus receiver's scrape jobs. The receiver's `config:` block isn't
 * decoded by the collector: it is handed to Prometheus' strict loader
 * (contrib v0.162.0 `receiver/prometheusreceiver/config.go:187-205`;
 * prometheus v3.14.0 `config/config.go:81`), whose `model.Duration` parses
 * with prometheus/common v0.71.0's `ParseDuration` (`model/time.go:211-280`):
 * `0` alone, or integer-and-unit runs in the units `y w d h m s ms`, each at
 * most once and from the biggest to the smallest (`1h30m`, `1d`, `2w`).
 * Fractions (`1.5h`), Go's `ns` and `us`, a sign, and a number without a
 * unit (`30`) are refused. A `${…}` reference is expanded by the collector
 * before Prometheus reads it, so it isn't flagged.
 */

/** The error under a scrape job's interval or timeout that Prometheus refuses (the spec's copy). */
export const PROMETHEUS_DURATION_MESSAGE = "Invalid duration format. Use: 1ms, 1s, 1m, 1h, 1d, 1w, or 1y";

const PROMETHEUS_DURATION = /^(?:0|(?=\d)(?:\d+y)?(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?(?:\d+ms)?)$/;

/** Whether Prometheus takes `value` as a duration: empty (unset), its grammar, or one holding a reference. */
export function isPrometheusDuration(value: string): boolean {
  return value === "" || PROMETHEUS_DURATION.test(value) || value.includes("${");
}
