import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACCOUNT_ERROR_CODES,
  ACCOUNT_SESSIONS_MAXIMUM,
  AccountSessionSchema,
  AccountSessionsResponseSchema,
  ChangePasswordRequestSchema,
  IdentityLinkRequestSchema,
  IdentityLinkResponseSchema,
  SESSION_BROWSERS,
  SESSION_SYSTEMS,
  SignInMethodsResponseSchema,
  UnlinkIdentityRequestSchema,
  type AccountErrorCode,
} from "./account.js";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import { FLEET_ERROR_CODES } from "./fleets.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { QUICK_DEPLOY_LINK_ERROR_CODES } from "./quick-deploy.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import { OIDC_LINK_RESULT_CODES, OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { TEST_REGEX_ERROR_CODES } from "./test-regexes.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import { VALIDATION_RULES_ERROR_CODES } from "./validation-rules.js";
import { VARIABLE_ERROR_CODES } from "./variables.js";

// The account's security routes (D21 decisions 21 and 35-40).

const session = {
  id: "0192f1a8-7a3c-7c51-9b7e-2f4d6c8e0a12",
  isCurrent: true,
  signedInAt: "2026-10-22T09:00:00.000Z",
  lastActiveAt: "2026-10-22T09:15:00.000Z",
  ipAddress: "203.0.113.7",
  browser: "firefox",
  os: "macos",
};

describe("ChangePasswordRequestSchema", () => {
  it("the new password is 12 to 128 characters and not trimmed", () => {
    const valid = { currentPassword: "old", newPassword: "a".repeat(12) };
    expect(ChangePasswordRequestSchema.safeParse(valid).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, newPassword: "a".repeat(11) }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, newPassword: "a".repeat(128) }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, newPassword: "a".repeat(129) }).success).toBe(false);

    // Neither password is trimmed: the spaces are the person's characters.
    const spaced = { currentPassword: "  old  ", newPassword: " twelve chars " };
    expect(ChangePasswordRequestSchema.parse(spaced)).toEqual(spaced);
    // Eleven characters and a space: twelve, kept as typed.
    expect(ChangePasswordRequestSchema.parse({ ...valid, newPassword: "elevenchars " }).newPassword).toBe(
      "elevenchars ",
    );
  });

  it("takes any current password from 1 to 128 characters, and refuses an unknown key", () => {
    const valid = { currentPassword: "x", newPassword: "a".repeat(12) };
    expect(ChangePasswordRequestSchema.safeParse(valid).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, currentPassword: "" }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, currentPassword: "a".repeat(128) }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, currentPassword: "a".repeat(129) }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ newPassword: valid.newPassword }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, confirmPassword: valid.newPassword }).success).toBe(false);
  });

  it("refuses without echoing a password in its issues", () => {
    const secret = "correct horse battery staple, far too long".repeat(4);
    const result = ChangePasswordRequestSchema.safeParse({ currentPassword: secret, newPassword: "short" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("correct horse");
    expect(JSON.stringify(result.error?.issues)).not.toContain("short");
  });
});

describe("AccountSessionsResponseSchema", () => {
  it("the sessions reply holds at most 100 items and only the listed families", () => {
    expect(ACCOUNT_SESSIONS_MAXIMUM).toBe(100);
    expect(SESSION_BROWSERS).toEqual(["firefox", "chrome", "edge", "safari", "opera", "other"]);
    expect(SESSION_SYSTEMS).toEqual(["macos", "windows", "linux", "ios", "android", "chromeos", "other"]);

    const items = (count: number) => Array.from({ length: count }, (_, index) => ({ ...session, isCurrent: index === 0 }));
    expect(AccountSessionsResponseSchema.safeParse({ items: items(100), total: 140 }).success).toBe(true);
    expect(AccountSessionsResponseSchema.safeParse({ items: items(101), total: 140 }).success).toBe(false);
    expect(AccountSessionsResponseSchema.safeParse({ items: [], total: 0 }).success).toBe(true);
    expect(AccountSessionsResponseSchema.safeParse({ items: [], total: -1 }).success).toBe(false);
    expect(AccountSessionsResponseSchema.safeParse({ items: [], total: 1.5 }).success).toBe(false);

    for (const browser of SESSION_BROWSERS) {
      expect(AccountSessionSchema.safeParse({ ...session, browser }).success, browser).toBe(true);
    }
    for (const os of SESSION_SYSTEMS) {
      expect(AccountSessionSchema.safeParse({ ...session, os }).success, os).toBe(true);
    }
    for (const browser of ["Firefox", "brave", "Mozilla/5.0 (Macintosh) Firefox/131.0", ""]) {
      expect(AccountSessionSchema.safeParse({ ...session, browser }).success, browser).toBe(false);
    }
    for (const os of ["macOS", "freebsd", "Mac OS X 10_15_7", ""]) {
      expect(AccountSessionSchema.safeParse({ ...session, os }).success, os).toBe(false);
    }
  });

  it("an item is strict: no raw user agent, a uuid id, ISO times and an address or null", () => {
    expect(AccountSessionSchema.safeParse(session).success).toBe(true);
    expect(AccountSessionSchema.safeParse({ ...session, ipAddress: null }).success).toBe(true);
    expect(AccountSessionSchema.safeParse({ ...session, userAgent: "Mozilla/5.0" }).success).toBe(false);
    expect(AccountSessionSchema.safeParse({ ...session, id: "current" }).success).toBe(false);
    expect(AccountSessionSchema.safeParse({ ...session, signedInAt: "yesterday" }).success).toBe(false);
    expect(AccountSessionSchema.safeParse({ ...session, lastActiveAt: undefined }).success).toBe(false);
    expect(AccountSessionSchema.safeParse({ ...session, isCurrent: "true" }).success).toBe(false);
  });
});

