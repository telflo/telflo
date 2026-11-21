import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionRevokedReason } from "@telflo/db";
import { AppError } from "../../errors.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { hashPassword, verifyPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IUserRepository, User } from "../identity/repositories/user-repository.js";
import type {
  CreatePasswordResetTokenInput,
  IPasswordResetTokenRepository,
  PasswordResetConsumeResult,
} from "./repositories/password-reset-token-repository.js";
import {
  createPasswordResetService,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  type PasswordResetTransaction,
} from "./service.js";

const OLD_PASSWORD = "the-old-password-that-was-forgotten";
const NEW_PASSWORD = "a-brand-new-sufficiently-long-password";
const MINUTE = 60 * 1000;
const PUBLIC_WEB_URL = "https://app.telflo.local";

interface StoredUser extends User {
  deletedAt: Date | null;
}

interface StoredResetToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredSession {
  id: string;
  userId: string;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
}

let oldPasswordHash: string;

beforeAll(async () => {
  oldPasswordHash = await hashPassword(OLD_PASSWORD);
});

/**
 * Hand-built fakes typed against the repository interfaces (`satisfies`, so
 * an interface change the fakes do not follow fails to compile), on an
 * injected clock.
 */
function buildHarness() {
  const users = new Map<string, StoredUser>();
  const resetTokens = new Map<string, StoredResetToken>();
  const sessions: StoredSession[] = [];
  const auditEvents: AuditEvent[] = [];
  const clock = { current: new Date("2030-01-01T00:00:00.000Z") };
  const now = () => new Date(clock.current);
  const mailer = createInMemoryMailer();

  const userRepository = {
    findByEmail: vi.fn(async (email: string) => {
      const normalized = email.trim().toLowerCase();
      return [...users.values()].find((user) => user.email === normalized && user.deletedAt === null);
    }),
    findById: vi.fn(async (id: string) => {
      const user = users.get(id);
      return user && user.deletedAt === null ? user : undefined;
    }),
    createAccount: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    markEmailVerified: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    setPasswordAndConfirmEmail: vi.fn(async (userId: string, passwordHash: string, at: Date) => {
      const user = users.get(userId);
      if (!user || user.deletedAt) return undefined;
      const wasUnconfirmed = user.emailVerifiedAt === null;
      user.passwordHash = passwordHash;
      user.emailVerifiedAt ??= at;
      return { email: user.email, wasUnconfirmed };
    }),
    findPasswordHashForShare: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    findByEmailIncludingDeleted: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    createFederatedAccount: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    setPasswordHash: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    takeOverUnverified: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    acceptTerms: vi.fn(async () => {
      throw new Error("not used by the password reset service");
    }),
    // Nothing to lock in memory; recorded so the order of calls can be checked.
    lockForUpdate: vi.fn(async () => undefined),
  } satisfies IUserRepository;

  const resetTokenRepository = {
    create: vi.fn(async (input: CreatePasswordResetTokenInput) => {
      resetTokens.set(input.tokenHash, { ...input, consumedAt: null });
    }),
    findUserIdByHash: vi.fn(async (tokenHash: string) => resetTokens.get(tokenHash)?.userId),
    consume: vi.fn(async (tokenHash: string, at: Date): Promise<PasswordResetConsumeResult> => {
      const row = resetTokens.get(tokenHash);
      if (!row) return { status: "not_found" };
      if (row.consumedAt) return { status: "already_consumed", userId: row.userId };
      row.consumedAt = at;
      return { status: "consumed", userId: row.userId, expiresAt: row.expiresAt };
    }),
    consumeAllForUser: vi.fn(async (userId: string, at: Date) => {
      let count = 0;
      for (const row of resetTokens.values()) {
        if (row.userId === userId && row.consumedAt === null) {
          row.consumedAt = at;
          count += 1;
        }
      }
      return count;
    }),
  } satisfies IPasswordResetTokenRepository;

  const sessionRepository = {
    revokeAllForUser: vi.fn(async (userId: string, reason: SessionRevokedReason) => {
      let count = 0;
      for (const session of sessions) {
        if (session.userId === userId && session.revokedAt === null) {
          session.revokedAt = now();
          session.revokedReason = reason;
          count += 1;
        }
      }
      return count;
    }),
  } satisfies PasswordResetTransaction["sessions"];

  const auditRepository = {
    record: vi.fn(async (event: AuditEvent) => {
      auditEvents.push(event);
    }),
  } satisfies IAuditRepository;

  const service = createPasswordResetService({
    users: userRepository,
    audit: auditRepository,
    mailer,
    settings: { publicWebUrl: PUBLIC_WEB_URL },
    now,
    // No real transaction: the fakes have nothing to roll back. Atomicity is
    // proven against Postgres in routes.integration.test.ts.
    withTransaction: <Result>(work: (transaction: PasswordResetTransaction) => Promise<Result>) =>
      work({ users: userRepository, passwordResetTokens: resetTokenRepository, sessions: sessionRepository }),
  });

  function addUser(options: { isVerified?: boolean; isDeleted?: boolean } = {}): StoredUser {
    const user: StoredUser = {
      id: randomUUID(),
      email: `person-${users.size + 1}@example.com`,
      passwordHash: oldPasswordHash,
      emailVerifiedAt: options.isVerified === false ? null : new Date("2029-12-01T00:00:00.000Z"),
      acceptedTermsVersion: "2026-01-01",
      createdAt: new Date("2029-12-01T00:00:00.000Z"),
      deletedAt: options.isDeleted ? new Date("2029-12-15T00:00:00.000Z") : null,
    };
    users.set(user.id, user);
    return user;
  }

  function addSession(userId: string): StoredSession {
    const session: StoredSession = { id: randomUUID(), userId, revokedAt: null, revokedReason: null };
    sessions.push(session);
    return session;
  }

  /** A reset token as the repository stores it; returns the plaintext. */
  function addToken(userId: string, options: { expiresAt?: Date; consumedAt?: Date } = {}): string {
    const token = randomUUID();
    resetTokens.set(hashToken(token), {
      userId,
      tokenHash: hashToken(token),
      expiresAt: options.expiresAt ?? new Date(clock.current.getTime() + 30 * MINUTE),
      consumedAt: options.consumedAt ?? null,
    });
    return token;
  }

  /** The plaintext token in the one reset email sent. */
  function emailedToken(): string {
    expect(mailer.sent).toHaveLength(1);
    const match = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]!.text);
    if (!match) throw new Error("no reset link in the email");
    return match[1]!;
  }

  return {
    service,
    clock,
    users,
    userRepository,
    resetTokens,
    sessions,
    auditEvents,
    mailer,
    resetTokenRepository,
    addUser,
    addSession,
    addToken,
    emailedToken,
    advance(milliseconds: number) {
      clock.current = new Date(clock.current.getTime() + milliseconds);
    },
  };
}

