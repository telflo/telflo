import type { CollectorDistribution, Configuration, CreateConfigurationRequest, Flow } from "@telflo/contracts";
import { createConfiguration } from "~/lib/api-client.js";
import { parse } from "~/lib/graph/parse.js";
import { toStored, type StoredGraph } from "~/lib/graph/stored-graph.js";
import { findDistribution } from "~/lib/stores/collector-catalogue-store.js";

/*
 * Using a flow: a flow becomes an ordinary configuration the user owns.
 * Every door into it ("Use this flow" on a flow's page, "Start from a flow"
 * in the create dialog) goes through `createConfigurationFromFlow`, so
 * there is one definition of what using a flow means.
 *
 * The text is parsed with the editor's parser once, here, and the graph stored
 * with the copy (`toStored`), so the flow opens with its layout saved, and a
 * text the canvas can't read is refused now, before anything is created,
 * rather than as an empty canvas after the editor opens. The YAML is sent
 * exactly as the flow has it: the text stays the content.
 *
 * One create takes the content, the pin and the flow's slug, so nothing is
 * left half made. There are no overrides (a picked distribution or version):
 * nothing picks one.
 *
 * A pin the catalogue no longer offers: the copy moves to the distribution's
 * default version, and the dialogs say so (`flowCopyPin`,
 * `pinMovedSentence`); the flow itself is untouched. With the catalogue
 * unread, the flow's pin is sent, and the API refuses one it doesn't offer
 * (400 `collector_version_unknown`), whose message the dialog shows.
 *
 * The create itself is `createConfigurationFromContent`: a name, a
 * description, a text, its stored graph and a pin, one request. A flow's copy
 * goes through it with the flow's slug; the playground's handoff with the
 * visitor's staged edit and no slug.
 */

/** Where a copy of a flow is pinned. */
export interface FlowCopyPin {
  /** The distribution the copy is locked to: always the flow's. */
  distribution: string;
  /** The collector version the copy's version 1 gets. */
  version: string;
  /** The flow's own pin when the copy moves off it, because the catalogue no longer offers it; else null. */
  movedFrom: string | null;
}

/**
 * Where a copy of `flow` is pinned, given the catalogue as read (null while
 * unread, or when its read failed): the flow's pin when the catalogue offers
 * it, or can't say (unread, or a distribution it doesn't list); else the
 * distribution's default version.
 */
export function flowCopyPin(
  flow: Pick<Flow, "collectorDistribution" | "collectorVersion">,
  distributions: readonly CollectorDistribution[] | null,
): FlowCopyPin {
  const asPinned = { distribution: flow.collectorDistribution, version: flow.collectorVersion, movedFrom: null };
  const distribution = findDistribution(distributions, flow.collectorDistribution);
  if (distribution === undefined) return asPinned;
  if (distribution.versions.some((offer) => offer.version === flow.collectorVersion)) return asPinned;
  const fallback = distribution.versions.find((offer) => offer.isDefault) ?? distribution.versions[0];
  if (fallback === undefined) return asPinned;
  return { distribution: flow.collectorDistribution, version: fallback.version, movedFrom: flow.collectorVersion };
}

/** What the dialogs say when a copy moves off the flow's pin; null when it doesn't. */
export function pinMovedSentence(pin: FlowCopyPin): string | null {
  if (pin.movedFrom === null) return null;
  return `This flow was built for collector v${pin.movedFrom}, which is no longer offered; your copy will use v${pin.version}.`;
}

/** A flow whose text the parser can't read: nothing was created. */
export class FlowNotLoadableError extends Error {
  constructor(reason: string) {
    super(`This flow could not be loaded: ${reason}`);
    this.name = "FlowNotLoadableError";
  }
}

export interface InstantiatedFlow {
  configuration: Configuration;
  /** Ready to hand to navigate(): the editor opens the new configuration's only version. */
  editorPath: string;
}

/** What a configuration is made from: its version 1's whole content and pin, and the flow it copies, if any. */
export interface ConfigurationContent {
  name: string;
  description: string;
  yamlContent: string;
  /** The graph as the editor stores it (`toStored`). */
  graph: StoredGraph;
  collectorDistribution: string;
  collectorVersion: string;
  /** The flow it was made from; left out for anything else. */
  sourceFlowSlug?: string;
}

/**
 * The create's request for `content`: the name and description, the four
 * content fields together, both pin fields, and the flow's slug only when
 * there is one. A caller holding content it didn't make (the playground's
 * staged edit) checks it with `CreateConfigurationRequestSchema` first.
 */
export function createRequestFor(content: ConfigurationContent): CreateConfigurationRequest {
  const { name, description, yamlContent, graph, collectorDistribution, collectorVersion, sourceFlowSlug } = content;
  return {
    name,
    description,
    yamlContent,
    nodes: graph.nodes,
    edges: graph.edges,
    pipelines: graph.pipelines,
    collectorDistribution,
    collectorVersion,
    ...(sourceFlowSlug === undefined ? {} : { sourceFlowSlug }),
  };
}

/**
 * Creates a configuration with `content` in `organizationId`, its version 1
 * holding the text, the graph and the pin, in one request. Throws the API's
 * ApiError for a refused create.
 */
export async function createConfigurationFromContent(organizationId: string, content: ConfigurationContent): Promise<InstantiatedFlow> {
  const { configuration } = await createConfiguration(organizationId, createRequestFor(content));
  return { configuration, editorPath: `/editor/${configuration.id}` };
}

/**
 * Creates the user's copy of `flow` in `organizationId`: its name and
 * description as given (the caller trims them), the flow's YAML byte for
 * byte, the graph the parser reads from it, the flow's distribution, the
 * pin `flowCopyPin` gives, and the flow's slug. Throws a FlowNotLoadableError
 * before any request for a text the parser can't read, and the API's
 * ApiError for a refused create.
 */
export async function createConfigurationFromFlow(args: {
  flow: Flow;
  organizationId: string;
  name: string;
  description: string;
  /** The collector catalogue as read; null while unread. */
  distributions: readonly CollectorDistribution[] | null;
}): Promise<InstantiatedFlow> {
  const { flow, organizationId, name, description, distributions } = args;

  const parsed = parse(flow.yaml);
  if (!parsed.ok) throw new FlowNotLoadableError(parsed.reason);
  const graph = toStored(parsed.graph);
  const pin = flowCopyPin(flow, distributions);

  return createConfigurationFromContent(organizationId, {
    name,
    description,
    yamlContent: flow.yaml,
    graph,
    collectorDistribution: pin.distribution,
    collectorVersion: pin.version,
    sourceFlowSlug: flow.slug,
  });
}
