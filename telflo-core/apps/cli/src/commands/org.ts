/*
 * `telflo org list` and `telflo org use <id>`: a person's token switches
 * organization without logging in again. `org list` reads `/orgs` (the
 * current one marked); `org use` checks the id against `/orgs`,
 * canonicalized, then stores it. `TELFLO_ORG` overrides the stored one for
 * one shell.
 */

import type { Command } from "commander";
import type { PublicOrganizations, WhoAmIResponse } from "@telflo/contracts";
import { saveCredentials } from "../credentials.js";
import { clientFor, requireLogin } from "../context.js";
import { requireId } from "../ids.js";
import { emit, EXIT, ExitError, printTable, terminalText } from "../output.js";

export const ORG_USE_WITH_ENVIRONMENT_TOKEN_MESSAGE =
  "telflo org use changes the stored login: with TELFLO_TOKEN, set TELFLO_ORG instead.";
export const ORG_USE_SERVICE_ACCOUNT_MESSAGE = "A service account's token acts in its own organization: there is nothing to switch.";
export const ORG_USE_NOT_ONE_OF_THEM_MESSAGE = "This token can't act in that organization (telflo org list shows the ones it can).";

/**
 * `telflo org list`. The current one: a person's (`TELFLO_ORG` over the
 * file's); a service account's own, never `TELFLO_ORG` (for `TELFLO_TOKEN`,
 * whose kind is unknown, `/whoami` says which).
 */
export async function listOrganizations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const login = requireLogin(env);
  const client = clientFor(login);
  let current = login.organizationId ?? null;
  if (login.kind === undefined) {
    const who = await client.request<WhoAmIResponse>("GET", "/whoami", { organization: false });
    if (who.kind === "service_account") current = who.organizationId;
  }
  const { items } = await client.request<PublicOrganizations>("GET", "/orgs", { organization: false });
  emit({ items, current }, () =>
    printTable(
      items.map((item) => ({ current: item.id === current ? "*" : "", ...item })),
      ["current", "id", "name", "type", "role"],
    ),
  );
}

/** `telflo org use <id>`: the stored login's organization, for a person's token from the file. */
export async function useOrganization(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const organizationId = requireId(id, "organization");
  const login = requireLogin(env);
  if (login.stored === undefined) throw new ExitError(ORG_USE_WITH_ENVIRONMENT_TOKEN_MESSAGE, EXIT.USAGE);
  if (login.stored.kind === "service_account") throw new ExitError(ORG_USE_SERVICE_ACCOUNT_MESSAGE, EXIT.USAGE);
  const { items } = await clientFor(login).request<PublicOrganizations>("GET", "/orgs", { organization: false });
  const chosen = items.find((item) => item.id === organizationId);
  if (chosen === undefined) throw new ExitError(ORG_USE_NOT_ONE_OF_THEM_MESSAGE, EXIT.USAGE);
  saveCredentials({ ...login.stored, organizationId: chosen.id }, env);
  emit({ organizationId: chosen.id, organizationName: chosen.name }, () => `Now using ${terminalText(chosen.name)} (${chosen.id}).`);
}

export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("List and switch the organization a personal token acts in");
  org
    .command("list")
    .description("List the organizations the token can act in (* the current one)")
    .action(() => listOrganizations());
  org
    .command("use")
    .description("Switch the stored login to another organization")
    .argument("<id>", "the organization's id")
    .action((id: string) => useOrganization(id));
}
