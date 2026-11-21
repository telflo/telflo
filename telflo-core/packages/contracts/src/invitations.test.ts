import { describe, expect, it } from "vitest";
import {
  CreateInvitationRequestSchema,
  INVITATION_ALREADY_ACCEPTED_MESSAGE,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_TTL_DAYS,
  invitationEmailMismatchMessage,
  InvitationPreviewResponseSchema,
  InvitationRegistrationRequestSchema,
  InvitationResponseSchema,
  InvitationSchema,
  InvitationsResponseSchema,
  InvitationTokenRequestSchema,
  JoinedOrganizationResponseSchema,
} from "./invitations.js";
import { PASSWORD_MINIMUM_LENGTH } from "./identity.js";

describe("INVITATION_TTL_DAYS", () => {
  it("is seven days", () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});

describe("the invitee's messages", () => {
  it("are the invalid and expired texts, the accepted one, and the mismatch naming the address", () => {
    expect(INVITATION_NOT_FOUND_MESSAGE).toBe(
      "Invalid or expired invite link. Please ask your admin to resend the invitation.",
    );
    expect(INVITATION_EXPIRED_MESSAGE).toBe(
      "This invitation link has expired. Please ask your admin to resend the invitation.",
    );
    expect(INVITATION_ALREADY_ACCEPTED_MESSAGE).toBe("This invitation has already been accepted.");
    expect(invitationEmailMismatchMessage("invitee@example.com")).toBe(
      "This invitation was sent to invitee@example.com. Sign in with that address to accept it.",
    );
  });
});

describe("CreateInvitationRequestSchema", () => {
  it("trims and lowercases the address, and accepts each of the two roles", () => {
    for (const role of ["admin", "contributor"]) {
      expect(CreateInvitationRequestSchema.parse({ email: "  New.Person@Example.COM ", role })).toEqual({
        email: "new.person@example.com",
        role,
      });
    }
  });

  it("refuses viewer, which is not a role", () => {
    expect(CreateInvitationRequestSchema.safeParse({ email: "someone@example.com", role: "viewer" }).success).toBe(false);
  });

  it("refuses a malformed or too long address, a missing or unknown role, and extra keys", () => {
    const valid = { email: "someone@example.com", role: "contributor" };
    expect(CreateInvitationRequestSchema.safeParse({ ...valid, email: "not-an-address" }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ ...valid, email: `${"a".repeat(250)}@example.com` }).success).toBe(
      false,
    );
    expect(CreateInvitationRequestSchema.safeParse({ email: valid.email }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ ...valid, role: "org_admin" }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ ...valid, organizationId: "x" }).success).toBe(false);
  });
});

