import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LIBRARY_FILE_PART_NAMES,
  LIBRARY_LINK_PATH_PATTERN,
} from "@telflo/contracts";
import type { OrganizationRole } from "@telflo/db";
import {
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { createFileStore } from "../../file-store/create-file-store.js";
import { FileStoreError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import { DOWNLOADS_BUSY_MESSAGE, PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT } from "../../http/public-download.js";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings, type LibraryLinkSigningKeys } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { createLibraryLinks } from "./link.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const MIB = 1_048_576;
const TEN_MIB = 10 * MIB;
const FILES = "/api/v1/library-files";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Markers no log line, header or audit row may hold: a file's name, its description and its file's name. */
const NAME_MARKER = "library-name-marker-4b1e";
const DESCRIPTION_MARKER = "library-description-marker-90c7";
const FILE_MARKER = "library-file-marker-d3a8";

/** The words, exactly. */
const MESSAGES = {
  fileNotFound: "Library file not found",
  productAdminRequired: "Only a product admin can do that.",
  termsRequired: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  tooLarge: "The file must be 10 MB or smaller.",
  invalid: "The request was not valid.",
  limited: "Too many attempts. Please wait and try again.",
};

/**
 * A part: a field, or a file. A file's `filename` goes in `filename="…"`, or,
 * with `filenameStar`, as RFC 5987's `filename*=UTF-8''…` (already
 * percent-encoded), which the upload's parser decodes as UTF-8.
 */
type Part =
  | { name: string; value: string }
  | { name: string; filename: string; filenameStar?: true; data: Buffer; contentType?: string };

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
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; ` +
            (part.filenameStar ? `filename*=UTF-8''${part.filename}\r\n` : `filename="${part.filename}"\r\n`) +
            `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`,
          "utf8",
        ),
        part.data,
        Buffer.from("\r\n"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** The bidirectional controls and invisible characters a file's name may not hold. */
const REFUSED_FORMAT_CHARACTERS: [string, string][] = [
  ["U+061C", "\u061C"],
  ["U+200B", "\u200B"],
  ["U+200E", "\u200E"],
  ["U+200F", "\u200F"],
  ["U+202A", "\u202A"],
  ["U+202B", "\u202B"],
  ["U+202C", "\u202C"],
  ["U+202D", "\u202D"],
  ["U+202E", "\u202E"],
  ["U+2060", "\u2060"],
  ["U+2066", "\u2066"],
  ["U+2067", "\u2067"],
  ["U+2068", "\u2068"],
  ["U+2069", "\u2069"],
  ["U+FEFF", "\uFEFF"],
];

/** A file's three parts, in order (LIBRARY_FILE_PART_NAMES), its name unique to the test. */
function fileParts(data: Buffer, options: { name?: string; description?: string; filename?: string; contentType?: string } = {}): Part[] {
  return [
    { name: "name", value: options.name ?? `Getting started ${NAME_MARKER} ${randomUUID()}` },
    { name: "description", value: options.description ?? `A guide ${DESCRIPTION_MARKER}` },
    {
      name: "file",
      filename: options.filename ?? `guide-${FILE_MARKER}.pdf`,
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

/** A key as an operator would set one, built at run time: a secret, never printed. */
const newKey = () => Buffer.from(randomBytes(32).toString("base64url"), "utf8");

/*
 * The library API, against Postgres as the API's own role, with a real
 * file store on a temporary directory. Product admins write; members list,
 * download and make links; anyone holding a link downloads the file.
 *
 * A link made with a real key is a secret: every check on one is a boolean,
 * and none is printed. `linkLeaked` checks the log lines and every audit row
 * for any link this file made.
 */
describe("the library API", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let root: string;
  let store: IFileStore;
  let logLines: string[] = [];
  /** Every link's text after `tll_` this file made, to look for in the logs and the audit rows. */
  const madeLinks: string[] = [];
  /** While true, every removal fails as a read-only disk would. */
  let isRemoveFailing = false;
  /** Awaited before each removal, while it is set. */
  let beforeRemove: ((key: FileKey) => Promise<void>) | undefined;
  /** While set, every read answers a stream the test ends itself, held here. */
  let heldReads: PassThrough[] | undefined;
  /** Every key the store was asked to write since the test began. */
  let writes: FileKey[] = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const tick = (ms = 60_000) => {
    clock = new Date(clock.getTime() + ms);
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
    read: async (key) => {
      const opened = await store.read(key);
      if (heldReads === undefined || !opened.found) return opened;
      opened.stream.destroy();
      const held = new PassThrough();
      heldReads.push(held);
      return { found: true, sizeBytes: opened.sizeBytes, stream: held };
    },
  };

  /** A server on the test database, logging every line to `logLines`. */
  async function serverWith(options: { rateLimits?: RateLimits; signingKeys?: LibraryLinkSigningKeys } = {}): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      const settings: AppSettings = loadSettings(process.env);
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: recordingStore,
        testing: UNCALLED_TESTING,
        settings: options.signingKeys === undefined ? settings : { ...settings, library: { signingKeys: options.signingKeys } },
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
    root = await mkdtemp(join(tmpdir(), "telflo-library-files-"));
    store = await createFileStore({ kind: "local", root });
    logLines = [];
    isRemoveFailing = false;
    beforeRemove = undefined;
    heldReads = undefined;
    writes = [];
    clock = new Date(Date.UTC(2026, 9, 24, 9, 0, 0));
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
      await ownerDb.updateTable("users").set({ accepted_terms_version: "2025-01-01" }).where("id", "=", account.user.id).execute();
    }
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return { userId: account.user.id, email: account.user.email, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };
  const productAdmin = (options: { hasAcceptedTerms?: boolean } = {}) => person({ ...options, isProductAdmin: true });

  const call = (
    who: Person | undefined,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    options: { on?: FastifyInstance; csrf?: boolean } = {},
  ) =>
    (options.on ?? server).inject({
      method,
      url,
      headers: options.csrf === false ? {} : csrfHeaders,
      ...(who === undefined ? {} : { cookies: { telflo_access: who.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  /** A file upload as `who` (signed out when undefined). */
  const upload = (who: Person | undefined, parts: Part[], options: { on?: FastifyInstance } = {}) => {
    const { payload, headers } = multipartBody(parts);
    return (options.on ?? server).inject({
      method: "POST",
      url: FILES,
      headers: { ...csrfHeaders, ...headers },
      ...(who === undefined ? {} : { cookies: { telflo_access: who.access } }),
      payload,
    });
  };

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({ status: statusCode, body: { error: { code, message } } });
  }

  /**
   * A refusal on a route whose success may be a link's 201 `{ path }` (POST
   * …/link): booleans only, so a refusal that breaks prints no link. The
   * body is checked for a link first, then the status, the code and the
   * message, each compared as a boolean.
   */
  function expectRefusalHoldingNoLink(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = undefined;
    }
    const path = (parsed as { path?: unknown } | undefined)?.path;
    expect(typeof path === "string" && LIBRARY_LINK_PATH_PATTERN.test(path)).toBe(false);
    expect(/tll_/i.test(response.body)).toBe(false);
    expect(response.statusCode === statusCode).toBe(true);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    expect(error?.code === code).toBe(true);
    expect(error?.message === message).toBe(true);
  }

  /** A public route's plain-text refusal. */
  function expectPlainRefusal(response: LightMyRequestResponse, statusCode: number, text: string): void {
    expect({ status: response.statusCode, body: response.body, type: response.headers["content-type"] }).toEqual({
      status: statusCode,
      body: `${text}\n`,
      type: "text/plain; charset=utf-8",
    });
  }

  interface FileBody {
    id: string;
    name: string;
    description: string;
    fileName: string;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
  }

  /** A file `admin` uploads, through the API. */
  const created = async (admin: Person, data: Buffer = Buffer.from("%PDF-1.7 guide\n"), options: Parameters<typeof fileParts>[1] = {}) => {
    const response = await upload(admin, fileParts(data, options));
    expect(response.statusCode).toBe(201);
    return response.json<{ libraryFile: FileBody }>().libraryFile;
  };

  const fileRows = () => databases.ownerDb.selectFrom("library_files").selectAll().orderBy("created_at").orderBy("id").execute();
  const filePath = (fileId: string) => join("global", "library-files", fileId);
  const libraryFiles = async () => (await filesUnder(root)).filter((path) => path.includes("library-files"));
  const auditRows = () =>
    databases.ownerDb.selectFrom("audit_events").selectAll().where("action", "like", "library_file.%").orderBy("occurred_at").orderBy("id").execute();
  const allAuditText = async () => JSON.stringify(await databases.ownerDb.selectFrom("audit_events").selectAll().execute());
  const filePathOf = (fileId: string) => `${FILES}/${fileId}`;
  const bytesPathOf = (fileId: string) => `${FILES}/${fileId}/file`;
  const linkPathOf = (fileId: string) => `${FILES}/${fileId}/link`;

  /** A link's path for `fileId`, made by `who` through the API: a secret, kept for the leak checks, never printed. */
  const madeLink = async (who: Person, fileId: string, options: { on?: FastifyInstance } = {}): Promise<string> => {
    const response = await call(who, "POST", linkPathOf(fileId), undefined, options);
    expect(response.statusCode).toBe(201);
    const { path } = response.json<{ path: string }>();
    expect(LIBRARY_LINK_PATH_PATTERN.test(path)).toBe(true);
    madeLinks.push(path.slice("/api/v1/library-links/tll_".length));
    return path;
  };

  /** Whether any log line or audit row holds any link this file made: a boolean, never the link. */
  const linkLeaked = async () => {
    const text = `${logLines.join("\n")}\n${await allAuditText()}`;
    return madeLinks.some((body) => text.includes(body));
  };

  /** A GET with no session, no cookie and no CSRF header: what a pasted curl sends. */
  const fetchLink = (path: string, options: { on?: FastifyInstance; method?: "GET" | "HEAD" } = {}) =>
    (options.on ?? server).inject({ method: options.method ?? "GET", url: path });

  describe("creating one (POST, product admins only)", () => {
    it("streams the file to the store, then saves the row and an audit row of ids in no organization; any type", async () => {
      const admin = await productAdmin();
      const data = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe, 0x00, 0x01]);
      const name = `  Getting started ${NAME_MARKER} ${randomUUID()}  `;

      const response = await upload(admin, fileParts(data, { name, filename: `setup-${FILE_MARKER}.exe`, contentType: "text/html" }));

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { libraryFile } = response.json<{ libraryFile: FileBody }>();
      expect(libraryFile).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        name: name.trim(),
        description: `A guide ${DESCRIPTION_MARKER}`,
        fileName: `setup-${FILE_MARKER}.exe`,
        sizeBytes: data.length,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      });
      const [row] = await fileRows();
      expect(row).toMatchObject({ id: libraryFile.id, created_by_user_id: admin.userId, size_bytes: data.length, created_at: clock });
      expect(row!.sha256.toString("hex")).toBe(sha256Of(data));
      expect(await libraryFiles()).toEqual([filePath(libraryFile.id)]);
      expect(await readFile(join(root, filePath(libraryFile.id)))).toEqual(data);
      expect(await auditRows()).toEqual([
        expect.objectContaining({
          action: "library_file.created",
          actor_user_id: admin.userId,
          actor_email: admin.email,
          organization_id: null,
          subject_type: "library_file",
          subject_id: libraryFile.id,
          metadata: {},
        }),
      ]);
      // Telflo's own content reaches no log line and no audit row.
      const logged = logLines.join("\n");
      const audited = await allAuditText();
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, FILE_MARKER]) {
        expect(logged.includes(marker), marker).toBe(false);
        expect(audited.includes(marker), marker).toBe(false);
      }
    });

    it("takes an empty file, and an empty description", async () => {
      const admin = await productAdmin();
      const file = await created(admin, Buffer.alloc(0), { description: "" });
      expect(file).toMatchObject({ sizeBytes: 0, description: "" });
    });

    it("accepts exactly 10 MiB, and refuses 10 MiB + 1 with 413 library_file_too_large, leaving no file and no row", async () => {
      const admin = await productAdmin();
      const exact = await upload(admin, fileParts(Buffer.alloc(TEN_MIB, 0x61)));
      expect(exact.statusCode).toBe(201);
      expect(exact.json<{ libraryFile: FileBody }>().libraryFile.sizeBytes).toBe(TEN_MIB);
      const before = await filesUnder(root);

      const over = await upload(admin, fileParts(Buffer.alloc(TEN_MIB + 1, 0x61)));

      expectRefusal(over, 413, "library_file_too_large", MESSAGES.tooLarge);
      expect(await fileRows()).toHaveLength(1);
      expect(await filesUnder(root)).toEqual(before);
      expect(await auditRows()).toHaveLength(1);
    });

    const data = Buffer.from("guide\n");
    const file: Part = { name: "file", filename: "guide.pdf", data };
    const [nameField, descriptionField] = fileParts(data) as [Part, Part];
    it.each<[string, Part[]]>([
      ["the file first", [file, nameField, descriptionField]],
      ["the description before the name", [descriptionField, nameField, file]],
      ["no description", [nameField, file]],
      ["no name", [descriptionField, file]],
      ["no file", [nameField, descriptionField]],
      ["a field after the file", [nameField, descriptionField, file, { name: "extra", value: "x" }]],
      ["a second file", [nameField, descriptionField, file, { ...file, filename: "more.pdf" }]],
      ["a misnamed file part", [nameField, descriptionField, { ...file, name: "upload" }]],
      ["the name as a file", [{ name: "name", filename: "a.pdf", data }, descriptionField, file]],
      ["a test template's parts", [nameField, descriptionField, { name: "receiverType", value: "otlp" }, file]],
      ["an empty name", fileParts(data, { name: "   " })],
      ["a 201-character name", fileParts(data, { name: "n".repeat(201) })],
      ["a 2,001-character description", fileParts(data, { description: "d".repeat(2_001) })],
      ["a 256-character file name", fileParts(data, { filename: "f".repeat(256) })],
      ["a file name of -", fileParts(data, { filename: "-" })],
      ["a file name starting with -", fileParts(data, { filename: "-o.txt" })],
      ["a file name of .", fileParts(data, { filename: "." })],
      ["a file name of ..", fileParts(data, { filename: ".." })],
      ["a file name ending in /..", fileParts(data, { filename: "guides/.." })],
      ["a file name holding a tab", fileParts(data, { filename: "a\tb.txt" })],
      ["a file name holding U+0001", fileParts(data, { filename: "a\u0001b.txt" })],
      ["a file name holding DEL", fileParts(data, { filename: "a\u007fb.txt" })],
      // The bidirectional and invisible characters, in UTF-8 through filename and filename*.
      ...REFUSED_FORMAT_CHARACTERS.flatMap(([label, character]): [string, Part[]][] => [
        [`a file name holding ${label} (filename)`, [nameField, descriptionField, { ...file, filename: `a${character}b.txt` }]],
        [
          `a file name holding ${label} (filename*)`,
          [nameField, descriptionField, { ...file, filename: encodeURIComponent(`a${character}b.txt`), filenameStar: true }],
        ],
      ]),
      ["a file name starting with U+202E (filename*)", [nameField, descriptionField, { ...file, filename: "%E2%80%AEtxt.exe", filenameStar: true }]],
    ])("refuses %s with 400 and no details, leaving nothing behind", async (_label, parts) => {
      const admin = await productAdmin();
      const response = await upload(admin, parts);
      expect({ status: response.statusCode, body: response.body }).toEqual({
        status: 400,
        body: JSON.stringify({ error: { code: "invalid_request", message: MESSAGES.invalid } }),
      });
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("keeps only a file name's last segment, as the upload's parser gives it: a name with a slash or a backslash is never stored", async () => {
      const admin = await productAdmin();
      expect((await created(admin, data, { filename: "../../etc/guide.pdf" })).fileName).toBe("guide.pdf");
      expect((await created(admin, data, { filename: "C:\\guides\\setup.exe" })).fileName).toBe("setup.exe");
      expect((await fileRows()).every((row) => !row.file_name.includes("/") && !row.file_name.includes("\\"))).toBe(true);
    });

    it.each([
      ["é (so the refusals above are the characters', not the spelling's)", "a\u00e9b.txt"],
      ["a Persian name's zero-width non-joiner", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt"],
      ["an emoji ZWJ sequence", "\u{1F469}\u200D\u{1F4BB} notes.txt"],
      ["a soft hyphen", "re\u00ADsume.pdf"],
    ])("reads filename and filename* as UTF-8, and stores a name with %s as sent", async (_label, fileName) => {
      const admin = await productAdmin();
      const [name, description] = fileParts(data) as [Part, Part];
      for (const part of [
        { ...file, filename: fileName },
        { ...file, filename: encodeURIComponent(fileName), filenameStar: true as const },
      ]) {
        const response = await upload(admin, [name, description, part]);
        expect(response.statusCode).toBe(201);
        expect(response.json<{ libraryFile: FileBody }>().libraryFile.fileName).toBe(fileName);
      }
    });

    it("reads the parts in LIBRARY_FILE_PART_NAMES' order", () => {
      expect(LIBRARY_FILE_PART_NAMES).toEqual(["name", "description", "file"]);
      expect(fileParts(data).map((part) => part.name)).toEqual([...LIBRARY_FILE_PART_NAMES]);
    });

    it("refuses a body that isn't multipart with 400", async () => {
      const admin = await productAdmin();
      expectRefusal(await call(admin, "POST", FILES, { name: "a", description: "" }), 400, "invalid_request", MESSAGES.invalid);
      expect(await fileRows()).toEqual([]);
    });

    it("removes the bytes when the row can't be saved (500), leaving no row and no audit row", async () => {
      const admin = await productAdmin();
      await withFailingInsert(databases.ownerDb, "library_files", "raise exception 'refused for the test'", async () => {
        expect((await upload(admin, fileParts(data))).statusCode).toBe(500);
      });
      expect(writes).toHaveLength(1);
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("removes the bytes when the audit row can't be saved (500), leaving no row", async () => {
      const admin = await productAdmin();
      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'refused for the test'", async () => {
        expect((await upload(admin, fileParts(data))).statusCode).toBe(500);
      });
      expect(await fileRows()).toEqual([]);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("isn't rate limited: a product admin's 31 uploads in a minute all save (RATE_LIMITS)", async () => {
      const limited = await serverWith({ rateLimits: RATE_LIMITS });
      const admin = await productAdmin();
      for (let n = 0; n < 31; n += 1) {
        expect((await upload(admin, fileParts(Buffer.from("x")), { on: limited })).statusCode).toBe(201);
      }
      expect(await fileRows()).toHaveLength(31);
    });

    it("needs no current terms of a product admin, as test templates' writes", async () => {
      const admin = await productAdmin({ hasAcceptedTerms: false });
      expect((await upload(admin, fileParts(data))).statusCode).toBe(201);
    });
  });

  describe("who may write", () => {
    it("refuses a member, an organization's admin included, every write with 403 product_admin_required, before reading the body, writing nothing", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      writes = [];
      for (const member of [await person(), await person({ role: "admin" })]) {
        expectRefusal(await upload(member, fileParts(Buffer.alloc(TEN_MIB, 0x61))), 403, "product_admin_required", MESSAGES.productAdminRequired);
        expectRefusal(await call(member, "PATCH", filePathOf(file.id), { name: "Taken" }), 403, "product_admin_required", MESSAGES.productAdminRequired);
        expectRefusal(await call(member, "DELETE", filePathOf(file.id)), 403, "product_admin_required", MESSAGES.productAdminRequired);
      }
      expect(writes).toEqual([]);
      expect((await fileRows()).map((row) => [row.id, row.name])).toEqual([[file.id, file.name]]);
      expect(await auditRows()).toHaveLength(1);
    });

    it("refuses a signed-out caller every route with 401, the link's route aside", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      expectRefusal(await upload(undefined, fileParts(Buffer.from("x"))), 401, "unauthenticated", MESSAGES.unauthenticated);
      for (const [method, url] of [
        ["GET", FILES],
        ["PATCH", filePathOf(file.id)],
        ["DELETE", filePathOf(file.id)],
        ["GET", bytesPathOf(file.id)],
        ["POST", linkPathOf(file.id)],
      ] as const) {
        // Every route alike, the link's included: no refusal here may print a link.
        expectRefusalHoldingNoLink(
          await call(undefined, method, url, method === "PATCH" ? { name: "x" } : undefined),
          401,
          "unauthenticated",
          MESSAGES.unauthenticated,
        );
      }
    });
  });

  describe("listing (GET)", () => {
    it("lists the files newest first, for a member with the current terms and a product admin without them; no-store", async () => {
      const admin = await productAdmin();
      const first = await created(admin);
      tick();
      const second = await created(admin, Buffer.from("two"), { description: "" });
      const member = await person();
      for (const who of [member, await productAdmin({ hasAcceptedTerms: false })]) {
        const response = await call(who, "GET", FILES);
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({ libraryFiles: [second, first] });
      }
    });

    it("refuses a member without the current terms (403)", async () => {
      const member = await person({ hasAcceptedTerms: false });
      expectRefusal(await call(member, "GET", FILES), 403, "terms_acceptance_required", MESSAGES.termsRequired);
    });
  });

  describe("changing one (PATCH, product admins only)", () => {
    it("writes and audits only the fields that differ, by name; a same-value change writes and audits nothing", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const at = tick();

      const renamed = await call(admin, "PATCH", filePathOf(file.id), { name: `  Renamed ${NAME_MARKER}  `, description: file.description });

      expect(renamed.statusCode).toBe(200);
      expect(renamed.headers["cache-control"]).toBe("no-store");
      expect(renamed.json()).toEqual({ libraryFile: { ...file, name: `Renamed ${NAME_MARKER}`, updatedAt: at.toISOString() } });
      tick();
      const described = await call(admin, "PATCH", filePathOf(file.id), { description: `New ${DESCRIPTION_MARKER}` });
      expect(described.json<{ libraryFile: FileBody }>().libraryFile.description).toBe(`New ${DESCRIPTION_MARKER}`);
      tick();
      const same = await call(admin, "PATCH", filePathOf(file.id), { name: `Renamed ${NAME_MARKER}` });
      expect(same.json<{ libraryFile: FileBody }>().libraryFile.updatedAt).toBe(described.json<{ libraryFile: FileBody }>().libraryFile.updatedAt);

      expect((await auditRows()).map((row) => [row.action, row.metadata, row.subject_id, row.organization_id])).toEqual([
        ["library_file.created", {}, file.id, null],
        ["library_file.updated", { changedFields: ["name"] }, file.id, null],
        ["library_file.updated", { changedFields: ["description"] }, file.id, null],
      ]);
      expect((await allAuditText()).includes(NAME_MARKER)).toBe(false);
      expect(logLines.join("\n").includes(NAME_MARKER)).toBe(false);
    });

    it.each([
      ["nothing", {}],
      ["a file name", { fileName: "other.pdf" }],
      ["an empty name", { name: "  " }],
      ["a 201-character name", { name: "n".repeat(201) }],
      ["a 2,001-character description", { description: "d".repeat(2_001) }],
    ])("refuses %s with 400", async (_label, body) => {
      const admin = await productAdmin();
      const file = await created(admin);
      const response = await call(admin, "PATCH", filePathOf(file.id), body);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_request");
      expect((await fileRows())[0]).toMatchObject({ name: file.name, description: file.description });
    });

    it.each([
      ["an unknown id", "0199e000-0000-7000-8000-00000000dead"],
      ["a malformed id", "not-a-uuid"],
    ])("answers %s 404 library_file_not_found", async (_label, id) => {
      const admin = await productAdmin();
      expectRefusal(await call(admin, "PATCH", filePathOf(id), { name: "x" }), 404, "library_file_not_found", MESSAGES.fileNotFound);
      expectRefusal(await call(admin, "DELETE", filePathOf(id)), 404, "library_file_not_found", MESSAGES.fileNotFound);
    });

    it("finds an upper-case spelling of the id (canonicalIdOf)", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      expect((await call(admin, "PATCH", filePathOf(file.id.toUpperCase()), { name: "Upper" })).statusCode).toBe(200);
    });
  });

  describe("deleting one (DELETE, product admins only)", () => {
    it("removes the row and audits in one transaction, then the bytes after the commit", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const seenAtRemoval: number[] = [];
      beforeRemove = async () => {
        seenAtRemoval.push((await databases.ownerDb.selectFrom("library_files").select("id").where("id", "=", file.id).execute()).length);
      };

      const response = await call(admin, "DELETE", filePathOf(file.id));

      expect(response.statusCode).toBe(204);
      expect(seenAtRemoval).toEqual([0]);
      expect(await fileRows()).toEqual([]);
      expect(await libraryFiles()).toEqual([]);
      expect((await auditRows()).map((row) => [row.action, row.metadata, row.subject_id])).toEqual([
        ["library_file.created", {}, file.id],
        ["library_file.deleted", {}, file.id],
      ]);
      expectRefusal(await call(admin, "DELETE", filePathOf(file.id)), 404, "library_file_not_found", MESSAGES.fileNotFound);
    });

    it("still deletes the row when the bytes can't be removed, logging the failure's code only", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      isRemoveFailing = true;
      expect((await call(admin, "DELETE", filePathOf(file.id))).statusCode).toBe(204);
      expect(await fileRows()).toEqual([]);
      const warned = logLines.filter((line) => line.includes("a library file's bytes could not be removed"));
      expect(warned).toHaveLength(1);
      expect(JSON.parse(warned[0]!)).toMatchObject({ code: "EROFS", syscall: "unlink" });
    });

    it("keeps the row and its bytes, removing nothing, when the transaction fails (the audit row refused)", async () => {
      const admin = await productAdmin();
      const data = Buffer.from("kept\n");
      const file = await created(admin, data);
      const removals: FileKey[] = [];
      beforeRemove = async (key) => void removals.push(key);
      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'refused for the test'", async () => {
        expect((await call(admin, "DELETE", filePathOf(file.id))).statusCode).toBe(500);
      });
      expect(removals).toEqual([]);
      expect(await fileRows()).toHaveLength(1);
      expect(await libraryFiles()).toEqual([filePath(file.id)]);
      expect((await call(await person(), "GET", bytesPathOf(file.id))).rawPayload.equals(data)).toBe(true);
    });
  });

  describe("downloading one (GET …/file, members with the current terms)", () => {
    it("streams the bytes as an attachment with no name, never sniffed or cached", async () => {
      const admin = await productAdmin();
      const data = randomBytes(4096);
      const file = await created(admin, data);
      const member = await person();

      const response = await call(member, "GET", bytesPathOf(file.id));

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(data)).toBe(true);
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-disposition": "attachment",
        "content-length": String(data.length),
      });
      // No person's text in a header.
      expect(JSON.stringify(response.headers).includes(FILE_MARKER)).toBe(false);
      // Not audited.
      expect(await auditRows()).toHaveLength(1);
    });

    it("refuses a member without the current terms (403), an unknown or malformed id and bytes that are gone (404)", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      expectRefusal(await call(await person({ hasAcceptedTerms: false }), "GET", bytesPathOf(file.id)), 403, "terms_acceptance_required", MESSAGES.termsRequired);
      const member = await person();
      for (const id of ["0199e000-0000-7000-8000-00000000dead", "x"]) {
        expectRefusal(await call(member, "GET", bytesPathOf(id)), 404, "library_file_not_found", MESSAGES.fileNotFound);
      }
      await store.remove({ kind: "library-file", fileId: file.id });
      expectRefusal(await call(member, "GET", bytesPathOf(file.id)), 404, "library_file_not_found", MESSAGES.fileNotFound);
    });

    it("counts a person's downloads, 404s included, on libraryFileDownloadsPerUser: the third of two is 429", async () => {
      const limited = await serverWith({ rateLimits: { ...TEST_RATE_LIMITS, libraryFileDownloadsPerUser: { max: 2, windowMs: 60_000 } } });
      const admin = await productAdmin();
      const file = await created(admin);
      const member = await person();
      expect((await call(member, "GET", bytesPathOf(file.id), undefined, { on: limited })).statusCode).toBe(200);
      expect((await call(member, "GET", bytesPathOf("x"), undefined, { on: limited })).statusCode).toBe(404);
      expectRefusal(await call(member, "GET", bytesPathOf(file.id), undefined, { on: limited }), 429, "rate_limited", MESSAGES.limited);
      // Another person's budget is their own.
      expect((await call(await person(), "GET", bytesPathOf(file.id), undefined, { on: limited })).statusCode).toBe(200);
    });
  });

  describe("making a link (POST …/link, members with the current terms)", () => {
    it("answers 201 { path } with no-store, the link's route; audits nothing and logs no link", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const member = await person();

      const response = await call(member, "POST", linkPathOf(file.id));

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body)).toEqual(["path"]);
      expect(LIBRARY_LINK_PATH_PATTERN.test(String(body.path))).toBe(true);
      madeLinks.push(String(body.path).slice("/api/v1/library-links/tll_".length));
      expect(await auditRows()).toHaveLength(1);
      expect(await linkLeaked()).toBe(false);
    });

    it("refuses a member without the current terms (403), a request without the CSRF header (403), and an unknown or malformed id (404)", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      expectRefusalHoldingNoLink(
        await call(await person({ hasAcceptedTerms: false }), "POST", linkPathOf(file.id)),
        403,
        "terms_acceptance_required",
        MESSAGES.termsRequired,
      );
      const member = await person();
      expect((await call(member, "POST", linkPathOf(file.id), undefined, { csrf: false })).statusCode).toBe(403);
      for (const id of ["0199e000-0000-7000-8000-00000000dead", "x"]) {
        expectRefusalHoldingNoLink(await call(member, "POST", linkPathOf(id)), 404, "library_file_not_found", MESSAGES.fileNotFound);
      }
    });

    it("counts a person's links on libraryFileLinksPerUser: the third of two is 429", async () => {
      const limited = await serverWith({ rateLimits: { ...TEST_RATE_LIMITS, libraryFileLinksPerUser: { max: 2, windowMs: 60_000 } } });
      const admin = await productAdmin();
      const file = await created(admin);
      const member = await person();
      await madeLink(member, file.id, { on: limited });
      await madeLink(member, file.id, { on: limited });
      expectRefusalHoldingNoLink(await call(member, "POST", linkPathOf(file.id), undefined, { on: limited }), 429, "rate_limited", MESSAGES.limited);
    });
  });

  describe("the link's public route (GET /api/v1/library-links/:link)", () => {
    it("downloads the file with no session, cookie or CSRF header, as an attachment with no name; no-store, nosniff, no-referrer; not audited", async () => {
      const admin = await productAdmin();
      const data = randomBytes(10_000);
      const file = await created(admin, data);
      const path = await madeLink(await person(), file.id);

      const response = await fetchLink(path);

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(data)).toBe(true);
      expect(response.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-disposition": "attachment",
        "referrer-policy": "no-referrer",
        "content-length": String(data.length),
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await auditRows()).toHaveLength(1);
      expect(await linkLeaked()).toBe(false);
    });

    it("downloads 10 MiB", async () => {
      const admin = await productAdmin();
      const data = Buffer.alloc(TEN_MIB, 0x62);
      const file = await created(admin, data);
      const response = await fetchLink(await madeLink(await person(), file.id));
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(data)).toBe(true);
    });

    it("lasts 24 hours by the injected clock: 200 a millisecond before, 410 'This link has expired.' at the expiry and after", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const madeAt = clock.getTime();
      const path = await madeLink(await person(), file.id);

      clock = new Date(madeAt + DAY_MS - 1);
      expect((await fetchLink(path)).statusCode).toBe(200);
      clock = new Date(madeAt + DAY_MS);
      expectPlainRefusal(await fetchLink(path), 410, "This link has expired.");
      clock = new Date(madeAt + 30 * DAY_MS);
      expectPlainRefusal(await fetchLink(path), 410, "This link has expired.");
      expect(await linkLeaked()).toBe(false);
    });

    it("is 404 once its file is deleted", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      expect((await call(admin, "DELETE", filePathOf(file.id))).statusCode).toBe(204);
      expectPlainRefusal(await fetchLink(path), 404, "Not found.");
    });

    it("is 404 when its file's bytes are gone", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      await store.remove({ kind: "library-file", fileId: file.id });
      expectPlainRefusal(await fetchLink(path), 404, "Not found.");
    });

    it("still downloads under a previous key after a rotation, and is 404 once that key is retired or under another key", async () => {
      const oldKey = newKey();
      const newerKey = newKey();
      const before = await serverWith({ signingKeys: { current: oldKey, previous: [] } });
      const during = await serverWith({ signingKeys: { current: newerKey, previous: [oldKey] } });
      const after = await serverWith({ signingKeys: { current: newerKey, previous: [] } });
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id, { on: before });

      expect((await fetchLink(path, { on: during })).statusCode).toBe(200);
      expectPlainRefusal(await fetchLink(path, { on: after }), 404, "Not found.");
      // The default server's key never signed it.
      expectPlainRefusal(await fetchLink(path), 404, "Not found.");
      expect(await linkLeaked()).toBe(false);
    });

    it("is 404 for a link signed by a key it doesn't hold, naming a real file", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const forged = createLibraryLinks({ current: newKey(), previous: [] }).sign(file.id, clock);
      expectPlainRefusal(await fetchLink(`/api/v1/library-links/${forged}`), 404, "Not found.");
    });

    it("is 404 with its first, a middle or its last character changed", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      const start = "/api/v1/library-links/tll_".length;
      for (const index of [start, start + 35, path.length - 1]) {
        const character = path[index] === "A" ? "B" : "A";
        expectPlainRefusal(await fetchLink(path.slice(0, index) + character + path.slice(index + 1)), 404, "Not found.");
      }
    });

    it.each([
      ["a malformed link", "/api/v1/library-links/tll_x"],
      ["another prefix", `/api/v1/library-links/tqd_${"A".repeat(71)}`],
      ["no link at all", "/api/v1/library-links/x"],
    ])("is 404 'Not found.' in plain text for %s", async (_label, path) => {
      expectPlainRefusal(await fetchLink(path), 404, "Not found.");
    });

    it("isn't routed for HEAD", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      expect((await fetchLink(path, { method: "HEAD" })).statusCode).toBe(404);
      expect(await linkLeaked()).toBe(false);
    });

    it("counts every request per IP (libraryLinksPerIp), forged ones included: the third of two is 429 in plain text with Retry-After", async () => {
      const limited = await serverWith({ rateLimits: { ...TEST_RATE_LIMITS, libraryLinksPerIp: { max: 2, windowMs: 60_000 } } });
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      expect((await fetchLink("/api/v1/library-links/tll_x", { on: limited })).statusCode).toBe(404);
      expect((await fetchLink(path, { on: limited })).statusCode).toBe(200);
      const refused = await fetchLink(path, { on: limited });
      expectPlainRefusal(refused, 429, MESSAGES.limited);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("counts each link by its file and expiry (libraryLinkDownloadsPerLink), never by the link: the third of two is 429; a link made a minute later has its own count", async () => {
      const limited = await serverWith({ rateLimits: { ...TEST_RATE_LIMITS, libraryLinkDownloadsPerLink: { max: 2, windowMs: 60 * 60_000 } } });
      const admin = await productAdmin();
      const file = await created(admin);
      const member = await person();
      const path = await madeLink(member, file.id, { on: limited });
      expect((await fetchLink(path, { on: limited })).statusCode).toBe(200);
      expect((await fetchLink(path, { on: limited })).statusCode).toBe(200);
      expectPlainRefusal(await fetchLink(path, { on: limited }), 429, MESSAGES.limited);
      tick();
      const later = await madeLink(member, file.id, { on: limited });
      expect((await fetchLink(later, { on: limited })).statusCode).toBe(200);
    });

    it(`holds one of ${PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT} slots until the reply's socket closes: the next is 503 with Retry-After: 1 until a download ends`, async () => {
      const admin = await productAdmin();
      const data = Buffer.from("held bytes\n");
      const file = await created(admin, data);
      const path = await madeLink(await person(), file.id);
      const holding: PassThrough[] = [];
      heldReads = holding;
      const streaming = Array.from({ length: PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT }, () => fetchLink(path));
      // Every handler has returned and its stream is open, the bytes not yet sent: waited for on that
      // condition (each read goes through the database and the file store, so no count of event-loop turns
      // bounds it), with a wall-clock hang guard well under vitest's 5 s.
      await vi.waitFor(
        () => {
          if (holding.length < PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT) throw new Error("not every read is held yet");
        },
        { timeout: 4_000, interval: 1 },
      );
      expect(holding).toHaveLength(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);

      const busy = await fetchLink(path);

      expectPlainRefusal(busy, 503, DOWNLOADS_BUSY_MESSAGE);
      expect(busy.headers["retry-after"]).toBe("1");
      const held = heldReads;
      heldReads = undefined;
      for (const stream of held) stream.end(data);
      for (const response of await Promise.all(streaming)) {
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.equals(data)).toBe(true);
      }
      expect((await fetchLink(path)).statusCode).toBe(200);
    });

    it("logs no link and no file name in any of its lines, whatever it answered", async () => {
      const admin = await productAdmin();
      const file = await created(admin);
      const path = await madeLink(await person(), file.id);
      await fetchLink(path);
      await fetchLink(`${path}?x=1`);
      await fetchLink(`${path.slice(0, -1)}A`);
      clock = new Date(clock.getTime() + 2 * DAY_MS);
      await fetchLink(path);
      expect(logLines.length).toBeGreaterThan(0);
      expect(await linkLeaked()).toBe(false);
      expect(logLines.join("\n").includes(FILE_MARKER)).toBe(false);
      const urls = logLines.flatMap((line) => {
        const url = (JSON.parse(line) as { req?: { url?: string } }).req?.url;
        return url === undefined ? [] : [url];
      });
      expect(urls.filter((url) => url.startsWith("/api/v1/library-links")).every((url) => url === "/api/v1/library-links/[redacted]")).toBe(true);
    });
  });
});