const origin = { ipAddress: "192.0.2.1", userAgent: "vitest" };

/** Audit events as an assertion may show them: any string value that looks like a link hidden, so a failure never prints one. */
const hideLinks = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value ?? null, (_key, inner: unknown) =>
      typeof inner === "string" && /token=|reset-password|https?:\/\//i.test(inner) ? "<a link-shaped value>" : inner,
    ),
  );

async function expectInvalidResetToken(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    code: "invalid_reset_token",
    statusCode: 400,
    message: "That reset link is invalid or has expired. Request a new one.",
  });
}

describe("requestReset", () => {
  it("writes no token and sends no email for an unknown address, and audits no_account", async () => {
    const harness = buildHarness();

    await harness.service.requestReset({ email: "nobody@example.com", ...origin });

    expect(harness.resetTokens.size).toBe(0);
    expect(harness.resetTokenRepository.create).not.toHaveBeenCalled();
    expect(harness.mailer.sent).toEqual([]);
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_requested",
        metadata: { outcome: "no_account" },
        ...origin,
      },
    ]);
  });

  it("treats a soft-deleted account as none", async () => {
    const harness = buildHarness();
    const user = harness.addUser({ isDeleted: true });

    await harness.service.requestReset({ email: user.email, ...origin });

    expect(harness.resetTokens.size).toBe(0);
    expect(harness.mailer.sent).toEqual([]);
    expect(harness.auditEvents[0]?.metadata).toEqual({ outcome: "no_account" });
  });

  it.each([
    ["verified", true],
    ["unverified", false],
  ])(
    "for a %s user, consumes their earlier tokens, then writes one expiring in 60 minutes and emails its plaintext",
    async (_label, isVerified) => {
      const harness = buildHarness();
      const user = harness.addUser({ isVerified });
      const other = harness.addUser();
      const earlier = harness.addToken(user.id);
      const othersToken = harness.addToken(other.id);

      await harness.service.requestReset({ email: user.email.toUpperCase(), ...origin });

      // The user's row locked, then the earlier tokens consumed, then the new
      // one written: only the newest link works.
      const { consumeAllForUser, create } = harness.resetTokenRepository;
      const { lockForUpdate } = harness.userRepository;
      expect(lockForUpdate).toHaveBeenCalledWith(user.id);
      expect(lockForUpdate.mock.invocationCallOrder[0]).toBeLessThan(consumeAllForUser.mock.invocationCallOrder[0]!);
      expect(consumeAllForUser).toHaveBeenCalledWith(user.id, harness.clock.current);
      expect(consumeAllForUser.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]!);
      expect(harness.resetTokens.get(hashToken(earlier))?.consumedAt).toEqual(harness.clock.current);
      expect(harness.resetTokens.get(hashToken(othersToken))?.consumedAt).toBeNull();

      const token = harness.emailedToken();
      expect(harness.mailer.sent[0]).toMatchObject({ to: user.email, subject: "Reset your Telflo password" });
      expect(harness.mailer.sent[0]!.text).toContain(`${PUBLIC_WEB_URL}/reset-password#token=${token}`);
      expect(harness.mailer.sent[0]!.text).not.toContain("?token=");
      expect(PASSWORD_RESET_TOKEN_TTL_MINUTES).toBe(60);
      expect(harness.resetTokens.get(hashToken(token))).toEqual({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(harness.clock.current.getTime() + 60 * MINUTE),
        consumedAt: null,
      });

      expect(harness.auditEvents).toEqual([
        {
          action: "user.password_reset_requested",
          actorUserId: user.id,
          actorEmail: user.email,
          subjectType: "user",
          subjectId: user.id,
          metadata: { outcome: "sent" },
          ...origin,
        },
      ]);
    },
  );

  it("audits send_failed with the actor and rethrows when the email cannot be sent, keeping the token", async () => {
    const harness = buildHarness();
    const user = harness.addUser();
    const failure = new Error("smtp unavailable");
    vi.spyOn(harness.mailer, "send").mockRejectedValueOnce(failure);

    await expect(harness.service.requestReset({ email: user.email, ...origin })).rejects.toBe(failure);

    expect(harness.resetTokens.size).toBe(1);
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_requested",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { outcome: "send_failed" },
        ...origin,
      },
    ]);
  });
});

