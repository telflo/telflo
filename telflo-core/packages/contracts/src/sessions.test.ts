import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  CurrentUserResponseSchema,
  OIDC_LINK_RESULT_CODES,
  OIDC_QUERY_ERROR_CODES,
  OidcProvidersResponseSchema,
  SESSION_ERROR_CODES,
  SwitchOrganizationRequestSchema,
  SwitchOrganizationResponseSchema,
  type OidcLinkResultCode,
  type OidcQueryErrorCode,
  type SessionErrorCode,
} from "./sessions.js";
import { DEFAULT_USER_PREFERENCES } from "./user-preferences.js";

const validRequest = { email: "person@example.com", password: "password" };

describe("CreateSessionRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(CreateSessionRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("trims and lowercases the email", () => {
    const parsed = CreateSessionRequestSchema.parse({
      ...validRequest,
      email: "  Person@Example.COM  ",
    });
    expect(parsed.email).toBe("person@example.com");
  });

  it("rejects a malformed email", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("accepts an 8-character password, because sign-in has no 12-character minimum", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, password: "a".repeat(8) });
    expect(result.success).toBe(true);
  });

  it("accepts a 1-character password", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, password: "a" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, password: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a 128-character password", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, password: "a".repeat(128) });
    expect(result.success).toBe(true);
  });

  it("rejects a 129-character password", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, password: "a".repeat(129) });
    expect(result.success).toBe(false);
  });

  it("does not trim the password", () => {
    const parsed = CreateSessionRequestSchema.parse({ ...validRequest, password: "  spaced  " });
    expect(parsed.password).toBe("  spaced  ");
  });

  it("rejects extra keys", () => {
    const result = CreateSessionRequestSchema.safeParse({ ...validRequest, remember: true });
    expect(result.success).toBe(false);
  });
});

const user = { id: "0b8f9c3e-6a1d-4f2b-9e7a-3c5d1e2f4a6b", email: "person@example.com" };
const organization = {
  id: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a",
  name: "Person's organization",
  type: "personal",
  logoId: null,
  role: "admin",
};

describe("CreateSessionResponseSchema", () => {
  it("accepts a user", () => {
    expect(CreateSessionResponseSchema.safeParse({ user }).success).toBe(true);
  });

  it("rejects a user id that is not a UUID", () => {
    const result = CreateSessionResponseSchema.safeParse({ user: { ...user, id: "42" } });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys on the user", () => {
    const result = CreateSessionResponseSchema.safeParse({ user: { ...user, passwordHash: "x" } });
    expect(result.success).toBe(false);
  });
});

