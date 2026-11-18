import { FLOW_SLUG_MAXIMUM_LENGTH, FLOW_SLUG_PATTERN } from "@telflo/contracts";
import type { ICollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { collectorDistributionUnknown, collectorVersionUnknown } from "../configurations/errors.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import { flowNotFound, flowSlugTaken } from "./errors.js";
import {
  FlowSlugTakenError,
  type Flow,
  type FlowCard,
  type FlowChanges,
  type FlowFields,
  type IFlowRepository,
} from "./repositories/flow-repository.js";

/**
 * The repositories a write uses, bound to one transaction: the flows, the
 * collector catalogue (a flow's pin is checked against it), and the audit
 * trail. All three are global (ADR 0008): no database context is needed.
 */
export interface FlowTransaction {
  flows: IFlowRepository;
  catalogue: Pick<ICollectorCatalogueRepository, "findDistributionDefault" | "isOffered">;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * it commits. If `work` rejects, the transaction rolls back and the
 * rejection propagates.
 */
export type WithFlowTransaction = <Result>(work: (transaction: FlowTransaction) => Promise<Result>) => Promise<Result>;

export interface FlowServiceDependencies {
  /** The reads' repository, outside any transaction: each read is one statement. */
  flows: Pick<IFlowRepository, "listPublishedCards" | "list" | "findBySlug">;
  withTransaction: WithFlowTransaction;
  /** Every flow timestamp comes from here, never SQL `now()`. */
  now: () => Date;
}

/** Who reads: whether they are a product admin, as the session check read it on this request (D12 decision 3). */
export interface FlowReader {
  isProductAdmin: boolean;
}

/** Who writes, for the audit row: a product admin, never acting for an organization. */
export interface FlowWriter {
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** What a create asks for, as the contract parses it. */
export type CreateFlowInput = FlowFields;

/** What a change asks for, as the contract parses it: a field left out stays as it is. */
export type UpdateFlowInput = { [Field in keyof FlowFields]?: FlowFields[Field] | undefined };

export interface IFlowService {
  /** Every published flow's card (D12 decision 10, Preflight ruling 6): what a signed-out visitor may see. */
  listShowcase(): Promise<FlowCard[]>;
  /** Every flow the reader may see, in full: the published ones, and the hidden ones too for a product admin. */
  list(reader: FlowReader): Promise<Flow[]>;
  /** The flow with this slug; 404 `flow_not_found` for none, and for a hidden one but to a product admin. */
  get(reader: FlowReader, slug: string): Promise<Flow>;
  /**
   * A new flow from the admin dialog's fields (D12 decision 11), its source
   * `telflo` and no author link.
   * The pin must be offered: a distribution the catalogue doesn't have is
   * 400 `collector_distribution_unknown`, a version it doesn't offer
   * (unknown or deprecated) 400 `collector_version_unknown`. A slug another
   * flow has is 409 `flow_slug_taken`. Nothing is written on a refusal.
   */
  create(writer: FlowWriter, input: CreateFlowInput): Promise<Flow>;
  /**
   * Changes the fields given that differ from the flow's. None given, or
   * none different, writes and audits nothing, and answers the flow as it
   * is. A pin left as it is stays, even if deprecated since (D12 Preflight
   * ruling 19; the configurations' `collectorVersionFor` rule); a changed one
   * must be offered, as a create's. 404 `flow_not_found` for an id no flow
   * has; 409 `flow_slug_taken` for a slug another flow has.
   */
  update(writer: FlowWriter, id: string, changes: UpdateFlowInput): Promise<Flow>;
  /**
   * Deletes it for good (D12 decision 2). Configurations created from it
   * keep their copy and their `source_flow_slug` (no foreign key). 404
   * `flow_not_found` for an id no flow has.
   */
  remove(writer: FlowWriter, id: string): Promise<void>;
}

/** The fields a change compares and audits, in the contract's order. */
const FIELDS = [
  "slug",
  "name",
  "summary",
  "description",
  "signals",
  "tags",
  "yaml",
  "collectorDistribution",
  "collectorVersion",
  "sourceUrl",
  "authorName",
  "sortOrder",
  "published",
] as const satisfies readonly (keyof FlowFields)[];

/** Two values of one field are the same: lists by their items, in order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

/** A slug a flow could have: one that isn't is no flow's, with no read. */
function isSlug(slug: string): boolean {
  return slug.length <= FLOW_SLUG_MAXIMUM_LENGTH && FLOW_SLUG_PATTERN.test(slug);
}

/**
 * An audit row about `flow` (D12 decision 11): global, so in no
 * organization. The metadata names the slug and, for a change, the fields
 * changed; never the YAML nor the description, nor any field's value but
 * the slug's and `published`'s.
 */
function auditEvent(writer: FlowWriter, flow: Flow, action: string, metadata: Record<string, unknown>): AuditEvent {
  return {
    action,
    actorUserId: writer.userId,
    actorEmail: writer.email,
    subjectType: "flow",
    subjectId: flow.id,
    metadata: { slug: flow.slug, ...metadata },
    ipAddress: writer.ipAddress,
    userAgent: writer.userAgent,
  };
}

/**
 * The checks a pin a write sets must pass (D12 decision 11): the
 * distribution is the catalogue's (by the create's rule for a
 * configuration: one with a default version to offer), and it offers the
 * version (not deprecated).
 */
async function assertOfferedPin(transaction: FlowTransaction, distribution: string, version: string): Promise<void> {
  if (!(await transaction.catalogue.findDistributionDefault(distribution))) throw collectorDistributionUnknown();
  if (!(await transaction.catalogue.isOffered(distribution, version))) throw collectorVersionUnknown();
}

/** Runs `write`, answering a slug another flow has with 409 `flow_slug_taken`. */
async function refusingTakenSlug<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof FlowSlugTakenError) throw flowSlugTaken();
    throw error;
  }
}

