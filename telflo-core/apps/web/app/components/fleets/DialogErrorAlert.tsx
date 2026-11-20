import { AlertTriangle } from "lucide-react";

/**
 * A dialog's inline error box, with `role="alert"` so a screen reader hears
 * it when it appears. Nothing when there is no error, so a dialog drops it in
 * unconditionally. The create and rename dialogs show their refusals here.
 */
export function DialogErrorAlert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-fail/25 bg-fail-soft p-3 text-[13px] text-fail">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{error}</p>
    </div>
  );
}
