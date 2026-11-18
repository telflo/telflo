import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityService, type IdentityDependencies } from "./service.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import * as passwordModule from "./password.js";
import { hashToken } from "./tokens.js";
import type { AuditEvent, IAuditRepository } from "./repositories/audit-repository.js";
import type { OrganizationMembership } from "../organizations/repositories/member-repository.js";
import type { Organization } from "../organizations/repositories/organization-repository.js";
import {
  DuplicateEmailError,
  type AccountCreatedCallback,
  type CreateUserInput,
  type IUserRepository,
  type User,
} from "./repositories/user-repository.js";
import type { IUserIdentityRepository } from "./repositories/user-identity-repository.js";
import type {
  CreateVerificationTokenInput,
  IVerificationTokenRepository,
  VerificationToken,
} from "./repositories/verification-token-repository.js";
import { OPEN_SOURCE_SITE } from "@telflo/contracts";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

/** Hand-built fakes: the service's logic is what is under test, not Postgres. */
function buildDependencies() {
  const usersByEmail = new Map<string, User>();
  const tokensByHash = new Map<string, VerificationToken & { tokenHash: string }>();
  const organizations: Organization[] = [];
  const memberships: OrganizationMembership[] = [];
  const auditEvents: AuditEvent[] = [];
  const mailer = createInMemoryMailer();
  let nextId = 1;
  const faults = { failMembershipInsert: false, accountDelayMilliseconds: 0, loseInsertRace: false };

  const users = {
    findByEmail: vi.fn(async (email: string) => usersByEmail.get(email.toLowerCase())),
    /**
     * Mirrors the real transaction: all three rows are built first, the
     * callback runs, and the rows are published only once every step has
     * succeeded, so a failure at any step leaves no account behind.
     *
     * `loseInsertRace` imitates a concurrent registration winning the
     * insert: the winner's row appears, and this call throws
     * DuplicateEmailError, as the real repository does.
     */
    createAccount: vi.fn(
      async (input: CreateUserInput, onCreated?: AccountCreatedCallback) => {
        if (faults.loseInsertRace) {
          const winner: User = {
            id: `user-${nextId++}`,
            email: input.email.toLowerCase(),
            passwordHash: "$argon2id$winner",
            emailVerifiedAt: null,
            acceptedTermsVersion: input.terms?.version ?? null,
            createdAt: new Date(),
          };
          usersByEmail.set(winner.email, winner);
          throw new DuplicateEmailError();
        }
        if (faults.accountDelayMilliseconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, faults.accountDelayMilliseconds));
        }
        const user: User = {
          id: `user-${nextId++}`,
          email: input.email.toLowerCase(),
          passwordHash: input.passwordHash,
          emailVerifiedAt: input.emailVerifiedAt,
          acceptedTermsVersion: input.terms?.version ?? null,
          createdAt: new Date(),
        };
        const organization: Organization = {
          id: `organization-${nextId++}`,
          name: user.email,
          type: "personal",
          ownerUserId: user.id,
          createdAt: new Date(),
          logoId: null,
          logoContentType: null,
        };
        if (faults.failMembershipInsert) throw new Error("membership insert failed");
        const membership: OrganizationMembership = {
          id: `membership-${nextId++}`,
          organizationId: organization.id,
          userId: user.id,
          role: "admin",
          createdAt: new Date(),
        };
        const account = { user, organization, membership };
        await onCreated?.(account, {
          audit,
          verificationTokens,
          identities,
          enterOrganization: async () => {
            throw new Error("not used by the identity service");
          },
        });
        usersByEmail.set(user.email, user);
        organizations.push(organization);
        memberships.push(membership);
        return account;
      },
    ),
    findById: vi.fn(async (id: string) => {
      return [...usersByEmail.values()].find((user) => user.id === id);
    }),
    markEmailVerified: vi.fn(async (userId: string) => {
      for (const user of usersByEmail.values()) {
        if (user.id === userId) user.emailVerifiedAt = new Date();
      }
    }),
    setPasswordAndConfirmEmail: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    findPasswordHashForShare: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    findByEmailIncludingDeleted: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    createFederatedAccount: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    setPasswordHash: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    takeOverUnverified: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    acceptTerms: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    lockForUpdate: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
  } satisfies IUserRepository;

  const verificationTokens = {
    create: vi.fn(async (input: CreateVerificationTokenInput) => {
      tokensByHash.set(input.tokenHash, {
        id: `token-${nextId++}`,
        userId: input.userId,
        expiresAt: input.expiresAt,
        consumedAt: null,
        tokenHash: input.tokenHash,
      });
    }),
    findByHash: vi.fn(async (tokenHash: string) => {
      return tokensByHash.get(tokenHash);
    }),
    consume: vi.fn(async (id: string) => {
      for (const token of tokensByHash.values()) {
        if (token.id === id && !token.consumedAt) {
          token.consumedAt = new Date();
          return true;
        }
      }
      return false;
    }),
    consumeAllForUser: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
  } satisfies IVerificationTokenRepository;

  const audit = {
    record: vi.fn(async (event: AuditEvent) => {
      auditEvents.push(event);
    }),
  } satisfies IAuditRepository;

  const identities = {
    findUserBySubject: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    link: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    listForUser: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    findForUser: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
    unlink: vi.fn(async () => {
      throw new Error("not used by the identity service");
    }),
  } satisfies IUserIdentityRepository;

  const deps: IdentityDependencies = {
    users,
    verificationTokens,
    audit,
    mailer,
    settings: {
      databaseUrl: "unused",
      apiPort: 8080,
      publicWebUrl: "https://app.telflo.local",
      webOrigin: "https://app.telflo.local",
      mail: {
        from: "no-reply@telflo.local",
        transport: { kind: "smtp", host: "localhost", port: 1025, allowInsecureTransport: false, tls: "none", login: null, ca: null },
      },
      verificationTokenTtlHours: 24,
      accessTokenSecret: "unused-development-only-secret-of-32-bytes",
      accessTokenTtlMinutes: 15,
      refreshTokenTtlDays: 30,
      isCookieSecure: true,
      trustProxyHops: 0,
      oidcProviders: [],
      // The site asks for the tests' Terms version (vitest.setup.ts's SaaS pin).
      site: { ...OPEN_SOURCE_SITE, terms: { ...OPEN_SOURCE_SITE.terms, version: TEST_TERMS_VERSION } },
      salesInquiryTo: "",
      opampServer: { url: "http://opamp-server.invalid", secret: "unused-opamp-management-secret-of-32-bytes" },
      otelcolValidator: { url: "http://otelcol-validator.invalid", secret: "unused-otelcol-validator-secret-of-32-bytes" },
      fileStore: { kind: "local", root: "/nonexistent/telflo-identity-test/file-store" },
      otelcolTesting: { url: "http://otelcol-testing.invalid", secret: "unused-otelcol-testing-secret-of-32-bytes" },
      testRuns: { runsPerTester: 4, downFailAfterSeconds: 600 },
      ottlEvaluator: { url: "http://ottl-evaluator.invalid", secret: "unused-ottl-evaluator-secret-of-32-bytes" },
      install: {
        agentPublicUrl: "https://opamp-agent.invalid/v1/opamp",
        collectorImageRepository: "ghcr.io/telflo/telflo/collector",
        allowInsecureConnections: false,
        helmChartReference: "oci://ghcr.io/telflo/telflo/charts/supervisor-collector",
        helmChartVersion: "0.1.0",
        templatesDirectory: "/nonexistent/telflo-identity-test/install-templates",
      },
      quickDeploy: {
        publicApiUrl: "https://api.telflo.local",
        keyRing: { current: { id: "0000000000000000", key: Buffer.alloc(32) }, previous: [] },
      },
      library: { signingKeys: { current: Buffer.alloc(32), previous: [] } },
    },
    now: () => new Date(),
    opampRegistration: { created: vi.fn(), renamed: vi.fn(), deleted: vi.fn() },
  };

  return {
    deps,
    mailer,
    users,
    verificationTokens,
    audit,
    auditEvents,
    usersByEmail,
    tokensByHash,
    organizations,
    memberships,
    faults,
  };
}

