import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";
import {
  AcknowledgeFeedbackRequestSchema,
  AdminUserBlockSchema,
  AdminUserSchema,
  AdminUsersPageSchema,
  ChangeProductAdminSettingsRequestSchema,
  CreateFeedbackRequestSchema,
  CreateFeedbackResponseSchema,
  FEEDBACK_ERROR_CODES,
  GrantProductAdminRequestSchema,
  ListAdminUsersQuerySchema,
  ListUserFeedbackQuerySchema,
  PendingFeedbackCountSchema,
  PRODUCT_ADMIN_ERROR_CODES,
  ProductAdminSettingsSchema,
  ProductAdminsResponseSchema,
  UserDeleteBlockedDetailsSchema,
  UserFeedbackPageSchema,
} from "./product-admin.js";

// The product-admin contracts (D29 decisions 28, 31 to 34): each schema's
// accepted and refused shapes, the bounds (the table's check: 1 to 5,000
// characters after trimming), and the error codes, unique across the
// package. Values are made-up fixtures (@example.com); nothing here is a
// person's.

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
const NOW = "2026-10-26T10:00:00.000Z";

describe("the product admins", () => {
  it("lists ids and emails, and grants by a lowercased, trimmed, valid email only", () => {
    expect(ProductAdminsResponseSchema.parse({ items: [{ id: ID, email: "a@example.com" }] })).toEqual({
      items: [{ id: ID, email: "a@example.com" }],
    });
    expect(ProductAdminsResponseSchema.safeParse({ items: [{ id: ID, email: "a@example.com", extra: 1 }] }).success).toBe(false);
    expect(GrantProductAdminRequestSchema.parse({ email: "  A@Example.COM " })).toEqual({ email: "a@example.com" });
    for (const body of [{}, { email: "" }, { email: "not an email" }, { email: "a@example.com", other: 1 }, { email: `${"a".repeat(250)}@example.com` }]) {
      expect(GrantProductAdminRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("the users", () => {
  it("takes each block kind with its own fields only, and null", () => {
    const base = { id: ID, email: "a@example.com", createdAt: NOW, isProductAdmin: false };
    for (const block of [
      null,
      { kind: "member", organizationName: "Acme", role: "contributor" },
      { kind: "owner", organizationName: "Acme" },
      { kind: "product_admin" },
    ]) {
      expect(AdminUserSchema.safeParse({ ...base, block }).success).toBe(true);
    }
    for (const block of [
      { kind: "member", organizationName: "Acme" },
      { kind: "owner", organizationName: "Acme", role: "admin" },
      { kind: "product_admin", organizationName: "Acme" },
      { kind: "other" },
    ]) {
      expect(AdminUserBlockSchema.safeParse(block).success).toBe(false);
    }
    expect(AdminUsersPageSchema.safeParse({ items: [{ ...base, block: null }], nextCursor: null }).success).toBe(true);
    expect(AdminUsersPageSchema.safeParse({ items: [], nextCursor: "abc" }).success).toBe(true);
    expect(AdminUsersPageSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("trims the search, takes 254 characters and refuses 255, bounds the cursor and refuses any other parameter", () => {
    expect(ListAdminUsersQuerySchema.parse({ q: "  acme  " })).toEqual({ q: "acme" });
    expect(ListAdminUsersQuerySchema.parse({})).toEqual({});
    expect(ListAdminUsersQuerySchema.safeParse({ q: "a".repeat(254) }).success).toBe(true);
    expect(ListAdminUsersQuerySchema.safeParse({ q: "a".repeat(255) }).success).toBe(false);
    expect(ListAdminUsersQuerySchema.safeParse({ cursor: "c".repeat(201) }).success).toBe(false);
    expect(ListAdminUsersQuerySchema.safeParse({ limit: "5" }).success).toBe(false);
  });

  it("gives a refused delete's details the kind only", () => {
    expect(UserDeleteBlockedDetailsSchema.parse({ kind: "member" })).toEqual({ kind: "member" });
    expect(UserDeleteBlockedDetailsSchema.safeParse({ kind: "member", organizationName: "Acme" }).success).toBe(false);
  });
});

describe("the feedback", () => {
  it.each([
    ["CreateFeedbackRequestSchema", CreateFeedbackRequestSchema, "text"],
    ["AcknowledgeFeedbackRequestSchema", AcknowledgeFeedbackRequestSchema, "reply"],
  ] as const)("%s trims, takes 1 to 5,000 characters, and refuses blank, longer and unstorable text", (_name, schema, field) => {
    expect(schema.parse({ [field]: "  hello  " })).toEqual({ [field]: "hello" });
    expect(schema.safeParse({ [field]: "x".repeat(5000) }).success).toBe(true);
    expect(schema.safeParse({ [field]: ` ${"x".repeat(5000)} ` }).success).toBe(true);
    for (const value of ["", "   \n\t ", "x".repeat(5001), "a\u0000b", "a\ud800b"]) {
      expect(schema.safeParse({ [field]: value }).success).toBe(false);
    }
    expect(schema.safeParse({ [field]: "hello", other: 1 }).success).toBe(false);
    // A refusal's message names no value.
    const refused = schema.safeParse({ [field]: "a\u0000b" });
    expect(refused.success === false && refused.error.issues.some((issue) => issue.message.includes("a\u0000b"))).toBe(false);
  });

  it("answers an id, a page with authorDeleted and a non-negative count; the list takes a cursor only", () => {
    expect(CreateFeedbackResponseSchema.parse({ id: ID })).toEqual({ id: ID });
    expect(
      UserFeedbackPageSchema.safeParse({
        items: [{ id: ID, email: "a@example.com", text: "Hello", createdAt: NOW, authorDeleted: false }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(PendingFeedbackCountSchema.safeParse({ count: 0 }).success).toBe(true);
    expect(PendingFeedbackCountSchema.safeParse({ count: -1 }).success).toBe(false);
    expect(PendingFeedbackCountSchema.safeParse({ count: 1.5 }).success).toBe(false);
    expect(ListUserFeedbackQuerySchema.safeParse({ cursor: "abc" }).success).toBe(true);
    expect(ListUserFeedbackQuerySchema.safeParse({ q: "abc" }).success).toBe(false);
  });
});

describe("the site's settings (D36-1 decision 51)", () => {
  it("are organizationCreation, everyone or product-admins, required, with no other key", () => {
    for (const value of ["everyone", "product-admins"]) {
      expect(ProductAdminSettingsSchema.parse({ organizationCreation: value })).toEqual({ organizationCreation: value });
      expect(ChangeProductAdminSettingsRequestSchema.parse({ organizationCreation: value })).toEqual({ organizationCreation: value });
    }
    for (const body of [{}, { organizationCreation: "product_admins" }, { organizationCreation: null }, { organizationCreation: true }, { organizationCreation: "everyone", other: 1 }]) {
      expect(ProductAdminSettingsSchema.safeParse(body).success).toBe(false);
      expect(ChangeProductAdminSettingsRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("the error codes", () => {
  it("names the product-admin and feedback codes, each unique across every list the package exports (Ruling 258's user_delete_busy included)", () => {
    expect(PRODUCT_ADMIN_ERROR_CODES).toEqual([
      "product_admin_target_not_found",
      "product_admin_not_found",
      "last_product_admin",
      "user_not_found",
      "user_delete_blocked",
      "user_delete_self",
      "user_delete_busy",
    ]);
    expect(FEEDBACK_ERROR_CODES).toEqual(["feedback_not_found", "feedback_author_deleted"]);
    const lists = Object.entries(contracts).filter(
      ([name, value]) => name.endsWith("_ERROR_CODES") && name !== "PRODUCT_ADMIN_ERROR_CODES" && name !== "FEEDBACK_ERROR_CODES" && Array.isArray(value),
    );
    expect(lists.length).toBeGreaterThan(5);
    const others = new Set(lists.flatMap(([, value]) => value as string[]));
    for (const code of [...PRODUCT_ADMIN_ERROR_CODES, ...FEEDBACK_ERROR_CODES]) expect({ code, taken: others.has(code) }).toEqual({ code, taken: false });
    expect(contracts.IDENTITY_ERROR_CODES).toContain("product_admin_required");
  });
});
