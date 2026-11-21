import type { ReactNode, Ref } from "react";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";
import { QUICK_DEPLOY_UNIT_NAME } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { formatDateTime } from "~/lib/format.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { NoDefaultToken } from "./InstallContainerSection.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * The install dialog's Quick Deploy screen, presentational: the dialog
 * holds the link, the bearer and the reveal.
 *
 * - "Quick Deploy command ready", what the command does (the systemd
 *   service's, or the foreground's), when the link expires and where it is
 *   extended or revoked, and the warning.
 * - Before the reveal, the preview (`quickDeployPreview`: the bearer and the
 *   link's secret masked) and "Reveal & copy command" ("Preparing…"); once
 *   revealed, the command in a `SecretCopyBox` ("Copy command", one line a
 *   line). The command is shown only here, only now: the link's secret is
 *   stored only as its hash.
 * - The link's default token revoked meanwhile (the reveal refused for it):
 *   with another valid default token (revoked and replaced since the link
 *   was made), "This link's token was revoked: make a new link." in place of
 *   the reveal, "Done" offered; with none, `NoDefaultToken`.
 * - Privacy: the command (the bearer and the link's secret) only in the
 *   `SecretCopyBox` (`ph-no-capture`); the preview holds the root path and
 *   the display name, configuration text, inside `ph-no-capture` too; none
 *   of them in an attribute.
 * - A Helm values link: one click, no reveal (the bearer comes with the
 *   link's download), so `oneClick` shows the command, built at once, in
 *   the box and nothing in its place once the dialog has closed (the
 *   command gone, the screen kept through the exit animation); its own
 *   `description` and `warning`.
 */

export const QUICK_DEPLOY_TITLE = "Quick Deploy command ready";
export const QUICK_DEPLOY_SYSTEMD_WORDS = `Run this command on the host: it downloads the bundle, unpacks it and installs the collector as ${QUICK_DEPLOY_UNIT_NAME}, started now and on every boot.`;
export const QUICK_DEPLOY_FOREGROUND_WORDS =
  "Run this command on the host: it downloads the bundle, unpacks it and starts the collector in the foreground of that shell.";
/** The systemd service's log (shown with the systemd words). */
export const QUICK_DEPLOY_JOURNAL_COMMAND = "sudo journalctl -u telflo-supervisor -f";
export const QUICK_DEPLOY_WARNING =
  "The command contains the fleet's default token and a link that downloads this install, with the values you typed, without signing in. Run it in a secure shell; don't paste it into shared logs or chat. If it leaks, revoke the link, and revoke the default token and issue a new one.";

/** The reveal refused for the link's token while another default token is valid: the link can never work again. */
export const QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS = "This link's token was revoked: make a new link.";

/** "This command is shown only now…": the link's expiry (a new link's is 24 hours on; never null from the create). */
export function quickDeployExpiryWords(expiresAt: string | null): string {
  return expiresAt === null
    ? "This command is shown only now. It never expires; revoke it under Install links on the Tokens tab."
    : `This command is shown only now. It expires ${formatDateTime(expiresAt)}; extend or revoke it under Install links on the Tokens tab.`;
}

export interface QuickDeployScreenProps {
  /** The command installs the systemd service (else runs in the foreground). */
  systemd: boolean;
  /** In place of the systemd or foreground words (the Helm values link's). */
  description?: ReactNode;
  /** In place of `QUICK_DEPLOY_WARNING` (the Helm values link's). */
  warning?: string;
  /** The command built at the link's making, no reveal (the Helm values link's): no preview, no Reveal. */
  oneClick?: boolean;
  /** The link's expiry, from the create's reply. */
  expiresAt: string | null;
  /** The masked command (`quickDeployPreview`): no bearer, no secret. */
  preview: string;
  /** The command with the bearer and the link, once revealed; null before. */
  command: string | null;
  revealing: boolean;
  /** False once the dialog has closed: the link's url is gone, nothing to reveal (the screen kept for the exit animation). */
  canReveal: boolean;
  revealError: string | null;
  /** The link's default token found revoked at the reveal, and no valid default token: nothing to reveal. */
  noDefaultToken: boolean;
  /** The link's default token found revoked at the reveal, another default token valid: a new link is the way on. */
  linkTokenRevoked: boolean;
  revealRef: Ref<HTMLButtonElement>;
  /** "Done": the focus's target when the words show (no reveal, no link in them). */
  doneRef: Ref<HTMLButtonElement>;
  onReveal: () => void;
  /** "Done", and the Tokens tab's link: the dialog closes. */
  onClose: () => void;
}

export function QuickDeployScreen({
  systemd,
  description,
  warning = QUICK_DEPLOY_WARNING,
  oneClick = false,
  expiresAt,
  preview,
  command,
  revealing,
  canReveal,
  revealError,
  noDefaultToken,
  linkTokenRevoked,
  revealRef,
  doneRef,
  onReveal,
  onClose,
}: QuickDeployScreenProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{QUICK_DEPLOY_TITLE}</DialogTitle>
        <DialogDescription>
          {description !== undefined ? (
            description
          ) : systemd ? (
            <>
              {QUICK_DEPLOY_SYSTEMD_WORDS} See its log with <span className="font-mono">{QUICK_DEPLOY_JOURNAL_COMMAND}</span>.
            </>
          ) : (
            QUICK_DEPLOY_FOREGROUND_WORDS
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        {command !== null ? (
          <SecretCopyBox secret={command} copyLabel="Copy command" multiline />
        ) : oneClick ? null : (
          <>
            <div className="ph-no-capture">
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{preview}</pre>
            </div>
            {linkTokenRevoked ? (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS}</p>
              </div>
            ) : noDefaultToken ? (
              <NoDefaultToken onTokensTab={onClose} />
            ) : (
              <div>
                <Button ref={revealRef} type="button" onClick={onReveal} disabled={revealing || !canReveal}>
                  {revealing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Preparing…
                    </>
                  ) : (
                    <>
                      <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
                      Reveal &amp; copy command
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
        <DialogErrorAlert error={revealError} />
        <p className="text-xs text-muted-foreground">{quickDeployExpiryWords(expiresAt)}</p>
        <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{warning}</p>
        </div>
      </div>
      <DialogFooter>
        <Button ref={doneRef} type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
