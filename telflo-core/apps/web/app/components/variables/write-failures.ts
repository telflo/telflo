import { toast } from "sonner";
import { isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { isUnknownOutcome } from "~/lib/fleets.js";
import { VARIABLES_UNAVAILABLE_MESSAGE, hasVariableCode, isVariableRefusal } from "~/lib/variables.js";

/*
 * How the variables dialogs take a write's failure in (D20 decision 39; the
 * fleet dialogs' rules, D17a decision 28 and Preflight ruling 13), before
 * each dialog's own refusals:
 * - the organization's or the terms' refusal closes the dialog and
 *   revalidates the layout; a session ended is silent (the handler has the
 *   page);
 * - a "not found" of the thing written (deleted meanwhile) toasts its fixed
 *   words, closes and reloads the page's list;
 * - an unknown outcome (a 5xx, the 503 `variables_unavailable` among them,
 *   no connection, the hang guard, a reply that doesn't parse) shows the
 *   503's words (neutral: they claim neither that a change was made nor
 *   that it wasn't; Ruling 78), keeps the dialog open for a retry (a
 *   create's id makes it safe), and reloads the list behind it.
 * Every word is fixed: never a name, a value or a description.
 */

export interface WriteFailureHandlers {
  /** Closes the dialog. */
  close: () => void;
  /** Revalidates the layout (the organization's or the terms' refusal). */
  revalidate: () => void;
  /** Reloads the page's list. */
  reload: () => void;
  /** Shows a message inside the dialog. */
  showError: (message: string) => void;
}

/** The not-found codes a dialog's write treats as "gone": the thing it writes, with its fixed toast. */
export interface GoneCode {
  code: "variable_not_found" | "variable_group_not_found";
  message: string;
}

/** Handles the failures every dialog shares; true when handled, false for the dialog's own refusals. */
export function handleSharedWriteFailure(error: unknown, handlers: WriteFailureHandlers, gone: readonly GoneCode[]): boolean {
  if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
    handlers.close();
    handlers.revalidate();
    return true;
  }
  if (isSessionEnded(error)) return true;
  for (const each of gone) {
    if (hasVariableCode(error, each.code)) {
      toast.error(each.message);
      handlers.close();
      handlers.reload();
      return true;
    }
  }
  if (isUnknownOutcome(error)) {
    handlers.showError(isVariableRefusal(error) ? error.message : VARIABLES_UNAVAILABLE_MESSAGE);
    handlers.reload();
    return true;
  }
  return false;
}
