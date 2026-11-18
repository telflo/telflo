import { afterEach, describe, expect, it, vi } from "vitest";
import { publicWebUrl } from "./public-url.server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicWebUrl", () => {
  it("is TELFLO_PUBLIC_WEB_URL when it is set", () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://telflo.example");
    expect(publicWebUrl()).toBe("https://telflo.example");
  });

  it("drops a trailing slash, so a path can be appended", () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://telflo.example/");
    expect(publicWebUrl()).toBe("https://telflo.example");
  });

  it("is undefined when the setting is unset", () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", undefined);
    expect(publicWebUrl()).toBeUndefined();
  });

  it('is undefined when the setting is "", the E2E servers\' unset', () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "");
    expect(publicWebUrl()).toBeUndefined();
  });

  it("reads the setting at call time, not at import", () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://one.example");
    expect(publicWebUrl()).toBe("https://one.example");
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://two.example");
    expect(publicWebUrl()).toBe("https://two.example");
  });
});
