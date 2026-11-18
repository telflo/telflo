import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import { RATE_LIMITED_MESSAGE, RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { SALES_INQUIRY_FAILED_MESSAGE } from "./service.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const USER_AGENT = "Mozilla/5.0 (sales inquiry test)";

const inquiry = {
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  message: "We run about 400 collectors.\nCan we talk?",
  website: "",
};

/** An in-memory mailer that can be told to fail, as a relay that refuses the message would. */
function createSwitchableMailer(): IMailer & { sent: EmailMessage[]; isFailing: boolean } {
  const mailer = {
    sent: [] as EmailMessage[],
    isFailing: false,
    async send(message: EmailMessage): Promise<void> {
      if (mailer.isFailing) throw new Error("the relay refused the message");
      mailer.sent.push(message);
    },
  };
  return mailer;
}

/** Builds a server at `level`, restoring LOG_LEVEL whatever happens. */
function withLogLevel<Result>(level: string, build: () => Result): Result {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  try {
    return build();
  } finally {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
}

describe("POST /api/v1/sales-inquiries (D4 decision 4)", () => {
  let settings: AppSettings;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  let mailer: ReturnType<typeof createSwitchableMailer>;
  /** The server's error lines since the test began. */
  let logLines: string[] = [];
  let servers: FastifyInstance[] = [];

  const serverWith = async (
    options: { rateLimits?: RateLimits; settings?: Partial<AppSettings> } = {},
  ): Promise<FastifyInstance> => {
    const server = withLogLevel("error", () =>
      buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, ...options.settings },
        db,
        mailer,
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      }),
    );
    servers.push(server);
    await server.ready();
    return server;
  };

  beforeAll(async () => {
    // The route switched on, with its address (D36-1 decision 25: there is no default address).
    settings = loadSettings({ ...process.env, TELFLO_SALES_INQUIRY: "true", TELFLO_SALES_INQUIRY_TO: "inquiries@telflo.test" });
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    mailer = createSwitchableMailer();
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    mailer.sent.length = 0;
    mailer.isFailing = false;
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
  });

  const submit = (
    server: FastifyInstance,
    payload: Record<string, unknown> = inquiry,
    options: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ) =>
    server.inject({
      method: "POST",
      url: "/api/v1/sales-inquiries",
      remoteAddress: options.remoteAddress ?? "198.51.100.7",
      headers: options.headers ?? { ...csrfHeaders, "user-agent": USER_AGENT },
      payload,
    });

  const auditRows = () =>
    ownerDb
      .selectFrom("audit_events")
      .select([
        "action",
        "actor_user_id",
        "actor_email",
        "organization_id",
        "subject_type",
        "subject_id",
        "metadata",
        "ip_address",
        "user_agent",
      ])
      .orderBy("occurred_at")
      .execute();

  function expectRateLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
  }

  it("sends the inquiry to TELFLO_SALES_INQUIRY_TO, with Reply-To the submitter, and answers 202", async () => {
    const server = await serverWith();

    const response = await submit(server);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(settings.salesInquiryTo).toBe("inquiries@telflo.test");
    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent;
    expect(message).toMatchObject({
      to: "inquiries@telflo.test",
      replyTo: "ada@example.com",
      subject: "Pricing inquiry from Ada Lovelace",
    });
    expect(message?.text).toBe(
      [
        "Ada Lovelace <ada@example.com>",
        "via the contact form",
        "",
        "We run about 400 collectors.\nCan we talk?",
        "",
        "Reply to this email to answer them directly.",
      ].join("\n"),
    );
    expect(message?.html).toContain("<strong>Ada Lovelace</strong> &lt;ada@example.com&gt;");
    expect(message?.html).toContain("We run about 400 collectors.\nCan we talk?</div>");
  });

  it("sends to another TELFLO_SALES_INQUIRY_TO when it is set", async () => {
    const server = await serverWith({ settings: { salesInquiryTo: "sales@telflo.test" } });

    expect((await submit(server)).statusCode).toBe(202);
    expect(mailer.sent.map((message) => message.to)).toEqual(["sales@telflo.test"]);
  });

  it("trims the values before sending them", async () => {
    const server = await serverWith();

    await submit(server, { ...inquiry, name: "  Ada Lovelace \n", message: "\n  Hello.  \n" });

    expect(mailer.sent[0]?.subject).toBe("Pricing inquiry from Ada Lovelace");
    expect(mailer.sent[0]?.text).toContain("\n\nHello.\n\n");
  });

  it("escapes the submitter's values in the HTML part", async () => {
    const server = await serverWith();

    await submit(server, { ...inquiry, name: "<script>x</script>", message: "<script>alert(1)</script>" });

    expect(mailer.sent[0]?.html).not.toContain("<script");
    expect(mailer.sent[0]?.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("audits the address, the outcome and the origin: no message, no actor, no organization", async () => {
    const server = await serverWith();

    await submit(server);

    expect(await auditRows()).toEqual([
      {
        action: "sales_inquiry.received",
        actor_user_id: null,
        actor_email: null,
        organization_id: null,
        subject_type: null,
        subject_id: null,
        metadata: { email: "ada@example.com", outcome: "sent" },
        ip_address: "198.51.100.7",
        user_agent: USER_AGENT,
      },
    ]);
    expect(JSON.stringify(await auditRows())).not.toContain("400 collectors");
  });

  describe("the honeypot", () => {
    it("answers a filled website with 202 and sends and audits nothing", async () => {
      const server = await serverWith();

      const response = await submit(server, { ...inquiry, website: "https://spam.example" });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "accepted" });
      expect(mailer.sent).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("answers 202 even when the rest of the body is invalid", async () => {
      const server = await serverWith();

      const response = await submit(server, { website: "x".repeat(500), unexpected: true });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "accepted" });
      expect(mailer.sent).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("ignores a website of only spaces", async () => {
      const server = await serverWith();

      expect((await submit(server, { ...inquiry, website: "   " })).statusCode).toBe(202);
      expect(mailer.sent).toHaveLength(1);
    });
  });

  it("refuses an invalid body with 400 and sends nothing", async () => {
    const server = await serverWith();

    const response = await submit(server, { ...inquiry, message: "   " });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(mailer.sent).toEqual([]);
  });

  it("answers a failed send with 502 sales_inquiry_failed, audits it, and logs the mailer's error", async () => {
    const server = await serverWith();
    mailer.isFailing = true;

    const response = await submit(server);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: "sales_inquiry_failed", message: SALES_INQUIRY_FAILED_MESSAGE },
    });
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        action: "sales_inquiry.received",
        metadata: { email: "ada@example.com", outcome: "send_failed" },
      }),
    ]);
    // The mailer's error is logged on its own; the response carries none of it.
    expect(logLines.some((line) => line.includes("the relay refused the message"))).toBe(true);
    expect(response.body).not.toContain("relay");
  });

  it("names no address in its failure message (D36-1 decision 25)", () => {
    expect(SALES_INQUIRY_FAILED_MESSAGE).toBe("Your message couldn't be sent. Please try again later.");
    expect(SALES_INQUIRY_FAILED_MESSAGE.includes("@")).toBe(false);
  });

  describe("switched off, TELFLO_SALES_INQUIRY's default (D36-1 decision 25, Preflight ruling 17)", () => {
    const switchedOff = () =>
      serverWith({
        // The default settings: no switch, no address.
        settings: { site: { ...settings.site, salesInquiry: false }, salesInquiryTo: "" },
        rateLimits: { ...TEST_RATE_LIMITS, salesInquiriesPerIp: { max: 1, windowMs: RATE_LIMITS.salesInquiriesPerIp.windowMs } },
      });

    it("answers exactly as a path nothing serves: no mail, no audit row", async () => {
      const server = await switchedOff();

      const response = await submit(server);
      const unknown = await server.inject({
        method: "POST",
        url: "/api/v1/no-such-route",
        remoteAddress: "198.51.100.7",
        headers: { ...csrfHeaders, "user-agent": USER_AGENT },
        payload: inquiry,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: "not_found", message: "No route for POST /api/v1/sales-inquiries" } });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ error: { code: "not_found", message: "No route for POST /api/v1/no-such-route" } });
      expect(mailer.sent).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it("answers 404 before the per-IP limit counts it, a honeypot and an invalid body too", async () => {
      const server = await switchedOff();

      for (const payload of [inquiry, { ...inquiry, website: "https://spam.example" }, { unexpected: true }, inquiry]) {
        expect((await submit(server, payload)).statusCode).toBe(404);
      }
      expect(mailer.sent).toEqual([]);
    });

    it("still needs the CSRF header first, as every POST under /api/v1/ (an unknown path's too)", async () => {
      const server = await switchedOff();

      const response = await submit(server, inquiry, { headers: {} });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
    });
  });

  it("refuses a request without the CSRF header, and sends nothing", async () => {
    const server = await serverWith();

    const response = await submit(server, inquiry, { headers: {} });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
    expect(mailer.sent).toEqual([]);
  });

  describe("the per-IP limit, at its production numbers", () => {
    const productionLimit = (): RateLimits => ({
      ...TEST_RATE_LIMITS,
      salesInquiriesPerIp: RATE_LIMITS.salesInquiriesPerIp,
    });

    it("refuses the 4th request from one IP in 10 minutes, and another IP is unaffected", async () => {
      const server = await serverWith({ rateLimits: productionLimit() });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await submit(server)).statusCode).toBe(202);
      }
      const refused = await submit(server);
      expectRateLimited(refused);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(10 * 60);
      expect(mailer.sent).toHaveLength(3);

      expect((await submit(server, inquiry, { remoteAddress: "198.51.100.8" })).statusCode).toBe(202);
      expect(mailer.sent).toHaveLength(4);
    });

    it("counts every request: a honeypot and an invalid body spend the budget too", async () => {
      const server = await serverWith({ rateLimits: productionLimit() });

      expect((await submit(server, { ...inquiry, website: "https://spam.example" })).statusCode).toBe(202);
      expect((await submit(server, { unexpected: true })).statusCode).toBe(400);
      expect((await submit(server)).statusCode).toBe(202);
      expectRateLimited(await submit(server));
    });

    describe("is a separate bucket from the identity endpoints'", () => {
      const withOneIdentityRequest = () =>
        serverWith({
          rateLimits: { ...productionLimit(), identityPerIp: { max: 1, windowMs: RATE_LIMITS.identityPerIp.windowMs } },
        });
      const requestReset = (server: FastifyInstance) =>
        server.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset-requests",
          remoteAddress: "198.51.100.7",
          headers: csrfHeaders,
          payload: { email: "someone@example.com" },
        });

      it("a spent identity budget leaves the inquiries theirs", async () => {
        const server = await withOneIdentityRequest();

        expect((await requestReset(server)).statusCode).toBe(202);
        expectRateLimited(await requestReset(server));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect((await submit(server)).statusCode).toBe(202);
        }
        expectRateLimited(await submit(server));
      });

      it("a spent inquiry budget leaves the identity endpoints theirs", async () => {
        const server = await withOneIdentityRequest();

        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect((await submit(server)).statusCode).toBe(202);
        }
        expectRateLimited(await submit(server));
        expect((await requestReset(server)).statusCode).toBe(202);
      });
    });
  });
});
