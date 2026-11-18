import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../errors.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { IMailer } from "../../mail/mailer.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { createSalesInquiryService, SALES_INQUIRY_FAILED_MESSAGE } from "./service.js";

const inquiry = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  message: "We run about 400 collectors.",
  ipAddress: "198.51.100.7",
  userAgent: "Mozilla/5.0",
};

function buildHarness(mailer: IMailer = createInMemoryMailer(), auditError?: Error) {
  const auditEvents: AuditEvent[] = [];
  const audit = {
    record: vi.fn(async (event: AuditEvent) => {
      if (auditError) throw auditError;
      auditEvents.push(event);
    }),
  } satisfies IAuditRepository;
  const log = { error: vi.fn() };
  const service = createSalesInquiryService({ audit, mailer, recipient: "sales@telflo.test", log });
  return { service, auditEvents, log };
}

describe("createSalesInquiryService", () => {
  it("sends one email to the recipient, with Reply-To the submitter", async () => {
    const mailer = createInMemoryMailer();
    const { service } = buildHarness(mailer);

    await service.submit(inquiry);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: "sales@telflo.test",
      replyTo: "ada@example.com",
      subject: "Pricing inquiry from Ada Lovelace",
    });
    expect(mailer.sent[0]?.text).toContain(inquiry.message);
  });

  it("audits the address, the outcome and the origin, with no message, actor or organization", async () => {
    const { service, auditEvents } = buildHarness();

    await service.submit(inquiry);

    expect(auditEvents).toEqual([
      {
        action: "sales_inquiry.received",
        metadata: { email: "ada@example.com", outcome: "sent" },
        ipAddress: "198.51.100.7",
        userAgent: "Mozilla/5.0",
      },
    ]);
  });

  it("answers a failed send with 502 sales_inquiry_failed, logs the mailer's error, and audits it", async () => {
    const relayError = new Error("the relay refused the message");
    const failing: IMailer = {
      send: async () => {
        throw relayError;
      },
    };
    const { service, auditEvents, log } = buildHarness(failing);

    const error = await service.submit(inquiry).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "sales_inquiry_failed", statusCode: 502, message: SALES_INQUIRY_FAILED_MESSAGE });
    expect(SALES_INQUIRY_FAILED_MESSAGE).toBe("Your message couldn't be sent. Please try again later.");
    expect(log.error).toHaveBeenCalledWith({ err: relayError }, expect.any(String));
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "sales_inquiry.received",
        metadata: { email: "ada@example.com", outcome: "send_failed" },
      }),
    ]);
  });

  it("still accepts a sent inquiry whose audit row couldn't be written, and logs why (D4 Ruling 16)", async () => {
    const mailer = createInMemoryMailer();
    const databaseError = new Error("the database is unreachable");
    const { service, log } = buildHarness(mailer, databaseError);

    await expect(service.submit(inquiry)).resolves.toBeUndefined();

    expect(mailer.sent).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith({ err: databaseError }, expect.any(String));
  });

  it("still answers a failed send with 502 when its audit row couldn't be written either, and logs both", async () => {
    const relayError = new Error("the relay refused the message");
    const databaseError = new Error("the database is unreachable");
    const failing: IMailer = {
      send: async () => {
        throw relayError;
      },
    };
    const { service, log } = buildHarness(failing, databaseError);

    const error = await service.submit(inquiry).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "sales_inquiry_failed", statusCode: 502 });
    expect(log.error).toHaveBeenCalledWith({ err: relayError }, expect.any(String));
    expect(log.error).toHaveBeenCalledWith({ err: databaseError }, expect.any(String));
  });
});
