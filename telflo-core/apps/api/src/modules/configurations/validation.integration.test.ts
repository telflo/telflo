import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { prepareTestDatabase, THROWAWAY_DATABASE_DROP_TIMEOUT } from "@telflo/db/test-database";
import { createCollectingRunner } from "../../http/after-response.js";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import {
  createOtelcolValidatorClient,
  type OtelcolValidatorClient,
  type ValidateRequest,
  type ValidateResult,
} from "../../otelcol-validator/client.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import type { FakeOtelcolValidatorFault } from "../../testing/fake-otelcol-validator.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { useFakeOtelcolValidator } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import { VARIABLES_UNAVAILABLE_MESSAGE } from "../variables/errors.js";

// The opamp-server every server needs, and the collector validator this
// file is about: its own fakes.
const opamp = useFakeOpampServer();
const validator = useFakeOtelcolValidator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** Creating, migrating and dropping a database waits for checkpoints. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/** The committed catalogue's distribution. */
const CONTRIB = "otelcol-contrib";
/** A Contrib version this file deprecates: a fixture's, never the committed catalogue's. */
const RETIRED = "0.1.0";
/** A fixture distribution, and its versions: none of them is Contrib's. */
const FIXTURE = "fixture-build";
const FIXTURE_DEFAULT = "9.9.1";
const FIXTURE_OTHER = "9.9.0";

/** The refusals' words, exactly: the validation's, the catalogue's and the envelope's. */
const MESSAGES = {
  unavailable: "Validation is unavailable. Your YAML was not checked — retry shortly.",
  perMinute: "Too many checks in the last minute. Checking again shortly.",
  inFlight: "Too many checks at once. Checking again shortly.",
  versionUnknown: "That collector version isn't available.",
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  organizationNotFound: "Organization not found",
  terms: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  csrf: "This request is missing a required header.",
  invalid: "The request was not valid.",
};

/** A text no log line may hold, and a component the fake refuses, whose message no log line may hold either. */
const TEXT_MARKER = "text-marker-7f3a9c";
const REFUSED_TYPE = "unknown_refusedmarker";
const textWith = (extra = "") =>
  `receivers:\n  otlp:\n    protocols:\n      grpc: {}\n# ${TEXT_MARKER} café 🚀\nexporters:\n  debug: {}\n${extra}`;
/** An exporter the fake refuses, and an environment variable it reports as a requirement. */
const INVALID_TEXT = textWith(`  ${REFUSED_TYPE}/edge-2:\n    endpoint: \${env:EXPORT_URL}\n`);

interface ValidationBody {
  status: "valid" | "invalid" | "retired";
  collectorVersion: string;
  errors: Array<{ message: string; componentPath: string | null }>;
  requirements: Array<{ category: string; title: string; description: string; componentPath: string | null }>;
}

/** A one-shot gate: `hold` waits until `release`, and `reached` resolves once something holds. */
function createGate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: () => open(),
    hold: async () => {
      reach();
      await released;
    },
  };
}

/** The URL of a server that just closed: nothing listens there. */
async function closedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/*
 * The validation against Postgres through the API as its own role, with the
 * OpenAPI-checked fake as the validator. The server's client is the fake's,
 * wrapped in process: every call is recorded, and a test can put a hook in
 * front of it (a gate, a look at the pool) or swap the client (a wrong secret,
 * a short timeout, nothing listening). A version of another distribution needs
 * a catalogue the committed one isn't, so the file runs on a throwaway
 * database it prepares (migrated and synced, as telflo_platform_test is) and
 * drops afterwards, with a fixture distribution and a deprecated Contrib
 * version.
 */
