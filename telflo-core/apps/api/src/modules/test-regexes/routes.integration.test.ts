import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  TEST_REGEX_NAME_TAKEN_MESSAGE,
} from "@telflo/contracts";
import { createDb, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  createUserWithOrganization,
  insertSeededTestRegexes,
  loadTestRegexMigration,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS, type OttlEvaluatorClient } from "../../ottl-evaluator/client.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { fakeOttlEvaluatorMarker, type FakeOttlEvaluatorFault, type FakeOttlEvaluatorRequest } from "../../testing/fake-ottl-evaluator.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_OTTL_EVALUATOR, useFakeOttlEvaluator } from "../../testing/ottl-evaluator.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs (D11b decision 8), and the OTTL
// evaluator's OpenAPI-checked fake (D15a Task 5): this file's own.
const opamp = useFakeOpampServer();
const evaluator = useFakeOttlEvaluator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const TEST_REGEXES = "/api/v1/test-regexes";

/** Markers no log line, URL or audit row may hold: an entry's name, category, description and regex (ADR 0024). */
const NAME_MARKER = "regex-name-marker-4b8e";
const CATEGORY_MARKER = "regex-category-marker-91d0";
const DESCRIPTION_MARKER = "regex-description-marker-c27f";
const REGEX_MARKER = "regex-regex-marker-5e13";

/** The fake evaluator's words for a regex its `invalid` marker names (fake-ottl-evaluator.ts's invalidMessage). */
const INVALID_REGEX = "Invalid regex: error parsing regexp: missing closing ): `(fake-ottl-evaluator` (fake)";

/** A regex the fake evaluator refuses as RE2 would. */
const BROKEN_REGEX = `(${fakeOttlEvaluatorMarker("invalid")}`;

/** The words, exactly. */
const MESSAGES = {
  notFound: "Test regex not found",
  nameTaken: "A regex with that name already exists.",
  productAdminRequired: "Only a product admin can do that.",
  termsRequired: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  invalid: "The request was not valid.",
  rateLimited: "Too many rule checks in the last minute. Try again shortly.",
  unavailable: "Rules can't be checked right now. Try again shortly.",
};

/** The application name of the one-connection pool's backend, which pg_stat_activity shows. */
const ONE_CONNECTION_APPLICATION_NAME = "test-regexes-one-connection";

/** The one wall-clock limit of a wait on a connection: a hang guard only, never a pause. */
const CONNECTION_HANG_GUARD = 10_000;

/** The real setTimeout, which a test's fake timers leave alone. */
const realSetTimeout = globalThis.setTimeout;

/** The fields a log line of this module may hold beside pino's and Fastify's own. */
const LOGGER_FIELDS = new Set(["level", "time", "pid", "hostname", "reqId", "msg"]);

/*
 * D15b Task 2: the regex library's API (decisions 7 and 8; details 17 and
 * 18; Preflight rulings 3 and 4), against Postgres as the API's own role,
 * with the OTTL evaluator's fake (its markers steer its answers, nextFault
 * queues failures). truncateAll empties test_regex: a test that needs the 35
 * seeded entries inserts them (insertSeededTestRegexes).
 */