const registration = {
  email: "person@example.com",
  password: "a-sufficiently-long-password",
  acceptedTermsVersion: TEST_TERMS_VERSION,
};

describe("registerUser", () => {
  let harness: ReturnType<typeof buildDependencies>;

  beforeEach(() => {
    harness = buildDependencies();
  });

  it("creates a user and returns verification_sent", async () => {
    const service = createIdentityService(harness.deps);
    const result = await service.registerUser(registration);
    expect(result).toEqual({ status: "verification_sent" });
    expect(harness.users.createAccount).toHaveBeenCalledOnce();
  });

  it("records the terms version from the checkbox, accepted at the service's clock, and leaves the email unverified", async () => {
    const at = new Date("2026-09-26T08:00:00.000Z");
    // A new Date on every reading, so the identity check below shows the
    // terms and the account's creation share one reading.
    const service = createIdentityService({ ...harness.deps, now: () => new Date(at) });
    await service.registerUser({ ...registration, ipAddress: "203.0.113.7", userAgent: "service-test-agent" });
    expect(harness.users.createAccount).toHaveBeenCalledWith(
      {
        email: "person@example.com",
        passwordHash: expect.stringMatching(/^\$argon2id\$/),
        terms: { version: TEST_TERMS_VERSION, acceptedAt: at },
        emailVerifiedAt: null,
        createdAt: at,
        origin: { ipAddress: "203.0.113.7", userAgent: "service-test-agent" },
      },
      expect.any(Function),
    );
    const [input] = harness.users.createAccount.mock.calls[0]!;
    expect(input.createdAt).toBe(input.terms!.acceptedAt);
  });

  it.each(["2025-01-01", `${TEST_TERMS_VERSION} `, "9999-12-31"])(
    "refuses the terms version %j, which isn't the current one, before looking the email up (Ruling 18)",
    async (version) => {
      const service = createIdentityService(harness.deps);
      await expect(service.registerUser({ ...registration, acceptedTermsVersion: version })).rejects.toMatchObject({
        code: "terms_version_not_current",
        statusCode: 400,
      });
      expect(harness.users.findByEmail).not.toHaveBeenCalled();
      expect(harness.users.createAccount).not.toHaveBeenCalled();
      expect(harness.mailer.sent).toHaveLength(0);
    },
  );

  it("never stores the plaintext password", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);
    const stored = harness.usersByEmail.get("person@example.com");
    expect(stored?.passwordHash).not.toBe(registration.password);
    expect(stored?.passwordHash?.startsWith("$argon2id$")).toBe(true);
  });

  it("sends a verification email containing a link to the web app", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);
    expect(harness.mailer.sent).toHaveLength(1);
    expect(harness.mailer.sent[0]?.to).toBe("person@example.com");
    expect(harness.mailer.sent[0]?.text).toContain("https://app.telflo.local/verify-email?token=");
  });

  it("stores the token hashed, never in plaintext", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);

    const sentUrl = harness.mailer.sent[0]!.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(sentUrl).toBeDefined();

    const stored = harness.verificationTokens.create.mock.calls[0]?.[0];
    expect(stored?.tokenHash).toBe(hashToken(sentUrl!));
    expect(stored?.tokenHash).not.toBe(sentUrl);
  });

  it("sets the token to expire after the configured lifetime", async () => {
    const service = createIdentityService(harness.deps);
    const before = Date.now();
    await service.registerUser(registration);

    const stored = harness.verificationTokens.create.mock.calls[0]?.[0];
    const expected = before + 24 * 60 * 60 * 1000;
    expect(stored!.expiresAt.getTime()).toBeGreaterThanOrEqual(expected - 5_000);
    expect(stored!.expiresAt.getTime()).toBeLessThanOrEqual(expected + 5_000);
  });

  it("records an audit event", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);
    expect(harness.auditEvents.map((e) => e.action)).toContain("user.registered");
  });

  it("creates one personal organization with the expected name and one admin membership for the new user", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser({ ...registration, email: "Person@Example.com" });

    const user = harness.usersByEmail.get("person@example.com")!;
    expect(harness.organizations).toEqual([
      expect.objectContaining({
        name: "person@example.com",
        type: "personal",
        ownerUserId: user.id,
      }),
    ]);
    expect(harness.memberships).toEqual([
      expect.objectContaining({
        organizationId: harness.organizations[0]!.id,
        userId: user.id,
        role: "admin",
      }),
    ]);
  });

  it("records user.registered, organization.created and organization_member.added in that order, each with the organization", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser({ ...registration, ipAddress: "203.0.113.7", userAgent: "test-agent" });

    const user = harness.usersByEmail.get("person@example.com")!;
    const organization = harness.organizations[0]!;
    const membership = harness.memberships[0]!;
    const common = {
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: organization.id,
      ipAddress: "203.0.113.7",
      userAgent: "test-agent",
    };
    expect(harness.auditEvents).toEqual([
      {
        ...common,
        action: "user.registered",
        subjectType: "user",
        subjectId: user.id,
        metadata: { acceptedTermsVersion: TEST_TERMS_VERSION },
      },
      {
        ...common,
        action: "organization.created",
        subjectType: "organization",
        subjectId: organization.id,
        metadata: { type: "personal" },
      },
      {
        ...common,
        action: "organization_member.added",
        subjectType: "organization_member",
        subjectId: membership.id,
        metadata: { role: "admin" },
      },
    ]);
  });

  /**
   * The service's half of atomicity: createAccount is one unit, so when its
   * membership insert fails, nothing of the account persists and the
   * service does none of its follow-on work. The database's half, that the
   * real transaction rolls back, is in repositories/repositories.integration.test.ts.
   */
  it("the three inserts are atomic: a failing membership insert leaves no user, no organization and no follow-on work", async () => {
    harness.faults.failMembershipInsert = true;
    const service = createIdentityService(harness.deps);

    await expect(service.registerUser(registration)).rejects.toThrow("membership insert failed");

    expect(harness.usersByEmail.size).toBe(0);
    expect(harness.organizations).toHaveLength(0);
    expect(harness.memberships).toHaveLength(0);
    expect(harness.auditEvents).toHaveLength(0);
    expect(harness.verificationTokens.create).not.toHaveBeenCalled();
    expect(harness.mailer.sent).toHaveLength(0);
  });

  describe("when the email is already registered", () => {
    it("returns the identical response, revealing nothing", async () => {
      const service = createIdentityService(harness.deps);
      const first = await service.registerUser(registration);
      const second = await service.registerUser(registration);
      expect(second).toEqual(first);
    });

    it("does not create a second user", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      harness.users.createAccount.mockClear();
      await service.registerUser(registration);
      expect(harness.users.createAccount).not.toHaveBeenCalled();
    });

    it("does not issue a verification token", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      harness.verificationTokens.create.mockClear();
      await service.registerUser(registration);
      expect(harness.verificationTokens.create).not.toHaveBeenCalled();
    });

    it("emails the existing owner a notice containing no token", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      await service.registerUser(registration);

      const notice = harness.mailer.sent[1];
      expect(notice?.to).toBe("person@example.com");
      expect(notice?.subject).toContain("Someone tried");
      expect(notice?.text).not.toContain("token=");
    });

    it("tells an account with no password (created with Google) to sign in with Google or set a password (D2c Ruling 19)", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      const existing = harness.usersByEmail.get("person@example.com");
      if (!existing) throw new Error("the first registration stored no user");
      harness.usersByEmail.set("person@example.com", { ...existing, passwordHash: null });

      await service.registerUser(registration);

      const notice = harness.mailer.sent[1];
      expect(notice?.to).toBe("person@example.com");
      expect(notice?.text).toContain("The existing account was created with Google");
      expect(notice?.text).toContain("/forgot-password");
    });

    it("does not overwrite the existing password", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      const originalHash = harness.usersByEmail.get("person@example.com")?.passwordHash;

      await service.registerUser({ ...registration, password: "an-entirely-different-one" });
      expect(harness.usersByEmail.get("person@example.com")?.passwordHash).toBe(originalHash);
    });

    it("creates no organization", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      await service.registerUser(registration);
      expect(harness.organizations).toHaveLength(1);
      expect(harness.memberships).toHaveLength(1);
    });

    /**
     * Regression test for the write-free wait described in registerUser's
     * docstring (Ruling 30 as revisited for D1b): the duplicate path must
     * take at least as long as recent new-account registrations did after
     * the hash. The fake account creation is slowed to far above the
     * fallback, so only a wait sampled from real observations can pass.
     * Only a lower bound is asserted; timers never fire early, so this is
     * not flaky under load.
     */
    it("waits out the new-account path's post-hash cost, as sampled from recent registrations", async () => {
      harness.faults.accountDelayMilliseconds = 80;
      const service = createIdentityService(harness.deps);
      await service.registerUser({ ...registration, email: "first@example.com" });
      await service.registerUser(registration);
      harness.users.createAccount.mockClear();

      const started = performance.now();
      await service.registerUser(registration);
      const elapsed = performance.now() - started;

      expect(harness.users.createAccount).not.toHaveBeenCalled();
      expect(elapsed).toBeGreaterThanOrEqual(75);
    });

    /**
     * The same regression test for the concurrent-insert loser: it pays only
     * a failed first insert and a refetch, so without its own wait it would
     * return measurably faster than a real registration.
     */
    it("pads the concurrent-insert loser to the sampled post-hash cost too", async () => {
      harness.faults.accountDelayMilliseconds = 80;
      const service = createIdentityService(harness.deps);
      await service.registerUser({ ...registration, email: "first@example.com" });
      await service.registerUser({ ...registration, email: "second@example.com" });

      harness.faults.loseInsertRace = true;
      harness.mailer.sent.length = 0;
      const started = performance.now();
      const result = await service.registerUser(registration);
      const elapsed = performance.now() - started;

      expect(result).toEqual({ status: "verification_sent" });
      expect(harness.mailer.sent).toHaveLength(1);
      expect(harness.mailer.sent[0]?.subject).toContain("Someone tried");
      expect(elapsed).toBeGreaterThanOrEqual(75);
    });

    it("records a distinct audit action, so the attempt is visible", async () => {
      const service = createIdentityService(harness.deps);
      await service.registerUser(registration);
      await service.registerUser(registration);
      expect(harness.auditEvents.map((e) => e.action)).toContain(
        "user.registration_attempted_existing_email",
      );
    });

    /**
     * Regression test for the enumeration-timing equalisation described in
     * service.ts's own comment above the discarded hashPassword() call: a
     * comment is not a regression detector, and the discarded call is
     * exactly the line a future refactor would delete as dead code. A
     * wall-clock assertion would be flaky (Argon2id's cost varies with
     * machine load); the call count is what's actually guaranteed, so
     * that's what's asserted — hashPassword must run exactly once on the
     * new-account path and exactly once on the duplicate-email path, never
     * zero (which would reopen the timing side-channel) and never more
     * than once (which would just be wasted work, but would signal the
     * implementation drifted from what the comment claims).
     */
    it("pays the same hashPassword cost (called exactly once) on both the new-account and duplicate-email paths", async () => {
      const spy = vi.spyOn(passwordModule, "hashPassword");
      const service = createIdentityService(harness.deps);

      await service.registerUser(registration);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();

      await service.registerUser(registration);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });

  it("treats an email differing only in case as the same account", async () => {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);
    harness.users.createAccount.mockClear();
    await service.registerUser({ ...registration, email: "PERSON@EXAMPLE.COM" });
    expect(harness.users.createAccount).not.toHaveBeenCalled();
  });
});

