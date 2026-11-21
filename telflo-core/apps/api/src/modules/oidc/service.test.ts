import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OPEN_SOURCE_SITE, type RegistrationMode } from "@telflo/contracts";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import type { IOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { IdentityLinkConflictError, type UserIdentity } from "../identity/repositories/user-identity-repository.js";
import { DuplicateEmailError, type Account, type User } from "../identity/repositories/user-repository.js";
import type { Session } from "../sessions/repositories/session-repository.js";
import type { IssuedSession, SessionTransaction, StartSessionInput } from "../sessions/service.js";
import { createCollectingRunner } from "../../http/after-response.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { VerifiedOidcFlow } from "./flow-cookie.js";
import type { IOidcProviderRegistry, OidcProvider } from "./providers.js";
import {
  createOidcService,
  oidcCallbackUrl,
  type ExchangeCode,
  type OidcServiceDependencies,
  type OidcTransaction,
  type ProviderClaims,
} from "./service.js";

// The service's branches that the database can't be made to take on cue:
// a takeover that finds the account verified under its lock, a session start
// refused under its lock, races that never settle. The table itself is
// proven against Postgres and the fake provider in routes.integration.test.ts.

const STATE = "s".repeat(43);
const flow: VerifiedOidcFlow = {
  providerId: "google",
  redirectTo: "/app/x",
  state: STATE,
  nonce: "n".repeat(43),
  codeVerifier: "v".repeat(43),
  intent: "sign_in",
};
const LINK_USER_ID = randomUUID();
const LINK_SESSION_ID = randomUUID();
const linkFlow: VerifiedOidcFlow = {
  ...flow,
  redirectTo: "/settings/account",
  intent: "link",
  userId: LINK_USER_ID,
  sessionId: LINK_SESSION_ID,
};
const origin = { ipAddress: "203.0.113.7", userAgent: "vitest" };
const callbackUrl = new URL(`https://telflo.example/api/v1/auth/oidc/google/callback?code=the-code&state=${STATE}`);

const provider: OidcProvider = {
  id: "google",
  name: "Google",
  isEmailAuthoritative: vi.fn(() => true),
  configuration: () => Promise.reject(new Error("not used: the exchange is injected")),
};
const registry: IOidcProviderRegistry = {
  list: () => [{ id: provider.id, name: provider.name }],
  get: (id) => (id === provider.id ? provider : undefined),
  relinksByEmail: (id) => id === provider.id,
};

function user(overrides: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    email: "person@gmail.com",
    passwordHash: null,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    acceptedTermsVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const issued: IssuedSession = {
  user: { id: "u", email: "person@gmail.com" },
  accessToken: "access",
  accessTokenExpiresAt: new Date(),
  refreshToken: "refresh",
  refreshTokenExpiresAt: new Date(),
};

function buildHarness(claims: Partial<ProviderClaims> = {}, registration: RegistrationMode = "open") {
  const events: AuditEvent[] = [];
  const calls: string[] = [];
  const exchange = vi.fn<ExchangeCode>(async () => {
    calls.push("exchange");
    return {
      iss: "https://accounts.google.com",
      aud: "client",
      iat: 0,
      exp: 0,
      sub: "sub-1",
      email: "person@gmail.com",
      email_verified: true,
      ...claims,
    };
  });
  const users = {
    findByEmailIncludingDeleted: vi.fn(async (_email: string) => {
      calls.push("findByEmailIncludingDeleted");
      return undefined as { user: User; isDeleted: boolean } | undefined;
    }),
    createFederatedAccount: vi.fn(async (): Promise<Account> => {
      calls.push("createFederatedAccount");
      throw new Error("not set up");
    }),
    findById: vi.fn(async (_id: string): Promise<User | undefined> => undefined),
  };
  const identities = {
    findUserBySubject: vi.fn(async (_provider: string, _subject: string) => {
      calls.push("findUserBySubject");
      return undefined as { user: User; isDeleted: boolean } | undefined;
    }),
    listForUser: vi.fn(async () => []),
    findForUser: vi.fn(async () => undefined),
  };
  const transaction = {
    users: {
      lockForUpdate: vi.fn(async () => undefined),
      findById: vi.fn(async (_id: string): Promise<User | undefined> => undefined),
      takeOverUnverified: vi.fn(
        async () => undefined as { email: string; hadPassword: boolean; hadTerms: boolean } | undefined,
      ),
      findPasswordHashForShare: vi.fn(async (): Promise<string | null | undefined> => null),
    },
    identities: {
      link: vi.fn(async () => ({}) as never),
      findUserBySubject: vi.fn(async (_provider: string, _subject: string) =>
        undefined as { user: User; isDeleted: boolean } | undefined,
      ),
      findForUser: vi.fn(async (_userId: string, _provider: string): Promise<UserIdentity | undefined> => undefined),
      unlink: vi.fn(async () => true),
    },
    passwordResetTokens: { consumeAllForUser: vi.fn(async () => 0) },
    verificationTokens: { consumeAllForUser: vi.fn(async () => 0) },
    sessions: {
      revokeAllForUser: vi.fn(async () => 0),
      findLiveForShare: vi.fn(async (_sessionId: string, _userId: string): Promise<Session | undefined> => undefined),
    },
    audit: { record: vi.fn(async (event: AuditEvent) => void events.push(event)) },
  } satisfies OidcTransaction;
  const mailer = createInMemoryMailer();
  const runner = createCollectingRunner();
  const sessionTransaction = {
    users: { findPasswordHashForShare: vi.fn(async (): Promise<string | null | undefined> => null) },
  };
  const startSession = vi.fn(async (input: StartSessionInput) =>
    (await input.check(sessionTransaction as unknown as SessionTransaction)) ? issued : undefined,
  );
  const deps: OidcServiceDependencies = {
    providers: registry,
    users,
    identities,
    withUserOrganizations: async (_userId, work) =>
      work({ findPersonalForUser: vi.fn(async () => ({ id: "org", name: "workspace" })) } as unknown as IOrganizationRepository),
    audit: { record: vi.fn(async (event: AuditEvent) => void events.push(event)) },
    sessions: { startSession },
    withTransaction: async (work) => {
      calls.push("transaction");
      return work(transaction);
    },
    settings: {
      publicWebUrl: "https://telflo.example",
      accessTokenSecret: "unit-test-only-secret-that-is-32-bytes-long",
      site: { ...OPEN_SOURCE_SITE, registration },
    },
    now: () => new Date("2026-09-26T12:00:00.000Z"),
    exchange,
    opampRegistration: { created: vi.fn(), renamed: vi.fn(), deleted: vi.fn() },
    mailer,
    runAfterResponse: runner.run,
  };
  const service = createOidcService(deps);
  const complete = () => service.completeSignIn({ providerId: "google", callbackUrl, flow, origin });
  const completeLink = () => service.completeSignIn({ providerId: "google", callbackUrl, flow: linkFlow, origin });
  const failure = () => events.find((event) => event.action === "user.oidc_sign_in_failed")?.metadata;
  const linkFailure = () => events.find((event) => event.action === "user.identity_link_failed");
  return {
    deps,
    service,
    complete,
    completeLink,
    failure,
    linkFailure,
    events,
    calls,
    exchange,
    users,
    identities,
    transaction,
    sessionTransaction,
    startSession,
    mailer,
    runner,
  };
}

/** The harness's service again, with an injected password verify. */
function createOidcServiceWith(
  harness: ReturnType<typeof buildHarness>,
  verifyPassword: (hashValue: string, plaintext: string) => Promise<boolean>,
) {
  return createOidcService({ ...harness.deps, verifyPassword });
}

describe("OIDC service", () => {
  it("exchanges the code before any lookup or transaction, and writes nothing when the exchange fails", async () => {
    const harness = buildHarness();
    harness.exchange.mockRejectedValueOnce(
      Object.assign(new Error("unexpected JWT claim value encountered"), {
        code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
        cause: { parameters: callbackUrl.searchParams },
      }),
    );

    expect(await harness.complete()).toEqual({ kind: "refused", code: "oauth_failed", redirectTo: "/app/x" });
    expect(harness.exchange).toHaveBeenCalledTimes(1);
    expect(harness.identities.findUserBySubject).not.toHaveBeenCalled();
    expect(harness.users.findByEmailIncludingDeleted).not.toHaveBeenCalled();
    expect(harness.users.createFederatedAccount).not.toHaveBeenCalled();
    expect(harness.calls).not.toContain("transaction");
    expect(harness.startSession).not.toHaveBeenCalled();
    // The failed check's code only: never the error, whose cause holds the code.
    expect(harness.failure()).toEqual({
      reason: "exchange_failed",
      provider: "google",
      error: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    });
    expect(JSON.stringify(harness.events)).not.toContain("the-code");
  });

  it("looks the subject up before anything the provider says about the email", async () => {
    const linked = user();
    const harness = buildHarness({ email_verified: false, email: "someone-else@example.com" });
    harness.identities.findUserBySubject.mockResolvedValueOnce({ user: linked, isDeleted: false });

    expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
    expect(harness.exchange.mock.invocationCallOrder[0]).toBeLessThan(
      harness.identities.findUserBySubject.mock.invocationCallOrder[0]!,
    );
    expect(harness.users.findByEmailIncludingDeleted).not.toHaveBeenCalled();
    expect(harness.calls).not.toContain("transaction");
  });

  it("takes the plain link path when the account was verified between the lookup and the takeover's lock", async () => {
    const unverified = user({ emailVerifiedAt: null, passwordHash: "$argon2id$hash" });
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: unverified, isDeleted: false });
    harness.transaction.users.takeOverUnverified.mockResolvedValueOnce(undefined);
    harness.transaction.users.findById.mockResolvedValue({ ...unverified, emailVerifiedAt: new Date() });

    expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
    expect(harness.transaction.passwordResetTokens.consumeAllForUser).not.toHaveBeenCalled();
    expect(harness.transaction.sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(harness.transaction.identities.link).toHaveBeenCalledTimes(1);
    expect(harness.events.map((event) => event.action)).toEqual(["user.identity_linked"]);
  });

  it("locks the user's row before the takeover touches tokens and sessions (the lock order)", async () => {
    const unverified = user({ emailVerifiedAt: null, passwordHash: "$argon2id$hash" });
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: unverified, isDeleted: false });
    harness.transaction.users.findById.mockResolvedValueOnce(unverified);
    harness.transaction.users.takeOverUnverified.mockResolvedValueOnce({
      email: unverified.email,
      hadPassword: true,
      hadTerms: true,
    });

    expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;
    const { transaction } = harness;
    expect(order(transaction.users.lockForUpdate)).toBeLessThan(order(transaction.users.findById));
    expect(order(transaction.users.findById)).toBeLessThan(order(transaction.users.takeOverUnverified));
    expect(order(transaction.users.takeOverUnverified)).toBeLessThan(order(transaction.passwordResetTokens.consumeAllForUser));
    expect(order(transaction.passwordResetTokens.consumeAllForUser)).toBeLessThan(order(transaction.sessions.revokeAllForUser));
    expect(transaction.sessions.revokeAllForUser).toHaveBeenCalledWith(unverified.id, "account_taken_over");
  });

  describe("the site's registration", () => {
    for (const registration of ["invite-only", "closed"] as const) {
      it(`${registration}: a sign-in with no account for the email is refused registration_not_open, creating nothing and starting no session`, async () => {
        const harness = buildHarness({}, registration);

        expect(await harness.complete()).toEqual({ kind: "refused", code: "registration_not_open", redirectTo: "/app/x" });
        expect(harness.users.findByEmailIncludingDeleted).toHaveBeenCalledTimes(1);
        expect(harness.users.createFederatedAccount).not.toHaveBeenCalled();
        expect(harness.calls).not.toContain("transaction");
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.failure()).toEqual({ reason: "registration_not_open", provider: "google" });
      });

      it(`${registration}: a verified account with the email is linked and signed in`, async () => {
        const verified = user();
        const harness = buildHarness({}, registration);
        harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: verified, isDeleted: false });
        harness.transaction.users.findById.mockResolvedValue(verified);

        expect(await harness.complete()).toEqual({ kind: "signed_in", issued, redirectTo: "/app/x" });
        expect(harness.transaction.identities.link).toHaveBeenCalledTimes(1);
        expect(harness.users.createFederatedAccount).not.toHaveBeenCalled();
      });
    }

    it("open: a sign-in with no account for the email goes on to create one", async () => {
      const harness = buildHarness({}, "open");

      // The harness's account create fails ("not set up"): reaching it is the point.
      expect(await harness.complete()).toMatchObject({ kind: "refused", code: "oauth_failed", redirectTo: "/app/x" });
      expect(harness.users.createFederatedAccount).toHaveBeenCalledTimes(1);
      expect(harness.failure()).toMatchObject({ reason: "internal_error" });
    });
  });

  it("refuses with session_refused when the user is gone by the time the session starts", async () => {
    const harness = buildHarness();
    harness.identities.findUserBySubject.mockResolvedValueOnce({ user: user(), isDeleted: false });
    harness.sessionTransaction.users.findPasswordHashForShare.mockResolvedValueOnce(undefined);

    expect(await harness.complete()).toEqual({ kind: "refused", code: "oauth_failed", redirectTo: "/app/x" });
    expect(harness.failure()).toMatchObject({ reason: "session_refused" });
  });

  it("starts the session for a live user without a password (null is live, undefined is gone)", async () => {
    const harness = buildHarness();
    harness.identities.findUserBySubject.mockResolvedValueOnce({ user: user({ passwordHash: null }), isDeleted: false });
    harness.sessionTransaction.users.findPasswordHashForShare.mockResolvedValueOnce(null);

    expect(await harness.complete()).toEqual({ kind: "signed_in", issued, redirectTo: "/app/x" });
    // As password sign-in: where the person last was, else the organization joined most recently,
    // the personal organization the last resort, chosen in the session's transaction.
    expect(harness.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        landing: { personalOrganizationId: "org" },
        auditMetadata: { method: "oidc", provider: "google" },
      }),
    );
    expect(harness.startSession.mock.calls[0]![0].organizationId).toBeUndefined();
  });

  it("refuses with concurrent_sign_in, never a 500, when every attempt loses a race", async () => {
    const harness = buildHarness();
    harness.users.createFederatedAccount.mockRejectedValue(new DuplicateEmailError());

    expect(await harness.complete()).toMatchObject({ kind: "refused", code: "oauth_failed" });
    expect(harness.failure()).toMatchObject({ reason: "concurrent_sign_in" });
    expect(harness.users.createFederatedAccount).toHaveBeenCalledTimes(3);
  });

  it("treats provider_taken as a race when the subject is now linked, and signs that user in", async () => {
    const existing = user();
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: existing, isDeleted: false });
    harness.transaction.users.findById.mockResolvedValueOnce(existing);
    harness.transaction.identities.link.mockRejectedValueOnce(new IdentityLinkConflictError("provider_taken"));
    harness.identities.findUserBySubject
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ user: existing, isDeleted: false });

    expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
    expect(harness.failure()).toBeUndefined();
  });

  it("refuses provider_taken with identity_conflict when the subject is still unlinked", async () => {
    const existing = user();
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: existing, isDeleted: false });
    harness.transaction.users.findById.mockResolvedValueOnce(existing);
    harness.transaction.identities.link.mockRejectedValueOnce(new IdentityLinkConflictError("provider_taken"));

    expect(await harness.complete()).toMatchObject({ kind: "refused", code: "oauth_failed" });
    expect(harness.failure()).toMatchObject({ reason: "identity_conflict" });
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("refuses a verified account soft-deleted between the lookup and the link's lock", async () => {
    const existing = user();
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: existing, isDeleted: false });
    harness.transaction.users.findById.mockResolvedValueOnce(undefined);

    expect(await harness.complete()).toMatchObject({ kind: "refused", code: "oauth_failed" });
    expect(harness.transaction.identities.link).not.toHaveBeenCalled();
    expect(harness.failure()).toMatchObject({ reason: "deleted_user" });
  });

  describe("the provider's email (M1)", () => {
    it("asks the provider about the address as it will be matched: trimmed and lowercased", async () => {
      const harness = buildHarness({ email: "  Person@GMAIL.com " });
      vi.mocked(provider.isEmailAuthoritative).mockClear();
      harness.users.createFederatedAccount.mockImplementationOnce(async () => ({ user: user() }) as unknown as Account);

      expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
      expect(provider.isEmailAuthoritative).toHaveBeenCalledWith({ email: "person@gmail.com", hd: undefined });
      expect(harness.users.findByEmailIncludingDeleted).toHaveBeenCalledWith("person@gmail.com");
    });

    it.each([
      ["a KELVIN SIGN (it lowercases to k)", "\u212Aate@gmail.com"],
      ["a Cyrillic letter", "p\u0435rson@gmail.com"],
      ["a control character", "person\u0000@gmail.com"],
    ])("refuses, as unverified and before any lookup, an address with %s", async (_label, email) => {
      const harness = buildHarness({ email });

      expect(await harness.complete()).toEqual({ kind: "refused", code: "oauth_email_unverified", redirectTo: "/app/x" });
      expect(harness.failure()).toEqual({ reason: "email_unverified", provider: "google" });
      expect(harness.users.findByEmailIncludingDeleted).not.toHaveBeenCalled();
      expect(harness.calls).not.toContain("transaction");
    });
  });

  describe("the email rechecked under the user's lock (M2)", () => {
    it("doesn't link an account whose email changed since the lookup: the decision runs again", async () => {
      const existing = user();
      const harness = buildHarness();
      harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: existing, isDeleted: false });
      harness.transaction.users.findById.mockResolvedValueOnce({ ...existing, email: "renamed@gmail.com" });
      const created = user();
      harness.users.createFederatedAccount.mockImplementationOnce(async () => ({ user: created }) as unknown as Account);

      expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
      expect(harness.transaction.identities.link).not.toHaveBeenCalled();
      expect(harness.users.findByEmailIncludingDeleted).toHaveBeenCalledTimes(2);
      expect(harness.startSession).toHaveBeenCalledWith(expect.objectContaining({ user: created }));
    });

    it("doesn't take over an account whose email changed since the lookup: the decision runs again", async () => {
      const unverified = user({ emailVerifiedAt: null, passwordHash: "$argon2id$hash" });
      const harness = buildHarness();
      harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: unverified, isDeleted: false });
      harness.transaction.users.findById.mockResolvedValueOnce({ ...unverified, email: "renamed@gmail.com" });
      harness.users.createFederatedAccount.mockImplementationOnce(async () => ({ user: user() }) as unknown as Account);

      expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
      expect(harness.transaction.users.takeOverUnverified).not.toHaveBeenCalled();
      expect(harness.transaction.passwordResetTokens.consumeAllForUser).not.toHaveBeenCalled();
      expect(harness.transaction.identities.link).not.toHaveBeenCalled();
      expect(harness.users.findByEmailIncludingDeleted).toHaveBeenCalledTimes(2);
    });
  });

  describe("an unexpected failure (M3)", () => {
    it("while finding the user: audited as internal_error by a label, refused with the flow's redirectTo", async () => {
      const harness = buildHarness();
      const failure = Object.assign(new Error(`connection lost; state=${STATE}`), { code: "57P01" });
      harness.identities.findUserBySubject.mockRejectedValueOnce(failure);

      const result = await harness.complete();

      expect(result).toEqual({ kind: "refused", code: "oauth_failed", redirectTo: "/app/x", error: failure });
      expect(harness.failure()).toEqual({ reason: "internal_error", provider: "google", error: "57P01" });
      expect(JSON.stringify(harness.events)).not.toContain(STATE);
    });

    it("while starting the session: audited as internal_error, refused", async () => {
      const harness = buildHarness();
      harness.identities.findUserBySubject.mockResolvedValueOnce({ user: user(), isDeleted: false });
      harness.startSession.mockRejectedValueOnce(new TypeError("boom"));

      expect(await harness.complete()).toMatchObject({ kind: "refused", code: "oauth_failed", redirectTo: "/app/x" });
      expect(harness.failure()).toEqual({ reason: "internal_error", provider: "google", error: "TypeError" });
    });
  });

  it("a sign-in's link records via sign_in and queues no email", async () => {
    const existing = user();
    const harness = buildHarness();
    harness.users.findByEmailIncludingDeleted.mockResolvedValueOnce({ user: existing, isDeleted: false });
    harness.transaction.users.findById.mockResolvedValueOnce(existing);

    expect(await harness.complete()).toMatchObject({ kind: "signed_in" });
    expect(harness.events.find((event) => event.action === "user.identity_linked")?.metadata).toEqual({
      provider: "google",
      via: "sign_in",
    });
    await harness.runner.settle();
    expect(harness.mailer.sent).toEqual([]);
  });

  describe("a link from Settings", () => {
    const session = (overrides: Partial<Session> = {}): Session => ({
      id: LINK_SESSION_ID,
      userId: LINK_USER_ID,
      activeOrganizationId: "org-of-the-session",
      createdAt: new Date(),
      lastRefreshedAt: new Date(),
      revokedAt: null,
      revokedReason: null,
      ipAddress: null,
      userAgent: null,
      ...overrides,
    });

    /** A harness whose flow's user and session are live. */
    function linkHarness(claims: Partial<ProviderClaims> = {}) {
      const harness = buildHarness(claims);
      const account = user({ id: LINK_USER_ID, email: "account@example.com", passwordHash: "$argon2id$hash" });
      harness.transaction.users.findById.mockResolvedValue(account);
      harness.users.findById.mockResolvedValue(account);
      harness.transaction.sessions.findLiveForShare.mockResolvedValue(session());
      return { harness, account };
    }

    it("locks the user's row first, then reads the user, then the flow's session for share by its user, before any identity", async () => {
      const { harness } = linkHarness();

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "linked" });
      const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;
      const { transaction } = harness;
      expect(order(transaction.users.lockForUpdate)).toBeLessThan(order(transaction.users.findById));
      expect(order(transaction.users.findById)).toBeLessThan(order(transaction.sessions.findLiveForShare));
      expect(order(transaction.sessions.findLiveForShare)).toBeLessThan(order(transaction.identities.findUserBySubject));
      expect(order(transaction.identities.findUserBySubject)).toBeLessThan(order(transaction.identities.findForUser));
      expect(order(transaction.identities.findForUser)).toBeLessThan(order(transaction.identities.link));
      expect(transaction.users.lockForUpdate).toHaveBeenCalledWith(LINK_USER_ID);
      expect(transaction.sessions.findLiveForShare).toHaveBeenCalledWith(LINK_SESSION_ID, LINK_USER_ID);
      // No sign-in's lookup by email, and no session started.
      expect(harness.users.findByEmailIncludingDeleted).not.toHaveBeenCalled();
      expect(harness.startSession).not.toHaveBeenCalled();
    });

    it("links by sub with the provider's email, audits via settings with the session's organization, and queues the email to the account", async () => {
      const { harness, account } = linkHarness({ sub: "the-sub", email: "  Other.Person@Example.COM " });

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "linked" });
      expect(harness.transaction.identities.link).toHaveBeenCalledWith({
        userId: LINK_USER_ID,
        provider: "google",
        subject: "the-sub",
        email: "other.person@example.com",
      });
      expect(harness.events).toEqual([
        expect.objectContaining({
          action: "user.identity_linked",
          actorUserId: LINK_USER_ID,
          actorEmail: account.email,
          organizationId: "org-of-the-session",
          metadata: { provider: "google", via: "settings" },
        }),
      ]);
      expect(harness.mailer.sent).toEqual([]);
      await harness.runner.settle();
      expect(harness.mailer.sent).toMatchObject([{ to: account.email, subject: "Google sign-in was linked to your Telflo account" }]);
    });

    it.each([
      ["a provider error", () => new URL(`${callbackUrl.href}&error=access_denied`), "provider_error", "access_denied"],
      ["a state mismatch", () => new URL(callbackUrl.href.replace(STATE, "x".repeat(43))), "state_mismatch", undefined],
    ])("refuses %s as link_failed, audited identity_link_failed by the flow's user", async (_label, url, reason, error) => {
      const { harness, account } = linkHarness();

      const result = await harness.service.completeSignIn({ providerId: "google", callbackUrl: url(), flow: linkFlow, origin });

      expect(result).toEqual({ kind: "link_ended", code: "link_failed" });
      expect(harness.exchange).not.toHaveBeenCalled();
      expect(harness.failure()).toBeUndefined();
      expect(harness.linkFailure()).toEqual(
        expect.objectContaining({
          actorUserId: LINK_USER_ID,
          actorEmail: account.email,
          organizationId: undefined,
          metadata: { provider: "google", reason, ...(error ? { error } : {}) },
        }),
      );
    });

    it("refuses a failed exchange as link_failed with the check's label", async () => {
      const { harness } = linkHarness();
      harness.exchange.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: "OAUTH_INVALID_RESPONSE" }));

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "link_failed" });
      expect(harness.linkFailure()?.metadata).toEqual({
        provider: "google",
        reason: "exchange_failed",
        error: "OAUTH_INVALID_RESPONSE",
      });
      expect(harness.calls).not.toContain("transaction");
    });

    it("refuses a decoded link flow for another provider as flow_cookie_invalid", async () => {
      const { harness } = linkHarness();

      const result = await harness.service.completeSignIn({ providerId: "okta", callbackUrl, flow: linkFlow, origin });

      expect(result).toEqual({ kind: "link_ended", code: "link_failed" });
      expect(harness.linkFailure()?.metadata).toEqual({ provider: "google", reason: "flow_cookie_invalid" });
    });

    it("refuses session_ended, writing nothing, when the flow's session is no longer the user's live one", async () => {
      const { harness } = linkHarness();
      harness.transaction.sessions.findLiveForShare.mockResolvedValue(undefined);

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "link_failed" });
      expect(harness.transaction.identities.findUserBySubject).not.toHaveBeenCalled();
      expect(harness.transaction.identities.link).not.toHaveBeenCalled();
      expect(harness.linkFailure()).toEqual(
        expect.objectContaining({ organizationId: undefined, metadata: { provider: "google", reason: "session_ended" } }),
      );
    });

    it("records the session's organization on a refusal once the session was read", async () => {
      const { harness } = linkHarness({ email_verified: "true" as never });

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "email_unverified" });
      expect(harness.linkFailure()).toEqual(
        expect.objectContaining({
          organizationId: "org-of-the-session",
          metadata: { provider: "google", reason: "email_unverified" },
        }),
      );
    });

    it.each([
      ["this account's: linked, and no email (the other callback wrote it)", LINK_USER_ID, "linked"],
      ["another account's: identity_in_use", "someone-else", "identity_in_use"],
      ["nobody's: identity_exists", undefined, "identity_exists"],
    ])("reads a unique-index race again after the rollback: the sub now %s", async (_label, holderId, code) => {
      const { harness } = linkHarness();
      harness.transaction.identities.link.mockRejectedValueOnce(new IdentityLinkConflictError("subject_taken"));
      harness.identities.findUserBySubject.mockResolvedValueOnce(
        holderId === undefined ? undefined : { user: user({ id: holderId }), isDeleted: false },
      );

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code });
      await harness.runner.settle();
      expect(harness.mailer.sent).toEqual([]);
      expect(harness.events.some((event) => event.action === "user.identity_linked")).toBe(false);
    });

    it("audits an unexpected failure as internal_error by a label and ends in link_failed", async () => {
      const { harness } = linkHarness();
      const failure = Object.assign(new Error(`connection lost; state=${STATE}`), { code: "57P01" });
      harness.transaction.sessions.findLiveForShare.mockRejectedValueOnce(failure);

      expect(await harness.completeLink()).toEqual({ kind: "link_ended", code: "link_failed", error: failure });
      expect(harness.linkFailure()?.metadata).toEqual({ provider: "google", reason: "internal_error", error: "57P01" });
      expect(JSON.stringify(harness.events)).not.toContain(STATE);
    });
  });

  describe("unlinking", () => {
    const context = {
      userId: LINK_USER_ID,
      organizationId: "org",
      role: "admin" as const,
      sessionId: LINK_SESSION_ID,
    };

    it("refuses with current_password_incorrect, unlinking nothing, when the hash changed between the verify and the lock", async () => {
      const harness = buildHarness();
      const account = user({ id: LINK_USER_ID, passwordHash: "$argon2id$verified" });
      harness.users.findById.mockResolvedValue(account);
      harness.identities.findForUser.mockResolvedValue({ provider: "google" } as never);
      harness.transaction.users.findPasswordHashForShare.mockResolvedValue("$argon2id$changed-since");

      const verifying = createOidcServiceWith(harness, async () => true);
      await expect(
        verifying.unlink({ context, origin, providerId: "google", currentPassword: "right-then" }),
      ).rejects.toMatchObject({ code: "current_password_incorrect", statusCode: 400 });
      expect(harness.transaction.identities.unlink).not.toHaveBeenCalled();
      expect(harness.events.map((event) => [event.action, event.metadata])).toEqual([
        ["user.reauthentication_failed", { purpose: "identity_unlink" }],
      ]);
      await harness.runner.settle();
      expect(harness.mailer.sent).toEqual([]);
    });
  });

  it("builds the callback URL from the public web URL and the request's query only", () => {
    const url = oidcCallbackUrl(
      { publicWebUrl: "https://telflo.example" },
      "google",
      "/api/v1/auth/oidc/google/callback?code=c&state=s",
    );
    expect(url.href).toBe("https://telflo.example/api/v1/auth/oidc/google/callback?code=c&state=s");
  });
});
