import { describe, expect, it } from "vitest";
import { SALES_INQUIRY_ERROR_CODES, SalesInquiryRequestSchema } from "./sales-inquiries.js";

const valid = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  message: "We run about 400 collectors.",
};

const accepts = (overrides: Record<string, unknown>) =>
  SalesInquiryRequestSchema.safeParse({ ...valid, ...overrides }).success;

describe("SalesInquiryRequestSchema", () => {
  it("accepts a well-formed inquiry, with or without the honeypot", () => {
    expect(SalesInquiryRequestSchema.safeParse(valid).success).toBe(true);
    expect(accepts({ website: "" })).toBe(true);
  });

  it("trims every value, and lowercases the email", () => {
    expect(
      SalesInquiryRequestSchema.parse({
        name: "  Ada Lovelace ",
        email: "  Ada@Example.COM ",
        message: "\n We run about 400 collectors.\n\n",
        website: "  ",
      }),
    ).toEqual({ ...valid, website: "" });
  });

  it("accepts a name of 200 characters and refuses 201", () => {
    expect(accepts({ name: "a".repeat(200) })).toBe(true);
    expect(accepts({ name: "a".repeat(201) })).toBe(false);
  });

  it("accepts a message of 5000 characters and refuses 5001", () => {
    expect(accepts({ message: "a".repeat(5000) })).toBe(true);
    expect(accepts({ message: "a".repeat(5001) })).toBe(false);
  });

  it("accepts an email of 254 characters and refuses 255 (the contract's email)", () => {
    const address = (length: number) => `${"a".repeat(length - "@example.com".length)}@example.com`;
    expect(accepts({ email: address(254) })).toBe(true);
    expect(accepts({ email: address(255) })).toBe(false);
  });

  it("accepts a honeypot of 200 characters and refuses 201", () => {
    expect(accepts({ website: "a".repeat(200) })).toBe(true);
    expect(accepts({ website: "a".repeat(201) })).toBe(false);
  });

  it("counts the lengths after trimming", () => {
    expect(accepts({ name: `  ${"a".repeat(200)}  `, message: ` ${"a".repeat(5000)} ` })).toBe(true);
  });

  it.each(["name", "email", "message"])("requires %s", (field) => {
    const { [field as keyof typeof valid]: _omitted, ...rest } = valid;
    expect(SalesInquiryRequestSchema.safeParse(rest).success).toBe(false);
  });

  it.each(["name", "message"])("refuses an empty or whitespace-only %s", (field) => {
    expect(accepts({ [field]: "" })).toBe(false);
    expect(accepts({ [field]: " \n\t " })).toBe(false);
  });

  it("refuses a malformed email", () => {
    expect(accepts({ email: "not-an-email" })).toBe(false);
  });

  it("refuses an extra key", () => {
    expect(accepts({ company: "Acme" })).toBe(false);
  });
});

describe("SALES_INQUIRY_ERROR_CODES", () => {
  it("names the failed send", () => {
    expect(SALES_INQUIRY_ERROR_CODES).toEqual(["sales_inquiry_failed"]);
  });
});
