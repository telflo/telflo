import { useId, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { withoutTrailingSlash, type InstallMethod } from "@telflo/contracts";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { DisplayNameField } from "./InstallContainerSection.js";
import { EnvVarInputs, type EnvVarInputsProps } from "./EnvVarInputs.js";

/*
 * The install dialog's Linux methods, presentational: the dialog holds
 * the fields and the download.
 *
 * - "Root path" (default `/etc/otelcol`) and, for a host's own collector,
 *   "Path to otelcol-contrib" (default `/usr/bin/otelcol-contrib`), each with
 *   its problem under it; the display name; the environment variables, whose
 *   ticked values the bundle's start script exports (their help the systemd
 *   service's while its box is ticked). "Download" and "Quick Deploy" are the
 *   dialog's footer.
 * - After the variables, the checkbox "Install as a systemd service (starts
 *   on boot)" (ticked at each opening: the dialog's state), its hint as its
 *   description, absent while the organization's public install links are
 *   off (the service comes only with Quick Deploy). Every field is disabled
 *   while a Quick Deploy link is made (`disabled`): the link holds what was
 *   shown.
 * - The hints: All In One's "unpack, then run"; own-binary's
 *   where the configuration and the supervisor's state go (the root path as
 *   typed). The bundle holds no token: the warning says where the dialog
 *   gives it (after the download, or inside the Quick Deploy command).
 * - Privacy: the paths are configuration text, inside
 *   `ph-no-capture` with the hints that repeat them.
 */

export const ALL_IN_ONE_HINT =
  "Unpack the bundle into the root path and run start_supervisor.sh: it downloads the collector and the supervisor into the root path, checks them and starts the supervisor.";
export const LINUX_WARNING =
  "The bundle holds no token: the dialog gives it to you after the download, or inside the Quick Deploy command. Treat it as a secret.";
/** The systemd checkbox's words and hint. */
export const SYSTEMD_LABEL = "Install as a systemd service (starts on boot)";
export const SYSTEMD_HINT =
  "Installs telflo-supervisor.service with sudo so the collector restarts after a reboot or a crash. Comes with Quick Deploy: untick it to download the bundle and run it yourself.";

function PathField({
  label,
  value,
  onChange,
  problem,
  placeholder,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  placeholder: string;
  hint?: ReactNode;
  disabled: boolean;
}) {
  const id = useId();
  const described = [problem !== null ? `${id}-problem` : null, hint !== undefined ? `${id}-hint` : null].filter((each) => each !== null);
  return (
    <div className="ph-no-capture grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null || undefined}
        aria-describedby={described.length > 0 ? described.join(" ") : undefined}
      />
      {problem !== null && (
        <p id={`${id}-problem`} className="text-xs text-fail">
          {problem}
        </p>
      )}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface InstallLinuxSectionProps {
  method: InstallMethod;
  rootPath: string;
  onRootPath: (value: string) => void;
  rootPathProblem: string | null;
  executablePath: string;
  onExecutablePath: (value: string) => void;
  executablePathProblem: string | null;
  displayName: string;
  onDisplayName: (value: string) => void;
  displayNameProblem: string | null;
  env: Omit<EnvVarInputsProps, "target" | "disabled">;
  /** "Install as a systemd service": ticked, Download is disabled and Quick Deploy installs the service. */
  systemd: boolean;
  onSystemd: (value: boolean) => void;
  /** While a Quick Deploy link is made: every field. */
  disabled: boolean;
  /** False while the organization's public install links are off: no systemd box. */
  systemdOffered?: boolean;
}

export function InstallLinuxSection({
  method,
  rootPath,
  onRootPath,
  rootPathProblem,
  executablePath,
  onExecutablePath,
  executablePathProblem,
  displayName,
  onDisplayName,
  displayNameProblem,
  env,
  systemd,
  onSystemd,
  disabled,
  systemdOffered = true,
}: InstallLinuxSectionProps) {
  const systemdId = useId();
  const root = withoutTrailingSlash(rootPath.trim()) || "<root>";
  return (
    <div className="grid gap-4">
      <PathField
        label="Root path"
        value={rootPath}
        onChange={onRootPath}
        problem={rootPathProblem}
        placeholder="/etc/otelcol"
        disabled={disabled}
        hint={
          method === "all-in-one" ? (
            ALL_IN_ONE_HINT
          ) : (
            <>
              The collector&apos;s configuration is written to <span className="font-mono">{root}/otelcol-config.yaml</span> and the
              supervisor&apos;s state to <span className="font-mono">{root}/opamp</span>.
            </>
          )
        }
      />
      {method === "own-binary" && (
        <PathField
          label="Path to otelcol-contrib"
          value={executablePath}
          onChange={onExecutablePath}
          problem={executablePathProblem}
          placeholder="/usr/bin/otelcol-contrib"
          disabled={disabled}
        />
      )}

      <DisplayNameField value={displayName} onChange={onDisplayName} problem={displayNameProblem} disabled={disabled} />

      <EnvVarInputs {...env} target={systemd ? "service" : "bundle"} disabled={disabled} />

      {systemdOffered && (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={systemdId}
              checked={systemd}
              onCheckedChange={(checked) => onSystemd(checked === true)}
              disabled={disabled}
              aria-describedby={`${systemdId}-hint`}
            />
            <Label htmlFor={systemdId} className="cursor-pointer text-sm font-normal">
              {SYSTEMD_LABEL}
            </Label>
          </div>
          <p id={`${systemdId}-hint`} className="pl-6 text-xs text-muted-foreground">
            {SYSTEMD_HINT}
          </p>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>{LINUX_WARNING}</p>
      </div>
    </div>
  );
}
