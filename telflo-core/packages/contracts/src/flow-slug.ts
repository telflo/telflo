import { z } from "zod";

/*
 * A flow's slug, on its own so both the flows' contract and the
 * configurations' (a create's `sourceFlowSlug`) can use it: flows.ts imports
 * configurations.ts, so configurations.ts importing flows.ts would be a
 * cycle whose evaluation order leaves one of them reading the other's
 * constants before they exist. flows.ts re-exports everything here.
 */

/**
 * The slug's limit: the admin dialog's slugify cuts a name to 80; the
 * table's ck_flows_slug_length has this.
 */
export const FLOW_SLUG_MAXIMUM_LENGTH = 80;

/**
 * Lowercase letters and digits in words joined by single hyphens: the
 * table's ck_flows_slug_format. The slug is a URL segment as it is.
 */
export const FLOW_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A flow's slug as a request names it: exactly as sent, not trimmed. The
 * create's `sourceFlowSlug` checks its format with this.
 */
export const FlowSlugSchema = z
  .string()
  .min(1, "Slug is required.")
  .max(FLOW_SLUG_MAXIMUM_LENGTH)
  .regex(FLOW_SLUG_PATTERN, "Slug must be lowercase letters and digits joined by single hyphens.");
