import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  Database,
  OrganizationLogoContentType,
  OrganizationRole,
  OrganizationsTable,
  OrganizationType,
} from "@telflo/db";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";

/*
 * Two repositories over `organizations`, split by what they are bound to:
 *
 * - `IOrganizationRepository` is global. Identity paths use it before any
 *   organization is chosen: registration creates the personal organization,
 *   sign-in finds it and `/me` lists a user's organizations. Creating a
 *   group organization is here too, since the new organization is not yet
 *   anyone's context.
 * - `IActiveOrganizationRepository` is organization-scoped: built from a
 *   transaction and a context, it reaches only the context's organization,
 *   through the organization scope. Organization management acts on the
 *   active organization only.
 */

export interface Organization {
  id: string;
  name: string;
  type: OrganizationType;
  /** The user whose personal organization this is; null for a group organization. */
  ownerUserId: string | null;
  createdAt: Date;
  /** Its logo's id: a new one per upload; null for none. */
  logoId: string | null;
  /** The logo's type, read from its bytes at upload; null exactly when `logoId` is. */
  logoContentType: OrganizationLogoContentType | null;
}

/**
 * An organization's logo as its row holds it: its id, which names its bytes
 * in the file store, and the type read from its first bytes at upload.
 */
export interface OrganizationLogo {
  logoId: string;
  contentType: OrganizationLogoContentType;
}

/**
 * An organization's settings: whether its public install links (Linux Quick
 * Deploy and Helm values links) work.
 */
export interface OrganizationSettings {
  publicInstallLinks: boolean;
}

export interface CreatePersonalOrganizationInput {
  ownerUserId: string;
  ownerEmail: string;
}

function toOrganization(row: Selectable<OrganizationsTable>): Organization {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    logoId: row.logo_id,
    logoContentType: row.logo_content_type,
  };
}

/**
 * The owner's lowercased email alone: the name a new personal organization is
 * created under (no migration renames an existing one). The email reaching
 * here is already lowercased by the contract and by the user insert;
 * lowercasing again is defensive, so the name can never disagree with the
 * stored email.
 */
export function personalOrganizationName(email: string): string {
  return email.trim().toLowerCase();
}

/** An organization, named. */
export interface OrganizationSummary {
  id: string;
  name: string;
}

/**
 * An organization as its member sees it in a list: its type, its logo's id
 * and their role in it.
 */
export interface UserOrganization extends OrganizationSummary {
  type: OrganizationType;
  logoId: string | null;
  role: OrganizationRole;
}

/**
 * A group organization's create: its id, when the API picked it first (a
 * logo's bytes are written under it before the row), and its logo.
 */
export interface CreateGroupOptions {
  id?: string;
  logo?: OrganizationLogo;
}

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique index on live group organizations' lower(name) (migration 1700000000010). */
const GROUP_NAME_UNIQUE_INDEX = "uq_organizations_lower_name_group";

/**
 * True only for a unique violation on the group-name index. Checked by name,
 * not just by SQLSTATE, as identity's `isDuplicateEmailViolation` is: a
 * violation of any other unique index is a bug, and must surface as one, not
 * be reported to the caller as "that name is taken".
 */
function isGroupNameViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === GROUP_NAME_UNIQUE_INDEX
  );
}

/**
 * Thrown by `createGroup` and `rename` when a live group organization already
 * has the name, ignoring case. The statement failed, so the transaction it
 * ran in is aborted: the caller lets it roll back.
 */
export class OrganizationNameTakenError extends Error {
  constructor() {
    super("a live group organization already has that name");
    this.name = "OrganizationNameTakenError";
  }
}

/** Runs `insertOrUpdate`, turning a group-name clash into OrganizationNameTakenError. */
async function withNameClashAsError<Result>(insertOrUpdate: () => Promise<Result>): Promise<Result> {
  try {
    return await insertOrUpdate();
  } catch (error) {
    if (isGroupNameViolation(error)) throw new OrganizationNameTakenError();
    throw error;
  }
}

