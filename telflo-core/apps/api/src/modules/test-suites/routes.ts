import {
  CreateTestDefinitionRequestSchema,
  CreateTestSuiteRequestSchema,
  ErrorResponseSchema,
  TestDefinitionResponseSchema,
  TestDefinitionsResponseSchema,
  TestSuiteResponseSchema,
  TestSuitesResponseSchema,
  UpdateTestSuiteRequestSchema,
  type TestDefinition as TestDefinitionResponseBody,
  type TestSuite as TestSuiteResponseBody,
} from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { assertActiveOrganization } from "../organizations/service.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createTestInputFileRepository } from "../test-runs/repositories/test-input-file-repository.js";
import { createTestTemplateRepository } from "../test-templates/repositories/test-template-repository.js";
import { createTestDefinitionInputRepository } from "./repositories/test-definition-input-repository.js";
import { createTestDefinitionRepository, type TestDefinition } from "./repositories/test-definition-repository.js";
import { createTestSuiteRepository, type TestSuite } from "./repositories/test-suite-repository.js";
import { createTestSuiteService } from "./service.js";
import type { WithTestSuitesTransaction } from "./transaction.js";

export interface TestSuitesRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/**
 * Every answer here carries configuration text (a suite's or a
 * definition's names, an input's bytes), so no cache keeps a copy
 * (docs/conventions/security.md).
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/** A create's refusals: a read's, and 409 past the cap (Preflight ruling 23). */
const createErrorResponses = { ...errorResponses, 409: ErrorResponseSchema };

/** A definition's create: a create's, and 429 for the person's uploads (Preflight ruling 22). */
const definitionCreateErrorResponses = { ...createErrorResponses, 429: ErrorResponseSchema };

/** Any string for every id: one naming nothing the caller can see is the same 404, never a 400 (D5 decision 7). */
const VersionParamsSchema = z.object({ organizationId: z.string(), configurationId: z.string(), versionId: z.string() });
const SuiteParamsSchema = VersionParamsSchema.extend({ suiteId: z.string() });
const DefinitionParamsSchema = SuiteParamsSchema.extend({ definitionId: z.string() });

const SUITES_ROUTE =
  "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/test-suites";
const DEFINITIONS_ROUTE = `${SUITES_ROUTE}/:suiteId/definitions`;

/** A suite's names go only into a response body (ADR 0024). */
function toSuiteResponseBody(suite: TestSuite): TestSuiteResponseBody {
  return {
    id: suite.id,
    configurationId: suite.configurationId,
    versionId: suite.versionId,
    name: suite.name,
    description: suite.description,
    createdByUserId: suite.createdByUserId,
    createdAt: suite.createdAt.toISOString(),
    updatedAt: suite.updatedAt.toISOString(),
  };
}

/** A definition's names and its input's go only into a response body (ADR 0024). */
function toDefinitionResponseBody(definition: TestDefinition): TestDefinitionResponseBody {
  return {
    id: definition.id,
    suiteId: definition.suiteId,
    name: definition.name,
    description: definition.description,
    pipeline: definition.pipeline,
    signal: definition.signal,
    durationSeconds: definition.durationSeconds,
    inputName: definition.inputName,
    createdByUserId: definition.createdByUserId,
    createdAt: definition.createdAt.toISOString(),
  };
}

/**
 * The test suites and definitions endpoints (D14b detail 19; Preflight
 * rulings 7, 10 and 22 to 24). Each needs a session and the current terms;
 * each re-reads the caller's membership under the organization's lock, and
 * each write then locks the configuration (service.ts); each answers 404
 * for anything the caller can't see, as the runs do. Each transaction
 * carries the request's `AuthContext`, so row-level security on the suites,
 * definitions and inputs admits the same rows the repositories do.
 *
 * A definition's create and its input's head count against the person's
 * uploads in the organization (RATE_LIMITS' testFileUploadsPerUser,
 * Preflight ruling 22): each
 * reads or copies up to 10 MiB, as an upload or a test file's head does.
 * Suite writes have no limit of their own (ruling 24).
 *
 * Names, descriptions and the input's name travel only in the JSON bodies:
 * never in a URL, a log line or an audit row.
 */
