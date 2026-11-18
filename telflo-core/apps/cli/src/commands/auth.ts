/*
 * `telflo login`, `whoami` and `logout` (D27 decisions 8, 14, 15 and 19).
 *
 * The server is `--server`, else `TELFLO_SERVER`, else the stored login's;
 * with none, login asks for its URL at a terminal (the origin rules of
 * server.ts) and is a usage error otherwise: there is no default server.
 *
 * The token is never on argv: it comes from stdin when stdin isn't a
 * terminal (one line, at most 4 KiB), from the `/cli-auth` page's handoff
 * (the browser flow, with a hidden prompt beside it), or from the hidden
 * prompt alone with `--no-browser`. It must be
 * a `tf_` token (else exit 2, never echoed), is checked with `/whoami` (a
 * 401 stores nothing), then the organization is chosen (a service
 * account's own; for a person, `--org`, the one, or a numbered choice at a
 * terminal), then the file is written. Nothing prints the token, nor its
 * prefix: `whoami` names the token by its name.
 */

import type { Command } from "commander";
import type { PublicOrganization, PublicOrganizations, WhoAmIResponse } from "@telflo/contracts";
import { ApiClient } from "../api.js";
import { deleteCredentials, saveCredentials, storedServer, TOKEN_PATTERN, type TokenKind } from "../credentials.js";
import { clientFor, organizationFromEnvironment, requireLogin } from "../context.js";
import { requireId } from "../ids.js";
import { browserLoginToken } from "../login-browser.js";
import { emit, EXIT, ExitError, terminalText, writeErr, writeNote } from "../output.js";
import { ask, readHidden, readLine, stdinIsTerminal } from "../prompt.js";
import { namedServer, NO_SERVER_MESSAGE, serverOrigin } from "../server.js";

export const NOT_A_TOKEN_MESSAGE = "That isn't a Telflo token (tf_ and 43 characters).";
export const SERVICE_ACCOUNT_WITH_ORG_MESSAGE =
  "A service account's token acts in its own organization: leave out --org (and unset TELFLO_ORG).";
export const NOT_ONE_OF_THEM_MESSAGE = "This token can't act in that organization.";
export const NO_ORGANIZATION_MESSAGE = "This token can't act in any organization.";
export const SEVERAL_ORGANIZATIONS_MESSAGE = "This token can act in several organizations: pass --org <id>.";
export const NOT_A_CHOICE_MESSAGE = "That isn't one of the numbers listed.";
export const SERVER_PROMPT = "The Telflo server's URL (such as https://telflo.example.com):";
export const PASTE_PROMPT = (server: string): string => `Create a token at ${server}/settings/account, then paste it: `;
export const LOGGED_OUT_MESSAGE =
  "Logged out: the credentials file is removed. The token itself still works until it expires or is revoked: " +
  "revoke a personal token on the Account page, a service account's under Settings › Service Accounts.";
export const NOT_LOGGED_IN_LOGOUT_MESSAGE = "No stored login to remove.";
export const ENVIRONMENT_TOKEN_STILL_SET_MESSAGE = "TELFLO_TOKEN is still set in this shell.";
/** Login's one note when `TELFLO_TOKEN` is set: every command reads it before the file. */
export const ENVIRONMENT_TOKEN_SHADOWS_MESSAGE =
  "TELFLO_TOKEN is set in this shell: commands use it, not the login just stored, until it is unset.";

/** How many times a number is asked for before login gives up. */
const CHOICE_ATTEMPTS = 3;

const KIND_WORDS: Readonly<Record<TokenKind, string>> = {
  person: "personal token",
  service_account: "service account token",
};

export interface LoginOptions {
  server?: string;
  org?: string;
  /** commander's `--no-browser`: false when it was given. */
  browser: boolean;
}

/**
 * The server to log in to: the one named (flag, `TELFLO_SERVER`, the stored
 * login's), else, at a terminal, the URL typed at a prompt; else exit 2.
 */
async function loginServer(flag: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const named = namedServer(flag, env, storedServer(env));
  if (named !== undefined) return named;
  if (!stdinIsTerminal()) throw new ExitError(NO_SERVER_MESSAGE, EXIT.USAGE);
  return serverOrigin(await ask(SERVER_PROMPT));
}

/** The token: stdin's line when stdin isn't a terminal, else the terminal's (decision 19). */
async function readToken(server: string, browser: boolean): Promise<string> {
  if (!stdinIsTerminal()) return readLine();
  // The browser flow (decision 20): the `127.0.0.1` listener and the browser
  // opened on `<server>/cli-auth#…`, racing a hidden prompt (login-browser.ts).
  if (browser) return browserLoginToken(server);
  return readHidden(PASTE_PROMPT(server));
}

/** The token as typed, checked for its shape before anything is sent (exit 2, never echoed). */
export function checkedToken(text: string): string {
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) throw new ExitError(NOT_A_TOKEN_MESSAGE, EXIT.USAGE);
  return token;
}

function describeOrganization(organization: Pick<PublicOrganization, "name" | "type" | "role">): string {
  return `${terminalText(organization.name)} (${terminalText(organization.type)}, ${terminalText(organization.role)})`;
}

