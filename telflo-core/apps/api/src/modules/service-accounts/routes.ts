import { randomBytes } from "node:crypto";
import {
  ApiTokensResponseSchema,
  CreateApiTokenRequestSchema,
  CreatedApiTokenResponseSchema,
  CreateServiceAccountRequestSchema,
  ErrorResponseSchema,
  RenameServiceAccountRequestSchema,
  ServiceAccountResponseSchema,
  ServiceAccountsResponseSchema,
  type ApiToken as ApiTokenResponseBody,
  type ServiceAccount as ServiceAccountResponseBody,
} from "@telflo/contracts";
import type { Database } from "@telflo/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createAuthenticate } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createApiTokenRepository } from "./repositories/api-token-repository.js";
import { createServiceAccountRepository, type ServiceAccount } from "./repositories/service-account-repository.js";
import {
  createServiceAccountService,
  type IServiceAccountService,
  type ListedApiToken,
  type WithServiceAccountTransaction,
} from "./service.js";

export interface ServiceAccountRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

/**
 * Any string: a path naming anything but the active organization, a
 * malformed id included, is the same 404 organization_not_found, not a 400.
 */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });

/**
 * Any string for the account too: one that isn't a canonical uuid names no
 * account, and gets the service's 404 service_account_not_found, as an
 * unknown one does.
 */
const ServiceAccountParamsSchema = z.object({ organizationId: z.string(), serviceAccountId: z.string() });

/** Any string for the token as well: one that isn't a canonical uuid is the revoke's 404 api_token_not_found. */
const ApiTokenParamsSchema = z.object({ organizationId: z.string(), serviceAccountId: z.string(), tokenId: z.string() });

/**
 * The create's reply carries the token: no cache, the browser's
 * or a proxy's, may keep it.
 */
const NO_STORE = "no-store";

/** Eight lowercase hex digits from four random bytes: a new address's random part. */
export function randomAddressHex(): string {
  return randomBytes(4).toString("hex");
}

/** The account as the contract has it; the organization and the update time stay in the API. */
function toResponseBody(account: ServiceAccount): ServiceAccountResponseBody {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    createdAt: account.createdAt.toISOString(),
    createdBy: account.createdBy === null ? null : { userId: account.createdBy.userId, email: account.createdBy.email },
    tokenCount: account.tokenCount,
  };
}

/** A token as listed: its prefix, never the token or its hash; the account, the organization and the creator stay in the API. */
function toApiTokenResponseBody(token: ListedApiToken): ApiTokenResponseBody {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    access: token.access,
    expiresAt: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
    createdAt: token.createdAt.toISOString(),
    isExpired: token.isExpired,
  };
}

/**
 * The service over the API's database, each unit of work one transaction
 * carrying the request's `AuthContext` (its active organization). Exported
 * so a test can pass its own random source for the address (the create's
 * retry) and still run as the API's role.
 */
export function createDatabaseServiceAccountService(
  db: Kysely<Database>,
  now: () => Date,
  randomHex: () => string = randomAddressHex,
): IServiceAccountService {
  const withTransaction: WithServiceAccountTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) => {
      const scope = { organizationId: context.organizationId };
      return work({
        active: {
          organization: createActiveOrganizationRepository(transaction, scope),
          members: createMemberRepository(transaction, scope),
        },
        serviceAccounts: createServiceAccountRepository(transaction, scope),
        apiTokens: createApiTokenRepository(transaction, scope),
        audit: createAuditRepository(transaction),
      });
    });
  return createServiceAccountService({ withTransaction, now, randomHex });
}

/**
 * The service-account routes, and those of an account's tokens, under the
 * active organization as every management route: a session (`authenticate`
 * only, never the terms check, as organization management), admins only, reads
 * included. Not rate limited, as the other management routes. The CSRF guard
 * covers the writes, as every state-changing route.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerServiceAccountRoutes(server: FastifyInstance, deps: ServiceAccountRoutesDependencies): void {
  const { db, now } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const service = createDatabaseServiceAccountService(db, now);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/organizations/:organizationId/service-accounts",
    {
      preHandler: authenticate,
      schema: { params: OrganizationParamsSchema, response: { 200: ServiceAccountsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const accounts = await service.list(actorOf(request), request.params.organizationId);
      return reply.send({ items: accounts.map(toResponseBody) });
    },
  );

  typed.post(
    "/api/v1/organizations/:organizationId/service-accounts",
    {
      preHandler: authenticate,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateServiceAccountRequestSchema,
        response: { 201: ServiceAccountResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const account = await service.create(actorOf(request), request.params.organizationId, request.body.name);
      return reply.status(201).send({ serviceAccount: toResponseBody(account) });
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId",
    {
      preHandler: authenticate,
      schema: { params: ServiceAccountParamsSchema, response: { 200: ServiceAccountResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId } = request.params;
      const account = await service.find(actorOf(request), organizationId, serviceAccountId);
      return reply.send({ serviceAccount: toResponseBody(account) });
    },
  );

  typed.patch(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId",
    {
      preHandler: authenticate,
      schema: {
        params: ServiceAccountParamsSchema,
        body: RenameServiceAccountRequestSchema,
        response: { 200: ServiceAccountResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId } = request.params;
      const account = await service.rename(actorOf(request), organizationId, serviceAccountId, request.body.name);
      return reply.send({ serviceAccount: toResponseBody(account) });
    },
  );

  typed.delete(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId",
    {
      preHandler: authenticate,
      schema: { params: ServiceAccountParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId } = request.params;
      await service.delete(actorOf(request), organizationId, serviceAccountId);
      return reply.status(204).send(null);
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId/api-tokens",
    {
      preHandler: authenticate,
      schema: { params: ServiceAccountParamsSchema, response: { 200: ApiTokensResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId } = request.params;
      const tokens = await service.listTokens(actorOf(request), organizationId, serviceAccountId);
      return reply.send({ items: tokens.map(toApiTokenResponseBody) });
    },
  );

  // The one reply that carries a token: never logged (the request log has no
  // bodies), never cached.
  typed.post(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId/api-tokens",
    {
      preHandler: authenticate,
      schema: {
        params: ServiceAccountParamsSchema,
        body: CreateApiTokenRequestSchema,
        response: { 201: CreatedApiTokenResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId } = request.params;
      const created = await service.createToken(actorOf(request), organizationId, serviceAccountId, request.body);
      return reply
        .status(201)
        .header("cache-control", NO_STORE)
        .send({ apiToken: toApiTokenResponseBody(created.apiToken), token: created.token });
    },
  );

  // A revoke: the row stays, revoked, and its name is free.
  typed.delete(
    "/api/v1/organizations/:organizationId/service-accounts/:serviceAccountId/api-tokens/:tokenId",
    {
      preHandler: authenticate,
      schema: { params: ApiTokenParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, serviceAccountId, tokenId } = request.params;
      await service.revokeToken(actorOf(request), organizationId, serviceAccountId, tokenId);
      return reply.status(204).send(null);
    },
  );
}
