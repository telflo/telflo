import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChangeMemberRoleRequestSchema,
  ChangeOrganizationRequestSchema,
  CreateOrganizationRequestSchema,
  MembersResponseSchema,
  MemberSchema,
  ORGANIZATION_ERROR_CODES,
  ORGANIZATION_PART_NAMES,
  OrganizationNameSchema,
  OrganizationResponseSchema,
  OrganizationRoleSchema,
  OrganizationSettingsSchema,
  mayInviteFrom,
  type OrganizationErrorCode,
} from "./organizations.js";
import { REGISTRATION_MODES } from "./site.js";

describe("OrganizationRoleSchema", () => {
  it("is admin and contributor only: viewer is retired (D7 decision 2)", () => {
    expect(OrganizationRoleSchema.options).toEqual(["admin", "contributor"]);
    expect(OrganizationRoleSchema.safeParse("viewer").success).toBe(false);
  });
});

describe("OrganizationNameSchema", () => {
  it("trims the name", () => {
    expect(OrganizationNameSchema.parse("  Acme Corp  ")).toBe("Acme Corp");
  });

  it("accepts 1 and 100 characters", () => {
    expect(OrganizationNameSchema.safeParse("a").success).toBe(true);
    expect(OrganizationNameSchema.safeParse("a".repeat(100)).success).toBe(true);
  });

  it("rejects 101 characters", () => {
    expect(OrganizationNameSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("counts the length after trimming", () => {
    expect(OrganizationNameSchema.safeParse(`  ${"a".repeat(100)}  `).success).toBe(true);
  });

  it.each([
    ["an empty name", ""],
    ["a whitespace-only name", "   \t "],
  ])("rejects %s with the empty-name message", (_label, name) => {
    const result = OrganizationNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Organization name is required");
  });
});

describe.each([
  ["CreateOrganizationRequestSchema", CreateOrganizationRequestSchema],
  ["ChangeOrganizationRequestSchema", ChangeOrganizationRequestSchema],
] as const)("%s", (_name, schema) => {
  it("accepts a name, trimmed", () => {
    expect(schema.parse({ name: " Acme " })).toEqual({ name: "Acme" });
  });

  it("rejects a missing, empty, whitespace-only, too long or non-string name", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: "" }).success).toBe(false);
    expect(schema.safeParse({ name: "  " }).success).toBe(false);
    expect(schema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
    expect(schema.safeParse({ name: 42 }).success).toBe(false);
  });

  it("rejects extra keys, so no logo or owner can ride along", () => {
    expect(schema.safeParse({ name: "Acme", logoUrl: "https://example.com/logo.png" }).success).toBe(false);
  });
});

describe("ChangeOrganizationRequestSchema (D23-2 decisions 9 and 33)", () => {
  it("accepts removeLogo: true beside the name", () => {
    expect(ChangeOrganizationRequestSchema.parse({ name: " Acme ", removeLogo: true })).toEqual({
      name: "Acme",
      removeLogo: true,
    });
  });

  it("refuses removeLogo as anything but true, and a logo riding along", () => {
    for (const removeLogo of [false, "true", 1, null]) {
      expect(ChangeOrganizationRequestSchema.safeParse({ name: "Acme", removeLogo }).success).toBe(false);
    }
    expect(ChangeOrganizationRequestSchema.safeParse({ name: "Acme", logoId: null }).success).toBe(false);
    expect(ChangeOrganizationRequestSchema.safeParse({ name: "Acme", file: "x" }).success).toBe(false);
  });
});

describe("ORGANIZATION_PART_NAMES", () => {
  it("is the name, then the file, last (D23-2 decision 33)", () => {
    expect(ORGANIZATION_PART_NAMES).toEqual(["name", "file"]);
  });
});

