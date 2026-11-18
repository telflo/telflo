import { API_TOKEN_PATTERN } from "@telflo/contracts";
import type { ApiTokenAccess, Database, OrganizationRole } from "@telflo/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createApiTokenContext, withDatabaseContext, type ApiTokenContext, type ApiTokenKind } from "../../database/context.js";
import type { ApiTokenFailureLimiter } from "../../http/rate-limits.js";
import { createPersonalApiTokenRepository } from "../account/repositories/personal-api-token-repository.js";
import { organizationAccessDenied } from "../organizations/errors.js";
import { findLiveMembershipRole } from "../organizations/repositories/organization-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import {
  createApiTokenRepository,
  findLiveApiTokenByHash,
  type LiveApiToken,
} from "../service-accounts/repositories/api-token-repository.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import { invalidApiToken, organizationRequired } from "./errors.js";

/*
 * The token check (D22 decisions 11 and 33 to 38; Preflight rulings 9 to
 * 12): the one entry of the public surface, `/api/public/v1/`. The only
 * caller of `findLiveApiTokenByHash` and of `createApiTokenContext`
 * (database/context-source.test.ts scans for others).
 *
 * A `tf_` token is a secret like a bearer (decision 48): it is read from the
 * header, hashed and dropped. Nothing here logs it, puts it in an error or
 * keeps it on the request; the request log carries no headers
 * (http/request-log.ts). Log lines hold the token's id only.
 *
 * No terms check (decision 35; D25 decision 10): a service account never
 * accepts the terms, and a terms bump locks none out; a person's token
 * neither. No CSRF header: the guard covers `/api/v1/` only (http/csrf.ts),
 * and a browser never attaches a bearer on its own.
 *
 * Two steps (D25 decisions 21 to 24 and 26; Ruling 160), the plugin's
 * per-token count between them:
 *   1. the token check (`createAuthenticateApiToken`): the lookup answers a
 *      service account's token with its organization and role, so its
 *      context is built at once; a person's own token is accepted with no
 *      organization yet;
 *   2. the organization check (`createApiTokenOrganizationCheck`): for a
 *      person, `X-Telflo-Org` names the organization and their live
 *      membership there is read on this request (no cache), giving the
 *      context with their live role. A service account's token ignores the
 *      header.
 */

/**
 * Who the request acts as, once the token check accepted it (D22 decision
 * 37; D25 Preflight ruling 5): the token's context, its user's address (for
 * audit rows and the opamp-server's actor, D25 decision 12: personal data,
 * never logged), its kind and its id.
 */
export interface RequestApiTokenAuthentication {
  context: ApiTokenContext;
  email: string;
  kind: ApiTokenKind;
  tokenId: string;
}

/**
 * The token the check accepted (D25 decisions 21 and 24), before any
 * organization is known: whose it is, its id, its user and their address
 * (personal data, never logged), and its access. A service account's
 * request also has its `RequestApiTokenAuthentication` at once; a person's
 * gets one from the organization check, when X-Telflo-Org names an
 * organization they are a live member of.
 */
export interface AcceptedApiToken {
  kind: ApiTokenKind;
  tokenId: string;
  userId: string;
  email: string;
  access: ApiTokenAccess;
}

/** The check itself: run by the public plugin's `onRequest` (D25 decision 13), or as a route's preHandler. */
export type ApiTokenCheck = (request: FastifyRequest) => Promise<void>;

/**
 * Whether a route needs a personal token's organization (D25 decision 24):
 * `required` everywhere but the routes declaring `organization: "optional"`
 * (`/whoami`, `/orgs`), where a header that is sent is still checked.
 */
export type ApiTokenOrganizationRequirement = "required" | "optional";

/** The organization check: run by the public plugin's `onRequest` after the per-token count, or as a route's preHandler. */
export type ApiTokenOrganizationCheck = (request: FastifyRequest, requirement: ApiTokenOrganizationRequirement) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest {
    /** Null unless the route runs the token check and it accepted the request. */
    apiToken: AcceptedApiToken | null;
    /**
     * Null unless the token check accepted the request AND its organization
     * is known: a service account's at once; a person's once the
     * organization check accepted X-Telflo-Org.
     */
    apiTokenAuthentication: RequestApiTokenAuthentication | null;
  }
}

/** Declares the request properties' shapes once, for every request (Fastify's decorator guidance). */
export function decorateApiTokenAuthentication(server: FastifyInstance): void {
  server.decorateRequest("apiToken", null);
  server.decorateRequest("apiTokenAuthentication", null);
}

/**
 * The token whose "Last used" is written (decision 38): a service account's
 * context, or a person's token, which has no organization yet (D25 decision
 * 21: written in `{ userId, organizationId: null }`).
 */
export interface ApiTokenUse {
  kind: ApiTokenKind;
  tokenId: string;
  userId: string;
  organizationId: string | null;
}

