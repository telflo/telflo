import {
  CreateOrganizationVariableRequestSchema,
  CreateVariableGroupRequestSchema,
  ErrorResponseSchema,
  OrganizationVariableResponseSchema,
  OrganizationVariablesResponseSchema,
  UpdateOrganizationVariableRequestSchema,
  UpdateVariableGroupRequestSchema,
  VariableDraftsResponseSchema,
  VariableGroupDetailSchema,
  VariableGroupOverrideRequestSchema,
  VariableGroupOverrideResponseSchema,
  VariableGroupResponseSchema,
  VariableGroupsResponseSchema,
} from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createVariableDraftsRepository } from "./drafts-repository.js";
import { createVariablesService, type WithVariablesTransaction } from "./service.js";

/** What the variables service is built from, once, in buildServer (D25 Preflight ruling 4). */
export interface VariableServicesDependencies extends ServerDependencies {
  now: () => Date;
  /** buildServer's: a create that finds its organization deleted runs its delete hook again. */
  opampRegistration: Pick<OpampRegistration, "deleted">;
}

/** The variables service, one instance (D25 Preflight ruling 4). */
export interface VariableServices {
  service: ReturnType<typeof createVariablesService>;
}

export interface VariableRoutesDependencies extends VariableServicesDependencies {
  /** buildServer's shared instances (createVariableServices). */
  services: { variables: VariableServices };
}

/**
 * The organization's variables and variable groups (D20 decision 37). Every
 * path names ids only: a variable's name, value or description never goes
 * in a URL (Q88), and no route takes a query.
 */
const VARIABLES_ROUTE = "/api/v1/organizations/:organizationId/variables";
const VARIABLE_GROUPS_ROUTE = "/api/v1/organizations/:organizationId/variable-groups";

/**
 * A reply carrying values, names or descriptions is configuration text
 * (Q88), as a configuration's YAML is: no cache keeps a copy.
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Every route's refusals: the contract's 400, the session's 401, the terms' 403, the 404s, the person's limit (429) and the one 503. */
const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** A write's: a refusal of the person's to fix besides (409). */
const writeErrorResponses = { ...errorResponses, 409: ErrorResponseSchema };

/**
 * Any string for each id: a path naming anything but the active
 * organization is the same 404, and a malformed variable or variable group
 * id its own 404 with no call, never a 400.
 */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });
const VariableParamsSchema = z.object({ organizationId: z.string(), variableId: z.string() });
const VariableGroupParamsSchema = z.object({ organizationId: z.string(), variableGroupId: z.string() });
const OverrideParamsSchema = z.object({ organizationId: z.string(), variableGroupId: z.string(), variableId: z.string() });

/**
 * The variables service (D25 Preflight ruling 4), moved verbatim from the
 * routes: built once in buildServer (the public surface doesn't port the
 * variables, decision 15, but every module's services are built alike).
 */
export function createVariableServices(
  deps: VariableServicesDependencies,
  rateLimiters: Pick<RateLimiters, "fleetsPerUser">,
  log: FastifyBaseLogger,
): VariableServices {
  const { db, opampServer, opampRegistration } = deps;
  const withTransaction: WithVariablesTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) =>
      work({
        organization: createActiveOrganizationRepository(transaction, { organizationId: context.organizationId }),
        audit: createAuditRepository(transaction),
        publishedVersions: createPublishedVersionRepository(transaction, context),
        drafts: createVariableDraftsRepository(transaction, context),
      }),
    );
  const service = createVariablesService({
    withTransaction,
    opampServer,
    limiter: rateLimiters.fleetsPerUser,
    opampRegistration,
    log,
  });
  return { service };
}

/**
 * D20 decision 37's routes. Each needs a session and the current terms (403
 * `terms_acceptance_required` first), then the path's organization the
 * session's active one; every member of it may use them (no viewer role
 * exists: Preflight ruling 46). The service does the rest: service.ts.
 */
