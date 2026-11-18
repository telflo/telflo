import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRole, SessionRevokedReason } from "@telflo/db";
import type { DatabaseContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import { hashPassword, verifyPassword } from "../identity/password.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import type {
  CreatePersonalOrganizationInput,
  IOrganizationRepository,
} from "../organizations/repositories/organization-repository.js";
import type { IUserRepository, User } from "../identity/repositories/user-repository.js";
import { createAccessTokens } from "./access-tokens.js";
import type {
  ConsumeResult,
  CreateRefreshTokenInput,
  IRefreshTokenRepository,
} from "./repositories/refresh-token-repository.js";
import type {
  CreateSessionInput,
  ISessionRepository,
  LiveSession,
  Session,
} from "./repositories/session-repository.js";
import {
  createSessionService,
  type IssuedSession,
  type ISessionService,
  REFRESH_GRACE_SECONDS,
  type SessionTransaction,
  warmUpSessionService,
} from "./service.js";
import { OPEN_SOURCE_SITE } from "@telflo/contracts";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

const PASSWORD = "a-sufficiently-long-password";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface StoredUser extends User {
  deletedAt: Date | null;
  /** `users.is_product_admin` (D12 decision 3). */
  isProductAdmin: boolean;
}

interface StoredOrganization {
  id: string;
  name: string;
  type: "personal" | "group";
  ownerUserId: string;
  deletedAt: Date | null;
  logoId: string | null;
}

interface StoredMembership {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  deletedAt?: Date | null;
}