describe("InvitationSchema", () => {
  const invitation = {
    id: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a",
    email: "someone@example.com",
    role: "contributor",
    invitedAt: "2026-09-27T12:00:00.000Z",
    expiresAt: "2026-10-04T12:00:00.000Z",
    isExpired: false,
  };

  it("accepts an invitation, alone, in a response and in a list", () => {
    expect(InvitationSchema.safeParse(invitation).success).toBe(true);
    expect(InvitationResponseSchema.safeParse({ invitation }).success).toBe(true);
    expect(
      InvitationsResponseSchema.safeParse({ items: [invitation, { ...invitation, isExpired: true }] }).success,
    ).toBe(true);
    expect(InvitationsResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("refuses a non-ISO date, a missing flag, a non-UUID id, a token and a nextCursor", () => {
    const { isExpired: _omitted, ...withoutFlag } = invitation;
    expect(InvitationSchema.safeParse({ ...invitation, expiresAt: "next week" }).success).toBe(false);
    expect(InvitationSchema.safeParse(withoutFlag).success).toBe(false);
    expect(InvitationSchema.safeParse({ ...invitation, id: "42" }).success).toBe(false);
    expect(InvitationSchema.safeParse({ ...invitation, tokenHash: "ab" }).success).toBe(false);
    expect(InvitationsResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false);
  });
});

describe("InvitationTokenRequestSchema", () => {
  it("accepts a token of 1 to 512 characters", () => {
    expect(InvitationTokenRequestSchema.safeParse({ token: "a" }).success).toBe(true);
    expect(InvitationTokenRequestSchema.safeParse({ token: "a".repeat(512) }).success).toBe(true);
  });

  it("refuses an empty token, one over 512 characters, a missing one and extra keys", () => {
    expect(InvitationTokenRequestSchema.safeParse({ token: "" }).success).toBe(false);
    expect(InvitationTokenRequestSchema.safeParse({ token: "a".repeat(513) }).success).toBe(false);
    expect(InvitationTokenRequestSchema.safeParse({}).success).toBe(false);
    expect(InvitationTokenRequestSchema.safeParse({ token: "a", email: "someone@example.com" }).success).toBe(false);
  });
});

describe("InvitationPreviewResponseSchema", () => {
  const preview = {
    organizationName: "Acme",
    organizationType: "group",
    email: "someone@example.com",
    role: "contributor",
    status: "pending",
    hasAccount: false,
    mayRegister: true,
  };

  it.each(["pending", "expired", "accepted"])("accepts the %s status", (status) => {
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, status } }).success).toBe(true);
  });

  it("requires mayRegister, as a boolean", () => {
    const { mayRegister: _omitted, ...withoutMayRegister } = preview;
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: withoutMayRegister }).success).toBe(false);
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, mayRegister: "false" } }).success).toBe(false);
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, mayRegister: false } }).success).toBe(true);
  });

  it("requires organizationType, personal or group", () => {
    const { organizationType: _omitted, ...withoutType } = preview;
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: withoutType }).success).toBe(false);
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, organizationType: "team" } }).success).toBe(false);
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, organizationType: "personal" } }).success).toBe(true);
  });

  it("refuses a revoked status, a missing hasAccount and extra keys", () => {
    const { hasAccount: _omitted, ...withoutAccount } = preview;
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, status: "revoked" } }).success).toBe(
      false,
    );
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: withoutAccount }).success).toBe(false);
    expect(InvitationPreviewResponseSchema.safeParse({ invitation: { ...preview, organizationId: "x" } }).success).toBe(
      false,
    );
  });
});

describe("InvitationRegistrationRequestSchema", () => {
  const valid = {
    token: "a-token",
    password: "p".repeat(PASSWORD_MINIMUM_LENGTH),
    acceptedTermsVersion: "2026-01-01",
  };

  it("accepts a token, registration's password and the terms version, the password untrimmed", () => {
    const password = ` ${"p".repeat(PASSWORD_MINIMUM_LENGTH)} `;
    expect(InvitationRegistrationRequestSchema.parse({ ...valid, password })).toEqual({ ...valid, password });
  });

  it("takes no terms version, as registration does: a site without Terms sends none", () => {
    const { acceptedTermsVersion: _omitted, ...withoutTerms } = valid;
    expect(InvitationRegistrationRequestSchema.parse(withoutTerms)).toEqual(withoutTerms);
    expect(InvitationRegistrationRequestSchema.safeParse({ ...valid, acceptedTermsVersion: "" }).success).toBe(false);
  });

  it("refuses a short password, a token over 512 characters and an email", () => {
    expect(
      InvitationRegistrationRequestSchema.safeParse({ ...valid, password: "p".repeat(PASSWORD_MINIMUM_LENGTH - 1) })
        .success,
    ).toBe(false);
    expect(InvitationRegistrationRequestSchema.safeParse({ ...valid, token: "a".repeat(513) }).success).toBe(false);
    // The address is the invitation's: one sent in the body is refused, not ignored.
    expect(InvitationRegistrationRequestSchema.safeParse({ ...valid, email: "someone@example.com" }).success).toBe(
      false,
    );
  });
});

describe("JoinedOrganizationResponseSchema", () => {
  const organization = {
    id: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a",
    name: "Acme",
    type: "group",
    logoId: null,
    role: "contributor",
  };

  it("is a switch's answer: the organization with its type, its logo's id and the member's role", () => {
    expect(JoinedOrganizationResponseSchema.safeParse({ organization }).success).toBe(true);
    const { role: _omitted, ...withoutRole } = organization;
    expect(JoinedOrganizationResponseSchema.safeParse({ organization: withoutRole }).success).toBe(false);
    const { logoId: _logo, ...withoutLogo } = organization;
    expect(JoinedOrganizationResponseSchema.safeParse({ organization: withoutLogo }).success).toBe(false);
    expect(JoinedOrganizationResponseSchema.safeParse({ organization, invitation: {} }).success).toBe(false);
  });
});
