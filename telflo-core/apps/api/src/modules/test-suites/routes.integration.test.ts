import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  TEST_DEFINITION_LIMIT_MESSAGE,
  TEST_SUITE_LIMIT_MESSAGE,
} from "@telflo/contracts";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestDefinition,
  addTestDefinitionInput,
  addTestRun,
  addTestSuite,
  addTestTemplate,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import type { Database, OrganizationRole } from "@telflo/db";
import { createFileStore } from "../../file-store/create-file-store.js";
import { FileStoreError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** A race test's own timeout: above waitForLockWaits' five-second hang guard, so the guard fires first. */
const LOCK_RACE_TIMEOUT = 20_000;
const PASSWORD = "a-sufficiently-long-password";

/** Markers no log line, URL or audit row may hold: names, descriptions and file names. */
const NAME_MARKER = "suite-name-marker-6b2e";
const DESCRIPTION_MARKER = "suite-description-marker-0c9d";
const FILE_MARKER = "file-name-marker-a41f";

/** The words, exactly. */
const MESSAGES = {
  organizationNotFound: "Organization not found",
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  suiteNotFound: "Test suite not found",
  definitionNotFound: "Test configuration not found",
  fileNotFound: "Test file not found",
  templateNotFound: "Test template not found",
  invalid: "The request was not valid.",
  uploadsLimited: "Too many attempts. Please wait and try again.",
  termsRequired: "Accept the current Terms of Service to continue.",
};

type Part =
  | { name: string; value: string; contentType?: string }
  | { name: string; filename: string; data: Buffer; contentType?: string };

/** A multipart/form-data body of `parts`, in their order. */
function multipartBody(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----telflo-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`),
        Buffer.from(part.value, "utf8"),
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`,
        ),
        part.data,
        Buffer.from("\r\n"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** Every file under `root`, as paths relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/*
 * The test suites and definitions API, against Postgres as the API's own
 * role, with a real FileStore on a temporary directory. Runs from a
 * definition are the runs API's (test-runs/routes.integration.test.ts).
 */
describe("the test suites and definitions API", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let root: string;
  let store: IFileStore;
  let logLines: string[] = [];
  /** Every stream the store's reads handed out since the test began. */
  let readStreams: Readable[] = [];
  /** While true, every removal fails as a read-only disk would. */
  let isRemoveFailing = false;
  /** Every copy the store began since the test began: its source and its destination. */
  let copies: Array<{ from: FileKey; to: FileKey }> = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return clock;
  };

  /** The store the servers use: the real one, recording each read's stream. */
  const recordingStore: IFileStore = {
    write: (key, content, options) => store.write(key, content, options),
    copy: (from, to) => {
      copies.push({ from, to });
      return store.copy(from, to);
    },
    remove: async (key) => {
      if (isRemoveFailing) throw new FileStoreError("EROFS", "unlink");
      await store.remove(key);
    },
    read: async (key) => {
      const result = await store.read(key);
      if (result.found) readStreams.push(result.stream);
      return result;
    },
  };

  /** A server on the test database, logging every line to `logLines`. */
  async function serverWith(options: { rateLimits?: RateLimits } = {}): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: recordingStore,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db: databases.db,
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
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await databases.destroy();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "telflo-test-suites-"));
    store = await createFileStore({ kind: "local", root });
    logLines = [];
    readStreams = [];
    isRemoveFailing = false;
    copies = [];
    clock = new Date(Date.UTC(2026, 9, 10, 9, 0, 0));
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
    organizationId: string;
    access: string;
  }

  /** A signed-in person active in a group organization (a new one unless given), as `role`. */
  const member = async (organizationId?: string, role: OrganizationRole = "admin"): Promise<Person> => {
    const ownerDb = databases.ownerDb;
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
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
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return { userId: account.user.id, organizationId: organization.id, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };

  /** Ana and Ben in one group organization, and Cara in another. */
  const team = async () => {
    const ana = await member();
    const ben = await member(ana.organizationId, "contributor");
    const cara = await member();
    return { ana, ben, cara };
  };

  /** A configuration `author` created, a draft unless `published`, with its version 1 and a draft version 2. */
  const configurationOf = async (author: Person, options: { published?: boolean } = {}) => {
    const ownerDb = databases.ownerDb;
    const configuration = await addConfiguration(ownerDb, {
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
      ...(options.published ? { publishedAt: new Date() } : {}),
    });
    const v2 = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      version_number: 2,
      created_by_user_id: author.userId,
    });
    return {
      organizationId: author.organizationId,
      configurationId: configuration.id,
      versionId: version.id,
      v2: v2.id,
    };
  };
  type Target = Awaited<ReturnType<typeof configurationOf>>;

  /** Publishes `target`'s version 1, as a publish would. */
  const publish = (target: Target, by: Person) =>
    databases.ownerDb
      .updateTable("configuration_versions")
      .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: by.userId })
      .where("id", "=", target.versionId)
      .execute();

  const suitesPath = (target: Target, options: { organizationId?: string; versionId?: string } = {}) =>
    `/api/v1/organizations/${options.organizationId ?? target.organizationId}/configurations/${target.configurationId}` +
    `/versions/${options.versionId ?? target.versionId}/test-suites`;
  const suitePath = (target: Target, suiteId: string, options: { organizationId?: string; versionId?: string } = {}) =>
    `${suitesPath(target, options)}/${suiteId}`;
  const definitionsPath = (target: Target, suiteId: string, options: { organizationId?: string; versionId?: string } = {}) =>
    `${suitePath(target, suiteId, options)}/definitions`;
  const headPath = (target: Target, suiteId: string, definitionId: string, options: { organizationId?: string } = {}) =>
    `${definitionsPath(target, suiteId, options)}/${definitionId}/input/head`;

  const call = (
    person: Person | undefined,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    options: { on?: FastifyInstance } = {},
  ) =>
    (options.on ?? server).inject({
      method,
      url,
      headers: csrfHeaders,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: statusCode,
      body: { error: { code, message } },
    });
  }

  /** A body the contract refuses: 400 `invalid_request`, with the schema's details. */
  function expectInvalid(response: LightMyRequestResponse): void {
    expect({ status: response.statusCode, error: response.json<{ error: Record<string, unknown> }>().error }).toMatchObject({
      status: 400,
      error: { code: "invalid_request", message: MESSAGES.invalid },
    });
  }

  interface SuiteBody {
    id: string;
    configurationId: string;
    versionId: string;
    name: string;
    description: string;
    createdByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }

  interface DefinitionBody {
    id: string;
    suiteId: string;
    name: string;
    description: string;
    pipeline: string;
    signal: string;
    durationSeconds: number;
    inputName: string;
    createdByUserId: string | null;
    createdAt: string;
  }

  /** A suite `person` creates on `target`'s version 1 (or `versionId`), through the API. */
  const createdSuite = async (person: Person, target: Target, body: Record<string, unknown> = {}, versionId?: string) => {
    const response = await call(person, "POST", suitesPath(target, versionId === undefined ? {} : { versionId }), {
      name: `Smoke tests ${NAME_MARKER}`,
      description: `Every pipeline ${DESCRIPTION_MARKER}`,
      ...body,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ suite: SuiteBody }>().suite;
  };

  /** A My Files upload of `person`'s, through the API; answers the file. */
  const uploaded = async (person: Person, data: Buffer = Buffer.from('{"resourceLogs":[]}\n'), filename = `app-logs-${FILE_MARKER}.json`) => {
    const { payload, headers } = multipartBody([
      { name: "displayName", value: "App logs" },
      { name: "description", value: "" },
      { name: "file", filename, data },
    ]);
    const response = await server.inject({
      method: "POST",
      url: `/api/v1/organizations/${person.organizationId}/test-files`,
      headers: { ...csrfHeaders, ...headers },
      cookies: { telflo_access: person.access },
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ file: { id: string; fileName: string; sizeBytes: number; sha256: string } }>().file;
  };

  /** A live template with `data` behind it, as a template's upload would leave it. */
  const templateWith = async (data: Buffer, overrides: { file_name?: string; content_type?: string } = {}) => {
    const template = await addTestTemplate(databases.ownerDb, {
      file_name: overrides.file_name ?? `otlp-traces-${FILE_MARKER}.json`,
      content_type: overrides.content_type ?? "application/json",
      size_bytes: data.length,
      sha256: createHash("sha256").update(data).digest(),
    });
    await store.write({ kind: "test-template", templateId: template.id }, (async function* () { yield data; })(), {
      maxBytes: 10_485_760,
    });
    return template;
  };

  const definitionBody = (source: { inputFileId: string } | { templateId: string }, overrides: Record<string, unknown> = {}) => ({
    ...source,
    name: `Logs only ${NAME_MARKER}`,
    description: `From the laptop ${DESCRIPTION_MARKER}`,
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    ...overrides,
  });

  /** A definition `person` creates in `suiteId` on `target`, through the API. */
  const createdDefinition = async (
    person: Person,
    target: Target,
    suiteId: string,
    source: { inputFileId: string } | { templateId: string },
    overrides: Record<string, unknown> = {},
    options: { versionId?: string } = {},
  ) => {
    const response = await call(person, "POST", definitionsPath(target, suiteId, options), definitionBody(source, overrides));
    expect(response.statusCode).toBe(201);
    return response.json<{ definition: DefinitionBody }>().definition;
  };

  const inputRows = () =>
    databases.ownerDb.selectFrom("test_definition_inputs").selectAll().orderBy("created_at").orderBy("id").execute();
  const inputPath = (organizationId: string, inputId: string) =>
    join("organizations", organizationId, "test-definition-inputs", inputId);
  /** The stored inputs' files, relative to the store's root. */
  const inputFiles = async () => (await filesUnder(root)).filter((path) => path.includes("test-definition-inputs"));
  const auditRows = (prefix: string) =>
    databases.ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", `${prefix}%`)
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  /** The invariant: no definition without its input, and no input no definition names; each input's bytes there exactly when its row is. */
  const expectNothingDangles = async (organizationId: string) => {
    const ownerDb = databases.ownerDb;
    const { rows } = await sql<{ dangling: number; unused: number }>`
      select (select count(*) from test_definitions d
               where not exists (select 1 from test_definition_inputs i where i.id = d.input_id))::int as dangling,
             (select count(*) from test_definition_inputs i
               where not exists (select 1 from test_definitions d where d.input_id = i.id))::int as unused
    `.execute(ownerDb);
    expect(rows[0]).toEqual({ dangling: 0, unused: 0 });
    const inputs = await ownerDb.selectFrom("test_definition_inputs").select("id").execute();
    expect(await inputFiles()).toEqual(inputs.map((input) => inputPath(organizationId, input.id)).sort());
  };

  /**
   * Resolves once `count` other backends wait on a lock, or `isSettled()`
   * holds: a condition, polled. The five seconds are a hang guard only, well
   * inside LOCK_RACE_TIMEOUT, so a race that never blocks fails here and its
   * side connection is rolled back before the test's own timeout.
   */
  const waitForLockWaits = async (count: number, isSettled: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (isSettled()) return;
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
      `.execute(databases.ownerDb);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} backends to wait on a lock`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const started = (request: Promise<LightMyRequestResponse>) => {
    const tracked = { isSettled: false, response: request };
    const settle = () => {
      tracked.isSettled = true;
    };
    request.then(settle, settle);
    return tracked;
  };

  /** A side connection's hold: the configuration's row, as every reference-changing path locks it. */
  const configurationRow =
    (configurationId: string) =>
    (connection: Kysely<Database>): Promise<unknown> =>
      sql`select id from configurations where id = ${configurationId} for update`.execute(connection);

  /**
   * A side connection's hold: the inputs' table in EXCLUSIVE mode, which a
   * read (ACCESS SHARE) passes and a delete's free (ROW EXCLUSIVE) waits on.
   * Each delete then stops just before it frees, after its definitions'
   * rows are gone: the moment two deletes sharing an input race at.
   */
  const inputsTable = (connection: Kysely<Database>): Promise<unknown> =>
    sql`lock table test_definition_inputs in exclusive mode`.execute(connection);

  /**
   * Holds `hold` from a side connection, as the tables' owner; starts
   * `first` and waits until it is blocked, then `second`, until both are;
   * then releases: the two go on from there.
   */
  const inOrder = async (
    hold: (connection: Kysely<Database>) => Promise<unknown>,
    first: () => Promise<LightMyRequestResponse>,
    second: () => Promise<LightMyRequestResponse>,
  ): Promise<[LightMyRequestResponse, LightMyRequestResponse]> =>
    databases.ownerDb.connection().execute(async (connection) => {
      await sql`begin`.execute(connection);
      let isOpen = true;
      const begun: Array<Promise<LightMyRequestResponse>> = [];
      try {
        await hold(connection);
        const a = started(first());
        begun.push(a.response);
        await waitForLockWaits(1, () => a.isSettled);
        const b = started(second());
        begun.push(b.response);
        await waitForLockWaits(2, () => b.isSettled);
        expect([a.isSettled, b.isSettled]).toEqual([false, false]);
        await sql`rollback`.execute(connection);
        isOpen = false;
        return [await a.response, await b.response];
      } finally {
        if (isOpen) await sql`rollback`.execute(connection);
        // A failed race still lets its requests finish here, so none outlives the test into the next one's truncate.
        await Promise.allSettled(begun);
      }
    });

  describe("suites", () => {
    it("creates a suite (201), its creator the caller and its times the API's clock, with an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const response = await call(ana, "POST", suitesPath(target), {
        name: `  Smoke tests ${NAME_MARKER}  `,
        description: `Every pipeline ${DESCRIPTION_MARKER}`,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const suite = response.json<{ suite: SuiteBody }>().suite;
      expect(suite).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        configurationId: target.configurationId,
        versionId: target.versionId,
        name: `Smoke tests ${NAME_MARKER}`,
        description: `Every pipeline ${DESCRIPTION_MARKER}`,
        createdByUserId: ana.userId,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      });
      expect(await auditRows("test_suite.")).toEqual([
        expect.objectContaining({
          action: "test_suite.created",
          actor_user_id: ana.userId,
          organization_id: ana.organizationId,
          subject_type: "test_suite",
          subject_id: suite.id,
          metadata: { configurationId: target.configurationId, versionId: target.versionId },
        }),
      ]);
    });

    it("takes a description left out as none, and refuses a name empty, over 200 characters or with U+0000, a description over 2,000, and an unknown field (400)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      expect((await createdSuite(ana, target, { name: "No description", description: undefined })).description).toBe("");
      for (const body of [
        { name: "   " },
        { name: "x".repeat(201) },
        { name: "a\u0000b" },
        { name: "Smoke", description: "x".repeat(2001) },
        { name: "Smoke", createdByUserId: randomUUID() },
        {},
      ]) {
        expectInvalid(await call(ana, "POST", suitesPath(target), body));
      }
      expect(await databases.ownerDb.selectFrom("test_suites").select("name").execute()).toEqual([{ name: "No description" }]);
    });

    it("lists the version's suites oldest first, by created_at then id, and none of another version's", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const first = await createdSuite(ana, target, { name: "First" });
      tick();
      const second = await createdSuite(ana, target, { name: "Second" });
      // Two at the same time: the id decides.
      const sameTime = new Date(clock.getTime());
      const tied = await Promise.all(
        [0, 1].map(() =>
          addTestSuite(databases.ownerDb, {
            organizationId: target.organizationId,
            configurationId: target.configurationId,
            configurationVersionId: target.versionId,
            created_at: sameTime,
            created_by_user_id: ana.userId,
          }),
        ),
      );
      await createdSuite(ana, target, { name: "On v2" }, target.v2);

      const response = await call(ana, "GET", suitesPath(target));
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      // The second and the tied pair share one created_at: by id among them.
      expect(new Date(second.createdAt)).toEqual(sameTime);
      expect(response.json<{ suites: SuiteBody[] }>().suites.map((suite) => suite.id)).toEqual([
        first.id,
        ...[second.id, ...tied.map((row) => row.id)].sort(),
      ]);
      expect(
        (await call(ana, "GET", suitesPath(target, { versionId: target.v2 }))).json<{ suites: SuiteBody[] }>().suites.map(
          (suite) => suite.name,
        ),
      ).toEqual(["On v2"]);
    });

    it("renames and describes a suite (PATCH), moving updated_at and auditing the changed fields' names only", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const at = tick();

      const renamed = await call(ana, "PATCH", suitePath(target, suite.id), { name: `Renamed ${NAME_MARKER}` });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<{ suite: SuiteBody }>().suite).toEqual({
        ...suite,
        name: `Renamed ${NAME_MARKER}`,
        updatedAt: at.toISOString(),
      });
      tick();
      const both = await call(ana, "PATCH", suitePath(target, suite.id), {
        name: "Both",
        description: `Described ${DESCRIPTION_MARKER} again`,
      });
      expect(both.json<{ suite: SuiteBody }>().suite).toMatchObject({ name: "Both", updatedAt: clock.toISOString() });

      const audits = (await auditRows("test_suite.updated")).map((row) => row.metadata);
      expect(audits).toEqual([
        { configurationId: target.configurationId, versionId: target.versionId, changedFields: ["name"] },
        { configurationId: target.configurationId, versionId: target.versionId, changedFields: ["name", "description"] },
      ]);
    });

    it("answers an empty PATCH ({}) and one changing nothing with the suite as it is (200), writing and auditing nothing, as a configuration's PATCH", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      tick();
      for (const body of [{}, { name: suite.name }, { name: suite.name, description: suite.description }]) {
        const response = await call(ana, "PATCH", suitePath(target, suite.id), body);
        expect(response.statusCode).toBe(200);
        expect(response.json<{ suite: SuiteBody }>().suite).toEqual(suite);
      }
      expect(await auditRows("test_suite.updated")).toEqual([]);
      expectInvalid(await call(ana, "PATCH", suitePath(target, suite.id), { name: "" }));
      expectInvalid(await call(ana, "PATCH", suitePath(target, suite.id), { versionId: target.v2 }));
    });

    it("answers an unknown, a malformed, a nil and another version's suite id with 404 test_suite_not_found on every suite endpoint", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const onV2 = await createdSuite(ana, target, {}, target.v2);
      for (const suiteId of [randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-000000000000", onV2.id]) {
        for (const [method, url, body] of [
          ["PATCH", suitePath(target, suiteId), { name: "x" }],
          ["DELETE", suitePath(target, suiteId), undefined],
          ["GET", definitionsPath(target, suiteId), undefined],
          ["POST", definitionsPath(target, suiteId), definitionBody({ inputFileId: randomUUID() })],
          ["DELETE", `${definitionsPath(target, suiteId)}/${randomUUID()}`, undefined],
          ["GET", headPath(target, suiteId, randomUUID()), undefined],
        ] as const) {
          expectRefusal(await call(ana, method, url, body), 404, "test_suite_not_found", MESSAGES.suiteNotFound);
        }
      }
      expect((await databases.ownerDb.selectFrom("test_suites").select("name").execute()).length).toBe(1);
    });

    it("takes the path's ids in upper case as the same suite (canonicalIdOf), and a configuration or version id that isn't one as 404", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const upper: Target = {
        ...target,
        configurationId: target.configurationId.toUpperCase(),
        versionId: target.versionId.toUpperCase(),
      };
      expect((await call(ana, "GET", suitesPath(upper))).json<{ suites: SuiteBody[] }>().suites.map((each) => each.id)).toEqual([
        suite.id,
      ]);
      const renamed = await call(ana, "PATCH", suitePath(upper, suite.id.toUpperCase()), { name: "Upper" });
      expect(renamed.json<{ suite: SuiteBody }>().suite).toMatchObject({ id: suite.id, name: "Upper" });
      expectRefusal(
        await call(ana, "GET", suitesPath({ ...target, configurationId: "not-a-uuid" })),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await call(ana, "POST", suitesPath(target, { versionId: "not-a-uuid" }), { name: "x" }),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      expect((await call(ana, "DELETE", suitePath(upper, suite.id.toUpperCase()))).statusCode).toBe(204);
      expect(await databases.ownerDb.selectFrom("test_suites").select("id").execute()).toEqual([]);
    });

    it("answers another configuration's version and a deleted configuration with 404 on all eight endpoints, writing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const other = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana);
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: file.id });
      const before = await Promise.all([
        databases.ownerDb.selectFrom("test_definitions").select(["id", "name"]).execute(),
        inputRows(),
        inputFiles(),
      ]);
      expectRefusal(
        await call(ana, "POST", suitesPath(target, { versionId: other.versionId }), { name: "x" }),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      expectRefusal(
        await call(ana, "GET", suitesPath(target, { versionId: other.versionId })),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      await databases.ownerDb
        .updateTable("configurations")
        .set({ deleted_at: new Date() })
        .where("id", "=", target.configurationId)
        .execute();
      for (const [method, url, body] of [
        ["GET", suitesPath(target), undefined],
        ["POST", suitesPath(target), { name: "x" }],
        ["PATCH", suitePath(target, suite.id), { name: "x" }],
        ["DELETE", suitePath(target, suite.id), undefined],
        ["GET", definitionsPath(target, suite.id), undefined],
        ["POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id })],
        ["DELETE", `${definitionsPath(target, suite.id)}/${definition.id}`, undefined],
        ["GET", headPath(target, suite.id, definition.id), undefined],
      ] as const) {
        expectRefusal(await call(ana, method, url, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(await databases.ownerDb.selectFrom("test_suites").select(["id", "name"]).execute()).toEqual([
        { id: suite.id, name: suite.name },
      ]);
      expect(
        await Promise.all([
          databases.ownerDb.selectFrom("test_definitions").select(["id", "name"]).execute(),
          inputRows(),
          inputFiles(),
        ]),
      ).toEqual(before);
      expect(await auditRows("test_definition.")).toHaveLength(1);
    });

    it("refuses a version's 101st suite with 409 test_suite_limit_reached, and another version still takes one", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      await sql`
        insert into test_suites (organization_id, configuration_id, configuration_version_id, name, created_by_user_id,
                                 created_at, updated_at)
        select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, 'Seeded ' || n, ${ana.userId}, now(), now()
          from generate_series(1, 100) as n
      `.execute(databases.ownerDb);

      expectRefusal(
        await call(ana, "POST", suitesPath(target), { name: "The 101st" }),
        409,
        "test_suite_limit_reached",
        TEST_SUITE_LIMIT_MESSAGE,
      );
      expect(TEST_SUITE_LIMIT_MESSAGE).toBe("A version can have at most 100 test suites.");
      expect((await call(ana, "GET", suitesPath(target))).json<{ suites: SuiteBody[] }>().suites).toHaveLength(100);
      await createdSuite(ana, target, { name: "On v2" }, target.v2);
      expect(await auditRows("test_suite.created")).toHaveLength(1);
    });

    it("counts the cap under the configuration's lock: five creates at once with 99 suites give exactly one 201 and four 409s", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      await sql`
        insert into test_suites (organization_id, configuration_id, configuration_version_id, name, created_by_user_id,
                                 created_at, updated_at)
        select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, 'Seeded ' || n, ${ana.userId}, now(), now()
          from generate_series(1, 99) as n
      `.execute(databases.ownerDb);
      const responses = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => call(ana, "POST", suitesPath(target), { name: `Racer ${n}` })),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
      expect((await call(ana, "GET", suitesPath(target))).json<{ suites: SuiteBody[] }>().suites).toHaveLength(100);
    });

    it("deletes a suite (204) with its definitions, freeing exactly the inputs nothing else names, rows and bytes, with an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana, { published: true });
      const suite = await createdSuite(ana, target);
      const [fileA, fileB, fileC] = [await uploaded(ana), await uploaded(ana), await uploaded(ana)];
      const a = await createdDefinition(ana, target, suite.id, { inputFileId: fileA.id });
      await createdDefinition(ana, target, suite.id, { inputFileId: fileB.id });
      const c = await createdDefinition(ana, target, suite.id, { inputFileId: fileC.id });
      const inputs = await inputRows();
      const inputOf = async (definitionId: string) =>
        (
          await databases.ownerDb
            .selectFrom("test_definitions")
            .select("input_id")
            .where("id", "=", definitionId)
            .executeTakeFirstOrThrow()
        ).input_id;
      const [inputA, inputC] = [await inputOf(a.id), await inputOf(c.id)];
      // A version copy's definition on v2 shares input C.
      const copy = await addTestSuite(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
        created_by_user_id: ana.userId,
      });
      await addTestDefinition(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
        testSuiteId: copy.id,
        inputId: inputC,
        created_by_user_id: ana.userId,
      });
      expect(await inputFiles()).toHaveLength(3);

      const response = await call(ana, "DELETE", suitePath(target, suite.id));

      expect(response.statusCode).toBe(204);
      expect(await databases.ownerDb.selectFrom("test_suites").select("id").execute()).toEqual([{ id: copy.id }]);
      expect((await databases.ownerDb.selectFrom("test_definitions").select("test_suite_id").execute()).map((row) => row.test_suite_id)).toEqual([
        copy.id,
      ]);
      expect((await inputRows()).map((row) => row.id)).toEqual([inputC]);
      expect(await inputFiles()).toEqual([inputPath(target.organizationId, inputC)]);
      const freed = inputs.map((row) => row.id).filter((id) => id !== inputC).sort();
      expect(freed).toContain(inputA);
      expect(await auditRows("test_suite.deleted")).toEqual([
        expect.objectContaining({
          subject_type: "test_suite",
          subject_id: suite.id,
          metadata: { configurationId: target.configurationId, versionId: target.versionId, freedInputIds: freed },
        }),
      ]);
    });

    it("answers 204 when a freed input's bytes can't be removed, logging only the error's code and syscall", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      isRemoveFailing = true;
      logLines = [];

      expect((await call(ana, "DELETE", suitePath(target, suite.id))).statusCode).toBe(204);

      expect(await inputRows()).toEqual([]);
      const warnings = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === 40);
      expect(warnings).toEqual([
        expect.objectContaining({ code: "EROFS", syscall: "unlink", msg: "a test definition input's bytes could not be removed" }),
      ]);
      expect(JSON.stringify(warnings)).not.toContain(target.organizationId);
    });
  });

  describe("visibility", () => {
    it("hides a draft's suites and definitions from a teammate (404 configuration_not_found everywhere) until it is published; then he sees them, creates a definition from his own file and sees Ana's", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const anas = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      const bensFile = await uploaded(ben, Buffer.from('{"resourceLogs":[{"ben":true}]}\n'), "ben.json");

      for (const [method, url, body] of [
        ["GET", suitesPath(target), undefined],
        ["POST", suitesPath(target), { name: "Ben's" }],
        ["PATCH", suitePath(target, suite.id), { name: "Taken" }],
        ["DELETE", suitePath(target, suite.id), undefined],
        ["GET", definitionsPath(target, suite.id), undefined],
        ["POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: bensFile.id })],
        ["DELETE", `${definitionsPath(target, suite.id)}/${anas.id}`, undefined],
        ["GET", headPath(target, suite.id, anas.id), undefined],
      ] as const) {
        expectRefusal(await call(ben, method, url, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(await inputFiles()).toHaveLength(1);

      await publish(target, ana);

      expect((await call(ben, "GET", suitesPath(target))).json<{ suites: SuiteBody[] }>().suites).toEqual([suite]);
      const bens = await createdDefinition(ben, target, suite.id, { inputFileId: bensFile.id }, { name: "Ben's" });
      expect(bens).toMatchObject({ createdByUserId: ben.userId, inputName: "ben.json" });
      const listed = (await call(ben, "GET", definitionsPath(target, suite.id))).json<{ definitions: DefinitionBody[] }>();
      expect(listed.definitions.map((definition) => definition.id)).toEqual([anas.id, bens.id]);
      // Ana's definition's input is his to read too (Play one's check), though her file is hers alone.
      expect((await call(ben, "GET", headPath(target, suite.id, anas.id))).statusCode).toBe(200);
      // And a published configuration's suite is every member's to rename.
      expect((await call(ben, "PATCH", suitePath(target, suite.id), { name: "Renamed by Ben" })).statusCode).toBe(200);
    });

    it("answers another organization with 404 everywhere: its path is organization_not_found, and its own path naming A's ids is configuration_not_found", async () => {
      const { ana, cara } = await team();
      const target = await configurationOf(ana, { published: true });
      const suite = await createdSuite(ana, target);
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      const carasFile = await uploaded(cara);
      const endpoints = (options: { organizationId?: string }) =>
        [
          ["GET", suitesPath(target, options), undefined],
          ["POST", suitesPath(target, options), { name: "Cara's" }],
          ["PATCH", suitePath(target, suite.id, options), { name: "Taken" }],
          ["DELETE", suitePath(target, suite.id, options), undefined],
          ["GET", definitionsPath(target, suite.id, options), undefined],
          ["POST", definitionsPath(target, suite.id, options), definitionBody({ inputFileId: carasFile.id })],
          ["DELETE", `${definitionsPath(target, suite.id, options)}/${definition.id}`, undefined],
          ["GET", headPath(target, suite.id, definition.id, options), undefined],
        ] as const;
      for (const [method, url, body] of endpoints({})) {
        expectRefusal(await call(cara, method, url, body), 404, "organization_not_found", MESSAGES.organizationNotFound);
      }
      for (const [method, url, body] of endpoints({ organizationId: cara.organizationId })) {
        expectRefusal(await call(cara, method, url, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(await databases.ownerDb.selectFrom("test_suites").select(["id", "name"]).execute()).toEqual([
        { id: suite.id, name: suite.name },
      ]);
      expect((await inputRows()).length).toBe(1);
      expect(await inputFiles()).toHaveLength(1);
    });

    it("needs a session on every endpoint (401)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana);
      for (const [method, url, body] of [
        ["GET", suitesPath(target), undefined],
        ["POST", suitesPath(target), { name: "x" }],
        ["PATCH", suitePath(target, suite.id), { name: "x" }],
        ["DELETE", suitePath(target, suite.id), undefined],
        ["GET", definitionsPath(target, suite.id), undefined],
        ["POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id })],
        ["DELETE", `${definitionsPath(target, suite.id)}/${randomUUID()}`, undefined],
        ["GET", headPath(target, suite.id, randomUUID()), undefined],
      ] as const) {
        expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
      }
      expect(await inputRows()).toEqual([]);
    });

    it("refuses every endpoint, all eight, with 403 terms_acceptance_required to a member who hasn't accepted the current terms, writing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana);
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: file.id });
      // The session check reads the user's row on each request: the terms change under her open session.
      await databases.ownerDb
        .updateTable("users")
        .set({ accepted_terms_version: "2025-01-01" })
        .where("id", "=", ana.userId)
        .execute();
      const before = await Promise.all([
        databases.ownerDb.selectFrom("test_suites").selectAll().execute(),
        databases.ownerDb.selectFrom("test_definitions").selectAll().execute(),
        inputRows(),
        inputFiles(),
        databases.ownerDb.selectFrom("audit_events").select("id").execute(),
      ]);
      const endpoints = [
        ["GET", suitesPath(target), undefined],
        ["POST", suitesPath(target), { name: "x" }],
        ["PATCH", suitePath(target, suite.id), { name: "x" }],
        ["DELETE", suitePath(target, suite.id), undefined],
        ["GET", definitionsPath(target, suite.id), undefined],
        ["POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id })],
        ["DELETE", `${definitionsPath(target, suite.id)}/${definition.id}`, undefined],
        ["GET", headPath(target, suite.id, definition.id), undefined],
      ] as const;
      expect(endpoints).toHaveLength(8);
      for (const [method, url, body] of endpoints) {
        const response = await call(ana, method, url, body);
        expect({ endpoint: `${method} ${url}`, status: response.statusCode, body: response.json() }).toEqual({
          endpoint: `${method} ${url}`,
          status: 403,
          body: { error: { code: "terms_acceptance_required", message: MESSAGES.termsRequired } },
        });
      }
      expect(
        await Promise.all([
          databases.ownerDb.selectFrom("test_suites").selectAll().execute(),
          databases.ownerDb.selectFrom("test_definitions").selectAll().execute(),
          inputRows(),
          inputFiles(),
          databases.ownerDb.selectFrom("audit_events").select("id").execute(),
        ]),
      ).toEqual(before);
    });
  });

  describe("definitions", () => {
    it("creates a definition from the caller's own file (201): the input copied and its row the file's name and type with the copy's size and SHA-256, an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const data = Buffer.from('{"resourceLogs":[{"scopeLogs":[]}]}\n');
      const file = await uploaded(ana, data);

      const response = await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id }, {
        name: `  Logs only ${NAME_MARKER} `,
        pipeline: "logs/app",
        durationSeconds: 60,
      }));

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const definition = response.json<{ definition: DefinitionBody }>().definition;
      expect(definition).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        suiteId: suite.id,
        name: `Logs only ${NAME_MARKER}`,
        description: `From the laptop ${DESCRIPTION_MARKER}`,
        pipeline: "logs/app",
        signal: "logs",
        durationSeconds: 60,
        inputName: file.fileName,
        createdByUserId: ana.userId,
        createdAt: clock.toISOString(),
      });
      const [input] = await inputRows();
      expect(input).toMatchObject({
        organization_id: target.organizationId,
        configuration_id: target.configurationId,
        file_name: file.fileName,
        content_type: "application/json",
        size_bytes: data.length,
      });
      expect(input!.sha256.toString("hex")).toBe(sha256Of(data));
      expect(await inputFiles()).toEqual([inputPath(target.organizationId, input!.id)]);
      expect(await readFile(join(root, inputPath(target.organizationId, input!.id)))).toEqual(data);
      expect(await auditRows("test_definition.")).toEqual([
        expect.objectContaining({
          action: "test_definition.created",
          actor_user_id: ana.userId,
          organization_id: ana.organizationId,
          subject_type: "test_definition",
          subject_id: definition.id,
          metadata: {
            configurationId: target.configurationId,
            versionId: target.versionId,
            suiteId: suite.id,
            inputId: input!.id,
            inputFileId: file.id,
          },
        }),
      ]);
    });

    it("creates a definition from a live template, the input copied under the template's file name and type; a deleted, unknown or bytes-gone template is 404 test_template_not_found, leaving nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const data = Buffer.from("trace sample\n");
      const template = await templateWith(data, { file_name: "otlp-traces.txt", content_type: "text/plain" });

      const definition = await createdDefinition(ana, target, suite.id, { templateId: template.id.toUpperCase() }, {
        pipeline: "traces",
        signal: "traces",
      });
      expect(definition).toMatchObject({ inputName: "otlp-traces.txt", signal: "traces", pipeline: "traces" });
      const [input] = await inputRows();
      expect(input).toMatchObject({ file_name: "otlp-traces.txt", content_type: "text/plain", size_bytes: data.length });
      expect(await readFile(join(root, inputPath(target.organizationId, input!.id)))).toEqual(data);
      expect((await auditRows("test_definition.created"))[0]!.metadata).toMatchObject({ templateId: template.id });

      const deleted = await templateWith(data);
      await databases.ownerDb.updateTable("test_templates").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();
      const bytesGone = await addTestTemplate(databases.ownerDb);
      for (const templateId of [deleted.id, randomUUID(), bytesGone.id]) {
        expectRefusal(
          await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ templateId })),
          404,
          "test_template_not_found",
          MESSAGES.templateNotFound,
        );
      }
      expect((await inputRows()).length).toBe(1);
      expect(await inputFiles()).toHaveLength(1);
    });

    it("refuses a teammate's My Files file, an unknown and a nil one with 404 test_file_not_found, before any copy begins; the caller's own file in upper case is theirs", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const suite = await createdSuite(ana, target);
      const anasFile = await uploaded(ana);

      for (const inputFileId of [anasFile.id, randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
        expectRefusal(
          await call(ben, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId })),
          404,
          "test_file_not_found",
          MESSAGES.fileNotFound,
        );
      }
      // Refused at the source's read, as the caller (the file's owner, then row-level security), never at the copy.
      expect(copies).toEqual([]);
      expect(await inputRows()).toEqual([]);
      expect(await inputFiles()).toEqual([]);

      const bensFile = await uploaded(ben);
      const definition = await createdDefinition(ben, target, suite.id, { inputFileId: bensFile.id.toUpperCase() });
      expect(definition.inputName).toBe(bensFile.fileName);
      // The canonical id names the source's key: Ben's own file, in his own folder.
      expect(copies).toEqual([
        {
          from: { kind: "test-input", organizationId: ben.organizationId, userId: ben.userId, fileId: bensFile.id },
          to: { kind: "test-definition-input", organizationId: ben.organizationId, inputId: expect.any(String) },
        },
      ]);
      expect((await auditRows("test_definition.created"))[0]!.metadata).toMatchObject({ inputFileId: bensFile.id });
    });

    it("refuses a body naming both sources or neither, a pipeline of another signal, a duration outside 1 to 60, an unknown field and a malformed id (400), copying nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana);
      for (const body of [
        definitionBody({ inputFileId: file.id }, { templateId: randomUUID() }),
        { ...definitionBody({ inputFileId: file.id }), inputFileId: undefined },
        definitionBody({ inputFileId: file.id }, { pipeline: "traces" }),
        definitionBody({ inputFileId: file.id }, { durationSeconds: 0 }),
        definitionBody({ inputFileId: file.id }, { durationSeconds: 61 }),
        definitionBody({ inputFileId: file.id }, { inputId: randomUUID() }),
        definitionBody({ inputFileId: "not-a-uuid" }),
        definitionBody({ inputFileId: file.id }, { name: "" }),
      ]) {
        expectInvalid(await call(ana, "POST", definitionsPath(target, suite.id), body));
      }
      expect(await inputRows()).toEqual([]);
      expect(await inputFiles()).toEqual([]);
    });

    it("lists the suite's definitions oldest first, by created_at then id, with their inputs' names", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const other = await createdSuite(ana, target, { name: "Other" });
      const file = await uploaded(ana);
      const first = await createdDefinition(ana, target, suite.id, { inputFileId: file.id }, { name: "First" });
      // Two at once: the id decides.
      const second = await createdDefinition(ana, target, suite.id, { inputFileId: file.id }, { name: "Second" });
      const third = await createdDefinition(ana, target, suite.id, { inputFileId: file.id }, { name: "Third" });
      tick();
      const last = await createdDefinition(ana, target, suite.id, { inputFileId: file.id }, { name: "Last" });
      await createdDefinition(ana, target, other.id, { inputFileId: file.id }, { name: "Elsewhere" });

      const response = await call(ana, "GET", definitionsPath(target, suite.id));
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const listed = response.json<{ definitions: DefinitionBody[] }>().definitions;
      expect(listed.map((definition) => definition.id)).toEqual([
        ...[first.id, second.id, third.id].sort(),
        last.id,
      ]);
      expect(listed.every((definition) => definition.inputName === file.fileName)).toBe(true);
    });

    it("keeps a definition's input when Ana deletes her My Files file: its head still reads it", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const data = Buffer.from('{"resourceLogs":[{"kept":true}]}\n');
      const file = await uploaded(ana, data);
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: file.id });

      const deleted = await call(ana, "DELETE", `/api/v1/organizations/${ana.organizationId}/test-files/${file.id}`);
      expect(deleted.statusCode).toBe(204);

      const head = await call(ana, "GET", headPath(target, suite.id, definition.id));
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload).toEqual(data);
    });

    it("refuses a suite's 101st definition with 409 test_definition_limit_reached, keeping no copy of its input", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const seeded = await addTestDefinitionInput(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
      });
      await sql`
        insert into test_definitions (organization_id, configuration_id, configuration_version_id, test_suite_id, input_id,
                                      name, target_pipeline, signal, duration_seconds, created_by_user_id, created_at)
        select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, ${suite.id}, ${seeded.id},
               'Seeded ' || n, 'logs', 'logs', 5, ${ana.userId}, now()
          from generate_series(1, 100) as n
      `.execute(databases.ownerDb);
      const file = await uploaded(ana);

      expectRefusal(
        await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id })),
        409,
        "test_definition_limit_reached",
        TEST_DEFINITION_LIMIT_MESSAGE,
      );
      expect(TEST_DEFINITION_LIMIT_MESSAGE).toBe("A test suite can have at most 100 test configurations.");
      expect((await inputRows()).map((row) => row.id)).toEqual([seeded.id]);
      expect(await inputFiles()).toEqual([]);
      expect(await auditRows("test_definition.")).toEqual([]);
      // Another suite still takes one.
      const other = await createdSuite(ana, target, { name: "Other" });
      await createdDefinition(ana, target, other.id, { inputFileId: file.id });
    });

    it("counts the cap under the configuration's lock: five creates at once with 99 definitions give exactly one 201 and four 409s, one copy kept", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const seeded = await addTestDefinitionInput(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
      });
      await sql`
        insert into test_definitions (organization_id, configuration_id, configuration_version_id, test_suite_id, input_id,
                                      name, target_pipeline, signal, duration_seconds, created_by_user_id, created_at)
        select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, ${suite.id}, ${seeded.id},
               'Seeded ' || n, 'logs', 'logs', 5, ${ana.userId}, now()
          from generate_series(1, 99) as n
      `.execute(databases.ownerDb);
      const file = await uploaded(ana);
      const responses = await Promise.all(
        [1, 2, 3, 4, 5].map(() => call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id }))),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await inputRows()).toHaveLength(2);
      expect(await inputFiles()).toHaveLength(1);
    });

    it("removes the copied input when the definition can't be saved after the copy (a failed insert), leaving no row and no bytes", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana);
      await withFailingInsert(databases.ownerDb, "test_definitions", "raise exception 'definition insert refused'", async () => {
        const response = await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id }));
        expect(response.statusCode).toBe(500);
      });
      expect(await inputRows()).toEqual([]);
      expect(await databases.ownerDb.selectFrom("test_definitions").select("id").execute()).toEqual([]);
      expect(await inputFiles()).toEqual([]);
      expect(await auditRows("test_definition.")).toEqual([]);
    });

    it("deletes a definition (204): its input freed, row and bytes, only once no definition names it, with audit rows of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const own = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      const shared = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      const sharedInput = (
        await databases.ownerDb.selectFrom("test_definitions").select("input_id").where("id", "=", shared.id).executeTakeFirstOrThrow()
      ).input_id;
      const ownInput = (
        await databases.ownerDb.selectFrom("test_definitions").select("input_id").where("id", "=", own.id).executeTakeFirstOrThrow()
      ).input_id;
      // A version copy's definition names the shared input too.
      const copy = await addTestSuite(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
      });
      const copied = await addTestDefinition(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
        testSuiteId: copy.id,
        inputId: sharedInput,
      });

      expect((await call(ana, "DELETE", `${definitionsPath(target, suite.id)}/${own.id}`)).statusCode).toBe(204);
      expect((await call(ana, "DELETE", `${definitionsPath(target, suite.id)}/${shared.id}`)).statusCode).toBe(204);

      expect((await inputRows()).map((row) => row.id)).toEqual([sharedInput]);
      expect(await inputFiles()).toEqual([inputPath(target.organizationId, sharedInput)]);
      expect((await auditRows("test_definition.deleted")).map((row) => [row.subject_id, row.metadata])).toEqual([
        [
          own.id,
          {
            configurationId: target.configurationId,
            versionId: target.versionId,
            suiteId: suite.id,
            inputId: ownInput,
            freedInputIds: [ownInput],
          },
        ],
        [
          shared.id,
          {
            configurationId: target.configurationId,
            versionId: target.versionId,
            suiteId: suite.id,
            inputId: sharedInput,
            freedInputIds: [],
          },
        ],
      ]);
      // The copy's own definition, deleted through v2's path, frees it at last.
      expect((await call(ana, "DELETE", `${definitionsPath(target, copy.id, { versionId: target.v2 })}/${copied.id.toUpperCase()}`)).statusCode).toBe(204);
      expect(await inputRows()).toEqual([]);
      expect(await inputFiles()).toEqual([]);
    });

    it("answers an unknown, a malformed and another suite's definition id with 404 test_definition_not_found, deleting nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const other = await createdSuite(ana, target, { name: "Other" });
      const elsewhere = await createdDefinition(ana, target, other.id, { inputFileId: (await uploaded(ana)).id });
      for (const definitionId of [randomUUID(), "not-a-uuid", elsewhere.id]) {
        expectRefusal(
          await call(ana, "DELETE", `${definitionsPath(target, suite.id)}/${definitionId}`),
          404,
          "test_definition_not_found",
          MESSAGES.definitionNotFound,
        );
        expectRefusal(
          await call(ana, "GET", headPath(target, suite.id, definitionId)),
          404,
          "test_definition_not_found",
          MESSAGES.definitionNotFound,
        );
      }
      expect((await databases.ownerDb.selectFrom("test_definitions").select("id").execute()).map((row) => row.id)).toEqual([
        elsewhere.id,
      ]);
    });
  });

  describe("a definition's input head (GET …/definitions/:definitionId/input/head)", () => {
    it("answers the first 64 KiB of a larger input, as bytes, never sniffed, under no name, never cached", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const data = Buffer.alloc(3 * 65_536 + 7);
      for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana, data)).id });
      readStreams = [];

      const response = await call(ana, "GET", headPath(target, suite.id, definition.id));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data.subarray(0, 65_536));
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-disposition": "attachment",
        "content-length": "65536",
      });
      expect(JSON.stringify(response.headers)).not.toContain(FILE_MARKER);
      expect(readStreams.length).toBe(1);
      expect(readStreams.every((stream) => stream.destroyed)).toBe(true);
    });

    it("answers a smaller input whole, and 404 test_definition_not_found once its bytes are gone", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const data = Buffer.from('{"resourceLogs":[{"small":true}]}\n');
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana, data)).id });
      const response = await call(ana, "GET", headPath(target, suite.id.toUpperCase(), definition.id.toUpperCase()));
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers["content-length"]).toBe(String(data.length));

      const [input] = await inputRows();
      await rm(join(root, inputPath(target.organizationId, input!.id)));
      expectRefusal(
        await call(ana, "GET", headPath(target, suite.id, definition.id)),
        404,
        "test_definition_not_found",
        MESSAGES.definitionNotFound,
      );
    });
  });

  describe("the uploads' limit (RATE_LIMITS: 30 a minute)", () => {
    it("counts a definition's create and its input's head with the person's uploads, refusing the 31st (429) before copying anything", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const suite = await createdSuite(ana, target);
      const file = await uploaded(ana); // On the unlimited server: not counted.
      const created: DefinitionBody[] = [];
      for (let index = 0; index < 15; index += 1) {
        const response = await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id }), {
          on: limited,
        });
        expect(response.statusCode).toBe(201);
        created.push(response.json<{ definition: DefinitionBody }>().definition);
      }
      for (let index = 0; index < 15; index += 1) {
        expect((await call(ana, "GET", headPath(target, suite.id, created[0]!.id), undefined, { on: limited })).statusCode).toBe(200);
      }
      expectRefusal(
        await call(ana, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: file.id }), { on: limited }),
        429,
        "rate_limited",
        MESSAGES.uploadsLimited,
      );
      expect((await call(ana, "GET", headPath(target, suite.id, created[0]!.id), undefined, { on: limited })).statusCode).toBe(429);
      expect(await inputRows()).toHaveLength(15);
      expect(await inputFiles()).toHaveLength(15);
      // Suite writes have no limit of their own.
      expect((await call(ana, "POST", suitesPath(target), { name: "Still" }, { on: limited })).statusCode).toBe(201);
    });
  });

  describe("a new version's copy of its source's suites", () => {
    /** POST …/versions: a new version of `target`'s configuration from `sourceVersionId`, as `person`. */
    const newVersion = (person: Person, target: Target, sourceVersionId: string) =>
      call(person, "POST", `/api/v1/organizations/${target.organizationId}/configurations/${target.configurationId}/versions`, {
        sourceVersionId,
        yamlContent: "receivers: {}\n",
        nodes: [],
        edges: [],
        pipelines: [],
      });

    /** A version's suites and each one's definitions, in the list's order (created_at, then id), as the tables' owner reads them. */
    const contentsOf = async (versionId: string) => {
      const ownerDb = databases.ownerDb;
      const suites = await ownerDb
        .selectFrom("test_suites")
        .selectAll()
        .where("configuration_version_id", "=", versionId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const definitions = [];
      for (const suite of suites) {
        definitions.push(
          ...(await ownerDb
            .selectFrom("test_definitions")
            .selectAll()
            .where("test_suite_id", "=", suite.id)
            .orderBy("created_at")
            .orderBy("id")
            .execute()),
        );
      }
      return { suites, definitions };
    };

    it("copies the suites and definitions in order (many sharing a created_at), sharing their inputs (no byte copied), a teammate their creator at the version's time; runs aren't copied; the audit row counts them", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const ownerDb = databases.ownerDb;
      // Two inputs with bytes, shared across the suites.
      const inputs = [];
      for (const name of ["first.json", "second.log"]) {
        const data = Buffer.from(`${name}\n`);
        const input = await addTestDefinitionInput(ownerDb, {
          organizationId: target.organizationId,
          configurationId: target.configurationId,
          file_name: name,
          size_bytes: data.length,
          sha256: createHash("sha256").update(data).digest(),
        });
        await store.write({ kind: "test-definition-input", organizationId: target.organizationId, inputId: input.id }, (async function* () { yield data; })(), { maxBytes: 10_485_760 });
        inputs.push(input);
      }
      // Six suites, four of them at one time, with random (v4) ids, so neither the insert's order nor
      // uuidv7's is the list's; each with four definitions, three at one time.
      const at = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
      const minutes = [0, 0, -1, 0, 1, 0];
      for (const [index, minute] of minutes.entries()) {
        const suite = await addTestSuite(ownerDb, {
          id: randomUUID(),
          organizationId: target.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          name: `suite ${index}`,
          description: `about suite ${index}`,
          created_by_user_id: ana.userId,
          created_at: new Date(at.getTime() + minute * 60_000),
        });
        for (const [position, offset] of [0, 0, -1, 0].entries()) {
          await addTestDefinition(ownerDb, {
            id: randomUUID(),
            organizationId: target.organizationId,
            configurationId: target.configurationId,
            configurationVersionId: target.versionId,
            testSuiteId: suite.id,
            inputId: inputs[(index + position) % 2]!.id,
            name: `definition ${index}.${position}`,
            description: `about ${index}.${position}`,
            target_pipeline: position % 2 === 0 ? "logs" : "traces/app",
            signal: position % 2 === 0 ? "logs" : "traces",
            duration_seconds: 1 + position,
            created_by_user_id: ana.userId,
            created_at: new Date(at.getTime() + offset * 60_000),
          });
        }
      }
      // A suite on another version stays where it is.
      await addTestSuite(ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
      });
      await addTestRun(ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
      });
      const filesBefore = await filesUnder(root);
      const source = await contentsOf(target.versionId);
      tick();

      const response = await newVersion(ben, target, target.versionId);

      expect(response.statusCode).toBe(201);
      const created = response.json<{ version: { id: string; versionNumber: number } }>().version;
      const copy = await contentsOf(created.id);
      // The same suites and definitions, in the same order, with the same text and inputs.
      const suiteFields = (suite: (typeof source.suites)[number]) => ({ name: suite.name, description: suite.description });
      const definitionFields = (definition: (typeof source.definitions)[number]) => ({
        name: definition.name,
        description: definition.description,
        target_pipeline: definition.target_pipeline,
        signal: definition.signal,
        duration_seconds: definition.duration_seconds,
        input_id: definition.input_id,
      });
      expect(copy.suites.map(suiteFields)).toEqual(source.suites.map(suiteFields));
      expect(copy.definitions.map(definitionFields)).toEqual(source.definitions.map(definitionFields));
      expect(copy.suites).toHaveLength(6);
      expect(copy.definitions).toHaveLength(24);
      // Each definition is in its own suite's copy.
      const copiedSuiteOf = new Map(source.suites.map((suite, index) => [suite.id, copy.suites[index]!.id]));
      expect(copy.definitions.map((definition) => definition.test_suite_id)).toEqual(
        source.definitions.map((definition) => copiedSuiteOf.get(definition.test_suite_id)),
      );
      // New rows: new ids, the version's own, Ben their creator, at the version's time.
      for (const row of [...copy.suites, ...copy.definitions]) {
        expect(row).toMatchObject({
          configuration_version_id: created.id,
          configuration_id: target.configurationId,
          organization_id: target.organizationId,
          created_by_user_id: ben.userId,
          created_at: clock,
        });
      }
      for (const suite of copy.suites) expect(suite.updated_at).toEqual(clock);
      expect(new Set([...copy.suites, ...copy.definitions].map((row) => row.id)).size).toBe(30);
      // The inputs are shared: no new row, no byte copied.
      expect(await inputRows()).toHaveLength(2);
      expect(copies).toEqual([]);
      expect(await filesUnder(root)).toEqual(filesBefore);
      // The source is as it was, and runs aren't copied.
      expect(await contentsOf(target.versionId)).toEqual(source);
      expect(await ownerDb.selectFrom("test_runs").select("id").where("configuration_version_id", "=", created.id).execute()).toEqual([]);
      // The suites the API lists on the new version, in that order.
      const listed = (await call(ben, "GET", suitesPath(target, { versionId: created.id }))).json<{ suites: SuiteBody[] }>().suites;
      expect(listed.map((suite) => suite.name)).toEqual(source.suites.map((suite) => suite.name));

      const [audit] = await databases.ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "configuration.version_created")
        .execute();
      expect(audit!.metadata).toEqual({
        versionId: created.id,
        versionNumber: 3,
        sourceVersionId: target.versionId,
        copiedSuites: 6,
        copiedDefinitions: 24,
        copiedValidationPipelines: 0,
        copiedValidationRules: 0,
      });
      expect(JSON.stringify(audit)).not.toContain("suite 0");
    });

    it("refuses a teammate's version create from a draft with 404 before the copy, copying nothing; its author's create copies the suites", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const suite = await createdSuite(ana, target);
      await createdDefinition(ana, target, suite.id, { inputFileId: file.id });

      expectRefusal(await newVersion(ben, target, target.versionId), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      expect(await databases.ownerDb.selectFrom("test_suites").select("id").execute()).toHaveLength(1);

      const response = await newVersion(ana, target, target.versionId);
      expect(response.statusCode).toBe(201);
      const copy = await contentsOf(response.json<{ version: { id: string } }>().version.id);
      expect(copy.suites.map((row) => [row.name, row.created_by_user_id])).toEqual([[suite.name, ana.userId]]);
      expect(copy.definitions).toHaveLength(1);
      await expectNothingDangles(target.organizationId);
    });

    it("copies nothing when the create fails after the copy (the audit row refused): neither the version nor its suites", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const suite = await createdSuite(ana, target);
      await createdDefinition(ana, target, suite.id, { inputFileId: file.id });
      const before = await Promise.all([
        databases.ownerDb.selectFrom("configuration_versions").select("id").execute(),
        databases.ownerDb.selectFrom("test_suites").selectAll().execute(),
        databases.ownerDb.selectFrom("test_definitions").selectAll().execute(),
        inputRows(),
      ]);

      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'refused for the test'", async () => {
        expect((await newVersion(ana, target, target.versionId)).statusCode).toBe(500);
      });

      expect(
        await Promise.all([
          databases.ownerDb.selectFrom("configuration_versions").select("id").execute(),
          databases.ownerDb.selectFrom("test_suites").selectAll().execute(),
          databases.ownerDb.selectFrom("test_definitions").selectAll().execute(),
          inputRows(),
        ]),
      ).toEqual(before);
    });

    describe("against a definition's delete on the same input, both under the configuration's lock", () => {
      /** A published configuration whose version 1 has one suite with Ana's one definition, on its own input. */
      const contested = async () => {
        const { ana, ben } = await team();
        const target = await configurationOf(ana, { published: true });
        const file = await uploaded(ana);
        const suite = await createdSuite(ana, target);
        const definition = await createdDefinition(ana, target, suite.id, { inputFileId: file.id });
        const [input] = await inputRows();
        const deleteDefinition = () => call(ana, "DELETE", `${definitionsPath(target, suite.id)}/${definition.id}`);
        return { ana, ben, target, suite, definition, inputId: input!.id, deleteDefinition };
      };

      it("the delete first: it frees the input, rows and bytes, and the copy then copies the suite alone", async () => {
        const { ben, target, suite, inputId, deleteDefinition } = await contested();

        const [deleted, created] = await inOrder(configurationRow(target.configurationId), deleteDefinition, () => newVersion(ben, target, target.versionId));

        expect([deleted.statusCode, created.statusCode]).toEqual([204, 201]);
        const copy = await contentsOf(created.json<{ version: { id: string } }>().version.id);
        expect(copy.suites.map((row) => row.name)).toEqual([suite.name]);
        expect(copy.definitions).toEqual([]);
        expect(await inputRows()).toEqual([]);
        expect(await inputFiles()).not.toContain(inputPath(target.organizationId, inputId));
        await expectNothingDangles(target.organizationId);
      }, LOCK_RACE_TIMEOUT);

      it("the copy first: its definition names the input, so the delete frees nothing, and the bytes stay", async () => {
        const { ben, target, definition, inputId, deleteDefinition } = await contested();

        const [created, deleted] = await inOrder(configurationRow(target.configurationId), () => newVersion(ben, target, target.versionId), deleteDefinition);

        expect([created.statusCode, deleted.statusCode]).toEqual([201, 204]);
        const copy = await contentsOf(created.json<{ version: { id: string } }>().version.id);
        expect(copy.definitions.map((row) => [row.name, row.input_id])).toEqual([[definition.name, inputId]]);
        expect((await contentsOf(target.versionId)).definitions).toEqual([]);
        expect((await inputRows()).map((row) => row.id)).toEqual([inputId]);
        expect(await inputFiles()).toEqual([inputPath(target.organizationId, inputId)]);
        await expectNothingDangles(target.organizationId);
      }, LOCK_RACE_TIMEOUT);
    });
  });

  /*
   * Deletes sharing an input, through the API. Each delete takes the
   * configuration's lock before it deletes a row and frees what nothing
   * names. The side connection holds the inputs' table, so both deletes have
   * begun before either frees: with the lock, the second waits for the first
   * to commit, and frees the input; without it (a bug), both have deleted
   * their definitions when they free, each still seeing the other's, and the
   * input is orphaned.
   */
  describe("deletes racing on a shared input", () => {
    /** Ana's published configuration: a suite on v1 with her definition on input I (and `own`, on J), a suite on v2 with a copy's definition on I. */
    const shared = async () => {
      const ana = await member();
      const target = await configurationOf(ana, { published: true });
      const onV1 = await createdSuite(ana, target);
      const definition = await createdDefinition(ana, target, onV1.id, { inputFileId: (await uploaded(ana)).id });
      const own = await createdDefinition(ana, target, onV1.id, { inputFileId: (await uploaded(ana)).id });
      const inputOf = async (definitionId: string) =>
        (
          await databases.ownerDb
            .selectFrom("test_definitions")
            .select("input_id")
            .where("id", "=", definitionId)
            .executeTakeFirstOrThrow()
        ).input_id;
      const inputId = await inputOf(definition.id);
      const ownInputId = await inputOf(own.id);
      // v2's suite and its definition on I, as a version copy leaves them.
      const onV2 = await createdSuite(ana, target, {}, target.v2);
      const copied = await addTestDefinition(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
        testSuiteId: onV2.id,
        inputId,
        created_by_user_id: ana.userId,
      });
      expect(await inputFiles()).toHaveLength(2);
      return {
        target,
        inputId,
        ownInputId,
        deleteOnV1: () => call(ana, "DELETE", `${definitionsPath(target, onV1.id)}/${definition.id}`),
        deleteOnV2: () => call(ana, "DELETE", `${definitionsPath(target, onV2.id, { versionId: target.v2 })}/${copied.id}`),
        deleteSuiteOnV1: () => call(ana, "DELETE", suitePath(target, onV1.id)),
      };
    };

    /** The freed inputs each delete's audit row names, in the order the deletes committed. */
    const freedByAudit = async () =>
      (await databases.ownerDb
        .selectFrom("audit_events")
        .select(["action", "metadata"])
        .where("action", "in", ["test_definition.deleted", "test_suite.deleted"])
        .orderBy("occurred_at")
        .orderBy("id")
        .execute()).map((row) => [row.action, (row.metadata as { freedInputIds: string[] }).freedInputIds]);

    it("two definition deletes at once, on v1 and v2 sharing one input: the second to commit frees it, row and bytes; nothing dangles or is orphaned", async () => {
      const { target, inputId, ownInputId, deleteOnV1, deleteOnV2 } = await shared();

      const [first, second] = await inOrder(inputsTable, deleteOnV1, deleteOnV2);

      expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
      expect((await inputRows()).map((row) => row.id)).toEqual([ownInputId]);
      expect(await inputFiles()).toEqual([inputPath(target.organizationId, ownInputId)]);
      expect(await freedByAudit()).toEqual([
        ["test_definition.deleted", []],
        ["test_definition.deleted", [inputId]],
      ]);
      await expectNothingDangles(target.organizationId);
    }, LOCK_RACE_TIMEOUT);

    it.each([
      ["the suite's delete first", true],
      ["the definition's delete first", false],
    ] as const)(
      "a suite delete and a definition delete at once, sharing one input (%s): the suite frees only its own input, the last delete the shared one; nothing dangles or is orphaned",
      async (_label, isSuiteFirst) => {
        const { target, inputId, ownInputId, deleteOnV2, deleteSuiteOnV1 } = await shared();

        const [first, second] = await inOrder(
          inputsTable,
          isSuiteFirst ? deleteSuiteOnV1 : deleteOnV2,
          isSuiteFirst ? deleteOnV2 : deleteSuiteOnV1,
        );

        expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
        expect(await inputRows()).toEqual([]);
        expect(await inputFiles()).toEqual([]);
        expect(await databases.ownerDb.selectFrom("test_definitions").select("id").execute()).toEqual([]);
        expect(await freedByAudit()).toEqual(
          isSuiteFirst
            ? [
                ["test_suite.deleted", [ownInputId]],
                ["test_definition.deleted", [inputId]],
              ]
            : [
                ["test_definition.deleted", []],
                ["test_suite.deleted", [inputId, ownInputId].sort()],
              ],
        );
        await expectNothingDangles(target.organizationId);
      },
      LOCK_RACE_TIMEOUT,
    );
  });

  describe("privacy", () => {
    it("puts no suite's or definition's name, description or input name in any audit row or log line", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const suite = await createdSuite(ana, target);
      await call(ana, "PATCH", suitePath(target, suite.id), {
        name: `Renamed ${NAME_MARKER}`,
        description: `Described ${DESCRIPTION_MARKER}`,
      });
      const definition = await createdDefinition(ana, target, suite.id, { inputFileId: (await uploaded(ana)).id });
      await createdDefinition(ana, target, suite.id, {
        templateId: (await templateWith(Buffer.from("x"))).id,
      });
      await call(ana, "GET", definitionsPath(target, suite.id));
      await call(ana, "GET", headPath(target, suite.id, definition.id));
      await call(ben, "POST", definitionsPath(target, suite.id), definitionBody({ inputFileId: randomUUID() }));
      await call(ana, "DELETE", `${definitionsPath(target, suite.id)}/${definition.id}`);
      await call(ana, "DELETE", suitePath(target, suite.id));

      const audits = [...(await auditRows("test_suite.")), ...(await auditRows("test_definition."))];
      expect(audits.map((row) => row.action).sort()).toEqual([
        "test_definition.created",
        "test_definition.created",
        "test_definition.deleted",
        "test_suite.created",
        "test_suite.deleted",
        "test_suite.updated",
      ]);
      expect(logLines.length).toBeGreaterThan(0);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, FILE_MARKER]) {
        expect(JSON.stringify(audits)).not.toContain(marker);
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }
    });
  });
});
