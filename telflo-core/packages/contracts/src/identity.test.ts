import { describe, expect, it } from "vitest";
import {
  AcceptedResponseSchema,
  EMAIL_RESERVED_MESSAGE,
  IDENTITY_ERROR_CODES,
  PASSWORD_MINIMUM_LENGTH,
  PasswordResetRequestSchema,
  PasswordResetSchema,
  RegisterRequestSchema,
  TermsAcceptanceRequestSchema,
  VerificationEmailRequestSchema,
  VerifyEmailRequestSchema,
} from "./identity.js";

const valid = {
  email: "person@example.com",
  password: "a-sufficiently-long-password",
  acceptedTermsVersion: "2026-01-01",
};

describe("RegisterRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(RegisterRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(RegisterRequestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects an email longer than the 254-character RFC limit", () => {
    const email = `${"a".repeat(250)}@example.com`;
    expect(RegisterRequestSchema.safeParse({ ...valid, email }).success).toBe(false);
  });

  it("trims and lowercases the email", () => {
    const parsed = RegisterRequestSchema.parse({ ...valid, email: "  Person@Example.COM  " });
    expect(parsed.email).toBe("person@example.com");
  });

  it("applies the length limit after trimming, not before", () => {
    const address = `${"a".repeat(240)}@example.com`; // 252 characters
    const padded = `   ${address}   `; // 258 before trimming
    const parsed = RegisterRequestSchema.safeParse({ ...valid, email: padded });
    expect(parsed.success).toBe(true);
  });

  it(`rejects a password shorter than ${PASSWORD_MINIMUM_LENGTH} characters`, () => {
    const password = "a".repeat(PASSWORD_MINIMUM_LENGTH - 1);
    expect(RegisterRequestSchema.safeParse({ ...valid, password }).success).toBe(false);
  });

  it(`accepts a password of exactly ${PASSWORD_MINIMUM_LENGTH} characters`, () => {
    const password = "a".repeat(PASSWORD_MINIMUM_LENGTH);
    expect(RegisterRequestSchema.safeParse({ ...valid, password }).success).toBe(true);
  });

  it("accepts a password of exactly 128 characters", () => {
    expect(RegisterRequestSchema.safeParse({ ...valid, password: "a".repeat(128) }).success).toBe(true);
  });

  it("rejects a password longer than 128 characters", () => {
    // Bounded so an enormous body cannot be turned into an Argon2id
    // denial-of-service by making every hash arbitrarily expensive.
    expect(
      RegisterRequestSchema.safeParse({ ...valid, password: "a".repeat(129) }).success,
    ).toBe(false);
  });

  it("does not trim the password, because spaces are legitimate characters", () => {
    const password = "  padded password  ";
    expect(RegisterRequestSchema.parse({ ...valid, password }).password).toBe(password);
  });

  it("refuses an empty or over-long accepted terms version, and takes none (D36-1 decision 29: a site without Terms sends none)", () => {
    expect(
      RegisterRequestSchema.safeParse({ ...valid, acceptedTermsVersion: "" }).success,
    ).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...valid, acceptedTermsVersion: "a".repeat(33) }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...valid, acceptedTermsVersion: "a".repeat(32) }).success).toBe(true);
    const { acceptedTermsVersion: _omitted, ...withoutTerms } = valid;
    expect(RegisterRequestSchema.parse(withoutTerms)).toEqual(withoutTerms);
    expect("acceptedTermsVersion" in RegisterRequestSchema.parse(withoutTerms)).toBe(false);
  });

  it("rejects unknown properties rather than silently ignoring them", () => {
    expect(
      RegisterRequestSchema.safeParse({ ...valid, isAdministrator: true }).success,
    ).toBe(false);
  });
});