/** What the checks read and write in the database, apart so their unit tests can count and fail them. */
export interface ApiTokenStore {
  /** The definer lookup, by the token's hash at the API's clock: undefined for every refusal alike. */
  findLive(tokenHash: string, at: Date): Promise<LiveApiToken | undefined>;
  /** "Last used" (decision 38): a service account's in its own context; a person's in theirs, with no organization. */
  touchLastUsed(token: ApiTokenUse, at: Date): Promise<void>;
  /**
   * A person's live role in a live organization (D25 decision 24), read in
   * `{ userId, organizationId }` on every request: undefined for an
   * unknown or deleted organization and for one they aren't a live member
   * of, alike.
   */
  findRole(userId: string, organizationId: string): Promise<OrganizationRole | undefined>;
}

/** The store over the API's pool: the lookup needs no context; the rest runs in the token's user's. */
export function createApiTokenStore(db: Kysely<Database>): ApiTokenStore {
  return {
    findLive: (tokenHash, at) => findLiveApiTokenByHash(db, tokenHash, at),
    async touchLastUsed(token, at) {
      if (token.kind === "person") {
        // Row-level security on personal_api_tokens reads the user alone (D25 decision 21).
        await withDatabaseContext(db, { userId: token.userId, organizationId: null }, (transaction) =>
          createPersonalApiTokenRepository(transaction).touchLastUsed(token.userId, token.tokenId, at),
        );
        return;
      }
      const organizationId = token.organizationId;
      if (organizationId === null) throw new Error("a service account's token names its organization");
      await withDatabaseContext(db, { userId: token.userId, organizationId }, (transaction) =>
        createApiTokenRepository(transaction, { organizationId }).touchLastUsed(token.tokenId, at),
      );
    },
    findRole: (userId, organizationId) =>
      withDatabaseContext(db, { userId, organizationId }, (transaction) =>
        findLiveMembershipRole(transaction, userId, organizationId),
      ),
  };
}

export interface AuthenticateApiTokenDependencies {
  store: ApiTokenStore;
  failures: ApiTokenFailureLimiter;
  /** The API's clock: expiry is judged by it, never the database's. */
  now: () => Date;
}

/** The scheme and its one space (RFC 7235: the scheme case aside). */
const BEARER_SCHEME = "bearer ";

