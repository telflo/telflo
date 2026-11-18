import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import {
  COLLECTOR_VERSION_RETIRED_MESSAGE,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  TEST_RUN_YAML_MAXIMUM_LENGTH,
  TESTING_UNAVAILABLE_MESSAGE,
} from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestRun,
  addTestTemplate,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
  type TestRunState,
} from "@telflo/db/testing";
import { prepareTestDatabase, THROWAWAY_DATABASE_DROP_TIMEOUT } from "@telflo/db/test-database";
import { createFileStore } from "../../file-store/create-file-store.js";
import { FileStoreError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import { createCollectingRunner } from "../../http/after-response.js";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { createCopyPlaces, TEST_RUN_COPIES_WAITING_PER_USER, type CopyPlaces } from "./copy-places.js";
import { opampOrganizationVariables, type IOrganizationVariables } from "./organization-variables.js";
import type { TestingDependencies } from "./test-runs-dependencies.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const MIB = 1_048_576;
const TEN_MIB = 10 * MIB;

/** Creating, migrating and dropping a database waits for checkpoints. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/** The committed catalogue's distribution, and a Contrib version this file deprecates (a fixture's). */
const CONTRIB = "otelcol-contrib";
const RETIRED = "0.1.0";

/** Markers no log line, URL or audit row may hold: a file's names, its description and a run's text. */
const NAME_MARKER = "name-marker-5e1c";
const DESCRIPTION_MARKER = "description-marker-91ab";
const TEXT_MARKER = "text-marker-3f7d";
/** An organization variable's value (D20): configuration text, in no log line, URL or audit row. */
const VALUE_MARKER = "value-marker-c41d";

const RUN_TEXT = `receivers:\n  otlp:\n    protocols:\n      http: {}\n# ${TEXT_MARKER}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n`;

/** The words, exactly. */
const MESSAGES = {
  organizationNotFound: "Organization not found",
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  fileNotFound: "Test file not found",
  runNotFound: "Test run not found",
  definitionNotFound: "Test configuration not found",
  templateNotFound: "Test template not found",
  noSuchFile: "This run has no such file.",
  tooLarge: "The file is larger than 10 MiB.",
  sampleTooLarge: "The file is larger than 1 MiB.",
  typeUnsupported: "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.",
  invalid: "The request was not valid.",
  versionUnknown: "That collector version isn't available.",
  rateLimited: "Too many test runs in the last minute. Try again shortly.",
  queuingBusy: "Too many test runs being queued at once. Try again shortly.",
  queueFull: "You have 50 test runs waiting already. Wait for some to finish.",
  variablesUnavailable: "The organization's variables couldn't be reached. Try again.",
  filledInTooLong: "The configuration with its organization variables filled in is over 262,144 characters.",
  uploadsLimited: "Too many attempts. Please wait and try again.",
  unauthenticated: "You need to sign in.",
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
      const type = part.contentType === undefined ? "" : `Content-Type: ${part.contentType}\r\n`;
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n${type}\r\n`),
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

/** An upload's three parts, in order. */
function uploadParts(
  data: Buffer,
  options: { displayName?: string; description?: string; filename?: string; contentType?: string } = {},
): Part[] {
  return [
    { name: "displayName", value: options.displayName ?? `App logs ${NAME_MARKER}` },
    { name: "description", value: options.description ?? `From the laptop ${DESCRIPTION_MARKER}` },
    {
      name: "file",
      filename: options.filename ?? `app-logs-${NAME_MARKER}.json`,
      data,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    },
  ];
}

/** A run's results, as the dispatcher stores them (Task 8), for a finished run's fixture. */
interface FinishedRunFields {
  output_size_bytes?: number;
  output_truncated?: boolean;
  decoded_input_size_bytes?: number;
  decoded_input_truncated?: boolean;
  [column: string]: unknown;
}

/** A finished run's state: the owner may insert it so (addTestRun's `state`). */
function finishedState(fields: FinishedRunFields = {}): Partial<TestRunState> {
  return {
    status: "succeeded",
    queued_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)),
    finished_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 9)),
    ...fields,
  } as unknown as Partial<TestRunState>;
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

/*
 * D14a Task 7: the test files and runs API (decision 28; Preflight rulings
 * 10 to 13 and 15; Ruling 24), against Postgres as the API's own role, with
 * a real FileStore on a temporary directory. The catalogue needs a
 * deprecated Contrib version, which the committed one hasn't, so the file
 * runs on a throwaway database it prepares (migrated and synced, as
 * telflo_platform_test is) and drops afterwards. The dispatcher is Task 8's: runs
 * stay queued here, and the tester is never called (UNCALLED_TESTING's).
 */
describe("the test files and runs API", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let contribDefault: string;
  let root: string;
  let store: IFileStore;
  /** Every stream the store's reads handed out since the test began. */
  let readStreams: Readable[] = [];
  /** How many times a queued run woke the dispatcher's signal since the test began. */
  let wakes = 0;
  let logLines: string[] = [];
  const servers: FastifyInstance[] = [];

  /** While true, every copy fails as a full disk would. */
  let isCopyFailing = false;
  /** How many copies began since the test began. */
  let copiesBegun = 0;
  /** Called as each write begins. */
  let onWrite: (() => void) | undefined;
  /** While set, each copy waits until this many have begun, so the queues behind them race. */
  let copyBarrier: { remaining: number; opened: Promise<void>; open: () => void } | undefined;
  /** While set, each removal waits for it before it begins. */
  let beforeRemove: (() => Promise<void>) | undefined;

  /** The store the servers use: the real one, recording each read's stream. */
  const recordingStore: IFileStore = {
    write: (key, content, options) => {
      onWrite?.();
      return store.write(key, content, options);
    },
    copy: async (from, to) => {
      copiesBegun += 1;
      if (isCopyFailing) throw new FileStoreError("ENOSPC", "write");
      const copied = await store.copy(from, to);
      if (copyBarrier !== undefined) {
        copyBarrier.remaining -= 1;
        if (copyBarrier.remaining <= 0) copyBarrier.open();
        await copyBarrier.opened;
      }
      return copied;
    },
    remove: async (key) => {
      await beforeRemove?.();
      return store.remove(key);
    },
    read: async (key) => {
      const result = await store.read(key);
      if (result.found) readStreams.push(result.stream);
      return result;
    },
  };

  /** A server on the throwaway database, logging every line to `logLines`. */
  async function serverWith(
    options: {
      rateLimits?: RateLimits;
      organizationVariables?: IOrganizationVariables;
      /** The queue's places (D14b Ruling 33), for a test that watches them; left out, the server's own. */
      copyPlaces?: CopyPlaces;
      /** Hooks of the test's own, added before the server is ready. */
      beforeReady?: (server: FastifyInstance) => void;
    } = {},
  ): Promise<FastifyInstance> {
    const testing: TestingDependencies = {
      ...UNCALLED_TESTING,
      queued: { notify: () => void (wakes += 1), subscribe: () => () => undefined },
      ...(options.organizationVariables === undefined ? {} : { organizationVariables: options.organizationVariables }),
      ...(options.copyPlaces === undefined ? {} : { copyPlaces: options.copyPlaces }),
    };
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: recordingStore,
        testing,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        runAfterResponse: (task) => createCollectingRunner().run(task),
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    servers.push(built);
    options.beforeReady?.(built);
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    databases = openTestDatabases();
    throwawayName = `telflo_test_runs_${randomUUID().replaceAll("-", "")}_test`;
    const ownerUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerUrl.pathname = `/${throwawayName}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${throwawayName}`;
    await prepareTestDatabase(ownerUrl.toString(), applicationUrl.toString());
    ownerDb = createDb(createPool(ownerUrl.toString()));
    db = createDb(createPool(applicationUrl.toString()));
    settings = loadSettings(process.env);
    await ownerDb
      .insertInto("collector_versions")
      .values({
        distribution: CONTRIB,
        version: RETIRED,
        label: `v${RETIRED}`,
        description: null,
        released_at: "2020-01-01",
        is_default: false,
        deprecated: true,
        deprecated_note: "Retired fixture.",
        container_image: `example/${CONTRIB}:${RETIRED}`,
        otelcol_contrib_version: null,
        supported_components: null,
        otelcol_contrib: "{}",
        opamp_supervisor: "{}",
      })
      .execute();
    const defaults = await ownerDb
      .selectFrom("collector_versions")
      .select("version")
      .where("distribution", "=", CONTRIB)
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    contribDefault = defaults.version;
    passwordHash = await hashPassword(PASSWORD);
    server = await serverWith();
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
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "telflo-test-runs-"));
    store = await createFileStore({ kind: "local", root });
    readStreams = [];
    wakes = 0;
    logLines = [];
    isCopyFailing = false;
    copiesBegun = 0;
    onWrite = undefined;
    copyBarrier = undefined;
    beforeRemove = undefined;
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

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
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  interface Person {
    userId: string;
    email: string;
    personalOrganizationId: string;
    /** The organization they act in. */
    organizationId: string;
    access: string;
  }

  /** A signed-in person active in a group organization (a new one unless given), as `role`. */
  const member = async (organizationId?: string, role: OrganizationRole = "admin"): Promise<Person> => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), organization.id);
    return {
      userId: account.user.id,
      email: account.user.email,
      personalOrganizationId: account.organization.id,
      organizationId: organization.id,
      access,
    };
  };

  /** The same person, also a member of another group organization (a new one), signed in again and active there. */
  const alsoIn = async (person: Person, role: OrganizationRole = "admin"): Promise<Person> => {
    const { organization } = await addMembership(ownerDb, { userId: person.userId, role });
    const access = await switchTo(await signedIn(person.email), organization.id);
    return { ...person, organizationId: organization.id, access };
  };

  /** Ana and Ben in one group organization, and Cara in another. */
  const team = async () => {
    const ana = await member();
    const ben = await member(ana.organizationId, "contributor");
    const cara = await member();
    return { ana, ben, cara };
  };

  /** A configuration `author` created, a draft unless `published`, with its version 1 at the default pin. */
  const configurationOf = async (author: Person, options: { published?: boolean } = {}) => {
    const configuration = await addConfiguration(ownerDb, {
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      collector_version: contribDefault,
      ...(options.published ? { publishedAt: new Date() } : {}),
    });
    return { configurationId: configuration.id, versionId: version.id, organizationId: author.organizationId };
  };

  type Target = Awaited<ReturnType<typeof configurationOf>>;

  const filesPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/test-files`;
  const runsPath = (target: Target, organizationId = target.organizationId) =>
    `/api/v1/organizations/${organizationId}/configurations/${target.configurationId}/versions/${target.versionId}/test-runs`;

  const upload = (
    person: { access?: string; organizationId: string } | undefined,
    parts: Part[],
    options: { on?: FastifyInstance; sample?: boolean; organizationId?: string } = {},
  ) => {
    const { payload, headers } = multipartBody(parts);
    return (options.on ?? server).inject({
      method: "POST",
      url: `${filesPath(options.organizationId ?? person!.organizationId)}${options.sample ? "/samples" : ""}`,
      headers: { ...csrfHeaders, ...headers },
      ...(person?.access === undefined ? {} : { cookies: { telflo_access: person.access } }),
      payload,
    });
  };

  /** An upload that succeeds; answers the file. */
  const uploaded = async (person: Person, data: Buffer = Buffer.from('{"resourceLogs":[]}\n'), options = {}) => {
    const response = await upload(person, uploadParts(data, options));
    expect(response.statusCode).toBe(201);
    return response.json<{ file: { id: string; fileName: string; sizeBytes: number; sha256: string } }>().file;
  };

  const suitesPath = (target: Target) => `${runsPath(target).slice(0, -"/test-runs".length)}/test-suites`;

  /**
   * A suite and a definition `person` creates on `target`'s version through
   * the API (D14b Task 3), its input copied from `source`; answers both.
   */
  const definitionOf = async (
    person: Person,
    target: Target,
    source: { inputFileId: string } | { templateId: string },
    overrides: Record<string, unknown> = {},
  ) => {
    const suiteResponse = await server.inject({
      method: "POST",
      url: suitesPath(target),
      headers: csrfHeaders,
      cookies: { telflo_access: person.access },
      payload: { name: `Smoke tests ${NAME_MARKER}`, description: DESCRIPTION_MARKER },
    });
    expect(suiteResponse.statusCode).toBe(201);
    const suite = suiteResponse.json<{ suite: { id: string; name: string } }>().suite;
    const definitionResponse = await server.inject({
      method: "POST",
      url: `${suitesPath(target)}/${suite.id}/definitions`,
      headers: csrfHeaders,
      cookies: { telflo_access: person.access },
      payload: {
        ...source,
        name: `Logs only ${NAME_MARKER}`,
        description: DESCRIPTION_MARKER,
        pipeline: "logs/app",
        signal: "logs",
        durationSeconds: 7,
        ...overrides,
      },
    });
    expect(definitionResponse.statusCode).toBe(201);
    const definition = definitionResponse.json<{
      definition: { id: string; name: string; inputName: string; pipeline: string; durationSeconds: number };
    }>().definition;
    const input = await ownerDb
      .selectFrom("test_definitions")
      .select("input_id")
      .where("id", "=", definition.id)
      .executeTakeFirstOrThrow();
    return { suite, definition, inputId: input.input_id };
  };

  /** A definition's run's body (D14b Preflight ruling 9): the definition, the text and the pin only. */
  const definitionRunBody = (definitionId: string, overrides: Record<string, unknown> = {}) => ({
    definitionId,
    yaml: RUN_TEXT,
    collectorVersion: contribDefault,
    ...overrides,
  });

  /** A live template with `data` behind it, as D14b Task 5's upload would leave it. */
  const templateWith = async (data: Buffer, overrides: { file_name?: string } = {}) => {
    const template = await addTestTemplate(ownerDb, {
      file_name: overrides.file_name ?? `otlp-logs-${NAME_MARKER}.json`,
      size_bytes: data.length,
      sha256: createHash("sha256").update(data).digest(),
    });
    await store.write({ kind: "test-template", templateId: template.id }, Readable.from([data]), { maxBytes: TEN_MIB });
    return template;
  };

  const queueBody = (
    input: { inputFileId: string } | { sourceRunId: string } | { templateId: string },
    overrides: Record<string, unknown> = {},
  ) => ({
    ...input,
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    yaml: RUN_TEXT,
    collectorVersion: contribDefault,
    ...overrides,
  });

  const queue = (person: Person, target: Target, body: unknown, options: { on?: FastifyInstance; organizationId?: string } = {}) =>
    (options.on ?? server).inject({
      method: "POST",
      url: runsPath(target, options.organizationId),
      headers: csrfHeaders,
      cookies: { telflo_access: person.access },
      payload: body as Record<string, unknown>,
    });

  const read = (person: Person, url: string, options: { on?: FastifyInstance } = {}) =>
    (options.on ?? server).inject({ method: "GET", url, cookies: { telflo_access: person.access } });

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: { code, message } });
  }

  /** A body the contract refuses: 400 `invalid_request`, with the schema's details. */
  function expectInvalid(response: LightMyRequestResponse): void {
    expect({ status: response.statusCode, error: response.json<{ error: Record<string, unknown> }>().error }).toMatchObject({
      status: 400,
      error: { code: "invalid_request", message: MESSAGES.invalid },
    });
  }

  const fileRows = () => ownerDb.selectFrom("test_input_files").selectAll().execute();
  const runRows = () => ownerDb.selectFrom("test_runs").selectAll().orderBy("queued_at").execute();
  const inputKeyPath = (organizationId: string, userId: string, fileId: string) =>
    join("organizations", organizationId, "users", userId, "test-inputs", fileId);
  const runFilePath = (organizationId: string, runId: string, name: string) =>
    join("organizations", organizationId, "test-runs", runId, name);

  /** Marks the tester down, as a monitor would (decision 12). */
  const markTesterDown = () => sql`update otelcol_testing_state set down_since = now()`.execute(ownerDb);

  describe("uploads (POST /test-files)", () => {
    it("streams the file to the store, then saves the row; the type is the extension's", async () => {
      const ana = await member();
      const data = Buffer.from('{"resourceLogs":[{"scopeLogs":[]}]}\n');

      const response = await upload(ana, uploadParts(data, { displayName: "  App logs  ", contentType: "text/html" }));

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { file } = response.json<{ file: Record<string, unknown> & { id: string } }>();
      expect(file).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        displayName: "App logs",
        fileName: `app-logs-${NAME_MARKER}.json`,
        description: `From the laptop ${DESCRIPTION_MARKER}`,
        // The extension's, never the browser's text/html.
        contentType: "application/json",
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        createdAt: expect.any(String),
      });
      const [row] = await fileRows();
      expect(row).toMatchObject({ id: file.id, organization_id: ana.organizationId, owner_user_id: ana.userId });
      expect(await filesUnder(root)).toEqual([inputKeyPath(ana.organizationId, ana.userId, file.id)]);
      expect(await readFile(join(root, inputKeyPath(ana.organizationId, ana.userId, file.id)))).toEqual(data);
    });

    it.each([
      ["events.json", "application/json"],
      ["events.NDJSON", "application/x-ndjson"],
      ["pipeline.yaml", "application/x-yaml"],
      ["pipeline.yml", "application/x-yaml"],
      ["notes.txt", "text/plain"],
      ["syslog.Log", "text/plain"],
    ])("stores %s as %s", async (filename, contentType) => {
      const ana = await member();
      const response = await upload(ana, uploadParts(Buffer.from("x"), { filename }));
      expect(response.statusCode).toBe(201);
      expect(response.json<{ file: { contentType: string; fileName: string } }>().file).toMatchObject({
        contentType,
        fileName: filename,
      });
    });

    it.each([
      ["another extension", "events.csv"],
      ["no extension", "events"],
      ["a dot file", ".json"],
      ["a trailing dot", "events.json."],
      ["a compressed file", "events.json.gz"],
    ])("refuses %s with 415, writing nothing", async (_label, filename) => {
      const ana = await member();
      const response = await upload(ana, uploadParts(Buffer.from("x"), { filename }));
      expectRefusal(response, 415, "test_file_type_unsupported", MESSAGES.typeUnsupported);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("accepts exactly 10 MiB, and refuses 10 MiB + 1 with 413, leaving no file and no row", async () => {
      const ana = await member();
      const exact = await upload(ana, uploadParts(Buffer.alloc(TEN_MIB, 0x61)));
      expect(exact.statusCode).toBe(201);
      expect(exact.json<{ file: { sizeBytes: number } }>().file.sizeBytes).toBe(TEN_MIB);
      const before = await filesUnder(root);

      const over = await upload(ana, uploadParts(Buffer.alloc(TEN_MIB + 1, 0x61)));

      expectRefusal(over, 413, "test_file_too_large", MESSAGES.tooLarge);
      expect(await fileRows()).toHaveLength(1);
      expect(await filesUnder(root)).toEqual(before);
    });

    it("answers an unauthenticated 10 MiB upload with 401, writing nothing", async () => {
      const ana = await member();
      const response = await upload({ organizationId: ana.organizationId }, uploadParts(Buffer.alloc(TEN_MIB, 0x61)));
      expectRefusal(response, 401, "unauthenticated", MESSAGES.unauthenticated);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    const data = Buffer.from("{}\n");
    const file = { name: "file", filename: "events.json", data };
    it.each<[string, Part[]]>([
      ["the file first", [file, { name: "displayName", value: "a" }, { name: "description", value: "" }]],
      ["the description before the name", [{ name: "description", value: "" }, { name: "displayName", value: "a" }, file]],
      ["no description", [{ name: "displayName", value: "a" }, file]],
      ["no file", [{ name: "displayName", value: "a" }, { name: "description", value: "" }]],
      ["a field after the file", [...uploadParts(data), { name: "extra", value: "x" }]],
      ["a second file", [...uploadParts(data), { name: "file", filename: "more.json", data }]],
      ["a misnamed file part", [{ name: "displayName", value: "a" }, { name: "description", value: "" }, { ...file, name: "upload" }]],
      ["the name as a file", [{ name: "displayName", filename: "a.json", data }, { name: "description", value: "" }, file]],
      ["an empty name", uploadParts(data, { displayName: "   " })],
      ["a 201-character name", uploadParts(data, { displayName: "a".repeat(201) })],
      ["a 2,001-character description", uploadParts(data, { description: "d".repeat(2_001) })],
      ["a field over 8 KiB", uploadParts(data, { description: "é".repeat(4_200) })],
      ["a 256-character file name", uploadParts(data, { filename: `${"f".repeat(251)}.json` })],
    ])("refuses %s with 400, leaving nothing behind", async (_label, parts) => {
      const ana = await member();
      const response = await upload(ana, parts);
      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("refuses a field over 8 KiB that trims to a valid one (busboy's fieldSize, not the contract's length): 9,000 spaces and an x is 400; 8,000 spaces and an x saves as x (D14b Ruling 36)", async () => {
      const ana = await member();

      const over = await upload(ana, uploadParts(data, { description: `${" ".repeat(9_000)}x` }));

      expectRefusal(over, 400, "invalid_request", MESSAGES.invalid);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      // The control: under 8 KiB, the same value trims to a valid description.
      await uploaded(ana, data, { description: `${" ".repeat(8_000)}x` });
      expect((await fileRows()).map((row) => row.description)).toEqual(["x"]);
    });

    it("answers a refusal over a real connection, and the connection serves the next request", async () => {
      const ana = await member();
      const listening = await serverWith();
      await listening.listen({ port: 0, host: "127.0.0.1" });
      const { port } = listening.server.address() as AddressInfo;
      // One kept-alive connection for every request: a body left unread would hold it.
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const send = (method: string, path: string, body: Buffer | undefined, headers: Record<string, string>) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method,
              path,
              agent,
              headers: { ...headers, ...(body === undefined ? {} : { "content-length": String(body.length) }) },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () =>
                resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
              );
            },
          );
          request.on("error", reject);
          request.end(body);
        });
      const sendUpload = (parts: Part[], cookie?: string) => {
        const { payload, headers } = multipartBody(parts);
        return send("POST", filesPath(ana.organizationId), payload, {
          ...csrfHeaders,
          ...headers,
          ...(cookie === undefined ? {} : { cookie }),
        });
      };
      const cookie = `telflo_access=${ana.access}`;
      const bigFile = { name: "file", filename: "events.json", data: Buffer.alloc(5 * MIB, 0x61) };

      try {
        const outOfOrder = await sendUpload([bigFile, { name: "displayName", value: "a" }, { name: "description", value: "" }], cookie);
        const tooLarge = await sendUpload([...uploadParts(Buffer.alloc(TEN_MIB + 1, 0x61)), { name: "extra", value: "x" }], cookie);
        const unauthenticated = await sendUpload(uploadParts(Buffer.alloc(TEN_MIB, 0x61)));
        const next = await send("GET", filesPath(ana.organizationId), undefined, { cookie });

        expect(outOfOrder.status).toBe(400);
        expect(JSON.parse(outOfOrder.body)).toEqual({ error: { code: "invalid_request", message: MESSAGES.invalid } });
        expect(tooLarge.status).toBe(413);
        expect(unauthenticated.status).toBe(401);
        expect(next.status).toBe(200);
        expect(JSON.parse(next.body)).toEqual({ files: [] });
        expect(await filesUnder(root)).toEqual([]);
      } finally {
        agent.destroy();
      }
    });

    it("an upload the client aborts inside the file: 400, nothing kept, one warning without the error's text (Ruling 39)", async () => {
      const ana = await member();
      // The client is gone, so the answer is read where the server makes it: the error it answers with.
      const answered: Array<{ statusCode: unknown; code: unknown }> = [];
      const listening = await serverWith({
        beforeReady: (built) =>
          built.addHook("onError", async (_request, _reply, error) => {
            const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
            answered.push({ statusCode, code });
          }),
      });
      await listening.listen({ port: 0, host: "127.0.0.1" });
      const { port } = listening.server.address() as AddressInfo;
      const { payload, headers } = multipartBody(uploadParts(Buffer.alloc(4 * MIB, 0x61)));
      let writing = (): void => undefined;
      const isWriting = new Promise<void>((resolve) => {
        writing = resolve;
      });
      onWrite = writing;
      // Only this request's lines from here (each server numbers its requests from 1).
      logLines = [];

      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: filesPath(ana.organizationId),
        headers: { ...csrfHeaders, ...headers, cookie: `telflo_access=${ana.access}`, "content-length": String(payload.length) },
      });
      request.on("error", () => undefined);
      // The parts and the first MiB of the file, then the connection goes.
      request.write(payload.subarray(0, MIB));
      await isWriting;
      request.destroy();

      while (answered.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(answered).toEqual([{ statusCode: 400, code: "invalid_request" }]);
      // Its removal is done once the warning is logged.
      const warning = "an upload broke off before its end; nothing was kept";
      while (!logLines.some((line) => line.includes(warning))) await new Promise((resolve) => setTimeout(resolve, 5));
      const parsed = logLines.map((line) => JSON.parse(line) as { level: number; msg: string });
      expect(parsed.filter((line) => line.level >= 50)).toEqual([]);
      expect(parsed.filter((line) => line.msg === "an upload broke off before its end; nothing was kept")).toHaveLength(1);
      // The warning carries nothing of the error (Node's own trace-level client-error line aside).
      const warned = parsed.find((line) => line.msg === warning) as Record<string, unknown>;
      expect(Object.keys(warned).sort()).toEqual(["hostname", "level", "msg", "pid", "time"]);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("refuses a body that isn't multipart with 400", async () => {
      const ana = await member();
      const response = await server.inject({
        method: "POST",
        url: filesPath(ana.organizationId),
        headers: csrfHeaders,
        cookies: { telflo_access: ana.access },
        payload: { displayName: "a", description: "", file: "{}" },
      });
      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(await fileRows()).toEqual([]);
    });

    it("answers another organization's path with 404, writing nothing", async () => {
      const { ana, cara } = await team();
      const response = await upload(ana, uploadParts(data), { organizationId: cara.organizationId });
      expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("refuses a removed member's upload (their session's own check, 401) before reading the body", async () => {
      const { ana, ben } = await team();
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: new Date() })
        .where("user_id", "=", ben.userId)
        .where("organization_id", "=", ana.organizationId)
        .execute();
      const response = await upload(ben, uploadParts(data));
      expect(response.statusCode).toBe(401);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("removes the bytes when the row can't be saved", async () => {
      const ana = await member();
      await withFailingInsert(ownerDb, "test_input_files", "raise exception 'refused for the test'", async () => {
        const response = await upload(ana, uploadParts(data));
        expect(response.statusCode).toBe(500);
      });
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("limits a person to 30 uploads and samples a minute (RATE_LIMITS), writing nothing for the 31st", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      for (let index = 0; index < 30; index += 1) {
        const isSample = index % 2 === 1;
        const parts = uploadParts(data, isSample ? { contentType: "application/json" } : {});
        const response = await upload(ana, parts, { on: limited, sample: isSample });
        expect(response.statusCode).toBe(201);
      }
      const written = await filesUnder(root);

      const response = await upload(ana, uploadParts(data), { on: limited });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: { code: "rate_limited", message: MESSAGES.uploadsLimited } });
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(await filesUnder(root)).toEqual(written);
      // Another person's are their own.
      const ben = await member();
      expect((await upload(ben, uploadParts(data), { on: limited })).statusCode).toBe(201);
    });
  });

  describe("samples (POST /test-files/samples)", () => {
    const sample = (displayName: string, text: string | Buffer, contentType = "application/json"): Part[] => [
      { name: "displayName", value: displayName },
      { name: "description", value: "" },
      { name: "file", filename: "sample", data: Buffer.isBuffer(text) ? text : Buffer.from(text), contentType },
    ];

    it.each([
      ["a JSON sample without an extension", "otlp sample", "application/json", "otlp sample.json", "application/json"],
      ["a raw sample without an extension", "app lines", "text/plain", "app lines.log", "text/plain"],
      ["a name that has an extension", "events.ndjson", "application/json", "events.ndjson", "application/x-ndjson"],
    ])("names %s from its display name and type", async (_label, displayName, partType, fileName, contentType) => {
      const ana = await member();
      const response = await upload(ana, sample(displayName, '{"a":1}', partType), { sample: true });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ file: Record<string, unknown> }>().file).toMatchObject({ displayName, fileName, contentType });
    });

    it("refuses a name whose own extension isn't one of the six with 415, writing nothing", async () => {
      const ana = await member();
      const response = await upload(ana, sample("events.csv", "a,b"), { sample: true });
      expectRefusal(response, 415, "test_file_type_unsupported", MESSAGES.typeUnsupported);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("refuses a file part of another type with 400", async () => {
      const ana = await member();
      const response = await upload(ana, sample("lines", "x", "application/octet-stream"), { sample: true });
      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("accepts exactly 1 MiB, and refuses 1 MiB + 1 with 413, leaving no file and no row", async () => {
      const ana = await member();
      expect((await upload(ana, sample("big", Buffer.alloc(MIB, 0x61)), { sample: true })).statusCode).toBe(201);
      const before = await filesUnder(root);

      const over = await upload(ana, sample("bigger", Buffer.alloc(MIB + 1, 0x61)), { sample: true });

      expectRefusal(over, 413, "test_file_too_large", MESSAGES.sampleTooLarge);
      expect(await fileRows()).toHaveLength(1);
      expect(await filesUnder(root)).toEqual(before);
    });
  });

  describe("My Files (GET and DELETE /test-files)", () => {
    it("lists only the person's own files in this organization, newest first", async () => {
      const { ana, ben } = await team();
      const first = await uploaded(ana);
      const second = await uploaded(ana);
      await uploaded(ben);
      // Ana's file in her personal organization is that organization's.
      const personal = await createUserWithOrganization(ownerDb);
      void personal;

      const response = await read(ana, filesPath(ana.organizationId));

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ files: Array<{ id: string }> }>().files.map((file) => file.id)).toEqual([second.id, first.id]);
      expectRefusal(await read(ana, filesPath(ana.personalOrganizationId)), 404, "organization_not_found", MESSAGES.organizationNotFound);
    });

    it("deletes the person's own file: the row, then the bytes", async () => {
      const ana = await member();
      const file = await uploaded(ana);

      const response = await server.inject({
        method: "DELETE",
        url: `${filesPath(ana.organizationId)}/${file.id}`,
        headers: csrfHeaders,
        cookies: { telflo_access: ana.access },
      });

      expect(response.statusCode).toBe(204);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("answers a teammate's, an unknown and a malformed file id with 404, deleting nothing", async () => {
      const { ana, ben } = await team();
      const file = await uploaded(ana);
      for (const id of [file.id, randomUUID(), "not-a-uuid"]) {
        const response = await server.inject({
          method: "DELETE",
          url: `${filesPath(ben.organizationId)}/${id}`,
          headers: csrfHeaders,
          cookies: { telflo_access: ben.access },
        });
        expectRefusal(response, 404, "test_file_not_found", MESSAGES.fileNotFound);
      }
      expect(await fileRows()).toHaveLength(1);
      expect(await filesUnder(root)).toHaveLength(1);
    });
  });

  describe("a file's head (GET /test-files/:fileId/head, Ruling 43)", () => {
    const headPath = (organizationId: string, fileId: string) => `${filesPath(organizationId)}/${fileId}/head`;

    it("answers the first 64 KiB of the owner's larger file, as bytes, never sniffed, under no name, never cached", async () => {
      const ana = await member();
      const data = Buffer.alloc(3 * 65_536 + 7);
      for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
      const file = await uploaded(ana, data);

      const response = await read(ana, headPath(ana.organizationId, file.id));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data.subarray(0, 65_536));
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-disposition": "attachment",
        "content-length": "65536",
      });
      expect(JSON.stringify(response.headers)).not.toContain(NAME_MARKER);
      expect(readStreams.every((stream) => stream.destroyed)).toBe(true);
    });

    it("answers a smaller file whole", async () => {
      const ana = await member();
      const data = Buffer.from('{"resourceLogs":[{"small":true}]}\n');
      const file = await uploaded(ana, data);
      const response = await read(ana, headPath(ana.organizationId, file.id));
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers["content-length"]).toBe(String(data.length));
    });

    it("is 404 to a teammate, from another organization, and for an unknown or malformed id", async () => {
      const { ana, ben, cara } = await team();
      const file = await uploaded(ana);
      for (const id of [file.id, randomUUID(), "not-a-uuid"]) {
        expectRefusal(await read(ben, headPath(ben.organizationId, id)), 404, "test_file_not_found", MESSAGES.fileNotFound);
      }
      expectRefusal(await read(cara, headPath(cara.organizationId, file.id)), 404, "test_file_not_found", MESSAGES.fileNotFound);
      expectRefusal(await read(cara, headPath(ana.organizationId, file.id)), 404, "organization_not_found", MESSAGES.organizationNotFound);
    });

    it("is 404 once the file's bytes are gone", async () => {
      const ana = await member();
      const file = await uploaded(ana);
      await rm(join(root, inputKeyPath(ana.organizationId, ana.userId, file.id)));
      expectRefusal(await read(ana, headPath(ana.organizationId, file.id)), 404, "test_file_not_found", MESSAGES.fileNotFound);
    });

    it("is 404 once the file's row is gone, though its bytes are still on disk (Ruling 45)", async () => {
      const ana = await member();
      const file = await uploaded(ana);
      await ownerDb.deleteFrom("test_input_files").where("id", "=", file.id).execute();
      expect(await filesUnder(root)).toContain(inputKeyPath(ana.organizationId, ana.userId, file.id));

      expectRefusal(await read(ana, headPath(ana.organizationId, file.id)), 404, "test_file_not_found", MESSAGES.fileNotFound);
      expect(readStreams).toEqual([]);
    });

    it("needs a session, and counts with the uploads (RATE_LIMITS: 30 a minute)", async () => {
      const ana = await member();
      const file = await uploaded(ana);
      expect((await server.inject({ method: "GET", url: headPath(ana.organizationId, file.id) })).statusCode).toBe(401);

      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      for (let index = 0; index < 30; index += 1) {
        expect((await read(ana, headPath(ana.organizationId, file.id), { on: limited })).statusCode).toBe(200);
      }
      expect((await read(ana, headPath(ana.organizationId, file.id), { on: limited })).statusCode).toBe(429);
    });
  });

  describe("queuing a run (POST …/test-runs)", () => {
    it("copies the input into the run's folder and saves the queued run with its snapshot and an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.from('{"resourceLogs":[]}\n');
      const file = await uploaded(ana, data);

      const response = await queue(ana, target, queueBody({ inputFileId: file.id }));

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { run } = response.json<{ run: Record<string, unknown> & { id: string } }>();
      expect(run).toEqual({
        id: expect.any(String),
        status: "queued",
        queuedAt: expect.any(String),
        startedAt: null,
        finishedAt: null,
        ahead: 0,
        pipeline: "logs",
        signal: "logs",
        durationSeconds: 5,
        collectorVersion: contribDefault,
        queuedByUserId: ana.userId,
        inputName: file.fileName,
        errorCode: null,
        suiteId: null,
        suiteName: null,
        definitionId: null,
        definitionName: null,
        configurationId: target.configurationId,
        versionId: target.versionId,
        sourceRunId: null,
        yaml: RUN_TEXT,
        collectorDistribution: CONTRIB,
        inputSizeBytes: data.length,
        inputContentType: "application/json",
        strategy: null,
        kwokEnabled: null,
        mutatedYaml: null,
        mutations: null,
        compatibility: null,
        logs: null,
        timings: null,
        errorMessage: null,
        outputSizeBytes: null,
        outputTruncated: null,
        decodedInputSizeBytes: null,
        decodedInputTruncated: null,
        // No validation pipeline for the run's pipeline: no rules (D15a decision 14).
        validationRules: [],
        validationResults: null,
      });
      expect(await readFile(join(root, runFilePath(ana.organizationId, run.id, "input")))).toEqual(data);
      expect(wakes).toBe(1);

      const audits = await ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "test_run.queued").execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        organization_id: ana.organizationId,
        actor_user_id: ana.userId,
        subject_type: "test_run",
        subject_id: run.id,
        metadata: { configurationId: target.configurationId, versionId: target.versionId, inputFileId: file.id },
      });
      // No name and no text: ids only (decision 23).
      const audited = JSON.stringify(audits[0]);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, TEXT_MARKER, "logs"]) {
        expect(audited).not.toContain(marker);
      }
    });

    it("refuses an unknown pin with 400 collector_version_unknown, and a retired one with D13b's words", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);

      expectRefusal(
        await queue(ana, target, queueBody({ inputFileId: file.id }, { collectorVersion: "9.9.9" })),
        400,
        "collector_version_unknown",
        MESSAGES.versionUnknown,
      );
      expectRefusal(
        await queue(ana, target, queueBody({ inputFileId: file.id }, { collectorVersion: RETIRED })),
        400,
        "collector_version_retired",
        COLLECTOR_VERSION_RETIRED_MESSAGE,
      );
      expect(await runRows()).toEqual([]);
    });

    it("checks the pin before the limits: a retired pin is 400 even while the tester is down", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      await markTesterDown();

      expectRefusal(
        await queue(ana, target, queueBody({ inputFileId: file.id }, { collectorVersion: RETIRED })),
        400,
        "collector_version_retired",
        COLLECTOR_VERSION_RETIRED_MESSAGE,
      );
    });

    it("refuses at once while the tester is down (503), queuing and copying nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const before = await filesUnder(root);
      await markTesterDown();

      const response = await queue(ana, target, queueBody({ inputFileId: file.id }));

      expectRefusal(response, 503, "testing_unavailable", TESTING_UNAVAILABLE_MESSAGE);
      expect(await runRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual(before);
      expect(wakes).toBe(0);
    });

    it("refuses a teammate's file id, an unknown one and another organization's with 404 test_file_not_found", async () => {
      const { ana, ben, cara } = await team();
      const target = await configurationOf(ben);
      const anas = await uploaded(ana);
      const caras = await uploaded(cara);
      for (const inputFileId of [anas.id, caras.id, randomUUID()]) {
        expectRefusal(
          await queue(ben, target, queueBody({ inputFileId })),
          404,
          "test_file_not_found",
          MESSAGES.fileNotFound,
        );
      }
      expect(await runRows()).toEqual([]);
    });

    it("lets a teammate re-run a published configuration's run, copying its input; the name travels with it", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const data = Buffer.from("line one\nline two\n");
      const file = await uploaded(ana, data, { filename: "app.log" });
      const original = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      const response = await queue(ben, target, queueBody({ sourceRunId: original.id }, { durationSeconds: 7 }));

      expect(response.statusCode).toBe(201);
      const { run } = response.json<{ run: { id: string; sourceRunId: string; inputName: string; inputSizeBytes: number; queuedByUserId: string } }>();
      expect(run).toMatchObject({
        sourceRunId: original.id,
        inputName: "app.log",
        inputSizeBytes: data.length,
        queuedByUserId: ben.userId,
      });
      expect(await readFile(join(root, runFilePath(ana.organizationId, run.id, "input")))).toEqual(data);
      const [audit] = await ownerDb
        .selectFrom("audit_events")
        .select("metadata")
        .where("action", "=", "test_run.queued")
        .where("subject_id", "=", run.id)
        .execute();
      expect(audit?.metadata).toEqual({ configurationId: target.configurationId, versionId: target.versionId, sourceRunId: original.id });
    });

    it("refuses a re-run of another member's draft's run by its id, as if it didn't exist", async () => {
      const { ana, ben } = await team();
      const anasDraft = await configurationOf(ana);
      const file = await uploaded(ana);
      const original = (await queue(ana, anasDraft, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      const bensOwn = await configurationOf(ben);

      expectRefusal(
        await queue(ben, bensOwn, queueBody({ sourceRunId: original.id })),
        404,
        "test_run_not_found",
        MESSAGES.runNotFound,
      );
      expect(await runRows()).toHaveLength(1);
    });

    it("refuses a re-run whose source's input is gone, leaving no row and no file of its own", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const source = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
      });

      expectRefusal(
        await queue(ana, target, queueBody({ sourceRunId: source.id })),
        404,
        "test_run_not_found",
        MESSAGES.runNotFound,
      );
      expect(await runRows()).toHaveLength(1);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("hides a draft from a teammate (404) until it is published, then queues their run", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const file = await uploaded(ben);

      expectRefusal(
        await queue(ben, target, queueBody({ inputFileId: file.id })),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: target.organizationId,
        version_number: 2,
        publishedAt: new Date(),
      });
      expect((await queue(ben, target, queueBody({ inputFileId: file.id }))).statusCode).toBe(201);
    });

    it("answers another organization, a deleted configuration and another configuration's version with 404", async () => {
      const { ana, cara } = await team();
      const target = await configurationOf(ana);
      const other = await configurationOf(ana);
      const file = await uploaded(ana);
      const body = queueBody({ inputFileId: file.id });

      expectRefusal(
        await queue(ana, target, body, { organizationId: cara.organizationId }),
        404,
        "organization_not_found",
        MESSAGES.organizationNotFound,
      );
      expectRefusal(
        await queue(ana, { ...target, versionId: other.versionId }, body),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", target.configurationId).execute();
      expectRefusal(await queue(ana, target, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      expect(await runRows()).toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ["both inputs", { sourceRunId: randomUUID() }],
      ["no input", { inputFileId: undefined }],
      ["a pipeline of another signal", { pipeline: "traces" }],
      ["a duration of 0", { durationSeconds: 0 }],
      ["a duration of 61", { durationSeconds: 61 }],
      ["empty text", { yaml: "" }],
      ["text over 262,144 characters", { yaml: "a".repeat(262_145) }],
      ["an unknown field", { distribution: "otelcol-contrib" }],
      // D14b Preflight ruling 9: a request mixing the union's branches fails both.
      ["a definition beside the file", { definitionId: randomUUID() }],
      ["a template beside the file", { templateId: randomUUID() }],
    ])("refuses %s with 400", async (_label, overrides) => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const response = await queue(ana, target, queueBody({ inputFileId: file.id }, overrides));
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_request");
      expect(await runRows()).toEqual([]);
    });

    it("limits a person to 20 runs a minute (RATE_LIMITS), copying nothing for the 21st", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      const written = await filesUnder(root);

      const response = await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited });

      expectRefusal(response, 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(await runRows()).toHaveLength(20);
      expect(await filesUnder(root)).toEqual(written);
    });

    it("five queued at once with 49 waiting: exactly one 201 and four test_run_queue_full, one run folder (the person's lock; four copy at once, D14b Ruling 33)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      for (let index = 0; index < 49; index += 1) {
        await addTestRun(ownerDb, {
          organizationId: ana.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: ana.userId,
        });
      }
      const file = await uploaded(ana);
      // The four copies that hold a place end together, so their
      // transactions run at once; the fifth waits for a place, then counts
      // a full queue before any copy (D14b Ruling 33).
      let open = (): void => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      copyBarrier = { remaining: 4, opened, open };

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => queue(ana, target, queueBody({ inputFileId: file.id }))),
      );

      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 429, 429, 429, 429]);
      for (const response of responses.filter((each) => each.statusCode === 429)) {
        expectRefusal(response, 429, "test_run_queue_full", MESSAGES.queueFull);
      }
      const runFolders = new Set(
        (await filesUnder(root))
          .filter((path) => path.startsWith(join("organizations", ana.organizationId, "test-runs")))
          .map((path) => path.split("/")[3]),
      );
      expect(runFolders.size).toBe(1);
      expect((await runRows()).filter((run) => run.status === "queued")).toHaveLength(50);
    });

    it("refusals before the copy don't spend the minute: a full queue, a missing source input (Rulings 39, 42)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);

      // A full queue, 21 times: never test_run_rate_limited.
      const seeded: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        const run = await addTestRun(ownerDb, {
          organizationId: ana.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: ana.userId,
        });
        seeded.push(run.id);
      }
      for (let index = 0; index < 21; index += 1) {
        expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_queue_full", MESSAGES.queueFull);
      }
      await ownerDb.deleteFrom("test_runs").where("id", "in", seeded).execute();

      // A re-run of a visible run whose input is gone, 21 times: 404.
      const source = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        state: finishedState(),
      });
      for (let index = 0; index < 21; index += 1) {
        expectRefusal(await queue(ana, target, queueBody({ sourceRunId: source.id }), { on: limited }), 404, "test_run_not_found", MESSAGES.runNotFound);
      }

      // The minute is whole: 20 queue, the 21st is limited.
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
    });

    it("a text too long once organization variables are filled in is refused 400 filled_in_too_long before the copy and doesn't spend the minute (Rulings 42, 45; D20 Preflight ruling 28, Ruling 78)", async () => {
      // A source whose value makes the text too long only once filled in.
      const limited = await serverWith({
        rateLimits: RATE_LIMITS,
        organizationVariables: {
          read: async () => ({ kind: "values", values: new Map([["LONG", "x".repeat(TEST_RUN_YAML_MAXIMUM_LENGTH)]]) }),
        },
      });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const yaml = `${RUN_TEXT}# long: \${org:LONG}\n`;
      expect(yaml.length).toBeLessThanOrEqual(TEST_RUN_YAML_MAXIMUM_LENGTH);

      for (let index = 0; index < 21; index += 1) {
        expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }, { yaml }), { on: limited }), 400, "filled_in_too_long", MESSAGES.filledInTooLong);
      }
      expect(copiesBegun).toBe(0);
      expect(await runRows()).toEqual([]);

      // The minute is whole: 20 queue, the 21st is limited.
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
    });

    it("values that can't be read refuse the queue 503 variables_unavailable before the copy, and don't spend the minute (D20 Preflight ruling 28)", async () => {
      const limited = await serverWith({
        rateLimits: RATE_LIMITS,
        organizationVariables: { read: async () => ({ kind: "unavailable", reason: "network" }) },
      });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const yaml = `${RUN_TEXT}# endpoint: \${org:ENDPOINT}\n`;

      for (let index = 0; index < 21; index += 1) {
        expectRefusal(
          await queue(ana, target, queueBody({ inputFileId: file.id }, { yaml }), { on: limited }),
          503,
          "variables_unavailable",
          MESSAGES.variablesUnavailable,
        );
      }
      expect(copiesBegun).toBe(0);
      expect(await runRows()).toEqual([]);
      expect(wakes).toBe(0);

      // The minute is whole: 20 queue (a text with no reference reads nothing), the 21st is limited.
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
    });

    it("a copy that began spends the minute, even when it fails: 20 failed copies, then the 21st is limited (Ruling 42)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      isCopyFailing = true;
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(500);
      }
      isCopyFailing = false;
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expect(copiesBegun).toBe(20);
    });

    it("bursts at a nearly full queue copy at most 20 inputs a minute: 4 rounds of 20 at once with 49 waiting (Ruling 42)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      for (let index = 0; index < 49; index += 1) {
        await addTestRun(ownerDb, {
          organizationId: ana.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: ana.userId,
        });
      }
      const file = await uploaded(ana);
      const statuses: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        // All twenty pass the first count of waiting runs together; the
        // re-check after the copy lets one through.
        const responses = await Promise.all(
          Array.from({ length: 20 }, () => queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })),
        );
        statuses.push(...responses.map((response) => response.statusCode));
        // One waiting run removed: 49 wait again.
        const [newest] = await ownerDb
          .selectFrom("test_runs")
          .select("id")
          .where("status", "=", "queued")
          .orderBy("queued_at", "desc")
          .limit(1)
          .execute();
        await ownerDb.deleteFrom("test_runs").where("id", "=", newest!.id).execute();
      }
      expect(copiesBegun).toBeLessThanOrEqual(20);
      expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((status) => status === 201 || status === 429)).toBe(true);
    });

    it("refuses a 51st waiting run, counting the person's waiting runs in this organization only (D14b Preflight ruling 21)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const personal = await addConfiguration(ownerDb, {
        organizationId: ana.personalOrganizationId,
        created_by_user_id: ana.userId,
      });
      const personalVersion = await addConfigurationVersion(ownerDb, {
        configurationId: personal.id,
        organizationId: ana.personalOrganizationId,
      });
      const seed = (organizationId: string, configurationId: string, versionId: string) =>
        addTestRun(ownerDb, { organizationId, configurationId, configurationVersionId: versionId, queuedByUserId: ana.userId });
      for (let index = 0; index < 49; index += 1) await seed(ana.organizationId, target.configurationId, target.versionId);
      // Her runs waiting in another organization don't count here: the cap is per person, per organization.
      for (let index = 0; index < 30; index += 1) await seed(ana.personalOrganizationId, personal.id, personalVersion.id);
      // A finished run doesn't wait.
      await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        state: finishedState(),
      });
      const file = await uploaded(ana);

      // The 50th waiting run is accepted…
      expect((await queue(ana, target, queueBody({ inputFileId: file.id }))).statusCode).toBe(201);
      const written = await filesUnder(root);
      // …and the 51st refused, nothing copied.
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id })), 429, "test_run_queue_full", MESSAGES.queueFull);
      expect(await filesUnder(root)).toEqual(written);
    });

    /** A server reading the organization's values from this file's fake opamp-server, as index.ts wires it; each read counted. */
    const withOpampVariables = async () => {
      const reads: string[] = [];
      const real = opampOrganizationVariables(opamp.client);
      const built = await serverWith({
        organizationVariables: {
          read: (organizationId) => {
            reads.push(organizationId);
            return real.read(organizationId);
          },
        },
      });
      return { server: built, reads };
    };

    /** The organization registered in the fake opamp-server, holding `name` = `value`. */
    const defineVariable = async (person: Person, name: string, value: string) => {
      const registered = await opamp.client.createOrganization({ id: person.organizationId, name: "Variables" });
      expect(["created", "unchanged"]).toContain(registered.kind);
      const created = await opamp.client.createVariable(person.organizationId, {
        id: randomUUID(),
        name,
        value,
        description: null,
        actor: { id: person.userId, email: person.email },
      });
      expect(created.kind).toBe("created");
    };

    it("POST and GET hold ${org:NAME}: a run, a re-run and a definition's Play are saved and returned as written, each queue reading the organization's values (D20 decision 13)", async () => {
      const { server: withVariables, reads } = await withOpampVariables();
      const ana = await member();
      await defineVariable(ana, "PROD_OTLP", `https://${VALUE_MARKER}:4318/$1`);
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const yaml = `${RUN_TEXT}# a: \${org:PROD_OTLP}\n# b: $\${org:PROD_OTLP}\n`;

      const first = await queue(ana, target, queueBody({ inputFileId: file.id }, { yaml }), { on: withVariables });
      expect(first.statusCode).toBe(201);
      const firstRun = first.json<{ run: { id: string; yaml: string } }>().run;
      const rerun = await queue(ana, target, queueBody({ sourceRunId: firstRun.id }, { yaml }), { on: withVariables });
      expect(rerun.statusCode).toBe(201);
      const played = await queue(ana, target, definitionRunBody(definition.id, { yaml }), { on: withVariables });
      expect(played.statusCode).toBe(201);

      for (const response of [first, rerun, played]) {
        const { run } = response.json<{ run: { id: string; yaml: string } }>();
        expect(run.yaml).toBe(yaml);
        const detail = await read(ana, `${runsPath(target)}/${run.id}`, { on: withVariables });
        expect(detail.json<{ run: { yaml: string } }>().run.yaml).toBe(yaml);
      }
      expect((await runRows()).map((run) => run.yaml)).toEqual([yaml, yaml, yaml]);
      expect(reads).toEqual([ana.organizationId, ana.organizationId, ana.organizationId]);

      // The value is configuration text: in no log line and no audit row.
      expect(logLines.filter((line) => line.includes(VALUE_MARKER))).toEqual([]);
      const audits = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(JSON.stringify(audits)).not.toContain(VALUE_MARKER);
    });

    it("a text with no live ${org:NAME} reads no values: an escaped reference, the legacy form and a default's form are plain text", async () => {
      const { server: withVariables, reads } = await withOpampVariables();
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const yaml = `${RUN_TEXT}# a: $\${org:X}\n# b: $orgvar:X\n# c: \${org:X:-y}\n`;

      const response = await queue(ana, target, queueBody({ inputFileId: file.id }, { yaml }), { on: withVariables });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ run: { yaml: string } }>().run.yaml).toBe(yaml);
      expect(reads).toEqual([]);
    });

    it("the opamp-server unreachable: 503 variables_unavailable, nothing queued, logged with ids and the reason only; a definition's Play alike", async () => {
      const { server: withVariables } = await withOpampVariables();
      const ana = await member();
      await defineVariable(ana, "PROD_OTLP", VALUE_MARKER);
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const yaml = `${RUN_TEXT}# a: \${org:PROD_OTLP}\n`;
      const copiesBefore = copiesBegun;

      opamp.fake.nextFault("error_500", "listVariables");
      expectRefusal(
        await queue(ana, target, queueBody({ inputFileId: file.id }, { yaml }), { on: withVariables }),
        503,
        "variables_unavailable",
        MESSAGES.variablesUnavailable,
      );
      opamp.fake.nextFault("error_500", "listVariables");
      expectRefusal(
        await queue(ana, target, definitionRunBody(definition.id, { yaml }), { on: withVariables }),
        503,
        "variables_unavailable",
        MESSAGES.variablesUnavailable,
      );

      expect(copiesBegun).toBe(copiesBefore);
      expect(await runRows()).toEqual([]);
      expect(wakes).toBe(0);
      const warned = logLines.filter((line) => line.includes("the organization's variables couldn't be read"));
      expect(warned).toHaveLength(2);
      for (const line of warned) {
        expect(JSON.parse(line)).toMatchObject({ organizationId: ana.organizationId, reason: "server_error" });
      }
      expect(logLines.filter((line) => line.includes(VALUE_MARKER) || line.includes("PROD_OTLP"))).toEqual([]);
    });

    it("removes the run's files when its row can't be saved", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const before = await filesUnder(root);

      await withFailingInsert(ownerDb, "test_runs", "raise exception 'refused for the test'", async () => {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }))).statusCode).toBe(500);
      });

      expect(await runRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual(before);
      expect(wakes).toBe(0);
    });
  });

  describe("runs from a definition or a template (D14b decisions 6, 7, 11 and 13; Preflight rulings 10, 20 to 22)", () => {
    /**
     * A hang guard only (D14b Ruling 41): the tests that queue 45 to 70
     * runs one after another take 3–4 s, close to vitest's 5 s default
     * under a concurrent run; each ends on its last request.
     */
    const MANY_RUNS_TIMEOUT = 60_000;
    const definitionAudits = () =>
      ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "test_run.queued").orderBy("occurred_at").execute();

    it("queues a definition's run: the definition's input bytes, pipeline, signal and duration, its breadcrumb in the detail and the list, and an audit row naming the definition and its suite", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.from('{"resourceLogs":[{"definition":true}]}\n');
      const file = await uploaded(ana, data);
      const { suite, definition, inputId } = await definitionOf(ana, target, { inputFileId: file.id });
      // Her My Files file goes: the definition keeps its own copy (decision 1), which the run copies.
      expect((await server.inject({ method: "DELETE", url: `${filesPath(ana.organizationId)}/${file.id}`, headers: csrfHeaders, cookies: { telflo_access: ana.access } })).statusCode).toBe(204);
      const copiesBefore = copiesBegun;

      const response = await queue(ana, target, definitionRunBody(definition.id));

      expect(response.statusCode).toBe(201);
      const { run } = response.json<{ run: Record<string, unknown> & { id: string } }>();
      expect(run).toMatchObject({
        status: "queued",
        pipeline: "logs/app",
        signal: "logs",
        durationSeconds: 7,
        inputName: file.fileName,
        inputSizeBytes: data.length,
        sourceRunId: null,
        suiteId: suite.id,
        suiteName: suite.name,
        definitionId: definition.id,
        definitionName: definition.name,
      });
      // Its input is the definition's copy, copied once more into the run's folder.
      expect(copiesBegun - copiesBefore).toBe(1);
      expect(await readFile(join(root, runFilePath(ana.organizationId, run.id, "input")))).toEqual(data);
      expect(await readFile(join(root, "organizations", ana.organizationId, "test-definition-inputs", inputId))).toEqual(data);
      expect(wakes).toBe(1);

      // The detail and the list carry the breadcrumb (Preflight ruling 20).
      const detail = (await read(ana, `${runsPath(target)}/${run.id}`)).json<{ run: Record<string, unknown> }>().run;
      const [listed] = (await read(ana, runsPath(target))).json<{ runs: Array<Record<string, unknown>> }>().runs;
      const breadcrumb = { suiteId: suite.id, suiteName: suite.name, definitionId: definition.id, definitionName: definition.name };
      expect(detail).toMatchObject(breadcrumb);
      expect(listed).toMatchObject(breadcrumb);

      // The snapshot outlives a rename: the run keeps the names it was queued with.
      expect((await server.inject({ method: "PATCH", url: `${suitesPath(target)}/${suite.id}`, headers: csrfHeaders, cookies: { telflo_access: ana.access }, payload: { name: "Renamed" } })).statusCode).toBe(200);
      expect((await read(ana, `${runsPath(target)}/${run.id}`)).json<{ run: Record<string, unknown> }>().run).toMatchObject(breadcrumb);

      // Ids only: exactly the definition and its suite (Preflight ruling 10).
      const audits = await definitionAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toEqual({
        configurationId: target.configurationId,
        versionId: target.versionId,
        definitionId: definition.id,
        suiteId: suite.id,
      });
      const audited = JSON.stringify(audits);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, TEXT_MARKER, file.fileName, "logs/app"]) {
        expect(audited).not.toContain(marker);
      }
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, TEXT_MARKER]) {
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }
    });

    it("queues a template's run: the template's bytes copied under its file name, the request's pipeline, no breadcrumb, an audit row naming the template; deleting the template later keeps the run's input", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.from('{"resourceLogs":[{"template":true}]}\n');
      const template = await templateWith(data);

      const response = await queue(ana, target, queueBody({ templateId: template.id }, { pipeline: "logs", durationSeconds: 9 }));

      expect(response.statusCode).toBe(201);
      const { run } = response.json<{ run: Record<string, unknown> & { id: string } }>();
      expect(run).toMatchObject({
        inputName: template.file_name,
        inputSizeBytes: data.length,
        inputContentType: "application/json",
        pipeline: "logs",
        durationSeconds: 9,
        sourceRunId: null,
        suiteId: null,
        suiteName: null,
        definitionId: null,
        definitionName: null,
      });
      expect(await readFile(join(root, runFilePath(ana.organizationId, run.id, "input")))).toEqual(data);
      const audits = await definitionAudits();
      expect(audits.map((audit) => audit.metadata)).toEqual([
        { configurationId: target.configurationId, versionId: target.versionId, templateId: template.id },
      ]);
      expect(JSON.stringify(audits)).not.toContain(NAME_MARKER);

      // A soft delete of the template, and its bytes gone: the run's own copy stays (decision 13).
      await ownerDb.updateTable("test_templates").set({ deleted_at: new Date() }).where("id", "=", template.id).execute();
      await store.remove({ kind: "test-template", templateId: template.id });
      expect(await readFile(join(root, runFilePath(ana.organizationId, run.id, "input")))).toEqual(data);
    });

    it("refuses a definition of another version, of another configuration, a deleted one, a teammate's draft's, an unknown, a nil and a malformed id with 404 test_definition_not_found, copying nothing", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const otherVersion = await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: target.organizationId,
        version_number: 2,
        collector_version: contribDefault,
      });
      const otherConfiguration = await configurationOf(ana, { published: true });
      const anasDraft = await configurationOf(ana);
      const bens = await configurationOf(ben);
      const file = await uploaded(ana);
      const onVersion1 = await definitionOf(ana, target, { inputFileId: file.id });
      const onOtherConfiguration = await definitionOf(ana, otherConfiguration, { inputFileId: file.id });
      const onDraft = await definitionOf(ana, anasDraft, { inputFileId: file.id });
      const deleted = await definitionOf(ana, target, { inputFileId: file.id });
      expect((await server.inject({ method: "DELETE", url: `${suitesPath(target)}/${deleted.suite.id}/definitions/${deleted.definition.id}`, headers: csrfHeaders, cookies: { telflo_access: ana.access } })).statusCode).toBe(204);
      const written = await filesUnder(root);
      const copiesBefore = copiesBegun;
      const onVersion2: Target = { ...target, versionId: otherVersion.id };

      for (const [person, where, definitionId] of [
        [ana, onVersion2, onVersion1.definition.id],
        [ana, target, onOtherConfiguration.definition.id],
        [ana, target, deleted.definition.id],
        [ben, bens, onDraft.definition.id],
        [ben, target, onDraft.definition.id],
        [ana, target, randomUUID()],
        [ana, target, "00000000-0000-0000-0000-000000000000"],
      ] as const) {
        expectRefusal(await queue(person, where, definitionRunBody(definitionId)), 404, "test_definition_not_found", MESSAGES.definitionNotFound);
      }
      // Not a UUID at all: the contract's 400, before anything is read.
      expectInvalid(await queue(ana, target, definitionRunBody("not-a-uuid")));

      expect(await runRows()).toEqual([]);
      expect(copiesBegun).toBe(copiesBefore);
      expect(await filesUnder(root)).toEqual(written);
      expect(wakes).toBe(0);
      // A teammate runs the published configuration's definition, made from Ana's file.
      expect((await queue(ben, target, definitionRunBody(onVersion1.definition.id))).statusCode).toBe(201);
    });

    it("refuses a deleted, an unknown and a nil template with 404 test_template_not_found, copying nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const deleted = await templateWith(Buffer.from("{}\n"));
      await ownerDb.updateTable("test_templates").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();
      const written = await filesUnder(root);

      for (const templateId of [deleted.id, randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
        expectRefusal(await queue(ana, target, queueBody({ templateId })), 404, "test_template_not_found", MESSAGES.templateNotFound);
      }

      expect(await runRows()).toEqual([]);
      expect(copiesBegun).toBe(0);
      expect(await filesUnder(root)).toEqual(written);
    });

    it("answers a definition or a template whose bytes are gone with its own 404 at the copy, keeping no row and no file", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition, inputId } = await definitionOf(ana, target, { inputFileId: file.id });
      const template = await templateWith(Buffer.from("{}\n"));
      await store.remove({ kind: "test-definition-input", organizationId: ana.organizationId, inputId });
      await store.remove({ kind: "test-template", templateId: template.id });
      const written = await filesUnder(root);

      expectRefusal(await queue(ana, target, definitionRunBody(definition.id)), 404, "test_definition_not_found", MESSAGES.definitionNotFound);
      expectRefusal(await queue(ana, target, queueBody({ templateId: template.id })), 404, "test_template_not_found", MESSAGES.templateNotFound);

      expect(await runRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual(written);
    });

    it("takes a definition's and a template's id in upper case as the same one (canonicalIdOf, Ruling 30)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const template = await templateWith(Buffer.from("{}\n"));

      const fromDefinition = await queue(ana, target, definitionRunBody(definition.id.toUpperCase()));
      const fromTemplate = await queue(ana, target, queueBody({ templateId: template.id.toUpperCase() }));

      expect(fromDefinition.statusCode).toBe(201);
      expect(fromDefinition.json<{ run: { definitionId: string } }>().run.definitionId).toBe(definition.id);
      expect(fromTemplate.statusCode).toBe(201);
      expect((await definitionAudits()).map((audit) => audit.metadata)).toEqual([
        expect.objectContaining({ definitionId: definition.id }),
        expect.objectContaining({ templateId: template.id }),
      ]);
    });

    it("a re-run of a definition's run copies its breadcrumb, even once the suite is deleted, and its audit row names the source run only", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { suite, definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const source = (await queue(ana, target, definitionRunBody(definition.id))).json<{ run: { id: string } }>().run;
      expect((await server.inject({ method: "DELETE", url: `${suitesPath(target)}/${suite.id}`, headers: csrfHeaders, cookies: { telflo_access: ana.access } })).statusCode).toBe(204);

      const response = await queue(ana, target, queueBody({ sourceRunId: source.id }, { pipeline: "logs", durationSeconds: 3 }));

      expect(response.statusCode).toBe(201);
      expect(response.json<{ run: Record<string, unknown> }>().run).toMatchObject({
        sourceRunId: source.id,
        pipeline: "logs",
        durationSeconds: 3,
        suiteId: suite.id,
        suiteName: suite.name,
        definitionId: definition.id,
        definitionName: definition.name,
      });
      expect((await definitionAudits()).at(-1)!.metadata).toEqual({
        configurationId: target.configurationId,
        versionId: target.versionId,
        sourceRunId: source.id,
      });
    });

    it("a re-run copies its source's breadcrumb only from a run of the path's configuration and version: another version's or another configuration's run gives none (D14b Ruling 34)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { suite, definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const source = (await queue(ana, target, definitionRunBody(definition.id))).json<{ run: { id: string } }>().run;
      // The same configuration's version 2, and another configuration of hers, published.
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: ana.organizationId,
        collector_version: contribDefault,
        version_number: 2,
      });
      const otherVersion: Target = { ...target, versionId: second.id };
      const otherConfiguration = await configurationOf(ana, { published: true });
      const breadcrumbOf = (response: LightMyRequestResponse) => {
        expect(response.statusCode).toBe(201);
        const { suiteId, suiteName, definitionId, definitionName, sourceRunId } = response.json<{
          run: Record<string, unknown>;
        }>().run;
        return { suiteId, suiteName, definitionId, definitionName, sourceRunId };
      };
      const none = { suiteId: null, suiteName: null, definitionId: null, definitionName: null, sourceRunId: source.id };

      expect(breadcrumbOf(await queue(ana, target, queueBody({ sourceRunId: source.id })))).toEqual({
        suiteId: suite.id,
        suiteName: suite.name,
        definitionId: definition.id,
        definitionName: definition.name,
        sourceRunId: source.id,
      });
      expect(breadcrumbOf(await queue(ana, otherVersion, queueBody({ sourceRunId: source.id })))).toEqual(none);
      expect(breadcrumbOf(await queue(ana, otherConfiguration, queueBody({ sourceRunId: source.id })))).toEqual(none);
      const stored = await ownerDb
        .selectFrom("test_runs")
        .select(["configuration_version_id", "test_suite_name", "test_definition_name"])
        .where("source_run_id", "=", source.id)
        .execute();
      expect(stored.filter((row) => row.test_suite_name !== null || row.test_definition_name !== null)).toEqual([
        { configuration_version_id: target.versionId, test_suite_name: suite.name, test_definition_name: definition.name },
      ]);
    });

    it("25 definition runs queue past the 20 a minute (RATE_LIMITS) and copy each; one-off runs still count, 20 then 429; the 51st waiting run, a definition's, is test_run_queue_full", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });

      for (let index = 0; index < 25; index += 1) {
        expect((await queue(ana, target, definitionRunBody(definition.id), { on: limited })).statusCode).toBe(201);
      }
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      // The minute doesn't stop a definition's run…
      expect((await queue(ana, target, definitionRunBody(definition.id), { on: limited })).statusCode).toBe(201);
      expect(await runRows()).toHaveLength(46);

      // …but the 50 waiting do (decision 7): four more make 50, and the 51st is refused, nothing copied.
      for (let index = 0; index < 4; index += 1) {
        await addTestRun(ownerDb, {
          organizationId: ana.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: ana.userId,
        });
      }
      const written = await filesUnder(root);
      const copiesBefore = copiesBegun;
      expectRefusal(await queue(ana, target, definitionRunBody(definition.id), { on: limited }), 429, "test_run_queue_full", MESSAGES.queueFull);
      expect(copiesBegun).toBe(copiesBefore);
      expect(await filesUnder(root)).toEqual(written);
    }, MANY_RUNS_TIMEOUT);

    it("a template's run and a re-run count against the 20 a minute (RATE_LIMITS), a re-run of a definition's run included", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const template = await templateWith(Buffer.from("{}\n"));
      const source = (await queue(ana, target, definitionRunBody(definition.id), { on: limited })).json<{ run: { id: string } }>().run;

      for (let index = 0; index < 10; index += 1) {
        expect((await queue(ana, target, queueBody({ templateId: template.id }), { on: limited })).statusCode).toBe(201);
        expect((await queue(ana, target, queueBody({ sourceRunId: source.id }), { on: limited })).statusCode).toBe(201);
      }

      expectRefusal(await queue(ana, target, queueBody({ templateId: template.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expectRefusal(await queue(ana, target, queueBody({ sourceRunId: source.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expect((await queue(ana, target, definitionRunBody(definition.id), { on: limited })).statusCode).toBe(201);
    });

    it("a one-off run can't claim the exemption: a body naming a definition beside its source, or any flag, is refused 400, and one-off runs keep the 20 a minute (decision 7)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { suite, definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const oneOff = queueBody({ inputFileId: file.id });

      for (const claim of [
        { ...oneOff, definitionId: definition.id },
        { ...oneOff, fromSuite: true },
        { ...oneOff, fromDefinition: true },
        { ...oneOff, exempt: true },
        { ...oneOff, suiteId: suite.id },
        { ...oneOff, definitionName: definition.name },
        { ...definitionRunBody(definition.id), inputFileId: file.id },
        { ...definitionRunBody(definition.id), pipeline: "logs", signal: "logs", durationSeconds: 5 },
      ]) {
        expectInvalid(await queue(ana, target, claim, { on: limited }));
      }
      expect(await runRows()).toEqual([]);

      // A suite's runs first, then the person's one-off runs: still 20, then 429.
      for (let index = 0; index < 3; index += 1) {
        expect((await queue(ana, target, definitionRunBody(definition.id), { on: limited })).statusCode).toBe(201);
      }
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, oneOff, { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, oneOff, { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
    });

    it("Ana's waiting runs, her minute's runs and her uploads in Globex don't count in Acme (Preflight rulings 21 and 22, RATE_LIMITS)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const anaInAcme = await member();
      const anaInGlobex = await alsoIn(anaInAcme);
      const acme = await configurationOf(anaInAcme);
      const globex = await configurationOf(anaInGlobex);

      // Globex: her 30 uploads, then the 31st refused…
      const uploadIn = (person: Person, on: FastifyInstance) =>
        upload(person, uploadParts(Buffer.from('{"resourceLogs":[]}\n')), { on });
      const globexUploads = [];
      for (let index = 0; index < 30; index += 1) globexUploads.push(await uploadIn(anaInGlobex, limited));
      expect(globexUploads.map((response) => response.statusCode)).toEqual(Array(30).fill(201));
      expectRefusal(await uploadIn(anaInGlobex, limited), 429, "rate_limited", MESSAGES.uploadsLimited);
      const globexFile = globexUploads[0]!.json<{ file: { id: string } }>().file;
      // …her 20 runs this minute, then the 21st refused, and 30 more waiting: 50 waiting there.
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(anaInGlobex, globex, queueBody({ inputFileId: globexFile.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(anaInGlobex, globex, queueBody({ inputFileId: globexFile.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      for (let index = 0; index < 30; index += 1) {
        await addTestRun(ownerDb, {
          organizationId: globex.organizationId,
          configurationId: globex.configurationId,
          configurationVersionId: globex.versionId,
          queuedByUserId: anaInAcme.userId,
        });
      }
      const { definition: globexDefinition } = await definitionOf(anaInGlobex, globex, { inputFileId: globexFile.id });
      expectRefusal(await queue(anaInGlobex, globex, definitionRunBody(globexDefinition.id), { on: limited }), 429, "test_run_queue_full", MESSAGES.queueFull);

      // Acme: none of it counts. Her upload, then her 20 runs; the 21st is Acme's own limit.
      const acmeUpload = await uploadIn(anaInAcme, limited);
      expect(acmeUpload.statusCode).toBe(201);
      const acmeFile = acmeUpload.json<{ file: { id: string } }>().file;
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(anaInAcme, acme, queueBody({ inputFileId: acmeFile.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(anaInAcme, acme, queueBody({ inputFileId: acmeFile.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expect(await runRows()).toHaveLength(70);
    }, MANY_RUNS_TIMEOUT);
  });

  describe("queue requests in flight (D14b Ruling 33)", () => {
    /** Hang guards only: each wait ends on its condition, and each test on its last request. */
    const CONDITION_TIMEOUT = { timeout: 10_000, interval: 5 };
    const BURST_TIMEOUT = 60_000;

    /** Holds every copy, once begun, until the test opens the gate. */
    const holdCopies = () => {
      let open = (): void => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      copyBarrier = { remaining: Number.POSITIVE_INFINITY, opened, open };
      return open;
    };

    /** `count` waiting runs of `person`'s on `target`, as the owner inserts them. */
    const seedWaiting = async (person: Person, target: Target, count: number) => {
      for (let index = 0; index < count; index += 1) {
        await addTestRun(ownerDb, {
          organizationId: person.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: person.userId,
        });
      }
    };

    it("bursts of definition runs at a nearly full queue copy at most 4 inputs a round: 4 rounds of 50 at once with 49 waiting, one queued a round and the rest refused before their copy", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      await seedWaiting(ana, target, 49);
      // The definition's own input was a copy too.
      const copiesAtStart = copiesBegun;

      for (let round = 0; round < 4; round += 1) {
        const copiesBefore = copiesBegun;
        const responses = await Promise.all(
          Array.from({ length: 50 }, () => queue(ana, target, definitionRunBody(definition.id), { on: limited })),
        );

        // At most the four holding a place counted 49 before the one that
        // filled the queue committed; every other one counted 50 first.
        expect(copiesBegun - copiesBefore).toBeLessThanOrEqual(4);
        expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
        for (const response of responses.filter((each) => each.statusCode !== 201)) {
          expectRefusal(response, 429, "test_run_queue_full", MESSAGES.queueFull);
        }
        // One waiting run removed: 49 wait again.
        const [newest] = await ownerDb
          .selectFrom("test_runs")
          .select("id")
          .where("status", "=", "queued")
          .orderBy("queued_at", "desc")
          .limit(1)
          .execute();
        await ownerDb.deleteFrom("test_runs").where("id", "=", newest!.id).execute();
      }
      expect(copiesBegun - copiesAtStart).toBeLessThanOrEqual(16);
      // Only the queued runs' folders are left: a refused copy's files went.
      const runFolders = new Set(
        (await filesUnder(root))
          .filter((path) => path.startsWith(join("organizations", ana.organizationId, "test-runs")))
          .map((path) => path.split("/")[3]),
      );
      expect(runFolders.size).toBe(4);
    }, BURST_TIMEOUT);

    it("a fifth request at once waits for a place, holding nothing, then proceeds once one is freed", async () => {
      const places = createCopyPlaces();
      const watched = await serverWith({ copyPlaces: places });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      // The definition's own input was a copy too.
      const copiesAtStart = copiesBegun;
      const open = holdCopies();

      const responses = Promise.all(
        Array.from({ length: 5 }, () => queue(ana, target, definitionRunBody(definition.id), { on: watched })),
      );
      await vi.waitFor(() => {
        expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 4, waiting: 1 });
        expect(copiesBegun - copiesAtStart).toBe(4);
      }, CONDITION_TIMEOUT);
      // Another organization's requests of hers have their own places.
      expect(places.count(ana.userId, ana.personalOrganizationId)).toEqual({ holding: 0, waiting: 0 });

      open();

      expect((await responses).map((response) => response.statusCode)).toEqual([201, 201, 201, 201, 201]);
      expect(copiesBegun - copiesAtStart).toBe(5);
      expect(await runRows()).toHaveLength(5);
      expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 0, waiting: 0 });
    }, BURST_TIMEOUT);

    it(`refuses a request beyond ${TEST_RUN_COPIES_WAITING_PER_USER} waiting with 429 test_run_rate_limited and a retry-after, copying nothing for it`, async () => {
      const places = createCopyPlaces();
      const watched = await serverWith({ copyPlaces: places });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      // The definition's own input was a copy too.
      const copiesAtStart = copiesBegun;
      const open = holdCopies();

      const held = Promise.all(
        Array.from({ length: 4 + TEST_RUN_COPIES_WAITING_PER_USER }, () =>
          queue(ana, target, definitionRunBody(definition.id), { on: watched }),
        ),
      );
      await vi.waitFor(() => {
        expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 4, waiting: TEST_RUN_COPIES_WAITING_PER_USER });
        expect(copiesBegun - copiesAtStart).toBe(4);
      }, CONDITION_TIMEOUT);

      const refused = await queue(ana, target, definitionRunBody(definition.id), { on: watched });

      // Its own words, not the minute's (D14b Ruling 37): a definition's run isn't counted against the minute.
      expectRefusal(refused, 429, "test_run_rate_limited", MESSAGES.queuingBusy);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(copiesBegun - copiesAtStart).toBe(4);
      open();
      // The 104 end as the queue's cap decides: 50 queued, the rest refused
      // once they count a full queue.
      const statuses = (await held).map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(50);
      expect(statuses.filter((status) => status === 429)).toHaveLength(4 + TEST_RUN_COPIES_WAITING_PER_USER - 50);
      expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 0, waiting: 0 });
    }, BURST_TIMEOUT);

    it("frees the place whatever the request ends in: a full queue, a failed copy, an input gone, a row that can't be saved, a queued run", async () => {
      const places = createCopyPlaces();
      const watched = await serverWith({ copyPlaces: places });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const gone = await definitionOf(ana, target, { inputFileId: file.id }, { name: "Gone" });
      await store.remove({ kind: "test-definition-input", organizationId: ana.organizationId, inputId: gone.inputId });
      const free = () => {
        expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 0, waiting: 0 });
        // Nothing kept in memory for her once every place is released (D14b Ruling 39).
        expect(places.keyCount()).toBe(0);
      };
      // Five of each in turn, every place freed after each.
      const fiveTimes = async (body: unknown, statusCode: number) => {
        for (let index = 0; index < 5; index += 1) {
          expect((await queue(ana, target, body, { on: watched })).statusCode).toBe(statusCode);
          free();
        }
      };

      await seedWaiting(ana, target, 50);
      await fiveTimes(definitionRunBody(definition.id), 429);
      await ownerDb.deleteFrom("test_runs").execute();

      isCopyFailing = true;
      await fiveTimes(definitionRunBody(definition.id), 500);
      isCopyFailing = false;

      await fiveTimes(definitionRunBody(gone.definition.id), 404);

      await withFailingInsert(ownerDb, "test_runs", "raise exception 'refused for the test'", async () => {
        await fiveTimes(definitionRunBody(definition.id), 500);
      });

      await fiveTimes(definitionRunBody(definition.id), 201);
      await fiveTimes(queueBody({ inputFileId: file.id }), 201);
      expect(await runRows()).toHaveLength(10);
    }, BURST_TIMEOUT);

    it("a counted run refused at the place gets its minute back: 25 one-off runs refused while a definition's run holds the only place, then 20 queue and the 21st is refused for the minute (D14b Ruling 39)", async () => {
      const places = createCopyPlaces({ inFlight: 1, waiting: 0 });
      const limited = await serverWith({ rateLimits: RATE_LIMITS, copyPlaces: places });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      const open = holdCopies();
      // A definition's run isn't counted against the minute (decision 7).
      const holder = queue(ana, target, definitionRunBody(definition.id), { on: limited });
      await vi.waitFor(() => expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 1, waiting: 0 }), CONDITION_TIMEOUT);

      // More than the minute's 20: had any kept its admission, the 21st
      // would be refused for the minute instead.
      for (let index = 0; index < 25; index += 1) {
        const refused = await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited });
        expectRefusal(refused, 429, "test_run_rate_limited", MESSAGES.queuingBusy);
      }

      open();
      expect((await holder).statusCode).toBe(201);
      copyBarrier = undefined;
      for (let index = 0; index < 20; index += 1) {
        expect((await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited })).statusCode).toBe(201);
      }
      expectRefusal(await queue(ana, target, queueBody({ inputFileId: file.id }), { on: limited }), 429, "test_run_rate_limited", MESSAGES.rateLimited);
      expect(await runRows()).toHaveLength(21);
    }, BURST_TIMEOUT);

    it("keeps the place until the run's files are removed: a failed copy holds it while its removal runs, then frees it (D14b Ruling 39)", async () => {
      const places = createCopyPlaces();
      const watched = await serverWith({ copyPlaces: places });
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const { definition } = await definitionOf(ana, target, { inputFileId: file.id });
      let removalsBegun = 0;
      let open = (): void => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      beforeRemove = async () => {
        removalsBegun += 1;
        await opened;
      };
      isCopyFailing = true;

      const response = queue(ana, target, definitionRunBody(definition.id), { on: watched });
      await vi.waitFor(() => expect(removalsBegun).toBe(1), CONDITION_TIMEOUT);
      expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 1, waiting: 0 });

      open();
      expect((await response).statusCode).toBe(500);
      expect(places.count(ana.userId, ana.organizationId)).toEqual({ holding: 0, waiting: 0 });
      expect(places.keyCount()).toBe(0);
    }, BURST_TIMEOUT);
  });

  describe("a version's runs (GET …/test-runs)", () => {
    it("lists the version's runs newest first, at most 100, without text or logs", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const ids: string[] = [];
      for (let index = 0; index < 101; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
        const row = await addTestRun(ownerDb, {
          organizationId: ana.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          queuedByUserId: ana.userId,
          state: finishedState({ queued_at: at, started_at: at, finished_at: at }),
        });
        ids.push(row.id);
      }

      const response = await read(ana, runsPath(target));

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { runs } = response.json<{ runs: Array<Record<string, unknown>> }>();
      expect(runs.map((run) => run.id)).toEqual(ids.slice(1).reverse());
      expect(Object.keys(runs[0]!).sort()).toEqual(
        [
          "id",
          "status",
          "queuedAt",
          "startedAt",
          "finishedAt",
          "ahead",
          "pipeline",
          "signal",
          "durationSeconds",
          "collectorVersion",
          "queuedByUserId",
          "inputName",
          "errorCode",
          "suiteId",
          "suiteName",
          "definitionId",
          "definitionName",
        ].sort(),
      );
      expect(runs[0]).toMatchObject({ status: "succeeded", ahead: null });
    });

    it("gives each waiting run its place under the queue's turns, for interleaved people (decision 11)", async () => {
      const { ana, ben, cara } = await team();
      const target = await configurationOf(ana, { published: true });
      const caras = await configurationOf(cara);
      const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
      const add = (person: Person, where: Target, state: Partial<TestRunState>) =>
        addTestRun(ownerDb, {
          organizationId: where.organizationId,
          configurationId: where.configurationId,
          configurationVersionId: where.versionId,
          queuedByUserId: person.userId,
          state,
        });
      const c1 = await add(cara, caras, { queued_at: at(0) });
      const a1 = await add(ana, target, { queued_at: at(1) });
      const a2 = await add(ana, target, { queued_at: at(2) });
      const b1 = await add(ben, target, { queued_at: at(3) });
      const b2 = await add(ben, target, { queued_at: at(4) });
      const a3 = await add(ana, target, { queued_at: at(5) });
      // Ben has one running already: his waiting runs' turns start at 1.
      const running = await add(ben, target, {
        status: "running",
        queued_at: at(0),
        started_at: at(0),
        lease_id: randomUUID(),
        lease_expires_at: new Date(Date.now() + 3_600_000),
      });

      const response = await read(ben, runsPath(target));

      // Turns: c1 0, a1 0, a2 1, b1 1, b2 2, a3 2; ordered by (turn, queued_at):
      // c1, a1, a2, b1, b2, a3.
      const places = Object.fromEntries(
        response.json<{ runs: Array<{ id: string; ahead: number | null }> }>().runs.map((run) => [run.id, run.ahead]),
      );
      expect(places).toEqual({
        [a1.id]: 1,
        [a2.id]: 2,
        [b1.id]: 3,
        [b2.id]: 4,
        [a3.id]: 5,
        [running.id]: null,
      });
      expect(places[c1.id]).toBeUndefined();
    });

    it("hides a draft's runs from a teammate (404) until the configuration is published, then shows them all", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const earlier = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      expectRefusal(await read(ben, runsPath(target)), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      expectRefusal(
        await read(ben, `${runsPath(target)}/${earlier.id}`),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await read(ben, `${runsPath(target)}/${earlier.id}/files/input`),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );

      await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: target.organizationId,
        version_number: 2,
        publishedAt: new Date(),
      });
      const later = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      const listed = await read(ben, runsPath(target));
      expect(listed.json<{ runs: Array<{ id: string }> }>().runs.map((run) => run.id)).toEqual([later.id, earlier.id]);
      expect((await read(ben, `${runsPath(target)}/${earlier.id}`)).statusCode).toBe(200);
      const input = await read(ben, `${runsPath(target)}/${earlier.id}/files/input`);
      expect(input.statusCode).toBe(200);
      expect(input.rawPayload).toEqual(await readFile(join(root, runFilePath(ana.organizationId, earlier.id, "input"))));
    });

    it("answers another organization with 404 everywhere", async () => {
      const { ana, cara } = await team();
      const target = await configurationOf(ana, { published: true });
      const file = await uploaded(ana);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      for (const suffix of ["", `/${run.id}`, `/${run.id}/files/input`]) {
        expectRefusal(
          await read(cara, `${runsPath(target, cara.organizationId)}${suffix}`),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expectRefusal(
          await read(cara, `${runsPath(target)}${suffix}`),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
      }
      expectRefusal(await read(cara, filesPath(ana.organizationId)), 404, "organization_not_found", MESSAGES.organizationNotFound);
    });

    it("hides a soft-deleted configuration's runs and their files (404), keeping both", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", target.configurationId).execute();

      for (const suffix of ["", `/${run.id}`, `/${run.id}/files/input`]) {
        expectRefusal(await read(ana, `${runsPath(target)}${suffix}`), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(await runRows()).toHaveLength(1);
      expect(await filesUnder(root)).toContain(runFilePath(ana.organizationId, run.id, "input"));
    });
  });

  describe("a run (GET …/test-runs/:runId)", () => {
    it("answers the run in full, with its results", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const timings = { totalMs: 9000, readyMs: 400, informerMs: null, replayMs: 30, holdMs: 5000, stopMs: 60 };
      const mutations = [{ id: "R-001", severity: "info", message: "Your receivers were replaced.", details: { receivers: ["otlp"] } }];
      const compatibility = [{ id: "C-003", severity: "advisory", component: "processors/batch", message: "Slow.", details: {} }];
      const row = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        input_name: "app.ndjson",
        input_size_bytes: 12,
        state: finishedState({
          strategy: "otlp",
          kwok_enabled: false,
          mutated_yaml: "receivers: {}\n",
          mutations: JSON.stringify(mutations),
          compatibility: JSON.stringify(compatibility),
          logs: "[replay] 1 of 1 payloads sent\n",
          timings: JSON.stringify(timings),
          output_size_bytes: 20,
          output_truncated: false,
          decoded_input_size_bytes: 12,
          decoded_input_truncated: false,
        }),
      });

      const response = await read(ana, `${runsPath(target)}/${row.id}`);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ run: Record<string, unknown> }>().run).toMatchObject({
        id: row.id,
        status: "succeeded",
        ahead: null,
        inputName: "app.ndjson",
        inputSizeBytes: 12,
        inputContentType: "application/x-ndjson",
        strategy: "otlp",
        kwokEnabled: false,
        mutatedYaml: "receivers: {}\n",
        mutations,
        compatibility,
        logs: "[replay] 1 of 1 payloads sent\n",
        timings,
        outputSizeBytes: 20,
        outputTruncated: false,
        decodedInputSizeBytes: 12,
        decodedInputTruncated: false,
        errorCode: null,
        errorMessage: null,
      });
    });

    it("serves results at the contract's bounds counted in code points: emoji included (Ruling 39)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const emoji = (count: number) => "😀".repeat(count);
      const mutations = [{ id: "R-001", severity: "info", message: emoji(4_096), details: {} }];
      const compatibility = [{ id: "C-003", severity: "advisory", component: emoji(1_024), message: emoji(4_096), details: {} }];
      const row = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        state: finishedState({
          status: "failed",
          strategy: "otlp",
          kwok_enabled: false,
          mutated_yaml: emoji(1_048_576),
          mutations: JSON.stringify(mutations),
          compatibility: JSON.stringify(compatibility),
          logs: emoji(262_144),
          error_code: "collector_failed",
          error_message: emoji(2_000),
        }),
      });

      const response = await read(ana, `${runsPath(target)}/${row.id}`);

      expect(response.statusCode).toBe(200);
      const run = response.json<{ run: Record<string, unknown> }>().run;
      expect(run.logs).toBe(emoji(262_144));
      expect(run.mutatedYaml).toBe(emoji(1_048_576));
      expect(run.errorMessage).toBe(emoji(2_000));
      expect(run.mutations).toEqual(mutations);
      expect(run.compatibility).toEqual(compatibility);
    });

    it("answers an unknown, a malformed and another version's run id with 404", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const other = await configurationOf(ana);
      const file = await uploaded(ana);
      const run = (await queue(ana, other, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      for (const id of [randomUUID(), "not-a-uuid", run.id]) {
        expectRefusal(await read(ana, `${runsPath(target)}/${id}`), 404, "test_run_not_found", MESSAGES.runNotFound);
      }
    });
  });

  describe("a run's files (GET …/test-runs/:runId/files/:file)", () => {
    it("streams the input as bytes, never sniffed, a download under a generic name, never cached", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.from('{"resourceLogs":[]}\n');
      const file = await uploaded(ana, data);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      const response = await read(ana, `${runsPath(target)}/${run.id}/files/input`);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="input"');
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(Number(response.headers["content-length"])).toBe(data.length);
      expect(response.rawPayload).toEqual(data);
    });

    it("round-trips the uploaded bytes exactly, UTF-16 with its NULs included", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"body":"café 🚀"}\n', "utf16le")]);
      expect(data.includes(0)).toBe(true);
      const file = await uploaded(ana, data);
      expect(file.sha256).toBe(createHash("sha256").update(data).digest("hex"));
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      const response = await read(ana, `${runsPath(target)}/${run.id}/files/input`);

      expect(response.rawPayload).toEqual(data);
    });

    it("answers a file the run didn't store, and an unknown file name, with 404", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      for (const name of ["output", "decoded-input", "secret", "..%2Finput"]) {
        expectRefusal(await read(ana, `${runsPath(target)}/${run.id}/files/${name}`), 404, "test_run_not_found", MESSAGES.noSuchFile);
      }
    });

    it("streams a stored output and decoded input under their generic names", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const output = Buffer.from('{"records":[]}');
      const decoded = Buffer.from('{"resourceLogs":[]}');
      const row = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        state: finishedState({
          output_size_bytes: output.length,
          output_truncated: false,
          decoded_input_size_bytes: decoded.length,
          decoded_input_truncated: false,
        }),
      });
      const key = (name: "output" | "decoded-input"): FileKey => ({
        kind: "test-run",
        organizationId: ana.organizationId,
        runId: row.id,
        name,
      });
      await store.write(key("output"), Readable.from([output]), { maxBytes: TEN_MIB });
      await store.write(key("decoded-input"), Readable.from([decoded]), { maxBytes: TEN_MIB });

      const outputResponse = await read(ana, `${runsPath(target)}/${row.id}/files/output`);
      const decodedResponse = await read(ana, `${runsPath(target)}/${row.id}/files/decoded-input`);

      expect(outputResponse.headers["content-disposition"]).toBe('attachment; filename="output"');
      expect(outputResponse.rawPayload).toEqual(output);
      expect(decodedResponse.headers["content-disposition"]).toBe('attachment; filename="decoded-input"');
      expect(decodedResponse.rawPayload).toEqual(decoded);
    });

    it("destroys the file's stream when the client goes away mid-download", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const row = await addTestRun(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: ana.userId,
        state: finishedState({ output_size_bytes: TEN_MIB, output_truncated: true }),
      });
      await store.write(
        { kind: "test-run", organizationId: ana.organizationId, runId: row.id, name: "output" },
        Readable.from([Buffer.alloc(TEN_MIB, 0x7b)]),
        { maxBytes: TEN_MIB },
      );
      const listening = await serverWith();
      await listening.listen({ port: 0, host: "127.0.0.1" });
      const { port } = listening.server.address() as AddressInfo;

      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: `${runsPath(target)}/${row.id}/files/output`,
            headers: { cookie: `telflo_access=${ana.access}` },
          },
          (response) => {
            expect(response.statusCode).toBe(200);
            // Gone before reading a byte.
            response.destroy();
            request.destroy();
            resolve();
          },
        );
        request.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
        });
        request.end();
      });

      expect(readStreams).toHaveLength(1);
      const stream = readStreams[0]!;
      await new Promise<void>((resolve) => {
        if (stream.destroyed) resolve();
        else stream.once("close", () => resolve());
      });
      expect(stream.destroyed).toBe(true);
      expect(stream.readableEnded).toBe(false);
    });
  });

  describe("a run's input head (GET …/test-runs/:runId/files/input/head, Ruling 46)", () => {
    const headPath = (target: Target, runId: string, organizationId = target.organizationId) =>
      `${runsPath(target, organizationId)}/${runId}/files/input/head`;

    it("answers the first 64 KiB of the run's larger input, as bytes, never sniffed, under no name, never cached", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.alloc(3 * 65_536 + 7);
      for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
      const file = await uploaded(ana, data);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      readStreams = [];

      const response = await read(ana, headPath(target, run.id));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data.subarray(0, 65_536));
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-disposition": "attachment",
        "content-length": "65536",
      });
      expect(JSON.stringify(response.headers)).not.toContain(NAME_MARKER);
      // The run's own copy, read once and closed.
      expect(readStreams).toHaveLength(1);
      expect(readStreams.every((stream) => stream.destroyed)).toBe(true);
    });

    it("answers a smaller input whole", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"body":"café"}\n', "utf16le")]);
      const file = await uploaded(ana, data);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      const response = await read(ana, headPath(target, run.id));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers["content-length"]).toBe(String(data.length));
    });

    it("follows the run's visibility: hidden from a teammate (404) while a draft, theirs once published", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const data = Buffer.from('{"resourceLogs":[{"draft":true}]}\n');
      const file = await uploaded(ana, data);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      expectRefusal(await read(ben, headPath(target, run.id)), 404, "configuration_not_found", MESSAGES.configurationNotFound);

      await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: target.organizationId,
        version_number: 2,
        publishedAt: new Date(),
      });
      const response = await read(ben, headPath(target, run.id));
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
    });

    it("is 404 from another organization, for an unknown, malformed or another version's run, and once the input's bytes are gone", async () => {
      const { ana, cara } = await team();
      const target = await configurationOf(ana, { published: true });
      const other = await configurationOf(ana);
      const file = await uploaded(ana);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      const elsewhere = (await queue(ana, other, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;

      expectRefusal(await read(cara, headPath(target, run.id)), 404, "organization_not_found", MESSAGES.organizationNotFound);
      expectRefusal(await read(cara, headPath(target, run.id, cara.organizationId)), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      for (const id of [randomUUID(), "not-a-uuid", elsewhere.id]) {
        expectRefusal(await read(ana, headPath(target, id)), 404, "test_run_not_found", MESSAGES.runNotFound);
      }

      await rm(join(root, runFilePath(ana.organizationId, run.id, "input")));
      expectRefusal(await read(ana, headPath(target, run.id)), 404, "test_run_not_found", MESSAGES.noSuchFile);
    });

    it("needs a session, and counts with the uploads (RATE_LIMITS: 30 a minute)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      expect((await server.inject({ method: "GET", url: headPath(target, run.id) })).statusCode).toBe(401);

      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      for (let index = 0; index < 30; index += 1) {
        expect((await read(ana, headPath(target, run.id), { on: limited })).statusCode).toBe(200);
      }
      expect((await read(ana, headPath(target, run.id), { on: limited })).statusCode).toBe(429);
    });
  });

  describe("privacy (decision 23)", () => {
    it("puts no file name, description or text in any log line", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const file = await uploaded(ana);
      await upload(ana, uploadParts(Buffer.from("x"), { filename: `refused-${NAME_MARKER}.csv` }));
      await upload(ana, uploadParts(Buffer.alloc(TEN_MIB + 1)));
      await upload(
        ana,
        [
          { name: "displayName", value: `Sample ${NAME_MARKER}` },
          { name: "description", value: DESCRIPTION_MARKER },
          { name: "file", filename: "sample", data: Buffer.from("{}"), contentType: "application/json" },
        ],
        { sample: true },
      );
      const run = (await queue(ana, target, queueBody({ inputFileId: file.id }))).json<{ run: { id: string } }>().run;
      await queue(ana, target, queueBody({ inputFileId: file.id }, { collectorVersion: RETIRED }));
      await read(ana, runsPath(target));
      await read(ana, `${runsPath(target)}/${run.id}`);
      await read(ana, `${runsPath(target)}/${run.id}/files/input`);
      await read(ana, filesPath(ana.organizationId));

      expect(logLines.length).toBeGreaterThan(0);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, TEXT_MARKER]) {
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }
    });
  });
});
