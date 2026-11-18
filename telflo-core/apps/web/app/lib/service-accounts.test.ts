import { describe, expect, it } from "vitest";
import { SERVICE_ACCOUNT_ERROR_CODES, SERVICE_ACCOUNT_ERROR_MESSAGES } from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import {
  formatServiceAccountDate,
  isServiceAccountRefusal,
  listedPrefix,
  serviceAccountFailureMessage,
} from "~/lib/service-accounts.js";

/* Settings › Service Accounts' words (D22 decisions 42-46; Preflight ruling 30). */

describe("the Service Accounts pages' words", () => {
  it("dates read en-US, and none reads Never", () => {
    const iso = "2026-10-23T12:00:00.000Z";
    expect(formatServiceAccountDate(iso)).toBe(new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
    expect(formatServiceAccountDate(iso)).toMatch(/^Oct 2[234], 2026$/);
    expect(formatServiceAccountDate(null)).toBe("Never");
    expect(formatServiceAccountDate("not a time")).toBe("—");
  });

  it("a prefix is listed with an ellipsis", () => {
    const start = "tf_";
    expect(listedPrefix(`${start}AbC12xYz`)).toBe(`${start}AbC12xYz…`);
  });

  it("toasts the API's fixed words for the service-account codes, invalid_request and rate_limited, else the fallback", () => {
    for (const code of SERVICE_ACCOUNT_ERROR_CODES) {
      const refusal = new ApiError(code, SERVICE_ACCOUNT_ERROR_MESSAGES[code], { status: 409 });
      expect(isServiceAccountRefusal(refusal)).toBe(true);
      expect(serviceAccountFailureMessage(refusal, "fallback")).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES[code]);
    }
    expect(serviceAccountFailureMessage(new ApiError("invalid_request", "The request is invalid.", { status: 400 }), "fallback")).toBe(
      "The request is invalid.",
    );
    expect(serviceAccountFailureMessage(new ApiError("rate_limited", "Too many requests.", { status: 429 }), "fallback")).toBe("Too many requests.");
    for (const other of [
      new ApiError("server_error", "Something went wrong.", { status: 500 }),
      new ApiError("network_error", "Could not reach the server. Check your connection."),
      new ApiError("unexpected_response", "The server returned an unexpected response."),
      new Error("boom"),
      "boom",
    ]) {
      expect(serviceAccountFailureMessage(other, "fallback")).toBe("fallback");
    }
  });
});
