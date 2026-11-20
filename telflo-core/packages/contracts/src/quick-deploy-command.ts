import { INSTALL_MASKED_TOKEN, installDisplayNameProblem, installPathProblem, shellQuote, withoutTrailingSlash } from "./install.js";
import { QUICK_DEPLOY_MASKED_SECRET, QUICK_DEPLOY_URL_PATTERN } from "./quick-deploy.js";

/*
 * The Quick Deploy command, built from a link's create reply (its `url`,
 * the one copy of the link's secret) and the reveal of the link's default
 * token. The install dialog builds it in the browser; the stack's smoke
 * prints it through the API's image, so both run this very text. Pure: no
 * request, no environment.
 *
 * The whole command is a subshell: `(` alone on the first line, `)` at
 * the end of the last command's line (`… restart telflo-supervisor.service )`,
 * `… ./start_supervisor.sh )`), never on a line of its own. The token is
 * exported only inside it, so it never reaches the ENVIRONMENT of the
 * person's shell (nor does the `cd` move that shell). It does reach the
 * shell's HISTORY: the pasted command, the bearer and the link's secret in
 * it, stays there, as the install dialog's own commands do. The paste's exit
 * status is the chain's: an Ansible `shell:` task, or any script, sees a
 * refused download fail, and a shell running with `set -e` (errexit)
 * stops, or closes, there; for a script or Ansible that is intended.
 * Inside, every value is single-quoted once, and every line of the command
 * after `(` but the last ends in ` &&` (the heredoc's body and its closing
 * `UNIT` line are the unit's text, not the command's lines: the and-list
 * goes on after `UNIT`): a refused download (curl's `-f` writes nothing,
 * tar then fails on the empty stream, 2) stops the command there, so a
 * revoked link never writes `opamp.env` or restarts an earlier install.
 * No `set -e` inside (a failed step already stops the `&&` chain, so
 * errexit would add nothing, and how it acts in subshells and command
 * substitutions varies from shell to shell), no `bash -c '…'`, no unquoted
 * heredoc, no `-L` (a redirect would carry the secret elsewhere).
 *
 * The command is for a POSIX-style shell (bash, sh, dash, zsh). Pasted
 * into an interactive csh or tcsh, which reads it line by line and runs
 * each line that parses, NO line of it runs: the `(` line and the last
 * line hold an unbalanced paren ("Too many ('s.", "Too many )'s."), every
 * line between ends in a dangling ` &&` ("Invalid null command."), and the
 * unit's text names no command. That is why `)` shares the last command's
 * line: alone, it left the line before it whole, and csh ran that line
 * (the service's restart, or the start script).
 *
 * curl starts `-q` (its first argument, or it isn't honored: no
 * `~/.curlrc` of the person's applies, a `location`, `proxy` or
 * `trace-ascii` line in it among them) and `-g` (no globbing: a bracketed
 * IPv6 base reaches it whole, whatever curl's version). `--retry 3`: curl
 * retries only a transient failure (a timeout, or a 408, 429, 500, 502, 503
 * or 504 reply) and honors its `Retry-After` (the cap's 503 and the
 * per-IP 429 carry one), so a fleet-wide rollout rides out a busy moment
 * (curl's `-S` still prints each refused try's error, even when a retry
 * then succeeds); a 404, 409 or 410 (an unknown, unusable, revoked or
 * expired link) is never retried, and `-f` writes nothing for it.
 *
 * The secrets are on no process's command line: the link reaches curl on
 * its standard input as a config line (`-K -`), and the bearer reaches
 * `opamp.env` from the shell's own environment, both through `printf`, a
 * builtin in every shell. As a systemd service, `install -m 600` creates
 * `opamp.env` root's and 0600 from its standard input (no window, a re-run
 * replacing it) in the start script's own format (`OPAMP_TOKEN='…'`); the
 * unit goes the same way, `install -m 644` (root's and 0644 whatever the
 * person's umask) from a QUOTED heredoc (`<<'UNIT'`: nothing in it
 * expands), then the service is reloaded, enabled and restarted (a re-run
 * takes effect).
 *
 * The command holds the bearer and the link's secret: a secret as an install
 * command is: shown only inside `ph-no-capture`, on the clipboard
 * only by its copy, never in a URL, toast, log, error or audit row. The
 * preview (`quickDeployPreview`) takes no bearer and masks the secret.
 */

/** The service the systemd variant installs, and its unit's path. */
export const QUICK_DEPLOY_UNIT_NAME = "telflo-supervisor.service";
export const QUICK_DEPLOY_UNIT_PATH = `/etc/systemd/system/${QUICK_DEPLOY_UNIT_NAME}`;

/**
 * A bearer as the opamp-server seals it (standard base64,
 * `tokens/tokens.go`): nothing in it is special inside the shell's `'…'`,
 * `opamp.env`'s `'…'` or the start script's reading of it. Helm's values
 * (`helm.ts`) check their `token` by it too.
 */
