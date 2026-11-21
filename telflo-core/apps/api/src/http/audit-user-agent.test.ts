import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { auditUserAgent } from "./audit-user-agent.js";

/*
 * The User-Agent as the platform stores it: "[redacted]" when it may hold a
 * tf_, tll_ or tqd_ credential in any spelling the request log recognizes;
 * otherwise as sent. Credentials are built at run time and compared as
 * booleans.
 */

const requestWith = (userAgent: string | undefined) =>
  ({ headers: userAgent === undefined ? {} : { "user-agent": userAgent } }) as unknown as FastifyRequest;

const body = () => randomBytes(32).toString("base64url");

describe("auditUserAgent", () => {
  it.each([
    ["a tf_ token", () => `ci-runner tf_${body()}`],
    ["a tf_ token in upper case", () => `ci-runner TF_${body()}`],
    ["a tf_ token with its t encoded", () => `ci-runner %74f_${body()}`],
    ["a tf_ token with its _ encoded", () => `ci-runner tf%5F${body()}`],
    ["a library link", () => `fetch https://x/api/v1/library-links/tll_${body()}`],
    ["a quick-deploy secret", () => `curl tqd_${body()}`],
  ])("redacts one holding %s", (_label, make) => {
    const userAgent = make();
    const stored = auditUserAgent(requestWith(userAgent));
    expect(stored === "[redacted]").toBe(true);
    expect(stored?.includes(userAgent.slice(-20))).toBe(false);
  });

  it("keeps an ordinary one as sent, and an absent one absent", () => {
    const ordinary = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 tf-cli/1.2 t_f";
    expect(auditUserAgent(requestWith(ordinary))).toBe(ordinary);
    expect(auditUserAgent(requestWith(undefined))).toBeUndefined();
  });
});
