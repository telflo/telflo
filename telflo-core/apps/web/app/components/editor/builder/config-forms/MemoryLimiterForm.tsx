import { NumberField, TextField } from "./form-context.js";

/*
 * The memory limiter's form (ADR 0018), over the form's fields (D9b
 * decisions 2 and 3): each field writes its own key; 0 can be entered
 * (decision 4). The memory_limiter processor only: the extension of the
 * same name keeps the fallback layout (decision 6).
 *
 * The collector (`internal/memorylimiter` `NewDefaultConfig`, v0.162.0)
 * has no default check interval or limit (both required); an unset spike
 * limit is 20% of the limit (`newFixedMemUsageChecker`).
 */

export function MemoryLimiterForm() {
  return (
    <div className="space-y-4">
      <TextField path={["check_interval"]} id="check-interval" label="Check Interval" required placeholder="e.g. 1s" />

      <NumberField
        path={["limit_mib"]}
        id="limit-mib"
        label="Memory Limit"
        required
        description="Hard cap in MiB; data is refused above it."
        placeholder="e.g. 512"
      />

      <NumberField
        path={["spike_limit_mib"]}
        id="spike-limit-mib"
        label="Spike Limit"
        defaultValue="20% of limit_mib"
        description="Expected max memory spike in MiB between checks."
        placeholder="e.g. 128"
      />
    </div>
  );
}
