import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { addMembership, addQuickDeployLink, createUserWithOrganization, openTestDatabases, truncateAll } from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * quick_deploy_links (migration 1700000000032): its constraints, as the owner;
 * its row-level security and the lookup by the secret's hash, as the API's
 * role (`db`), which the policies constrain. schema.integration.test.ts has
 * the migration's catalog (up, down, up).
 */
describe("quick_deploy_links", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A live group organization with an admin, who also keeps their personal organization. */
  const createOrganization = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: admin.user.id });
    return { userId: admin.user.id, organization: group.organization };
  };

  const linkRow = (id: string) => ownerDb.selectFrom("quick_deploy_links").selectAll().where("id", "=", id).executeTakeFirst();

  describe("constraints", () => {
    it("stores a link with its defaults: no downloads, not revoked", async () => {
      const { userId, organization } = await createOrganization();
      const link = await addQuickDeployLink(ownerDb, { organizationId: organization.id, created_by_user_id: userId });
      expect(link).toMatchObject({
        organization_id: organization.id,
        created_by_user_id: userId,
        env_ciphertext: null,
        env_key_id: null,
        revoked_at: null,
        revoked_by_user_id: null,
        download_count: 0,
        last_downloaded_at: null,
        choices: { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: [] },
      });
    });

    it("stores sealed values with their key id, a link that never expires, and a revoked one with its revoker", async () => {
      const { userId, organization } = await createOrganization();
      const ciphertext = randomBytes(64);
      const sealed = await addQuickDeployLink(ownerDb, { organizationId: organization.id, env_ciphertext: ciphertext, env_key_id: "0123456789abcdef" });
      expect(Buffer.from(sealed.env_ciphertext!).equals(ciphertext)).toBe(true);
      await expect(addQuickDeployLink(ownerDb, { organizationId: organization.id, expires_at: null })).resolves.toMatchObject({ expires_at: null });
      const at = new Date();
      await expect(
        addQuickDeployLink(ownerDb, { organizationId: organization.id, created_at: at, revoked_at: at, revoked_by_user_id: userId }),
      ).resolves.toMatchObject({ revoked_by_user_id: userId });
    });

    it.each([
      ["a secret_hash that isn't sha-256 hex (the secret itself)", { secret_hash: `tqd_${"A".repeat(43)}` }, "ck_quick_deploy_links_secret_hash"],
      ["a secret_hash in upper case", { secret_hash: "A".repeat(64) }, "ck_quick_deploy_links_secret_hash"],
      ["choices that aren't an object", { choices: JSON.stringify(["all-in-one"]) }, "ck_quick_deploy_links_choices"],
      ["choices over 16 KiB", { choices: JSON.stringify({ envNames: ["A".repeat(16_384)] }) }, "ck_quick_deploy_links_choices"],
      ["a ciphertext without its key id", { env_ciphertext: randomBytes(64) }, "ck_quick_deploy_links_env_sealed"],
      ["a key id without a ciphertext", { env_key_id: "0123456789abcdef" }, "ck_quick_deploy_links_env_sealed"],
      ["a key id that isn't 16 lowercase hex", { env_ciphertext: randomBytes(64), env_key_id: "0123456789ABCDEF" }, "ck_quick_deploy_links_env_key_id"],
      ["a ciphertext shorter than its header", { env_ciphertext: randomBytes(28), env_key_id: "0123456789abcdef" }, "ck_quick_deploy_links_env_ciphertext_length"],
      ["a ciphertext over 1 MiB", { env_ciphertext: randomBytes(1_048_577), env_key_id: "0123456789abcdef" }, "ck_quick_deploy_links_env_ciphertext_length"],
      [
        "an expiry not after the creation",
        { created_at: new Date("2026-10-17T00:00:00Z"), expires_at: new Date("2026-10-17T00:00:00Z") },
        "ck_quick_deploy_links_expires_after_created",
      ],
      [
        "a revocation before the creation",
        { created_at: new Date("2026-10-17T00:00:00Z"), revoked_at: new Date("2026-10-16T23:59:59Z") },
        "ck_quick_deploy_links_revoked_after_created",
      ],
      ["a revoker on a link not revoked", { revoked_by_user_id: "self" }, "ck_quick_deploy_links_revoked_by"],
      ["a count with no last download", { download_count: 1 }, "ck_quick_deploy_links_downloads"],
      ["a last download with no count", { last_downloaded_at: new Date() }, "ck_quick_deploy_links_downloads"],
      ["a negative count", { download_count: -1, last_downloaded_at: new Date() }, "ck_quick_deploy_links_downloads"],
    ])("refuses %s", async (_label, overrides, constraint) => {
      const { userId, organization } = await createOrganization();
      const values = { ...overrides } as Record<string, unknown>;
      if (values.revoked_by_user_id === "self") values.revoked_by_user_id = userId;
      await expect(addQuickDeployLink(ownerDb, { organizationId: organization.id, ...values })).rejects.toThrow(new RegExp(constraint));
    });

    it("refuses a hash another link has, in any organization", async () => {
      const first = await createOrganization();
      const second = await createOrganization();
      const link = await addQuickDeployLink(ownerDb, { organizationId: first.organization.id });
      await expect(addQuickDeployLink(ownerDb, { organizationId: second.organization.id, secret_hash: link.secret_hash })).rejects.toThrow(
        /uq_quick_deploy_links_secret_hash/,
      );
    });

    it("goes with its organization's hard delete, and keeps a link with no creator or revoker once their account is hard-deleted", async () => {
      const { organization } = await createOrganization();
      const other = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: other.user.id, organizationId: organization.id });
      const at = new Date();
      const link = await addQuickDeployLink(ownerDb, {
        organizationId: organization.id,
        created_by_user_id: other.user.id,
        created_at: at,
        revoked_at: at,
        revoked_by_user_id: other.user.id,
      });
      await ownerDb.deleteFrom("users").where("id", "=", other.user.id).execute();
      expect(await linkRow(link.id)).toMatchObject({ created_by_user_id: null, revoked_by_user_id: null, revoked_at: at });

      await ownerDb.deleteFrom("organizations").where("id", "=", organization.id).execute();
      expect(await linkRow(link.id)).toBeUndefined();
    });
  });

  describe("row-level security, as the application role", () => {
    /** `work` in a transaction whose database context names `organizationId` (none for null). */
    const inContext = <T>(organizationId: string | null, work: (transaction: Kysely<Database>) => Promise<T>) =>
      db.transaction().execute(async (transaction) => {
        if (organizationId !== null) await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
        return work(transaction);
      });

    it("shows nothing without a context, and only the context's organization's links with one", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await addQuickDeployLink(ownerDb, { organizationId: a.organization.id });
      const inB = await addQuickDeployLink(ownerDb, { organizationId: b.organization.id });
      const ids = (transaction: Kysely<Database>) => transaction.selectFrom("quick_deploy_links").select("id").execute();
      expect(await inContext(null, ids)).toEqual([]);
      expect(await inContext(a.organization.id, ids)).toEqual([{ id: inA.id }]);
      expect(await inContext(b.organization.id, ids)).toEqual([{ id: inB.id }]);
    });

    it("updates and deletes none of another organization's links, and refuses an insert naming it (42501)", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await addQuickDeployLink(ownerDb, { organizationId: a.organization.id });
      const before = await linkRow(inA.id);

      const updated = await inContext(b.organization.id, (transaction) =>
        transaction
          .updateTable("quick_deploy_links")
          .set({ revoked_at: new Date(), download_count: 7, last_downloaded_at: new Date() })
          .where("id", "=", inA.id)
          .executeTakeFirst(),
      );
      expect(updated.numUpdatedRows).toBe(0n);
      const deleted = await inContext(b.organization.id, (transaction) =>
        transaction.deleteFrom("quick_deploy_links").where("id", "=", inA.id).executeTakeFirst(),
      );
      expect(deleted.numDeletedRows).toBe(0n);
      expect(await linkRow(inA.id)).toEqual(before);

      await expect(
        inContext(b.organization.id, (transaction) =>
          transaction
            .insertInto("quick_deploy_links")
            .values({
              organization_id: a.organization.id,
              fleet_id: randomUUID(),
              group_id: randomUUID(),
              default_token_id: randomUUID(),
              secret_hash: randomBytes(32).toString("hex"),
              choices: JSON.stringify({}),
              created_at: new Date(),
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("refuses an update that moves a link into another organization (42501)", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await addQuickDeployLink(ownerDb, { organizationId: a.organization.id });
      await expect(
        inContext(a.organization.id, (transaction) =>
          transaction.updateTable("quick_deploy_links").set({ organization_id: b.organization.id }).where("id", "=", inA.id).execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await linkRow(inA.id)).toMatchObject({ organization_id: a.organization.id });
    });
  });

  describe("the lookup by the secret's hash, as the application role", () => {
    const byHash = async (hash: string) =>
      (
        await sql<{ id: string; organization_id: string; organization_is_live: boolean }>`
          select * from quick_deploy_link_by_secret_hash(${hash})`.execute(db)
      ).rows;

    it("finds a link by its hash with no database context, in any state, with its organization and whether that is live, and nothing more", async () => {
      const { organization } = await createOrganization();
      const at = new Date();
      const revoked = await addQuickDeployLink(ownerDb, { organizationId: organization.id, created_at: at, revoked_at: at });
      const expired = await addQuickDeployLink(ownerDb, {
        organizationId: organization.id,
        created_at: new Date(at.getTime() - 2 * 86_400_000),
        expires_at: new Date(at.getTime() - 86_400_000),
      });
      await addQuickDeployLink(ownerDb, { organizationId: organization.id });
      expect(await byHash(revoked.secret_hash)).toEqual([{ id: revoked.id, organization_id: organization.id, organization_is_live: true }]);
      expect(await byHash(expired.secret_hash)).toEqual([{ id: expired.id, organization_id: organization.id, organization_is_live: true }]);

      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", organization.id).execute();
      expect(await byHash(revoked.secret_hash)).toEqual([{ id: revoked.id, organization_id: organization.id, organization_is_live: false }]);
    });

    it("finds nothing by anything but the exact hash: an unknown one, the empty string, a prefix, a pattern, upper case, the hash with a space", async () => {
      const { organization } = await createOrganization();
      const link = await addQuickDeployLink(ownerDb, { organizationId: organization.id });
      for (const probe of [
        "0".repeat(64),
        "",
        link.secret_hash.slice(0, 63),
        `${link.secret_hash.slice(0, 10)}%`,
        "%",
        link.secret_hash.toUpperCase(),
        `${link.secret_hash} `,
      ]) {
        expect({ probe, found: await byHash(probe) }).toEqual({ probe, found: [] });
      }
    });

    it("is executable by telflo_platform_runtime (the API's login through it) and not by public", async () => {
      const { rows } = await sql<{ application: boolean; everyone: boolean }>`
        select has_function_privilege('telflo_platform_runtime', 'quick_deploy_link_by_secret_hash(text)', 'EXECUTE') as application,
               has_function_privilege('public', 'quick_deploy_link_by_secret_hash(text)', 'EXECUTE') as everyone`.execute(ownerDb);
      expect(rows).toEqual([{ application: true, everyone: false }]);
      const { rows: login } = await sql<{ granted: boolean }>`
        select has_function_privilege(current_user, 'quick_deploy_link_by_secret_hash(text)', 'EXECUTE') as granted`.execute(db);
      expect(login).toEqual([{ granted: true }]);
    });
  });
});