/**
 * D12 decisions 2, 10 and 11. Whether the caller may write is decided
 * before the service is reached (`requireProductAdmin`); whether they may
 * see a hidden flow is the reader's flag.
 */
export function createFlowService(deps: FlowServiceDependencies): IFlowService {
  const { flows, withTransaction, now } = deps;

  return {
    async listShowcase(): Promise<FlowCard[]> {
      return flows.listPublishedCards();
    },

    async list(reader: FlowReader): Promise<Flow[]> {
      return flows.list({ includeHidden: reader.isProductAdmin });
    },

    async get(reader: FlowReader, slug: string): Promise<Flow> {
      const flow = isSlug(slug) ? await flows.findBySlug(slug, { includeHidden: reader.isProductAdmin }) : undefined;
      if (!flow) throw flowNotFound();
      return flow;
    },

    async create(writer: FlowWriter, input: CreateFlowInput): Promise<Flow> {
      return refusingTakenSlug(() =>
        withTransaction(async (transaction) => {
          await assertOfferedPin(transaction, input.collectorDistribution, input.collectorVersion);
          const flow = await transaction.flows.create({ ...input, source: "telflo", authorUrl: null, at: now() });
          await transaction.audit.record(auditEvent(writer, flow, "flow.created", {}));
          return flow;
        }),
      );
    },

    async update(writer: FlowWriter, id: string, changes: UpdateFlowInput): Promise<Flow> {
      const canonicalId = canonicalIdOf(id);
      if (canonicalId === undefined) throw flowNotFound();
      return refusingTakenSlug(() =>
        withTransaction(async (transaction) => {
          const current = await transaction.flows.lockForUpdate(canonicalId);
          if (!current) throw flowNotFound();
          // Only the fields that differ from what is there.
          const to: FlowChanges = {};
          for (const field of FIELDS) {
            const value = changes[field];
            if (value !== undefined && !sameValue(value, current[field])) Object.assign(to, { [field]: value });
          }
          const changedFields = FIELDS.filter((field) => field in to);
          if (changedFields.length === 0) return current;
          // The pin as it will be: kept as it is, even if deprecated since; a
          // change must name one the catalogue offers.
          const distribution = to.collectorDistribution ?? current.collectorDistribution;
          const version = to.collectorVersion ?? current.collectorVersion;
          if (distribution !== current.collectorDistribution || version !== current.collectorVersion) {
            await assertOfferedPin(transaction, distribution, version);
          }
          const updated = await transaction.flows.update(current.id, to, now());
          // Locked above, and only a delete removes it: this can't miss.
          if (!updated) throw flowNotFound();
          // Never the YAML nor the description: the field names, and the
          // slug's and the switch's values, which are public.
          const from: Record<string, unknown> = {};
          const into: Record<string, unknown> = {};
          for (const field of ["slug", "published"] as const) {
            if (field in to) {
              from[field] = current[field];
              into[field] = updated[field];
            }
          }
          await transaction.audit.record(
            auditEvent(writer, updated, "flow.updated", {
              changedFields,
              ...(Object.keys(from).length === 0 ? {} : { from, to: into }),
            }),
          );
          return updated;
        }),
      );
    },

    async remove(writer: FlowWriter, id: string): Promise<void> {
      const canonicalId = canonicalIdOf(id);
      if (canonicalId === undefined) throw flowNotFound();
      await withTransaction(async (transaction) => {
        const removed = await transaction.flows.remove(canonicalId);
        if (!removed) throw flowNotFound();
        await transaction.audit.record(auditEvent(writer, removed, "flow.deleted", {}));
      });
    },
  };
}
