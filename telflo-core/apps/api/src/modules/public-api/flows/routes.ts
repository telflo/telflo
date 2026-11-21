import {
  ErrorResponseSchema,
  PublicFlowDetailSchema,
  PublicFlowsSchema,
  type PublicFlow,
  type PublicFlowDetail,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Flow } from "../../flows/repositories/flow-repository.js";
import { publicFlowReader } from "../actor.js";
import type { PublicApiArea } from "../area.js";

/*
 * The public surface's flows, registered into the `/api/public/v1` plugin
 * (routes.ts), so each runs the token check, the per-token limit and its
 * access check first. Flows are global, not an organization's: both read
 * the shared flows service as `publicFlowReader`, never a product admin, so
 * a token sees the published flows only and a hidden one is 404
 * `flow_not_found`, as an unknown slug is. The list answers each flow
 * without its description and YAML, the get with both. Its OpenAPI fragment
 * is `openapi/flows.yaml`.
 *
 * Every reply is `no-store`, as the signed-in flow reads are: the get holds
 * a YAML, and a flow hidden since must not be served from a cache.
 */

const NO_STORE = "no-store";

/** Any string: one that isn't a flow's slug is 404 `flow_not_found`, not 400. */
const SlugParamsSchema = z.object({ slug: z.string() });

/** The list's refusals: the token's 401, a personal token's organization (400, 403) and the per-token limit. */
const listErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** The get's: the list's, and 404 `flow_not_found`. */
const getErrorResponses = { ...listErrorResponses, 404: ErrorResponseSchema };

function toPublicFlow(flow: Flow): PublicFlow {
  return {
    id: flow.id,
    slug: flow.slug,
    name: flow.name,
    summary: flow.summary,
    source: flow.source,
    authorName: flow.authorName,
    authorUrl: flow.authorUrl,
    signals: flow.signals,
    tags: flow.tags,
    collectorVersion: flow.collectorVersion,
    distribution: flow.collectorDistribution,
    sourceUrl: flow.sourceUrl,
    updatedAt: flow.updatedAt.toISOString(),
  };
}

function toPublicFlowDetail(flow: Flow): PublicFlowDetail {
  return { ...toPublicFlow(flow), description: flow.description, yaml: flow.yaml };
}

export const registerFlowPublicRoutes: PublicApiArea = (api, { deps }) => {
  const { service } = deps.services.flows;
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // Every published flow, in the gallery's order (sort order, then name); one page.
  typed.get(
    "/flows",
    {
      config: { access: "read" },
      schema: { response: { 200: PublicFlowsSchema, ...listErrorResponses } },
    },
    async (_request, reply) => {
      const flows = await service.list(publicFlowReader);
      return reply.header("cache-control", NO_STORE).send({ items: flows.map(toPublicFlow), nextCursor: null });
    },
  );

  // One published flow by its slug, with its description and YAML.
  typed.get(
    "/flows/:slug",
    {
      config: { access: "read" },
      schema: { params: SlugParamsSchema, response: { 200: PublicFlowDetailSchema, ...getErrorResponses } },
    },
    async (request, reply) => {
      const flow = await service.get(publicFlowReader, request.params.slug);
      return reply.header("cache-control", NO_STORE).send(toPublicFlowDetail(flow));
    },
  );
};