interface StoredRefreshToken {
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

let passwordHash: string;

beforeAll(async () => {
  // Real Argon2id, hashed once: the service's verify is the real one.
  passwordHash = await hashPassword(PASSWORD);
});

/**
 * Hand-built fakes typed against the repository interfaces (`satisfies`, so
 * an interface change that the fakes do not follow fails to compile). The
 * access tokens are the real implementation on the test clock, so the pair
 * a test receives is a genuine one.
 */
function buildHarness() {
  // The site asks for the tests' Terms version (vitest.setup.ts's SaaS pin); a test may change it.
  const settings = {
    refreshTokenTtlDays: 30,
    site: { ...OPEN_SOURCE_SITE, terms: { ...OPEN_SOURCE_SITE.terms, version: TEST_TERMS_VERSION } },
  };
  const users = new Map<string, StoredUser>();
  const organizations = new Map<string, StoredOrganization>();
  const memberships: StoredMembership[] = [];
  const sessionRows = new Map<string, Session>();
  const refreshTokenRows = new Map<string, StoredRefreshToken>();
  const auditEvents: AuditEvent[] = [];
  /** The locking reads, in order: `organization:<id>`, `membership:<id>` and `user:<id>` (the check's). */
  const locks: string[] = [];
  const clock = { current: new Date("2030-01-01T00:00:00.000Z") };
  const now = () => new Date(clock.current);

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
      throw new Error("not used by the session service");
    }),
    markEmailVerified: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    setPasswordAndConfirmEmail: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    findPasswordHashForShare: vi.fn(async (id: string) => {
      locks.push(`user:${id}`);
      const user = users.get(id);
      return user && user.deletedAt === null ? user.passwordHash : undefined;
    }),
    findByEmailIncludingDeleted: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    createFederatedAccount: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    setPasswordHash: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    takeOverUnverified: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    acceptTerms: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    lockForUpdate: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
  } satisfies IUserRepository;

  const liveMembershipsOf = (userId: string) =>
    memberships
      .filter((membership) => membership.userId === userId && !membership.deletedAt)
      .map((membership) => ({ membership, organization: organizations.get(membership.organizationId)! }))
      .filter(({ organization }) => organization.deletedAt === null);
  const liveOrganizationsOf = (userId: string) =>
    liveMembershipsOf(userId).map(({ organization }) => organization);

  /** An organization as the repository returns it, unless soft-deleted. */
  const liveOrganization = (organizationId: string) => {
    const organization = organizations.get(organizationId);
    if (!organization || organization.deletedAt) return undefined;
    return { ...organization, createdAt: new Date("2029-12-01T00:00:00.000Z"), logoContentType: null };
  };

  const organizationRepository = {
    createPersonal: vi.fn(async (_input: CreatePersonalOrganizationInput) => {
      throw new Error("not used by the session service");
    }),
    createGroup: vi.fn(async (_name: string) => {
      throw new Error("not used by the session service");
    }),
    nextId: vi.fn(async (): Promise<string> => {
      throw new Error("not used by the session service");
    }),
    findPersonalForUser: vi.fn(async (userId: string) => {
      const personal = liveOrganizationsOf(userId).find(
        (organization) => organization.type === "personal" && organization.ownerUserId === userId,
      );
      return personal ? { id: personal.id, name: personal.name } : undefined;
    }),
    listForUser: vi.fn(async (userId: string) =>
      liveMembershipsOf(userId).map(({ membership, organization }) => ({
        id: organization.id,
        name: organization.name,
        type: organization.type,
        logoId: organization.logoId,
        role: membership.role,
      })),
    ),
    /** `memberships` is in the order they were made: the last live one is the newest. */
    findNewestJoinedForUser: vi.fn(async (userId: string) => liveMembershipsOf(userId).at(-1)?.organization.id),
  } satisfies IOrganizationRepository;

  const sessionRepository = {
    create: vi.fn(async (input: CreateSessionInput) => {
      const session: Session = {
        id: randomUUID(),
        userId: input.userId,
        activeOrganizationId: input.activeOrganizationId,
        createdAt: now(),
        lastRefreshedAt: now(),
        revokedAt: null,
        revokedReason: null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      };
      sessionRows.set(session.id, session);
      return session;
    }),
    /** The same conditions as the real query's joins and filters. */
    findLiveWithUser: vi.fn(async (sessionId: string): Promise<LiveSession | undefined> => {
      const session = sessionRows.get(sessionId);
      if (!session || session.revokedAt) return undefined;
      const user = users.get(session.userId);
      if (!user || user.deletedAt || !user.emailVerifiedAt) return undefined;
      const organization = organizations.get(session.activeOrganizationId);
      if (!organization || organization.deletedAt) return undefined;
      const membership = memberships.find(
        (candidate) =>
          candidate.userId === user.id && candidate.organizationId === organization.id && !candidate.deletedAt,
      );
      if (!membership) return undefined;
      return {
        session: { ...session },
        user: {
          id: user.id,
          email: user.email,
          acceptedTermsVersion: user.acceptedTermsVersion,
          isProductAdmin: user.isProductAdmin,
        },
        organization: {
          id: organization.id,
          name: organization.name,
          type: organization.type,
          logoId: organization.logoId,
          role: membership.role,
        },
      };
    }),
    findLive: vi.fn(async (sessionId: string) => {
      const session = sessionRows.get(sessionId);
      return session && !session.revokedAt ? { ...session } : undefined;
    }),
    lockLive: vi.fn(async (sessionId: string) => {
      const session = sessionRows.get(sessionId);
      return session && !session.revokedAt ? { ...session } : undefined;
    }),
    setActiveOrganization: vi.fn(async (sessionId: string, organizationId: string) => {
      sessionRows.get(sessionId)!.activeOrganizationId = organizationId;
    }),
    revoke: vi.fn(async (sessionId: string, reason: SessionRevokedReason) => {
      const session = sessionRows.get(sessionId);
      if (!session || session.revokedAt) return false;
      session.revokedAt = now();
      session.revokedReason = reason;
      return true;
    }),
    revokeAllForUser: vi.fn(async (userId: string, reason: SessionRevokedReason) => {
      let count = 0;
      for (const session of sessionRows.values()) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = now();
          session.revokedReason = reason;
          count += 1;
        }
      }
      return count;
    }),
    listLiveForUser: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    revokeOwn: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    findLiveForShare: vi.fn(async () => {
      throw new Error("not used by the session service");
    }),
    touchRefreshed: vi.fn(async (sessionId: string, at: Date) => {
      const session = sessionRows.get(sessionId);
      if (session) session.lastRefreshedAt = at;
    }),
    /** The real query's order: refreshed last, then created last, then (for ties here) made last. */
    findMostRecentlyUsedOrganizationId: vi.fn(async (userId: string) => {
      const own = [...sessionRows.values()].filter((session) => session.userId === userId).reverse();
      own.sort(
        (a, b) =>
          b.lastRefreshedAt.getTime() - a.lastRefreshedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return own[0]?.activeOrganizationId;
    }),
  } satisfies ISessionRepository;

  const refreshTokenRepository = {
    create: vi.fn(async (input: CreateRefreshTokenInput) => {
      const row: StoredRefreshToken = { ...input, consumedAt: null };
      refreshTokenRows.set(input.tokenHash, row);
      return {
        id: randomUUID(),
        sessionId: input.sessionId,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now(),
      };
    }),
    consume: vi.fn(async (tokenHash: string, at: Date): Promise<ConsumeResult> => {
      const row = refreshTokenRows.get(tokenHash);
      if (!row) return { status: "not_found" };
      const userId = sessionRows.get(row.sessionId)!.userId;
      if (row.consumedAt) {
        return {
          status: "already_consumed",
          sessionId: row.sessionId,
          userId,
          expiresAt: row.expiresAt,
          consumedAt: row.consumedAt,
        };
      }
      row.consumedAt = at;
      return { status: "consumed", sessionId: row.sessionId, userId, expiresAt: row.expiresAt };
    }),
  } satisfies IRefreshTokenRepository;

  const auditRepository = {
    record: vi.fn(async (event: AuditEvent) => {
      auditEvents.push(event);
    }),
  } satisfies IAuditRepository;

  const accessTokens = createAccessTokens({
    secret: "unit-test-only-secret-that-is-32-bytes-long",
    ttlMinutes: 15,
    now,
  });

  const verifyPasswordSpy = vi.fn(verifyPassword);

  /**
   * Every database context the service set, in order. The fakes don't apply
   * row-level security; routes.integration.test.ts and
   * database/row-level-security.integration.test.ts do.
   */
  const contexts: DatabaseContext[] = [];

  const service: ISessionService = createSessionService({
    users: userRepository,
    withUserOrganizations: async (userId, work) => {
      contexts.push({ userId, organizationId: null });
      return work(organizationRepository);
    },
    sessions: sessionRepository,
    audit: auditRepository,
    // No real transaction: the fakes have nothing to roll back. Atomicity
    // is proven against Postgres in routes.integration.test.ts.
    withTransaction: <Result>(work: (transaction: SessionTransaction) => Promise<Result>) =>
      work({
        users: userRepository,
        sessions: sessionRepository,
        organizations: organizationRepository,
        refreshTokens: refreshTokenRepository,
        audit: auditRepository,
        setDatabaseContext: async (context) => {
          contexts.push(context);
        },
        // The target's locking reads, with the real queries' conditions. The
        // locks themselves are proven in routes.integration.test.ts.
        inOrganization: (organizationId: string) => ({
          organization: {
            findActive: vi.fn(async () => liveOrganization(organizationId)),
            findActiveForShare: vi.fn(async () => {
              locks.push(`organization:${organizationId}`);
              return liveOrganization(organizationId);
            }),
          },
          members: {
            find: vi.fn(async (userId: string) => {
              const membership = memberships.find(
                (candidate) => candidate.organizationId === organizationId && candidate.userId === userId,
              );
              const user = users.get(userId);
              if (!membership || !user || user.deletedAt) return undefined;
              return {
                userId,
                email: user.email,
                role: membership.role,
                isOrganizationOwner: organizations.get(organizationId)?.ownerUserId === userId,
                createdAt: new Date("2029-12-01T00:00:00.000Z"),
                deletedAt: membership.deletedAt ?? null,
                isServiceAccount: false,
              };
            }),
            findForShare: vi.fn(async (userId: string) => {
              locks.push(`membership:${organizationId}`);
              const membership = memberships.find(
                (candidate) =>
                  candidate.organizationId === organizationId && candidate.userId === userId && !candidate.deletedAt,
              );
              return membership
                ? { id: randomUUID(), createdAt: new Date("2029-12-01T00:00:00.000Z"), ...membership }
                : undefined;
            }),
          },
        }),
      }),
    accessTokens,
    settings,
    now,
    verifyPassword: verifyPasswordSpy,
  });

  /** A user with a personal organization they administer, as registration makes them. */
  function addUser(
    options: { email?: string; passwordHash?: string | null; isVerified?: boolean; hasPersonal?: boolean } = {},
  ) {
    const user: StoredUser = {
      id: randomUUID(),
      email: options.email ?? `person-${users.size + 1}@example.com`,
      passwordHash: options.passwordHash === undefined ? passwordHash : options.passwordHash,
      emailVerifiedAt: options.isVerified === false ? null : new Date("2029-12-01T00:00:00.000Z"),
      acceptedTermsVersion: TEST_TERMS_VERSION,
      createdAt: new Date("2029-12-01T00:00:00.000Z"),
      deletedAt: null,
      isProductAdmin: false,
    };
    users.set(user.id, user);
    const type = options.hasPersonal === false ? "group" : "personal";
    const organization = addOrganization(user.id, type, user.email);
    memberships.push({ organizationId: organization.id, userId: user.id, role: "admin" });
    return { user, organization };
  }

  function addOrganization(ownerUserId: string, type: "personal" | "group", name: string) {
    const organization: StoredOrganization = { id: randomUUID(), name, type, ownerUserId, deletedAt: null, logoId: null };
    organizations.set(organization.id, organization);
    return organization;
  }

  return {
    service,
    settings,
    accessTokens,
    clock,
    users,
    organizations,
    memberships,
    sessionRows,
    refreshTokenRows,
    auditEvents,
    locks,
    contexts,
    userRepository,
    organizationRepository,
    sessionRepository,
    refreshTokenRepository,
    verifyPasswordSpy,
    addUser,
    addOrganization,
    advance(milliseconds: number) {
      clock.current = new Date(clock.current.getTime() + milliseconds);
    },
  };
}

type Harness = ReturnType<typeof buildHarness>;

const origin = { ipAddress: "203.0.113.7", userAgent: "vitest" };

