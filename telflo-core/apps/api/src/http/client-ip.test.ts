import { describe, expect, it } from "vitest";
import { clientIpForAudit } from "./client-ip.js";

describe("clientIpForAudit", () => {
  it("accepts an IPv4 address", () => {
    expect(clientIpForAudit("203.0.113.7")).toBe("203.0.113.7");
  });

  it("accepts an IPv6 address", () => {
    expect(clientIpForAudit("2001:db8::1")).toBe("2001:db8::1");
  });

  it("accepts the IPv6 loopback address", () => {
    expect(clientIpForAudit("::1")).toBe("::1");
  });

  it("returns undefined for the text unknown", () => {
    expect(clientIpForAudit("unknown")).toBeUndefined();
  });

  it("returns undefined for the empty string", () => {
    expect(clientIpForAudit("")).toBeUndefined();
  });

  it("returns undefined for a forwarded list rather than recording it whole", () => {
    expect(clientIpForAudit("1.2.3.4, 5.6.7.8")).toBeUndefined();
  });
});
