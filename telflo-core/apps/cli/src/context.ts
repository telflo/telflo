/*
 * The login a command runs with, and the client for it.
 *
 * - `TELFLO_TOKEN` (scripts) wins over the file, and pairs with
 *   `TELFLO_SERVER` only: never the stored server. Without
 *   `TELFLO_SERVER` it is a usage error (there is no default server).
 * - Otherwise the file's token goes only to the file's server:
 *   `TELFLO_SERVER` naming another origin is refused.
 * - `X-Telflo-Org` goes with a person's token only: the file's
 *   organization, or `TELFLO_ORG` for one shell. A service account's token
 *   has its own; `TELFLO_ORG` is refused for it. For `TELFLO_TOKEN`, whose
 *   kind the CLI doesn't know, `/whoami` is asked once, the first time a
 *   route needs the organization.
 */

import { ApiClient, type ClientOptions } from "./api.js";
import { loadCredentials, TOKEN_PATTERN, type Credentials, type TokenKind } from "./credentials.js";
import { requireId } from "./ids.js";
import { EXIT, ExitError } from "./output.js";
import { chooseServer, serverOrigin } from "./server.js";
import type { WhoAmIResponse } from "@telflo/contracts";

export const NOT_LOGGED_IN_MESSAGE = "Not logged in: run telflo login (or set TELFLO_TOKEN).";
export const ENVIRONMENT_TOKEN_MALFORMED_MESSAGE = "TELFLO_TOKEN isn't a Telflo token (tf_ and 43 characters).";
export const SERVICE_ACCOUNT_ORGANIZATION_MESSAGE =
  "A service account's token acts in its own organization: unset TELFLO_ORG (and leave out --org).";
export const PERSON_ORGANIZATION_NEEDED_MESSAGE =
  "A personal token in TELFLO_TOKEN needs TELFLO_ORG: set it to the organization's id (telflo org list shows them).";
export const OTHER_SERVER_MESSAGE = (stored: string, requested: string): string =>
  `The stored login is for ${stored}, not ${requested}: run telflo login --server ${requested}.`;

/** Where the login came from. */
export type LoginSource = "file" | "environment";

export interface Login {
  source: LoginSource;
  server: string;
  token: string;
  /** Known for the file's login; for `TELFLO_TOKEN`, only after `/whoami`. */
  kind: TokenKind | undefined;
  /** The file's token name (`TELFLO_TOKEN`'s is unknown until `/whoami`). */
  tokenName: string | undefined;
  /** The organization a person's token acts in (`TELFLO_ORG` over the file's). */
  organizationId: string | undefined;
  /** The file's own login, for commands that rewrite it (`org use`). */
  stored: Credentials | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** `TELFLO_ORG`, canonicalized (a malformed one is exit 2), or undefined. */
export function organizationFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmpty(env.TELFLO_ORG);
  return value === undefined ? undefined : requireId(value, "TELFLO_ORG");
}

/**
 * The login in force, or null when there is none (no `TELFLO_TOKEN`, no
 * file): the anonymous validate's case. Refusals are ExitErrors.
 */
export function resolveLogin(env: NodeJS.ProcessEnv = process.env): Login | null {
  // Trimmed as login's input is: a variable set from a file often ends with a newline.
  const environmentToken = nonEmpty(env.TELFLO_TOKEN?.trim());
  if (environmentToken !== undefined) {
    if (!TOKEN_PATTERN.test(environmentToken)) throw new ExitError(ENVIRONMENT_TOKEN_MALFORMED_MESSAGE, EXIT.USAGE);
    return {
      source: "environment",
      server: chooseServer(undefined, env, undefined),
      token: environmentToken,
      kind: undefined,
      tokenName: undefined,
      organizationId: organizationFromEnvironment(env),
      stored: undefined,
    };
  }
  const stored = loadCredentials(env);
  if (stored === null) return null;
  const requested = nonEmpty(env.TELFLO_SERVER);
  if (requested !== undefined) {
    const origin = serverOrigin(requested);
    if (origin !== stored.server) throw new ExitError(OTHER_SERVER_MESSAGE(stored.server, origin), EXIT.AUTH);
  }
  const fromEnvironment = organizationFromEnvironment(env);
  if (stored.kind === "service_account" && fromEnvironment !== undefined) {
    throw new ExitError(SERVICE_ACCOUNT_ORGANIZATION_MESSAGE, EXIT.USAGE);
  }
  return {
    source: "file",
    server: stored.server,
    token: stored.token,
    kind: stored.kind,
    tokenName: stored.tokenName,
    organizationId: stored.kind === "person" ? (fromEnvironment ?? stored.organizationId) : stored.organizationId,
    stored,
  };
}

/** The login, or exit 3 "Not logged in". */
export function requireLogin(env: NodeJS.ProcessEnv = process.env): Login {
  const login = resolveLogin(env);
  if (login === null) throw new ExitError(NOT_LOGGED_IN_MESSAGE, EXIT.AUTH);
  return login;
}

/** Extra client options: a test's fetch or clock. */
export type ClientExtras = Pick<ClientOptions, "fetch" | "sleep">;

/**
 * The client for a login: its token to its server only, `X-Telflo-Org` for
 * a person's token. For `TELFLO_TOKEN`, the first route needing the
 * organization asks `/whoami` (once) which kind the token is.
 */
export function clientFor(login: Login, extras: ClientExtras = {}): ApiClient {
  let kind: Promise<TokenKind> | undefined = login.kind === undefined ? undefined : Promise.resolve(login.kind);
  const client: ApiClient = new ApiClient({
    ...extras,
    server: login.server,
    token: login.token,
    organizationId: async () => {
      kind ??= client.request<WhoAmIResponse>("GET", "/whoami", { organization: false }).then((who) => who.kind);
      const known = await kind;
      if (known === "service_account") {
        if (login.source === "environment" && login.organizationId !== undefined) {
          throw new ExitError(SERVICE_ACCOUNT_ORGANIZATION_MESSAGE, EXIT.USAGE);
        }
        return undefined;
      }
      if (login.organizationId === undefined) throw new ExitError(PERSON_ORGANIZATION_NEEDED_MESSAGE, EXIT.USAGE);
      return login.organizationId;
    },
  });
  return client;
}

/** The logged-in client, or exit 3. */
export function requireClient(env: NodeJS.ProcessEnv = process.env, extras: ClientExtras = {}): ApiClient {
  return clientFor(requireLogin(env), extras);
}

/** A client with no token, for the open routes (the anonymous validate): `TELFLO_SERVER`, else exit 2. */
export function anonymousClient(env: NodeJS.ProcessEnv = process.env, extras: ClientExtras = {}): ApiClient {
  return new ApiClient({ ...extras, server: chooseServer(undefined, env, undefined) });
}