describe("verifyEmail", () => {
  let harness: ReturnType<typeof buildDependencies>;

  beforeEach(() => {
    harness = buildDependencies();
  });

  /** Registers, then returns the plaintext token mailed for that registration. */
  async function registerAndGetToken(): Promise<string> {
    const service = createIdentityService(harness.deps);
    await service.registerUser(registration);
    const text = harness.mailer.sent[0]!.text;
    return text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  }

  it("verifies a valid, unconsumed, unexpired token", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    const result = await service.verifyEmail({ token });
    expect(result).toEqual({ status: "verified" });
  });

  it("marks the user's email verified", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    await service.verifyEmail({ token });
    expect(harness.users.markEmailVerified).toHaveBeenCalledOnce();
  });

  it("records an audit event on success", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    await service.verifyEmail({ token });
    expect(harness.auditEvents.map((e) => e.action)).toContain("user.email_verified");
  });

  it("rejects a token that was never issued", async () => {
    const service = createIdentityService(harness.deps);
    await expect(service.verifyEmail({ token: "never-issued" })).rejects.toMatchObject({
      code: "invalid_verification_token",
    });
  });

  it("records a failure audit event for a token that was never issued", async () => {
    const service = createIdentityService(harness.deps);
    await expect(service.verifyEmail({ token: "never-issued" })).rejects.toThrow();
    expect(harness.auditEvents.map((e) => e.action)).toContain("user.email_verification_failed");
  });

  it("rejects an unconsumed token that has expired, with its own audit action", async () => {
    const token = await registerAndGetToken();
    const stored = harness.tokensByHash.get(hashToken(token))!;
    stored.expiresAt = new Date(Date.now() - 1_000);

    const service = createIdentityService(harness.deps);
    await expect(service.verifyEmail({ token })).rejects.toMatchObject({
      code: "invalid_verification_token",
    });
    // Distinct from user.email_verification_failed (never-issued hash): an
    // ordinary stale link is not the same signal as a scan or a mangled URL.
    expect(harness.auditEvents.map((e) => e.action)).toContain(
      "user.email_verification_expired",
    );
    expect(harness.auditEvents.map((e) => e.action)).not.toContain(
      "user.email_verification_failed",
    );
  });

  /**
   * Pins the ordering: consumedAt is checked before expiresAt, so a link
   * that was validly used and has since expired still reports
   * already_verified rather than the misleading "invalid or expired".
   */
  it("reports already_verified for a token that is both consumed and expired", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    await service.verifyEmail({ token });

    const stored = harness.tokensByHash.get(hashToken(token))!;
    stored.expiresAt = new Date(Date.now() - 1_000);

    const result = await service.verifyEmail({ token });
    expect(result).toEqual({ status: "already_verified" });
  });

  /**
   * The behavior this whole round exists to pin: clicking the same valid
   * link twice — back button, bookmark, mail-client prefetch — must not
   * report a false failure. A consumed token is a *different* state from an
   * unknown one, and the response must say so.
   */
  it("reports already_verified, not an error, for a token already consumed by an earlier click", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);

    const first = await service.verifyEmail({ token });
    expect(first).toEqual({ status: "verified" });

    const second = await service.verifyEmail({ token });
    expect(second).toEqual({ status: "already_verified" });
  });

  it("records a distinct audit action for a repeated verification", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    await service.verifyEmail({ token });
    await service.verifyEmail({ token });
    expect(harness.auditEvents.map((e) => e.action)).toContain(
      "user.email_verification_repeated",
    );
  });

  it("does not mark the user verified a second time", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);
    await service.verifyEmail({ token });
    harness.users.markEmailVerified.mockClear();
    await service.verifyEmail({ token });
    expect(harness.users.markEmailVerified).not.toHaveBeenCalled();
  });

  it("when two verifications race for the same unconsumed token, exactly one wins", async () => {
    const token = await registerAndGetToken();
    const service = createIdentityService(harness.deps);

    const results = await Promise.all([
      service.verifyEmail({ token }),
      service.verifyEmail({ token }),
    ]);

    expect(results.filter((r) => r.status === "verified")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_verified")).toHaveLength(1);
  });
});

