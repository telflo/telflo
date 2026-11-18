import { z } from "zod";
import { FLOW_SIGNALS, FLOW_SOURCES } from "../flows.js";

/*
 * The public surface's request and response shapes for flows (routes
 * 24–25) (D25 decisions 17, 18, 19 and 45): strict Zod schemas, camelCase,
 * from the platform's flow (flows.ts' FlowSchema) mapped to a summary and a
 * detail. Flows are global, not an
 * organization's; a token sees the published ones only.
 *
 * `updatedAt` is never null: the platform stamps every flow.
 */

/** A published flow without its description and YAML. */
export const PublicFlowSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    source: z.enum(FLOW_SOURCES),
    authorName: z.string().nullable(),
    authorUrl: z.string().nullable(),
    signals: z.array(z.enum(FLOW_SIGNALS)),
    tags: z.array(z.string()),
    collectorVersion: z.string(),
    distribution: z.string(),
    sourceUrl: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PublicFlow = z.infer<typeof PublicFlowSchema>;

/** One published flow, with its long description (Markdown) and its YAML. */
export const PublicFlowDetailSchema = PublicFlowSchema.extend({ description: z.string(), yaml: z.string() }).strict();

export type PublicFlowDetail = z.infer<typeof PublicFlowDetailSchema>;

/** `GET /flows`: every published flow, in the gallery's order; not paginated (decision 19). */
export const PublicFlowsSchema = z.object({ items: z.array(PublicFlowSchema), nextCursor: z.null() }).strict();

export type PublicFlows = z.infer<typeof PublicFlowsSchema>;