describe("SignInMethodsResponseSchema", () => {
  it("holds whether a password is set, the linked identities and the configured providers", () => {
    const reply = {
      hasPassword: false,
      identities: [
        { provider: "google", email: "person@example.com", linkedAt: "2026-10-22T09:00:00.000Z", relinksByEmail: true },
      ],
      providers: [{ id: "google", name: "Google" }],
    };
    expect(SignInMethodsResponseSchema.safeParse(reply).success).toBe(true);
    // Whether the provider re-links by email (Ruling 92): required, a boolean.
    const { relinksByEmail: _omitted, ...withoutRelinks } = reply.identities[0]!;
    expect(SignInMethodsResponseSchema.safeParse({ ...reply, identities: [withoutRelinks] }).success).toBe(false);
    expect(
      SignInMethodsResponseSchema.safeParse({ ...reply, identities: [{ ...reply.identities[0], relinksByEmail: "true" }] })
        .success,
    ).toBe(false);
    expect(
      SignInMethodsResponseSchema.safeParse({ ...reply, identities: [{ ...reply.identities[0], relinksByEmail: false }] })
        .success,
    ).toBe(true);
    expect(SignInMethodsResponseSchema.safeParse({ ...reply, identities: [], providers: [] }).success).toBe(true);
    expect(
      SignInMethodsResponseSchema.safeParse({
        ...reply,
        identities: [{ ...reply.identities[0], providerSubject: "1234" }],
      }).success,
    ).toBe(false);
    expect(SignInMethodsResponseSchema.safeParse({ ...reply, email: "person@example.com" }).success).toBe(false);
  });
});

describe("IdentityLinkRequestSchema", () => {
  it("the link request refuses an unknown key and a provider id outside the pattern", () => {
    expect(IdentityLinkRequestSchema.safeParse({ provider: "google" }).success).toBe(true);
    expect(IdentityLinkRequestSchema.safeParse({ provider: "google", currentPassword: "pw" }).success).toBe(true);
    expect(IdentityLinkRequestSchema.safeParse({ provider: "my-idp-2" }).success).toBe(true);
    expect(IdentityLinkRequestSchema.safeParse({ provider: "a".repeat(64) }).success).toBe(true);

    expect(IdentityLinkRequestSchema.safeParse({ provider: "google", redirectTo: "/app" }).success).toBe(false);
    for (const provider of ["", "Google", "goo gle", "google/", "../google", "google_2", "a".repeat(65)]) {
      expect(IdentityLinkRequestSchema.safeParse({ provider }).success, provider).toBe(false);
    }
    expect(IdentityLinkRequestSchema.safeParse({}).success).toBe(false);
    expect(IdentityLinkRequestSchema.safeParse({ provider: "google", currentPassword: "" }).success).toBe(false);
    expect(
      IdentityLinkRequestSchema.safeParse({ provider: "google", currentPassword: "a".repeat(129) }).success,
    ).toBe(false);
  });

  it("answers the provider's authorization URL", () => {
    const url = "https://accounts.example.com/authorize?state=abc";
    expect(IdentityLinkResponseSchema.parse({ authorizationUrl: url })).toEqual({ authorizationUrl: url });
    expect(IdentityLinkResponseSchema.safeParse({ authorizationUrl: "not a url" }).success).toBe(false);
  });
});

describe("UnlinkIdentityRequestSchema", () => {
  it("requires the current password, 1 to 128 characters, and nothing else", () => {
    expect(UnlinkIdentityRequestSchema.safeParse({ currentPassword: " pw " }).data).toEqual({ currentPassword: " pw " });
    expect(UnlinkIdentityRequestSchema.safeParse({}).success).toBe(false);
    expect(UnlinkIdentityRequestSchema.safeParse({ currentPassword: "" }).success).toBe(false);
    expect(UnlinkIdentityRequestSchema.safeParse({ currentPassword: "a".repeat(129) }).success).toBe(false);
    expect(UnlinkIdentityRequestSchema.safeParse({ currentPassword: "pw", provider: "google" }).success).toBe(false);
  });
});

describe("ACCOUNT_ERROR_CODES", () => {
  it("ACCOUNT_ERROR_CODES is decision 21's eight codes", () => {
    expect(ACCOUNT_ERROR_CODES).toEqual([
      "current_password_incorrect",
      "password_not_set",
      "identity_already_linked",
      "identity_not_linked",
      "unlink_requires_password",
      "session_not_found",
      "cannot_revoke_current_session",
      "provider_unavailable",
    ]);
    expectTypeOf<"session_not_found">().toMatchTypeOf<AccountErrorCode>();
    expectTypeOf<"session_not_fund">().not.toMatchTypeOf<AccountErrorCode>();
  });

  it("the codes clash with no other module's codes", () => {
    const others = new Set<string>([
      ...CONFIGURATION_ERROR_CODES,
      ...FLEET_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...VALIDATION_RULES_ERROR_CODES,
      ...TEST_REGEX_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...OIDC_QUERY_ERROR_CODES,
      ...OIDC_LINK_RESULT_CODES,
      ...SALES_INQUIRY_ERROR_CODES,
      ...QUICK_DEPLOY_LINK_ERROR_CODES,
      ...VARIABLE_ERROR_CODES,
    ]);
    for (const code of ACCOUNT_ERROR_CODES) expect(others.has(code), code).toBe(false);
    // Reused, not redeclared: the person's 429.
    expect(SESSION_ERROR_CODES).toContain("rate_limited");
  });
});
