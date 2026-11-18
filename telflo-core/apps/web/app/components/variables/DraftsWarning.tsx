import type { VariableDraftsResponse } from "@telflo/contracts";
import { DRAFTS_UNREAD_MESSAGE, draftsWarning } from "~/lib/variables.js";

/*
 * Default 21's warning, without refusing (a delete or a rename): the
 * configurations whose current draft references the variable's name, read
 * as the dialog opens, exactly "Drafts using OTLP_EP: edge-config". Nothing
 * while it reads or when no draft does; a read that failed says the drafts
 * couldn't be checked. The name and the configurations' names are
 * configuration text: the warning sits inside `ph-no-capture`, text only.
 */

/** The drafts read of one opening. */
export type DraftsRead =
  | { state: "reading" }
  | { state: "read"; configurations: VariableDraftsResponse["configurations"] }
  | { state: "failed" };

export function DraftsWarning({ name, drafts }: { name: string; drafts: DraftsRead }) {
  if (drafts.state === "reading" || (drafts.state === "read" && drafts.configurations.length === 0)) return null;
  return (
    <div className="ph-no-capture rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn" role="status">
      {drafts.state === "read" ? draftsWarning(name, drafts.configurations) : DRAFTS_UNREAD_MESSAGE}
    </div>
  );
}