describe("issueResetLink", () => {
  it("writes requestReset's token (hashed, 60 minutes, the earlier ones consumed) and hands back its link, sending no email; the audit row holds no link", async () => {
    const harness = buildHarness();
    const user = harness.addUser({ isVerified: false });
    const earlier = harness.addToken(user.id);

    const link = await harness.service.issueResetLink({ email: user.email.toUpperCase(), ...origin });

    expect(harness.mailer.sent).toEqual([]);
    const prefix = `${PUBLIC_WEB_URL}/reset-password#token=`;
    expect(link !== undefined && link.startsWith(prefix)).toBe(true);
    const token = link!.slice(prefix.length);
    expect(/^[A-Za-z0-9_-]{20,}$/.test(token)).toBe(true);
    const stored = harness.resetTokens.get(hashToken(token));
    expect(stored?.userId === user.id && stored.consumedAt === null).toBe(true);
    expect(stored?.expiresAt).toEqual(new Date(harness.clock.current.getTime() + 60 * MINUTE));
    expect([...harness.resetTokens.keys()].includes(token)).toBe(false);
    expect(harness.resetTokens.get(hashToken(earlier))?.consumedAt).toEqual(harness.clock.current);
    expect(harness.userRepository.lockForUpdate).toHaveBeenCalledWith(user.id);

    expect(JSON.stringify(harness.auditEvents).includes(token)).toBe(false);
    expect(hideLinks(harness.auditEvents)).toEqual([
      {
        action: "user.password_reset_requested",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { outcome: "returned" },
        ...origin,
      },
    ]);

    // The link completes like a mailed one: the password set, the email confirmed, once.
    const completed = await harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin });
    expect(completed.emailConfirmed).toBe(true);
    await expectInvalidResetToken(harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin }));
  });

  it("records the operator's command in the audit row when it asked (telflo-admin reset-link)", async () => {
    const harness = buildHarness();
    const user = harness.addUser();

    const link = await harness.service.issueResetLink({ email: user.email, via: "admin_command" });

    expect(link !== undefined).toBe(true);
    expect(harness.mailer.sent).toEqual([]);
    expect(hideLinks(harness.auditEvents.map((event) => event.metadata))).toEqual([{ outcome: "returned", via: "admin_command" }]);
  });

  it("answers undefined, writing no token, for an address without a live account (audited no_account)", async () => {
    const harness = buildHarness();
    const deleted = harness.addUser({ isDeleted: true });

    for (const email of ["nobody@example.com", deleted.email]) {
      expect(await harness.service.issueResetLink({ email, ...origin })).toBeUndefined();
    }
    expect(harness.resetTokens.size).toBe(0);
    expect(harness.mailer.sent).toEqual([]);
    expect(harness.auditEvents.map((event) => event.metadata)).toEqual([{ outcome: "no_account" }, { outcome: "no_account" }]);
  });
});