describe("VerifyEmailRequestSchema", () => {
  it("accepts a token", () => {
    expect(VerifyEmailRequestSchema.safeParse({ token: "abc123" }).success).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(VerifyEmailRequestSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects an absurdly long token, which cannot be one we issued", () => {
    expect(VerifyEmailRequestSchema.safeParse({ token: "a".repeat(513) }).success).toBe(false);
  });
});

// The two email endpoints take the same body, so they share these cases.
describe.each([
  ["PasswordResetRequestSchema", PasswordResetRequestSchema],
  ["VerificationEmailRequestSchema", VerificationEmailRequestSchema],
])("%s", (_name, schema) => {
  it("accepts an email address, trimmed and lowercased", () => {
    expect(schema.parse({ email: "  Person@Example.COM " })).toEqual({ email: "person@example.com" });
  });

  it("rejects a malformed email", () => {
    expect(schema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(schema.safeParse({ email: "person@example.com", redirectTo: "/app" }).success).toBe(false);
  });
});

describe("PasswordResetSchema", () => {
  const reset = { token: "abc123", password: "a-sufficiently-long-password" };

  it("accepts a token and a password", () => {
    expect(PasswordResetSchema.safeParse(reset).success).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(PasswordResetSchema.safeParse({ ...reset, token: "" }).success).toBe(false);
  });

  it("accepts a 512-character token and rejects a 513-character one", () => {
    expect(PasswordResetSchema.safeParse({ ...reset, token: "a".repeat(512) }).success).toBe(true);
    expect(PasswordResetSchema.safeParse({ ...reset, token: "a".repeat(513) }).success).toBe(false);
  });

  it(`rejects a password of ${PASSWORD_MINIMUM_LENGTH - 1} characters and accepts one of ${PASSWORD_MINIMUM_LENGTH}`, () => {
    const short = "a".repeat(PASSWORD_MINIMUM_LENGTH - 1);
    expect(PasswordResetSchema.safeParse({ ...reset, password: short }).success).toBe(false);
    expect(PasswordResetSchema.safeParse({ ...reset, password: `${short}a` }).success).toBe(true);
  });

  it("accepts a password of 128 characters and rejects one of 129", () => {
    expect(PasswordResetSchema.safeParse({ ...reset, password: "a".repeat(128) }).success).toBe(true);
    expect(PasswordResetSchema.safeParse({ ...reset, password: "a".repeat(129) }).success).toBe(false);
  });

  it("does not trim the password", () => {
    const password = "  padded password  ";
    expect(PasswordResetSchema.parse({ ...reset, password }).password).toBe(password);
  });

  it("rejects a missing token or password", () => {
    expect(PasswordResetSchema.safeParse({ password: reset.password }).success).toBe(false);
    expect(PasswordResetSchema.safeParse({ token: reset.token }).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(PasswordResetSchema.safeParse({ ...reset, confirmPassword: reset.password }).success).toBe(false);
  });
});

describe("AcceptedResponseSchema", () => {
  it("accepts exactly { status: 'accepted' }", () => {
    expect(AcceptedResponseSchema.safeParse({ status: "accepted" }).success).toBe(true);
  });

  it("rejects another status", () => {
    expect(AcceptedResponseSchema.safeParse({ status: "sent" }).success).toBe(false);
  });

  it("rejects unknown properties, which could say whether an account exists", () => {
    expect(AcceptedResponseSchema.safeParse({ status: "accepted", sent: true }).success).toBe(false);
  });
});

describe("TermsAcceptanceRequestSchema", () => {
  it("accepts a version (the API compares it with its setting)", () => {
    expect(TermsAcceptanceRequestSchema.parse({ version: "2026-01-01" })).toEqual({ version: "2026-01-01" });
  });

  it("accepts another well-formed version, which the endpoint refuses as not current", () => {
    expect(TermsAcceptanceRequestSchema.safeParse({ version: "2025-01-01" }).success).toBe(true);
  });

  it("rejects an empty, missing or non-string version", () => {
    expect(TermsAcceptanceRequestSchema.safeParse({ version: "" }).success).toBe(false);
    expect(TermsAcceptanceRequestSchema.safeParse({}).success).toBe(false);
    expect(TermsAcceptanceRequestSchema.safeParse({ version: 20260101 }).success).toBe(false);
  });

  it("rejects a version longer than 32 characters, as registration does", () => {
    expect(TermsAcceptanceRequestSchema.safeParse({ version: "a".repeat(32) }).success).toBe(true);
    expect(TermsAcceptanceRequestSchema.safeParse({ version: "a".repeat(33) }).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(
      TermsAcceptanceRequestSchema.safeParse({ version: "2026-01-01", accepted: true }).success,
    ).toBe(false);
  });
});

describe("IDENTITY_ERROR_CODES", () => {
  it("names the verification and reset link codes, the stale terms version, the data endpoints' terms refusal, product administration's refusal, and the reserved domain's refusal", () => {
    expect(IDENTITY_ERROR_CODES).toEqual([
      "invalid_verification_token",
      "invalid_reset_token",
      "terms_version_not_current",
      "terms_acceptance_required",
      "product_admin_required",
      "email_reserved",
    ]);
  });

  it("the reserved domain's refusal says the spec's words, which name no address (D22 decision 23)", () => {
    expect(EMAIL_RESERVED_MESSAGE).toBe("This address can't be used");
  });
});
