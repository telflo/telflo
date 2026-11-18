import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, USER_FEEDBACK_PAGE_SIZE, type UserFeedbackPage } from "@telflo/contracts";
import { addUserFeedback, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { AppError } from "../../errors.js";
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
import { FEEDBACK_REPLY_EMAIL_SUBJECT } from "../feedback/emails.js";
import { hashPassword } from "../identity/password.js";
import { createFeedbackAdminService } from "./feedback-admin-service.js";
import { createSystemRepository, type ISystemRepository } from "./repositories/system-repository.js";

/*
 * User Feedback for product admins (D29 decisions 33, 34 and 37; decision
 * 44's feedback bullet): the pending list, 25 a page by an opaque cursor,
 * with each sender's current email and `authorDeleted`; the pending count;
 * acknowledge (204, marked, then the reply emailed to the sender after the
 * response and never stored), dismiss (204, no email); every refusal:
 * 404 `feedback_not_found` (missing, handled, a non-canonical id), 409
 * `feedback_author_deleted` (the item left pending), 403
 * `product_admin_required` when the caller lost the flag meanwhile, 429
 * past the writes' limit; a failed send logged with the item's id and fixed
 * words only.
 *
 * Another person's email, the feedback's text and the reply are personal
 * data: every check on them is a boolean, never a printed value.
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const NOW = new Date(Date.UTC(2026, 9, 27, 9, 30, 0, 0));

describe("the product admins' User Feedback routes", () => {
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

  /** A server with this mailer and these limits, its after-response work queued until `runner.settle()`, its log captured in full. */
  const start = async (options: { mailer?: IMailer & { sent: EmailMessage[] }; rateLimits?: RateLimits } = {}) => {
    mailer = options.mailer ?? createInMemoryMailer();
    runner = createCollectingRunner();
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

  const person = async (options: { isProductAdmin?: boolean } = {}) => {
    const created = await createUserWithOrganization(databases.ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash, is_product_admin: options.isProductAdmin ?? false },
    });
    return { userId: created.user.id, email: created.user.email, organizationId: created.organization.id };
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

  /** A signed-in product admin. */
  const signedInAdmin = async () => {
    const admin = await person({ isProductAdmin: true });
    return { ...admin, access: await signIn(admin.email) };
  };

  const get = (url: string, access: string) => server!.inject({ method: "GET", url, cookies: { telflo_access: access } });
  const post = (url: string, access: string, body?: Record<string, unknown>) =>
    server!.inject({
      method: "POST",
      url,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      ...(body === undefined ? {} : { payload: body }),
    });
  const acknowledge = (id: string, access: string, reply: string) =>
    post(`/api/v1/product-admin/feedback/${id}/acknowledge`, access, { reply });
  const dismiss = (id: string, access: string) => post(`/api/v1/product-admin/feedback/${id}/dismiss`, access);

  const item = (id: string) =>
    databases.ownerDb
      .selectFrom("user_feedback")
      .select(["handled_at", "handled_by_user_id", "outcome"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  const auditRows = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .select(["action", "actor_user_id", "organization_id", "subject_type", "subject_id", "metadata"])
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  it("lists the pending items newest first, 25 a page, with each sender's current email and authorDeleted; handled items absent; no-store", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const cara = await person();
    const marker = `feedback-marker-${randomUUID()}`;
    const ids: string[] = [];
    // 27 pending, a second apart, Ben's and Cara's alternating; the oldest holds the marker.
    for (let index = 0; index < 27; index += 1) {
      const sender = index % 2 === 0 ? ben : cara;
      const created = await addUserFeedback(databases.ownerDb, {
        userId: sender.userId,
        organizationId: sender.organizationId,
        text: index === 0 ? marker : `Feedback ${index}.`,
        created_at: new Date(NOW.getTime() - (27 - index) * 1000),
      });
      ids.unshift(created.id);
    }
    await addUserFeedback(databases.ownerDb, {
      userId: ben.userId,
      organizationId: ben.organizationId,
      created_at: NOW,
      handled_at: NOW,
      handled_by_user_id: admin.userId,
      outcome: "dismissed",
    });
    await databases.ownerDb
      .updateTable("users")
      .set({ deleted_at: NOW, email: `deleted-${randomUUID().replaceAll("-", "").slice(0, 24)}@deleted-accounts.telflo.invalid` })
      .where("id", "=", cara.userId)
      .execute();

    const first = await get("/api/v1/product-admin/feedback", admin.access);
    expect({ status: first.statusCode, cache: first.headers["cache-control"] }).toEqual({ status: 200, cache: "no-store" });
    const firstPage = first.json<UserFeedbackPage>();
    expect(firstPage.items.map((each) => each.id)).toEqual(ids.slice(0, USER_FEEDBACK_PAGE_SIZE));
    expect(typeof firstPage.nextCursor).toBe("string");
    const second = await get(`/api/v1/product-admin/feedback?cursor=${encodeURIComponent(firstPage.nextCursor!)}`, admin.access);
    const secondPage = second.json<UserFeedbackPage>();
    expect({ ids: secondPage.items.map((each) => each.id), nextCursor: secondPage.nextCursor }).toEqual({
      ids: ids.slice(USER_FEEDBACK_PAGE_SIZE),
      nextCursor: null,
    });

    const all = [...firstPage.items, ...secondPage.items];
    const caraNow = await databases.ownerDb.selectFrom("users").select("email").where("id", "=", cara.userId).executeTakeFirstOrThrow();
    // Ben's items show his email, Cara's her anonymous address, and say she is deleted.
    expect(
      all.every((each, index) => {
        const isBens = (27 - 1 - index) % 2 === 0;
        return isBens ? each.email === ben.email && !each.authorDeleted : each.email === caraNow.email && each.authorDeleted;
      }),
    ).toBe(true);
    expect(all.at(-1)!.text === marker).toBe(true);
    expect(all.every((each) => each.createdAt.endsWith("Z"))).toBe(true);
    // The list's audit rows hold counts only: the rows returned, the full page 25, never the look-ahead's 26 (Ruling 264).
    expect((await auditRows()).filter((row) => row.action === "product_admin.feedback_listed").map((row) => row.metadata)).toEqual([
      { count: USER_FEEDBACK_PAGE_SIZE },
      { count: 2 },
    ]);
  });

  it("answers a cursor encodeCursor couldn't have made 400 invalid_request", async () => {
    await start();
    const admin = await signedInAdmin();
    for (const cursor of [
      "not base64!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-10-27", id: randomUUID() })).toString("base64url"),
    ]) {
      const response = await get(`/api/v1/product-admin/feedback?cursor=${encodeURIComponent(cursor)}`, admin.access);
      expect({ status: response.statusCode, code: response.json().error.code }).toEqual({ status: 400, code: "invalid_request" });
    }
  });

  it("counts the pending items, 0 included", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const countNow = async () => {
      const response = await get("/api/v1/product-admin/feedback/pending-count", admin.access);
      expect({ status: response.statusCode, cache: response.headers["cache-control"] }).toEqual({ status: 200, cache: "no-store" });
      return response.json<{ count: number }>();
    };
    expect(await countNow()).toEqual({ count: 0 });
    const pending = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    await addUserFeedback(databases.ownerDb, {
      userId: ben.userId,
      organizationId: ben.organizationId,
      handled_at: NOW,
      outcome: "acknowledged",
    });
    expect(await countNow()).toEqual({ count: 2 });
    expect((await dismiss(pending.id, admin.access)).statusCode).toBe(204);
    expect(await countNow()).toEqual({ count: 1 });
  });

  it("acknowledges: 204, marked by the caller, the reply emailed to the sender after the response (its line breaks kept) and stored nowhere", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    const replyMarker = `reply-marker-${randomUUID()}`;
    const reply = `Thanks, Ben.\nWe added it. ${replyMarker}`;

    const response = await acknowledge(feedback.id.toUpperCase(), admin.access, `  ${reply}\n `);

    expect({ status: response.statusCode, body: response.body, cache: response.headers["cache-control"] }).toEqual({
      status: 204,
      body: "",
      cache: "no-store",
    });
    expect(await item(feedback.id)).toEqual({ handled_at: NOW, handled_by_user_id: admin.userId, outcome: "acknowledged" });
    expect(mailer.sent.length).toBe(0);
    await runner.settle();
    expect(mailer.sent.length).toBe(1);
    const [message] = mailer.sent;
    expect({
      toBen: message!.to === ben.email,
      subject: message!.subject,
      text: message!.text === `Hi,\n\n${reply}`,
      html: message!.html.includes(`Thanks, Ben.<br>We added it. ${replyMarker}`),
    }).toEqual({ toBen: true, subject: FEEDBACK_REPLY_EMAIL_SUBJECT, text: true, html: true });
    // Never stored: not on the item, not in an audit row, not in a log line.
    const stored = await databases.ownerDb.selectFrom("user_feedback").select("text").execute();
    const audits = await auditRows();
    expect({
      inItems: stored.some((row) => row.text.includes(replyMarker)),
      inAudit: audits.some((row) => JSON.stringify(row).includes(replyMarker) || JSON.stringify(row.metadata).includes(ben.email)),
      inLog: logLines.some((line) => line.includes(replyMarker) || line.includes(ben.email)),
    }).toEqual({ inItems: false, inAudit: false, inLog: false });
    expect(audits.filter((row) => row.action === "feedback.acknowledged")).toEqual([
      {
        action: "feedback.acknowledged",
        actor_user_id: admin.userId,
        organization_id: null,
        subject_type: "feedback",
        subject_id: feedback.id,
        metadata: {},
      },
    ]);
  });

  it("dismisses: 204, marked by the caller, no email", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });

    const response = await dismiss(feedback.id, admin.access);

    expect({ status: response.statusCode, cache: response.headers["cache-control"] }).toEqual({ status: 204, cache: "no-store" });
    expect(await item(feedback.id)).toEqual({ handled_at: NOW, handled_by_user_id: admin.userId, outcome: "dismissed" });
    await runner.settle();
    expect(mailer.sent.length).toBe(0);
    expect((await auditRows()).filter((row) => row.action === "feedback.dismissed").map((row) => row.subject_id)).toEqual([feedback.id]);
  });

  it("answers 404 feedback_not_found for a handled item, an unknown id and a non-canonical one, sending nothing", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const handled = await addUserFeedback(databases.ownerDb, {
      userId: ben.userId,
      organizationId: ben.organizationId,
      handled_at: NOW,
      outcome: "dismissed",
    });
    for (const id of [handled.id, randomUUID(), "not-a-uuid", `{${handled.id}}`, handled.id.replaceAll("-", "")]) {
      for (const response of [
        await acknowledge(encodeURIComponent(id), admin.access, "Thanks."),
        await dismiss(encodeURIComponent(id), admin.access),
      ]) {
        expect({ status: response.statusCode, code: response.json().error.code, cache: response.headers["cache-control"] }).toEqual({
          status: 404,
          code: "feedback_not_found",
          cache: "no-store",
        });
      }
    }
    await runner.settle();
    expect(mailer.sent.length).toBe(0);
  });

  it("answers an acknowledge whose sender is deleted 409 feedback_author_deleted, the item left pending; Dismiss still works", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    await databases.ownerDb.updateTable("users").set({ deleted_at: NOW }).where("id", "=", ben.userId).execute();

    const refused = await acknowledge(feedback.id, admin.access, "Thanks.");

    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 409, code: "feedback_author_deleted" });
    expect(await item(feedback.id)).toEqual({ handled_at: null, handled_by_user_id: null, outcome: null });
    const listed = (await get("/api/v1/product-admin/feedback", admin.access)).json<UserFeedbackPage>();
    expect(listed.items.map((each) => ({ id: each.id, authorDeleted: each.authorDeleted }))).toEqual([
      { id: feedback.id, authorDeleted: true },
    ]);
    expect((await dismiss(feedback.id, admin.access)).statusCode).toBe(204);
    await runner.settle();
    expect(mailer.sent.length).toBe(0);
  });

  it("refuses a blank reply, one over 5,000 characters, a missing or extra field: 400, the item left pending, the reply in no reply or log line", async () => {
    await start();
    const admin = await signedInAdmin();
    const ben = await person();
    const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    const marker = `reply-marker-${randomUUID()}`;
    for (const body of [
      { reply: " \n " },
      { reply: `${marker}${"x".repeat(5001 - marker.length)}` },
      {},
      { reply: marker, text: marker },
    ]) {
      const response = await post(`/api/v1/product-admin/feedback/${feedback.id}/acknowledge`, admin.access, body);
      expect({ status: response.statusCode, holds: response.body.includes(marker) }).toEqual({ status: 400, holds: false });
    }
    expect(await item(feedback.id)).toEqual({ handled_at: null, handled_by_user_id: null, outcome: null });
    expect(logLines.some((line) => line.includes(marker))).toBe(false);
  });

  it("counts acknowledges and dismisses against the writes' limit (here 2 a minute): the third is 429 and marks nothing", async () => {
    await start({ rateLimits: { ...TEST_RATE_LIMITS, productAdminWritesPerUser: { max: 2, windowMs: 60_000 } } });
    const admin = await signedInAdmin();
    const ben = await person();
    const items = await Promise.all(
      [0, 1, 2].map(() => addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId })),
    );
    expect((await dismiss(items[0]!.id, admin.access)).statusCode).toBe(204);
    expect((await acknowledge(items[1]!.id, admin.access, "Thanks.")).statusCode).toBe(204);
    const refused = await dismiss(items[2]!.id, admin.access);
    expect({ status: refused.statusCode, code: refused.json().error.code, retryAfter: Number(refused.headers["retry-after"]) > 0 }).toEqual(
      {
        status: 429,
        code: "rate_limited",
        retryAfter: true,
      },
    );
    expect(await item(items[2]!.id)).toEqual({ handled_at: null, handled_by_user_id: null, outcome: null });
  });

  it("logs a failed reply's send with the item's id and fixed words only, never the error, the reply or an address; the item stays handled", async () => {
    await start({
      mailer: {
        sent: [],
        async send(message) {
          throw new Error(`550 5.1.1 <${message.to}>: Recipient address rejected: ${message.text}`);
        },
      },
    });
    const admin = await signedInAdmin();
    const ben = await person();
    const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    const replyMarker = `reply-marker-${randomUUID()}`;
    expect((await acknowledge(feedback.id, admin.access, `Thanks. ${replyMarker}`)).statusCode).toBe(204);
    logLines = [];

    await runner.settle();

    const failure = logLines.filter((line) => line.includes("couldn't be sent"));
    expect(failure.length).toBe(1);
    const entry = JSON.parse(failure[0]!) as Record<string, unknown>;
    expect({ feedbackId: entry.feedbackId, err: "err" in entry, level: entry.level }).toEqual({
      feedbackId: feedback.id,
      err: false,
      level: 50,
    });
    const leaked = [ben.email, admin.email, replyMarker, "Recipient address rejected"];
    expect(logLines.some((line) => leaked.some((text) => line.includes(text)))).toBe(false);
    expect((await item(feedback.id)).outcome).toBe("acknowledged");
  });

  describe("a caller who lost the flag while a write waited (decision 34: 403 product_admin_required)", () => {
    const at = NOW;
    const service = (system: ISystemRepository) =>
      createFeedbackAdminService({
        system,
        mailer: createInMemoryMailer(),
        runAfterResponse: () => undefined,
        log: { error: () => undefined },
        now: () => at,
        countWrite: () => undefined,
      });

    /** The 403 an AppError carries, as booleans and fixed words. */
    const refusalOf = async (work: Promise<unknown>) => {
      try {
        await work;
        return "answered";
      } catch (error) {
        return error instanceof AppError ? { status: error.statusCode, code: error.code } : "another error";
      }
    };

    it("answers the database's gate (the flag cleared after the route's check) 403 on acknowledge and dismiss, the item left pending", async () => {
      const admin = await person({ isProductAdmin: true });
      const ben = await person();
      const feedback = await addUserFeedback(databases.ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
      // The route's requireProductAdmin let the request through; then an operator cleared the flag.
      await databases.ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", admin.userId).execute();
      const actor = { userId: admin.userId, email: admin.email };
      const feedbackService = service(createSystemRepository(databases.db));

      expect(await refusalOf(feedbackService.acknowledge(actor, feedback.id, "Thanks."))).toEqual({
        status: 403,
        code: "product_admin_required",
      });
      expect(await refusalOf(feedbackService.dismiss(actor, feedback.id))).toEqual({ status: 403, code: "product_admin_required" });
      expect(await item(feedback.id)).toEqual({ handled_at: null, handled_by_user_id: null, outcome: null });
    });

    it("answers the function's `forbidden` (the caller re-read under the item's lock) 403", async () => {
      const forbidden = {
        handleFeedback: async () => ({ outcome: "forbidden" as const }),
      } as unknown as ISystemRepository;
      const actor = { userId: randomUUID(), email: "admin@example.com" };
      expect(await refusalOf(service(forbidden).acknowledge(actor, randomUUID(), "Thanks."))).toEqual({
        status: 403,
        code: "product_admin_required",
      });
      expect(await refusalOf(service(forbidden).dismiss(actor, randomUUID()))).toEqual({ status: 403, code: "product_admin_required" });
    });
  });
});
