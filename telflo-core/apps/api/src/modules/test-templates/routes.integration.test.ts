import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  TEST_TEMPLATE_PART_NAMES,
  TEST_TEMPLATE_RECEIVER_TYPES,
} from "@telflo/contracts";
import type { OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestTemplate,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
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
const PASSWORD = "a-sufficiently-long-password";
const MIB = 1_048_576;
const TEN_MIB = 10 * MIB;
const HEAD_BYTES = 64 * 1024;
const TEMPLATES = "/api/v1/test-templates";

/** Markers no log line, URL or audit row may hold: a template's name, its description and its file's name. */
const NAME_MARKER = "template-name-marker-7c3a";
const DESCRIPTION_MARKER = "template-description-marker-e5d2";
const FILE_MARKER = "template-file-marker-19bf";

const RUN_TEXT =
  "receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n";

/** The words, exactly. */
const MESSAGES = {
  templateNotFound: "Test template not found",
  productAdminRequired: "Only a product admin can do that.",
  termsRequired: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  tooLarge: "The file is larger than 10 MiB.",
  typeUnsupported: "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.",
  invalid: "The request was not valid.",
  uploadsLimited: "Too many attempts. Please wait and try again.",
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

/** A template upload's five parts, in order (TEST_TEMPLATE_PART_NAMES), its name unique to the test. */
function templateParts(
  data: Buffer,
  options: { name?: string; description?: string; receiverType?: string; signal?: string; filename?: string; contentType?: string } = {},
): Part[] {
  return [
    { name: "name", value: options.name ?? `OTLP logs ${NAME_MARKER} ${randomUUID()}` },
    { name: "description", value: options.description ?? `A sample ${DESCRIPTION_MARKER}` },
    { name: "receiverType", value: options.receiverType ?? "otlp" },
    { name: "signal", value: options.signal ?? "logs" },
    {
      name: "file",
      filename: options.filename ?? `otlp-logs-${FILE_MARKER}.json`,
      data,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    },
  ];
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
 * The test templates API, against Postgres as the API's own role, with a
 * real FileStore on a temporary directory. Product admins write; members
 * read the live templates and their bytes; a deleted template's definitions
 * keep their own copies (the queue's path).
 */
describe("the test templates API", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let root: string;
  let store: IFileStore;
  let logLines: string[] = [];
  /** While true, every removal fails as a read-only disk would. */
  let isRemoveFailing = false;
  /** Awaited before each removal, while it is set: a test watches what the database holds at that moment. */
  let beforeRemove: ((key: FileKey) => Promise<void>) | undefined;
  /** Every key the store was asked to write since the test began. */
  let writes: FileKey[] = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return clock;
  };

  /** The store the servers use: the real one, recording each write. */
  const recordingStore: IFileStore = {
    write: (key, content, options) => {
      writes.push(key);
      return store.write(key, content, options);
    },
    copy: (from, to) => store.copy(from, to),
    remove: async (key) => {
      await beforeRemove?.(key);
      if (isRemoveFailing) throw new FileStoreError("EROFS", "unlink");
      await store.remove(key);
    },
    read: (key) => store.read(key),
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
    root = await mkdtemp(join(tmpdir(), "telflo-test-templates-"));
    store = await createFileStore({ kind: "local", root });
    logLines = [];
    isRemoveFailing = false;
    beforeRemove = undefined;
    writes = [];
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
    email: string;
    organizationId: string;
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
      // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
      access: (switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access")),
    };
  };
  const productAdmin = (options: { hasAcceptedTerms?: boolean } = {}) => person({ ...options, isProductAdmin: true });

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

  /** A template upload as `who` (signed out when undefined). */
  const upload = (who: Person | undefined, parts: Part[], options: { on?: FastifyInstance } = {}) => {
    const { payload, headers } = multipartBody(parts);
    return (options.on ?? server).inject({
      method: "POST",
      url: TEMPLATES,
      headers: { ...csrfHeaders, ...headers },
      ...(who === undefined ? {} : { cookies: { telflo_access: who.access } }),
      payload,
    });
  };

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: statusCode,
      body: { error: { code, message } },
    });
  }

  interface TemplateBody {
    id: string;
    name: string;
    description: string;
    receiverType: string;
    signal: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
  }

  /** A template `admin` uploads, through the API. */
  const created = async (admin: Person, data: Buffer = Buffer.from('{"resourceLogs":[]}\n'), options: Parameters<typeof templateParts>[1] = {}) => {
    const response = await upload(admin, templateParts(data, options));
    expect(response.statusCode).toBe(201);
    return response.json<{ template: TemplateBody }>().template;
  };

  const templateRows = () => databases.ownerDb.selectFrom("test_templates").selectAll().orderBy("created_at").orderBy("id").execute();
  const templatePath = (templateId: string) => join("global", "test-templates", templateId);
  const templateFiles = async () => (await filesUnder(root)).filter((path) => path.includes("test-templates"));
  const auditRows = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", "test_template.%")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
  const templatePathOf = (templateId: string) => `${TEMPLATES}/${templateId}`;
  const filePathOf = (templateId: string) => `${TEMPLATES}/${templateId}/file`;
  const headPathOf = (templateId: string) => `${TEMPLATES}/${templateId}/file/head`;

  describe("creating one (POST, product admins only)", () => {
    it("streams the file to the store, then saves the row and an audit row of ids in no organization; the type is the extension's", async () => {
      const admin = await productAdmin();
      const data = Buffer.from('{"resourceLogs":[{"scopeLogs":[]}]}\n');
      const name = `  OTLP logs ${NAME_MARKER} ${randomUUID()}  `;

      const response = await upload(
        admin,
        templateParts(data, { name, receiverType: "filelog", signal: "logs", contentType: "text/html" }),
      );

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { template } = response.json<{ template: TemplateBody }>();
      expect(template).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: name.trim(),
        description: `A sample ${DESCRIPTION_MARKER}`,
        receiverType: "filelog",
        signal: "logs",
        fileName: `otlp-logs-${FILE_MARKER}.json`,
        // The extension's, never the browser's text/html.
        contentType: "application/json",
        sizeBytes: data.length,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      });
      const [row] = await templateRows();
      expect(row).toMatchObject({
        id: template.id,
        created_by_user_id: admin.userId,
        deleted_at: null,
        size_bytes: data.length,
        created_at: clock,
      });
      expect(row!.sha256.toString("hex")).toBe(sha256Of(data));
      expect(await templateFiles()).toEqual([templatePath(template.id)]);
      expect(await readFile(join(root, templatePath(template.id)))).toEqual(data);
      expect(await auditRows()).toEqual([
        expect.objectContaining({
          action: "test_template.created",
          actor_user_id: admin.userId,
          actor_email: admin.email,
          organization_id: null,
          subject_type: "test_template",
          subject_id: template.id,
          metadata: {},
        }),
      ]);
    });

    it.each([
      ["events.json", "application/json"],
      ["events.NDJSON", "application/x-ndjson"],
      ["pipeline.yaml", "application/x-yaml"],
      ["pipeline.yml", "application/x-yaml"],
      ["notes.txt", "text/plain"],
      ["syslog.Log", "text/plain"],
    ])("stores %s as %s", async (filename, contentType) => {
      const admin = await productAdmin();
      const template = await created(admin, Buffer.from("x"), { filename });
      expect(template).toMatchObject({ contentType, fileName: filename });
    });

    it.each([
      ["another extension", "events.csv"],
      ["no extension", "events"],
      ["a dot file", ".json"],
      ["a compressed file", "events.json.gz"],
    ])("refuses %s with 415, writing nothing", async (_label, filename) => {
      const admin = await productAdmin();
      const response = await upload(admin, templateParts(Buffer.from("x"), { filename }));
      expectRefusal(response, 415, "test_file_type_unsupported", MESSAGES.typeUnsupported);
      expect(await templateRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("takes every one of the palette's receiver types (TEST_TEMPLATE_RECEIVER_TYPES), and each signal", async () => {
      const admin = await productAdmin();
      for (const receiverType of TEST_TEMPLATE_RECEIVER_TYPES) {
        expect((await created(admin, Buffer.from("x"), { receiverType })).receiverType).toBe(receiverType);
      }
      for (const signal of ["traces", "metrics", "logs"]) {
        expect((await created(admin, Buffer.from("x"), { signal })).signal).toBe(signal);
      }
    });

    it("accepts exactly 10 MiB, and refuses 10 MiB + 1 with 413 after reading it, leaving no file and no row", async () => {
      const admin = await productAdmin();
      const exact = await upload(admin, templateParts(Buffer.alloc(TEN_MIB, 0x61)));
      expect(exact.statusCode).toBe(201);
      expect(exact.json<{ template: TemplateBody }>().template.sizeBytes).toBe(TEN_MIB);
      const before = await filesUnder(root);

      const over = await upload(admin, templateParts(Buffer.alloc(TEN_MIB + 1, 0x61)));

      expectRefusal(over, 413, "test_file_too_large", MESSAGES.tooLarge);
      expect(await templateRows()).toHaveLength(1);
      expect(await filesUnder(root)).toEqual(before);
      expect(await auditRows()).toHaveLength(1);
    });

    const data = Buffer.from("{}\n");
    const file: Part = { name: "file", filename: "events.json", data };
    const fields = (overrides: Record<string, string> = {}): Part[] =>
      templateParts(data, overrides).slice(0, 4);
    it.each<[string, Part[]]>([
      ["the file first", [file, ...fields()]],
      ["the description before the name", [fields()[1]!, fields()[0]!, ...fields().slice(2), file]],
      ["the signal before the receiver type", [...fields().slice(0, 2), fields()[3]!, fields()[2]!, file]],
      ["no description", [fields()[0]!, ...fields().slice(2), file]],
      ["no signal", [...fields().slice(0, 3), file]],
      ["no file", fields()],
      ["a field after the file", [...fields(), file, { name: "extra", value: "x" }]],
      ["a second file", [...fields(), file, { ...file, filename: "more.json" }]],
      ["a misnamed file part", [...fields(), { ...file, name: "upload" }]],
      ["the name as a file", [{ name: "name", filename: "a.json", data }, ...fields().slice(1), file]],
      ["a test file upload's parts", [{ name: "displayName", value: "a" }, { name: "description", value: "" }, file]],
      ["an empty name", templateParts(data, { name: "   " })],
      ["a 201-character name", templateParts(data, { name: "a".repeat(201) })],
      ["a 2,001-character description", templateParts(data, { description: "d".repeat(2_001) })],
      ["a field over 8 KiB", templateParts(data, { description: "é".repeat(4_200) })],
      ["a receiver type off the palette's list", templateParts(data, { receiverType: "kafka" })],
      ["a receiver type in upper case", templateParts(data, { receiverType: "OTLP" })],
      ["an unknown signal", templateParts(data, { signal: "profiles" })],
      ["a 256-character file name", templateParts(data, { filename: `${"f".repeat(251)}.json` })],
    ])("refuses %s with 400, leaving nothing behind", async (_label, parts) => {
      const admin = await productAdmin();
      const response = await upload(admin, parts);
      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(await templateRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("refuses a field over 8 KiB that trims to a valid one (busboy's fieldSize, not the contract's length): 9,000 spaces and an x is 400; 8,000 spaces and an x saves as x", async () => {
      const admin = await productAdmin();
      const data = Buffer.from("x");

      const over = await upload(admin, templateParts(data, { description: `${" ".repeat(9_000)}x` }));

      expectRefusal(over, 400, "invalid_request", MESSAGES.invalid);
      expect(await templateRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
      // The control: under 8 KiB, the same value trims to a valid description.
      expect((await created(admin, data, { description: `${" ".repeat(8_000)}x` })).description).toBe("x");
    });

    it("reads the parts in TEST_TEMPLATE_PART_NAMES' order", () => {
      expect(TEST_TEMPLATE_PART_NAMES).toEqual(["name", "description", "receiverType", "signal", "file"]);
      expect(templateParts(data).map((part) => part.name)).toEqual([...TEST_TEMPLATE_PART_NAMES]);
    });

    it("refuses a body that isn't multipart with 400", async () => {
      const admin = await productAdmin();
      const response = await call(admin, "POST", TEMPLATES, { name: "a", description: "", receiverType: "otlp", signal: "logs" });
      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(await templateRows()).toEqual([]);
    });

    it("refuses a member (403 product_admin_required) and a signed-out caller (401) before reading the body, writing nothing", async () => {
      const member = await person({ role: "admin" });
      const parts = templateParts(Buffer.alloc(TEN_MIB, 0x61));

      expectRefusal(await upload(member, parts), 403, "product_admin_required", MESSAGES.productAdminRequired);
      expectRefusal(await upload(undefined, parts), 401, "unauthenticated", MESSAGES.unauthenticated);

      expect(writes).toEqual([]);
      expect(await templateRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("needs no current terms of a product admin, as flows' writes", async () => {
      const admin = await productAdmin({ hasAcceptedTerms: false });
      expect((await upload(admin, templateParts(Buffer.from("x")))).statusCode).toBe(201);
    });

    it("answers each refusal over a real connection, the unread body dropped, and the connection serves the next request", async () => {
      const admin = await productAdmin();
      const member = await person();
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
      const sendUpload = (parts: Part[], who?: Person) => {
        const { payload, headers } = multipartBody(parts);
        return send("POST", TEMPLATES, payload, {
          ...csrfHeaders,
          ...headers,
          ...(who === undefined ? {} : { cookie: `telflo_access=${who.access}` }),
        });
      };
      const big = Buffer.alloc(TEN_MIB, 0x61);

      try {
        const unauthenticated = await sendUpload(templateParts(big));
        const forbidden = await sendUpload(templateParts(big), member);
        const outOfOrder = await sendUpload([{ name: "file", filename: "events.json", data: Buffer.alloc(5 * MIB, 0x61) }, ...templateParts(big).slice(0, 4)], admin);
        const tooLarge = await sendUpload([...templateParts(Buffer.alloc(TEN_MIB + 1, 0x61)), { name: "extra", value: "x" }], admin);
        const next = await send("GET", TEMPLATES, undefined, { cookie: `telflo_access=${member.access}` });

        expect([unauthenticated.status, forbidden.status, outOfOrder.status, tooLarge.status]).toEqual([401, 403, 400, 413]);
        expect(JSON.parse(forbidden.body)).toEqual({
          error: { code: "product_admin_required", message: MESSAGES.productAdminRequired },
        });
        expect(next.status).toBe(200);
        expect(JSON.parse(next.body)).toEqual({ templates: [] });
        expect(writes).toHaveLength(1);
        expect(await filesUnder(root)).toEqual([]);
      } finally {
        agent.destroy();
      }
    });

    it("removes the bytes when the row can't be saved (500), leaving no row and no audit row", async () => {
      const admin = await productAdmin();
      await withFailingInsert(databases.ownerDb, "test_templates", "raise exception 'refused for the test'", async () => {
        expect((await upload(admin, templateParts(Buffer.from("x")))).statusCode).toBe(500);
      });
      expect(await templateRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("isn't rate limited: a product admin's 31 uploads in a minute all save (RATE_LIMITS)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      for (let n = 0; n < 31; n += 1) {
        expect((await upload(admin, templateParts(Buffer.from("x")), { on: limited })).statusCode).toBe(201);
      }
      expect(await templateRows()).toHaveLength(31);
    });
  });

  describe("changing one (PATCH, product admins only, metadata only)", () => {
    it("changes the fields given, moving updated_at, and audits the changed fields' names only", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      const at = tick();

      const response = await call(admin, "PATCH", templatePathOf(template.id), {
        name: `  Renamed ${NAME_MARKER}  `,
        description: `Described ${DESCRIPTION_MARKER}`,
        receiverType: "syslog",
        signal: "logs",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ template: TemplateBody }>().template).toEqual({
        ...template,
        name: `Renamed ${NAME_MARKER}`,
        description: `Described ${DESCRIPTION_MARKER}`,
        receiverType: "syslog",
        updatedAt: at.toISOString(),
      });
      const audits = await auditRows();
      expect(audits.map((row) => [row.action, row.organization_id, row.subject_id, row.metadata])).toEqual([
        ["test_template.created", null, template.id, {}],
        // The signal was already logs: only what changed.
        ["test_template.updated", null, template.id, { changedFields: ["name", "description", "receiverType"] }],
      ]);
      // The file never changes.
      expect(await readFile(join(root, templatePath(template.id)))).toEqual(Buffer.from('{"resourceLogs":[]}\n'));
    });

    it("answers an empty PATCH ({}) and one changing nothing with the template as it is (200), writing and auditing nothing, as a flow's", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      tick();
      for (const body of [{}, { name: template.name, signal: template.signal }]) {
        const response = await call(admin, "PATCH", templatePathOf(template.id), body);
        expect(response.statusCode).toBe(200);
        expect(response.json<{ template: TemplateBody }>().template).toEqual(template);
      }
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_template.created"]);
      expect((await templateRows())[0]!.updated_at).toEqual(new Date(template.updatedAt));
    });

    it("refuses a file, an unknown field, a receiver type off the list and an empty name (400), changing nothing", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      for (const body of [{ fileName: "other.json" }, { sizeBytes: 1 }, { receiverType: "kafka" }, { name: "  " }, { signal: "profiles" }]) {
        const response = await call(admin, "PATCH", templatePathOf(template.id), body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_template.created"]);
    });

    it("answers a deleted, an unknown, a nil and a malformed id with 404 test_template_not_found; an id in upper case is the same template (canonicalIdOf)", async () => {
      const admin = await productAdmin();
      const deleted = await created(admin);
      expect((await call(admin, "DELETE", templatePathOf(deleted.id))).statusCode).toBe(204);
      for (const id of [deleted.id, randomUUID(), "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        expectRefusal(await call(admin, "PATCH", templatePathOf(id), { name: "x" }), 404, "test_template_not_found", MESSAGES.templateNotFound);
      }
      const live = await created(admin);
      const renamed = await call(admin, "PATCH", templatePathOf(live.id.toUpperCase()), { name: "Upper" });
      expect(renamed.json<{ template: TemplateBody }>().template).toMatchObject({ id: live.id, name: "Upper" });
      // A deleted template's metadata stays as it was (the API changes live ones only).
      expect((await templateRows()).find((row) => row.id === deleted.id)!.name).toBe(deleted.name);
    });
  });

  describe("deleting one (DELETE, product admins only)", () => {
    it("deletes it softly (204) with an audit row of ids in no organization, then removes its bytes; a second delete is 404", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      const at = tick();

      expect((await call(admin, "DELETE", templatePathOf(template.id.toUpperCase()))).statusCode).toBe(204);

      const [row] = await templateRows();
      expect(row).toMatchObject({ id: template.id, deleted_at: at, name: template.name });
      expect(await templateFiles()).toEqual([]);
      expect((await auditRows()).map((audit) => [audit.action, audit.organization_id, audit.subject_id, audit.metadata])).toEqual([
        ["test_template.created", null, template.id, {}],
        ["test_template.deleted", null, template.id, {}],
      ]);
      expectRefusal(await call(admin, "DELETE", templatePathOf(template.id)), 404, "test_template_not_found", MESSAGES.templateNotFound);
      expect(await auditRows()).toHaveLength(2);
    });

    it("answers an unknown, a nil and a malformed id with 404 test_template_not_found, deleting nothing", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      for (const id of [randomUUID(), "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        expectRefusal(await call(admin, "DELETE", templatePathOf(id)), 404, "test_template_not_found", MESSAGES.templateNotFound);
      }
      expect((await templateRows()).map((row) => row.deleted_at)).toEqual([null]);
      expect(await templateFiles()).toEqual([templatePath(template.id)]);
    });

    it("answers 204 when the bytes can't be removed, logging only the error's code and syscall", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      isRemoveFailing = true;
      logLines = [];

      expect((await call(admin, "DELETE", templatePathOf(template.id))).statusCode).toBe(204);

      expect((await templateRows())[0]!.deleted_at).not.toBeNull();
      const warnings = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === 40);
      expect(warnings).toEqual([
        expect.objectContaining({ code: "EROFS", syscall: "unlink", msg: "a test template's bytes could not be removed" }),
      ]);
      expect(JSON.stringify(warnings)).not.toContain(template.id);
    });

    it("answers 404 on both file reads of a template deleted while its bytes couldn't be removed: the live row decides, not the bytes left behind", async () => {
      const admin = await productAdmin();
      const member = await person();
      const template = await created(admin);
      isRemoveFailing = true;

      expect((await call(admin, "DELETE", templatePathOf(template.id))).statusCode).toBe(204);

      // The bytes are still in the store...
      expect(await templateFiles()).toEqual([templatePath(template.id)]);
      // ...and no member reads them.
      for (const url of [filePathOf(template.id), headPathOf(template.id)]) {
        expectRefusal(await call(member, "GET", url), 404, "test_template_not_found", MESSAGES.templateNotFound);
      }
    });

    it("commits the row before the bytes go: a delete whose transaction fails leaves the template live with its bytes; one that commits removes them only after", async () => {
      const admin = await productAdmin();
      const member = await person();
      const bytes = Buffer.from('{"resourceLogs":["kept"]}\n');
      const template = await created(admin, bytes);
      const removals: FileKey[] = [];
      beforeRemove = async (key) => void removals.push(key);

      // The audit row can't be written, so the delete's transaction rolls back.
      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'refused for the test'", async () => {
        expect((await call(admin, "DELETE", templatePathOf(template.id))).statusCode).toBe(500);
      });

      expect((await templateRows()).map((row) => row.deleted_at)).toEqual([null]);
      expect(removals).toEqual([]);
      expect(await templateFiles()).toEqual([templatePath(template.id)]);
      expect((await call(member, "GET", filePathOf(template.id))).rawPayload).toEqual(bytes);
      expect((await call(member, "GET", TEMPLATES)).json<{ templates: TemplateBody[] }>().templates.map((each) => each.id)).toEqual([
        template.id,
      ]);

      // The delete that commits: at the removal, another connection already sees the row deleted.
      const at = tick();
      const seenAtRemoval: Array<Date | null> = [];
      beforeRemove = async () => {
        const row = await databases.ownerDb
          .selectFrom("test_templates")
          .select("deleted_at")
          .where("id", "=", template.id)
          .executeTakeFirstOrThrow();
        seenAtRemoval.push(row.deleted_at);
      };

      expect((await call(admin, "DELETE", templatePathOf(template.id))).statusCode).toBe(204);

      expect(seenAtRemoval).toEqual([at]);
      expect(await templateFiles()).toEqual([]);
    });
  });

  describe("who may write", () => {
    it("refuses a member, an organization's admin included, every write with 403 product_admin_required, writing nothing", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      for (const member of [await person(), await person({ role: "admin" })]) {
        expectRefusal(await upload(member, templateParts(Buffer.from("x"))), 403, "product_admin_required", MESSAGES.productAdminRequired);
        expectRefusal(
          await call(member, "PATCH", templatePathOf(template.id), { name: "Taken" }),
          403,
          "product_admin_required",
          MESSAGES.productAdminRequired,
        );
        expectRefusal(await call(member, "DELETE", templatePathOf(template.id)), 403, "product_admin_required", MESSAGES.productAdminRequired);
      }
      expect((await templateRows()).map((row) => [row.name, row.deleted_at])).toEqual([[template.name, null]]);
      expect(await templateFiles()).toEqual([templatePath(template.id)]);
      expect((await auditRows()).map((row) => row.action)).toEqual(["test_template.created"]);
    });

    it("refuses a product admin whose flag is revoked on the very next request (403)", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      await databases.ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", admin.userId).execute();
      expectRefusal(await call(admin, "DELETE", templatePathOf(template.id)), 403, "product_admin_required", MESSAGES.productAdminRequired);
      expect((await templateRows())[0]!.deleted_at).toBeNull();
    });

    it("needs a session on every endpoint (401)", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      expect((await upload(undefined, templateParts(Buffer.from("x")))).statusCode).toBe(401);
      for (const [method, url, body] of [
        ["GET", TEMPLATES, undefined],
        ["PATCH", templatePathOf(template.id), { name: "x" }],
        ["DELETE", templatePathOf(template.id), undefined],
        ["GET", filePathOf(template.id), undefined],
        ["GET", headPathOf(template.id), undefined],
      ] as const) {
        expectRefusal(await call(undefined, method, url, body), 401, "unauthenticated", MESSAGES.unauthenticated);
      }
      expect((await templateRows()).map((row) => [row.name, row.deleted_at])).toEqual([[template.name, null]]);
    });
  });

  describe("members' reads", () => {
    it("lists the live templates, newest first (created_at, then id), to any member with the current terms; a deleted one disappears", async () => {
      const admin = await productAdmin();
      const member = await person();
      const first = await created(admin);
      tick();
      const second = await created(admin);
      tick();
      const third = await created(admin);
      // Two of one created_at, the newest: the id, descending, breaks the tie.
      tick();
      const tied = [
        await addTestTemplate(databases.ownerDb, { created_at: clock, name: `Tied ${randomUUID()}` }),
        await addTestTemplate(databases.ownerDb, { created_at: clock, name: `Tied ${randomUUID()}` }),
      ].sort((a, b) => (a.id < b.id ? 1 : -1));

      const listed = await call(member, "GET", TEMPLATES);
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json<{ templates: TemplateBody[] }>().templates.map((template) => template.id)).toEqual([
        ...tied.map((template) => template.id),
        third.id,
        second.id,
        first.id,
      ]);
      expect(listed.json<{ templates: TemplateBody[] }>().templates[2]).toEqual(third);

      expect((await call(admin, "DELETE", templatePathOf(second.id))).statusCode).toBe(204);
      expect(
        (await call(member, "GET", TEMPLATES)).json<{ templates: TemplateBody[] }>().templates.map((template) => template.id),
      ).not.toContain(second.id);
    });

    it("lists at most 1,000 (TEST_TEMPLATES_LIST_MAXIMUM), the newest", async () => {
      const member = await person();
      await sql`
        insert into test_templates (name, receiver_type, signal, file_name, content_type, size_bytes, sha256, created_at, updated_at)
        select 'Seeded ' || n, 'otlp', 'logs', 'sample.json', 'application/json', 0, sha256(''::bytea),
               ${clock}::timestamptz + make_interval(secs => n), ${clock}::timestamptz + make_interval(secs => n)
          from generate_series(1, 1001) as n
      `.execute(databases.ownerDb);
      const templates = (await call(member, "GET", TEMPLATES)).json<{ templates: TemplateBody[] }>().templates;
      expect(templates).toHaveLength(1_000);
      expect(templates[0]!.name).toBe("Seeded 1001");
      expect(templates.at(-1)!.name).toBe("Seeded 2");
    });

    it("refuses a member without the current terms (403 terms_acceptance_required) on the list and both file reads", async () => {
      const admin = await productAdmin();
      const template = await created(admin);
      const member = await person({ hasAcceptedTerms: false });
      for (const url of [TEMPLATES, filePathOf(template.id), headPathOf(template.id)]) {
        expectRefusal(await call(member, "GET", url), 403, "terms_acceptance_required", MESSAGES.termsRequired);
      }
    });

    it("lists the templates to a product admin without the current terms, as the flows admin list reads (the admin page's list); the file reads still need them", async () => {
      const admin = await productAdmin({ hasAcceptedTerms: false });
      const template = await created(admin);
      const listed = await call(admin, "GET", TEMPLATES);
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ templates: TemplateBody[] }>().templates.map((each) => each.id)).toEqual([template.id]);
      for (const url of [filePathOf(template.id), headPathOf(template.id)]) {
        expectRefusal(await call(admin, "GET", url), 403, "terms_acceptance_required", MESSAGES.termsRequired);
      }
    });

    it("streams a template's bytes whole, as bytes, never sniffed, a download under a generic name, never cached", async () => {
      const admin = await productAdmin();
      const member = await person();
      // UTF-16 with its NULs: bytes, exactly.
      const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}\n', "utf16le"), Buffer.alloc(HEAD_BYTES * 2, 0x62)]);
      const template = await created(admin, data);

      const response = await call(member, "GET", filePathOf(template.id.toUpperCase()));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-disposition": 'attachment; filename="template"',
        "cache-control": "no-store",
        "content-length": String(data.length),
      });
      expect(JSON.stringify(response.headers)).not.toContain(FILE_MARKER);
    });

    it("answers the first 64 KiB of a larger template as its head, and a smaller one whole, under no name", async () => {
      const admin = await productAdmin();
      const member = await person();
      const large = Buffer.alloc(HEAD_BYTES + 100, 0x61);
      large[HEAD_BYTES - 1] = 0x7a;
      const small = Buffer.from('{"resourceLogs":[]}\n');
      const [big, little] = [await created(admin, large), await created(admin, small)];

      const head = await call(member, "GET", headPathOf(big.id));
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload).toEqual(large.subarray(0, HEAD_BYTES));
      expect(head.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-disposition": "attachment",
        "cache-control": "no-store",
        "content-length": String(HEAD_BYTES),
      });
      expect((await call(member, "GET", headPathOf(little.id))).rawPayload).toEqual(small);
    });

    it("answers a deleted, an unknown, a nil and a malformed template, and one whose bytes are gone, with 404 on both file reads", async () => {
      const admin = await productAdmin();
      const member = await person();
      const deleted = await created(admin);
      expect((await call(admin, "DELETE", templatePathOf(deleted.id))).statusCode).toBe(204);
      const bytesGone = await created(admin);
      await store.remove({ kind: "test-template", templateId: bytesGone.id });
      for (const id of [deleted.id, bytesGone.id, randomUUID(), "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        for (const url of [filePathOf(id), headPathOf(id)]) {
          expectRefusal(await call(member, "GET", url), 404, "test_template_not_found", MESSAGES.templateNotFound);
        }
      }
    });

    it("counts the head and the whole file together in a per-person budget of their own (user:<id>: this global route has no organization; RATE_LIMITS: 30 a minute); the list isn't counted", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      const template = await created(admin);
      const ana = await person();
      const ben = await person();
      const anaReads = async (url: string) => (await call(ana, "GET", url, undefined, { on: limited })).statusCode;
      // 15 heads and 15 whole files: 30 together.
      for (let n = 0; n < 15; n += 1) {
        expect(await anaReads(headPathOf(template.id))).toBe(200);
        expect(await anaReads(filePathOf(template.id))).toBe(200);
      }
      for (const url of [filePathOf(template.id), headPathOf(template.id)]) {
        expectRefusal(await call(ana, "GET", url, undefined, { on: limited }), 429, "rate_limited", MESSAGES.uploadsLimited);
      }
      // Another person has their own 30.
      expect((await call(ben, "GET", filePathOf(template.id), undefined, { on: limited })).statusCode).toBe(200);
      expect((await call(ben, "GET", headPathOf(template.id), undefined, { on: limited })).statusCode).toBe(200);
      // The list isn't counted.
      expect(await anaReads(TEMPLATES)).toBe(200);
    });

    it("counts a whole-file read on its own: 30 in a minute, then 429", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      const template = await created(admin);
      const ana = await person();
      for (let n = 0; n < 30; n += 1) {
        expect((await call(ana, "GET", filePathOf(template.id), undefined, { on: limited })).statusCode).toBe(200);
      }
      expectRefusal(await call(ana, "GET", filePathOf(template.id), undefined, { on: limited }), 429, "rate_limited", MESSAGES.uploadsLimited);
    });

    it("counts a read answered 404 before the template is looked up: 30 refused reads spend the minute", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      const template = await created(admin);
      const ana = await person();
      const unknown = randomUUID();
      // 15 heads and 15 whole files of a template that isn't there: each 404, each counted.
      for (let n = 0; n < 15; n += 1) {
        for (const url of [headPathOf(unknown), filePathOf(unknown)]) {
          expectRefusal(await call(ana, "GET", url, undefined, { on: limited }), 404, "test_template_not_found", MESSAGES.templateNotFound);
        }
      }
      // The live template's reads are then refused: the 404s spent the 30.
      for (const url of [filePathOf(template.id), headPathOf(template.id)]) {
        expectRefusal(await call(ana, "GET", url, undefined, { on: limited }), 429, "rate_limited", MESSAGES.uploadsLimited);
      }
    });
  });

  describe("a deleted template's definitions", () => {
    it("a definition made from a template before its delete still runs, from its own copy: the template leaves the list and its file reads 404", async () => {
      const admin = await productAdmin();
      const ana = await person({ role: "admin" });
      const data = Buffer.from('{"resourceLogs":[{"fromTemplate":true}]}\n');
      const template = await created(admin, data);
      const configuration = await addConfiguration(databases.ownerDb, {
        organizationId: ana.organizationId,
        created_by_user_id: ana.userId,
      });
      const version = await addConfigurationVersion(databases.ownerDb, {
        configurationId: configuration.id,
        organizationId: ana.organizationId,
        created_by_user_id: ana.userId,
      });
      const versionPath = `/api/v1/organizations/${ana.organizationId}/configurations/${configuration.id}/versions/${version.id}`;
      const suite = await call(ana, "POST", `${versionPath}/test-suites`, { name: `Smoke ${randomUUID()}` });
      expect(suite.statusCode).toBe(201);
      const suiteId = suite.json<{ suite: { id: string } }>().suite.id;
      const definitionsPath = `${versionPath}/test-suites/${suiteId}/definitions`;
      const definition = await call(ana, "POST", definitionsPath, {
        templateId: template.id,
        name: `Logs ${randomUUID()}`,
        description: "",
        pipeline: "logs",
        signal: "logs",
        durationSeconds: 5,
      });
      expect(definition.statusCode).toBe(201);
      const definitionId = definition.json<{ definition: { id: string } }>().definition.id;

      expect((await call(admin, "DELETE", templatePathOf(template.id))).statusCode).toBe(204);

      expect((await call(ana, "GET", TEMPLATES)).json<{ templates: TemplateBody[] }>().templates).toEqual([]);
      expectRefusal(await call(ana, "GET", filePathOf(template.id)), 404, "test_template_not_found", MESSAGES.templateNotFound);
      expect(await templateFiles()).toEqual([]);
      // A new definition from it is refused; the one made before keeps its own copy.
      expectRefusal(
        await call(ana, "POST", definitionsPath, {
          templateId: template.id,
          name: "Too late",
          description: "",
          pipeline: "logs",
          signal: "logs",
          durationSeconds: 5,
        }),
        404,
        "test_template_not_found",
        MESSAGES.templateNotFound,
      );
      const head = await call(ana, "GET", `${definitionsPath}/${definitionId}/input/head`);
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload).toEqual(data);
      const { version: collectorVersion } = await databases.ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", "otelcol-contrib")
        .where("is_default", "=", true)
        .executeTakeFirstOrThrow();

      const queued = await call(ana, "POST", `${versionPath}/test-runs`, { definitionId, yaml: RUN_TEXT, collectorVersion });

      expect(queued.statusCode).toBe(201);
      const { run } = queued.json<{ run: { id: string; inputName: string; inputSizeBytes: number; definitionId: string } }>();
      expect(run).toMatchObject({ inputName: template.fileName, inputSizeBytes: data.length, definitionId });
      expect(await readFile(join(root, "organizations", ana.organizationId, "test-runs", run.id, "input"))).toEqual(data);
    });
  });

  describe("privacy", () => {
    it("puts no template's name, description or file name in any audit row or log line", async () => {
      const admin = await productAdmin();
      const member = await person();
      const template = await created(admin);
      await call(admin, "PATCH", templatePathOf(template.id), {
        name: `Renamed ${NAME_MARKER}`,
        description: `Described ${DESCRIPTION_MARKER}`,
      });
      await call(member, "GET", TEMPLATES);
      await call(member, "GET", filePathOf(template.id));
      await call(member, "GET", headPathOf(template.id));
      await upload(member, templateParts(Buffer.from("x")));
      await upload(admin, templateParts(Buffer.from("x"), { filename: `events-${FILE_MARKER}.csv` }));
      await upload(admin, templateParts(Buffer.from("x"), { receiverType: `kafka${NAME_MARKER}` }));
      await call(admin, "DELETE", templatePathOf(template.id));

      const audits = await auditRows();
      expect(audits.map((row) => row.action)).toEqual([
        "test_template.created",
        "test_template.updated",
        "test_template.deleted",
      ]);
      expect(logLines.length).toBeGreaterThan(0);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, FILE_MARKER]) {
        expect(JSON.stringify(audits)).not.toContain(marker);
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }
    });
  });
});
