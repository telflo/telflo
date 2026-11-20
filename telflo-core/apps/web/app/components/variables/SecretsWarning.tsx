import type { ReactNode } from "react";
import { SECRETS_WARNING_ENV_REFERENCE, SECRETS_WARNING_LEAD } from "~/lib/variables.js";

/*
 * The warning atop the Variables and Variable groups pages: nothing in a
 * variable is secret, so secrets stay in environment variables; the Variables
 * page adds that a test run keeps the values it used with its results (the
 * Variable groups page gives nothing more). lib/variables.ts holds each page's
 * whole text. Fixed words, no configuration text: a note, not a status, since
 * it never changes.
 */

export function SecretsWarning({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn" role="note">
      <strong className="font-semibold">{SECRETS_WARNING_LEAD}</strong> Keep passwords, tokens and keys in environment
      variables (<code className="font-mono">{SECRETS_WARNING_ENV_REFERENCE}</code>), set when you install.
      {children !== undefined && <> {children}</>}
    </div>
  );
}