describe("a version's validation", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let settings: AppSettings;
  /** The server's pool, as the API's own role: what a validation must not hold while it asks the validator. */
  let pool: Pool;
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  /** Contrib's default version and another offered one, as the tables hold them. */
  let contribDefault: string;
  let contribOther: string;
  /** The server's log lines since the test began, every level. */
  let logLines: string[] = [];
  /** Every check the server asked the validator for since the test began. */
  let calls: ValidateRequest[] = [];
  /** A test's hook in front of the client. */
  let hook: ((request: ValidateRequest) => Promise<ValidateResult>) | undefined;
  /** The client the wrapper delegates to when no hook is set: the fake's, unless a test swaps it. */
  let delegate: () => OtelcolValidatorClient = () => validator.client;
  const servers: FastifyInstance[] = [];

  /** The wrapper the server calls: records the call, then runs the test's hook or the delegate. */
  const serverValidator: OtelcolValidatorClient = {
    validate: (request) => {
      calls.push(request);
      return (hook ?? ((checked: ValidateRequest) => delegate().validate(checked)))(request);
    },
  };

  /** The organizations whose variables the server read from the opamp-server since the test began. */
  let variableReads: string[] = [];

  /** A server on the throwaway database, logging every line to `logLines`. */
  async function serverWith(rateLimits: RateLimits): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        // The fake's client, each read of the variables recorded.
        opampServer: {
          ...opamp.client,
          listVariables: (organizationId) => {
            variableReads.push(organizationId);
            return opamp.client.listVariables(organizationId);
          },
        },
        otelcolValidator: serverValidator,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits,
        runAfterResponse: (task) => createCollectingRunner().run(task),
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
    throwawayName = `telflo_validation_${randomUUID().replaceAll("-", "")}_test`;
    const ownerUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerUrl.pathname = `/${throwawayName}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${throwawayName}`;
    await prepareTestDatabase(ownerUrl.toString(), applicationUrl.toString());
    ownerDb = createDb(createPool(ownerUrl.toString()));
    pool = createPool(applicationUrl.toString());
    db = createDb(pool);
    settings = loadSettings(process.env);

    const version = (distribution: string, number: string, fields: { isDefault?: boolean; deprecated?: boolean }) => ({
      distribution,
      version: number,
      label: `v${number}`,
      description: null,
      released_at: "2026-01-01",
      is_default: fields.isDefault ?? false,
      deprecated: fields.deprecated ?? false,
      deprecated_note: fields.deprecated ? "Retired fixture." : null,
      container_image: `example/${distribution}:${number}`,
      otelcol_contrib_version: distribution === CONTRIB ? null : "0.162.0",
      supported_components: null,
      otelcol_contrib: "{}",
      opamp_supervisor: "{}",
    });
    await ownerDb
      .insertInto("collector_distributions")
      .values({ id: FIXTURE, label: "Fixture Build", description: null, icon: null, sort_order: 9, is_default: false })
      .execute();
    await ownerDb
      .insertInto("collector_versions")
      .values([
        version(FIXTURE, FIXTURE_DEFAULT, { isDefault: true }),
        version(FIXTURE, FIXTURE_OTHER, {}),
        version(CONTRIB, RETIRED, { deprecated: true }),
      ])
      .execute();
    const offered = await ownerDb
      .selectFrom("collector_versions")
      .select(["version", "is_default"])
      .where("distribution", "=", CONTRIB)
      .where("deprecated", "=", false)
      .execute();
    contribDefault = offered.find((row) => row.is_default)!.version;
    contribOther = offered.find((row) => !row.is_default)!.version;

    server = await serverWith(TEST_RATE_LIMITS);
    passwordHash = await hashPassword(PASSWORD);
  }, THROWAWAY_DATABASE_TIMEOUT);

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await db?.destroy();
    await ownerDb?.destroy();
    await sql`drop database if exists ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await databases.destroy();
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    calls = [];
    variableReads = [];
    hook = undefined;
    delegate = () => validator.client;
    validator.fake.takeRequests();
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  const verifiedUser = (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) =>
    createUserWithOrganization(ownerDb, {
      ...overrides,
      user: {
        email: `person-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        ...overrides.user,
      },
    });

  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const switchTo = async (access: string, organizationId: string) => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  /** A signed-in user, active in their personal organization. */
  const personalUser = async (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) => {
    const account = await verifiedUser(overrides);
    return { account, organization: account.organization, access: await signedIn(account.user.email) };
  };

  /** A signed-in user who is a `role` of a group organization (a new one unless given) and active in it. */
  const memberActiveInGroup = async (role: OrganizationRole = "admin", organizationId?: string) => {
    const account = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), group.id);
    return { account, group, access };
  };

  /**
   * A configuration the user created (a draft), with its version 1 holding
   * a saved text, built for `distribution` (Contrib unless given) and
   * pinned to `collectorVersion` (its default unless given).
   */
  const withVersion = async (
    user: { account: { user: { id: string } }; organizationId: string },
    options: { distribution?: string; collectorVersion?: string } = {},
  ) => {
    const distribution = options.distribution ?? CONTRIB;
    const configuration = await addConfiguration(ownerDb, {
      organizationId: user.organizationId,
      created_by_user_id: user.account.user.id,
      collector_distribution: distribution,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: user.organizationId,
      yaml_content: "saved: text\n",
      collector_distribution: distribution,
      collector_version: options.collectorVersion ?? (distribution === CONTRIB ? contribDefault : FIXTURE_DEFAULT),
    });
    return { configuration, version };
  };

  /** A personal user with a Contrib configuration's version (options as withVersion's). */
  const personalWithVersion = async (options: { distribution?: string; collectorVersion?: string } = {}) => {
    const user = await personalUser();
    const { configuration, version } = await withVersion(
      { account: user.account, organizationId: user.organization.id },
      options,
    );
    return { ...user, configuration, version };
  };

  const validationPath = (organizationId: string, configurationId: string, versionId: string) =>
    `/api/v1/organizations/${organizationId}/configurations/${configurationId}/versions/${versionId}/validation`;

  const validate = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    versionId: string,
    payload: unknown,
    options: { headers?: Record<string, string>; on?: FastifyInstance } = {},
  ) =>
    (options.on ?? server).inject({
      method: "POST",
      url: validationPath(organizationId, configurationId, versionId),
      headers: options.headers ?? csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  /** A validation of `subject`'s version, as its owner. */
  const validateAs = (
    subject: { access: string; organization: { id: string }; configuration: { id: string }; version: { id: string } },
    payload: unknown,
    options: { headers?: Record<string, string>; on?: FastifyInstance } = {},
  ) => validate(subject.access, subject.organization.id, subject.configuration.id, subject.version.id, payload, options);

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: { code, message } });
  }

  /** The rows a validation must never write: versions, configurations and the audit trail. */
  const snapshot = async () => ({
    versions: await ownerDb.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
    configurations: await ownerDb.selectFrom("configurations").selectAll().orderBy("id").execute(),
    audits: await ownerDb.selectFrom("audit_events").select(["id", "action"]).orderBy("id").execute(),
  });

  describe("the answers", () => {
    it("valid: 200 with the saved pin, no errors, and the requirements; cached nowhere", async () => {
      const subject = await personalWithVersion();
      const yaml = textWith().replace("debug: {}", 'debug:\n    verbosity: "${env:LEVEL}"');

      const response = await validateAs(subject, { yaml });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<ValidationBody>()).toEqual({
        status: "valid",
        collectorVersion: contribDefault,
        errors: [],
        requirements: [
          {
            category: "env_var",
            title: "Set environment variable LEVEL",
            description: expect.stringContaining("${env:LEVEL}"),
            componentPath: null,
          },
        ],
      });
      // Exactly the text sent, with the configuration's distribution and the version's pin.
      expect(validator.fake.takeRequests()).toEqual([{ distribution: CONTRIB, version: contribDefault, yaml }]);
    });

    it("invalid: 200 with each error and its component path, and the requirements", async () => {
      const subject = await personalWithVersion();

      const response = await validateAs(subject, { yaml: INVALID_TEXT });

      expect(response.statusCode).toBe(200);
      expect(response.json<ValidationBody>()).toEqual({
        status: "invalid",
        collectorVersion: contribDefault,
        errors: [
          {
            message: `unknown type: "${REFUSED_TYPE}" for id: "${REFUSED_TYPE}/edge-2"`,
            componentPath: `exporters::${REFUSED_TYPE}/edge-2`,
          },
        ],
        requirements: [expect.objectContaining({ category: "env_var", title: "Set environment variable EXPORT_URL" })],
      });
    });

    it("checks against the tab's unsaved pick when the body names one, the saved pin untouched", async () => {
      const subject = await personalWithVersion();
      const before = await snapshot();

      const response = await validateAs(subject, { yaml: textWith(), collectorVersion: contribOther });

      expect(response.statusCode).toBe(200);
      expect(response.json<ValidationBody>()).toMatchObject({ status: "valid", collectorVersion: contribOther });
      expect(validator.fake.takeRequests()).toEqual([
        { distribution: CONTRIB, version: contribOther, yaml: textWith() },
      ]);
      expect(await snapshot()).toEqual(before);
    });

    it("retired: a saved pin the catalogue deprecated answers 200 retired without asking the validator", async () => {
      const subject = await personalWithVersion({ collectorVersion: RETIRED });

      const response = await validateAs(subject, { yaml: INVALID_TEXT });

      expect(response.statusCode).toBe(200);
      expect(response.json<ValidationBody>()).toEqual({
        status: "retired",
        collectorVersion: RETIRED,
        errors: [],
        requirements: [],
      });
      expect(calls).toEqual([]);
      expect(validator.fake.takeRequests()).toEqual([]);
    });

    it("retired too when the body names a deprecated version, and checked when it names an offered one", async () => {
      const subject = await personalWithVersion();

      const retired = await validateAs(subject, { yaml: textWith(), collectorVersion: RETIRED });
      expect(retired.json<ValidationBody>()).toMatchObject({ status: "retired", collectorVersion: RETIRED });
      expect(calls).toEqual([]);

      const pinnedRetired = await personalWithVersion({ collectorVersion: RETIRED });
      const picked = await validateAs(pinnedRetired, { yaml: textWith(), collectorVersion: contribDefault });
      expect(picked.json<ValidationBody>()).toMatchObject({ status: "valid", collectorVersion: contribDefault });
      expect(calls).toHaveLength(1);
    });

    it("400 collector_version_unknown for a version the catalogue doesn't have, asking nothing", async () => {
      const subject = await personalWithVersion();

      expectRefusal(
        await validateAs(subject, { yaml: textWith(), collectorVersion: "0.0.999" }),
        400,
        "collector_version_unknown",
        MESSAGES.versionUnknown,
      );
      expect(calls).toEqual([]);
    });

    it("400 collector_version_unknown for a version of another distribution, both ways round, asking nothing", async () => {
      const contrib = await personalWithVersion();
      expectRefusal(
        await validateAs(contrib, { yaml: textWith(), collectorVersion: FIXTURE_DEFAULT }),
        400,
        "collector_version_unknown",
        MESSAGES.versionUnknown,
      );

      const fixture = await personalWithVersion({ distribution: FIXTURE });
      expectRefusal(
        await validateAs(fixture, { yaml: textWith(), collectorVersion: contribDefault }),
        400,
        "collector_version_unknown",
        MESSAGES.versionUnknown,
      );
      expect(calls).toEqual([]);
    });
  });

  describe("the distribution is always the configuration's", () => {
    it("sends the configuration's distribution, a fixture's here, with its own version", async () => {
      const subject = await personalWithVersion({ distribution: FIXTURE });

      const saved = await validateAs(subject, { yaml: textWith() });
      const picked = await validateAs(subject, { yaml: textWith(), collectorVersion: FIXTURE_OTHER });

      expect(saved.json<ValidationBody>()).toMatchObject({ status: "valid", collectorVersion: FIXTURE_DEFAULT });
      expect(picked.json<ValidationBody>()).toMatchObject({ status: "valid", collectorVersion: FIXTURE_OTHER });
      expect(validator.fake.takeRequests()).toEqual([
        { distribution: FIXTURE, version: FIXTURE_DEFAULT, yaml: textWith() },
        { distribution: FIXTURE, version: FIXTURE_OTHER, yaml: textWith() },
      ]);
    });

    it("refuses a body naming a distribution with 400 invalid_request, asking nothing", async () => {
      const subject = await personalWithVersion({ distribution: FIXTURE });

      for (const payload of [
        { yaml: textWith(), distribution: CONTRIB },
        { yaml: textWith(), distribution: CONTRIB, collectorVersion: contribDefault },
        { yaml: textWith(), collectorDistribution: CONTRIB },
      ]) {
        const response = await validateAs(subject, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_request", message: MESSAGES.invalid } });
      }
      expect(calls).toEqual([]);
      expect(validator.fake.takeRequests()).toEqual([]);
    });
  });

  describe("503 validation_unavailable for every failure of the validator", () => {
    it.each<FakeOtelcolValidatorFault>([
      "invalid_request",
      "not_found",
      "version_retired",
      "payload_too_large",
      "error_500",
      "version_unavailable",
      "validator_busy",
    ])("the validator's %s", async (fault) => {
      const subject = await personalWithVersion();
      validator.fake.nextFault(fault);

      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
      expect(calls).toHaveLength(1);
    });

    it("the validator refusing the platform's secret (401)", async () => {
      const subject = await personalWithVersion();
      const wrong = createOtelcolValidatorClient({ url: validator.fake.url, secret: "not-the-fake-validator-secret-0123456789" });
      delegate = () => wrong;

      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
    });

    it("an answer over the client's cap", async () => {
      const subject = await personalWithVersion();
      const capped = createOtelcolValidatorClient({ url: validator.fake.url, secret: validator.fake.secret, maxReplyBytes: 64 });
      delegate = () => capped;

      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
      expect(calls).toHaveLength(1);
    });

    it("a malformed answer", async () => {
      const subject = await personalWithVersion();
      validator.fake.nextFault("malformed_reply");

      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
      expect(validator.fake.takeViolations()).toEqual([expect.stringContaining("reply 200 body")]);
    });

    it("no answer within the client's timeout", async () => {
      const subject = await personalWithVersion();
      const slow = createOtelcolValidatorClient({ url: validator.fake.url, secret: validator.fake.secret, timeoutMs: 100 });
      delegate = () => slow;
      validator.fake.nextFault("hang");

      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
    });

    it("a reset connection, and nothing listening", async () => {
      const subject = await personalWithVersion();
      validator.fake.nextFault("reset");
      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);

      const down = createOtelcolValidatorClient({ url: await closedUrl(), secret: validator.fake.secret });
      delegate = () => down;
      expectRefusal(await validateAs(subject, { yaml: textWith() }), 503, "validation_unavailable", MESSAGES.unavailable);
    });

    it("a text the fake answers unavailable for (the browser tests' marker)", async () => {
      const subject = await personalWithVersion();
      expectRefusal(
        await validateAs(subject, { yaml: textWith("# fake-otelcol-validator: unavailable\n") }),
        503,
        "validation_unavailable",
        MESSAGES.unavailable,
      );
    });
  });

  describe("the person's limits", () => {
    it("allows 60 checks a minute, a retired answer counted too, then 429 validation_rate_limited with Retry-After", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationsPerUser: RATE_LIMITS.validationsPerUser });
      const retired = await personalWithVersion({ collectorVersion: RETIRED });
      const offered = await withVersion({ account: retired.account, organizationId: retired.organization.id });
      const subjectOffered = { ...retired, ...offered };

      expect(RATE_LIMITS.validationsPerUser.max).toBe(60);
      for (let check = 0; check < 59; check += 1) {
        expect((await validateAs(retired, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);
      }
      expect((await validateAs(subjectOffered, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);
      expect(calls).toHaveLength(1);

      for (const subject of [retired, subjectOffered]) {
        const refused = await validateAs(subject, { yaml: textWith() }, { on: limited });
        expectRefusal(refused, 429, "validation_rate_limited", MESSAGES.perMinute);
        const retryAfter = Number(refused.headers["retry-after"]);
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
      }
      // The refusals asked nothing.
      expect(calls).toHaveLength(1);

      // Another person's checks are their own.
      const other = await personalWithVersion();
      expect((await validateAs(other, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);
    });

    it("counts after the read: a version the caller can't see is still 404, not 429", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationsPerUser: { max: 1, windowMs: 60_000 } });
      const subject = await personalWithVersion();
      expect((await validateAs(subject, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);

      expectRefusal(
        await validate(subject.access, subject.organization.id, randomUUID(), subject.version.id, { yaml: textWith() }, {
          on: limited,
        }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect((await validateAs(subject, { yaml: textWith() }, { on: limited })).statusCode).toBe(429);
    });

    it("lets two of a person's checks wait on the validator at once; a third is 429 with Retry-After 1, asking nothing", async () => {
      const subject = await personalWithVersion();
      const other = await personalWithVersion();
      const gates = [createGate(), createGate()];
      let held = 0;
      hook = async (request) => {
        const gate = gates[held];
        held += 1;
        await gate?.hold();
        return validator.client.validate(request);
      };

      const first = validateAs(subject, { yaml: textWith() });
      await gates[0]!.reached;
      const second = validateAs(subject, { yaml: textWith() });
      await gates[1]!.reached;

      const third = await validateAs(subject, { yaml: textWith() });
      expectRefusal(third, 429, "validation_rate_limited", MESSAGES.inFlight);
      expect(third.headers["retry-after"]).toBe("1");
      expect(calls).toHaveLength(2);

      // Another person isn't held up by them.
      expect((await validateAs(other, { yaml: textWith() })).statusCode).toBe(200);

      gates[0]!.release();
      gates[1]!.release();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);

      // Ended, they free their slots, whatever their answer.
      validator.fake.nextFault("validator_busy");
      expect((await validateAs(subject, { yaml: textWith() })).statusCode).toBe(503);
      expect((await validateAs(subject, { yaml: textWith() })).statusCode).toBe(200);
    });
  });

  describe("a person's two sessions share the limits", () => {
    it("counts both sessions' checks against one per-minute limit", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationsPerUser: { max: 2, windowMs: 60_000 } });
      const subject = await personalWithVersion();
      const secondSession = { ...subject, access: await signedIn(subject.account.user.email) };
      expect(secondSession.access).not.toBe(subject.access);

      expect((await validateAs(subject, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);
      expect((await validateAs(secondSession, { yaml: textWith() }, { on: limited })).statusCode).toBe(200);
      for (const session of [subject, secondSession]) {
        expectRefusal(
          await validateAs(session, { yaml: textWith() }, { on: limited }),
          429,
          "validation_rate_limited",
          MESSAGES.perMinute,
        );
      }
      expect(calls).toHaveLength(2);
    });

    it("counts both sessions' checks against one in-flight limit", async () => {
      const subject = await personalWithVersion();
      const secondSession = { ...subject, access: await signedIn(subject.account.user.email) };
      const gates = [createGate(), createGate()];
      let held = 0;
      hook = async (request) => {
        const gate = gates[held];
        held += 1;
        await gate?.hold();
        return validator.client.validate(request);
      };

      const first = validateAs(subject, { yaml: textWith() });
      await gates[0]!.reached;
      const second = validateAs(secondSession, { yaml: textWith() });
      await gates[1]!.reached;

      for (const session of [subject, secondSession]) {
        expectRefusal(await validateAs(session, { yaml: textWith() }), 429, "validation_rate_limited", MESSAGES.inFlight);
      }
      expect(calls).toHaveLength(2);

      gates[0]!.release();
      gates[1]!.release();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
    });
  });

  describe("outside any transaction", () => {
    it("asks the validator after the read committed, holding no database connection", async () => {
      const subject = await personalWithVersion();
      const seen: Array<{ total: number; idle: number; waiting: number }> = [];
      hook = async (request) => {
        seen.push({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
        return validator.client.validate(request);
      };

      expect((await validateAs(subject, { yaml: textWith() })).statusCode).toBe(200);

      // The read used a connection, and gave it back before the call: every
      // one the pool holds is idle while the validator works.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.total).toBeGreaterThan(0);
      expect(seen[0]!.idle).toBe(seen[0]!.total);
      expect(seen[0]!.waiting).toBe(0);
    });

    it("stores nothing and audits nothing, whatever the answer", async () => {
      const subject = await personalWithVersion();
      const retired = await personalWithVersion({ collectorVersion: RETIRED });
      const before = await snapshot();

      await validateAs(subject, { yaml: textWith() });
      await validateAs(subject, { yaml: INVALID_TEXT });
      validator.fake.nextFault("validator_busy");
      await validateAs(subject, { yaml: textWith() });
      await validateAs(retired, { yaml: textWith() });

      expect(await snapshot()).toEqual(before);
    });
  });

  describe("who may check (the draft rules, the terms gate)", () => {
    it("answers another member's draft 404 configuration_not_found, as one that doesn't exist, asking nothing", async () => {
      const a = await memberActiveInGroup("contributor");
      const b = await memberActiveInGroup("admin", a.group.id);
      const { configuration, version } = await withVersion({ account: a.account, organizationId: a.group.id });

      expectRefusal(
        await validate(b.access, a.group.id, configuration.id, version.id, { yaml: textWith() }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await validate(b.access, a.group.id, randomUUID(), version.id, { yaml: textWith() }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(calls).toEqual([]);

      // Its author checks it.
      expect((await validate(a.access, a.group.id, configuration.id, version.id, { yaml: textWith() })).statusCode).toBe(200);
    });

    it("lets a teammate check a published configuration's version", async () => {
      const a = await memberActiveInGroup("admin");
      const b = await memberActiveInGroup("contributor", a.group.id);
      const configuration = await addConfiguration(ownerDb, {
        organizationId: a.group.id,
        created_by_user_id: a.account.user.id,
      });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: a.group.id,
        yaml_content: "published: text\n",
        publishedAt: new Date(),
        publishedByUserId: a.account.user.id,
      });

      expect((await validate(b.access, a.group.id, configuration.id, version.id, { yaml: textWith() })).statusCode).toBe(200);
    });

    it("answers a version that isn't the configuration's 404 configuration_version_not_found, malformed ids too", async () => {
      const subject = await personalWithVersion();
      const elsewhere = await withVersion({ account: subject.account, organizationId: subject.organization.id });

      for (const versionId of [randomUUID(), elsewhere.version.id, "not-a-uuid"]) {
        expectRefusal(
          await validate(subject.access, subject.organization.id, subject.configuration.id, versionId, { yaml: textWith() }),
          404,
          "configuration_version_not_found",
          MESSAGES.versionNotFound,
        );
      }
      expectRefusal(
        await validate(subject.access, subject.organization.id, "not-a-uuid", subject.version.id, { yaml: textWith() }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(calls).toEqual([]);
    });

    it("answers a soft-deleted configuration's version 404 configuration_not_found, asking nothing", async () => {
      const subject = await personalWithVersion();
      await ownerDb
        .updateTable("configurations")
        .set({ deleted_at: new Date() })
        .where("id", "=", subject.configuration.id)
        .execute();

      expectRefusal(
        await validateAs(subject, { yaml: textWith() }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(calls).toEqual([]);
    });

    it("answers another organization's configuration, named under the caller's own, 404 configuration_not_found, asking nothing", async () => {
      const subject = await personalWithVersion();
      const stranger = await personalUser();

      expectRefusal(
        await validate(stranger.access, stranger.organization.id, subject.configuration.id, subject.version.id, {
          yaml: textWith(),
        }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      // And a group's, named by an admin of another group.
      const owner = await memberActiveInGroup("admin");
      const elsewhere = await memberActiveInGroup("admin");
      const { configuration, version } = await withVersion({ account: owner.account, organizationId: owner.group.id });
      expectRefusal(
        await validate(elsewhere.access, elsewhere.group.id, configuration.id, version.id, { yaml: textWith() }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(calls).toEqual([]);
    });

    it("answers a path naming another organization 404 organization_not_found", async () => {
      const subject = await personalWithVersion();
      const stranger = await personalUser();

      expectRefusal(
        await validate(stranger.access, subject.organization.id, subject.configuration.id, subject.version.id, {
          yaml: textWith(),
        }),
        404,
        "organization_not_found",
        MESSAGES.organizationNotFound,
      );
      expect(calls).toEqual([]);
    });

    it("refuses a user who hasn't accepted the current terms with 403 terms_acceptance_required, asking nothing", async () => {
      const user = await personalUser({ user: { accepted_terms_version: "2025-01-01" } });
      const { configuration, version } = await withVersion({ account: user.account, organizationId: user.organization.id });

      expectRefusal(
        await validate(user.access, user.organization.id, configuration.id, version.id, { yaml: textWith() }),
        403,
        "terms_acceptance_required",
        MESSAGES.terms,
      );
      expect(calls).toEqual([]);
    });

    it("refuses a signed-out request with 401, and one without the CSRF header with 403, asking nothing", async () => {
      const subject = await personalWithVersion();

      expectRefusal(
        await validate(undefined, subject.organization.id, subject.configuration.id, subject.version.id, { yaml: textWith() }),
        401,
        "unauthenticated",
        MESSAGES.unauthenticated,
      );
      expectRefusal(
        await validateAs(subject, { yaml: textWith() }, { headers: {} }),
        403,
        "csrf_header_missing",
        MESSAGES.csrf,
      );
      expect(calls).toEqual([]);
    });
  });

  describe("the body", () => {
    it("takes 262,144 characters and refuses one more, an empty text and a missing one with 400 invalid_request", async () => {
      const subject = await personalWithVersion();
      const at = `# ${"x".repeat(262_142)}`;

      expect((await validateAs(subject, { yaml: at })).statusCode).toBe(200);
      for (const payload of [{ yaml: `${at}x` }, { yaml: "" }, {}, { yaml: textWith(), collectorVersion: "latest" }]) {
        const response = await validateAs(subject, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_request", message: MESSAGES.invalid } });
      }
      expect(calls).toHaveLength(1);
    });

    it("refuses a C0 control character other than tab, line feed and carriage return with 400 invalid_request, asking nothing", async () => {
      const subject = await personalWithVersion();

      for (const character of ["\u0001", "\u0007", "\u000b", "\u001b", "\u001f"]) {
        const response = await validateAs(subject, { yaml: textWith(`# ${character}\n`) });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_request", message: MESSAGES.invalid } });
      }
      expect(calls).toEqual([]);
      expect((await validateAs(subject, { yaml: textWith("# a\tb\r\n") })).statusCode).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });

  describe("the organization's values, filled in by the validator before its checks", () => {
    /** Values no log line may hold, and a name. */
    const VALUE_MARKER = "value-marker-b81e$x";
    const NAME_MARKER = "NAME_MARKER_5C2D";

    /** Registers the organization at the fake opamp-server and gives it these variables. */
    const withVariables = async (organizationId: string, variables: Record<string, string>) => {
      const registered = await opamp.client.createOrganization({ id: organizationId, name: "an organization" });
      expect(["created", "unchanged"]).toContain(registered.kind);
      for (const [name, value] of Object.entries(variables)) {
        const created = await opamp.client.createVariable(organizationId, {
          id: randomUUID(),
          name,
          value,
          description: null,
          actor: null,
        });
        expect(created.kind).toBe("created");
      }
    };

    it("sends the values of the names the text references live, and only those, in the text's order", async () => {
      const subject = await personalWithVersion();
      await withVariables(subject.organization.id, {
        ENDPOINT: "otel.example:4317",
        [NAME_MARKER]: VALUE_MARKER,
        UNUSED: "never sent",
        ESCAPED: "never sent either",
        LEGACY: "nor this",
      });
      const yaml = textWith(
        `  otlp:\n    endpoint: "\${org:${NAME_MARKER}}"\n    headers:\n      a: \${org:ENDPOINT}\n` +
          `      b: $\${org:ESCAPED}\n      c: $orgvar:LEGACY\n      d: \${org:MISSING}\n      e: \${org:ENDPOINT}\n`,
      );

      const response = await validateAs(subject, { yaml });

      expect(response.statusCode).toBe(200);
      expect(variableReads).toEqual([subject.organization.id]);
      const [request] = validator.fake.takeRequests();
      // The text as written: the validator fills it in.
      expect(request).toEqual({
        distribution: CONTRIB,
        version: contribDefault,
        yaml,
        organizationVariables: { [NAME_MARKER]: VALUE_MARKER, ENDPOINT: "otel.example:4317" },
      });
      expect(Object.keys(request!.organizationVariables!)).toEqual([NAME_MARKER, "ENDPOINT"]);
      expect(response.json<ValidationBody>().requirements).toContainEqual({
        category: "organization_variable",
        title: "Organization variables filled in",
        description: expect.stringContaining(`${NAME_MARKER}, ENDPOINT.`),
        componentPath: null,
      });
      for (const forbidden of [VALUE_MARKER, NAME_MARKER, "otel.example"]) {
        expect(logLines.filter((line) => line.includes(forbidden))).toEqual([]);
      }
    });

    it("reads nothing for a text with no live reference, and sends the text alone", async () => {
      const subject = await personalWithVersion();
      await withVariables(subject.organization.id, { HOST: "x" });
      const yaml = textWith("# $${org:HOST} $orgvar:HOST ${org:HOST:-x}\n");

      expect((await validateAs(subject, { yaml })).statusCode).toBe(200);

      expect(variableReads).toEqual([]);
      expect(validator.fake.takeRequests()).toEqual([{ distribution: CONTRIB, version: contribDefault, yaml }]);
    });

    it("sends no values when the organization defines none of the names, or the opamp-server holds no such organization", async () => {
      const subject = await personalWithVersion();
      const yaml = textWith("# ${org:HOST}\n");

      // Not registered at the opamp-server: it has no variables.
      expect((await validateAs(subject, { yaml })).statusCode).toBe(200);
      await withVariables(subject.organization.id, { OTHER: "x" });
      expect((await validateAs(subject, { yaml })).statusCode).toBe(200);

      expect(variableReads).toEqual([subject.organization.id, subject.organization.id]);
      expect(validator.fake.takeRequests()).toEqual([
        { distribution: CONTRIB, version: contribDefault, yaml },
        { distribution: CONTRIB, version: contribDefault, yaml },
      ]);
    });

    it("sends a variable named __proto__ like any other", async () => {
      const subject = await personalWithVersion();
      await withVariables(subject.organization.id, {});
      // Created by itself: an object literal's `__proto__` would set its prototype instead.
      await opamp.client.createVariable(subject.organization.id, {
        id: randomUUID(),
        name: "__proto__",
        value: "a value",
        description: null,
        actor: null,
      });

      expect((await validateAs(subject, { yaml: textWith("# ${org:__proto__}\n") })).statusCode).toBe(200);

      const [request] = validator.fake.takeRequests();
      expect(Object.entries(request!.organizationVariables!)).toEqual([["__proto__", "a value"]]);
    });

    // "hang" is the client's 5-second timeout, an unavailable like these: not waited out here.
    it.each(["error_500", "reset", "malformed_reply"] as const)(
      "answers 503 variables_unavailable when the opamp-server's read fails (%s), the validator never asked, the slot released",
      async (fault) => {
        const subject = await personalWithVersion();
        await withVariables(subject.organization.id, { HOST: VALUE_MARKER });
        opamp.fake.nextFault(fault, "listVariables");
        const yaml = textWith("# ${org:HOST}\n");

        const response = await validateAs(subject, { yaml });

        // A reply the contract refuses is the fake's own violation, and the client's misconfiguration error.
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
        expectRefusal(response, 503, "variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE);
        expect(calls).toEqual([]);
        expect(validator.fake.takeRequests()).toEqual([]);
        for (const forbidden of [VALUE_MARKER, "HOST", TEXT_MARKER]) {
          expect(logLines.filter((line) => line.includes(forbidden))).toEqual([]);
        }
        // The person's in-flight slot is back: the next check runs.
        expect((await validateAs(subject, { yaml })).statusCode).toBe(200);
      },
    );

    it("logs the unavailable read with ids and the kind only", async () => {
      const subject = await personalWithVersion();
      opamp.fake.nextFault("error_500", "listVariables");

      expect((await validateAs(subject, { yaml: textWith("# ${org:HOST}\n") })).statusCode).toBe(503);

      const lines = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.result === "variables_unavailable");
      expect(lines).toHaveLength(1);
      const { level, time: _time, pid: _pid, hostname: _hostname, reqId: _reqId, msg: _msg, ...fields } = lines[0]!;
      expect(level).toBe(40);
      expect(fields).toEqual({
        configurationId: subject.configuration.id,
        versionId: subject.version.id,
        distribution: CONTRIB,
        collectorVersion: contribDefault,
        result: "variables_unavailable",
        reason: "server_error",
      });
    });

    it("reads nothing for a retired version: the validator isn't asked", async () => {
      const subject = await personalWithVersion({ collectorVersion: RETIRED });

      const response = await validateAs(subject, { yaml: textWith("# ${org:HOST}\n") });

      expect(response.json<ValidationBody>().status).toBe("retired");
      expect(variableReads).toEqual([]);
    });
  });

  describe("nothing of the text, the answer or the secret in the log", () => {
    /** The log lines, parsed. */
    const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    it("logs ids, the version and the result's kind for every answer, and never the text, a message or the secret", async () => {
      const subject = await personalWithVersion();
      const retired = await personalWithVersion({ collectorVersion: RETIRED });
      const secret = "a-wrong-validator-secret-never-logged-0123456789";

      expect((await validateAs(subject, { yaml: textWith() })).statusCode).toBe(200);
      expect((await validateAs(subject, { yaml: INVALID_TEXT })).statusCode).toBe(200);
      expect((await validateAs(retired, { yaml: INVALID_TEXT })).statusCode).toBe(200);
      validator.fake.nextFault("validator_busy");
      expect((await validateAs(subject, { yaml: INVALID_TEXT })).statusCode).toBe(503);
      validator.fake.nextFault("malformed_reply");
      expect((await validateAs(subject, { yaml: INVALID_TEXT })).statusCode).toBe(503);
      expect(validator.fake.takeViolations()).toHaveLength(1);
      const capped = createOtelcolValidatorClient({ url: validator.fake.url, secret: validator.fake.secret, maxReplyBytes: 64 });
      delegate = () => capped;
      expect((await validateAs(subject, { yaml: INVALID_TEXT })).statusCode).toBe(503);
      delegate = () => createOtelcolValidatorClient({ url: validator.fake.url, secret });
      expect((await validateAs(subject, { yaml: INVALID_TEXT })).statusCode).toBe(503);

      expect(logLines.length).toBeGreaterThan(0);
      for (const forbidden of [TEXT_MARKER, REFUSED_TYPE, "EXPORT_URL", secret, validator.fake.secret, "unknown type"]) {
        expect(logLines.filter((line) => line.includes(forbidden))).toEqual([]);
      }

      const results = logged()
        .filter((entry) => "result" in entry)
        .map(({ level, result, reason, status, configurationId, versionId, distribution, collectorVersion }) => ({
          level,
          result,
          reason,
          status,
          configurationId,
          versionId,
          distribution,
          collectorVersion,
        }));
      const ids = { configurationId: subject.configuration.id, versionId: subject.version.id, distribution: CONTRIB };
      expect(results).toEqual([
        { level: 30, result: "valid", reason: undefined, status: undefined, ...ids, collectorVersion: contribDefault },
        { level: 30, result: "invalid", reason: undefined, status: undefined, ...ids, collectorVersion: contribDefault },
        {
          level: 30,
          result: "retired",
          reason: undefined,
          status: undefined,
          configurationId: retired.configuration.id,
          versionId: retired.version.id,
          distribution: CONTRIB,
          collectorVersion: RETIRED,
        },
        { level: 40, result: "unavailable", reason: "validator_busy", status: 503, ...ids, collectorVersion: contribDefault },
        // A deployment to fix: at error, naming the reason only.
        { level: 50, result: "unavailable", reason: "malformed_reply", status: 200, ...ids, collectorVersion: contribDefault },
        // A reply over the cap: any member's text once made one; the validator
        // now answers at most 2,290,356 bytes, under the 4 MiB cap. At warn.
        { level: 40, result: "unavailable", reason: "oversized_reply", status: 200, ...ids, collectorVersion: contribDefault },
        { level: 50, result: "unavailable", reason: "unauthorized", status: 401, ...ids, collectorVersion: contribDefault },
      ]);
      // Each of those lines holds nothing else.
      for (const entry of logged().filter((line) => "result" in line)) {
        expect(Object.keys(entry).sort()).toEqual(
          expect.arrayContaining(["configurationId", "versionId", "distribution", "collectorVersion", "result"]),
        );
        const extra = Object.keys(entry).filter(
          (key) =>
            ![
              "level",
              "time",
              "pid",
              "hostname",
              "reqId",
              "msg",
              "configurationId",
              "versionId",
              "distribution",
              "collectorVersion",
              "result",
              "reason",
              "status",
            ].includes(key),
        );
        expect(extra).toEqual([]);
      }
    });
  });
});
