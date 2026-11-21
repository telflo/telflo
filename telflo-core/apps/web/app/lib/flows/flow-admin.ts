import {
  FLOW_SIGNALS,
  FLOW_SLUG_MAXIMUM_LENGTH,
  type CollectorDistribution,
  type CreateFlowRequest,
  type Flow,
  type FlowSignal,
  type UpdateFlowRequest,
} from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import { componentsOf, extractSignalType, readText } from "~/lib/graph/parse.js";
import { findDistribution } from "~/lib/stores/collector-catalogue-store.js";

/*
 * What product admin's flows page and its dialog share: the slug, the signals
 * and the PATCH an edit sends.
 */

/** The slug: the name, lowercased, words of letters and digits joined by hyphens, at most 80 characters. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, FLOW_SLUG_MAXIMUM_LENGTH);
}

/**
 * The signals a configuration's pipelines handle, in the order
 * traces, metrics, logs, derived rather than asked: a flow's signals are a
 * fact about its pipelines, and an author ticking boxes gets them wrong.
 *
 * Read as the editor reads the text (`readText`, which `parse` runs), so a
 * text the editor refuses has none. The pipelines are the text's own:
 * `parse`'s graph shows a text without any as three empty default
 * pipelines, which would make every signal look handled. A pipeline's
 * signal is its name's type, so `traces/sampled` counts as traces.
 */
export function deriveSignals(yaml: string): FlowSignal[] {
  if (!yaml.trim()) return [];
  const read = readText(yaml);
  if (!read.ok) return [];
  const pipelineNames = Object.keys(componentsOf(componentsOf(read.config.service).pipelines));
  const found = new Set<string>(pipelineNames.map(extractSignalType));
  return FLOW_SIGNALS.filter((signal) => found.has(signal));
}

/**
 * Whether the catalog offers a flow's pin: false for a pin it has retired
 * (deprecated) or never had; null when it can't say (unread, its read failed,
 * or a distribution it doesn't list).
 */
export function isPinOffered(
  flow: Pick<Flow, "collectorDistribution" | "collectorVersion">,
  distributions: readonly CollectorDistribution[] | null,
): boolean | null {
  const distribution = findDistribution(distributions, flow.collectorDistribution);
  if (distribution === undefined) return null;
  return distribution.versions.some((offer) => offer.version === flow.collectorVersion);
}

/** What the dialog saves: every field of a create but `published`, which a create leaves to its default (shown). */
export type FlowFields = Omit<CreateFlowRequest, "published">;

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The PATCH an edit sends: only the fields that differ from the flow as
 * read. So an edit that leaves the pin alone doesn't send it, and the API
 * keeps it even when the catalog has retired it since: renaming an
 * old-pinned flow doesn't force a re-pin. A changed distribution or version
 * sends both, so the API checks them as a pair. The signals are compared as
 * a set (the dialog derives them in its own order); the tags as a list.
 */
export function changedFields(flow: Flow, fields: FlowFields): UpdateFlowRequest {
  const changes: UpdateFlowRequest = {};
  if (fields.slug !== flow.slug) changes.slug = fields.slug;
  if (fields.name !== flow.name) changes.name = fields.name;
  if (fields.summary !== flow.summary) changes.summary = fields.summary;
  if (fields.description !== flow.description) changes.description = fields.description;
  if (!sameMembers(fields.signals, flow.signals)) changes.signals = fields.signals;
  if (!sameList(fields.tags, flow.tags)) changes.tags = fields.tags;
  if (fields.yaml !== flow.yaml) changes.yaml = fields.yaml;
  if (fields.collectorDistribution !== flow.collectorDistribution || fields.collectorVersion !== flow.collectorVersion) {
    changes.collectorDistribution = fields.collectorDistribution;
    changes.collectorVersion = fields.collectorVersion;
  }
  if ((fields.sourceUrl ?? null) !== flow.sourceUrl) changes.sourceUrl = fields.sourceUrl ?? null;
  if ((fields.authorName ?? null) !== flow.authorName) changes.authorName = fields.authorName ?? null;
  if (fields.sortOrder !== flow.sortOrder) changes.sortOrder = fields.sortOrder;
  return changes;
}

/**
 * Whether an admin call was refused because the caller is no longer a
 * product admin (403 `product_admin_required`, the flag read live): the
 * page then goes to `/app`, as the gate sends a non-admin.
 */
export function isProductAdminRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.code === "product_admin_required";
}
