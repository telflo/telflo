import { useId } from "react";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";
import { Link } from "react-router";
import type { DockerMount } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { EnvVarInputs, type EnvVarInputsProps } from "./EnvVarInputs.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * The install dialog's container image method, presentational: the dialog
 * holds the fields, the bearer and the reveal.
 *
 * - "Collector display name (optional)" (`DisplayNameField`, shared with
 *   the Linux methods), the environment variables (`EnvVarInputs`), the
 *   group's mounts listed read-only, then the run command: the preview
 *   with the token masked (`containerPreview`: it takes no bearer), and
 *   "Reveal & copy command" ("Preparing…"); once revealed, the command in a
 *   `SecretCopyBox` ("Copy command", one flag a line), following the fields
 *   live, hidden while a field has a problem (its message shows under it).
 *   The warning says what the command holds. The display name and the
 *   variables are disabled while the reveal runs: the command copied is the
 *   one shown.
 * - A fleet with no valid default token (all revoked) shows
 *   `NoDefaultToken` in place of the reveal: issue a new one on the Tokens
 *   tab.
 * - Mounts the platform can't read (the facts' `mountsReadable` false)
 *   are left out of the command, and the section says so.
 * - Privacy: the display name, the variables, the mounts' paths and the
 *   preview are configuration text, all inside `ph-no-capture`; the
 *   bearer only in the `SecretCopyBox` (also `ph-no-capture`), never in
 *   an attribute.
 */

export const CONTAINER_INTRO =
  "Pull Telflo's prebuilt collector image and run it with your fleet's credentials: no build step. The named volume keeps this collector's identity across restarts and upgrades.";
export const CONTAINER_WARNING =
  "The command contains the fleet's default token. Anyone holding it can enroll collectors in this fleet. Run it in a secure shell; don't paste it into shared logs or chat. If it leaks, revoke the default token and issue a new one on the Tokens tab.";
export const DISPLAY_NAME_HELP = "Shown in Fleet Management. Leave empty for an automatic name.";
/** The facts' `mountsReadable` false: the group's mounts can't be read, so the command has none. */
export const MOUNTS_UNREADABLE_WORDS =
  "This group's mounts are saved in a form Telflo can't read: they're left out of the command. Edit them on the Groups tab.";

/** The display name: the container's and the Linux methods' alike. */
export function DisplayNameField({
  value,
  onChange,
  problem,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="ph-no-capture grid gap-2">
      <Label htmlFor={id}>Collector display name (optional)</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. prod-collector-east-1"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem !== null ? `${id}-problem` : `${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {DISPLAY_NAME_HELP}
      </p>
      {problem !== null && (
        <p id={`${id}-problem`} className="text-xs text-fail">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The fleet's default tokens all revoked: no bearer to put in a command;
 * the Tokens tab issues a new one. `onTokensTab` closes the dialog as the
 * link is followed.
 */
export function NoDefaultToken({ onTokensTab }: { onTokensTab: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        The fleet&apos;s default token is revoked. Issue a new one on the{" "}
        <Link to={{ search: "?tab=tokens" }} onClick={onTokensTab} className="font-medium underline">
          Tokens tab
        </Link>
        , then install.
      </p>
    </div>
  );
}

/** The mounts' line: host path, container path, read-only or not; paths as text only. */
function MountsList({ mounts }: { mounts: readonly DockerMount[] }) {
  if (mounts.length === 0) return null;
  return (
    <div className="ph-no-capture grid gap-1 text-xs text-muted-foreground">
      <p>From the group&apos;s mounts:</p>
      <ul className="grid gap-0.5 pl-1">
        {mounts.map((mount, index) => (
          <li key={index}>
            <span className="font-mono text-foreground">{mount.hostPath}</span> →{" "}
            <span className="font-mono text-foreground">{mount.containerPath}</span>
            {mount.readOnly ? " (read-only)" : ""}
          </li>
        ))}
      </ul>
      <p>Edit the group&apos;s mounts on the Groups tab.</p>
    </div>
  );
}

export interface InstallContainerSectionProps {
  mounts: readonly DockerMount[];
  /** The facts' `mountsReadable`: false when the group's mounts can't be read (none are in the command). */
  mountsReadable: boolean;
  displayName: string;
  onDisplayName: (value: string) => void;
  displayNameProblem: string | null;
  env: Omit<EnvVarInputsProps, "target" | "disabled">;
  /** The masked command (`containerPreview`): no bearer. */
  preview: string;
  /** The command with the bearer, once revealed and while every field is valid; null otherwise. */
  command: string | null;
  /** Whether this opening holds a bearer: the reveal is done. */
  revealed: boolean;
  revealing: boolean;
  revealError: string | null;
  noDefaultToken: boolean;
  onReveal: () => void;
  onTokensTab: () => void;
}

export function InstallContainerSection({
  mounts,
  mountsReadable,
  displayName,
  onDisplayName,
  displayNameProblem,
  env,
  preview,
  command,
  revealed,
  revealing,
  revealError,
  noDefaultToken,
  onReveal,
  onTokensTab,
}: InstallContainerSectionProps) {
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted-foreground">{CONTAINER_INTRO}</p>

      {/* Disabled while revealing: a value typed during "Preparing…" would reach the box, not the clipboard. */}
      <DisplayNameField value={displayName} onChange={onDisplayName} problem={displayNameProblem} disabled={revealing} />

      <EnvVarInputs {...env} target="command" disabled={revealing} />

      <MountsList mounts={mounts} />
      {!mountsReadable && <p className="text-xs text-warn">{MOUNTS_UNREADABLE_WORDS}</p>}

      <div className="grid gap-2">
        <p className="text-sm font-medium leading-none">Run command</p>
        {revealed ? (
          command !== null && <SecretCopyBox secret={command} copyLabel="Copy command" multiline />
        ) : (
          <div className="ph-no-capture">
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{preview}</pre>
          </div>
        )}
        {!revealed &&
          (noDefaultToken ? (
            <NoDefaultToken onTokensTab={onTokensTab} />
          ) : (
            <Button type="button" onClick={onReveal} disabled={revealing}>
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
          ))}
      </div>

      <DialogErrorAlert error={revealError} />

      <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>{CONTAINER_WARNING}</p>
      </div>
    </div>
  );
}