describe("the regex library API", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  /** A server whose evaluator rejects any call: a write that reaches it fails with a 500. */
  let uncalled: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let logLines: string[] = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return clock;
  };

  /** A server on the test database, logging every line to `logLines`. */
  async function serverWith(
    options: { rateLimits?: RateLimits; ottlEvaluator?: OttlEvaluatorClient; db?: Kysely<Database> } = {},
  ): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: { ...UNCALLED_TESTING, ottlEvaluator: options.ottlEvaluator ?? evaluator.client },
        settings: loadSettings(process.env),
        db: options.db ?? databases.db,
        now: () => new Date(clock.getTime()),
        mailer: createInMemoryMailer(),
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    servers.push(built);
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
    server = await serverWith();
    uncalled = await serverWith({ ottlEvaluator: UNCALLED_OTTL_EVALUATOR });
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    logLines = [];
    evaluator.fake.takeRequests();
    clock = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
  });

  afterEach(() => {
    // The platform sent the fake nothing the evaluator's contract refuses.
    expect(evaluator.fake.takeViolations()).toEqual([]);
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  interface Person {
    userId: string;
    email: string;
    /** The group organization the session is active in. */
    organizationId: string;
    /** Their personal workspace, which they may switch to. */
    personalOrganizationId: string;
    access: string;
  }

  /**
   * A signed-in person active in a new group organization, as `role`: a
   * product admin when `isProductAdmin`, with the current terms unless
   * `hasAcceptedTerms` is false.
   */
  const person = async (
    options: { isProductAdmin?: boolean; hasAcceptedTerms?: boolean; role?: OrganizationRole } = {},
  ): Promise<Person> => {
    const ownerDb = databases.ownerDb;
    const account = await createUserWithOrganization(ownerDb, {
      user: {
        email: `person-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        ...(options.isProductAdmin ? { is_product_admin: true } : {}),
      },
    });
    const { organization } = await addMembership(ownerDb, { userId: account.user.id, role: options.role ?? "contributor" });
    const signedIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: cookieValue(signedIn, "telflo_access") },
      payload: { organizationId: organization.id },
    });
    expect(switched.statusCode).toBe(200);
    if (options.hasAcceptedTerms === false) {
      // The session check reads the user's row on each request: the terms change under the open session.
      await ownerDb.updateTable("users").set({ accepted_terms_version: "2025-01-01" }).where("id", "=", account.user.id).execute();
    }
    return {
      userId: account.user.id,
      email: account.user.email,
      organizationId: organization.id,
      personalOrganizationId: account.organization.id,
      // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
      access: (switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access")),
    };
  };
  const productAdmin = (options: { hasAcceptedTerms?: boolean; role?: OrganizationRole } = {}) =>
    person({ ...options, isProductAdmin: true });

  /** `who`'s session, moved to `organizationId`: the same person, another organization. */
  const switchedTo = async (who: Person, organizationId: string): Promise<Person> => {
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: who.access },
      payload: { organizationId },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return { ...who, organizationId, access: (switched.headers["set-cookie"] === undefined ? who.access : cookieValue(switched, "telflo_access")) };
  };

  const call = (
    who: Person | undefined,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    options: { on?: FastifyInstance } = {},
  ) =>
    (options.on ?? server).inject({
      method,
      url,
      headers: csrfHeaders,
      ...(who === undefined ? {} : { cookies: { telflo_access: who.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: statusCode,
      body: { error: { code, message } },
    });
  }

  /** 400 `invalid_request`: the contract refused the body. */
  function expectInvalid(response: LightMyRequestResponse): void {
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_request");
  }

  /** 400 `test_regex_invalid`, with the evaluator's words, its problem placed under `regex`. */
  function expectRegexInvalid(response: LightMyRequestResponse, message = INVALID_REGEX): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { error: { code: "test_regex_invalid", message, details: { problems: [{ field: "regex", message }] } } },
    });
  }

  interface TestRegexBody {
    id: string;
    name: string;
    category: string;
    description: string | null;
    regex: string;
    createdAt: string;
    updatedAt: string;
  }

  /** An entry's fields, its name unique to the test. */
  const entry = (overrides: Partial<Record<"name" | "category" | "description" | "regex", string | null>> = {}) => ({
    name: `Email ${NAME_MARKER} ${randomUUID()}`,
    category: `PII ${CATEGORY_MARKER}`,
    description: `Matches emails ${DESCRIPTION_MARKER}`,
    regex: `[a-z]+@[a-z]+\\.com${REGEX_MARKER}`,
    ...overrides,
  });

  /** An entry `admin` creates through the API. */
  const created = async (admin: Person, overrides: Parameters<typeof entry>[0] = {}, options: { on?: FastifyInstance } = {}) => {
    const response = await call(admin, "POST", TEST_REGEXES, entry(overrides), options);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ testRegex: TestRegexBody }>().testRegex;
  };

  const pathOf = (testRegexId: string) => `${TEST_REGEXES}/${testRegexId}`;

  const rows = () => databases.ownerDb.selectFrom("test_regex").selectAll().orderBy("created_at").orderBy("id").execute();
  const auditRows = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", "test_regex.%")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
  const validations = () => evaluator.fake.takeRequests().filter((request) => request.operation === "validate");

  /** This module's log lines (its checks'), parsed. */
  const checkLines = () =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => typeof line.msg === "string" && /test regex checked|OTTL evaluator/.test(line.msg));

  /**
   * The evaluator's faults that end a check as unavailable once the fake has
   * read the request: it fails, is busy, refuses the request as the
   * contract's breach (400) or as too large (413), or answers a 200 that has
   * lost validate's `valid` (malformed_reply). `reset` is the one it never
   * reads.
   */
  const ANSWERED_UNAVAILABLE: readonly FakeOttlEvaluatorFault[] = [
    "error_500",
    "evaluator_busy",
    "invalid_request",
    "payload_too_large",
    "malformed_reply",
  ];

  /** The fake's own record of its malformed reply, which the afterEach would otherwise fail on. */
  const expectMalformedReplyViolation = () =>
    expect(evaluator.fake.takeViolations()).toEqual([expect.stringContaining("reply 200 body")]);

  /**
   * `who`'s write, its check never answered (the fake's `hang`) until the
   * client's own timer of OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS ends it: under
   * fake timers, moved on only once the fake has read the request, so there
   * is no wall-clock wait (as the client's own timeout test). The wait for
   * the fake's read is a condition under a hang guard, on the real timers.
   */
  async function timedOut(who: Person, method: "POST" | "PATCH", url: string, payload: unknown) {
    evaluator.fake.nextFault("hang");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answered = false;
      const pending = call(who, method, url, payload).then((response) => {
        answered = true;
        return response;
      });
      // Until the fake has read it (vi.waitFor would move the fake clock on as it polls).
      const read: FakeOttlEvaluatorRequest[] = [];
      const giveUpAt = Date.now() + CONNECTION_HANG_GUARD;
      while (read.length === 0 && Date.now() < giveUpAt) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
        read.push(...evaluator.fake.takeRequests());
      }
      expect(read.map((request) => request.operation)).toEqual(["validate"]);
      await vi.advanceTimersByTimeAsync(OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS - 1);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  describe("reading the library (GET, members)", () => {
    it("lists every entry, the 35 seeded and an admin's own, by category, then name, under the database's collation, never cached", async () => {
      await insertSeededTestRegexes(databases.ownerDb);
      const admin = await productAdmin();
      const member = await person();
      const mine = [
        await created(admin, { category: "Zebra", name: "Last of all" }),
        await created(admin, { category: "Aardvark", name: "First of all", description: null }),
        await created(admin, { category: "PCI", name: "Diners Club" }),
      ];

      const listed = await call(member, "GET", TEST_REGEXES);
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      const testRegexes = listed.json<{ testRegexes: TestRegexBody[] }>().testRegexes;
      expect(testRegexes).toHaveLength(38);

      // The 35, byte for byte, beside the three.
      const { seededTestRegexes } = await loadTestRegexMigration();
      for (const seeded of seededTestRegexes) {
        expect(testRegexes.find((each) => each.name === seeded.name)).toMatchObject({
          name: seeded.name,
          category: seeded.category,
          description: seeded.description,
          regex: seeded.regex,
        });
      }
      expect(testRegexes.find((each) => each.name === "US Social Security Number")!.regex).toBe("\\d{3}-\\d{2}-\\d{4}");
      expect(testRegexes.find((each) => each.id === mine[1]!.id)).toEqual(mine[1]);

      // en_US.utf8, as localeCompare (Preflight ruling 3): "Credit Card" before "CVV Code" (under "C" they swap).
      const expected = [...testRegexes].sort(
        (a, b) => a.category.localeCompare(b.category, "en-US") || a.name.localeCompare(b.name, "en-US"),
      );
      expect(testRegexes.map((each) => [each.category, each.name])).toEqual(expected.map((each) => [each.category, each.name]));
      expect(testRegexes[0]!.name).toBe("First of all");
      expect(testRegexes.at(-1)!.name).toBe("Last of all");
      expect(testRegexes.filter((each) => each.category === "PCI").map((each) => each.name)).toEqual([
        "Credit Card",
        "CVV Code",
        "Diners Club",
      ]);
    });

    it("lists an empty library as [] (truncateAll empties it)", async () => {
      const member = await person();
      const listed = await call(member, "GET", TEST_REGEXES);
      expect(listed.json()).toEqual({ testRegexes: [] });
    });

    it("refuses a member without the current terms (403 terms_acceptance_required)", async () => {
      const member = await person({ hasAcceptedTerms: false });
      expectRefusal(await call(member, "GET", TEST_REGEXES), 403, "terms_acceptance_required", MESSAGES.termsRequired);
    });

    it("lists the library to a product admin without the current terms, as the test templates' list (the admin page's)", async () => {
      await insertSeededTestRegexes(databases.ownerDb);
      const admin = await productAdmin({ hasAcceptedTerms: false });
      const listed = await call(admin, "GET", TEST_REGEXES);
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ testRegexes: TestRegexBody[] }>().testRegexes).toHaveLength(35);
    });

    it("needs a session on every endpoint (401), never cached", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      for (const [method, url, body] of [
        ["GET", TEST_REGEXES, undefined],
        ["POST", TEST_REGEXES, entry()],
        ["PATCH", pathOf(testRegex.id), { name: "x" }],
        ["DELETE", pathOf(testRegex.id), undefined],
      ] as const) {
        const response = await call(undefined, method, url, body);
        expectRefusal(response, 401, "unauthenticated", MESSAGES.unauthenticated);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(await rows()).toHaveLength(1);
    });
  });

  describe("creating one (POST, product admins only)", () => {
    it("checks the regex under the evaluator's RE2, then saves the row and an audit row of ids in no organization (201)", async () => {
      const admin = await productAdmin();
      const body = entry({ name: `  Email ${NAME_MARKER}  `, regex: " \\b[a-z]+@example\\.com\\b " });

      const response = await call(admin, "POST", TEST_REGEXES, body);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const testRegex = response.json<{ testRegex: TestRegexBody }>().testRegex;
      expect(testRegex).toEqual({
        id: expect.any(String),
        name: `Email ${NAME_MARKER}`,
        category: body.category,
        description: body.description,
        // Never trimmed: its spaces are part of it.
        regex: " \\b[a-z]+@example\\.com\\b ",
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      });
      expect((await rows()).map((row) => [row.id, row.name, row.category, row.description, row.regex])).toEqual([
        [testRegex.id, testRegex.name, testRegex.category, testRegex.description, " \\b[a-z]+@example\\.com\\b "],
      ]);
      // RE2 doesn't depend on the signal or target: a placeholder of each (Preflight ruling 4).
      expect(validations().map((request) => request.body)).toEqual([
        { signal: "logs", rule: { kind: "contains_regex", target: "output", pattern: " \\b[a-z]+@example\\.com\\b " } },
      ]);
      const audits = await auditRows();
      expect(audits.map((row) => [row.action, row.organization_id, row.subject_type, row.subject_id, row.metadata, row.actor_user_id])).toEqual([
        ["test_regex.created", null, "test_regex", testRegex.id, {}, admin.userId],
      ]);
    });

    it("saves a description left out, '', or only whitespace (Unicode's included) as none (null)", async () => {
      const admin = await productAdmin();
      const { description: _left, ...withoutDescription } = entry();
      const saved = [await call(admin, "POST", TEST_REGEXES, withoutDescription)];
      for (const description of ["", "   ", "\u3000\u0085\u00a0", null]) {
        saved.push(await call(admin, "POST", TEST_REGEXES, entry({ description })));
      }
      for (const response of saved) {
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json<{ testRegex: TestRegexBody }>().testRegex.description).toBeNull();
      }
      expect((await rows()).map((row) => row.description)).toEqual([null, null, null, null, null]);
    });

    it("refuses a regex RE2 doesn't take with the evaluator's words, its problem under regex (400 test_regex_invalid), saving nothing", async () => {
      const admin = await productAdmin();
      const response = await call(admin, "POST", TEST_REGEXES, entry({ regex: BROKEN_REGEX }));
      expectRegexInvalid(response);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(validations()).toHaveLength(1);
      expect(await rows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("refuses every create while the evaluator can't check it: down, failing, busy, refusing the request or answering malformed (503 rules_unavailable, decision 8's words)", async () => {
      const admin = await productAdmin();
      for (const fault of ["reset", ...ANSWERED_UNAVAILABLE] as const) {
        evaluator.fake.nextFault(fault);
        expectRefusal(await call(admin, "POST", TEST_REGEXES, entry()), 503, "rules_unavailable", MESSAGES.unavailable);
        if (fault === "malformed_reply") expectMalformedReplyViolation();
      }
      expect(validations()).toHaveLength(ANSWERED_UNAVAILABLE.length);
      // The fake's own markers: a busy and a failing evaluator, by the request.
      for (const marker of ["busy", "unavailable"] as const) {
        expectRefusal(
          await call(admin, "POST", TEST_REGEXES, entry({ regex: fakeOttlEvaluatorMarker(marker) })),
          503,
          "rules_unavailable",
          MESSAGES.unavailable,
        );
      }
      expect(RULES_UNAVAILABLE_AT_SAVE_MESSAGE).toBe(MESSAGES.unavailable);
      expect(await rows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("refuses a create whose check the evaluator never answers within the client's 5 s (503 rules_unavailable; fake timers), saving and auditing nothing", async () => {
      const admin = await productAdmin();
      expectRefusal(await timedOut(admin, "POST", TEST_REGEXES, entry()), 503, "rules_unavailable", MESSAGES.unavailable);
      expect(await rows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
      expect(checkLines().map((line) => line.result)).toEqual(["unavailable"]);
    });

    it("refuses a name another entry has, a seeded one included, before the check (409 test_regex_name_taken, decision 8's words); names are compared case and all", async () => {
      await insertSeededTestRegexes(databases.ownerDb);
      const admin = await productAdmin();
      const first = await created(admin, { name: "Diners Club" });
      validations();

      for (const name of ["Diners Club", "  Diners Club ", "Email Address"]) {
        expectRefusal(await call(admin, "POST", TEST_REGEXES, entry({ name })), 409, "test_regex_name_taken", MESSAGES.nameTaken);
      }
      expect(TEST_REGEX_NAME_TAKEN_MESSAGE).toBe(MESSAGES.nameTaken);
      // A duplicate spends no check.
      expect(validations()).toEqual([]);
      // Another case is another name (uq_test_regex_name is case-sensitive).
      expect((await call(admin, "POST", TEST_REGEXES, entry({ name: "diners club" }))).statusCode).toBe(201);
      expect((await rows()).filter((row) => row.name.toLowerCase() === "diners club").map((row) => row.id)[0]).toBe(first.id);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created", "test_regex.created"]);
    });

    it("refuses a name taken while the regex was checked (the race path: 23505 on uq_test_regex_name is 409), saving nothing of its own and logging no name", async () => {
      const admin = await productAdmin();
      const name = `Raced ${NAME_MARKER}`;
      const racing: OttlEvaluatorClient = {
        ...evaluator.client,
        validate: async (...args) => {
          // Another writer takes the name after the pre-read, while the check runs.
          await databases.ownerDb
            .insertInto("test_regex")
            .values({ name, category: "Other", description: null, regex: "x", created_at: clock, updated_at: clock })
            .execute();
          return evaluator.client.validate(...args);
        },
      };
      const raced = await serverWith({ ottlEvaluator: racing });

      expectRefusal(await call(admin, "POST", TEST_REGEXES, entry({ name }), { on: raced }), 409, "test_regex_name_taken", MESSAGES.nameTaken);
      expect((await rows()).map((row) => [row.name, row.category])).toEqual([[name, "Other"]]);
      expect(await auditRows()).toEqual([]);
      expect(logLines.filter((line) => line.includes(NAME_MARKER))).toEqual([]);
    });

    it("saves nothing when the audit row can't be written (500): the row and its audit row are one transaction", async () => {
      const admin = await productAdmin();
      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'audit refused'", async () => {
        expect((await call(admin, "POST", TEST_REGEXES, entry())).statusCode).toBe(500);
      });
      expect(await rows()).toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ["a blank name", { name: "   " }],
      ["a name of Unicode's whitespace only", { name: "\u0085\u3000\u00a0" }],
      ["a 201-character name", { name: "n".repeat(201) }],
      ["a blank category", { category: "" }],
      ["a category of Unicode's whitespace only", { category: "\u2028\u0085" }],
      ["a 101-character category", { category: "c".repeat(101) }],
      ["a 2,001-character description", { description: "d".repeat(2_001) }],
      ["an empty regex", { regex: "" }],
      ["a regex of Unicode's whitespace only", { regex: "\u0085\u3000" }],
      ["a regex of 8,193 bytes", { regex: "a".repeat(8_193) }],
      ["a regex with U+0000", { regex: "a\u0000" }],
      ["an unknown field", { pattern: "a" }],
      ["no regex", { regex: undefined }],
    ])("refuses %s (400 invalid_request) before any check, saving nothing", async (_label, overrides) => {
      const admin = await productAdmin();
      const response = await call(admin, "POST", TEST_REGEXES, { ...entry(), ...overrides }, { on: uncalled });
      expectInvalid(response);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(await rows()).toEqual([]);
    });

    it("saves each field at its bound: 200, 100 and 2,000 characters, and a regex of 8,192 bytes", async () => {
      const admin = await productAdmin();
      const body = { name: "n".repeat(200), category: "c".repeat(100), description: "d".repeat(2_000), regex: "é".repeat(4_096) };
      const response = await call(admin, "POST", TEST_REGEXES, body);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<{ testRegex: TestRegexBody }>().testRegex).toMatchObject(body);
    });

    it("asks the evaluator outside any transaction, holding no connection: on a one-connection pool, a checked POST and PATCH succeed while the evaluator itself queries that pool", async () => {
      const admin = await productAdmin();
      const url = new URL(process.env.TELFLO_DATABASE_URL!);
      url.searchParams.set("application_name", ONE_CONNECTION_APPLICATION_NAME);
      const oneDb = createDb(new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: CONNECTION_HANG_GUARD }));
      const asked: Array<{ idleInTransaction: number; pooled: number }> = [];
      const wrapped: OttlEvaluatorClient = {
        ...evaluator.client,
        validate: async (...args) => {
          const held = await sql<{ count: number }>`
            select count(*)::int as count
              from pg_stat_activity
             where datname = current_database()
               and usename = 'telflo_platform'
               and application_name = ${ONE_CONNECTION_APPLICATION_NAME}
               and state like 'idle in transaction%'
          `.execute(databases.ownerDb);
          const pooled = await sql<{ one: number }>`select 1 as one`.execute(oneDb);
          asked.push({ idleInTransaction: held.rows[0]!.count, pooled: pooled.rows[0]!.one });
          return evaluator.client.validate(...args);
        },
      };
      const oneConnection = await serverWith({ db: oneDb, ottlEvaluator: wrapped });
      try {
        const testRegex = await created(admin, {}, { on: oneConnection });
        const patched = await call(admin, "PATCH", pathOf(testRegex.id), { regex: "\\d{9}" }, { on: oneConnection });
        expect(patched.statusCode, patched.body).toBe(200);
        expect(asked).toEqual([
          { idleInTransaction: 0, pooled: 1 },
          { idleInTransaction: 0, pooled: 1 },
        ]);
      } finally {
        await oneConnection.close();
        servers.splice(servers.indexOf(oneConnection), 1);
        await oneDb.destroy();
      }
    });
  });

  describe("changing one (PATCH, product admins only)", () => {
    it("changes the fields given, checking a new regex once, moving updated_at, and audits the changed fields' names only", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      validations();
      const at = tick();

      const response = await call(admin, "PATCH", pathOf(testRegex.id), {
        name: ` Renamed ${NAME_MARKER} `,
        category: `Secrets ${CATEGORY_MARKER}`,
        description: testRegex.description,
        regex: `\\bAKIA[0-9A-Z]{16}\\b${REGEX_MARKER}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ testRegex: TestRegexBody }>().testRegex).toEqual({
        ...testRegex,
        name: `Renamed ${NAME_MARKER}`,
        category: `Secrets ${CATEGORY_MARKER}`,
        regex: `\\bAKIA[0-9A-Z]{16}\\b${REGEX_MARKER}`,
        updatedAt: at.toISOString(),
      });
      expect(validations().map((request) => request.body)).toEqual([
        { signal: "logs", rule: { kind: "contains_regex", target: "output", pattern: `\\bAKIA[0-9A-Z]{16}\\b${REGEX_MARKER}` } },
      ]);
      expect((await auditRows()).map((row) => [row.action, row.organization_id, row.subject_id, row.metadata])).toEqual([
        ["test_regex.created", null, testRegex.id, {}],
        // The description was already that: only what changed.
        ["test_regex.updated", null, testRegex.id, { changedFields: ["name", "category", "regex"] }],
      ]);
    });

    it("asks no evaluator for a change of the name, category or description, nor for a regex equal to the stored one", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      validations();
      for (const body of [
        { name: `Renamed ${randomUUID()}` },
        { category: "Secrets" },
        { description: "Another" },
        { regex: testRegex.regex, name: `Again ${randomUUID()}` },
      ]) {
        // The uncalled server's evaluator rejects any call: a check would be a 500.
        const response = await call(admin, "PATCH", pathOf(testRegex.id), body, { on: uncalled });
        expect(response.statusCode, response.body).toBe(200);
      }
      const response = await call(admin, "PATCH", pathOf(testRegex.id), { name: "Once more" });
      expect(response.statusCode).toBe(200);
      expect(validations()).toEqual([]);
      expect((await auditRows()).map((row) => row.metadata)).toEqual([
        {},
        { changedFields: ["name"] },
        { changedFields: ["category"] },
        { changedFields: ["description"] },
        { changedFields: ["name"] },
        { changedFields: ["name"] },
      ]);
    });

    it("checks a regex that differs from the stored one only in whitespace, each time with exactly the regex sent (RE2 reads a trailing space, and `\\d+\\ ` compiles where `\\d+\\` doesn't)", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin, { regex: "\\d+ " });
      validations();
      for (const regex of ["\\d+", "\\d+  ", "\\d+\t"]) {
        const response = await call(admin, "PATCH", pathOf(testRegex.id), { regex });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ testRegex: TestRegexBody }>().testRegex.regex).toBe(regex);
      }
      expect(validations().map((request) => request.body)).toEqual(
        ["\\d+", "\\d+  ", "\\d+\t"].map((pattern) => ({ signal: "logs", rule: { kind: "contains_regex", target: "output", pattern } })),
      );
      expect((await rows()).map((row) => row.regex)).toEqual(["\\d+\t"]);
      expect((await auditRows()).map((row) => row.metadata)).toEqual([
        {},
        { changedFields: ["regex"] },
        { changedFields: ["regex"] },
        { changedFields: ["regex"] },
      ]);
    });

    it("answers an empty PATCH ({}) and one changing nothing with the entry as it is (200), writing and auditing nothing", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      tick();
      for (const body of [
        {},
        { name: testRegex.name },
        { name: ` ${testRegex.name}\u0085`, category: testRegex.category, description: testRegex.description, regex: testRegex.regex },
      ]) {
        const response = await call(admin, "PATCH", pathOf(testRegex.id), body, { on: uncalled });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ testRegex: TestRegexBody }>().testRegex).toEqual(testRegex);
      }
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created"]);
      expect((await rows())[0]!.updated_at).toEqual(new Date(testRegex.updatedAt));
    });

    it("removes the description with '', only whitespace or null", async () => {
      const admin = await productAdmin();
      for (const description of ["", " \u3000 ", null]) {
        const testRegex = await created(admin);
        const response = await call(admin, "PATCH", pathOf(testRegex.id), { description }, { on: uncalled });
        expect(response.json<{ testRegex: TestRegexBody }>().testRegex.description).toBeNull();
      }
      expect((await rows()).map((row) => row.description)).toEqual([null, null, null]);
    });

    it("refuses a regex RE2 doesn't take (400 test_regex_invalid under regex), and every check while the evaluator is down, failing, busy, refusing the request or answering malformed (503), changing nothing", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      const before = await rows();
      validations();
      const patch = (body: Record<string, unknown>) => call(admin, "PATCH", pathOf(testRegex.id), body);

      expectRegexInvalid(await patch({ regex: BROKEN_REGEX, name: "Not saved" }));
      for (const fault of ["reset", ...ANSWERED_UNAVAILABLE] as const) {
        evaluator.fake.nextFault(fault);
        expectRefusal(await patch({ regex: "\\d+", name: "Not saved" }), 503, "rules_unavailable", MESSAGES.unavailable);
        if (fault === "malformed_reply") expectMalformedReplyViolation();
      }
      // The reset's request never reached the fake's reading: one recorded per other fault, and the invalid one's.
      expect(validations()).toHaveLength(1 + ANSWERED_UNAVAILABLE.length);
      expect(await rows()).toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created"]);
    });

    it("refuses a regex change whose check the evaluator never answers within the client's 5 s (503 rules_unavailable; fake timers), changing and auditing nothing", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      const before = await rows();
      validations();
      logLines = [];

      expectRefusal(
        await timedOut(admin, "PATCH", pathOf(testRegex.id), { regex: "\\d+", name: "Not saved" }),
        503,
        "rules_unavailable",
        MESSAGES.unavailable,
      );
      expect(await rows()).toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created"]);
      expect(checkLines().map((line) => [line.result, line.testRegexId])).toEqual([["unavailable", testRegex.id]]);
    });

    it("refuses a rename to a name another entry has (409: 23505 on uq_test_regex_name), changing nothing and logging no name", async () => {
      const admin = await productAdmin();
      const taken = await created(admin, { name: `Taken ${NAME_MARKER}` });
      const other = await created(admin);
      const before = await rows();

      for (const body of [{ name: taken.name }, { name: `  ${taken.name}`, category: "Moved" }]) {
        expectRefusal(await call(admin, "PATCH", pathOf(other.id), body, { on: uncalled }), 409, "test_regex_name_taken", MESSAGES.nameTaken);
      }
      expect(await rows()).toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created", "test_regex.created"]);
      expect(logLines.filter((line) => line.includes(NAME_MARKER))).toEqual([]);
    });

    it("answers an unknown, a nil and a malformed id with 404 test_regex_not_found before any check; an id in upper case is the same entry", async () => {
      const admin = await productAdmin();
      for (const id of [randomUUID(), "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        expectRefusal(await call(admin, "PATCH", pathOf(id), { regex: BROKEN_REGEX }, { on: uncalled }), 404, "test_regex_not_found", MESSAGES.notFound);
      }
      const testRegex = await created(admin);
      const renamed = await call(admin, "PATCH", pathOf(testRegex.id.toUpperCase()), { name: "Upper" });
      expect(renamed.json<{ testRegex: TestRegexBody }>().testRegex).toMatchObject({ id: testRegex.id, name: "Upper" });
    });

    it("refuses fields too long, blank or Unicode-blank, an unknown field and a null name (400), changing nothing", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      const before = await rows();
      for (const body of [
        { name: "  " },
        { name: "\u0085\u2028" },
        { name: "n".repeat(201) },
        { category: "\u3000" },
        { category: "c".repeat(101) },
        { description: "d".repeat(2_001) },
        { regex: "" },
        { regex: "\u00a0\u0085" },
        { regex: "a".repeat(8_193) },
        { name: null },
        { id: randomUUID() },
        { createdAt: clock.toISOString() },
      ]) {
        expectInvalid(await call(admin, "PATCH", pathOf(testRegex.id), body, { on: uncalled }));
      }
      expect(await rows()).toEqual(before);
    });
  });

  describe("deleting one (DELETE, product admins only)", () => {
    it("deletes it for good (204) with an audit row of ids in no organization; a second delete is 404", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      const kept = await created(admin);

      const response = await call(admin, "DELETE", pathOf(testRegex.id), undefined, { on: uncalled });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await rows()).map((row) => row.id)).toEqual([kept.id]);
      expect((await auditRows()).map((row) => [row.action, row.organization_id, row.subject_type, row.subject_id, row.metadata])).toEqual([
        ["test_regex.created", null, "test_regex", testRegex.id, {}],
        ["test_regex.created", null, "test_regex", kept.id, {}],
        ["test_regex.deleted", null, "test_regex", testRegex.id, {}],
      ]);
      expectRefusal(await call(admin, "DELETE", pathOf(testRegex.id)), 404, "test_regex_not_found", MESSAGES.notFound);
    });

    it("answers an unknown, a nil and a malformed id with 404 test_regex_not_found, deleting nothing", async () => {
      const admin = await productAdmin();
      await created(admin);
      for (const id of [randomUUID(), "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        expectRefusal(await call(admin, "DELETE", pathOf(id)), 404, "test_regex_not_found", MESSAGES.notFound);
      }
      expect(await rows()).toHaveLength(1);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created"]);
    });
  });

  describe("who may write", () => {
    it("refuses a member, an organization's admin included, every write with 403 product_admin_required, writing nothing and asking no evaluator", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      validations();
      for (const member of [await person(), await person({ role: "admin" })]) {
        for (const [method, url, body] of [
          ["POST", TEST_REGEXES, entry()],
          ["PATCH", pathOf(testRegex.id), { name: "Taken over", regex: "\\d+" }],
          ["DELETE", pathOf(testRegex.id), undefined],
        ] as const) {
          const response = await call(member, method, url, body);
          expectRefusal(response, 403, "product_admin_required", MESSAGES.productAdminRequired);
          expect(response.headers["cache-control"]).toBe("no-store");
        }
      }
      expect(validations()).toEqual([]);
      expect((await rows()).map((row) => [row.id, row.name])).toEqual([[testRegex.id, testRegex.name]]);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_regex.created"]);
    });

    it("refuses a product admin whose flag is revoked on the very next write (403)", async () => {
      const admin = await productAdmin();
      const testRegex = await created(admin);
      await databases.ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", admin.userId).execute();
      for (const [method, url, body] of [
        ["POST", TEST_REGEXES, entry()],
        ["PATCH", pathOf(testRegex.id), { name: "Revoked" }],
        ["DELETE", pathOf(testRegex.id), undefined],
      ] as const) {
        expectRefusal(await call(admin, method, url, body), 403, "product_admin_required", MESSAGES.productAdminRequired);
      }
      expect((await rows()).map((row) => row.name)).toEqual([testRegex.name]);
      // Still a member: the list reads.
      expect((await call(admin, "GET", TEST_REGEXES)).statusCode).toBe(200);
    });

    it("needs no current terms of a product admin's writes, as the test templates' and flows' writes", async () => {
      const admin = await productAdmin({ hasAcceptedTerms: false });
      const testRegex = await created(admin);
      expect((await call(admin, "PATCH", pathOf(testRegex.id), { name: "Renamed" })).statusCode).toBe(200);
      expect((await call(admin, "DELETE", pathOf(testRegex.id))).statusCode).toBe(204);
    });
  });

  describe("the checks' limit (RATE_LIMITS: each admin's own 30 checked saves a minute, Preflight ruling 4)", () => {
    it("counts every create and regex change the evaluator is asked about, refused or not, and never gives one back: the 31st is 429; a name-only PATCH and a duplicate name aren't counted", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      const other = await productAdmin();
      const post = (body: Record<string, unknown>, who: Person = admin) => call(who, "POST", TEST_REGEXES, body, { on: limited });

      // 1 check.
      const testRegex = await created(admin, {}, { on: limited });
      // Not counted: name-only changes, an unchanged regex, a duplicate name, a body refused.
      for (let n = 0; n < 5; n += 1) {
        expect((await call(admin, "PATCH", pathOf(testRegex.id), { name: `Renamed ${n}` }, { on: limited })).statusCode).toBe(200);
      }
      expect((await call(admin, "PATCH", pathOf(testRegex.id), { regex: testRegex.regex }, { on: limited })).statusCode).toBe(200);
      expect((await post(entry({ name: "Renamed 4" }))).statusCode).toBe(409);
      expect((await post({ ...entry(), regex: "" })).statusCode).toBe(400);
      // 3 more: one the evaluator refuses, one while it is busy, one regex change.
      expect((await post(entry({ regex: BROKEN_REGEX }))).statusCode).toBe(400);
      evaluator.fake.nextFault("evaluator_busy");
      expect((await post(entry())).statusCode).toBe(503);
      expect((await call(admin, "PATCH", pathOf(testRegex.id), { regex: "\\d{2}" }, { on: limited })).statusCode).toBe(200);
      // 26 more: 30 in all.
      for (let n = 0; n < 26; n += 1) expect((await post(entry())).statusCode).toBe(201);
      expect(validations()).toHaveLength(30);

      const refused = await post(entry());
      expectRefusal(refused, 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expectRefusal(
        await call(admin, "PATCH", pathOf(testRegex.id), { regex: "\\d{3}" }, { on: limited }),
        429,
        "validation_rule_rate_limited",
        MESSAGES.rateLimited,
      );
      expect(validations()).toEqual([]);

      // A change needing no check isn't refused; a duplicate is still 409, not 429.
      expect((await call(admin, "PATCH", pathOf(testRegex.id), { name: "After the limit" }, { on: limited })).statusCode).toBe(200);
      expect((await post(entry({ name: "After the limit" }))).statusCode).toBe(409);
      // Another admin has their own 30.
      expect((await post(entry(), other)).statusCode).toBe(201);
    });

    it("keys the count on the person alone (user:<id>): switching organization gives no fresh 30, and it is apart from the rules' checked saves in each organization (organization:<id>:user:<id>), both ways", async () => {
      const limited = await serverWith({
        rateLimits: { ...TEST_RATE_LIMITS, validationRuleChecksPerUser: { max: 3, windowMs: 60_000 } },
      });
      const admin = await productAdmin({ role: "admin" });
      const configuration = await addConfiguration(databases.ownerDb, {
        organizationId: admin.organizationId,
        created_by_user_id: admin.userId,
      });
      // Published, so another member of the organization sees it too.
      const version = await addConfigurationVersion(databases.ownerDb, {
        configurationId: configuration.id,
        organizationId: admin.organizationId,
        created_by_user_id: admin.userId,
        publishedAt: new Date(),
      });
      const pipelinesPath =
        `/api/v1/organizations/${admin.organizationId}/configurations/${configuration.id}/versions/${version.id}/validation-pipelines`;
      const pipeline = await call(admin, "POST", pipelinesPath, { pipeline: "logs/default" });
      expect(pipeline.statusCode, pipeline.body).toBe(201);
      const rulesPath = `${pipelinesPath}/${pipeline.json<{ validationPipeline: { id: string } }>().validationPipeline.id}/rules`;
      const rule = (n: number) => ({ kind: "contains_regex", target: "output", pattern: `\\d{${n}}` });
      const saveRule = (who: Person, n: number) => call(who, "POST", rulesPath, rule(n), { on: limited });
      const saveEntry = (who: Person) => call(who, "POST", TEST_REGEXES, entry(), { on: limited });

      // The library's three, in the group organization's session.
      for (let n = 0; n < 3; n += 1) expect((await saveEntry(admin)).statusCode).toBe(201);
      expectRefusal(await saveEntry(admin), 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      // The organization's rule saves have their own three, untouched by the library's.
      for (let n = 1; n <= 3; n += 1) expect((await saveRule(admin, n)).statusCode).toBe(201);
      expectRefusal(await saveRule(admin, 4), 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      // The person alone: a session in another organization shares the library's count (the old token is spent).
      const inPersonal = await switchedTo(admin, admin.personalOrganizationId);
      expectRefusal(await saveEntry(inPersonal), 429, "validation_rule_rate_limited", MESSAGES.rateLimited);

      // The other way: an admin who spends the organization's three on rules still has the library's three.
      const second = await productAdmin({ role: "admin" });
      await addMembership(databases.ownerDb, { userId: second.userId, organizationId: admin.organizationId, role: "admin" });
      const secondInOrganization = await switchedTo(second, admin.organizationId);
      for (let n = 1; n <= 3; n += 1) expect((await saveRule(secondInOrganization, n)).statusCode).toBe(201);
      expectRefusal(await saveRule(secondInOrganization, 4), 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      for (let n = 0; n < 3; n += 1) expect((await saveEntry(secondInOrganization)).statusCode).toBe(201);
      validations();
    });
  });

  describe("privacy (ADR 0024)", () => {
    it("puts no entry's name, category, description or regex in any audit row or log line; a check's line names the entry's id and its result only, and an unavailable one the client's reason, status and code", async () => {
      const admin = await productAdmin();
      const member = await person();
      const testRegex = await created(admin);
      await call(admin, "PATCH", pathOf(testRegex.id), {
        name: `Renamed ${NAME_MARKER}`,
        category: `Moved ${CATEGORY_MARKER}`,
        description: `Described ${DESCRIPTION_MARKER}`,
        regex: `\\w+${REGEX_MARKER}`,
      });
      // A space after each fake marker: the fake reads one only before a word boundary.
      await call(admin, "PATCH", pathOf(testRegex.id), { regex: `${BROKEN_REGEX} ${REGEX_MARKER}` });
      evaluator.fake.nextFault("reset");
      await call(admin, "PATCH", pathOf(testRegex.id), { regex: `\\s+${REGEX_MARKER}` });
      evaluator.fake.nextFault("invalid_request");
      await call(admin, "PATCH", pathOf(testRegex.id), { regex: `\\S+${REGEX_MARKER}` });
      await call(admin, "POST", TEST_REGEXES, entry({ name: `Renamed ${NAME_MARKER}` }));
      await call(admin, "POST", TEST_REGEXES, entry({ regex: `${BROKEN_REGEX} ${REGEX_MARKER}` }));
      await call(admin, "POST", TEST_REGEXES, entry({ regex: `${fakeOttlEvaluatorMarker("busy")} ${REGEX_MARKER}` }));
      await call(admin, "POST", TEST_REGEXES, { ...entry(), name: `${NAME_MARKER}${"n".repeat(300)}` });
      await call(member, "POST", TEST_REGEXES, entry());
      await call(member, "GET", TEST_REGEXES);
      await call(admin, "DELETE", pathOf(testRegex.id));

      const audits = await auditRows();
      expect(audits.map((row) => row.action)).toEqual(["test_regex.created", "test_regex.updated", "test_regex.deleted"]);
      expect(logLines.length).toBeGreaterThan(0);
      for (const marker of [NAME_MARKER, CATEGORY_MARKER, DESCRIPTION_MARKER, REGEX_MARKER, "fake-ottl-evaluator"]) {
        expect(JSON.stringify(audits)).not.toContain(marker);
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }

      // Each check's line: {testRegexId, result} (a create has no id yet), an
      // unavailable one's the client's reason, and its status and envelope's
      // code when the evaluator answered (as D15a's rule check), and nothing
      // else of its own.
      const lines = checkLines();
      expect(lines.map((line) => [line.result, line.testRegexId ?? null])).toEqual([
        ["valid", null],
        ["valid", testRegex.id],
        ["invalid", testRegex.id],
        ["unavailable", testRegex.id],
        ["unavailable", testRegex.id],
        ["invalid", null],
        ["busy", null],
      ]);
      const unavailable = lines.filter((line) => line.result === "unavailable");
      expect(unavailable.map((line) => [line.level, line.msg, line.reason, line.status, line.code])).toEqual([
        [40, "the OTTL evaluator is unavailable", "network", undefined, undefined],
        [50, "the OTTL evaluator can't be used", "invalid_request", 400, "invalid_request"],
      ]);
      for (const line of lines) {
        const own = line.testRegexId === undefined ? ["result"] : ["result", "testRegexId"];
        const answered = line.status === undefined ? [] : ["code", "status"];
        expect(Object.keys(line).filter((key) => !LOGGER_FIELDS.has(key)).sort()).toEqual(
          (line.result === "unavailable" ? [...own, "reason", ...answered] : own).sort(),
        );
      }
    });
  });
});