export interface IOrganizationRepository {
  createPersonal(input: CreatePersonalOrganizationInput): Promise<Organization>;
  createGroup(name: string, options?: CreateGroupOptions): Promise<Organization>;
  /**
   * A new organization's id, picked before its row is written: a logo's bytes
   * are written under it first. The id the table's own default would have
   * given (uuidv7()).
   */
  nextId(): Promise<string>;
  findPersonalForUser(userId: string): Promise<OrganizationSummary | undefined>;
  listForUser(userId: string): Promise<UserOrganization[]>;
  /**
   * The id of the live organization the user joined most recently: their newest live membership (`created_at`,
   * which a restore keeps) in an organization that isn't soft-deleted, the personal one included. Unlocked.
   * Needs a database context naming the user, as `findPersonalForUser` does.
   */
  findNewestJoinedForUser(userId: string): Promise<string | undefined>;
}

/**
 * Runs `work` with the repository bound to a transaction whose database
 * context is `userId` alone, and resolves once it commits. Row-level
 * security then shows it that user's memberships in every organization and
 * nobody else's: what sign-in's personal organization and `/me`'s list
 * need, before any organization is chosen.
 */
export type WithUserOrganizations = <Result>(
  userId: string,
  work: (organizations: IOrganizationRepository) => Promise<Result>,
) => Promise<Result>;

/**
 * Takes either the pool-backed `Kysely` or a `Transaction` (which extends
 * it). Registration always passes its transaction: see `createAccount` in
 * identity's user-repository.ts, which is the only way an account is created.
 */
