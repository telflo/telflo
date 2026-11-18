import {
  CreateFlowRequestSchema,
  ErrorResponseSchema,
  FlowLintRequestSchema,
  FlowLintResponseSchema,
  FlowResponseSchema,
  FlowShowcaseResponseSchema,
  FlowsResponseSchema,
  PublishedFlowResponseSchema,
  PublishedFlowsResponseSchema,
  UpdateFlowRequestSchema,
  type Flow as FlowResponseBody,
  type FlowCard as FlowCardResponseBody,
  type PublishedFlow as PublishedFlowResponseBody,
} from "@telflo/contracts";
import type { FastifyInstance, FastifyRequest, onSendHookHandler, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import { notFoundWhen } from "../../http/not-found-when.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { publicFlowReader } from "../public-api/actor.js";
import { createAuthenticate, requireAuthentication, requireProductAdmin } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { lintFlowConfig } from "./lint.js";
import { createFlowRepository, type Flow, type FlowCard } from "./repositories/flow-repository.js";
import { createFlowService, type FlowReader, type FlowWriter, type WithFlowTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

/** What the flows service is built from, once, in buildServer (D25 decision 15, Preflight ruling 4). */
export interface FlowServicesDependencies extends ServerDependencies {
  now: () => Date;
}

/** The flows service, one instance shared by the browser routes here and the public routes (D25 decision 15). */
export interface FlowServices {
  service: ReturnType<typeof createFlowService>;
}

export interface FlowRoutesDependencies extends FlowServicesDependencies {
  /** buildServer's shared instances (createFlowServices). */
  services: { flows: FlowServices };
}

/**
 * The flows service (D25 Preflight ruling 4), moved verbatim from the
 * routes: built once in buildServer and shared by the browser and the
 * public routes. Flows are global: no database context.
 */
export function createFlowServices(deps: FlowServicesDependencies): FlowServices {
  const { db, now } = deps;
  const withTransaction: WithFlowTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({
        flows: createFlowRepository(transaction),
        catalogue: createCollectorCatalogueRepository(transaction),
        audit: createAuditRepository(transaction),
      }),
    );
  const service = createFlowService({ flows: createFlowRepository(db), withTransaction, now });
  return { service };
}

/**
 * A flow's write allows 4 MiB: the YAML and the description, 262,144
 * characters each, up to 1.5 MiB each once JSON escapes them, and the other
 * fields, a few KiB. The gateway allows the same on these paths
 * (`docker/gateway/default.conf`).
 */
const FLOW_WRITE_BODY_LIMIT = 4 * 1024 * 1024;

/**
 * The lint's body is the YAML alone: 262,144 characters, up to 1.5 MiB once
 * JSON escapes them, as a version's validation's, which allows 2 MiB too.
 * The gateway's location for the flows' paths admits 4 MiB
 * (`docker/gateway/default.conf`), so a body between the two reaches the
 * API and is refused here, with the API's 413.
 */
const FLOW_LINT_BODY_LIMIT = 2 * 1024 * 1024;

// The three routes with these limits (a flow's create, change and lint)
// check the session in `onRequest`, before Fastify reads the body (D36-1
// decision 42, Preflight ruling 9): a request without a valid session is
// 401 whatever its body, never 413 (only the server-wide CSRF guard runs
// before it). The product-admin check (and the lint's limit after it) stays
// in `preHandler`.

/**
 * The signed-in reads and the writes answer with flows in full, which a
 * product admin's include hidden ones (an admin's draft, whose YAML the
 * lint exists to check for pasted secrets), and the lint answers with
 * configuration text: no cache keeps a copy, as for a configuration's YAML
 * (docs/conventions/security.md). The showcase's cards
 * have no YAML and no hidden flow, and carry no cache header (Preflight
 * ruling 6), so a hide shows at once.
 */
const NO_STORE = "no-store";

/**
 * The open flow read's every reply (D31-1 decision 34, Preflight ruling 1):
 * the 200s, the 404 and the limiter's 429. Each 200 carries a flow's YAML,
 * and a flow hidden since must never be answered from a cache, as for every
 * YAML-carrying flow read.
 */
const noStore: onSendHookHandler = async (_request, reply, payload) => {
  void reply.header("cache-control", NO_STORE);
  return payload;
};

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Any string: one that isn't a flow's slug is 404 flow_not_found, not 400. */
const SlugParamsSchema = z.object({ slug: z.string() });

/** Any string: one that isn't a canonical UUID is 404 flow_not_found, not 400. */
const IdParamsSchema = z.object({ id: z.string() });

function toResponseBody(flow: Flow): FlowResponseBody {
  return {
    id: flow.id,
    slug: flow.slug,
    name: flow.name,
    summary: flow.summary,
    description: flow.description,
    source: flow.source,
    authorName: flow.authorName,
    authorUrl: flow.authorUrl,
    signals: flow.signals,
    tags: flow.tags,
    yaml: flow.yaml,
    collectorDistribution: flow.collectorDistribution,
    collectorVersion: flow.collectorVersion,
    sourceUrl: flow.sourceUrl,
    published: flow.published,
    sortOrder: flow.sortOrder,
    createdAt: flow.createdAt.toISOString(),
    updatedAt: flow.updatedAt.toISOString(),
  };
}

/** A published flow as the open read answers it: a flow in full but its id, `published`, `sortOrder` and `createdAt`. */
function toPublishedResponseBody(flow: Flow): PublishedFlowResponseBody {
  return {
    slug: flow.slug,
    name: flow.name,
    summary: flow.summary,
    description: flow.description,
    source: flow.source,
    authorName: flow.authorName,
    authorUrl: flow.authorUrl,
    signals: flow.signals,
    tags: flow.tags,
    yaml: flow.yaml,
    collectorDistribution: flow.collectorDistribution,
    collectorVersion: flow.collectorVersion,
    sourceUrl: flow.sourceUrl,
    updatedAt: flow.updatedAt.toISOString(),
  };
}

function toCardResponseBody(card: FlowCard): FlowCardResponseBody {
  return {
    slug: card.slug,
    name: card.name,
    summary: card.summary,
    signals: card.signals,
    tags: card.tags,
    authorName: card.authorName,
    updatedAt: card.updatedAt.toISOString(),
  };
}

/** The signed-in reader: whether they are a product admin, as the session check read it on this request. */
function readerOf(request: FastifyRequest): FlowReader {
  return { isProductAdmin: requireAuthentication(request).isProductAdmin };
}

/** The writer, for the audit row: never their organization (a product admin administers the product). */
function writerOf(request: FastifyRequest): FlowWriter {
  const authentication = requireAuthentication(request);
  return {
    userId: authentication.context.userId,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

/**
 * D12 decisions 10 and 11 (Preflight rulings 6 and 19):
 *
 *   * `GET /api/v1/flow-showcase`: no session, no rate limit and no cache
 *     header (Ruling 6, as `/api/v1/auth/oidc-providers`): the web server
 *     calls it for every landing view from its own address, so a per-IP
 *     limit would throttle every visitor. The published flows' cards only,
 *     never the YAML. Its own path, not `/api/v1/flows/showcase`, which would
 *     hide a flow slugged `showcase`.
 *   * `GET /api/v1/published-flows` and `/api/v1/published-flows/:slug`
 *     (D31-1 decisions 5, 19 and 34, Preflight rulings 1 and 2): the open
 *     flow read, for the playground's gallery and a flow's page, read from
 *     the visitor's browser only. No session, whatever the cookie: the
 *     non-admin reader (`publicFlowReader`), so the published flows only,
 *     a hidden one 404 `flow_not_found` as an unknown one. The flows in
 *     full, YAML included, but their id, `published`, `sortOrder` and
 *     `createdAt`. 60 requests a minute per address over both routes
 *     together (`publishedFlowReadsPerIp`, an `onRequest` hook, so every
 *     request counts, an unknown slug's included; 429 `rate_limited` with
 *     Retry-After); every reply `Cache-Control: no-store`; the request
 *     line logs the route's pattern only (http/request-log.ts); no audit.
 *     The showcase above keeps no limit.
 *   * Those three are the anonymous reads TELFLO_PUBLIC_FLOWS switches
 *     (D36-1 decisions 27 and 31, Preflight ruling 7): off, the open
 *     source's default, each answers as a path nothing serves (404
 *     `not_found`), first in its `onRequest` (before the per-address
 *     limit). The signed-in reads below are everyone's, whatever it says.
 *   * `GET /api/v1/flows` and `/api/v1/flows/:slug`: signed in, without the
 *     current terms (the catalogue's rule: the terms gate data endpoints, and
 *     flows are no one's data). The published flows, and the hidden ones too
 *     for a product admin. The list carries each flow's YAML.
 *   * `POST /api/v1/flows`, `PATCH` and `DELETE /api/v1/flows/:id`: a
 *     product admin only (403 `product_admin_required`), each audited. Not
 *     rate limited, as no other signed-in write but the invitations' email
 *     and the validation is (D2c decision 7).
 *   * `POST /api/v1/flows/lint` (decision 6, Preflight ruling 3): the flow
 *     lint over the YAML sent, a product admin only, 20 a minute per product
 *     admin (429 `rate_limited`). It changes
 *     nothing, so nothing is audited; the YAML, the findings and the
 *     destinations are configuration text and reach no log line.
 *
 * Flows are global (ADR 0008): every read and write goes through the API's
 * role with no database context and no row-level security.
 */
export function registerFlowRoutes(
  server: FastifyInstance,
  deps: FlowRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "flowLintsPerUser" | "publishedFlowReadsPerIp">,
): void {
  const { service } = deps.services.flows;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const productAdmin = [authenticate, requireProductAdmin];
  // After the flag check, so only a product admin's lint counts.
  const flowLintLimit: preHandlerAsyncHookHandler = async (request) =>
    rateLimiters.flowLintsPerUser(requireAuthentication(request).context.userId);
  const typed = server.withTypeProvider<ZodTypeProvider>();
  // The anonymous reads' switch (D36-1 decision 31): first in each one's onRequest.
  const publicFlowsOff = notFoundWhen(!deps.settings.site.publicFlows);

  typed.get(
    "/api/v1/flow-showcase",
    { onRequest: publicFlowsOff, schema: { response: { 200: FlowShowcaseResponseSchema, 404: ErrorResponseSchema } } },
    async (_request, reply) => {
      const cards = await service.listShowcase();
      return reply.send({ flows: cards.map(toCardResponseBody) });
    },
  );

  // One hook instance over both routes: one per-address count (Preflight ruling 2).
  const publishedFlowReadLimit = rateLimiters.publishedFlowReadsPerIp;

  typed.get(
    "/api/v1/published-flows",
    {
      onRequest: [publicFlowsOff, publishedFlowReadLimit],
      onSend: noStore,
      schema: { response: { 200: PublishedFlowsResponseSchema, 404: ErrorResponseSchema, 429: ErrorResponseSchema } },
    },
    async (_request, reply) => {
      const flows = await service.list(publicFlowReader);
      return reply.send({ flows: flows.map(toPublishedResponseBody) });
    },
  );

  typed.get(
    "/api/v1/published-flows/:slug",
    {
      onRequest: [publicFlowsOff, publishedFlowReadLimit],
      onSend: noStore,
      schema: {
        params: SlugParamsSchema,
        response: { 200: PublishedFlowResponseSchema, 404: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const flow = await service.get(publicFlowReader, request.params.slug);
      return reply.send({ flow: toPublishedResponseBody(flow) });
    },
  );

  typed.get(
    "/api/v1/flows",
    {
      preHandler: authenticate,
      schema: { response: { 200: FlowsResponseSchema, 401: ErrorResponseSchema } },
    },
    async (request, reply) => {
      const flows = await service.list(readerOf(request));
      return reply.header("cache-control", NO_STORE).send({ flows: flows.map(toResponseBody) });
    },
  );

  typed.get(
    "/api/v1/flows/:slug",
    {
      preHandler: authenticate,
      schema: {
        params: SlugParamsSchema,
        response: { 200: FlowResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const flow = await service.get(readerOf(request), request.params.slug);
      return reply.header("cache-control", NO_STORE).send({ flow: toResponseBody(flow) });
    },
  );

  typed.post(
    "/api/v1/flows",
    {
      onRequest: authenticate,
      preHandler: requireProductAdmin,
      bodyLimit: FLOW_WRITE_BODY_LIMIT,
      schema: {
        body: CreateFlowRequestSchema,
        response: {
          201: FlowResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const flow = await service.create(writerOf(request), request.body);
      return reply.status(201).header("cache-control", NO_STORE).send({ flow: toResponseBody(flow) });
    },
  );

  typed.post(
    "/api/v1/flows/lint",
    {
      onRequest: authenticate,
      preHandler: [requireProductAdmin, flowLintLimit],
      bodyLimit: FLOW_LINT_BODY_LIMIT,
      schema: {
        body: FlowLintRequestSchema,
        response: {
          200: FlowLintResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => reply.header("cache-control", NO_STORE).send(lintFlowConfig(request.body.yaml)),
  );

  typed.patch(
    "/api/v1/flows/:id",
    {
      onRequest: authenticate,
      preHandler: requireProductAdmin,
      bodyLimit: FLOW_WRITE_BODY_LIMIT,
      schema: {
        params: IdParamsSchema,
        body: UpdateFlowRequestSchema,
        response: {
          200: FlowResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const flow = await service.update(writerOf(request), request.params.id, request.body);
      return reply.header("cache-control", NO_STORE).send({ flow: toResponseBody(flow) });
    },
  );

  typed.delete(
    "/api/v1/flows/:id",
    {
      preHandler: productAdmin,
      schema: {
        params: IdParamsSchema,
        response: { 204: noContent, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.remove(writerOf(request), request.params.id);
      return reply.status(204).send(null);
    },
  );
}
