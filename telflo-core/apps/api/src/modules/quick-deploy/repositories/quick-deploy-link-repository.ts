import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { QUICK_DEPLOY_LINKS_ACTIVE_MAXIMUM } from "@telflo/contracts";
import type { Database, QuickDeployLinkChoicesColumn, QuickDeployLinksTable } from "@telflo/db";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";
import type { SealedValues } from "../sealed-values.js";

/*
 * Quick-deploy links (D17c-2 decision 22; Preflight rulings 1 to 5): the
 * context's organization's rows, reached only through the organization
 * scope, row-level security on quick_deploy_links (migration
 * 1700000000032) behind it, so the transaction must carry a database
 * context naming the same organization. Every query but the download's is
 * a fleet's, its first filter the organization (the scope's).
 *
 * The secret is never here, and its hash leaves no method: `createWithinCap`
 * writes it once, and `findQuickDeployLinkBySecretHash`, below, the
 * definer's one caller, is the only read keyed by it (ADR 0023). An object
 * that doesn't carry the hash can't log it. The sealed values stay sealed:
 * only the download opens them (sealed-values.ts).
 */

/** The most links a fleet holds neither expired nor revoked (decision 22). */
export const QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET = QUICK_DEPLOY_LINKS_ACTIVE_MAXIMUM;

/** A link in any state: active while neither revoked nor past `expiresAt` (the caller's clock). */
export interface QuickDeployLink {
  id: string;
  organizationId: string;
  /** The opamp-server's fleet, group and default token. */
  fleetId: string;
  groupId: string;
  defaultTokenId: string;
  /** Null once the member's account is hard-deleted. */
  createdBy: { userId: string; email: string } | null;
  choices: QuickDeployLinkChoicesColumn;
  /** The typed values, sealed; null when none was typed. */
  sealed: SealedValues | null;
  createdAt: Date;
  /** Null: never expires. */
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  downloadCount: number;
  lastDownloadedAt: Date | null;
}

export interface NewQuickDeployLink {
  /** From `nextId`, in the same transaction: the sealed values' associated data names it. */
  id: string;
  fleetId: string;
  groupId: string;
  defaultTokenId: string;
  createdByUserId: string;
  /** sha-256 (hex) of the secret (secret.ts). */
  secretHash: string;
  choices: QuickDeployLinkChoicesColumn;
  sealed: SealedValues | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Where a fleet's list page starts: after the last row of the previous page. */
export interface QuickDeployLinksAfter {
  createdAt: Date;
  id: string;
}

export type CreateWithinCapResult = { kind: "created"; link: QuickDeployLink } | { kind: "limit_reached" };

export type ExtendResult =
  | { kind: "extended"; link: QuickDeployLink }
  /** Revoked: never extended (decision 5); the link as it is. */
  | { kind: "revoked"; link: QuickDeployLink }
  /** The fleet's other links active now are already `cap`: extending this one would make one more (`quick_deploy_link_limit_reached`). */
  | { kind: "limit_reached" }
  | { kind: "not_found" };

export interface IQuickDeployLinkRepository {
  /** A new link's id (`select uuidv7()`, Preflight ruling 5), picked before sealing its values. */
  nextId(): Promise<string>;
  /**
   * Inserts the link unless its fleet already holds `cap` active ones (not
   * revoked, not expired at `now`), counted under a transaction-scoped
   * advisory lock on the organization's fleet (Preflight ruling 3): two
   * creates at cap − 1 leave exactly cap, the second counting after the
   * first's commit. The caller's transaction holds the lock to its end.
   */
  createWithinCap(link: NewQuickDeployLink, now: Date, cap?: number): Promise<CreateWithinCapResult>;
  /** A fleet's links, newest first ((createdAt, id) descending), after `after` when given. */
  list(fleetId: string, page: { limit: number; after?: QuickDeployLinksAfter }): Promise<QuickDeployLink[]>;
  /** The fleet's link with this id, in any state, or undefined. */
  find(fleetId: string, id: string): Promise<QuickDeployLink | undefined>;
  /**
   * Sets the expiry (null: never) of a link not revoked, which is then
   * active: counted as a create is, under the same advisory lock, always
   * (D17c-2 Rulings 36 and 40). Refused (`limit_reached`) when the fleet's
   * OTHER active links at `now` are already `cap`; a link active in a full
   * fleet has cap − 1 others, so it is extended, and an expired one is
   * refused there. The caller's transaction holds the lock to its end.
   */
  extend(fleetId: string, id: string, expiresAt: Date | null, now: Date, cap?: number): Promise<ExtendResult>;
  /**
   * Revokes the link once, by `userId` at `now`: a revoked link stays as it
   * was. The link as it then is, or undefined for an unknown one.
   */
  revoke(fleetId: string, id: string, userId: string, now: Date): Promise<QuickDeployLink | undefined>;
  /** A fleet's delete, after the opamp-server's: every link of it. How many. */
  removeForFleet(fleetId: string): Promise<number>;
  /** The download's read, by id, after the lookup by hash (any fleet of the organization). */
  findForDownload(id: string): Promise<QuickDeployLink | undefined>;
  /**
   * The download's last gate and its count (Preflight ruling 4), in the
   * transaction that writes its audit row: the row locked `for no key
   * update` while still neither revoked nor expired at `now`, then one more
   * download at `now`. Undefined when it isn't active now (revoked or
   * expired meanwhile: the route's 410).
   */
  recordDownload(id: string, now: Date): Promise<QuickDeployLink | undefined>;
}

type LinkRow = Omit<Selectable<QuickDeployLinksTable>, "secret_hash"> & { creator_email: string | null };

function toLink(row: LinkRow): QuickDeployLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fleetId: row.fleet_id,
    groupId: row.group_id,
    defaultTokenId: row.default_token_id,
    createdBy:
      row.created_by_user_id === null || row.creator_email === null ? null : { userId: row.created_by_user_id, email: row.creator_email },
    choices: row.choices,
    sealed: row.env_ciphertext === null || row.env_key_id === null ? null : { ciphertext: Buffer.from(row.env_ciphertext), keyId: row.env_key_id },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    downloadCount: row.download_count,
    lastDownloadedAt: row.last_downloaded_at,
  };
}