describe("CurrentUserResponseSchema", () => {
  const valid = {
    user,
    organization,
    organizations: [organization],
    termsAcceptanceRequired: false,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  };

  it("accepts a well-formed response", () => {
    expect(CurrentUserResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("requires termsAcceptanceRequired, as a boolean", () => {
    const { termsAcceptanceRequired: _omitted, ...withoutFlag } = valid;
    expect(CurrentUserResponseSchema.safeParse(withoutFlag).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, termsAcceptanceRequired: "yes" }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, termsAcceptanceRequired: true }).success).toBe(true);
  });

  it("requires isProductAdmin, as a boolean", () => {
    const { isProductAdmin: _omitted, ...withoutFlag } = valid;
    expect(CurrentUserResponseSchema.safeParse(withoutFlag).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, isProductAdmin: "true" }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, isProductAdmin: null }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, isProductAdmin: true }).success).toBe(true);
  });

  it("requires mayCreateOrganizations, as a boolean", () => {
    const { mayCreateOrganizations: _omitted, ...withoutFlag } = valid;
    expect(CurrentUserResponseSchema.safeParse(withoutFlag).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, mayCreateOrganizations: "true" }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, mayCreateOrganizations: false }).success).toBe(true);
  });

  it("requires the preferences, every key, with no unknown one", () => {
    const { preferences: _omitted, ...withoutPreferences } = valid;
    expect(CurrentUserResponseSchema.safeParse(withoutPreferences).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, preferences: null }).success).toBe(false);
    const { editor: _editor, ...withoutEditor } = DEFAULT_USER_PREFERENCES;
    expect(CurrentUserResponseSchema.safeParse({ ...valid, preferences: withoutEditor }).success).toBe(false);
    const { minimap: _minimap, ...editorWithoutMinimap } = DEFAULT_USER_PREFERENCES.editor;
    expect(
      CurrentUserResponseSchema.safeParse({ ...valid, preferences: { ...DEFAULT_USER_PREFERENCES, editor: editorWithoutMinimap } })
        .success,
    ).toBe(false);
    expect(
      CurrentUserResponseSchema.safeParse({ ...valid, preferences: { ...DEFAULT_USER_PREFERENCES, theme: "system" } }).success,
    ).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, preferences: { ...DEFAULT_USER_PREFERENCES, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      CurrentUserResponseSchema.safeParse({ ...valid, preferences: { ...DEFAULT_USER_PREFERENCES, theme: "navy" } }).success,
    ).toBe(true);
  });

  it("rejects the flag inside the user, where sign-in's and refresh's answers would carry it", () => {
    const result = CurrentUserResponseSchema.safeParse({ ...valid, user: { ...user, isProductAdmin: true } });
    expect(result.success).toBe(false);
  });

  it.each(["admin", "contributor"])("accepts the %s role", (role) => {
    const result = CurrentUserResponseSchema.safeParse({
      ...valid,
      organization: { ...organization, role },
    });
    expect(result.success).toBe(true);
  });

  it.each(["owner", "viewer"])("rejects the unknown role %s", (role) => {
    const result = CurrentUserResponseSchema.safeParse({
      ...valid,
      organization: { ...organization, role },
    });
    expect(result.success).toBe(false);
  });

  it("requires the type on the active organization", () => {
    const { type: _omitted, ...withoutType } = organization;
    expect(CurrentUserResponseSchema.safeParse({ ...valid, organization: withoutType }).success).toBe(false);
    expect(
      CurrentUserResponseSchema.safeParse({ ...valid, organization: { ...organization, type: "team" } }).success,
    ).toBe(false);
  });

  it("requires a type and a role on every entry in the organizations list", () => {
    const { type: _type, ...withoutType } = organization;
    const { role: _role, ...withoutRole } = organization;
    expect(CurrentUserResponseSchema.safeParse({ ...valid, organizations: [withoutType] }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ ...valid, organizations: [withoutRole] }).success).toBe(false);
    const group = {
      id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      name: "Acme",
      type: "group",
      logoId: "0199e000-0000-7000-8000-000000000001",
      role: "contributor",
    };
    expect(CurrentUserResponseSchema.safeParse({ ...valid, organizations: [organization, group] }).success).toBe(true);
  });

  it("accepts an empty organizations list, since the one-organization invariant is the database's", () => {
    const result = CurrentUserResponseSchema.safeParse({ ...valid, organizations: [] });
    expect(result.success).toBe(true);
  });

  it("rejects extra keys", () => {
    const result = CurrentUserResponseSchema.safeParse({ ...valid, sessionId: "x" });
    expect(result.success).toBe(false);
  });
});

describe("SwitchOrganizationRequestSchema", () => {
  it("accepts an organization id", () => {
    expect(SwitchOrganizationRequestSchema.safeParse({ organizationId: organization.id }).success).toBe(true);
  });

  it("rejects an id that is not a UUID, a missing id and extra keys", () => {
    expect(SwitchOrganizationRequestSchema.safeParse({ organizationId: "42" }).success).toBe(false);
    expect(SwitchOrganizationRequestSchema.safeParse({}).success).toBe(false);
    expect(
      SwitchOrganizationRequestSchema.safeParse({ organizationId: organization.id, role: "admin" }).success,
    ).toBe(false);
  });
});

describe("SwitchOrganizationResponseSchema", () => {
  it("accepts the organization with its type and the user's role", () => {
    expect(SwitchOrganizationResponseSchema.safeParse({ organization }).success).toBe(true);
  });

  it("rejects the organization without its role", () => {
    const { role: _omitted, ...withoutRole } = organization;
    expect(SwitchOrganizationResponseSchema.safeParse({ organization: withoutRole }).success).toBe(false);
  });
});

