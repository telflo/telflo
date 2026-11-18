import {
  INSTALL_DISPLAY_NAME_MAXIMUM_LENGTH,
  INSTALL_DISPLAY_NAME_RULE,
  INSTALL_MASKED_TOKEN,
  installBundleFileName,
  installDisplayNameProblem,
  installEnvValueProblem,
  installPathProblem,
  shellQuote,
  withoutTrailingSlash,
  type InstallArch,
  type InstallMethod,
} from "@telflo/contracts";

// The Quick Deploy command (D17c-2 decisions 8 and 29; Preflight ruling 14) is the contracts', so the stack's smoke
// prints the dialog's very command; the dialog builds it from the create's reply and the reveal.
export {
  QUICK_DEPLOY_UNIT_NAME,
  QUICK_DEPLOY_UNIT_PATH,
  quickDeployCommands,
  quickDeployPreview,
  quickDeployUnit,
  type QuickDeployCommandParts,
  type QuickDeployPreviewParts,
} from "@telflo/contracts";
export { shellQuote };

/*
 * The install commands (D17c-1 decisions 40 to 42; Preflight rulings 28 and
 * 29), built in the browser from the install's facts (no bearer) and a
 * reveal's bearer: the container's `docker run` (the contracts', re-exported
 * below: D25 decision 36), and the Linux bundle's "Set the token, then run"
 * lines. Pure: no React, no request.
 *
 * Every value is single-quoted once, a `'` written `'\''`, and nothing runs
 * through `bash -c` (quotes nested inside `bash -c '…'` would break a path
 * with a space and run a `$(…)` in the person's shell). A command holding the
 * bearer is a secret (ADR 0024, decision 48): the dialog shows it only inside
 * `ph-no-capture` and puts it on the clipboard only through its copy; the
 * preview holds the masked token, never the bearer (`containerPreview` takes
 * none). The display name, the paths and the variables' values are
 * configuration text.
 */

/** What the preview shows in place of the bearer (16 bullets): the contracts' own. */
export const MASKED_TOKEN = INSTALL_MASKED_TOKEN;

/* ---------------------------------------------------------------------------
 * The person's fields, checked before anything is revealed or sent. The
 * bundle route checks its own with the same rules (the contracts').
 */

export const DISPLAY_NAME_MAXIMUM_LENGTH = INSTALL_DISPLAY_NAME_MAXIMUM_LENGTH;
export const DISPLAY_NAME_RULE = INSTALL_DISPLAY_NAME_RULE;

/**
 * The display name's problem, or null (decision 41): trimmed, empty is no
 * name (an automatic one), else 1 to 80 letters, digits, spaces, dots,
 * dashes and underscores (a `'` is refused, never stripped). The name used
 * is the trimmed one. The contracts' rule, which the Quick Deploy command
 * checks too.
 */
export const displayNameProblem: (raw: string) => string | null = installDisplayNameProblem;

/**
 * An included variable's value's problem, or null (decision 40, Preflight
 * ruling 28): trimmed, then the bundle route's rule (1 to 4,096 characters,
 * no control character, no lone UTF-16 surrogate: D17d-2 Ruling 36, since
 * neither Helm's YAML nor the bundle can carry one), so an included
 * variable with no value is refused before the reveal ("Type a value or
 * untick it."), and one holding a lone surrogate shows the contracts'
 * refusal. The value used, in the command and in the bundle's request
 * alike, is the trimmed one.
 */
export function envValueProblem(raw: string): string | null {
  return installEnvValueProblem(raw.trim());
}

/**
 * The root path's and the executable path's problem, or null (decision 39):
 * the bundle route's own rule (absolute, letters, digits, dots, dashes,
 * underscores and `/`, no `.` or `..` segment, at most 200 characters
 * without its trailing `/`, not the root).
 */
export const absolutePathProblem: (path: string) => string | null = installPathProblem;

/* ---------------------------------------------------------------------------
 * The container command (decision 40): the contracts' (D25 decision 36,
 * Preflight ruling 10), so the public install route answers the dialog's
 * very command; re-exported here so the web's imports stay.
 */

export {
  containerCommand,
  containerPreview,
  OPAMP_VOLUME,
  type ContainerCommandParts,
  type IncludedEnvVar,
} from "@telflo/contracts";

/* ---------------------------------------------------------------------------
 * The Linux bundle's "Set the token, then run" (decisions 41 and 42).
 */

export interface LinuxRunParts {
  method: InstallMethod;
  arch: InstallArch;
  /** Checked by `absolutePathProblem`; its trailing `/` is removed, as the bundle route removes it. */
  rootPath: string;
  /** The reveal's bearer. */
  bearer: string;
  /** Trimmed and checked by `displayNameProblem`; "" for none. */
  displayName: string;
}

/**
 * Four lines: the token exported (`Bearer …`, the bearer in this line
 * only), the root made, the bundle (its file name the contracts', the
 * route's own) unpacked into it, and `start_supervisor.sh` run there as
 * root with the token passed through, the display name as its
 * `--OPAMP_SERVER_NAME=` flag when one is given.
 */
export function linuxRunCommands({ method, arch, rootPath, bearer, displayName }: LinuxRunParts): string {
  const root = shellQuote(withoutTrailingSlash(rootPath));
  const name = displayName === "" ? "" : ` --OPAMP_SERVER_NAME=${shellQuote(displayName)}`;
  return [
    `export OPAMP_TOKEN=${shellQuote(`Bearer ${bearer}`)}`,
    `sudo mkdir -p ${root}`,
    `sudo tar -xzf ${installBundleFileName(method, arch)} -C ${root}`,
    `cd ${root} && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh${name}`,
  ].join("\n");
}