/** A person's organization at a terminal: the list, numbered as `/orgs` sorts it, and a number typed. */
async function pickAtTerminal(items: readonly PublicOrganization[]): Promise<PublicOrganization> {
  writeErr("This token can act in several organizations:");
  items.forEach((organization, index) => writeErr(`  ${index + 1}. ${describeOrganization(organization)}`));
  for (let attempt = 1; ; attempt += 1) {
    const answer = (await ask("Organization number:")).trim();
    const chosen = /^\d{1,4}$/.test(answer) ? items[Number(answer) - 1] : undefined;
    if (chosen !== undefined) return chosen;
    if (attempt >= CHOICE_ATTEMPTS) throw new ExitError(NOT_A_CHOICE_MESSAGE, EXIT.USAGE);
    writeErr(NOT_A_CHOICE_MESSAGE);
  }
}

/** The organization the login acts in (decision 15). */
async function chooseOrganization(
  client: ApiClient,
  who: WhoAmIResponse,
  requested: string | undefined,
  interactive: boolean,
): Promise<{ id: string; name: string | undefined }> {
  if (who.kind === "service_account" && requested !== undefined) throw new ExitError(SERVICE_ACCOUNT_WITH_ORG_MESSAGE, EXIT.USAGE);
  const { items } = await client.request<PublicOrganizations>("GET", "/orgs", { organization: false });
  if (who.kind === "service_account") {
    return { id: who.organizationId, name: items.find((item) => item.id === who.organizationId)?.name };
  }
  if (requested !== undefined) {
    const chosen = items.find((item) => item.id === requested);
    if (chosen === undefined) throw new ExitError(NOT_ONE_OF_THEM_MESSAGE, EXIT.USAGE);
    return chosen;
  }
  const [only, ...others] = items;
  if (only === undefined) throw new ExitError(NO_ORGANIZATION_MESSAGE, EXIT.AUTH);
  if (others.length === 0) return only;
  if (!interactive) throw new ExitError(SEVERAL_ORGANIZATIONS_MESSAGE, EXIT.USAGE);
  return pickAtTerminal(items);
}

/** `telflo login` (decision 19). */
export async function login(options: LoginOptions, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // The organization's id is checked before anything is asked.
  const requested = options.org === undefined ? organizationFromEnvironment(env) : requireId(options.org, "organization (--org)");
  const server = await loginServer(options.server, env);
  const interactive = stdinIsTerminal();
  const token = checkedToken(await readToken(server, options.browser));
  const client = new ApiClient({ server, token });
  // A 401 ends the login here (exit 3): nothing is stored.
  const who = await client.request<WhoAmIResponse>("GET", "/whoami", { organization: false });
  const organization = await chooseOrganization(client, who, requested, interactive);
  saveCredentials({ version: 1, server, token, kind: who.kind, tokenName: who.tokenName, organizationId: organization.id }, env);
  if (env.TELFLO_TOKEN !== undefined && env.TELFLO_TOKEN.trim() !== "") writeNote(ENVIRONMENT_TOKEN_SHADOWS_MESSAGE);
  const organizationWords = organization.name ?? organization.id;
  emit(
    { server, kind: who.kind, tokenName: who.tokenName, access: who.access, organizationId: organization.id, organizationName: organization.name ?? null },
    () => `Logged in to ${server} as ${terminalText(who.tokenName)} (${terminalText(organizationWords)}).`,
  );
}

/** `telflo whoami`: the server, the token's name and kind, its access and the organization. Never the token. */
export async function whoami(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const current = requireLogin(env);
  const client = clientFor(current);
  const who = await client.request<WhoAmIResponse>("GET", "/whoami", { organization: false });
  const organizationId = who.kind === "service_account" ? who.organizationId : (current.organizationId ?? null);
  let organizationName: string | null = null;
  if (organizationId !== null) {
    const { items } = await client.request<PublicOrganizations>("GET", "/orgs", { organization: false });
    organizationName = items.find((item) => item.id === organizationId)?.name ?? null;
  }
  const organizationWords =
    organizationId === null
      ? "(none: set TELFLO_ORG)"
      : organizationName === null
        ? terminalText(organizationId)
        : `${terminalText(organizationName)} (${terminalText(organizationId)})`;
  emit(
    { server: client.server, source: current.source, kind: who.kind, tokenName: who.tokenName, access: who.access, organizationId, organizationName },
    () =>
      [
        `Server:       ${client.server}`,
        `Token:        ${terminalText(who.tokenName)} (${KIND_WORDS[who.kind]}${current.source === "environment" ? ", from TELFLO_TOKEN" : ""})`,
        `Access:       ${terminalText(who.access)}`,
        `Organization: ${organizationWords}`,
      ].join("\n"),
  );
}

/** `telflo logout`: the file removed; a token can't be revoked from the terminal (decision 14). */
export function logout(env: NodeJS.ProcessEnv = process.env): void {
  const removed = deleteCredentials(env);
  const stillSet = env.TELFLO_TOKEN !== undefined && env.TELFLO_TOKEN !== "";
  emit({ removed }, () =>
    [removed ? LOGGED_OUT_MESSAGE : NOT_LOGGED_IN_LOGOUT_MESSAGE, ...(stillSet ? [ENVIRONMENT_TOKEN_STILL_SET_MESSAGE] : [])].join("\n"),
  );
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Log in with a Telflo token (approved in the browser, pasted at a hidden prompt, or from stdin)")
    .option("--server <url>", "the Telflo server (else TELFLO_SERVER or the stored server; asked for at a terminal when none is set)")
    .option("--org <id>", "the organization a personal token acts in")
    .option("--no-browser", "paste a token instead of approving in the browser")
    .action((options: LoginOptions) => login(options));

  program
    .command("whoami")
    .description("Show the server, token and organization the CLI is using")
    .action(() => whoami());

  program
    .command("logout")
    .description("Remove the stored login")
    .action(() => logout());
}
