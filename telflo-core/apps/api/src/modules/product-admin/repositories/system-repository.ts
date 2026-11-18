import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, OrganizationRole, StoredOrganizationCreation } from "@telflo/db";
import type { AdminUserBlockKind, OrganizationCreation } from "@telflo/contracts";
import { withProductAdminContext } from "../../../database/context.js";
import { createAuditRepository, type AuditEvent } from "../../identity/repositories/audit-repository.js";
import { productAdminRequired } from "../errors.js";
import { organizationCreationOf, storedOrganizationCreationOf } from "../../site-settings/organization-creation.js";
import type { PagePosition } from "../cursor.js";

/*
 * The SystemRepository (ADR 0008, spec §3.7; D29 decisions 17 to 20): the
 * platform's one cross-organization path. The only caller of
 * withProductAdminContext and of migration 1700000000041's product-admin
 * functions (a test scans the source), one method per operation, each
 * writing its audit row in the same transaction: in no organization, the
 * actor's columns as usual, `metadata` holding ids, counts and fixed values
 * only, never an email, a search term or a feedback's text (decision 20).
 *
 *   | Call                 | action                                 | subject   | metadata             |
 *   | Users list or search | product_admin.users_listed             | —         | { count, searched }  |
 *   | Product admins list  | product_admin.product_admins_listed    | —         | { count }            |
 *   | Feedback list        | product_admin.feedback_listed          | —         | { count }            |
 *   | Grant                | product_admin.granted                  | the user  | {}                   |
 *   | Grant, already one   | product_admin.grant_unchanged          | the user  | {}                   |
 *   | Remove               | product_admin.revoked                  | the user  | { self }             |
 *   | Organization creation| product_admin.organization_creation_changed   | — | { from, to }  |
 *   |   the value it holds | product_admin.organization_creation_unchanged | — | { from, to }  |
 *   | Acknowledge          | feedback.acknowledged                  | the item  | {}                   |
 *   | Dismiss              | feedback.dismissed                     | the item  | {}                   |
 *   | A write's refusal    | product_admin.refused                  | when known| { operation, outcome }|
 *   | Delete               | user.deleted                           | the user  | { deletedOrganizations, deletedServiceAccounts, revokedSessions } |
 *   |   and per organization | organization.deleted (in it)         | the org.  | { reason: "account_deleted", deletedServiceAccounts } |
 *
 * The organization-creation switch (D36-1 decision 51) is migration 044's
 * product_admin_set_organization_creation; its from and to are fixed
 * values in the contract's spelling (`everyone`, `product-admins`).
 *
 * The delete's method (decision 29) is Task 2's, on migration 042. The
 * pending count (decision 37) is a number and no personal data: it isn't
 * audited (decision 20's named exception).
 *
 * A refusal by the database's gate (42501 with its own hint, Ruling 260:
 * the caller stopped being a product admin between the route's check and
 * the call; any other 42501 stays a server failure) rolls the
 * transaction back, audit row and all, and is answered 403
 * `product_admin_required`; so is a write's `forbidden` (the caller
 * re-read under its lock, Rulings 257 and 258), which is audited.
 */

