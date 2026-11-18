import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QUICK_DEPLOY_SECRET_PATTERN, QUICK_DEPLOY_URL_PATTERN } from "@telflo/contracts";
import { generateQuickDeploySecret, quickDeployLinkUrl, quickDeploySecretHash } from "./secret.js";

describe("a quick-deploy link's secret (decision 23)", () => {
  it("is tqd_ and 32 random bytes in base64url, its hash the sha-256 of the whole secret", () => {
    const { secret, secretHash } = generateQuickDeploySecret();
    expect(secret).toMatch(QUICK_DEPLOY_SECRET_PATTERN);
    expect(Buffer.from(secret.slice(4), "base64url")).toHaveLength(32);
    expect(secretHash).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(quickDeploySecretHash(secret)).toBe(secretHash);
  });

  it("is new each time", () => {
    const secrets = new Set(Array.from({ length: 64 }, () => generateQuickDeploySecret().secret));
    expect(secrets.size).toBe(64);
  });

  it("makes a link the contracts' URL pattern takes, under the API's public URL", () => {
    const { secret } = generateQuickDeploySecret();
    for (const base of ["http://127.0.0.1:56899", "https://telflo.example/base"]) {
      const url = quickDeployLinkUrl(base, secret);
      expect(url).toBe(`${base}/api/v1/quick-deploy/${secret}`);
      expect(url).toMatch(QUICK_DEPLOY_URL_PATTERN);
    }
  });
});
