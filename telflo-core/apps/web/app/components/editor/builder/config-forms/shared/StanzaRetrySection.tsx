import { DurationField, FormScope, useForm } from "../form-context.js";
import { UnshowableSectionHint, type SectionState } from "./section-toggle.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The stanza receivers' Retry on Failure, over the form's fields, bound to
 * the `retry_on_failure` block's path. The form's ConfigSection ("Retry on
 * Failure") holds it.
 *
 * Not `RetryConfigSection`, which is exporterhelper's: the stanza receivers'
 * `retry_on_failure` is `consumerretry.Config`
 * (`pkg/stanza/adapter/config.go:19`;
 * `internal/coreinternal/consumerretry/config.go:10-33` at v0.162.0:
 * `enabled` false by default, `initial_interval` 1s, `max_interval` 30s,
 * `max_elapsed_time` 5m). It has no `multiplier`, a key the collector refuses
 * there, so none is ever written.
 *
 * The box is off when the block is unset or `enabled` isn't true (the
 * collector's default); ticking writes `enabled: true` (into the block, which
 * is added if missing), unticking writes `enabled: false`, each keeping the
 * block's other keys.
 *
 * The intervals' defaults are placeholders and "Default" hints, not
 * values; a field's edit writes only its key.
 */

/** On only while `enabled` is true: unset (the key or the block) is off, as the collector has it. */
function retryState(enabled: ValueView, block: ValueView): SectionState {
  if (block.kind === "absent") return "off";
  if (block.kind !== "map") return "unshowable";
  if (enabled.kind === "absent") return "off";
  if (enabled.kind === "scalar" && typeof enabled.value === "boolean") return enabled.value ? "on" : "off";
  return "unshowable";
}

export function StanzaRetrySection({ path }: { path: ValuePath }) {
  const form = useForm();
  const state = retryState(form.read([...path, "enabled"]), form.read(path));

  return (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          id="stanza-retry-enabled"
          checked={state === "on"}
          onCheckedChange={(checked) => {
            if ((checked === true) !== (state === "on")) form.set([...path, "enabled"], checked === true);
          }}
          disabled={form.disabled || state === "unshowable"}
        />
        <Label htmlFor="stanza-retry-enabled" className="cursor-pointer text-sm">
          Enable Retry
        </Label>
      </div>
      {state === "unshowable" && <UnshowableSectionHint />}

      {state === "on" && (
        <FormScope path={path}>
          <DurationField
            path={["initial_interval"]}
            id="stanza-retry-initial-interval"
            label="Initial Interval"
            defaultValue="1s"
            description="Wait before the first retry."
          />
          <DurationField
            path={["max_interval"]}
            id="stanza-retry-max-interval"
            label="Max Interval"
            defaultValue="30s"
            description="Upper bound between retries."
          />
          <DurationField
            path={["max_elapsed_time"]}
            id="stanza-retry-max-elapsed-time"
            label="Max Elapsed Time"
            defaultValue="5m"
            description="Give up retrying after this total time."
          />
        </FormScope>
      )}
    </>
  );
}