describe("completeReset", () => {
  it("sets the new hash, revokes every session with password_reset, consumes the other tokens, and audits the counts", async () => {
    const harness = buildHarness();
    const user = harness.addUser();
    const otherUser = harness.addUser();
    const sessions = [harness.addSession(user.id), harness.addSession(user.id)];
    const othersSession = harness.addSession(otherUser.id);
    const token = harness.addToken(user.id);
    const stale = harness.addToken(user.id);

    const result = await harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin });

    expect(result).toEqual({ userId: user.id, email: user.email, revokedSessions: 2, emailConfirmed: false });
    const stored = harness.users.get(user.id)!;
    expect(await verifyPassword(stored.passwordHash!, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(stored.passwordHash!, OLD_PASSWORD)).toBe(false);
    for (const session of sessions) expect(session.revokedReason).toBe("password_reset");
    expect(othersSession.revokedAt).toBeNull();
    expect(harness.resetTokens.get(hashToken(token))?.consumedAt).toEqual(harness.clock.current);
    expect(harness.resetTokens.get(hashToken(stale))?.consumedAt).toEqual(harness.clock.current);
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { revokedSessions: 2, emailConfirmed: false },
        ...origin,
      },
    ]);
  });

  it("confirms an unconfirmed email and says so", async () => {
    const harness = buildHarness();
    const user = harness.addUser({ isVerified: false });
    const token = harness.addToken(user.id);

    const result = await harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin });

    expect(result.emailConfirmed).toBe(true);
    expect(harness.users.get(user.id)!.emailVerifiedAt).toEqual(harness.clock.current);
    expect(harness.auditEvents[0]?.metadata).toEqual({ revokedSessions: 0, emailConfirmed: true });
  });

  it("refuses a used token with invalid_reset_token, audited as used", async () => {
    const harness = buildHarness();
    const user = harness.addUser();
    const token = harness.addToken(user.id);
    await harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin });
    const hashAfterFirst = harness.users.get(user.id)!.passwordHash;
    harness.auditEvents.length = 0;

    await expectInvalidResetToken(
      harness.service.completeReset({ token, password: "yet-another-long-password", ...origin }),
    );

    expect(harness.users.get(user.id)!.passwordHash).toBe(hashAfterFirst);
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_failed",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { reason: "used" },
        ...origin,
      },
    ]);
  });

  it.each([
    ["exactly at its expiry", 0],
    ["after its expiry", 1],
  ])("refuses a token %s, audited as expired, and changes nothing but consuming it", async (_label, pastMs) => {
    const harness = buildHarness();
    const user = harness.addUser();
    const session = harness.addSession(user.id);
    const expiresAt = new Date(harness.clock.current.getTime() + 60 * MINUTE);
    const token = harness.addToken(user.id, { expiresAt });
    harness.advance(60 * MINUTE + pastMs);

    await expectInvalidResetToken(harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin }));

    expect(harness.users.get(user.id)!.passwordHash).toBe(oldPasswordHash);
    expect(session.revokedAt).toBeNull();
    expect(harness.resetTokens.get(hashToken(token))?.consumedAt).toEqual(harness.clock.current);
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_failed",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { reason: "expired" },
        ...origin,
      },
    ]);
  });

  it("accepts a token a moment before its expiry", async () => {
    const harness = buildHarness();
    const user = harness.addUser();
    const token = harness.addToken(user.id, { expiresAt: new Date(harness.clock.current.getTime() + 60 * MINUTE) });
    harness.advance(60 * MINUTE - 1);

    await expect(harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin })).resolves.toMatchObject({
      userId: user.id,
    });
  });

  it("finds the token's user, locks the user's row, and only then consumes the token", async () => {
    // requestReset locks the user's row and then consumes tokens; consuming
    // before locking here would take the two in the reverse order and let a
    // concurrent request and completion deadlock.
    const harness = buildHarness();
    const user = harness.addUser();
    const token = harness.addToken(user.id);

    await harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin });

    const { findUserIdByHash, consume, consumeAllForUser } = harness.resetTokenRepository;
    const { lockForUpdate, setPasswordAndConfirmEmail } = harness.userRepository;
    expect(findUserIdByHash).toHaveBeenCalledWith(hashToken(token));
    expect(lockForUpdate).toHaveBeenCalledWith(user.id);
    expect(consume).toHaveBeenCalledWith(hashToken(token), harness.clock.current);
    const order = [findUserIdByHash, lockForUpdate, consume, setPasswordAndConfirmEmail, consumeAllForUser].map(
      (mock) => mock.mock.invocationCallOrder[0]!,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("refuses an unknown token, audited as unknown_token with no actor", async () => {
    const harness = buildHarness();
    harness.addUser();

    await expectInvalidResetToken(
      harness.service.completeReset({ token: "never-issued", password: NEW_PASSWORD, ...origin }),
    );

    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_failed",
        metadata: { reason: "unknown_token" },
        ...origin,
      },
    ]);
  });

  it("refuses a soft-deleted user's token and changes nothing but consuming it", async () => {
    const harness = buildHarness();
    const user = harness.addUser({ isDeleted: true });
    const session = harness.addSession(user.id);
    const token = harness.addToken(user.id);
    const other = harness.addToken(user.id);

    await expectInvalidResetToken(harness.service.completeReset({ token, password: NEW_PASSWORD, ...origin }));

    expect(harness.users.get(user.id)!.passwordHash).toBe(oldPasswordHash);
    expect(session.revokedAt).toBeNull();
    expect(harness.resetTokens.get(hashToken(token))?.consumedAt).toEqual(harness.clock.current);
    expect(harness.resetTokens.get(hashToken(other))?.consumedAt).toBeNull();
    expect(harness.auditEvents).toEqual([
      {
        action: "user.password_reset_failed",
        actorUserId: user.id,
        actorEmail: undefined,
        subjectType: "user",
        subjectId: user.id,
        metadata: { reason: "no_account" },
        ...origin,
      },
    ]);
  });
});
