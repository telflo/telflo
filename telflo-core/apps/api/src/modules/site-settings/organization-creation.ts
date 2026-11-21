import type { OrganizationCreation } from "@telflo/contracts";
import type { Database, StoredOrganizationCreation } from "@telflo/db";
import type { Kysely } from "kysely";

/*
 * Who may create a group organization: the product admins' switch, "Only
 * product admins can create organizations", stored in migration
 * 1700000000044's one-row site_settings. On (`product_admins`) by default, in
 * every registration mode: a fresh install lets only product admins create
 * one.
 *
 * The API's role reads the row here, with no database context (a global
 * table, no row-level security): an organization's create and `/me` read it
 * on each request. Only the SystemRepository changes it, through the
 * product-admin definer, which writes the audit row with it.
 *
 * The contract spells the value `product-admins` (as `invite-only`); the
 * column `product_admins` (as the block kinds). These two maps are the only
 * place the spellings meet.
 */

const toContract: Record<StoredOrganizationCreation, OrganizationCreation> = {
  everyone: "everyone",
  product_admins: "product-admins",
};

const toStored: Record<OrganizationCreation, StoredOrganizationCreation> = {
  everyone: "everyone",
  "product-admins": "product_admins",
};

/** The column's value in the contract's spelling. */
export function organizationCreationOf(stored: StoredOrganizationCreation): OrganizationCreation {
  return toContract[stored];
}

/** The contract's value in the column's spelling. */
export function storedOrganizationCreationOf(value: OrganizationCreation): StoredOrganizationCreation {
  return toStored[value];
}

/** Reads the switch from its one row. */
export async function readOrganizationCreation(db: Kysely<Database>): Promise<OrganizationCreation> {
  const row = await db.selectFrom("site_settings").select("organization_creation").executeTakeFirstOrThrow();
  return organizationCreationOf(row.organization_creation);
}

/**
 * Whether a person may create an organization: anyone while the switch is
 * off, only a product admin (as this request's session check read the
 * flag) while it is on.
 */
export function mayCreateOrganizations(creation: OrganizationCreation, isProductAdmin: boolean): boolean {
  return creation === "everyone" || isProductAdmin;
}
