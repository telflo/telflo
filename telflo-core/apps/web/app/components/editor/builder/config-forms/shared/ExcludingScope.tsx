import { useMemo, type ReactNode } from "react";

import { FormProvider, formSource, useForm, type FormSource } from "../form-context.js";
import { useAdjustments } from "./AdjustmentAlert.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/**
 * Writes made under it also remove `excludes`, in the same change, with the
 * adjustment toast (`message`), which names `excludes` as the path it
 * adjusted. A change that only removes keys (a cleared field, a pruned block)
 * leaves the other alone. It serves the prometheus receiver's basic
 * authentication against authorization (prometheus/common v0.71.0
 * `config/http_config.go:434-437`) and the spanmetrics connector's explicit
 * against exponential histogram.
 */
export function ExcludingScope({ excludes, message, children }: { excludes: ValuePath; message: string; children: ReactNode }) {
  const form = useForm();
  const { note } = useAdjustments();
  const excludesKey = JSON.stringify(excludes);
  const scoped = useMemo<FormSource>(() => {
    const other: ValuePath = JSON.parse(excludesKey) as ValuePath;
    return formSource(
      form.read,
      (changes) => {
        const writes = changes.some((change) => !("remove" in change));
        if (!writes || form.read(other).kind === "absent") return form.apply(changes);
        const removal: ValueChange = { path: other, remove: true };
        const result = form.apply([...changes, removal]);
        note([{ message, adjusted: [other] }], result);
        return result;
      },
      form.disabled,
    );
  }, [form, excludesKey, message, note]);
  return <FormProvider form={scoped}>{children}</FormProvider>;
}
