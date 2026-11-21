import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { FEEDBACK_ADMIN_EMAIL_SUBJECT } from "./emails.js";
import { createFeedbackService } from "./service.js";

/*
 * "Contact us"'s `POST /api/v1/feedback`: the item written in the sender's
 * active organization with its `feedback.created` row; the text trimmed and
 * capped; 10 an hour per person; after the response, each live, verified
 * human product admin emailed separately, with the sender's email and never
 * the text; a failed send logged with ids and fixed words only.
 *
 * Another person's email and the feedback's text are personal data: every
 * check on them is a boolean (`includes`, `===`), never a printed value.
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const NOW = new Date(Date.UTC(2026, 9, 27, 9, 30, 0, 123));

/** A mailer that refuses `failFor`'s messages with an SMTP-like error quoting the recipient, and keeps the rest. */
function createFailingMailer(failFor: (message: EmailMessage) => boolean): IMailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      if (failFor(message)) throw new Error(`550 5.1.1 <${message.to}>: Recipient address rejected`);
      sent.push(message);
    },
  };
}

describe("POST /api/v1/feedback", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance | undefined;
  let mailer: IMailer & { sent: EmailMessage[] };
  let runner: CollectingRunner;
  let logLines: string[] = [];

  beforeAll(async () => {
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    logLines = [];
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** A server with this mailer and these limits, its after-response work queued until `runner.settle()`. */
  const start = async (
    options: {
      mailer?: IMailer & { sent: EmailMessage[] };
      rateLimits?: RateLimits;
    } = {},
  ) => {
    mailer = options.mailer ?? createInMemoryMailer();
    runner = createCollectingRunner();
    // The log at its fullest while the server is built: every line a failed send could write is captured.
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db: databases.db,
        mailer,
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        runAfterResponse: runner.run,
        now: () => NOW,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    return server;
  };

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** A person with a personal organization; a product admin, unverified or deleted when asked. */
  const person = async (
    options: {
      isProductAdmin?: boolean;
      verified?: boolean;
      deleted?: boolean;
    } = {},
  ) => {
    const created = await createUserWithOrganization(databases.ownerDb, {
      user: {
        email: `person-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        is_product_admin: options.isProductAdmin ?? false,
        ...(options.verified === false ? { email_verified_at: null } : {}),
      },
    });
    if (options.deleted === true) {
      await databases.ownerDb.updateTable("users").set({ deleted_at: NOW }).where("id", "=", created.user.id).execute();
    }
    return {
      userId: created.user.id,
      email: created.user.email,
      organizationId: created.organization.id,
    };
  };

  const signIn = async (email: string) => {
    const response = await server!.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const sendFeedback = (access: string, body: unknown) =>
    server!.inject({
      method: "POST",
      url: "/api/v1/feedback",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: body as Record<string, unknown>,
    });

  const auditRows = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .select(["action", "actor_user_id", "organization_id", "subject_type", "subject_id", "metadata"])
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  it("writes the item, trimmed, in the session's active organization with feedback.created (ids only), answering 201 { id } before any email", async () => {
    await start();
    const sender = await person();
    const group = await addMembership(databases.ownerDb, {
      userId: sender.userId,
      role: "contributor",
    });
    const personalAccess = await signIn(sender.email);
    const switched = await server!.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: personalAccess },
      payload: { organizationId: group.organization.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    const access = switched.headers["set-cookie"] === undefined ? personalAccess : cookieValue(switched, "telflo_access");
    await person({ isProductAdmin: true });
    const marker = `feedback-marker-${randomUUID()}`;

    const response = await sendFeedback(access, {
      text: `  \n${marker}\nSecond line.  \t`,
    });

    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();
    expect(Object.keys(response.json())).toEqual(["id"]);
    const rows = await databases.ownerDb.selectFrom("user_feedback").selectAll().execute();
    expect(
      rows.map((row) => ({
        ...row,
        text: row.text === `${marker}\nSecond line.`,
      })),
    ).toEqual([
      {
        id,
        user_id: sender.userId,
        organization_id: group.organization.id,
        text: true,
        created_at: NOW,
        handled_at: null,
        handled_by_user_id: null,
        outcome: null,
      },
    ]);
    const audits = await auditRows();
    expect(audits.filter((row) => row.action === "feedback.created")).toEqual([
      {
        action: "feedback.created",
        actor_user_id: sender.userId,
        organization_id: group.organization.id,
        subject_type: "feedback",
        subject_id: id,
        metadata: {},
      },
    ]);
    expect(audits.some((row) => JSON.stringify(row.metadata).includes(marker))).toBe(false);
    // The emails follow the response: nothing sent until the queued work runs.
    expect(mailer.sent.length).toBe(0);
  });

  it("answers 401 signed out and 403 terms_acceptance_required without the current terms: nothing written, audited or queued", async () => {
    await start();
    await person({ isProductAdmin: true });
    const sender = await person();
    const access = await signIn(sender.email);
    await databases.ownerDb.updateTable("users").set({ accepted_terms_version: "2025-01-01" }).where("id", "=", sender.userId).execute();
    const marker = `feedback-marker-${randomUUID()}`;

    const signedOut = await server!.inject({ method: "POST", url: "/api/v1/feedback", headers: csrfHeaders, payload: { text: marker } });
    expect({ status: signedOut.statusCode, code: signedOut.json().error.code }).toEqual({ status: 401, code: "unauthenticated" });
    const withoutTerms = await sendFeedback(access, { text: marker });
    expect({ status: withoutTerms.statusCode, code: withoutTerms.json().error.code }).toEqual({
      status: 403,
      code: "terms_acceptance_required",
    });

    expect(await databases.ownerDb.selectFrom("user_feedback").select("id").execute()).toHaveLength(0);
    expect((await auditRows()).filter((row) => row.action === "feedback.created")).toHaveLength(0);
    await runner.settle();
    expect(mailer.sent.length).toBe(0);
  });

  it("refuses a blank text, one over 5,000 characters after trimming, a missing or extra field: 400, the text in no reply or log line", async () => {
    await start();
    const sender = await person();
    const access = await signIn(sender.email);
    const marker = `feedback-marker-${randomUUID()}`;
    const bodies: unknown[] = [
      { text: "   \n\t " },
      { text: `${marker}${"x".repeat(5001 - marker.length)}` },
      {},
      { text: marker, organizationId: sender.organizationId },
      { text: `${marker}\u0000` },
    ];
    for (const body of bodies) {
      const response = await sendFeedback(access, body);
      expect(response.statusCode).toBe(400);
      expect(response.body.includes(marker)).toBe(false);
    }
    // 5,000 characters once trimmed is the cap itself.
    expect((await sendFeedback(access, { text: `  ${"y".repeat(5000)}  ` })).statusCode).toBe(201);
    expect(await databases.ownerDb.selectFrom("user_feedback").select("id").execute()).toHaveLength(1);
    expect(logLines.some((line) => line.includes(marker))).toBe(false);
  });

  it("counts 10 an hour per person (here 2), after validation: refused bodies count nothing; the third good one is 429 with Retry-After and writes nothing; another person has their own count", async () => {
    await start({
      rateLimits: {
        ...TEST_RATE_LIMITS,
        feedbackPerUser: { max: 2, windowMs: 60 * 60 * 1000 },
      },
    });
    const ana = await person();
    const ben = await person();
    const anaAccess = await signIn(ana.email);
    const benAccess = await signIn(ben.email);
    // Refused bodies first: more than the limit of them, none counted.
    for (const body of [{ text: "  " }, {}, { text: "x".repeat(5001) }]) {
      expect((await sendFeedback(anaAccess, body)).statusCode).toBe(400);
    }
    expect((await sendFeedback(anaAccess, { text: "One." })).statusCode).toBe(201);
    expect((await sendFeedback(anaAccess, { text: "Two." })).statusCode).toBe(201);
    const refused = await sendFeedback(anaAccess, { text: "Three." });
    expect({
      status: refused.statusCode,
      code: refused.json().error.code,
      retryAfter: Number(refused.headers["retry-after"]) > 0,
    }).toEqual({
      status: 429,
      code: "rate_limited",
      retryAfter: true,
    });
    expect((await sendFeedback(benAccess, { text: "Ben's." })).statusCode).toBe(201);
    expect(await databases.ownerDb.selectFrom("user_feedback").select("id").execute()).toHaveLength(3);
  });

  it("emails each live, verified human product admin separately after the response: the sender's email and the page's link, never the text", async () => {
    await start();
    const sender = await person();
    const ana = await person({ isProductAdmin: true });
    const ben = await person({ isProductAdmin: true });
    const unverified = await person({ isProductAdmin: true, verified: false });
    const deleted = await person({ isProductAdmin: true, deleted: true });
    const notAdmin = await person();
    // A service account holding the flag (an operator's SQL could set it) is no recipient.
    const service = await addServiceAccount(databases.ownerDb, {
      organizationId: ana.organizationId,
    });
    await databases.ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", service.user.id).execute();
    const access = await signIn(sender.email);
    const marker = `feedback-marker-${randomUUID()}`;

    expect(
      (
        await sendFeedback(access, {
          text: `Please add a connector. ${marker}`,
        })
      ).statusCode,
    ).toBe(201);
    expect(mailer.sent.length).toBe(0);
    await runner.settle();

    const to = (email: string) => mailer.sent.filter((message) => message.to === email).length;
    expect({
      count: mailer.sent.length,
      ana: to(ana.email),
      ben: to(ben.email),
      unverified: to(unverified.email),
      deleted: to(deleted.email),
      notAdmin: to(notAdmin.email),
      sender: to(sender.email),
      service: to(service.user.email),
    }).toEqual({
      count: 2,
      ana: 1,
      ben: 1,
      unverified: 0,
      deleted: 0,
      notAdmin: 0,
      sender: 0,
      service: 0,
    });
    const reviewUrl = `${loadSettings(process.env).publicWebUrl}/product-admin/user-feedback`;
    for (const message of mailer.sent) {
      expect({
        subject: message.subject,
        namesSender: message.text.includes(`Requested by: ${sender.email}`) && message.html.includes(sender.email),
        links: message.text.includes(reviewUrl) && message.html.includes(`href="${reviewUrl}"`),
        holdsText: [message.subject, message.text, message.html].some(
          (part) => part.includes(marker) || part.includes("Please add a connector"),
        ),
      }).toEqual({
        subject: FEEDBACK_ADMIN_EMAIL_SUBJECT,
        namesSender: true,
        links: true,
        holdsText: false,
      });
    }
  });

  it("logs a failed send with the item's and the recipient's ids and fixed words only, never the error or an address, and still emails the other admins", async () => {
    const ana = await person({ isProductAdmin: true });
    const ben = await person({ isProductAdmin: true });
    await start({
      mailer: createFailingMailer((message) => message.to === ana.email),
    });
    const sender = await person();
    const access = await signIn(sender.email);
    const marker = `feedback-marker-${randomUUID()}`;
    const response = await sendFeedback(access, { text: marker });
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();
    logLines = [];

    await runner.settle();

    expect({
      sentToBen: mailer.sent.some((message) => message.to === ben.email),
      count: mailer.sent.length,
    }).toEqual({ sentToBen: true, count: 1 });
    const failure = logLines.filter((line) => line.includes("couldn't be sent"));
    expect(failure.length).toBe(1);
    const entry = JSON.parse(failure[0]!) as Record<string, unknown>;
    expect({
      feedbackId: entry.feedbackId,
      recipientUserId: entry.recipientUserId,
      err: "err" in entry,
      level: entry.level,
    }).toEqual({
      feedbackId: id,
      recipientUserId: ana.userId,
      err: false,
      level: 50,
    });
    const leaked = [ana.email, ben.email, sender.email, marker, "Recipient address rejected"];
    expect(logLines.some((line) => leaked.some((text) => line.includes(text)))).toBe(false);
  });

  it("logs a failed read of the recipients with the item's id and fixed words only, never the error", async () => {
    const sender = await person();
    const queued = createCollectingRunner();
    const errors: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const service = createFeedbackService({
      db: databases.db,
      mailer: createInMemoryMailer(),
      runAfterResponse: queued.run,
      log: {
        error: (fields: Record<string, unknown>, message: string) => void errors.push({ fields, message }),
      } as never,
      now: () => NOW,
      publicWebUrl: "http://localhost:56898",
      countFeedback: () => undefined,
      listRecipients: async () => {
        throw new Error(`connection to the database lost while reading ${sender.email}`);
      },
    });
    const id = await service.create(
      {
        context: {
          userId: sender.userId,
          organizationId: sender.organizationId,
          role: "admin",
          sessionId: randomUUID(),
        },
        email: sender.email,
      },
      "Hello.",
    );

    await queued.settle();

    expect(errors.map(({ fields, message }) => ({ fields, message }))).toEqual([
      {
        fields: { feedbackId: id },
        message: "a feedback item's product admins couldn't be read, so none was emailed",
      },
    ]);
  });
});