describe("OrganizationResponseSchema", () => {
  const organization = { id: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a", name: "Acme", type: "group", logoId: null };

  it("accepts an organization with its type", () => {
    expect(OrganizationResponseSchema.safeParse({ organization }).success).toBe(true);
  });

  it("requires logoId (D23-2 decision 13): a logo's id or null, never a URL", () => {
    const { logoId: _omitted, ...withoutLogo } = organization;
    expect(OrganizationResponseSchema.safeParse({ organization: withoutLogo }).success).toBe(false);
    expect(
      OrganizationResponseSchema.safeParse({
        organization: { ...organization, logoId: "0199e000-0000-7000-8000-000000000001" },
      }).success,
    ).toBe(true);
    for (const logoId of ["https://example.com/logo.png", "", 42]) {
      expect(OrganizationResponseSchema.safeParse({ organization: { ...organization, logoId } }).success).toBe(false);
    }
  });

  it("rejects an unknown type, a missing type, a non-UUID id and extra keys", () => {
    const { type: _omitted, ...withoutType } = organization;
    expect(OrganizationResponseSchema.safeParse({ organization: { ...organization, type: "team" } }).success).toBe(
      false,
    );
    expect(OrganizationResponseSchema.safeParse({ organization: withoutType }).success).toBe(false);
    expect(OrganizationResponseSchema.safeParse({ organization: { ...organization, id: "42" } }).success).toBe(false);
    expect(
      OrganizationResponseSchema.safeParse({ organization: { ...organization, ownerUserId: null } }).success,
    ).toBe(false);
  });
});

describe("MemberSchema", () => {
  const member = {
    userId: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a",
    email: "member@example.com",
    role: "contributor",
    isOrganizationOwner: false,
    createdAt: "2026-09-26T12:00:00.000Z",
    deletedAt: null,
  };

  it("accepts an active member and a removed one", () => {
    expect(MemberSchema.safeParse(member).success).toBe(true);
    expect(MemberSchema.safeParse({ ...member, deletedAt: "2026-09-27T08:30:00.000Z" }).success).toBe(true);
  });

  it("accepts each of the two roles and marks the personal organization's owner", () => {
    for (const role of ["admin", "contributor"]) {
      expect(MemberSchema.safeParse({ ...member, role }).success).toBe(true);
    }
    expect(MemberSchema.safeParse({ ...member, isOrganizationOwner: true }).success).toBe(true);
  });

  it("rejects an unknown role, a missing owner flag, a non-ISO date, a non-UUID id and extra keys", () => {
    const { isOrganizationOwner: _omitted, ...withoutOwnerFlag } = member;
    expect(MemberSchema.safeParse({ ...member, role: "org_admin" }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...member, role: "viewer" }).success).toBe(false);
    expect(MemberSchema.safeParse(withoutOwnerFlag).success).toBe(false);
    expect(MemberSchema.safeParse({ ...member, createdAt: "yesterday" }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...member, deletedAt: undefined }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...member, userId: "42" }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...member, status: "active" }).success).toBe(false);
  });

  it("is listed as { items } with no nextCursor (decision 7)", () => {
    expect(MembersResponseSchema.safeParse({ items: [member] }).success).toBe(true);
    expect(MembersResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(MembersResponseSchema.safeParse({ items: [member], nextCursor: null }).success).toBe(false);
  });
});

describe("ChangeMemberRoleRequestSchema", () => {
  it.each(["admin", "contributor"])("accepts %s", (role) => {
    expect(ChangeMemberRoleRequestSchema.parse({ role })).toEqual({ role });
  });

  it("refuses viewer, which is retired (D7 decision 2)", () => {
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "viewer" }).success).toBe(false);
  });

  it("rejects a missing or unknown role, prefixed role names, and extra keys", () => {
    expect(ChangeMemberRoleRequestSchema.safeParse({}).success).toBe(false);
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "org_contributor" }).success).toBe(false);
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "contributor", userId: "x" }).success).toBe(false);
  });
});

describe("ORGANIZATION_ERROR_CODES", () => {
  it("lists every code of D5 decisions 7, 8 and 10, of D6 decisions 8 and 9, D22 decision 30's, D23-2 decision 34's and D36-1 decisions 51's and 57's", () => {
    expect(ORGANIZATION_ERROR_CODES).toEqual([
      "organization_not_found",
      "organization_name_taken",
      "organization_admin_required",
      "organization_access_denied",
      "cannot_change_own_membership",
      "member_not_found",
      "member_not_active",
      "member_not_removed",
      "personal_organization_protected",
      "member_already_active",
      "member_removed",
      "invitation_already_pending",
      "invitation_not_found",
      "invitation_email_failed",
      "invitation_expired",
      "invitation_already_accepted",
      "invitation_email_mismatch",
      "account_exists",
      "member_is_service_account",
      "organization_logo_type_unsupported",
      "organization_logo_too_large",
      "organization_creation_restricted",
      "personal_organization_invitations_disabled",
    ]);
  });

  it("derives a union type, so a misspelled code does not type-check", () => {
    expectTypeOf<"organization_not_found">().toMatchTypeOf<OrganizationErrorCode>();
    expectTypeOf<"organisation_not_found">().not.toMatchTypeOf<OrganizationErrorCode>();
  });
});

// D36-1 decision 57 (Q268): a personal workspace invites only while registration is open.
describe("mayInviteFrom", () => {
  it("lets a group organization invite in every mode, and a personal one only while registration is open", () => {
    const answers = REGISTRATION_MODES.map((mode) => ({
      mode,
      group: mayInviteFrom(mode, "group"),
      personal: mayInviteFrom(mode, "personal"),
    }));
    expect(answers).toEqual([
      { mode: "open", group: true, personal: true },
      { mode: "invite-only", group: true, personal: false },
      { mode: "closed", group: true, personal: false },
    ]);
  });
});

// D17d-2 decision 20, Preflight ruling 15: the "Public install links" switch, the GET's reply and the PATCH's body.
describe("OrganizationSettingsSchema", () => {
  it("is publicInstallLinks, a boolean", () => {
    expect(OrganizationSettingsSchema.parse({ publicInstallLinks: true })).toEqual({ publicInstallLinks: true });
    expect(OrganizationSettingsSchema.parse({ publicInstallLinks: false })).toEqual({ publicInstallLinks: false });
  });

  it.each([
    ["nothing", {}],
    ["a string", { publicInstallLinks: "false" }],
    ["null", { publicInstallLinks: null }],
    ["an unknown setting", { publicInstallLinks: true, quickDeploy: true }],
  ])("refuses %s", (_label, body) => {
    expect(OrganizationSettingsSchema.safeParse(body).success).toBe(false);
  });
});