export function registerTestSuitesRoutes(
  server: FastifyInstance,
  deps: TestSuitesRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "testFileUploadsPerUser">,
): void {
  const { db, fileStore, now } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];
  const withTransaction: WithTestSuitesTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) => {
      const scope = { organizationId: context.organizationId };
      // The viewer is the database context's user, so the repositories'
      // filters and row-level security see the same rows.
      const viewer = { organizationId: context.organizationId, userId: context.userId };
      return work({
        organization: createActiveOrganizationRepository(transaction, scope),
        members: createMemberRepository(transaction, scope),
        configurations: createConfigurationRepository(transaction, viewer),
        versions: createConfigurationVersionRepository(transaction, viewer),
        suites: createTestSuiteRepository(transaction, viewer),
        definitions: createTestDefinitionRepository(transaction, viewer),
        inputs: createTestDefinitionInputRepository(transaction, viewer),
        files: createTestInputFileRepository(transaction, viewer),
        templates: createTestTemplateRepository(transaction),
        audit: createAuditRepository(transaction),
      });
    });
  const service = createTestSuiteService({ withTransaction, fileStore, now, log: server.log });
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    SUITES_ROUTE,
    { preHandler, schema: { params: VersionParamsSchema, response: { 200: TestSuitesResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const suites = await service.listSuites(actorOf(request), request.params);
      return reply.header("cache-control", NO_STORE).send({ suites: suites.map(toSuiteResponseBody) });
    },
  );

  typed.post(
    SUITES_ROUTE,
    {
      preHandler,
      schema: {
        params: VersionParamsSchema,
        body: CreateTestSuiteRequestSchema,
        response: { 201: TestSuiteResponseSchema, ...createErrorResponses },
      },
    },
    async (request, reply) => {
      const suite = await service.createSuite(actorOf(request), request.params, request.body);
      return reply.status(201).header("cache-control", NO_STORE).send({ suite: toSuiteResponseBody(suite) });
    },
  );

  typed.patch(
    `${SUITES_ROUTE}/:suiteId`,
    {
      preHandler,
      schema: {
        params: SuiteParamsSchema,
        body: UpdateTestSuiteRequestSchema,
        response: { 200: TestSuiteResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { suiteId, ...path } = request.params;
      const suite = await service.updateSuite(actorOf(request), path, suiteId, request.body);
      return reply.header("cache-control", NO_STORE).send({ suite: toSuiteResponseBody(suite) });
    },
  );

  typed.delete(
    `${SUITES_ROUTE}/:suiteId`,
    { preHandler, schema: { params: SuiteParamsSchema, response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const { suiteId, ...path } = request.params;
      await service.removeSuite(actorOf(request), path, suiteId);
      return reply.status(204).send(null);
    },
  );

  typed.get(
    DEFINITIONS_ROUTE,
    {
      preHandler,
      schema: { params: SuiteParamsSchema, response: { 200: TestDefinitionsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { suiteId, ...path } = request.params;
      const definitions = await service.listDefinitions(actorOf(request), path, suiteId);
      return reply.header("cache-control", NO_STORE).send({ definitions: definitions.map(toDefinitionResponseBody) });
    },
  );

  typed.post(
    DEFINITIONS_ROUTE,
    {
      preHandler,
      schema: {
        params: SuiteParamsSchema,
        body: CreateTestDefinitionRequestSchema,
        response: { 201: TestDefinitionResponseSchema, ...definitionCreateErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { suiteId, ...path } = request.params;
      assertActiveOrganization(actor, path.organizationId);
      rateLimiters.testFileUploadsPerUser(actor.context.userId, actor.context.organizationId);
      const definition = await service.createDefinition(actor, path, suiteId, request.body);
      return reply
        .status(201)
        .header("cache-control", NO_STORE)
        .send({ definition: toDefinitionResponseBody(definition) });
    },
  );

  typed.delete(
    `${DEFINITIONS_ROUTE}/:definitionId`,
    { preHandler, schema: { params: DefinitionParamsSchema, response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const { suiteId, definitionId, ...path } = request.params;
      await service.removeDefinition(actorOf(request), path, suiteId, definitionId);
      return reply.status(204).send(null);
    },
  );

  // The first 64 KiB of a definition's input (Play one's fixture-shape
  // check), as a test file's head (D14a Ruling 43) and a run's input's
  // (Ruling 46): bytes, never sniffed, under no file name, never cached,
  // counted with the uploads.
  typed.get(
    `${DEFINITIONS_ROUTE}/:definitionId/input/head`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler, schema: { params: DefinitionParamsSchema } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { suiteId, definitionId, ...path } = request.params;
      assertActiveOrganization(actor, path.organizationId);
      rateLimiters.testFileUploadsPerUser(actor.context.userId, actor.context.organizationId);
      const { sizeBytes, stream } = await service.openDefinitionInputHead(actor, path, suiteId, definitionId);
      const destroy = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once("close", destroy);
      try {
        return await reply
          .header("content-type", "application/octet-stream")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", "attachment")
          .header("cache-control", NO_STORE)
          .header("content-length", sizeBytes)
          .send(stream);
      } catch (error) {
        destroy();
        throw error;
      }
    },
  );
}