export const BEARER_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface QuickDeployCommandParts {
  /** The create's `url`: `{TELFLO_PUBLIC_API_URL}/api/v1/quick-deploy/{secret}` (`QUICK_DEPLOY_URL_PATTERN`). */
  url: string;
  /** Checked by `installPathProblem`; its trailing `/` removed, as the bundle's root path. */
  rootPath: string;
  /** The reveal's bearer (the link's default token's), without `Bearer `. */
  bearer: string;
  /** Trimmed and checked by `installDisplayNameProblem`; "" for none. */
  displayName: string;
  /** "Install as a systemd service" (the default), else the foreground. */
  systemd: boolean;
}

/** The preview's parts: no bearer, so it can hold none. */
export type QuickDeployPreviewParts = Omit<QuickDeployCommandParts, "bearer">;

/** The backstops (the dialog checks the fields first): anything else is a broken contract, never written into a root's command. */
function checkedLink(url: string): string {
  if (!QUICK_DEPLOY_URL_PATTERN.test(url)) throw new Error("The install link isn't one the API makes.");
  return url;
}

function checkedRoot(rootPath: string): string {
  if (installPathProblem(rootPath) !== null) throw new Error("The root path isn't one an install takes.");
  return withoutTrailingSlash(rootPath);
}

function checkedName(displayName: string): string {
  if (displayName !== displayName.trim() || installDisplayNameProblem(displayName) !== null) {
    throw new Error("The display name isn't one an install takes.");
  }
  return displayName;
}

/**
 * The unit's text: the root unquoted (its charset holds no
 * space, `%`, `$`, `"` or `\`), and the display name on `ExecStart=` as one
 * double-quoted argument (letters, digits, spaces, `.`, `_`, `-`: nothing
 * systemd reads specially), so a restart keeps it.
 */
export function quickDeployUnit(rootPath: string, displayName: string): string {
  const root = checkedRoot(rootPath);
  const name = checkedName(displayName);
  return [
    "[Unit]",
    "Description=Telflo OpAMP Supervisor",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `ExecStart=${root}/start_supervisor.sh${name === "" ? "" : ` "--OPAMP_SERVER_NAME=${name}"`}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
}

/** The lines, with `link` and `token` as given: the real ones, or the preview's masks. */
function quickDeployLines(link: string, https: boolean, token: string, rootPath: string, displayName: string, systemd: boolean): string {
  const root = checkedRoot(rootPath);
  const name = checkedName(displayName);
  const quotedRoot = shellQuote(root);
  // `--proto '=https'` only for an https link: development's http link would be refused.
  const proto = https ? " --proto '=https'" : "";
  const lines = [
    // The subshell's opening, alone: the token exported inside it only.
    "(",
    `export OPAMP_TOKEN=${shellQuote(`Bearer ${token}`)} &&`,
    `sudo mkdir -p ${quotedRoot} &&`,
    `printf 'url = "%s"\\n' ${shellQuote(link)} | curl -q -g -fsS --retry 3${proto} -K - | sudo tar -xzf - -C ${quotedRoot} &&`,
  ];
  if (!systemd) {
    const flag = name === "" ? "" : ` --OPAMP_SERVER_NAME=${shellQuote(name)}`;
    // The subshell's closing on the last command's line, never alone (csh and tcsh then run no line).
    lines.push(`cd ${quotedRoot} && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh${flag} )`);
    return lines.join("\n");
  }
  lines.push(
    `printf "OPAMP_TOKEN='%s'\\n" "$OPAMP_TOKEN" | sudo install -m 600 /dev/stdin ${shellQuote(`${root}/opamp.env`)} &&`,
    // The heredoc's body follows the line its `<<'UNIT' &&` ends; the and-list goes on after the delimiter.
    `sudo install -m 644 /dev/stdin ${QUICK_DEPLOY_UNIT_PATH} <<'UNIT' &&`,
    quickDeployUnit(root, name),
    "UNIT",
    // The subshell's closing on the last command's line, never alone (csh and tcsh then run no line).
    `sudo systemctl daemon-reload && sudo systemctl enable ${QUICK_DEPLOY_UNIT_NAME} && sudo systemctl restart ${QUICK_DEPLOY_UNIT_NAME} )`,
  );
  return lines.join("\n");
}

/**
 * The Quick Deploy command: the foreground variant, or (`systemd`) the
 * service's. Throws on a link, a bearer, a root path or a display name
 * outside its rule (a broken contract).
 */
export function quickDeployCommands({ url, rootPath, bearer, displayName, systemd }: QuickDeployCommandParts): string {
  const link = checkedLink(url);
  if (!BEARER_PATTERN.test(bearer)) throw new Error("The bearer isn't one the opamp-server seals.");
  return quickDeployLines(link, link.startsWith("https://"), bearer, rootPath, displayName, systemd);
}

/**
 * The preview: the command with the bearer `••••••••••••••••`
 * and the link's secret `tqd_••••••••`, its base kept. It takes no bearer,
 * so it can hold none; it holds no character of the secret.
 */
export function quickDeployPreview({ url, rootPath, displayName, systemd }: QuickDeployPreviewParts): string {
  const link = checkedLink(url);
  const masked = `${link.slice(0, link.lastIndexOf("/") + 1)}${QUICK_DEPLOY_MASKED_SECRET}`;
  return quickDeployLines(masked, link.startsWith("https://"), INSTALL_MASKED_TOKEN, rootPath, displayName, systemd);
}