export function createOrganizationRepository(
  db: Kysely<Database> | Transaction<Database>,
): IOrganizationRepository {
  return {
    async createPersonal(input: CreatePersonalOrganizationInput): Promise<Organization> {
      const row = await db
        .insertInto("organizations")
        .values({
          name: personalOrganizationName(input.ownerEmail),
          type: "personal",
          owner_user_id: input.ownerUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toOrganization(row);
    },

    /**
     * A group organization, which has no owner. The name is taken as given:
     * the contract trims and bounds it. A live group organization with the
     * same name, ignoring case, throws OrganizationNameTakenError. With `id`,
     * the row takes it (nextId's); with `logo`, its columns.
     */
    async createGroup(name: string, options: CreateGroupOptions = {}): Promise<Organization> {
      const row = await withNameClashAsError(() =>
        db
          .insertInto("organizations")
          .values({
            ...(options.id === undefined ? {} : { id: options.id }),
            name,
            type: "group",
            owner_user_id: null,
            ...(options.logo === undefined
              ? {}
              : { logo_id: options.logo.logoId, logo_content_type: options.logo.contentType }),
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      return toOrganization(row);
    },

    async nextId(): Promise<string> {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(db);
      return rows[0]!.id;
    },

    /**
     * The user's own personal organization, if they are still a live member of
     * it and it is not soft-deleted. Needs a database context naming the user:
     * row-level security hides every membership otherwise. It can be
     * undefined: every user is guaranteed a membership, not a personal
     * organization (a service account's only membership is in a group one).
     * There is at most one (uq_organizations_owner_user_id_personal).
     */
    async findPersonalForUser(userId: string): Promise<OrganizationSummary | undefined> {
      return db
        .selectFrom("organizations")
        .innerJoin("organization_members", "organization_members.organization_id", "organizations.id")
        .select(["organizations.id", "organizations.name"])
        .where("organization_members.user_id", "=", userId)
        .where("organization_members.deleted_at", "is", null)
        .where("organizations.type", "=", "personal")
        .where("organizations.owner_user_id", "=", userId)
        .where("organizations.deleted_at", "is", null)
        .executeTakeFirst();
    },

    async findNewestJoinedForUser(userId: string): Promise<string | undefined> {
      const row = await db
        .selectFrom("organizations")
        .innerJoin("organization_members", "organization_members.organization_id", "organizations.id")
        .select("organizations.id")
        .where("organization_members.user_id", "=", userId)
        .where("organization_members.deleted_at", "is", null)
        .where("organizations.deleted_at", "is", null)
        .orderBy("organization_members.created_at", "desc")
        .orderBy("organization_members.id", "desc")
        .limit(1)
        .executeTakeFirst();
      return row?.id;
    },

    /**
     * Every live organization the user is a live member of, with its type
     * and their role: personal first, then by name. Needs a database context
     * naming the user, as above.
     */
    async listForUser(userId: string): Promise<UserOrganization[]> {
      return db
        .selectFrom("organizations")
        .innerJoin("organization_members", "organization_members.organization_id", "organizations.id")
        .select([
          "organizations.id",
          "organizations.name",
          "organizations.type",
          "organizations.logo_id as logoId",
          "organization_members.role",
        ])
        .where("organization_members.user_id", "=", userId)
        .where("organization_members.deleted_at", "is", null)
        .where("organizations.deleted_at", "is", null)
        .orderBy(sql`organizations.type = 'personal'`, "desc")
        .orderBy("organizations.name")
        .orderBy("organizations.id")
        .execute();
    },
  };
}

/**
 * The user's role in the organization, while both the membership and the
 * organization are live; undefined otherwise (an unknown or deleted
 * organization, or one the user isn't a live member of, alike). A personal
 * token's organization check, read on every request, so a removal or a role
 * change takes effect on the next one. Needs a database context naming the
 * user (row-level security shows their own memberships).
 */
export async function findLiveMembershipRole(
  transaction: Transaction<Database>,
  userId: string,
  organizationId: string,
): Promise<OrganizationRole | undefined> {
  const row = await transaction
    .selectFrom("organization_members")
    .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
    .select("organization_members.role")
    .where("organization_members.user_id", "=", userId)
    .where("organization_members.organization_id", "=", organizationId)
    .where("organization_members.deleted_at", "is", null)
    .where("organizations.deleted_at", "is", null)
    .executeTakeFirst();
  return row?.role;
}

/**
 * The context's organization, and nothing else. Every method acts on a
 * live organization only: a soft-deleted one is not found and not changed.
 */
export interface IActiveOrganizationRepository {
  /** The organization, unless it is soft-deleted. */
  findActive(): Promise<Organization | undefined>;
  /**
   * The same, locked `for no key update` until the transaction ends: the
   * organization lock, which every change to the organization or its
   * members takes first. It conflicts with itself and with the switch's
   * `for share`, so those serialize, but not with the `key share` a
   * foreign-key check takes. Moving a session into an organization takes
   * that on the organization, so with `for update` two changes
   * reassigning sessions into each other's organization deadlock (40P01):
   * two owners removing each other from their personal organizations at
   * once, say.
   */
  lockActive(): Promise<Organization | undefined>;
  /**
   * The same, locked `for share`: the switch's lock on its target, which a
   * concurrent delete (`lockActive`) waits behind.
   */
  findActiveForShare(): Promise<Organization | undefined>;
  /** Its settings, unless it is soft-deleted. */
  findSettings(): Promise<OrganizationSettings | undefined>;
  /**
   * The same, locked `for share`: a link's create and a download's count
   * read the switch under it, so an admin's change (under `lockActive`'s
   * `for no key update`) waits for them, and they for it. Undefined when it
   * is soft-deleted.
   */
  findSettingsForShare(): Promise<OrganizationSettings | undefined>;
  /** Sets the "Public install links" switch. False, and nothing changed, when it is soft-deleted. */
  setPublicInstallLinks(enabled: boolean): Promise<boolean>;
  /** Renames it. Undefined when it is soft-deleted; a clash throws OrganizationNameTakenError. */
  rename(name: string): Promise<Organization | undefined>;
  /**
   * Points it at a new logo, or at none (null): both columns together.
   * Undefined when it is soft-deleted. The bytes are the caller's: written
   * before, the old ones removed after the commit.
   */
  setLogo(logo: OrganizationLogo | null): Promise<Organization | undefined>;
  /**
   * Its logo (the public read), unless it has none or is soft-deleted.
   */
  findLogo(): Promise<OrganizationLogo | undefined>;
  /** Soft-deletes a group organization. False, and nothing changed, for a personal or already deleted one. */
  markDeleted(at: Date): Promise<boolean>;
  /**
   * Soft-deletes every live account whose only live membership in a live
   * organization is here: deleting the organization would otherwise strand
   * them. Returns how many.
   */
  deleteAccountsOnlyInOrganization(): Promise<number>;
  /**
   * Moves every live session acting here (of `userId` only, when given) to its
   * user's fallback organization, or revokes it when there is none. Returns how
   * many it moved or revoked. Takes the sessions' row locks, so the caller has
   * already locked the organization and the memberships (the lock order).
   */
  reassignSessionsLeavingOrganization(userId?: string): Promise<number>;
}

/**
 * Bound to a transaction that carries the database context (context.ts) and
 * to the context whose organization it acts on. `organizations` has no
 * row-level security, so the scope's filter is its only guard.
 */
export function createActiveOrganizationRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IActiveOrganizationRepository {
  const scope = createOrganizationScope(transaction, context);
  const live = () => scope.selectFrom("organizations").selectAll().where("deleted_at", "is", null);
  const liveSettings = () =>
    scope.selectFrom("organizations").select("public_install_links_enabled").where("deleted_at", "is", null);
  const toSettings = (row: { public_install_links_enabled: boolean } | undefined): OrganizationSettings | undefined =>
    row ? { publicInstallLinks: row.public_install_links_enabled } : undefined;

  return {
    async findActive(): Promise<Organization | undefined> {
      const row = await live().executeTakeFirst();
      return row ? toOrganization(row) : undefined;
    },

    async lockActive(): Promise<Organization | undefined> {
      const row = await live().forNoKeyUpdate().executeTakeFirst();
      return row ? toOrganization(row) : undefined;
    },

    async findActiveForShare(): Promise<Organization | undefined> {
      const row = await live().forShare().executeTakeFirst();
      return row ? toOrganization(row) : undefined;
    },

    async findSettings(): Promise<OrganizationSettings | undefined> {
      return toSettings(await liveSettings().executeTakeFirst());
    },

    async findSettingsForShare(): Promise<OrganizationSettings | undefined> {
      return toSettings(await liveSettings().forShare().executeTakeFirst());
    },

    async setPublicInstallLinks(enabled: boolean): Promise<boolean> {
      const result = await scope
        .updateTable("organizations", { public_install_links_enabled: enabled, updated_at: new Date() })
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async rename(name: string): Promise<Organization | undefined> {
      const row = await withNameClashAsError(() =>
        scope
          .updateTable("organizations", { name, updated_at: new Date() })
          .where("deleted_at", "is", null)
          .returningAll()
          .executeTakeFirst(),
      );
      return row ? toOrganization(row) : undefined;
    },

    async setLogo(logo: OrganizationLogo | null): Promise<Organization | undefined> {
      const row = await scope
        .updateTable("organizations", {
          logo_id: logo?.logoId ?? null,
          logo_content_type: logo?.contentType ?? null,
          updated_at: new Date(),
        })
        .where("deleted_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      return row ? toOrganization(row) : undefined;
    },

    async findLogo(): Promise<OrganizationLogo | undefined> {
      const row = await scope
        .selectFrom("organizations")
        .select(["logo_id", "logo_content_type"])
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!row || row.logo_id === null || row.logo_content_type === null) return undefined;
      return { logoId: row.logo_id, contentType: row.logo_content_type };
    },

    async markDeleted(at: Date): Promise<boolean> {
      const result = await scope
        .updateTable("organizations", { deleted_at: at, updated_at: at })
        .where("type", "=", "group")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    // The two functions are SECURITY DEFINER: they reach other users' rows,
    // past row-level security. Each refuses (42501) unless its organization
    // is the one the database context names, which the scope's is.
    async deleteAccountsOnlyInOrganization(): Promise<number> {
      const { rows } = await sql<{ deleted: number }>`
        select delete_accounts_only_in_organization(${scope.organizationId}) as deleted
      `.execute(transaction);
      return rows[0]!.deleted;
    },

    async reassignSessionsLeavingOrganization(userId?: string): Promise<number> {
      const { rows } = await sql<{ changed: number }>`
        select reassign_sessions_leaving_organization(${scope.organizationId}, ${userId ?? null}) as changed
      `.execute(transaction);
      return rows[0]!.changed;
    },
  };
}