/** Who acts: the product admin, for the audit row. Never their organization: a product admin administers the product. */
export interface ProductAdminActor {
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** One live person as the Users page lists them, with the block of decision 30 (null: deletable). */
export interface AdminUserRow {
  id: string;
  email: string;
  createdAt: Date;
  isProductAdmin: boolean;
  block:
    | { kind: "member"; organizationName: string; role: OrganizationRole }
    | { kind: "owner"; organizationName: string }
    | { kind: "product_admin" }
    | null;
}

export interface ListUsersOptions {
  /** Trimmed by the contract; empty or absent is no search. */
  query?: string | undefined;
  after?: PagePosition | undefined;
  /** The page's size: one more row is read, to learn whether another page follows (at most 99). */
  pageSize: number;
  /** The API's clock: an invitation is pending while it expires after this. */
  at: Date;
}

/**
 * A page of a list (Ruling 264): at most the page size's rows, and whether
 * another page follows (the look-ahead row read and dropped). The audit
 * row counts the rows returned, never the look-ahead (decision 12: "how
 * many rows came back").
 */
export interface ListPage<Row> {
  rows: Row[];
  hasMore: boolean;
}

export interface ProductAdminRow {
  id: string;
  email: string;
}

export type GrantResult =
  | { outcome: "granted" | "unchanged"; user: ProductAdminRow }
  | { outcome: "not_found" | "forbidden" };

export type RevokeOutcome = "revoked" | "not_found" | "last_admin" | "forbidden";

/** The switch's change (D36-1 decision 51): what it held before, or `forbidden` (the caller lost the flag while it waited). */
export type SetOrganizationCreationResult =
  | { outcome: "changed" | "unchanged"; previous: OrganizationCreation }
  | { outcome: "forbidden" };

export interface FeedbackRow {
  id: string;
  email: string;
  text: string;
  createdAt: Date;
  authorDeleted: boolean;
}

export interface ListFeedbackOptions {
  after?: PagePosition | undefined;
  /** The page's size: one more row is read, to learn whether another page follows (at most 99). */
  pageSize: number;
}

export type FeedbackHandling = "acknowledged" | "dismissed";

export type HandleFeedbackResult =
  | { outcome: "handled"; sender: { userId: string; email: string } }
  | { outcome: "not_found" | "forbidden" | "author_deleted" };

/** An organization a person's delete removed with them: what the service does after the commit (decision 29). */
export interface DeletedOrganization {
  id: string;
  logoId: string | null;
  deletedServiceAccounts: number;
}

/**
 * A person's delete (decision 29): `deleted` with what went; or a refusal:
 * `blocked` with the block's kind (never a name), `not_found`, `self`,
 * `forbidden` (the caller lost the flag while it waited), `busy` (the
 * person's memberships kept changing under the locks: three attempts).
 */
export type DeleteUserResult =
  | { outcome: "deleted"; organizations: DeletedOrganization[]; deletedServiceAccounts: number; revokedSessions: number }
  | { outcome: "blocked"; kind: AdminUserBlockKind }
  | { outcome: "not_found" | "self" | "forbidden" | "busy" };

export interface ISystemRepository {
  listUsers(actor: ProductAdminActor, options: ListUsersOptions): Promise<ListPage<AdminUserRow>>;
  listProductAdmins(actor: ProductAdminActor): Promise<ProductAdminRow[]>;
  grantProductAdmin(actor: ProductAdminActor, email: string, at: Date): Promise<GrantResult>;
  revokeProductAdmin(actor: ProductAdminActor, userId: string, at: Date): Promise<RevokeOutcome>;
  listFeedback(actor: ProductAdminActor, options: ListFeedbackOptions): Promise<ListPage<FeedbackRow>>;
  countPendingFeedback(actor: ProductAdminActor): Promise<number>;
  handleFeedback(actor: ProductAdminActor, feedbackId: string, handling: FeedbackHandling, at: Date): Promise<HandleFeedbackResult>;
  deleteUser(actor: ProductAdminActor, userId: string, at: Date): Promise<DeleteUserResult>;
  setOrganizationCreation(actor: ProductAdminActor, value: OrganizationCreation): Promise<SetOrganizationCreationResult>;
}

/** The operation a refusal names (decision 20's `{ operation, outcome }`): fixed words. */
type RefusedOperation = "grant" | "revoke" | "acknowledge" | "dismiss" | "delete" | "organization_creation";

interface UserListRow {
  id: string;
  email: string;
  created_at: Date;
  is_product_admin: boolean;
  block_kind: AdminUserBlockKind | null;
  block_organization_name: string | null;
  block_role: OrganizationRole | null;
}

function blockOf(row: UserListRow): AdminUserRow["block"] {
  switch (row.block_kind) {
    case null:
      return null;
    case "product_admin":
      return { kind: "product_admin" };
    case "owner":
      return { kind: "owner", organizationName: row.block_organization_name ?? "" };
    case "member":
      return { kind: "member", organizationName: row.block_organization_name ?? "", role: row.block_role ?? "contributor" };
  }
}

/**
 * The HINT the database's gate raises its 42501 with (migration
 * 1700000000041, Ruling 260): only that refusal is the caller's lost flag.
 * Any other 42501 (a missing grant, a policy) is a server failure, and
 * stays one.
 */
const GATE_HINT = "telflo_product_admin_gate";

function isGateRefusal(error: unknown): boolean {
  const { code, hint } = (error ?? {}) as { code?: unknown; hint?: unknown };
  return code === "42501" && hint === GATE_HINT;
}

export function createSystemRepository(db: Kysely<Database>): ISystemRepository {
  /**
   * Runs `work` in the product-admin context with an audit repository in the
   * same transaction; the gate's 42501 (its hint: GATE_HINT) is answered
   * 403 `product_admin_required`, the transaction (its audit row with it)
   * rolled back; any other error, another 42501 included, goes on as it is.
   */
  async function inContext<Result>(
    actor: ProductAdminActor,
    work: (transaction: Transaction<Database>, audit: (event: Omit<AuditEvent, "actorUserId" | "actorEmail" | "ipAddress" | "userAgent" | "organizationId">) => Promise<void>) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await withProductAdminContext(db, actor.userId, (transaction) => {
        const audits = createAuditRepository(transaction);
        return work(transaction, (event) =>
          audits.record({
            ...event,
            actorUserId: actor.userId,
            actorEmail: actor.email,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          }),
        );
      });
    } catch (error) {
      if (isGateRefusal(error)) throw productAdminRequired();
      throw error;
    }
  }