/** The token of an `Authorization` header: `Bearer`, one space, then exactly a `tf_` token; undefined otherwise. */
function tokenOf(header: string): string | undefined {
  if (header.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return undefined;
  const token = header.slice(BEARER_SCHEME.length);
  return API_TOKEN_PATTERN.test(token) ? token : undefined;
}

/** A Postgres error's code (`23514`), or Node's (`ECONNREFUSED`): never its message or detail, which may hold values. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * The public routes' token check, decision 34's order exactly (run by the
 * public plugin's `onRequest` since D25, before any body is read), with
 * Preflight ruling 11's count (Ruling 100: in flight until settled):
 *   1. the client address's failure budget: blocked → 429 `rate_limited`
 *      with Retry-After (the window's remaining time; 1 second when only
 *      attempts in flight fill it), before the header is read;
 *   2. no `Authorization` header → the 401, counting nothing (it guesses
 *      nothing); any header, whatever its scheme, counts one attempt now,
 *      in flight, before the lookup, so parallel guesses can't outrun the
 *      count;
 *   3. the header's form: `Bearer`, one space, a `tf_` token; else the
 *      attempt fails (a settled failure) and the 401;
 *   4. the lookup by its hash at the API's clock: no row → the attempt
 *      fails and the 401;
 *   5. accepted: the request's own attempt is refunded (the window and the
 *      address's other failures stand), so whatever follows (a person's
 *      refused organization included, D25 decision 24) never counts;
 *   6. the accepted token, and a service account's context (its
 *      organization and role from the lookup); a person's waits for the
 *      organization check;
 *   7. "Last used", best-effort: a failure is logged with the token's id and
 *      the error's code only, and never refuses the request.
 * A lookup that throws (a server failure, not a failed token) refunds its
 * attempt too, and surfaces as the error handler's 500: a try/finally
 * refunds any attempt left unsettled, whatever throws (Ruling 105).
 */
export function createAuthenticateApiToken({ store, failures, now }: AuthenticateApiTokenDependencies): ApiTokenCheck {
  return async (request) => {
    const ip = request.ip;
    failures.assertNotBlocked(ip);
    const header = request.headers.authorization;
    if (header === undefined) throw invalidApiToken();
    const attempt = failures.begin(ip);
    // Settling is structural (Ruling 105): whatever leaves this block
    // unsettled (the lookup throwing, or anything else that throws) is
    // refunded on the way out; settling twice does nothing, so the refusals'
    // fail() and the acceptance's refund() stand.
    try {
      const token = tokenOf(header);
      if (token === undefined) {
        attempt.fail();
        throw invalidApiToken();
      }
      const at = now();
      const found: LiveApiToken | undefined = await store.findLive(apiTokenHash(token), at);
      // A service account's always names its organization and role, and a
      // person's names neither (decision 21); a row otherwise is refused as
      // an unknown one. The checks keep the types honest.
      const isServiceAccount =
        found?.kind === "service_account" && found.organizationId !== null && found.role !== null;
      const isPerson = found?.kind === "person" && found.organizationId === null && found.role === null;
      if (found === undefined || (!isServiceAccount && !isPerson)) {
        attempt.fail();
        throw invalidApiToken();
      }
      attempt.refund();
      const accepted: AcceptedApiToken = Object.freeze({
        kind: found.kind,
        tokenId: found.tokenId,
        userId: found.userId,
        email: found.email,
        access: found.access,
      });
      let context: ApiTokenContext | undefined;
      if (found.kind === "service_account" && found.organizationId !== null && found.role !== null) {
        context = createApiTokenContext({
          userId: found.userId,
          organizationId: found.organizationId,
          role: found.role,
          kind: found.kind,
          tokenId: found.tokenId,
          access: found.access,
        });
      }
      try {
        await store.touchLastUsed(
          context ?? { kind: found.kind, tokenId: found.tokenId, userId: found.userId, organizationId: null },
          at,
        );
      } catch (error) {
        request.log.warn({ tokenId: found.tokenId, code: codeOf(error) }, "an API token's last use wasn't recorded");
      }
      request.apiToken = accepted;
      if (context !== undefined) {
        request.apiTokenAuthentication = { context, email: found.email, kind: found.kind, tokenId: found.tokenId };
      }
    } finally {
      attempt.refund();
    }
  };
}

/** The header naming a personal token's organization (D25 decision 24): an organization's id only. */
const ORGANIZATION_HEADER = "x-telflo-org";

/**
 * The organization check (D25 decision 24; Preflight ruling 14), after the
 * token check and the per-token count (Ruling 160):
 *   - a service account's token: nothing to do; it ignores X-Telflo-Org
 *     (decision 23);
 *   - a person's token, no header: `required` answers 400
 *     `organization_required`; `optional` leaves the organization unknown
 *     (`/whoami` answers null);
 *   - a header that is sent, on any route: not a uuid (`canonicalIdOf`) →
 *     400 `organization_required`; else the person's live membership in
 *     that live organization, read now in `{ userId, organizationId }`
 *     (no cache, so a removal or a role change takes effect on the next
 *     request): none (an unknown, a deleted, or another organization,
 *     alike) → 403 `organization_access_denied`; found → the context, with
 *     their live role.
 * Nothing here counts toward the token failure limit (decision 24): the
 * token was accepted, and its attempt already refunded.
 */
export function createApiTokenOrganizationCheck({ store }: { store: Pick<ApiTokenStore, "findRole"> }): ApiTokenOrganizationCheck {
  return async (request, requirement) => {
    const accepted = requireAcceptedApiToken(request);
    if (accepted.kind !== "person") return;
    const header = request.headers[ORGANIZATION_HEADER];
    if (header === undefined) {
      if (requirement === "optional") return;
      throw organizationRequired();
    }
    // A repeated header arrives as a list (or joined): never one uuid, so the same 400.
    const organizationId = typeof header === "string" ? canonicalIdOf(header) : undefined;
    if (organizationId === undefined) throw organizationRequired();
    const role = await store.findRole(accepted.userId, organizationId);
    if (role === undefined) throw organizationAccessDenied();
    const context = createApiTokenContext({
      userId: accepted.userId,
      organizationId,
      role,
      kind: accepted.kind,
      tokenId: accepted.tokenId,
      access: accepted.access,
    });
    request.apiTokenAuthentication = { context, email: accepted.email, kind: accepted.kind, tokenId: accepted.tokenId };
  };
}

/**
 * For handlers behind the token check that need no organization (a
 * person's `/whoami` and `/orgs` without X-Telflo-Org): the accepted
 * token. Throws the one 401 when the check didn't run, so a route that
 * forgot it fails closed.
 */
export function requireAcceptedApiToken(request: FastifyRequest): AcceptedApiToken {
  if (!request.apiToken) throw invalidApiToken();
  return request.apiToken;
}

/**
 * For handlers behind the token check and, for a person, the organization
 * check. Throwing here rather than asserting non-null means a route that
 * forgets either fails closed, with the one 401 (as `requireAuthentication`
 * does for a session's routes).
 */
export function requireApiTokenAuthentication(request: FastifyRequest): RequestApiTokenAuthentication {
  if (!request.apiTokenAuthentication) throw invalidApiToken();
  return request.apiTokenAuthentication;
}
