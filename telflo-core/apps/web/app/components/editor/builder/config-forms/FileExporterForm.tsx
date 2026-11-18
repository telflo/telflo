import { useRef, type ReactNode } from "react";

import { ConfigSection } from "./ConfigSection.js";
import { FormProvider, formSource, FormScope, NumberField, TextField, useForm } from "./form-context.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The file exporter's form (ADR 0018), over the form's fields
 * (D9d decision 2, D9b's contract): each field writes its own key.
 * Collector claims are contrib v0.162.0's `exporter/fileexporter`.
 *
 * - Fixed (decision 4): rotation is on exactly while `rotation` is in the
 *   text, whatever it holds (`config.go:195-199`): `rotation: {}` is still
 *   on (100 MB, 100 backups). The three
 *   fields sit in a pruning scope: clearing the last key removes
 *   `rotation`; a key no field shows (`localtime`) keeps it. `ROTATION_HINT`
 *   says so.
 * - Fixed (D9b decision 4): each is a `NumberField`, so 0 can be typed
 *   (Max Days 0 keeps every file).
 * - Changed (decision 7): a rotation value written while the text has
 *   `append: true` removes `append` in the same change, with
 *   `APPEND_TOAST`: the collector refuses the two together
 *   (`config.go:126-128`). The form has no Append control.
 * - File Path cleared removes the key (D9b's contract; `""` is refused
 *   either way, `config.go:123-125`).
 *
 * Ids are fixed (decision 13).
 */

/** Under Rotation (Parity Notes). */
export const ROTATION_HINT = "Setting any of these turns rotation on; with none set, the file isn't rotated.";
/** The append cascade's toast (decision 7). */
export const APPEND_TOAST = "Removed append: it can't be used with rotation.";

const ROTATION: ValuePath = ["rotation"];
const APPEND: ValuePath = ["append"];

/** The rotation fields' source: a value written under `rotation` while `append: true` is in the text removes `append` with it. */
function AppendScope({ children }: { children: ReactNode }) {
  const form = useForm();
  const { note } = useAdjustments();
  const noteRef = useRef(note);
  noteRef.current = note;
  const scoped = formSource(
    form.read,
    (changes) => {
      const sets = changes.some((change) => change.path[0] === ROTATION[0] && ("value" in change || "plain" in change));
      if (!sets || form.read(APPEND).value !== true) return form.apply(changes);
      const result = form.apply([...changes, { path: APPEND, remove: true }]);
      noteRef.current([{ message: APPEND_TOAST, adjusted: [APPEND] }], result);
      return result;
    },
    form.disabled,
  );
  return <FormProvider form={scoped}>{children}</FormProvider>;
}

export function FileExporterForm() {
  const form = useForm();
  const rotationCount = ["max_megabytes", "max_days", "max_backups"].filter((key) => form.read([...ROTATION, key]).kind !== "absent").length;

  return (
    <div className="space-y-4">
      <TextField path={["path"]} id="path" label="File Path" required placeholder="e.g. ./output.json" />

      <ConfigSection title="Rotation" count={rotationCount}>
        <p className="text-[11px] leading-4 text-muted-foreground">{ROTATION_HINT}</p>

        <AppendScope>
          <FormScope path={ROTATION} prune>
            <NumberField
              path={["max_megabytes"]}
              id="rotation-max-megabytes"
              label="Max Megabytes"
              defaultValue="100"
              description="Rotate the file once it reaches this size."
            />

            <NumberField
              path={["max_days"]}
              id="rotation-max-days"
              label="Max Days"
              defaultValue="0 (keep all)"
              placeholder="0"
              description="Delete rotated files older than this many days."
            />

            <NumberField
              path={["max_backups"]}
              id="rotation-max-backups"
              label="Max Backups"
              defaultValue="100"
              description="Rotated files kept before the oldest is deleted."
            />
          </FormScope>
        </AppendScope>
      </ConfigSection>
    </div>
  );
}
