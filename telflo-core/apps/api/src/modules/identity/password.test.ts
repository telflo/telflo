import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword", () => {
  it("produces an argon2id hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("produces a different hash each time, because the salt is random", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same password"),
      hashPassword("same password"),
    ]);
    expect(first).not.toBe(second);
  });

  it("never includes the plaintext in the hash", async () => {
    const hash = await hashPassword("unmistakable-plaintext");
    expect(hash).not.toContain("unmistakable-plaintext");
  });

  it("handles passwords at the 128-character contract maximum", async () => {
    const hash = await hashPassword("a".repeat(128));
    expect(await verifyPassword(hash, "a".repeat(128))).toBe(true);
  });

  it("handles non-ascii passwords without corrupting them", async () => {
    const password = "пароль-パスワード-🔐";
    const hash = await hashPassword(password);
    expect(await verifyPassword(hash, password)).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the correct password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword(hash, "right")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("rejects a password differing only in case", async () => {
    const hash = await hashPassword("CaseSensitive");
    expect(await verifyPassword(hash, "casesensitive")).toBe(false);
  });

  it("rejects an empty password against a real hash", async () => {
    const hash = await hashPassword("something");
    expect(await verifyPassword(hash, "")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    // A corrupted or truncated column value must not crash a login attempt.
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("returns false rather than throwing on an empty hash", async () => {
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});