  /** A write's refusal (decision 20): fixed words, the subject when its id is known, never an email. */
  const refused = (operation: RefusedOperation, outcome: string, subject?: { type: string; id: string }) => ({
    action: "product_admin.refused",
    ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}),
    metadata: { operation, outcome },
  });

  return {
    listUsers(actor, { query, after, pageSize, at }) {
      const searched = query !== undefined && query !== "";
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<UserListRow>`
          select * from product_admin_list_users(
            ${searched ? query : null}::text, ${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid,
            ${pageSize + 1}::integer, ${at}::timestamptz
          )
        `.execute(transaction);
        const page = rows.slice(0, pageSize);
        await audit({ action: "product_admin.users_listed", metadata: { count: page.length, searched } });
        return {
          rows: page.map((row) => ({
            id: row.id,
            email: row.email,
            createdAt: row.created_at,
            isProductAdmin: row.is_product_admin,
            block: blockOf(row),
          })),
          hasMore: rows.length > pageSize,
        };
      });
    },

    listProductAdmins(actor) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<ProductAdminRow>`select id, email from product_admin_list_product_admins()`.execute(transaction);
        await audit({ action: "product_admin.product_admins_listed", metadata: { count: rows.length } });
        return rows;
      });
    },

    grantProductAdmin(actor, email, at) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{ outcome: GrantResult["outcome"]; user_id: string | null; email: string | null }>`
          select outcome, user_id, email from product_admin_grant(${email}::text, ${at}::timestamptz)
        `.execute(transaction);
        const row = rows[0]!;
        if ((row.outcome === "granted" || row.outcome === "unchanged") && row.user_id !== null && row.email !== null) {
          await audit({
            action: row.outcome === "granted" ? "product_admin.granted" : "product_admin.grant_unchanged",
            subjectType: "user",
            subjectId: row.user_id,
            metadata: {},
          });
          return { outcome: row.outcome, user: { id: row.user_id, email: row.email } };
        }
        // The email named no one the caller may grant: no subject, and never the email.
        const outcome = row.outcome === "forbidden" ? "forbidden" : "not_found";
        await audit(refused("grant", outcome));
        return { outcome };
      });
    },

    revokeProductAdmin(actor, userId, at) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{ outcome: RevokeOutcome }>`
          select product_admin_revoke(${userId}::uuid, ${at}::timestamptz) as outcome
        `.execute(transaction);
        const outcome = rows[0]!.outcome;
        const subject = { subjectType: "user", subjectId: userId };
        if (outcome === "revoked") {
          await audit({ action: "product_admin.revoked", ...subject, metadata: { self: userId === actor.userId } });
        } else {
          await audit(refused("revoke", outcome, { type: "user", id: userId }));
        }
        return outcome;
      });
    },

    listFeedback(actor, { after, pageSize }) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{ id: string; email: string; text: string; created_at: Date; author_deleted: boolean }>`
          select id, email, text, created_at, author_deleted
            from product_admin_list_feedback(${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid, ${pageSize + 1}::integer)
        `.execute(transaction);
        const page = rows.slice(0, pageSize);
        await audit({ action: "product_admin.feedback_listed", metadata: { count: page.length } });
        return {
          rows: page.map((row) => ({
            id: row.id,
            email: row.email,
            text: row.text,
            createdAt: row.created_at,
            authorDeleted: row.author_deleted,
          })),
          hasMore: rows.length > pageSize,
        };
      });
    },

    countPendingFeedback(actor) {
      // Decision 20's named exception: a number, no personal data, not audited.
      return inContext(actor, async (transaction) => {
        const { rows } = await sql<{ count: number }>`select product_admin_count_pending_feedback() as count`.execute(transaction);
        return rows[0]!.count;
      });
    },

    handleFeedback(actor, feedbackId, handling, at) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{ outcome: HandleFeedbackResult["outcome"]; user_id: string | null; email: string | null }>`
          select outcome, user_id, email from product_admin_handle_feedback(${feedbackId}::uuid, ${handling}::text, ${at}::timestamptz)
        `.execute(transaction);
        const row = rows[0]!;
        const subject = { type: "feedback", id: feedbackId };
        if (row.outcome === "handled" && row.user_id !== null && row.email !== null) {
          await audit({
            action: handling === "acknowledged" ? "feedback.acknowledged" : "feedback.dismissed",
            subjectType: subject.type,
            subjectId: subject.id,
            metadata: {},
          });
          return { outcome: "handled", sender: { userId: row.user_id, email: row.email } };
        }
        const outcome = row.outcome === "handled" ? "not_found" : row.outcome;
        await audit(refused(handling === "acknowledged" ? "acknowledge" : "dismiss", outcome, subject));
        return { outcome };
      });
    },

    deleteUser(actor, userId, at) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{
          outcome: "deleted" | "blocked" | "not_found" | "self" | "forbidden" | "busy";
          block_kind: AdminUserBlockKind | null;
          organizations: DeletedOrganization[] | null;
          deleted_service_accounts: number | null;
          revoked_sessions: number | null;
        }>`
          select outcome, block_kind, organizations, deleted_service_accounts, revoked_sessions
            from product_admin_delete_account(${userId}::uuid, ${at}::timestamptz)
        `.execute(transaction);
        const row = rows[0]!;
        const subject = { type: "user", id: userId };
        if (row.outcome === "deleted") {
          const organizations = (row.organizations ?? []).map(({ id, logoId, deletedServiceAccounts }) => ({ id, logoId, deletedServiceAccounts }));
          const deletedServiceAccounts = row.deleted_service_accounts ?? 0;
          const revokedSessions = row.revoked_sessions ?? 0;
          // In each organization deleted, as an organization's own delete writes one (decision 20): ids and counts only.
          const audits = createAuditRepository(transaction);
          for (const organization of organizations) {
            await audits.record({
              action: "organization.deleted",
              actorUserId: actor.userId,
              actorEmail: actor.email,
              ipAddress: actor.ipAddress,
              userAgent: actor.userAgent,
              organizationId: organization.id,
              subjectType: "organization",
              subjectId: organization.id,
              metadata: { reason: "account_deleted", deletedServiceAccounts: organization.deletedServiceAccounts },
            });
          }
          await audit({
            action: "user.deleted",
            subjectType: subject.type,
            subjectId: subject.id,
            metadata: { deletedOrganizations: organizations.length, deletedServiceAccounts, revokedSessions },
          });
          return { outcome: "deleted", organizations, deletedServiceAccounts, revokedSessions };
        }
        await audit(refused("delete", row.outcome, subject));
        if (row.outcome === "blocked") return { outcome: "blocked", kind: row.block_kind ?? "member" };
        return { outcome: row.outcome };
      });
    },

    setOrganizationCreation(actor, value) {
      return inContext(actor, async (transaction, audit) => {
        const { rows } = await sql<{ outcome: "changed" | "unchanged" | "forbidden"; previous: StoredOrganizationCreation | null }>`
          select outcome, previous from product_admin_set_organization_creation(${storedOrganizationCreationOf(value)}::text)
        `.execute(transaction);
        const row = rows[0]!;
        if (row.outcome === "forbidden" || row.previous === null) {
          await audit(refused("organization_creation", "forbidden"));
          return { outcome: "forbidden" };
        }
        const previous = organizationCreationOf(row.previous);
        await audit({
          action:
            row.outcome === "changed"
              ? "product_admin.organization_creation_changed"
              : "product_admin.organization_creation_unchanged",
          metadata: { from: previous, to: value },
        });
        return { outcome: row.outcome, previous };
      });
    },
  };
}