describe("ActiveOrganizationSchema's logoId", () => {
  it("is required: a logo's id or null", () => {
    const { logoId: _omitted, ...withoutLogo } = organization;
    expect(SwitchOrganizationResponseSchema.safeParse({ organization: withoutLogo }).success).toBe(false);
    expect(
      SwitchOrganizationResponseSchema.safeParse({
        organization: { ...organization, logoId: "0199e000-0000-7000-8000-000000000001" },
      }).success,
    ).toBe(true);
  });

  it("is an id, never a URL or anything else", () => {
    for (const logoId of ["https://example.com/logo.png", "/api/v1/organization-logos/x/y", "", 42]) {
      expect(SwitchOrganizationResponseSchema.safeParse({ organization: { ...organization, logoId } }).success).toBe(
        false,
      );
    }
  });
});

describe("CSRF header", () => {
  it("is x-telflo-csrf: 1", () => {
    expect(CSRF_HEADER_NAME).toBe("x-telflo-csrf");
    expect(CSRF_HEADER_VALUE).toBe("1");
  });
});

describe("SESSION_ERROR_CODES", () => {
  it("lists the six session error codes", () => {
    expect(SESSION_ERROR_CODES).toEqual([
      "invalid_credentials",
      "email_not_verified",
      "unauthenticated",
      "access_token_expired",
      "csrf_header_missing",
      "rate_limited",
    ]);
  });

  it("derives a union type, so a misspelled code does not type-check", () => {
    expectTypeOf<"unauthenticated">().toMatchTypeOf<SessionErrorCode>();
    expectTypeOf<"unauthenticted">().not.toMatchTypeOf<SessionErrorCode>();
  });
});

describe("OidcProvidersResponseSchema", () => {
  it("accepts a list of providers", () => {
    const body = { providers: [{ id: "google", name: "Google" }] };
    expect(OidcProvidersResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts an empty list, when no provider is configured", () => {
    expect(OidcProvidersResponseSchema.safeParse({ providers: [] }).success).toBe(true);
  });

  it("rejects a provider without an id or a name, or with an empty one", () => {
    expect(OidcProvidersResponseSchema.safeParse({ providers: [{ name: "Google" }] }).success).toBe(false);
    expect(OidcProvidersResponseSchema.safeParse({ providers: [{ id: "google" }] }).success).toBe(false);
    expect(OidcProvidersResponseSchema.safeParse({ providers: [{ id: "", name: "Google" }] }).success).toBe(false);
  });

  it("rejects a missing list", () => {
    expect(OidcProvidersResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown properties on the response and on a provider, so no secret can ride along", () => {
    expect(
      OidcProvidersResponseSchema.safeParse({ providers: [], issuer: "https://accounts.google.com" }).success,
    ).toBe(false);
    expect(
      OidcProvidersResponseSchema.safeParse({
        providers: [{ id: "google", name: "Google", clientSecret: "secret" }],
      }).success,
    ).toBe(false);
  });
});

describe("OIDC_QUERY_ERROR_CODES", () => {
  it("lists the four codes a federated sign-in reports in the login URL, registration_not_open among them", () => {
    expect(OIDC_QUERY_ERROR_CODES).toEqual([
      "oauth_failed",
      "oauth_email_unverified",
      "oauth_email_reserved",
      "registration_not_open",
    ]);
  });

  it("derives a union type, so a misspelled code does not type-check", () => {
    expectTypeOf<"oauth_failed">().toMatchTypeOf<OidcQueryErrorCode>();
    expectTypeOf<"oauth_faild">().not.toMatchTypeOf<OidcQueryErrorCode>();
  });
});

describe("OIDC_LINK_RESULT_CODES", () => {
  it("lists the five codes a link from Settings reports in the account page's URL", () => {
    expect(OIDC_LINK_RESULT_CODES).toEqual([
      "linked",
      "identity_in_use",
      "identity_exists",
      "email_unverified",
      "link_failed",
    ]);
  });

  it("derives a union type, so a misspelled code does not type-check", () => {
    expectTypeOf<"link_failed">().toMatchTypeOf<OidcLinkResultCode>();
    expectTypeOf<"link_faild">().not.toMatchTypeOf<OidcLinkResultCode>();
  });
});
