import {
  CreateTestRegexRequestSchema,
  ErrorResponseSchema,
  TestRegexesResponseSchema,
  TestRegexResponseSchema,
  UpdateTestRegexRequestSchema,
  type TestRegex as TestRegexResponseBody,
} from "@telflo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import {
  createAuthenticate,
  requireAuthentication,
  requireCurrentTermsUnlessProductAdmin,
  requireProductAdmin,
} from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createTestRegexRepository, type TestRegex } from "./repositories/test-regex-repository.js";
import { createTestRegexService, type TestRegexWriter, type WithTestRegexesTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface TestRegexesRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/**
 * Every answer here carries configuration text (an entry's name, category,
 * description and regex; a refusal of a regex quotes it), so no cache keeps
 * a copy (docs/conventions/security.md): every route's every answer, its
 * refusals included, by this onSend hook.
 */
async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Any string: one that isn't a canonical UUID is 404 test_regex_not_found, not 400. */
const TestRegexParamsSchema = z.object({ testRegexId: z.string() });

const TEST_REGEXES_ROUTE = "/api/v1/test-regexes";

/** A write's refusals: 400 the body or the regex, 409 the name, 429 the checks' limit, 503 the evaluator. */
const writeErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** An entry's text goes only into a response body (ADR 0024). */
function toResponseBody(testRegex: TestRegex): TestRegexResponseBody {
  return {
    id: testRegex.id,
    name: testRegex.name,
    category: testRegex.category,
    description: testRegex.description,
    regex: testRegex.regex,
    createdAt: testRegex.createdAt.toISOString(),
    updatedAt: testRegex.updatedAt.toISOString(),
  };
}

/** The writer, for the audit row and the limit: never their organization (a product admin administers the product). */
function writerOf(request: FastifyRequest): TestRegexWriter {
  const authentication = requireAuthentication(request);
  return {
    userId: authentication.context.userId,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

/**
 * The regex library's endpoints (D15b decisions 7 and 8; details 17 and 18;
 * Preflight rulings 3 and 4):
 *
 *   * `GET /api/v1/test-regexes`: every entry, by category, then name, then
 *     id, for a member with the current terms, and for a product admin with
 *     or without them (the admin page's list, as the test templates').
 *   * `POST /api/v1/test-regexes`, `PATCH` and `DELETE
 *     /api/v1/test-regexes/:testRegexId`: a product admin only (403
 *     `product_admin_required`, the flag read on this request), without
 *     the terms, as templates' writes; each audited in no organization,
 *     with ids only. A create, and a change of the regex, is checked under
 *     the OTTL evaluator's RE2 first, counted on the person's own checked
 *     saves (RATE_LIMITS' validationRuleChecksPerUser, `admit(userId,
 *     null)`: apart from every organization's).
 *
 * Entries are global (ADR 0008): every read and write goes through the
 * API's role with no database context and no row-level security. Their text
 * and the evaluator's words travel only in the JSON bodies.
 */
export function registerTestRegexesRoutes(
  server: FastifyInstance,
  deps: TestRegexesRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "validationRuleChecksPerUser">,
): void {
  const { db, testing, now } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const productAdmin = [authenticate, requireProductAdmin];
  const withTransaction: WithTestRegexesTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({ testRegexes: createTestRegexRepository(transaction), audit: createAuditRepository(transaction) }),
    );
  const service = createTestRegexService({
    testRegexes: createTestRegexRepository(db),
    withTransaction,
    evaluator: testing.ottlEvaluator,
    limiter: rateLimiters.validationRuleChecksPerUser,
    now,
    log: server.log,
  });
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    TEST_REGEXES_ROUTE,
    {
      preHandler: [authenticate, requireCurrentTermsUnlessProductAdmin],
      onSend: noStore,
      schema: { response: { 200: TestRegexesResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async (_request, reply) => {
      const testRegexes = await service.list();
      return reply.send({ testRegexes: testRegexes.map(toResponseBody) });
    },
  );

  typed.post(
    TEST_REGEXES_ROUTE,
    {
      preHandler: productAdmin,
      onSend: noStore,
      schema: {
        body: CreateTestRegexRequestSchema,
        response: { 201: TestRegexResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const created = await service.create(writerOf(request), request.body);
      return reply.status(201).send({ testRegex: toResponseBody(created) });
    },
  );

  typed.patch(
    `${TEST_REGEXES_ROUTE}/:testRegexId`,
    {
      preHandler: productAdmin,
      onSend: noStore,
      schema: {
        params: TestRegexParamsSchema,
        body: UpdateTestRegexRequestSchema,
        response: { 200: TestRegexResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const updated = await service.update(writerOf(request), request.params.testRegexId, request.body);
      return reply.send({ testRegex: toResponseBody(updated) });
    },
  );

  typed.delete(
    `${TEST_REGEXES_ROUTE}/:testRegexId`,
    {
      preHandler: productAdmin,
      onSend: noStore,
      schema: {
        params: TestRegexParamsSchema,
        response: { 204: noContent, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.remove(writerOf(request), request.params.testRegexId);
      return reply.status(204).send(null);
    },
  );
}
