import { describe, expect, it, vi } from "vitest";
import { createAuthContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import { createCollectingRunner } from "../../http/after-response.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { User } from "../identity/repositories/user-repository.js";
import { createAccountService, type AccountServiceDependencies, type AccountTransaction } from "./service.js";

/*
 * The password change's order and refusals on hand-built fakes that write
 * every call to one log. The races themselves run on Postgres
 * (password.integration.test.ts); here, the order the service makes its
 * calls in, and what each refusal leaves unwritten.
 */

const CURRENT_PASSWORD = "the-current-sufficiently-long-password";
const NEW_PASSWORD = "a-brand-new-sufficiently-long-password";
const PUBLIC_WEB_URL = "https://app.telflo.local";
const USER_ID = "0199e000-0000-7000-8000-0000000000a1";
const ORGANIZATION_ID = "0199e000-0000-7000-8000-0000000000b1";
const SESSION_ID = "0199e000-0000-7000-8000-0000000000c1";

/** A stand-in for Argon2id: the "hash" names its password, so a verify is a comparison. */
const fakeHash = (plaintext: string) => `hash(${plaintext})`;

function buildHarness(options: { passwordHash?: string | null; isDeleted?: boolean } = {}) {
  const calls: string[] = [];
  const stored = {
    passwordHash: options.passwordHash === undefined ? fakeHash(CURRENT_PASSWORD) : options.passwordHash,
    isDeleted: options.isDeleted ?? false,
  };
  /** What the transaction's reread sees: the stored hash unless a test changes it in between. */
  let hashSeenUnderLock: () => string | null | undefined = () => (stored.isDeleted ? undefined : stored.passwordHash);
  const committed: AuditEvent[] = [];
  const outside: AuditEvent[] = [];
  const consumedFor: string[] = [];
  const at = new Date("2030-01-01T00:00:00.000Z");
  const mailer = createInMemoryMailer();
  const runner = createCollectingRunner();
  const user: User = {
    id: USER_ID,
    email: "person@example.com",
    passwordHash: stored.passwordHash,
    emailVerifiedAt: at,
    acceptedTermsVersion: "2026-01-01",
    createdAt: at,
  };

  const audit = {
    record: vi.fn(async (event: AuditEvent) => {
      calls.push(`audit:${event.action}`);
      outside.push(event);
    }),
  } satisfies IAuditRepository;

  const deps: AccountServiceDependencies = {
    users: {
      findById: vi.fn(async () => {
        calls.push("findById");
        return stored.isDeleted ? undefined : user;
      }),
    },
    audit,
    withTransaction: async <Result>(work: (transaction: AccountTransaction) => Promise<Result>) => {
      calls.push("begin");
      const pending: AuditEvent[] = [];
      const transaction: AccountTransaction = {
        users: {
          lockForUpdate: async () => void calls.push("lockForUpdate"),
          findPasswordHashForShare: async () => {
            calls.push("findPasswordHashForShare");
            return hashSeenUnderLock();
          },
          setPasswordHash: async (_userId, hash) => {
            calls.push("setPasswordHash");
            stored.passwordHash = hash;
            return true;
          },
        },
        passwordResetTokens: {
          consumeAllForUser: async (userId) => {
            calls.push("consumeAllForUser");
            consumedFor.push(userId);
            return 1;
          },
        },
        audit: {
          record: async (event) => {
            calls.push(`transaction audit:${event.action}`);
            pending.push(event);
          },
        },
      };
      const result = await work(transaction);
      committed.push(...pending);
      calls.push("commit");
      return result;
    },
    mailer,
    settings: { publicWebUrl: PUBLIC_WEB_URL },
    now: () => at,
    runAfterResponse: (task) => {
      calls.push("runAfterResponse");
      runner.run(task);
    },
    verifyPassword: async (hash, plaintext) => {
      calls.push("verifyPassword");
      return hash === fakeHash(plaintext);
    },
    hashPassword: async (plaintext) => {
      calls.push("hashPassword");
      return fakeHash(plaintext);
    },
  };

  const context = createAuthContext({ userId: USER_ID, organizationId: ORGANIZATION_ID, role: "admin", sessionId: SESSION_ID });
  const origin = { ipAddress: "192.0.2.10", userAgent: "service-test" };
  const change = (currentPassword = CURRENT_PASSWORD) =>
    createAccountService(deps).changePassword({ context, currentPassword, newPassword: NEW_PASSWORD, origin });

  return {
    calls,
    stored,
    committed,
    outside,
    consumedFor,
    mailer,
    runner,
    change,
    setHashSeenUnderLock: (read: () => string | null | undefined) => {
      hashSeenUnderLock = read;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("createAccountService().changePassword", () => {
  it("reads, verifies and hashes outside, then locks the user first, rereads, sets, consumes and audits in one transaction, and only then queues the email", async () => {
    const harness = buildHarness();

    await harness.change();

    expect(harness.calls).toEqual([
      "findById",
      "verifyPassword",
      "hashPassword",
      "begin",
      "lockForUpdate",
      "findPasswordHashForShare",
      "setPasswordHash",
      "consumeAllForUser",
      "transaction audit:user.password_changed",
      "commit",
      "runAfterResponse",
    ]);
    expect(harness.stored.passwordHash).toBe(fakeHash(NEW_PASSWORD));
    expect(harness.consumedFor).toEqual([USER_ID]);
  });

  it("audits user.password_changed with ids only: subject the user, no metadata, the session's organization, the origin in its columns", async () => {
    const harness = buildHarness();

    await harness.change();

    expect(harness.committed).toEqual([
      {
        action: "user.password_changed",
        actorUserId: USER_ID,
        actorEmail: "person@example.com",
        organizationId: ORGANIZATION_ID,
        subjectType: "user",
        subjectId: USER_ID,
        ipAddress: "192.0.2.10",
        userAgent: "service-test",
      },
    ]);
    expect(JSON.stringify(harness.committed)).not.toContain(CURRENT_PASSWORD);
    expect(JSON.stringify(harness.committed)).not.toContain(NEW_PASSWORD);
  });

  it("sends nothing until the runner runs, then the password-changed email to the account's address", async () => {
    const harness = buildHarness();

    await harness.change();
    expect(harness.mailer.sent).toEqual([]);

    await harness.runner.settle();
    expect(harness.mailer.sent).toHaveLength(1);
    expect(harness.mailer.sent[0]).toMatchObject({
      to: "person@example.com",
      subject: "Your Telflo password was changed",
    });
    expect(harness.mailer.sent[0]!.text).toContain(`${PUBLIC_WEB_URL}/forgot-password`);
  });

  it("refuses a password-less account with 409 password_not_set before any verify, writing nothing", async () => {
    const harness = buildHarness({ passwordHash: null });

    const error = await refusal(harness.change());

    expect(error).toMatchObject({ code: "password_not_set", statusCode: 409 });
    expect(harness.calls).toEqual(["findById"]);
  });

  it("refuses a wrong current password with current_password_incorrect, audits user.reauthentication_failed {purpose: password_change} outside any transaction, and opens none", async () => {
    const harness = buildHarness();

    const error = await refusal(harness.change("not-the-current-password"));

    expect(error).toMatchObject({ code: "current_password_incorrect", statusCode: 400 });
    expect(harness.calls).toEqual(["findById", "verifyPassword", "audit:user.reauthentication_failed"]);
    expect(harness.outside).toEqual([
      {
        action: "user.reauthentication_failed",
        actorUserId: USER_ID,
        actorEmail: "person@example.com",
        organizationId: ORGANIZATION_ID,
        subjectType: "user",
        subjectId: USER_ID,
        metadata: { purpose: "password_change" },
        ipAddress: "192.0.2.10",
        userAgent: "service-test",
      },
    ]);
    expect(JSON.stringify(harness.outside)).not.toContain("not-the-current-password");
    expect(harness.stored.passwordHash).toBe(fakeHash(CURRENT_PASSWORD));
  });

  it("refuses when the hash changed between the verify and the lock: current_password_incorrect with the same audit row, nothing set, no token consumed, no email", async () => {
    const harness = buildHarness();
    // A reset (or another change) committed while this one was hashing.
    harness.setHashSeenUnderLock(() => fakeHash("the-reset-password"));

    const error = await refusal(harness.change());

    expect(error).toMatchObject({ code: "current_password_incorrect", statusCode: 400 });
    expect(harness.calls).toEqual([
      "findById",
      "verifyPassword",
      "hashPassword",
      "begin",
      "lockForUpdate",
      "findPasswordHashForShare",
      "commit",
      "audit:user.reauthentication_failed",
    ]);
    expect(harness.outside).toEqual([
      expect.objectContaining({ action: "user.reauthentication_failed", metadata: { purpose: "password_change" } }),
    ]);
    expect(harness.committed).toEqual([]);
    expect(harness.consumedFor).toEqual([]);
    await harness.runner.settle();
    expect(harness.mailer.sent).toEqual([]);
  });

  it("answers 401 unauthenticated for a user deleted since the session check, and for one deleted under the lock", async () => {
    const before = buildHarness({ isDeleted: true });
    expect(await refusal(before.change())).toMatchObject({ code: "unauthenticated", statusCode: 401 });
    expect(before.calls).toEqual(["findById"]);

    const under = buildHarness();
    under.setHashSeenUnderLock(() => undefined);
    expect(await refusal(under.change())).toMatchObject({ code: "unauthenticated", statusCode: 401 });
    expect(under.calls).not.toContain("setPasswordHash");
    expect(under.outside).toEqual([]);
  });
});
