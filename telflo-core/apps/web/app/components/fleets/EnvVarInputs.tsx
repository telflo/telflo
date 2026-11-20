import { useId, type ReactNode } from "react";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";

/*
 * The install dialog's environment variables: the variables the group's
 * published version reads with `${env:NAME}` (the facts' `envVarNames`,
 * found on the server), each opt-in. Nothing when there are none.
 *
 * - One row per name: a checkbox "Include {NAME}" (unticked), and once
 *   ticked a value input (placeholder "value"); an unticked row's note "set
 *   on the host" ("set in the service" for the systemd service). The values
 *   live in the dialog, shared by its methods, and leave it only into the
 *   command or the bundle's request: never stored.
 * - A Linux method with "Install as a systemd service" ticked (`target`
 *   "service") says the service doesn't see the shell's variables
 *   (systemd starts it with its own clean environment) and how to give it
 *   one: `sudo systemctl edit telflo-supervisor`, an `Environment=` line
 *   for a plain value, an `EnvironmentFile=` naming a root-only file for
 *   a secret (systemd shows `Environment=` values to every user), which
 *   start_supervisor.sh passes on to the collector.
 * - Privacy: a name is configuration text, so it is visible text only, never
 *   an attribute: the ids are `useId`'s and the row's index, the checkbox is
 *   named by its `<label>`, the value input by `aria-labelledby` pointing at
 *   the name's text (never an `aria-label`, an `id` or a `title`). The rows
 *   sit inside `ph-no-capture`, so replay records neither the names nor the
 *   values; a value input's `value` (React writes a controlled input's) is
 *   the one attribute holding a typed value, inside it.
 * - A row's problem (`problems`, keyed by name: "Type a value or untick
 *   it.", the bundle route's own words for a 400) shows under it.
 * - The Helm install (`target` "helm") writes the ticked values into
 *   values.yaml's `collectorEnv`, which reaches the pods through a Secret;
 *   an unticked row's note "set in the cluster". Every offered name is a
 *   row like any other, a YAML 1.1 word's too (the platform's chart quotes
 *   the keys).
 */

/** A variable's row: whether it is included, and its value as typed. */
export interface EnvVarChoice {
  included: boolean;
  value: string;
}

/** By name: a Map, never a plain object, so a name such as `constructor` or `__proto__` reads nothing inherited. */
export type EnvVarChoices = ReadonlyMap<string, EnvVarChoice>;

/** The container's help, the Linux bundle's, and the systemd service's. */
const HELP_START = "This group's published version reads these variables with ";
const HELP_COMMAND = ". Tick one to set its value here; unticked variables are left out of the command: set them on the host.";
const HELP_BUNDLE =
  ". Tick one to set its value here; unticked variables are left out of the bundle: set them on the host. Ticked values are written into the bundle's start script: keep the bundle private if they are secrets.";
const HELP_SERVICE = (
  <>
    . Tick one to set its value here. The systemd service doesn&apos;t see variables set in your shell: tick them here, or give them to the
    service afterwards with <span className="font-mono">sudo systemctl edit telflo-supervisor</span> (an{" "}
    <span className="font-mono">Environment=NAME=value</span> line for a plain value; for a secret, an{" "}
    <span className="font-mono">EnvironmentFile=</span> line naming a file only root can read, since{" "}
    <span className="font-mono">Environment=</span> values are visible to every user on the host), then restart it. Ticked values are written
    into the bundle&apos;s start script (root only): keep the link private if they are secrets.
  </>
);
/** The Helm install's. */
const HELP_HELM =
  ". Tick one to set its value here; ticked values are written into values.yaml's collectorEnv and reach the pods through a Secret; unticked variables are left out: give them to the pods yourself.";
const HELP: Record<EnvVarInputsProps["target"], ReactNode> = {
  command: HELP_COMMAND,
  bundle: HELP_BUNDLE,
  service: HELP_SERVICE,
  helm: HELP_HELM,
};
/** An unticked row's note. */
const UNTICKED: Record<EnvVarInputsProps["target"], string> = {
  command: "set on the host",
  bundle: "set on the host",
  service: "set in the service",
  helm: "set in the cluster",
};

export interface EnvVarInputsProps {
  names: readonly string[];
  choices: EnvVarChoices;
  onChange: (name: string, choice: EnvVarChoice) => void;
  /** Each row's problem, by name: shown under it. */
  problems: ReadonlyMap<string, string>;
  /** Too many ticked for the bundle (at most 50): shown under the rows. */
  countProblem?: string | null;
  /**
   * "command": the container's `-e` lines; "bundle": the Linux start script's exports; "service": those
   * exports too, the bundle installed as the systemd service ("Install as a systemd service" ticked); "helm":
   * values.yaml's `collectorEnv`.
   */
  target: "command" | "bundle" | "service" | "helm";
  disabled?: boolean;
}

export function EnvVarInputs({ names, choices, onChange, problems, countProblem = null, target, disabled = false }: EnvVarInputsProps) {
  const idPrefix = useId();
  if (names.length === 0) return null;
  return (
    <div className="ph-no-capture grid gap-2">
      <p className="text-sm font-medium leading-none">
        Configuration environment variables <span className="text-muted-foreground">(optional)</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {HELP_START}
        <span className="font-mono">{"${env:…}"}</span>
        {HELP[target]}
      </p>
      <div className="grid gap-2">
        {names.map((name, index) => {
          const rowId = `${idPrefix}-env-${index}`;
          const choice = choices.get(name) ?? { included: false, value: "" };
          const problem = choice.included ? problems.get(name) : undefined;
          return (
            <div key={name} className="grid gap-1">
              <div className="grid min-h-8 grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2">
                <Checkbox
                  id={`${rowId}-include`}
                  checked={choice.included}
                  onCheckedChange={(checked) => onChange(name, { ...choice, included: checked === true })}
                  disabled={disabled}
                />
                <Label htmlFor={`${rowId}-include`} className="cursor-pointer truncate text-xs font-normal">
                  Include{" "}
                  <span id={`${rowId}-name`} className="font-mono">
                    {name}
                  </span>
                </Label>
                {choice.included ? (
                  <Input
                    id={`${rowId}-value`}
                    aria-labelledby={`${rowId}-name`}
                    value={choice.value}
                    onChange={(event) => onChange(name, { ...choice, value: event.target.value })}
                    placeholder="value"
                    className="h-8 font-mono text-xs"
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={problem !== undefined || undefined}
                    aria-describedby={problem !== undefined ? `${rowId}-problem` : undefined}
                  />
                ) : (
                  <span className="truncate text-xs italic text-muted-foreground">{UNTICKED[target]}</span>
                )}
              </div>
              {problem !== undefined && (
                <p id={`${rowId}-problem`} className="text-xs text-fail">
                  {problem}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {countProblem !== null && <p className="text-xs text-fail">{countProblem}</p>}
    </div>
  );
}
