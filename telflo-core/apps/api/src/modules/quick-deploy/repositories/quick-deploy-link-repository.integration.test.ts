import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import { addMembership, addQuickDeployLink, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import type { AuthContext } from "../../../database/context.js";
import { createAuditRepository } from "../../identity/repositories/audit-repository.js";
import { createActiveOrganizationRepository } from "../../organizations/repositories/organization-repository.js";
import { createQuickDeployLink, type QuickDeployLinkToCreate } from "../create-link.js";
import { openValues, quickDeployKeyRing } from "../sealed-values.js";
import {
  createQuickDeployLinkRepository,
  findQuickDeployLinkBySecretHash,
  QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET,
  type NewQuickDeployLink,
} from "./quick-deploy-link-repository.js";

/*
 * The quick-deploy link repository and the create's transaction
 * (create-link.ts), against the test database as the API's role: the cap
 * counted under its lock, the keyset list, extend, revoke, the counter, a
 * fleet's delete, the lookup by hash, each in the organization's context only.
 */

const APPLICATION_NAME = "quick-deploy-link-repository-test";
const DAY_MS = 86_400_000;
const keyRing = quickDeployKeyRing({ TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: randomBytes(32).toString("base64") });

describe("the quick-deploy link repository", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases({ applicationName: APPLICATION_NAME });
    ({ db, ownerDb } = databases);
  });
  afterAll(async () => {
    await databases.destroy();
  });
  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A member of a live group organization, as its AuthContext's ids. */
  const tenant = async () => {
    const person = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: person.user.id });
    return { userId: person.user.id, organizationId: group.organization.id, email: person.user.email };
  };
  type Tenant = Awaited<ReturnType<typeof tenant>>;
  const actorOf = (person: Tenant) => ({
    context: { userId: person.userId, organizationId: person.organizationId, role: "contributor", sessionId: randomUUID() } as AuthContext,
    email: person.email,
    ipAddress: "203.0.113.7",
    userAgent: "curl/8.7.1",
  });
  const inContext = <T>(person: Tenant, work: (links: ReturnType<typeof createQuickDeployLinkRepository>, transaction: Transaction<Database>) => Promise<T>) =>
    withDatabaseContext(db, { userId: person.userId, organizationId: person.organizationId }, (transaction) =>
      work(createQuickDeployLinkRepository(transaction, person), transaction),
    );
  const newLink = (id: string, fleetId: string, userId: string, now: Date): NewQuickDeployLink => ({
    id,
    fleetId,
    groupId: randomUUID(),
    defaultTokenId: randomUUID(),
    createdByUserId: userId,
    secretHash: randomBytes(32).toString("hex"),
    choices: { method: "all-in-one", arch: "arm64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: [] },
    sealed: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + DAY_MS),
  });
  const toCreate = (fleetId: string, now: Date, values: QuickDeployLinkToCreate["values"] = []): QuickDeployLinkToCreate => ({
    fleetId,
    groupId: randomUUID(),
    defaultTokenId: randomUUID(),
    secretHash: randomBytes(32).toString("hex"),
    choices: { method: "own-binary", arch: "amd64", rootPath: "/opt/telflo", executablePath: "/usr/bin/otelcol-contrib", systemd: false },
    values,
    createdAt: now,
    expiresAt: new Date(now.getTime() + DAY_MS),
  });
  /** The create's transaction, as the fleet routes' service runs it. */
  const create = (person: Tenant, link: QuickDeployLinkToCreate, cap?: number) =>
    withDatabaseContext(db, { userId: person.userId, organizationId: person.organizationId }, (transaction) => {
      const links = createQuickDeployLinkRepository(transaction, person);
      return createQuickDeployLink(
        {
          organization: createActiveOrganizationRepository(transaction, person),
          quickDeployLinks: { nextId: () => links.nextId(), createWithinCap: (row, now) => links.createWithinCap(row, now, cap) },
          audit: createAuditRepository(transaction),
        },
        actorOf(person),
        keyRing,
        link,
      );
    });
  const auditRows = () => ownerDb.selectFrom("audit_events").selectAll().where("action", "like", "quick_deploy_link.%").execute();
  const activeCount = async (fleetId: string, now: Date) =>
    Number(
      (
        await ownerDb
          .selectFrom("quick_deploy_links")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("fleet_id", "=", fleetId)
          .where("revoked_at", "is", null)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
          .executeTakeFirstOrThrow()
      ).n,
    );
  /**
   * Resolves once another of this file's connections waits on an advisory
   * lock (the cap's), or once `settled`; with `anyLock`, on any lock (a
   * row's too, so a race whose second would wait on the first's row, were
   * the cap's lock gone, is released rather than left waiting).
   */
  const untilWaitingOnTheCap = async (settled: () => boolean, anyLock = false) => {
    for (;;) {
      if (settled()) return;
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and application_name = ${APPLICATION_NAME}
           and wait_event_type = 'Lock' and (${anyLock} or wait_event = 'advisory')`.execute(ownerDb);
      if (rows[0]!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  describe("the create within the cap", () => {
    it("counts the cap under the fleet's lock: of two creates racing at 99 active links, the second waits for the first's commit and is refused, leaving exactly 100", async () => {
      const person = await tenant();
      const fleetId = randomUUID();
      const now = new Date();
      for (let index = 0; index < QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET - 1; index++) {
        await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: now, expires_at: new Date(now.getTime() + DAY_MS) });
      }
      // Neither a revoked nor an expired link counts, nor another fleet's.
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: new Date(now.getTime() - 1000), revoked_at: now });
      await addQuickDeployLink(ownerDb, {
        organizationId: person.organizationId,
        fleet_id: fleetId,
        created_at: new Date(now.getTime() - 2 * DAY_MS),
        expires_at: new Date(now.getTime() - 1000),
      });
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId });

      let firstInserted!: () => void;
      const inserted = new Promise<void>((resolve) => (firstInserted = resolve));
      let releaseFirst!: () => void;
      const released = new Promise<void>((resolve) => (releaseFirst = resolve));
      const first = inContext(person, async (links) => {
        const outcome = await links.createWithinCap(newLink(await links.nextId(), fleetId, person.userId, now), now);
        firstInserted();
        await released; // the transaction, and the lock with it, stays open until the second is seen waiting
        return outcome;
      });
      await inserted;
      let secondSettled = false;
      const second = inContext(person, async (links) => links.createWithinCap(newLink(await links.nextId(), fleetId, person.userId, now), now)).finally(
        () => (secondSettled = true),
      );
      // The second waits on the fleet's lock; were there none, it would finish, counting 99, and make a 101st.
      await untilWaitingOnTheCap(() => secondSettled);
      releaseFirst();
      expect((await first).kind).toBe("created");
      expect((await second).kind).toBe("limit_reached");
      expect(await activeCount(fleetId, now)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
    });

    it("locks per organization's fleet: a create for another fleet doesn't wait", async () => {
      const person = await tenant();
      const now = new Date();
      let releaseFirst!: () => void;
      const released = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstInserted!: () => void;
      const inserted = new Promise<void>((resolve) => (firstInserted = resolve));
      const first = inContext(person, async (links) => {
        const outcome = await links.createWithinCap(newLink(await links.nextId(), randomUUID(), person.userId, now), now);
        firstInserted();
        await released;
        return outcome;
      });
      await inserted;
      const other = await inContext(person, async (links) => links.createWithinCap(newLink(await links.nextId(), randomUUID(), person.userId, now), now));
      expect(other.kind).toBe("created");
      releaseFirst();
      expect((await first).kind).toBe("created");
    });

    it("makes the link with the id it picked, its values sealed for that id, and the created audit row with the member, ids and choices only, in one transaction", async () => {
      const person = await tenant();
      const fleetId = randomUUID();
      const now = new Date();
      const values = [
        { name: "NGINX_ENV", value: "prod" },
        { name: "REGION", value: "eu-west-1" },
      ];
      const request = toCreate(fleetId, now, values);
      const outcome = await create(person, request);
      if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
      const { link } = outcome;
      expect(link).toMatchObject({
        organizationId: person.organizationId,
        fleetId,
        groupId: request.groupId,
        defaultTokenId: request.defaultTokenId,
        createdBy: { userId: person.userId, email: person.email },
        choices: { ...request.choices, envNames: ["NGINX_ENV", "REGION"] },
        createdAt: now,
        expiresAt: request.expiresAt,
        revokedAt: null,
        downloadCount: 0,
        lastDownloadedAt: null,
      });
      expect(Object.keys(link)).not.toContain("secretHash");
      // No hash leaves the repository: not under another key either.
      expect(JSON.stringify(link)).not.toContain(request.secretHash);
      expect(openValues(keyRing, link.sealed!, { organizationId: person.organizationId, linkId: link.id }, link.choices.envNames)).toEqual(values);
      const row = await ownerDb.selectFrom("quick_deploy_links").selectAll().where("id", "=", link.id).executeTakeFirstOrThrow();
      expect(row.secret_hash).toBe(request.secretHash);
      expect(row.env_key_id).toBe(keyRing.current.id);
      expect(Buffer.from(row.env_ciphertext!).toString("utf8")).not.toContain("prod");

      expect(await auditRows()).toEqual([
        expect.objectContaining({
          action: "quick_deploy_link.created",
          actor_user_id: person.userId,
          actor_email: person.email,
          organization_id: person.organizationId,
          subject_type: "quick_deploy_link",
          subject_id: link.id,
          metadata: { linkId: link.id, fleetId, groupId: request.groupId, method: "own-binary", arch: "amd64", systemd: false },
          ip_address: "203.0.113.7",
          user_agent: "curl/8.7.1",
        }),
      ]);
      const audited = JSON.stringify(await auditRows());
      for (const text of ["NGINX_ENV", "prod", "/opt/telflo", "/usr/bin/otelcol-contrib", request.secretHash]) expect(audited).not.toContain(text);
    });

    it("seals nothing when no value was typed", async () => {
      const person = await tenant();
      const outcome = await create(person, toCreate(randomUUID(), new Date()));
      expect(outcome).toMatchObject({ kind: "created", link: { sealed: null, choices: { envNames: [] } } });
    });

    it("writes nothing, no link and no audit row, at the cap", async () => {
      const person = await tenant();
      const fleetId = randomUUID();
      const now = new Date();
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: now, expires_at: new Date(now.getTime() + DAY_MS) });
      expect(await create(person, toCreate(fleetId, now), 1)).toEqual({ kind: "limit_reached" });
      expect(await activeCount(fleetId, now)).toBe(1);
      expect(await auditRows()).toEqual([]);
    });

    it("writes nothing once the organization is deleted", async () => {
      const person = await tenant();
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", person.organizationId).execute();
      expect(await create(person, toCreate(randomUUID(), new Date()))).toEqual({ kind: "organization_gone" });
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("picks uuidv7 ids, ascending", async () => {
      const person = await tenant();
      const [a, b] = await inContext(person, async (links) => [await links.nextId(), await links.nextId()]);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(a! < b!).toBe(true);
    });
  });

  describe("a fleet's links", () => {
    it("lists newest first, keyset paged on (createdAt, id), the fleet's only, with the creator's email (null once the account is gone)", async () => {
      const person = await tenant();
      const other = await tenant();
      const fleetId = randomUUID();
      const at = new Date("2026-10-17T10:00:00.000Z");
      const made = [];
      for (const offset of [0, 1, 1, 2, 3]) {
        made.push(
          await addQuickDeployLink(ownerDb, {
            organizationId: person.organizationId,
            fleet_id: fleetId,
            created_at: new Date(at.getTime() + offset * 1000),
            expires_at: new Date(at.getTime() + DAY_MS),
            created_by_user_id: person.userId,
          }),
        );
      }
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId });
      await addQuickDeployLink(ownerDb, { organizationId: other.organizationId, fleet_id: fleetId });
      const expected = [...made]
        .sort((x, y) => y.created_at.getTime() - x.created_at.getTime() || (x.id < y.id ? 1 : -1))
        .map((link) => link.id);

      const pages = await inContext(person, async (links) => {
        const first = await links.list(fleetId, { limit: 2 });
        const last = first.at(-1)!;
        const second = await links.list(fleetId, { limit: 2, after: { createdAt: last.createdAt, id: last.id } });
        const end = second.at(-1)!;
        const third = await links.list(fleetId, { limit: 2, after: { createdAt: end.createdAt, id: end.id } });
        return [first, second, third];
      });
      expect(pages.map((page) => page.map((link) => link.id))).toEqual([expected.slice(0, 2), expected.slice(2, 4), expected.slice(4)]);
      expect(pages[0]![0]!.createdBy).toEqual({ userId: person.userId, email: person.email });
      for (const link of pages.flat()) expect(Object.keys(link)).not.toContain("secretHash");
      // No hash leaves the repository, under any key: none of the fleet's links' hashes is in the pages.
      const listed = JSON.stringify(pages);
      for (const link of made) expect(listed).not.toContain(link.secret_hash);

      await sql`update quick_deploy_links set created_by_user_id = null where id = ${expected[0]!}`.execute(ownerDb);
      expect((await inContext(person, (links) => links.list(fleetId, { limit: 1 })))[0]!.createdBy).toBeNull();
    });

    it("finds the fleet's link in any state, and not through another fleet or organization", async () => {
      const person = await tenant();
      const other = await tenant();
      const at = new Date();
      const link = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, created_at: at, revoked_at: at });
      expect(await inContext(person, (links) => links.find(link.fleet_id, link.id))).toMatchObject({ id: link.id, revokedAt: at });
      expect(await inContext(person, (links) => links.find(randomUUID(), link.id))).toBeUndefined();
      expect(await inContext(other, (links) => links.find(link.fleet_id, link.id))).toBeUndefined();
    });

    it("extends a link not revoked, expired or not, to a new expiry or never; a revoked one stays as it was; an unknown one is not found", async () => {
      const person = await tenant();
      const now = new Date();
      const expired = await addQuickDeployLink(ownerDb, {
        organizationId: person.organizationId,
        created_at: new Date(now.getTime() - 2 * DAY_MS),
        expires_at: new Date(now.getTime() - DAY_MS),
      });
      const later = new Date(now.getTime() + 7 * DAY_MS);
      expect(await inContext(person, (links) => links.extend(expired.fleet_id, expired.id, later, now))).toMatchObject({
        kind: "extended",
        link: { id: expired.id, expiresAt: later },
      });
      expect(await inContext(person, (links) => links.extend(expired.fleet_id, expired.id, null, now))).toMatchObject({
        kind: "extended",
        link: { expiresAt: null },
      });
      const revoked = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, created_at: now, revoked_at: now });
      expect(await inContext(person, (links) => links.extend(revoked.fleet_id, revoked.id, later, now))).toMatchObject({
        kind: "revoked",
        link: { id: revoked.id, expiresAt: revoked.expires_at, revokedAt: now },
      });
      expect(await inContext(person, (links) => links.extend(revoked.fleet_id, randomUUID(), later, now))).toEqual({ kind: "not_found" });
      expect(await inContext(person, (links) => links.extend(randomUUID(), expired.id, later, now))).toEqual({ kind: "not_found" });
    });

    /** `count` links active at `now` in the fleet, and one that expired a day ago. */
    const atTheCap = async (person: Tenant, fleetId: string, now: Date, count: number) => {
      for (let index = 0; index < count; index++) {
        await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: now, expires_at: new Date(now.getTime() + DAY_MS) });
      }
      return addQuickDeployLink(ownerDb, {
        organizationId: person.organizationId,
        fleet_id: fleetId,
        created_at: new Date(now.getTime() - 2 * DAY_MS),
        expires_at: new Date(now.getTime() - DAY_MS),
      });
    };

    it("refuses an expired link's extend at the cap, leaving it expired; an active link's extend counts its 99 others, so it is extended", async () => {
      const person = await tenant();
      const fleetId = randomUUID();
      const now = new Date();
      const expired = await atTheCap(person, fleetId, now, QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
      const later = new Date(now.getTime() + 7 * DAY_MS);
      expect(await inContext(person, (links) => links.extend(fleetId, expired.id, later, now))).toEqual({ kind: "limit_reached" });
      expect(await inContext(person, (links) => links.extend(fleetId, expired.id, null, now))).toEqual({ kind: "limit_reached" });
      expect((await ownerDb.selectFrom("quick_deploy_links").select("expires_at").where("id", "=", expired.id).executeTakeFirstOrThrow()).expires_at).toEqual(expired.expires_at);
      expect(await activeCount(fleetId, now)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
      // An active one at the cap: 99 others, so extended.
      const active = (await ownerDb.selectFrom("quick_deploy_links").select("id").where("fleet_id", "=", fleetId).where("id", "<>", expired.id).executeTakeFirstOrThrow()).id;
      expect(await inContext(person, (links) => links.extend(fleetId, active, later, now))).toMatchObject({ kind: "extended", link: { id: active, expiresAt: later } });
      // One revoked frees a place: the expired link is then extended.
      await ownerDb.updateTable("quick_deploy_links").set({ revoked_at: now }).where("id", "=", active).execute();
      expect(await inContext(person, (links) => links.extend(fleetId, expired.id, later, now))).toMatchObject({ kind: "extended", link: { id: expired.id, expiresAt: later } });
      expect(await activeCount(fleetId, now)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
    });

    /** Runs `first` in a transaction held open until `second` is seen waiting on the cap's lock, then both to their end. */
    const raced = async <A, B>(person: Tenant, first: (links: ReturnType<typeof createQuickDeployLinkRepository>) => Promise<A>, second: (links: ReturnType<typeof createQuickDeployLinkRepository>) => Promise<B>) => {
      let firstDone!: () => void;
      const done = new Promise<void>((resolve) => (firstDone = resolve));
      let releaseFirst!: () => void;
      const released = new Promise<void>((resolve) => (releaseFirst = resolve));
      const one = inContext(person, async (links) => {
        const outcome = await first(links);
        firstDone();
        await released; // the transaction, and the lock with it, stays open until the second is seen waiting
        return outcome;
      });
      await done;
      let secondSettled = false;
      const two = inContext(person, second).finally(() => (secondSettled = true));
      await untilWaitingOnTheCap(() => secondSettled, true);
      releaseFirst();
      return [await one, await two] as const;
    };

    it.each(["the extend first", "the create first"] as const)(
      "counts an expired link's extend and a create racing at 99 active links under the fleet's lock (%s): the second waits and is refused, leaving exactly 100",
      async (order) => {
        const person = await tenant();
        const fleetId = randomUUID();
        const now = new Date();
        const expired = await atTheCap(person, fleetId, now, QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET - 1);
        const extend = (links: ReturnType<typeof createQuickDeployLinkRepository>) => links.extend(fleetId, expired.id, null, now);
        const create = async (links: ReturnType<typeof createQuickDeployLinkRepository>) => links.createWithinCap(newLink(await links.nextId(), fleetId, person.userId, now), now);
        const kinds =
          order === "the extend first"
            ? (await raced(person, extend, create)).map((outcome) => outcome.kind)
            : (await raced(person, create, extend)).map((outcome) => outcome.kind);
        expect(kinds).toEqual(order === "the extend first" ? ["extended", "limit_reached"] : ["created", "limit_reached"]);
        expect(await activeCount(fleetId, now)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
      },
    );

    it("doesn't count the link itself: two extends of one expired link racing at 99 active links both extend it, leaving 100", async () => {
      const person = await tenant();
      const fleetId = randomUUID();
      const now = new Date();
      const expired = await atTheCap(person, fleetId, now, QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET - 1);
      const later = new Date(now.getTime() + 7 * DAY_MS);
      const [first, second] = await raced(
        person,
        (links) => links.extend(fleetId, expired.id, later, now),
        (links) => links.extend(fleetId, expired.id, null, now),
      );
      expect([first.kind, second.kind]).toEqual(["extended", "extended"]);
      expect(await activeCount(fleetId, now)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
    });

    it.each(["the create first", "the extend first"] as const)(
      "decides an extend under the fleet's lock, always: a link active at the extend's now but expired at a racing create's, at 99 others, leaves 100 at most (%s)",
      async (order) => {
        const person = await tenant();
        const fleetId = randomUUID();
        const t = new Date();
        for (let index = 0; index < QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET - 1; index++) {
          await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: t, expires_at: new Date(t.getTime() + DAY_MS) });
        }
        // Expiring at t: active at the extend's clock (t − 5 ms), expired at the create's (t + 5 ms).
        const x = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: new Date(t.getTime() - DAY_MS), expires_at: t });
        const before = new Date(t.getTime() - 5);
        const after = new Date(t.getTime() + 5);
        const extend = (links: ReturnType<typeof createQuickDeployLinkRepository>) => links.extend(fleetId, x.id, null, before);
        const create = async (links: ReturnType<typeof createQuickDeployLinkRepository>) => links.createWithinCap(newLink(await links.nextId(), fleetId, person.userId, after), after);
        const kinds =
          order === "the create first"
            ? (await raced(person, create, extend)).map((outcome) => outcome.kind)
            : (await raced(person, extend, create)).map((outcome) => outcome.kind);
        // Were the extend's "already active" decided before the lock, neither would count the other: 101.
        expect(kinds).toEqual(order === "the create first" ? ["created", "limit_reached"] : ["extended", "limit_reached"]);
        expect(await activeCount(fleetId, after)).toBe(QUICK_DEPLOY_LINKS_ACTIVE_PER_FLEET);
      },
    );

    it("revokes once: a repeat keeps the first revocation and its revoker; an unknown link is undefined", async () => {
      const person = await tenant();
      const second = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: second.user.id, organizationId: person.organizationId });
      const link = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId });
      const first = new Date(link.created_at.getTime() + 1000);
      expect(await inContext(person, (links) => links.revoke(link.fleet_id, link.id, person.userId, first))).toMatchObject({
        revokedAt: first,
        revokedByUserId: person.userId,
      });
      expect(
        await inContext(person, (links) => links.revoke(link.fleet_id, link.id, second.user.id, new Date(first.getTime() + 1000))),
      ).toMatchObject({ revokedAt: first, revokedByUserId: person.userId });
      expect(await inContext(person, (links) => links.revoke(link.fleet_id, randomUUID(), person.userId, first))).toBeUndefined();
      expect(await inContext(person, (links) => links.revoke(randomUUID(), link.id, person.userId, first))).toBeUndefined();
    });

    it("removes every link of a fleet at its delete, and only that fleet's, in the organization only", async () => {
      const person = await tenant();
      const other = await tenant();
      const fleetId = randomUUID();
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId });
      const at = new Date();
      await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, fleet_id: fleetId, created_at: at, revoked_at: at });
      const kept = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId });
      const othersFleet = await addQuickDeployLink(ownerDb, { organizationId: other.organizationId, fleet_id: fleetId });
      expect(await inContext(person, (links) => links.removeForFleet(fleetId))).toBe(2);
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").orderBy("id").execute()).map(({ id }) => id).sort()).toEqual(
        [kept.id, othersFleet.id].sort(),
      );
    });
  });

  describe("the download's reads and its counter", () => {
    it("finds a link by its hash with no database context, then reads it in its own organization's context only", async () => {
      const a = await tenant();
      const b = await tenant();
      const link = await addQuickDeployLink(ownerDb, { organizationId: a.organizationId });
      expect(await findQuickDeployLinkBySecretHash(db, link.secret_hash)).toEqual({ id: link.id, organizationId: a.organizationId, organizationIsLive: true });
      expect(await findQuickDeployLinkBySecretHash(db, randomBytes(32).toString("hex"))).toBeUndefined();
      expect(await inContext(b, (links) => links.findForDownload(link.id))).toBeUndefined();
      expect(await inContext(a, (links) => links.findForDownload(link.id))).toMatchObject({ id: link.id, fleetId: link.fleet_id });
    });

    it("counts each download at its time, every one of ten concurrent ones, none once the link is revoked or expired", async () => {
      const person = await tenant();
      const now = new Date();
      const link = await addQuickDeployLink(ownerDb, { organizationId: person.organizationId, created_at: now, expires_at: new Date(now.getTime() + DAY_MS) });
      const download = (at: Date) => inContext(person, (links) => links.recordDownload(link.id, at));
      const at = new Date(now.getTime() + 1000);
      const rows = await Promise.all(Array.from({ length: 10 }, () => download(at)));
      expect(rows.every((row) => row !== undefined)).toBe(true);
      expect(await ownerDb.selectFrom("quick_deploy_links").select(["download_count", "last_downloaded_at"]).where("id", "=", link.id).executeTakeFirst()).toEqual({
        download_count: 10,
        last_downloaded_at: at,
      });
      // Past its expiry by the caller's clock.
      expect(await download(new Date(now.getTime() + DAY_MS))).toBeUndefined();
      await ownerDb.updateTable("quick_deploy_links").set({ revoked_at: at }).where("id", "=", link.id).execute();
      expect(await download(at)).toBeUndefined();
      expect(await ownerDb.selectFrom("quick_deploy_links").select("download_count").where("id", "=", link.id).executeTakeFirst()).toEqual({ download_count: 10 });
    });

    it("counts nothing in another organization's context", async () => {
      const a = await tenant();
      const b = await tenant();
      const link = await addQuickDeployLink(ownerDb, { organizationId: a.organizationId });
      expect(await inContext(b, (links) => links.recordDownload(link.id, new Date()))).toBeUndefined();
      expect(await ownerDb.selectFrom("quick_deploy_links").select("download_count").where("id", "=", link.id).executeTakeFirst()).toEqual({ download_count: 0 });
    });
  });
});