export function registerVariableRoutes(
  server: FastifyInstance,
  deps: VariableRoutesDependencies,
): void {
  const { service } = deps.services.variables;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];
  const typed = server.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // Variables.

  typed.get(
    VARIABLES_ROUTE,
    {
      preHandler,
      schema: { params: OrganizationParamsSchema, response: { 200: OrganizationVariablesResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const variables = await service.listVariables(actorOf(request), request.params.organizationId);
      return reply.header("cache-control", NO_STORE).send({ variables });
    },
  );

  // Q93: 201 with the variable; a retry with the same id, name, value and description 200.
  typed.post(
    VARIABLES_ROUTE,
    {
      preHandler,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateOrganizationVariableRequestSchema,
        response: { 201: OrganizationVariableResponseSchema, 200: OrganizationVariableResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const outcome = await service.createVariable(actorOf(request), request.params.organizationId, request.body);
      return reply
        .status(outcome.kind === "created" ? 201 : 200)
        .header("cache-control", NO_STORE)
        .send({ variable: outcome.created });
    },
  );

  typed.patch(
    `${VARIABLES_ROUTE}/:variableId`,
    {
      preHandler,
      schema: {
        params: VariableParamsSchema,
        body: UpdateOrganizationVariableRequestSchema,
        response: { 200: OrganizationVariableResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, variableId } = request.params;
      const variable = await service.updateVariable(actorOf(request), organizationId, variableId, request.body);
      return reply.header("cache-control", NO_STORE).send({ variable });
    },
  );

  typed.delete(
    `${VARIABLES_ROUTE}/:variableId`,
    {
      preHandler,
      schema: { params: VariableParamsSchema, response: { 204: noContent, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, variableId } = request.params;
      await service.deleteVariable(actorOf(request), organizationId, variableId);
      return reply.status(204).send(null);
    },
  );

  // Default 21's warning (Preflight ruling 27): the variable named by its id, never its name.
  typed.get(
    `${VARIABLES_ROUTE}/:variableId/drafts`,
    {
      preHandler,
      schema: { params: VariableParamsSchema, response: { 200: VariableDraftsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, variableId } = request.params;
      const configurations = await service.variableDrafts(actorOf(request), organizationId, variableId);
      return reply.header("cache-control", NO_STORE).send({ configurations });
    },
  );

  // -------------------------------------------------------------------------
  // Variable groups and their overrides.

  typed.get(
    VARIABLE_GROUPS_ROUTE,
    {
      preHandler,
      schema: { params: OrganizationParamsSchema, response: { 200: VariableGroupsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const variableGroups = await service.listVariableGroups(actorOf(request), request.params.organizationId);
      return reply.header("cache-control", NO_STORE).send({ variableGroups });
    },
  );

  typed.post(
    VARIABLE_GROUPS_ROUTE,
    {
      preHandler,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateVariableGroupRequestSchema,
        response: { 201: VariableGroupResponseSchema, 200: VariableGroupResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const outcome = await service.createVariableGroup(actorOf(request), request.params.organizationId, request.body);
      return reply
        .status(outcome.kind === "created" ? 201 : 200)
        .header("cache-control", NO_STORE)
        .send({ variableGroup: outcome.created });
    },
  );

  // The group and its overrides (the organization's value for every variable it doesn't override).
  typed.get(
    `${VARIABLE_GROUPS_ROUTE}/:variableGroupId`,
    {
      preHandler,
      schema: { params: VariableGroupParamsSchema, response: { 200: VariableGroupDetailSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, variableGroupId } = request.params;
      const detail = await service.getVariableGroup(actorOf(request), organizationId, variableGroupId);
      return reply.header("cache-control", NO_STORE).send(detail);
    },
  );

  typed.patch(
    `${VARIABLE_GROUPS_ROUTE}/:variableGroupId`,
    {
      preHandler,
      schema: {
        params: VariableGroupParamsSchema,
        body: UpdateVariableGroupRequestSchema,
        response: { 200: VariableGroupResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, variableGroupId } = request.params;
      const variableGroup = await service.updateVariableGroup(actorOf(request), organizationId, variableGroupId, request.body);
      return reply.header("cache-control", NO_STORE).send({ variableGroup });
    },
  );

  typed.delete(
    `${VARIABLE_GROUPS_ROUTE}/:variableGroupId`,
    {
      preHandler,
      schema: { params: VariableGroupParamsSchema, response: { 204: noContent, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, variableGroupId } = request.params;
      await service.deleteVariableGroup(actorOf(request), organizationId, variableGroupId);
      return reply.status(204).send(null);
    },
  );

  // A new override, a replace and the same value again all answer 200 with the override as it now is.
  typed.put(
    `${VARIABLE_GROUPS_ROUTE}/:variableGroupId/overrides/:variableId`,
    {
      preHandler,
      schema: {
        params: OverrideParamsSchema,
        body: VariableGroupOverrideRequestSchema,
        response: { 200: VariableGroupOverrideResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, variableGroupId, variableId } = request.params;
      const override = await service.setOverride(actorOf(request), organizationId, variableGroupId, variableId, request.body.value);
      return reply.header("cache-control", NO_STORE).send({ override });
    },
  );

  // The Reset: the variable takes the organization's value in this group again. No body: the actor is the session's.
  typed.delete(
    `${VARIABLE_GROUPS_ROUTE}/:variableGroupId/overrides/:variableId`,
    {
      preHandler,
      schema: { params: OverrideParamsSchema, response: { 204: noContent, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, variableGroupId, variableId } = request.params;
      await service.resetOverride(actorOf(request), organizationId, variableGroupId, variableId);
      return reply.status(204).send(null);
    },
  );
}