/** Resolves to the AppError a call rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

function describeError(error: AppError) {
  return { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details };
}

const INVALID_CREDENTIALS = {
  code: "invalid_credentials",
  message: "Invalid login credentials",
  statusCode: 401,
  details: undefined,
};

describe("warmUpSessionService", () => {
  it("resolves once the dummy password hash is built", async () => {
    await expect(warmUpSessionService()).resolves.toBeUndefined();
  });
});

describe("session service", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  const signIn = (email: string, password = PASSWORD) => harness.service.signIn({ email, password, ...origin });

  describe("signIn", () => {
    it("signs in a verified user and returns a working pair whose access token names the personal organization", async () => {
      const { user, organization } = harness.addUser();

      const issued = await signIn(user.email);

      expect(issued.user).toEqual({ id: user.id, email: user.email });
      expect(issued.accessTokenExpiresAt).toEqual(new Date(harness.clock.current.getTime() + 15 * MINUTE));
      expect(issued.refreshTokenExpiresAt).toEqual(new Date(harness.clock.current.getTime() + 30 * DAY));

      const verified = await harness.accessTokens.verify(issued.accessToken);
      expect(verified.status).toBe("valid");
      if (verified.status !== "valid") return;
      expect(verified.claims.userId).toBe(user.id);
      expect(verified.claims.organizationId).toBe(organization.id);

      const session = harness.sessionRows.get(verified.claims.sessionId);
      expect(session).toMatchObject({
        userId: user.id,
        activeOrganizationId: organization.id,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      expect(await harness.service.authenticate(issued.accessToken)).toEqual({
        status: "authenticated",
        userId: user.id,
        email: user.email,
        hasAcceptedCurrentTerms: true,
        isProductAdmin: false,
        sessionId: verified.claims.sessionId,
        organization: { id: organization.id, name: organization.name, type: "personal", logoId: null, role: "admin" },
      });
      const refreshed = await harness.service.refresh({ refreshToken: issued.refreshToken, ...origin });
      expect(refreshed).toMatchObject({ kind: "rotated", issued: { user: { id: user.id, email: user.email } } });
    });

    it("stores the refresh token only as its hash", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      const stored = [...harness.refreshTokenRows.values()];
      expect(stored).toHaveLength(1);
      expect(stored[0]!.tokenHash).not.toBe(issued.refreshToken);
      expect(harness.refreshTokenRows.has(issued.refreshToken)).toBe(false);
    });

    it("gives an unknown email, a wrong password, a null password hash and a soft-deleted user the identical error", async () => {
      const wrong = harness.addUser();
      const federated = harness.addUser({ passwordHash: null });
      const deleted = harness.addUser();
      deleted.user.deletedAt = new Date("2029-12-15T00:00:00.000Z");

      const errors = await Promise.all([
        rejection(signIn("nobody@example.com")),
        rejection(signIn(wrong.user.email, "not-the-password")),
        rejection(signIn(federated.user.email)),
        rejection(signIn(deleted.user.email)),
      ]);

      for (const error of errors) expect(describeError(error)).toEqual(INVALID_CREDENTIALS);
      expect(harness.sessionRows.size).toBe(0);
    });

    it("still performs one password verification, against an Argon2id hash with the stored parameters, for an unknown email", async () => {
      await rejection(signIn("nobody@example.com"));

      expect(harness.verifyPasswordSpy).toHaveBeenCalledOnce();
      const [hashValue, plaintext] = harness.verifyPasswordSpy.mock.calls[0]!;
      expect(hashValue).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(plaintext).toBe(PASSWORD);
    });

    it("still performs one password verification for an account with no password", async () => {
      const { user } = harness.addUser({ passwordHash: null });
      await rejection(signIn(user.email));

      expect(harness.verifyPasswordSpy).toHaveBeenCalledOnce();
      expect(harness.verifyPasswordSpy.mock.calls[0]![0]).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    });

    it("performs exactly one verification for a wrong password, against the user's own hash", async () => {
      const { user } = harness.addUser();
      await rejection(signIn(user.email, "not-the-password"));
      expect(harness.verifyPasswordSpy).toHaveBeenCalledOnce();
      expect(harness.verifyPasswordSpy.mock.calls[0]![0]).toBe(passwordHash);
    });

    it("tells an unverified user with the right password email_not_verified", async () => {
      const { user } = harness.addUser({ isVerified: false });
      const error = await rejection(signIn(user.email));
      expect(describeError(error)).toEqual({
        code: "email_not_verified",
        message: "Email not confirmed",
        statusCode: 403,
        details: undefined,
      });
      expect(harness.sessionRows.size).toBe(0);
    });

    it("tells an unverified user with the wrong password only invalid_credentials", async () => {
      const { user } = harness.addUser({ isVerified: false });
      const error = await rejection(signIn(user.email, "not-the-password"));
      expect(describeError(error)).toEqual(INVALID_CREDENTIALS);
    });

    it("matches the email case-insensitively", async () => {
      const { user } = harness.addUser({ email: "person@example.com" });
      const issued = await signIn("  Person@EXAMPLE.com ");
      expect(issued.user.id).toBe(user.id);
    });

    it("fails with a 500, audits no_personal_organization, and creates no session for a user without a personal organization", async () => {
      const { user } = harness.addUser({ hasPersonal: false });

      const error = await rejection(signIn(user.email));

      expect(error.statusCode).toBe(500);
      expect(error.code).toBe("internal_error");
      expect(harness.sessionRepository.create).not.toHaveBeenCalled();
      expect(harness.refreshTokenRows.size).toBe(0);
      expect(harness.auditEvents).toEqual([
        {
          action: "user.sign_in_failed",
          actorUserId: user.id,
          actorEmail: user.email,
          metadata: { reason: "no_personal_organization" },
          ...origin,
        },
      ]);
    });

    it("does not fall back to another organization when the personal one is soft-deleted", async () => {
      const { user, organization } = harness.addUser();
      const group = harness.addOrganization(randomUUID(), "group", "Group");
      harness.memberships.push({ organizationId: group.id, userId: user.id, role: "contributor" });
      organization.deletedAt = new Date("2029-12-20T00:00:00.000Z");

      const error = await rejection(signIn(user.email));

      expect(error.statusCode).toBe(500);
      expect(harness.sessionRows.size).toBe(0);
    });

    it("refuses with invalid_credentials, audits password_changed and creates nothing when the hash changed after it verified (D3 Ruling 15)", async () => {
      const { user } = harness.addUser();
      const newHash = await hashPassword("a-different-sufficiently-long-password");
      // A reset commits between the verify and the transaction's recheck: the
      // stored row gets a new hash, while the user the service read keeps the old.
      harness.verifyPasswordSpy.mockImplementationOnce(async (hashValue: string, plaintext: string) => {
        const isValid = await verifyPassword(hashValue, plaintext);
        harness.users.set(user.id, { ...user, passwordHash: newHash });
        return isValid;
      });

      const error = await rejection(signIn(user.email));

      expect(error).toMatchObject({ code: "invalid_credentials", statusCode: 401, message: "Invalid login credentials" });
      expect(harness.userRepository.findPasswordHashForShare).toHaveBeenCalledWith(user.id);
      expect(harness.sessionRepository.create).not.toHaveBeenCalled();
      expect(harness.sessionRows.size).toBe(0);
      expect(harness.refreshTokenRows.size).toBe(0);
      expect(harness.auditEvents).toEqual([
        {
          action: "user.sign_in_failed",
          actorUserId: user.id,
          actorEmail: user.email,
          metadata: { reason: "password_changed" },
          ...origin,
        },
      ]);
    });

    it("rechecks the hash before creating the session", async () => {
      const { user } = harness.addUser();
      await signIn(user.email);

      const { findPasswordHashForShare } = harness.userRepository;
      expect(findPasswordHashForShare).toHaveBeenCalledWith(user.id);
      expect(findPasswordHashForShare.mock.invocationCallOrder[0]).toBeLessThan(
        harness.sessionRepository.create.mock.invocationCallOrder[0]!,
      );
    });

    /** Each arranges one failure and returns the attempt, with the user it names when there is one. */
    const failures: [string, (h: Harness) => { email: string; password: string; userId?: string }][] = [
      ["unknown_email", () => ({ email: "nobody@example.com", password: PASSWORD })],
      [
        "no_password",
        (h) => {
          const { user } = h.addUser({ passwordHash: null });
          return { email: user.email, password: PASSWORD, userId: user.id };
        },
      ],
      [
        "wrong_password",
        (h) => {
          const { user } = h.addUser();
          return { email: user.email, password: "not-the-password", userId: user.id };
        },
      ],
      [
        "email_not_verified",
        (h) => {
          const { user } = h.addUser({ isVerified: false });
          return { email: user.email, password: PASSWORD, userId: user.id };
        },
      ],
    ];

    it.each(failures)("audits a failed sign-in with reason %s", async (reason, arrange) => {
      const { email, password, userId } = arrange(harness);
      await rejection(harness.service.signIn({ email, password, ...origin }));

      expect(harness.auditEvents).toHaveLength(1);
      const [event] = harness.auditEvents;
      expect(event).toMatchObject({ action: "user.sign_in_failed", metadata: { reason }, ...origin });
      expect(event!.actorUserId).toBe(userId);
      // The organization is looked up only after the credentials pass.
      expect(event!.organizationId).toBeUndefined();
    });

    it("audits a successful sign-in with the user, the personal organization and the session", async () => {
      const { user, organization } = harness.addUser();
      const issued = await signIn(user.email);
      const verified = await harness.accessTokens.verify(issued.accessToken);
      if (verified.status !== "valid") throw new Error("expected a valid token");

      expect(harness.auditEvents).toEqual([
        {
          action: "user.signed_in",
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: organization.id,
          subjectType: "session",
          subjectId: verified.claims.sessionId,
          ...origin,
        },
      ]);
    });
  });

  describe("startSession (D2c Ruling 10)", () => {
    it("runs the check first, then creates the session and audits user.signed_in with the metadata", async () => {
      const { user, organization } = harness.addUser({ passwordHash: null });
      const check = vi.fn(async () => true);

      const issued = await harness.service.startSession({
        user,
        organizationId: organization.id,
        origin,
        auditMetadata: { method: "oidc", provider: "google" },
        check,
      });

      expect(issued?.user).toEqual({ id: user.id, email: user.email });
      expect(check.mock.invocationCallOrder[0]).toBeLessThan(
        harness.sessionRepository.create.mock.invocationCallOrder[0]!,
      );
      expect(harness.auditEvents).toEqual([
        expect.objectContaining({
          action: "user.signed_in",
          actorUserId: user.id,
          organizationId: organization.id,
          metadata: { method: "oidc", provider: "google" },
        }),
      ]);
    });

    it("creates and audits nothing when the check refuses", async () => {
      const { user, organization } = harness.addUser();

      const issued = await harness.service.startSession({
        user,
        organizationId: organization.id,
        origin,
        check: async () => false,
      });

      expect(issued).toBeUndefined();
      expect(harness.sessionRows.size).toBe(0);
      expect(harness.refreshTokenRows.size).toBe(0);
      expect(harness.auditEvents).toEqual([]);
    });
  });

  describe("where a new sign-in lands (D36-1 decision 56, Q265)", () => {
    /** A person with their personal organization, then group organizations joined in the order named. */
    function personWithGroups(...names: string[]) {
      const { user, organization: personal } = harness.addUser();
      const groups = names.map((name) => {
        const group = harness.addOrganization(randomUUID(), "group", name);
        harness.memberships.push({ organizationId: group.id, userId: user.id, role: "contributor" });
        return group;
      });
      return { user, personal, groups };
    }

    /** Signs in; answers the new session's id and the organization it started in. */
    async function landing(email: string) {
      const issued = await signIn(email);
      const verified = await harness.accessTokens.verify(issued.accessToken);
      if (verified.status !== "valid") throw new Error("expected a valid token");
      const session = harness.sessionRows.get(verified.claims.sessionId)!;
      expect(session.activeOrganizationId).toBe(verified.claims.organizationId);
      return { issued, sessionId: session.id, organizationId: session.activeOrganizationId };
    }

    /** Signs out the session (it stays an earlier session, revoked), a minute later. */
    async function signOut(sessionId: string, userId: string) {
      harness.advance(MINUTE);
      await harness.service.signOut({ sessionId, userId, ...origin });
      harness.advance(MINUTE);
    }

    it("with no earlier session, lands in the organization joined most recently, and audits it", async () => {
      const { user, groups } = personWithGroups("First", "Second");

      const { organizationId, sessionId } = await landing(user.email);

      expect(organizationId).toBe(groups[1]!.id);
      expect(harness.auditEvents).toEqual([
        expect.objectContaining({ action: "user.signed_in", organizationId: groups[1]!.id, subjectId: sessionId }),
      ]);
    });

    it("with only the personal organization, lands there", async () => {
      const { user, personal } = personWithGroups();
      expect((await landing(user.email)).organizationId).toBe(personal.id);
    });

    it("lands in the earlier session's organization, revoked or not, over the newest membership", async () => {
      const { user, personal, groups } = personWithGroups("Earlier", "Newest");
      const first = await landing(user.email);
      // The person switches to "Earlier", then signs out.
      harness.sessionRows.get(first.sessionId)!.activeOrganizationId = groups[0]!.id;
      await signOut(first.sessionId, user.id);

      expect((await landing(user.email)).organizationId).toBe(groups[0]!.id);
      // And to the personal organization, when that is where they last were.
      const second = [...harness.sessionRows.values()].at(-1)!;
      second.activeOrganizationId = personal.id;
      await signOut(second.id, user.id);
      expect((await landing(user.email)).organizationId).toBe(personal.id);
    });

    it("takes the most recently used earlier session: the one refreshed last, not the one made last", async () => {
      const { user, groups } = personWithGroups("Refreshed", "Made last");
      const [refreshed, madeLast] = groups as [StoredOrganization, StoredOrganization];
      const first = await landing(user.email);
      harness.sessionRows.get(first.sessionId)!.activeOrganizationId = refreshed.id;
      harness.advance(MINUTE);
      const second = await landing(user.email);
      harness.sessionRows.get(second.sessionId)!.activeOrganizationId = madeLast.id;
      harness.advance(MINUTE);
      // The first browser is still in use: its refresh makes it the most recently used.
      await harness.service.refresh({ refreshToken: first.issued.refreshToken, ...origin });
      harness.advance(MINUTE);

      expect((await landing(user.email)).organizationId).toBe(refreshed.id);
    });

    it("passes over the earlier session's organization once the person has left it: the newest live membership instead", async () => {
      const { user, groups } = personWithGroups("Left", "Kept");
      const first = await landing(user.email);
      harness.sessionRows.get(first.sessionId)!.activeOrganizationId = groups[0]!.id;
      await signOut(first.sessionId, user.id);
      harness.memberships.find((membership) => membership.organizationId === groups[0]!.id)!.deletedAt = new Date();

      const { organizationId } = await landing(user.email);

      expect(organizationId).toBe(groups[1]!.id);
      // The organization was locked and found without the membership: never landed in.
      expect(harness.locks).toContain(`membership:${groups[0]!.id}`);
    });

    it("passes over a deleted organization, the earlier session's and the newest membership's alike: the next live one, else the personal organization", async () => {
      const { user, personal, groups } = personWithGroups("Other", "Deleted");
      const [other, deleted] = groups as [StoredOrganization, StoredOrganization];
      const first = await landing(user.email);
      expect(first.organizationId).toBe(deleted.id);
      await signOut(first.sessionId, user.id);
      deleted.deletedAt = new Date();

      // The earlier session's (deleted) is passed over; the newest live membership is "Other".
      expect((await landing(user.email)).organizationId).toBe(other.id);

      // With "Other" left too, nothing but the personal organization.
      const second = [...harness.sessionRows.values()].at(-1)!;
      await signOut(second.id, user.id);
      harness.memberships.find((membership) => membership.organizationId === other.id)!.deletedAt = new Date();
      expect((await landing(user.email)).organizationId).toBe(personal.id);
    });

    it("falls back to the personal organization when every candidate fails under its lock", async () => {
      const { user, personal, groups } = personWithGroups("Gone");
      // The unlocked reads still name "Gone" (a delete committing between them and the locks).
      harness.sessionRepository.findMostRecentlyUsedOrganizationId.mockResolvedValueOnce(groups[0]!.id);
      harness.organizationRepository.findNewestJoinedForUser.mockResolvedValueOnce(groups[0]!.id);
      groups[0]!.deletedAt = new Date();

      expect((await landing(user.email)).organizationId).toBe(personal.id);
    });

    it("locks each candidate organization, then its membership, in id order, all before the check locks the user; in the user's context, then each organization's", async () => {
      const { user, groups } = personWithGroups("A", "B");
      const first = await landing(user.email);
      harness.sessionRows.get(first.sessionId)!.activeOrganizationId = groups[0]!.id;
      await signOut(first.sessionId, user.id);
      harness.locks.length = 0;
      harness.contexts.length = 0;

      await landing(user.email);

      const [low, high] = [groups[0]!.id, groups[1]!.id].sort();
      expect(harness.locks).toEqual([
        `organization:${low}`,
        `membership:${low}`,
        `organization:${high}`,
        `membership:${high}`,
        `user:${user.id}`,
      ]);
      expect(harness.contexts).toEqual([
        { userId: user.id, organizationId: null },
        { userId: user.id, organizationId: null },
        { userId: user.id, organizationId: low },
        { userId: user.id, organizationId: high },
        { userId: user.id, organizationId: groups[0]!.id },
      ]);
    });

    it("leaves a session started in a named organization (an invitation's) where it was named", async () => {
      const { user, personal, groups } = personWithGroups("Newest");
      const issued = await harness.service.startSession({
        user,
        organizationId: personal.id,
        origin,
        check: async () => true,
      });
      const verified = await harness.accessTokens.verify(issued!.accessToken);
      expect(verified.status === "valid" && verified.claims.organizationId).toBe(personal.id);
      expect(harness.sessionRepository.findMostRecentlyUsedOrganizationId).not.toHaveBeenCalled();
      expect(groups).toHaveLength(1);
    });
  });

  describe("refresh", () => {
    const refresh = (refreshToken: string) => harness.service.refresh({ refreshToken, ...origin });

    /** A refresh that must rotate the pair; resolves with the new pair. */
    const rotate = async (refreshToken: string): Promise<IssuedSession> => {
      const result = await refresh(refreshToken);
      if (result.kind !== "rotated") throw new Error(`expected a rotation, got ${result.kind}`);
      return result.issued;
    };

    /** Past the grace window, so presenting a consumed token again is a reuse (D2b Preflight ruling 2). */
    const pastTheGraceWindow = () => harness.advance(REFRESH_GRACE_SECONDS * 1000 + 1);

    it("rotates: the old token is consumed and the new one works", async () => {
      const { user, organization } = harness.addUser();
      const first = await signIn(user.email);
      harness.advance(10 * MINUTE);

      const second = await rotate(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(second.refreshTokenExpiresAt).toEqual(new Date(harness.clock.current.getTime() + 30 * DAY));
      const firstRow = [...harness.refreshTokenRows.values()][0]!;
      expect(firstRow.consumedAt).toEqual(harness.clock.current);

      const verified = await harness.accessTokens.verify(second.accessToken);
      if (verified.status !== "valid") throw new Error("expected a valid token");
      expect(verified.claims.organizationId).toBe(organization.id);
      expect(harness.sessionRows.get(verified.claims.sessionId)!.lastRefreshedAt).toEqual(harness.clock.current);

      harness.advance(10 * MINUTE);
      const third = await rotate(second.refreshToken);
      expect(third.user.id).toBe(user.id);
    });

    it("reads the session in its user's database context, with no organization", async () => {
      const { user } = harness.addUser();
      const first = await signIn(user.email);
      harness.contexts.length = 0;
      await rotate(first.refreshToken);
      expect(harness.contexts).toEqual([{ userId: user.id, organizationId: null }]);
    });

    it("carries the session row's organization into the new access token, not the old token's", async () => {
      const { user } = harness.addUser();
      const first = await signIn(user.email);
      const group = harness.addOrganization(randomUUID(), "group", "Group");
      harness.memberships.push({ organizationId: group.id, userId: user.id, role: "contributor" });
      const session = [...harness.sessionRows.values()][0]!;
      session.activeOrganizationId = group.id;

      const second = await rotate(first.refreshToken);
      const verified = await harness.accessTokens.verify(second.accessToken);
      if (verified.status !== "valid") throw new Error("expected a valid token");
      expect(verified.claims.organizationId).toBe(group.id);
    });

    it("revokes the session when a consumed refresh token is reused, and its unexpired access token stops working", async () => {
      const { user, organization } = harness.addUser();
      const first = await signIn(user.email);
      const second = await rotate(first.refreshToken);
      const sessionId = [...harness.sessionRows.keys()][0]!;
      pastTheGraceWindow();

      const error = await rejection(refresh(first.refreshToken));

      expect(error.code).toBe("unauthenticated");
      expect(error.statusCode).toBe(401);
      expect(harness.sessionRows.get(sessionId)).toMatchObject({ revokedReason: "refresh_token_reused" });
      // Still within its 15 minutes, but the session is gone.
      expect((await harness.accessTokens.verify(second.accessToken)).status).toBe("valid");
      expect(await harness.service.authenticate(second.accessToken)).toEqual({ status: "unauthenticated" });
      // And the rotated token is dead too: the whole session is revoked.
      expect((await rejection(refresh(second.refreshToken))).code).toBe("unauthenticated");

      expect(harness.auditEvents.filter((event) => event.action === "session.refresh_token_reused")).toEqual([
        {
          action: "session.refresh_token_reused",
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: organization.id,
          subjectType: "session",
          subjectId: sessionId,
          metadata: { isRevoked: true },
          ...origin,
        },
      ]);
    });

    it("refuses an expired refresh token without revoking the session", async () => {
      const { user } = harness.addUser();
      const first = await signIn(user.email);
      harness.advance(30 * DAY);

      const error = await rejection(refresh(first.refreshToken));

      expect(error.code).toBe("unauthenticated");
      expect(harness.sessionRepository.revoke).not.toHaveBeenCalled();
      expect([...harness.sessionRows.values()][0]!.revokedAt).toBeNull();
      expect(harness.auditEvents.map((event) => event.action)).toEqual(["user.signed_in"]);
    });

    it("does not revoke when the token is consumed now but had expired", async () => {
      const { user } = harness.addUser();
      const first = await signIn(user.email);
      harness.advance(30 * DAY + 1);

      await rejection(refresh(first.refreshToken));

      const consumed = await harness.refreshTokenRepository.consume.mock.results[0]!.value;
      expect(consumed).toMatchObject({ status: "consumed" });
      expect(harness.sessionRepository.revoke).not.toHaveBeenCalled();
      expect(harness.refreshTokenRepository.create).toHaveBeenCalledOnce(); // sign-in's only
    });

    it("refuses a refresh for a revoked session", async () => {
      const { user } = harness.addUser();
      const first = await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;
      await harness.service.signOut({ sessionId, ...origin });

      const error = await rejection(refresh(first.refreshToken));
      expect(error.code).toBe("unauthenticated");
      expect(harness.refreshTokenRepository.create).toHaveBeenCalledOnce();
    });

    it("refuses an unknown refresh token", async () => {
      const error = await rejection(refresh("never-issued"));
      expect(describeError(error)).toEqual({
        code: "unauthenticated",
        message: "You need to sign in.",
        statusCode: 401,
        details: undefined,
      });
      expect(harness.sessionRepository.revoke).not.toHaveBeenCalled();
    });

    describe("the grace window (D2b decision 3)", () => {
      const SECOND = 1000;

      /** Signs in and rotates once, so the first refresh token is consumed at the clock's current reading. */
      const rotatedOnce = async () => {
        const account = harness.addUser();
        const first = await signIn(account.user.email);
        harness.advance(5 * MINUTE);
        const second = await rotate(first.refreshToken);
        const sessionId = [...harness.sessionRows.keys()][0]!;
        return { ...account, first, second, sessionId };
      };

      /** Everything a refresh could write, to prove a grace or a refusal wrote none of it. */
      const writes = () => ({
        refreshTokensCreated: harness.refreshTokenRepository.create.mock.calls.length,
        refreshTokenRows: harness.refreshTokenRows.size,
        touches: harness.sessionRepository.touchRefreshed.mock.calls.length,
        revocations: harness.sessionRepository.revoke.mock.calls.length,
        auditEvents: harness.auditEvents.length,
      });

      it.each([
        ["at the same instant", 0],
        ["exactly 10 seconds later", 10 * SECOND],
      ])(
        "gives a second presentation %s only an access token for the session's user and organization",
        async (_label, delay) => {
          const { user, organization, first, sessionId } = await rotatedOnce();
          harness.advance(delay);

          const result = await refresh(first.refreshToken);

          expect(result.kind).toBe("grace");
          if (result.kind !== "grace") return;
          expect(result.user).toEqual({ id: user.id, email: user.email });
          expect(result).not.toHaveProperty("refreshToken");
          expect(result.accessTokenExpiresAt).toEqual(new Date(harness.clock.current.getTime() + 15 * MINUTE));
          const verified = await harness.accessTokens.verify(result.accessToken);
          if (verified.status !== "valid") throw new Error("expected a valid token");
          expect(verified.claims).toMatchObject({ userId: user.id, sessionId, organizationId: organization.id });
          expect(await harness.service.authenticate(result.accessToken)).toMatchObject({
            status: "authenticated",
            sessionId,
          });
          expect(harness.sessionRows.get(sessionId)!.revokedAt).toBeNull();
        },
      );

      it("counts a presentation whose clock reading precedes the consumption as within the window (Preflight ruling 1)", async () => {
        // A presentation that waited on the winner's row lock read its clock
        // before the winner wrote consumed_at.
        const { first } = await rotatedOnce();
        harness.advance(-2 * SECOND);

        expect((await refresh(first.refreshToken)).kind).toBe("grace");
      });

      it("carries the session row's current organization, not the consumed token's", async () => {
        const { user, first, sessionId } = await rotatedOnce();
        const group = harness.addOrganization(randomUUID(), "group", "Group");
        harness.memberships.push({ organizationId: group.id, userId: user.id, role: "contributor" });
        harness.sessionRows.get(sessionId)!.activeOrganizationId = group.id;

        const result = await refresh(first.refreshToken);

        if (result.kind !== "grace") throw new Error("expected a grace");
        const verified = await harness.accessTokens.verify(result.accessToken);
        if (verified.status !== "valid") throw new Error("expected a valid token");
        expect(verified.claims.organizationId).toBe(group.id);
      });

      it("writes nothing: no refresh token, no touch, no revocation, no audit row", async () => {
        const { first, sessionId } = await rotatedOnce();
        const before = writes();
        const lastRefreshedAt = harness.sessionRows.get(sessionId)!.lastRefreshedAt;
        harness.advance(3 * SECOND);

        expect((await refresh(first.refreshToken)).kind).toBe("grace");

        expect(writes()).toEqual(before);
        expect(harness.sessionRows.get(sessionId)).toMatchObject({ lastRefreshedAt, revokedAt: null });
      });

      it("is a reuse at 10.001 seconds: the session is revoked and audited", async () => {
        const { user, organization, first, second, sessionId } = await rotatedOnce();
        harness.advance(10 * SECOND + 1);

        const error = await rejection(refresh(first.refreshToken));

        expect(describeError(error)).toMatchObject({ code: "unauthenticated", statusCode: 401 });
        expect(harness.sessionRows.get(sessionId)).toMatchObject({ revokedReason: "refresh_token_reused" });
        expect(await harness.service.authenticate(second.accessToken)).toEqual({ status: "unauthenticated" });
        expect(harness.auditEvents.at(-1)).toEqual({
          action: "session.refresh_token_reused",
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: organization.id,
          subjectType: "session",
          subjectId: sessionId,
          metadata: { isRevoked: true },
          ...origin,
        });
      });

      it("refuses a presentation within the window on a revoked session, writing nothing", async () => {
        const { first, sessionId } = await rotatedOnce();
        const session = harness.sessionRows.get(sessionId)!;
        session.revokedAt = harness.clock.current;
        session.revokedReason = "logout";
        const before = writes();
        harness.advance(1 * SECOND);

        const error = await rejection(refresh(first.refreshToken));

        expect(describeError(error)).toEqual({
          code: "unauthenticated",
          message: "You need to sign in.",
          statusCode: 401,
          details: undefined,
        });
        expect(writes()).toEqual(before);
        expect(session.revokedReason).toBe("logout");
      });

      it("refuses, without revoking, an expired token presented again within the window", async () => {
        // The first presentation consumes the expired token and is refused;
        // the second must not turn that consumption into an access token.
        const { user } = harness.addUser();
        const first = await signIn(user.email);
        const sessionId = [...harness.sessionRows.keys()][0]!;
        harness.advance(30 * DAY + 1);
        await rejection(refresh(first.refreshToken));
        const before = writes();
        harness.advance(1 * SECOND);

        const error = await rejection(refresh(first.refreshToken));

        expect(error.code).toBe("unauthenticated");
        expect(writes()).toEqual(before);
        expect(harness.sessionRows.get(sessionId)!.revokedAt).toBeNull();
      });
    });
  });

  describe("authenticate", () => {
    it("reports a valid token for a live session as authenticated", async () => {
      const { user, organization } = harness.addUser();
      const issued = await signIn(user.email);
      const result = await harness.service.authenticate(issued.accessToken);
      expect(result).toMatchObject({
        status: "authenticated",
        userId: user.id,
        email: user.email,
        organization: { id: organization.id, name: organization.name, type: "personal", logoId: null, role: "admin" },
      });
    });

    it("answers whether the user's Terms are satisfied as the session check read them: the site's version accepted, not an older one or none (D7 decision 10)", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({
        status: "authenticated",
        hasAcceptedCurrentTerms: true,
      });

      for (const accepted of [null, "2025-01-01"]) {
        user.acceptedTermsVersion = accepted;
        expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({
          status: "authenticated",
          hasAcceptedCurrentTerms: false,
        });
      }
    });

    it("follows the site's Terms version, read on each request (TELFLO_TERMS_VERSION, D36-1 decision 29)", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      harness.settings.site.terms.version = "2099-01-01";
      expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({ hasAcceptedCurrentTerms: false });
      user.acceptedTermsVersion = "2099-01-01";
      expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({ hasAcceptedCurrentTerms: true });
    });

    it("answers Terms satisfied for every user while the site asks for none (D36-1 Preflight ruling 1)", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      harness.settings.site.terms.version = "";
      for (const accepted of [null, "2025-01-01", TEST_TERMS_VERSION]) {
        user.acceptedTermsVersion = accepted;
        expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({ hasAcceptedCurrentTerms: true });
      }
    });

    it("carries the product-admin flag as the session check read it on each request, not as the token was issued (D12 decision 3)", async () => {
      const { user } = harness.addUser();
      user.isProductAdmin = true;
      const issued = await signIn(user.email);
      expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({
        status: "authenticated",
        isProductAdmin: true,
      });

      // Cleared by an operator mid-session: the same token, no refresh.
      user.isProductAdmin = false;
      expect(await harness.service.authenticate(issued.accessToken)).toMatchObject({
        status: "authenticated",
        isProductAdmin: false,
      });
    });

    it("reports an expired token as expired, with its session", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;
      harness.advance(15 * MINUTE);
      expect(await harness.service.authenticate(issued.accessToken)).toEqual({ status: "expired", sessionId });
    });

    it("reports a valid token for a revoked session as unauthenticated", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;
      await harness.service.signOut({ sessionId, ...origin });
      expect(await harness.service.authenticate(issued.accessToken)).toEqual({ status: "unauthenticated" });
    });

    it("reports garbage as unauthenticated", async () => {
      expect(await harness.service.authenticate("not-a-jwt")).toEqual({ status: "unauthenticated" });
    });

    it("reports a missing token as unauthenticated", async () => {
      expect(await harness.service.authenticate(undefined)).toEqual({ status: "unauthenticated" });
      expect(await harness.service.authenticate("")).toEqual({ status: "unauthenticated" });
    });

    it("reports a token whose organization the session has since left as expired, so the client refreshes (D5 decision 10)", async () => {
      const { user } = harness.addUser();
      const issued = await signIn(user.email);
      const group = harness.addOrganization(randomUUID(), "group", "Group");
      harness.memberships.push({ organizationId: group.id, userId: user.id, role: "contributor" });
      const session = [...harness.sessionRows.values()][0]!;
      session.activeOrganizationId = group.id;

      expect(await harness.service.authenticate(issued.accessToken)).toEqual({ status: "expired", sessionId: session.id });
    });

    it("reads the session in the database context the token claims", async () => {
      const { user, organization } = harness.addUser();
      const issued = await signIn(user.email);
      harness.contexts.length = 0;
      await harness.service.authenticate(issued.accessToken);
      expect(harness.contexts).toEqual([{ userId: user.id, organizationId: organization.id }]);
    });

    it("refuses a token whose user differs from the session's user", async () => {
      const { user } = harness.addUser();
      await signIn(user.email);
      const session = [...harness.sessionRows.values()][0]!;
      const forged = await harness.accessTokens.issue({
        userId: randomUUID(),
        sessionId: session.id,
        organizationId: session.activeOrganizationId,
      });
      expect(await harness.service.authenticate(forged.token)).toEqual({ status: "unauthenticated" });
    });
  });

  describe("signOut", () => {
    it("is safe to call twice and audits once, with the token's user, the user's email and the organization", async () => {
      const { user, organization } = harness.addUser();
      await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;
      const input = { sessionId, userId: user.id, organizationId: organization.id, ...origin };

      await harness.service.signOut(input);
      await harness.service.signOut(input);

      expect(harness.sessionRows.get(sessionId)).toMatchObject({ revokedReason: "logout" });
      expect(harness.auditEvents.filter((event) => event.action === "user.signed_out")).toEqual([
        {
          action: "user.signed_out",
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: organization.id,
          subjectType: "session",
          subjectId: sessionId,
          ...origin,
        },
      ]);
    });

    it("looks the email up by the token's user id", async () => {
      const { user, organization } = harness.addUser();
      await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;

      await harness.service.signOut({ sessionId, userId: user.id, organizationId: organization.id, ...origin });

      expect(harness.userRepository.findById).toHaveBeenCalledTimes(1);
      expect(harness.userRepository.findById).toHaveBeenCalledWith(user.id);
    });

    it("revokes without an email when no user id is known", async () => {
      const { user } = harness.addUser();
      await signIn(user.email);
      const sessionId = [...harness.sessionRows.keys()][0]!;

      await harness.service.signOut({ sessionId, ...origin });

      expect(harness.userRepository.findById).not.toHaveBeenCalled();
      const event = harness.auditEvents.find((candidate) => candidate.action === "user.signed_out");
      expect(event).toMatchObject({ subjectId: sessionId });
      expect(event?.actorEmail).toBeUndefined();
    });

    it("does nothing without a session id", async () => {
      await harness.service.signOut({ ...origin });
      expect(harness.sessionRepository.revoke).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });
  });

  describe("signOutEverywhere", () => {
    it("revokes all of the user's sessions and no one else's, auditing the count", async () => {
      const { user, organization } = harness.addUser();
      const other = harness.addUser();
      const mine = [await signIn(user.email), await signIn(user.email)];
      const theirs = await signIn(other.user.email);

      const result = await harness.service.signOutEverywhere({
        userId: user.id,
        email: user.email,
        organizationId: organization.id,
        ...origin,
      });

      expect(result).toEqual({ count: 2 });
      for (const issued of mine) {
        expect(await harness.service.authenticate(issued.accessToken)).toEqual({ status: "unauthenticated" });
      }
      expect((await harness.service.authenticate(theirs.accessToken)).status).toBe("authenticated");
      expect(harness.auditEvents.at(-1)).toEqual({
        action: "user.signed_out_everywhere",
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: organization.id,
        subjectType: "user",
        subjectId: user.id,
        metadata: { count: 2 },
        ...origin,
      });
    });
  });

  describe("switchOrganization", () => {
    /** A signed-in user with a group organization they are a `role` of, and their request's context. */
    async function signedInWithGroup(role: OrganizationRole = "contributor") {
      const { user, organization } = harness.addUser();
      // Signed in before joining the group: the session starts in the personal organization (Q265).
      const issued = await signIn(user.email);
      const group = harness.addOrganization(randomUUID(), "group", "Acme");
      harness.memberships.push({ organizationId: group.id, userId: user.id, role });
      const authenticated = await harness.service.authenticate(issued.accessToken);
      if (authenticated.status !== "authenticated") throw new Error("not signed in");
      const context = {
        userId: user.id,
        organizationId: organization.id,
        role: authenticated.organization.role,
        sessionId: authenticated.sessionId,
      };
      return { user, personal: organization, group, context };
    }

    const switchTo = (
      input: Awaited<ReturnType<typeof signedInWithGroup>>,
      organizationId: string,
    ) => harness.service.switchOrganization({ context: input.context, email: input.user.email, organizationId, ...origin });

    it("moves the session, audits the switch and issues a token for the new organization", async () => {
      const signedIn = await signedInWithGroup("contributor");
      const { group, personal, context } = signedIn;

      const result = await switchTo(signedIn, group.id);

      expect(result.organization).toEqual({ id: group.id, name: "Acme", type: "group", logoId: null, role: "contributor" });
      expect(harness.sessionRows.get(context.sessionId)!.activeOrganizationId).toBe(group.id);
      const verified = await harness.accessTokens.verify(result.access!.token);
      expect(verified).toMatchObject({
        status: "valid",
        claims: { userId: context.userId, sessionId: context.sessionId, organizationId: group.id },
      });
      expect(harness.auditEvents.at(-1)).toEqual({
        action: "session.organization_switched",
        actorUserId: context.userId,
        actorEmail: signedIn.user.email,
        organizationId: group.id,
        subjectType: "session",
        subjectId: context.sessionId,
        metadata: { fromOrganizationId: personal.id },
        ...origin,
      });
    });

    it("sets the target organization as the database context before its locking reads (Preflight ruling 1)", async () => {
      const signedIn = await signedInWithGroup();
      await switchTo(signedIn, signedIn.group.id);
      expect(harness.contexts.at(-1)).toEqual({ userId: signedIn.user.id, organizationId: signedIn.group.id });
    });

    it("changes, audits and issues nothing when switching to the organization already active", async () => {
      const signedIn = await signedInWithGroup();
      const auditCount = harness.auditEvents.length;

      const result = await switchTo(signedIn, signedIn.personal.id);

      expect(result).toEqual({
        organization: { id: signedIn.personal.id, name: signedIn.personal.name, type: "personal", logoId: null, role: "admin" },
      });
      expect(harness.sessionRepository.setActiveOrganization).not.toHaveBeenCalled();
      expect(harness.auditEvents).toHaveLength(auditCount);
    });

    it("answers the active organization's id in capitals as the no-op (Ruling 85)", async () => {
      const signedIn = await signedInWithGroup();
      const auditCount = harness.auditEvents.length;

      const result = await switchTo(signedIn, signedIn.personal.id.toUpperCase());

      expect(result).toEqual({
        organization: { id: signedIn.personal.id, name: signedIn.personal.name, type: "personal", logoId: null, role: "admin" },
      });
      expect(harness.sessionRepository.setActiveOrganization).not.toHaveBeenCalled();
      expect(harness.auditEvents).toHaveLength(auditCount);
    });

    it("refuses an id that isn't a uuid with the same 403, before any read", async () => {
      const signedIn = await signedInWithGroup();
      const contextCount = harness.contexts.length;

      await expect(switchTo(signedIn, `{${signedIn.group.id}}`)).rejects.toMatchObject({
        code: "organization_access_denied",
        statusCode: 403,
      });
      expect(harness.contexts).toHaveLength(contextCount);
    });

    it.each([
      ["deleted", (organization: { deletedAt: Date | null }) => (organization.deletedAt = new Date())],
      [
        "left",
        (_organization: unknown, membership: { deletedAt?: Date | null }) => (membership.deletedAt = new Date()),
      ],
    ] as const)(
      "answers a switch to the active organization, %s since the request was authenticated, with 403",
      async (_label, goAway) => {
        const signedIn = await signedInWithGroup();
        const personal = harness.organizations.get(signedIn.personal.id)!;
        const membership = harness.memberships.find((candidate) => candidate.organizationId === personal.id)!;
        goAway(personal, membership);

        await expect(switchTo(signedIn, personal.id)).rejects.toMatchObject({ code: "organization_access_denied" });
        expect(harness.sessionRepository.setActiveOrganization).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["an unknown organization", () => ({ id: randomUUID() })],
      ["an organization the user isn't a member of", () => harness.addOrganization(randomUUID(), "group", "Other")],
      [
        "a deleted organization the user was a member of",
        (userId: string) => {
          const deleted = harness.addOrganization(randomUUID(), "group", "Deleted");
          harness.memberships.push({ organizationId: deleted.id, userId, role: "admin" });
          deleted.deletedAt = new Date();
          return deleted;
        },
      ],
    ])("refuses %s with 403 organization_access_denied and changes nothing", async (_label, target) => {
      const signedIn = await signedInWithGroup();
      const { id } = target(signedIn.user.id);
      const auditCount = harness.auditEvents.length;

      const error = await switchTo(signedIn, id).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "organization_access_denied",
        statusCode: 403,
        message: "You are not an active member of this organization",
      });
      expect(harness.sessionRows.get(signedIn.context.sessionId)!.activeOrganizationId).toBe(signedIn.personal.id);
      expect(harness.auditEvents).toHaveLength(auditCount);
    });

    it("refuses an organization whose membership was removed", async () => {
      const signedIn = await signedInWithGroup();
      harness.memberships.find((membership) => membership.organizationId === signedIn.group.id)!.deletedAt =
        new Date();
      await expect(switchTo(signedIn, signedIn.group.id)).rejects.toMatchObject({ code: "organization_access_denied" });
      expect(harness.sessionRows.get(signedIn.context.sessionId)!.activeOrganizationId).toBe(signedIn.personal.id);
    });

    it("answers as a no-op when the session moved into the target between its unlocked read and its lock", async () => {
      // Another switch of the same session committed in between (Ruling 22).
      const signedIn = await signedInWithGroup("contributor");
      const stale = { ...harness.sessionRows.get(signedIn.context.sessionId)! };
      harness.sessionRows.get(signedIn.context.sessionId)!.activeOrganizationId = signedIn.group.id;
      harness.sessionRepository.findLive.mockResolvedValueOnce(stale);
      const auditCount = harness.auditEvents.length;

      const result = await switchTo(signedIn, signedIn.group.id);

      expect(result.organization).toEqual({ id: signedIn.group.id, name: "Acme", type: "group", logoId: null, role: "contributor" });
      expect(await harness.accessTokens.verify(result.access!.token)).toMatchObject({
        claims: { organizationId: signedIn.group.id },
      });
      expect(harness.sessionRepository.setActiveOrganization).not.toHaveBeenCalled();
      expect(harness.auditEvents).toHaveLength(auditCount);
    });

    it("refuses a session revoked since the request was authenticated with 401 unauthenticated", async () => {
      const signedIn = await signedInWithGroup();
      await harness.sessionRepository.revoke(signedIn.context.sessionId, "logout");
      await expect(switchTo(signedIn, signedIn.group.id)).rejects.toMatchObject({
        code: "unauthenticated",
        statusCode: 401,
      });
      expect(harness.sessionRepository.setActiveOrganization).not.toHaveBeenCalled();
    });
  });
});