describe("resendVerification", () => {
  const HOUR = 60 * 60 * 1000;
  const origin = { ipAddress: "203.0.113.9", userAgent: "resend-test-agent" };
  /** The service's clock, fixed so the token's expiry can be compared exactly. */
  const at = new Date("2026-09-25T12:00:00.000Z");
  let harness: ReturnType<typeof buildDependencies>;

  beforeEach(() => {
    harness = buildDependencies();
  });

  const service = () => createIdentityService({ ...harness.deps, now: () => at });

  function addUser(options: { isVerified: boolean }): User {
    const user: User = {
      id: `user-${harness.usersByEmail.size + 100}`,
      email: `person-${harness.usersByEmail.size}@example.com`,
      passwordHash: "$argon2id$existing",
      emailVerifiedAt: options.isVerified ? new Date("2026-09-01T00:00:00.000Z") : null,
      acceptedTermsVersion: TEST_TERMS_VERSION,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    harness.usersByEmail.set(user.email, user);
    return user;
  }

  it("sends nothing and writes no token for an unknown address, and audits no_account", async () => {
    await service().resendVerification({ email: "nobody@example.com", ...origin });

    expect(harness.mailer.sent).toEqual([]);
    expect(harness.verificationTokens.create).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([
      { action: "user.verification_email_resent", metadata: { outcome: "no_account" }, ...origin },
    ]);
  });

  it("sends nothing and writes no token for a verified user, and audits already_verified", async () => {
    const user = addUser({ isVerified: true });

    await service().resendVerification({ email: user.email, ...origin });

    expect(harness.mailer.sent).toEqual([]);
    expect(harness.verificationTokens.create).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([
      {
        action: "user.verification_email_resent",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { outcome: "already_verified" },
        ...origin,
      },
    ]);
  });

  it("emails an unverified user a new link with the usual expiry, leaves the earlier tokens valid, and audits sent", async () => {
    const user = addUser({ isVerified: false });
    const earlierHash = hashToken("an-earlier-token");
    await harness.verificationTokens.create({
      userId: user.id,
      tokenHash: earlierHash,
      expiresAt: new Date(at.getTime() + HOUR),
    });
    harness.verificationTokens.create.mockClear();

    await service().resendVerification({ email: user.email.toUpperCase(), ...origin });

    expect(harness.mailer.sent).toHaveLength(1);
    const message = harness.mailer.sent[0]!;
    expect(message).toMatchObject({ to: user.email, subject: "Confirm your Telflo email address" });
    const token = message.text.match(/\/verify-email\?token=([A-Za-z0-9_-]+)/)![1]!;
    expect(message.text).toContain(`https://app.telflo.local/verify-email?token=${token}`);
    expect(harness.verificationTokens.create).toHaveBeenCalledOnce();
    expect(harness.verificationTokens.create).toHaveBeenCalledWith({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(at.getTime() + 24 * HOUR),
    });
    // D3 decision 8: the earlier link still works until it expires.
    expect(harness.tokensByHash.get(earlierHash)?.consumedAt).toBeNull();
    expect(harness.verificationTokens.consume).not.toHaveBeenCalled();

    expect(harness.auditEvents).toEqual([
      {
        action: "user.verification_email_resent",
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        metadata: { outcome: "sent" },
        ...origin,
      },
    ]);
  });

  it("audits send_failed with the actor and rethrows when the email cannot be sent", async () => {
    const user = addUser({ isVerified: false });
    const failure = new Error("smtp unavailable");
    vi.spyOn(harness.mailer, "send").mockRejectedValueOnce(failure);

    await expect(service().resendVerification({ email: user.email, ...origin })).rejects.toBe(failure);

    expect(harness.auditEvents).toEqual([
      {
        action: "user.verification_email_resent",
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
