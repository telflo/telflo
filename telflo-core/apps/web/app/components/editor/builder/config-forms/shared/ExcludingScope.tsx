import { useMemo, type ReactNode } from "react";

import { FormProvider, formSource, useForm, type FormSource } from "../form-context.js";
import { useAdjustments } from "./AdjustmentAlert.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/**
 * Writes made under it also remove `excludes`, in the same change, with
 * decision 7's toast (`message`), which names `excludes` as the path it
 * adjusted (D9d Ruling 41d). A change that only removes keys (a cleared
 * field, a pruned block) leaves the other alone. The prometheus receiver's
 * basic authentication against authorization (prometheus/common v0.71.0
 * `config/http_config.go:434-437`) and the spanmetrics connector's
 * explicit against exponential histogram (D9d Ruling 43: one helper).
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