/** Every column but the secret's hash. */
const LINK_COLUMNS = [
  "quick_deploy_links.id",
  "quick_deploy_links.organization_id",
  "quick_deploy_links.fleet_id",
  "quick_deploy_links.group_id",
  "quick_deploy_links.default_token_id",
  "quick_deploy_links.created_by_user_id",
  "quick_deploy_links.choices",
  "quick_deploy_links.env_ciphertext",
  "quick_deploy_links.env_key_id",
  "quick_deploy_links.created_at",
  "quick_deploy_links.expires_at",
  "quick_deploy_links.revoked_at",
  "quick_deploy_links.revoked_by_user_id",
  "quick_deploy_links.download_count",
  "quick_deploy_links.last_downloaded_at",
] as const;

/**
 * Bound to a transaction that carries the database context (context.ts) and
 * to the context whose organization it acts on.
 */
export function createQuickDeployLinkRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IQuickDeployLinkRepository {
  const scope = createOrganizationScope(transaction, context);
  /** The links with their creator's email (`users` is global; the links are chosen through the scope). */
  const links = () =>
    scope
      .selectFrom("quick_deploy_links")
      .leftJoin("users", "users.id", "quick_deploy_links.created_by_user_id")
      .select([...LINK_COLUMNS, "users.email as creator_email"]);
  const ofFleet = (fleetId: string) => links().where("quick_deploy_links.fleet_id", "=", fleetId);
  const isActiveAt = (now: Date) =>
    sql<boolean>`quick_deploy_links.revoked_at is null and (quick_deploy_links.expires_at is null or quick_deploy_links.expires_at > ${now})`;
  const byId = async (id: string) => {
    const row = await links().where("quick_deploy_links.id", "=", id).executeTakeFirst();
    return row === undefined ? undefined : toLink(row);
  };
  const find = async (fleetId: string, id: string) => {
    const row = await ofFleet(fleetId).where("quick_deploy_links.id", "=", id).executeTakeFirst();
    return row === undefined ? undefined : toLink(row);
  };
  /**
   * The cap's lock (Preflight ruling 3; test-run-repository.ts' precedent):
   * one key per organization's fleet, held to the transaction's end, so a
   * create and an extend that each add an active link count one after the
   * other, the second after the first's commit.
   */
  const lockTheCap = async (fleetId: string) => {
    const key = `telflo.quick_deploy_links:${scope.organizationId}:${fleetId}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
  };
  /** The fleet's links active at `now` (neither revoked nor expired), `except` one when given. Under the cap's lock. */
  const activeCount = async (fleetId: string, now: Date, except?: string) => {
    let query = scope
      .selectFrom("quick_deploy_links")
      .select((eb) => eb.fn.countAll<string>().as("active"))
      .where("fleet_id", "=", fleetId)
      .where(isActiveAt(now));
    if (except !== undefined) query = query.where("id", "<>", except);
    const { active } = await query.executeTakeFirstOrThrow();
    return Number(active);
  };

  return {
    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(transaction);
      return rows[0]!.id;
    },

    async createWithinCap(link, now, cap = QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET) {
      await lockTheCap(link.fleetId);
      if ((await activeCount(link.fleetId, now)) >= cap) return { kind: "limit_reached" };
      await scope
        .insertInto("quick_deploy_links", {
          id: link.id,
          fleet_id: link.fleetId,
          group_id: link.groupId,
          default_token_id: link.defaultTokenId,
          created_by_user_id: link.createdByUserId,
          secret_hash: link.secretHash,
          choices: JSON.stringify(link.choices),
          env_ciphertext: link.sealed?.ciphertext ?? null,
          env_key_id: link.sealed?.keyId ?? null,
          created_at: link.createdAt,
          expires_at: link.expiresAt,
        })
        .execute();
      const created = await byId(link.id);
      if (created === undefined) throw new Error("the link's insert left no row");
      return { kind: "created", link: created };
    },

    async list(fleetId, { limit, after }) {
      let query = ofFleet(fleetId)
        .orderBy("quick_deploy_links.created_at", "desc")
        .orderBy("quick_deploy_links.id", "desc")
        .limit(limit);
      if (after !== undefined) {
        query = query.where(
          sql<boolean>`(quick_deploy_links.created_at, quick_deploy_links.id) < (${after.createdAt}, ${after.id}::uuid)`,
        );
      }
      return (await query.execute()).map(toLink);
    },

    find,

    async extend(fleetId, id, expiresAt, now, cap = QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET) {
      const current = await find(fleetId, id);
      if (current === undefined) return { kind: "not_found" };
      if (current.revokedAt !== null) return { kind: "revoked", link: current };
      // Decided under the fleet's lock, always (Ruling 40): the link active after it, counted with the fleet's
      // OTHER active links at `now`, as a create counts. Whether the link is active itself is never decided
      // before the lock: one active at this `now` but expired at a concurrent create's would be counted by
      // neither. The link is left out of the count, so an active link of a full fleet (99 others) is extended,
      // and a second extend of one link that waited on the lock (the first's making it active) isn't refused.
      await lockTheCap(fleetId);
      if ((await activeCount(fleetId, now, id)) >= cap) return { kind: "limit_reached" };
      const extended = await scope
        .updateTable("quick_deploy_links", { expires_at: expiresAt })
        .where("fleet_id", "=", fleetId)
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      const link = await find(fleetId, id);
      if (link === undefined) return { kind: "not_found" };
      return extended.numUpdatedRows > 0n ? { kind: "extended", link } : { kind: "revoked", link };
    },

    async revoke(fleetId, id, userId, now) {
      await scope
        .updateTable("quick_deploy_links", { revoked_at: now, revoked_by_user_id: userId })
        .where("fleet_id", "=", fleetId)
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .execute();
      return find(fleetId, id);
    },

    async removeForFleet(fleetId) {
      const result = await scope.deleteFrom("quick_deploy_links").where("fleet_id", "=", fleetId).executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    findForDownload(id) {
      return byId(id);
    },

    async recordDownload(id, now) {
      // Locked first, so concurrent downloads of one link count one by one, and a revoke that committed
      // meanwhile is seen: READ COMMITTED re-checks the locked row's conditions once the lock is granted.
      const locked = await scope
        .selectFrom("quick_deploy_links")
        .select(["id", "download_count"])
        .where("id", "=", id)
        .where(isActiveAt(now))
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (locked === undefined) return undefined;
      await scope
        .updateTable("quick_deploy_links", { download_count: locked.download_count + 1, last_downloaded_at: now })
        .where("id", "=", id)
        .execute();
      return byId(id);
    },
  };
}

/** A link as its secret's hash finds it, before any database context names its organization. */
export interface QuickDeployLinkBySecret {
  id: string;
  organizationId: string;
  /** False once the organization is soft-deleted. */
  organizationIsLive: boolean;
}

/**
 * The link whose secret hashes to `secretHash`, in any state, or undefined:
 * quick_deploy_link_by_secret_hash, the SECURITY DEFINER function that reads
 * past row-level security (ADR 0023's rule: 256 random bits, stored as a
 * hash, matched exactly), and its one caller. It answers only the link's
 * id, its organization and whether that is live; everything after sets the
 * database context to the link's organization and reads through the
 * policies (`findForDownload`).
 */
export async function findQuickDeployLinkBySecretHash(
  db: Kysely<Database> | Transaction<Database>,
  secretHash: string,
): Promise<QuickDeployLinkBySecret | undefined> {
  const { rows } = await sql<{ id: string; organization_id: string; organization_is_live: boolean }>`
    select id, organization_id, organization_is_live from quick_deploy_link_by_secret_hash(${secretHash})
  `.execute(db);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, organizationId: row.organization_id, organizationIsLive: row.organization_is_live };
}
