import { INSTALL_ENV_NAME_PATTERN, INSTALL_MASKED_TOKEN, RESERVED_INSTALL_ENV_NAMES, shellQuote, type InstallFacts } from "./install.js";

/*
 * The install commands the web's dialogs and the public install route
 * build alike, so the API and the web produce byte-identical commands: the
 * container's `docker run` and its masked preview, which the web's
 * `lib/install.ts` re-exports. The Quick Deploy command
 * (`quick-deploy-command.ts`) and the Helm commands (`helm.ts`) are here
 * too; the Linux bundle's "Set the token, then run" lines stay the web's.
 * Pure: no React, no request, no environment.
 *
 * Every value is single-quoted once, a `'` written `'\''`, and nothing runs
 * through `bash -c` (quotes nested inside `bash -c '…'` would break on a path
 * with a space and run a `$(…)` in the person's shell). A command holding the
 * bearer is a secret: the web shows it only inside `ph-no-capture` and puts
 * it on the clipboard only through its copy, the API answers it only in
 * install's `no-store` reply, and neither logs it; the preview holds the
 * masked token, never the bearer (`containerPreview` takes none). The display
 * name, the paths and the variables' values are configuration text.
 */

const RESERVED: ReadonlySet<string> = new Set(RESERVED_INSTALL_ENV_NAMES);

/** The image's own volume: the supervisor's state, its instance uid among it, across restarts. */
export const OPAMP_VOLUME = "telflo-opamp:/app/opamp";

/** An included variable: its name (from the facts' `envVarNames`) and its trimmed value. */
export interface IncludedEnvVar {
  name: string;
  value: string;
}

export interface ContainerCommandParts {
  facts: Pick<InstallFacts, "imageTag" | "endpoint" | "allowInsecureConnections" | "groupId" | "mounts">;
  /** The reveal's bearer. */
  bearer: string;
  /** Trimmed and checked by `installDisplayNameProblem`; "" for none. */
  displayName: string;
  /** The included variables, in the facts' order, each value trimmed and checked by `installEnvValueProblem`. */
  env: readonly IncludedEnvVar[];
}

/**
 * The `docker run` command, one flag a line: the image's volume, a `-v`
 * per group mount (`:ro` when read-only), the group's id, the endpoint,
 * whether insecure connections are allowed, the display name when one is
 * given, the bearer, then a line per included variable, and the image
 * last.
 */
export function containerCommand({ facts, bearer, displayName, env }: ContainerCommandParts): string {
  const lines = ["docker run -d --restart unless-stopped --name telflo-collector", `-v ${OPAMP_VOLUME}`];
  for (const mount of facts.mounts) {
    lines.push(`-v ${shellQuote(`${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`)}`);
  }
  lines.push(`-e COLLECTOR_GROUP_ID=${shellQuote(facts.groupId)}`);
  lines.push(`-e OPAMP_ENDPOINT=${shellQuote(facts.endpoint)}`);
  lines.push(`-e OPAMP_ALLOW_INSECURE_CONNECTIONS=${shellQuote(facts.allowInsecureConnections ? "true" : "false")}`);
  if (displayName !== "") lines.push(`-e OPAMP_SERVER_NAME=${shellQuote(displayName)}`);
  lines.push(`-e OPAMP_TOKEN=${shellQuote(bearer)}`);
  const written = new Set<string>();
  for (const { name, value } of env) {
    // A name comes from the server's scan of the YAML; one that isn't a shell name is a broken contract, never written.
    if (!INSTALL_ENV_NAME_PATTERN.test(name)) throw new Error("An environment variable's name isn't a shell name.");
    // docker keeps the last `-e` of a name: a reserved one (OPAMP_TOKEN, say) would replace the install's own, and a name
    // given twice one of its values. The facts never offer either: a broken contract, never written.
    if (RESERVED.has(name)) throw new Error("An environment variable's name is one the install sets itself.");
    if (written.has(name)) throw new Error("An environment variable is given twice.");
    written.add(name);
    lines.push(`-e ${name}=${shellQuote(value)}`);
  }
  lines.push(shellQuote(facts.imageTag));
  return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join(" \\\n");
}

/** The preview: the same command with the token masked. It takes no bearer, so it can hold none. */
export function containerPreview(parts: Omit<ContainerCommandParts, "bearer">): string {
  return containerCommand({ ...parts, bearer: INSTALL_MASKED_TOKEN });
}
