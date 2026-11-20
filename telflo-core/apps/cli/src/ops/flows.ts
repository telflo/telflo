/*
 * The flows' calls, on routes 24-25 with the public API's names:
 * `authorName`, `distribution`, `collectorVersion`, `sourceUrl`. Flows are
 * Telflo's published starting points, not an organization's. Nothing here
 * prints or writes a file.
 */

import type { PublicFlow, PublicFlowDetail, PublicFlows } from "@telflo/contracts";
import { segment, type ApiClient } from "../api.js";
import { EXIT, ExitError } from "../output.js";

export interface FlowYaml {
  slug: string;
  distribution: string;
  collectorVersion: string;
  yaml: string;
}

/** Route 24: every published flow, in the gallery's order. */
export async function listFlows(client: ApiClient): Promise<PublicFlow[]> {
  return (await client.request<PublicFlows>("GET", "/flows")).items;
}

export const SLUG_NEEDED_MESSAGE = "The flow's slug can't be empty (telflo flows list shows them).";

/**
 * Route 25's path for a slug, or a usage error (exit 2) before any request:
 * an empty slug, `.` or `..` (`segment`). Any other text is the API's to
 * answer (404 `flow_not_found` for one that isn't a flow's slug).
 */
export function flowPath(slug: string): string {
  if (slug === "") throw new ExitError(SLUG_NEEDED_MESSAGE, EXIT.USAGE);
  return `/flows/${segment(slug)}`;
}

/** Route 25: one flow, with its description and YAML. */
export async function getFlow(client: ApiClient, slug: string): Promise<PublicFlowDetail> {
  return client.request<PublicFlowDetail>("GET", flowPath(slug));
}

/** A flow's YAML, ending in a newline, with the collector it was validated on. */
export async function getFlowYaml(client: ApiClient, slug: string): Promise<FlowYaml> {
  const flow = await getFlow(client, slug);
  return {
    slug: flow.slug,
    distribution: flow.distribution,
    collectorVersion: flow.collectorVersion,
    yaml: flow.yaml.endsWith("\n") ? flow.yaml : `${flow.yaml}\n`,
  };
}
