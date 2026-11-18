import type { ReactNode } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, type FormSource } from "../form-context.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * What the shared sections' "Enable …" boxes show (D9b decisions 3 and 4).
 * A section is on, off, or written in a form the box can't show (a scalar
 * or a list where a mapping belongs), which leaves the box read-only with
 * decision 3's hint.
 */

export type SectionState = "on" | "off" | "unshowable";

/** TLS and CORS: on while the block is there; an explicit null is unset. */
export function presenceOf(view: ValueView): SectionState {
  if (view.kind === "absent") return "off";
  return view.kind === "map" ? "on" : "unshowable";
}

/**
 * What an absent retry or queue block means to the collector (D9d Preflight
 * ruling 4):
 * - `"on"`: a block with a default that is on (D9b's exporters);
 * - `"off-optional"`: a `configoptional.Default` block (load balancing's
 *   top-level `sending_queue`, `factory.go:52`; the S3 exporter's,
 *   `factory.go:51`): absent is off; written, it is on (null, `{}`, or keys
 *   without `enabled: false`; core `configoptional/optional.go:172-220`);
 * - `"off-struct"`: a plain `configretry.BackOffConfig` whose zero value is
 *   off (load balancing's top-level `retry_on_failure`, `config.go:42`): on
 *   only with `enabled: true`.
 */
export type AbsentMeans = "on" | "off-optional" | "off-struct";

/** Whether the text writes `path` as an explicit null (`sending_queue:`), which the form reads as unset. */
function writtenNull(form: FormSource, path: ValuePath): boolean {
  const key = path[path.length - 1];
  if (typeof key !== "string") return false;
  const parent = form.read(path.slice(0, -1));
  return parent.kind === "map" && Object.hasOwn(parent.value, key) && parent.value[key] === null;
}

/**
 * Retry and the queue: on unless `enabled` is false. Unset (the key or the
 * whole block) is on, as the collector has them (decision 4). With an off
 * variant (`absentMeans`), as `AbsentMeans` says.
 */
export function enabledOf(form: FormSource, path: ValuePath, absentMeans: AbsentMeans = "on"): SectionState {
  const block = form.read(path);
  if (block.kind === "absent") {
    if (absentMeans === "on") return "on";
    return absentMeans === "off-optional" && writtenNull(form, path) ? "on" : "off";
  }
  if (block.kind !== "map") return "unshowable";
  const enabled = form.read([...path, "enabled"]);
  if (enabled.kind === "absent") return absentMeans === "off-struct" ? "off" : "on";
  if (enabled.kind === "scalar" && typeof enabled.value === "boolean") return enabled.value ? "on" : "off";
  return "unshowable";
}

/** A fixed id part from a form's own label ("OTLP gRPC" → "otlp-grpc"), never from a value. */
export function idPart(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The section box: a checkbox and its 13px label. */
export function SectionToggle({
  id,
  label,
  state,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  state: SectionState;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={state !== "off"}
        onCheckedChange={(checked) => {
          if ((checked === true) !== (state !== "off")) onToggle(checked === true);
        }}
        disabled={disabled || state === "unshowable"}
      />
      <Label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </Label>
    </div>
  );
}

/** A section's 11px hint line. */
export function SectionHint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-4 text-muted-foreground">{children}</p>;
}

/** Decision 3's hint, under a section whose value it can't show. */
export function UnshowableSectionHint() {
  return <SectionHint>{UNSHOWABLE_VALUE_MESSAGE}</SectionHint>;
}
