import { describe, expect, it } from "vitest";
import { CONFIGURATION_ERROR_CODES, CONFIGURATION_INVALID_MESSAGE } from "../configurations.js";
import { FLEET_ERROR_CODES } from "../fleets.js";
import { FLOW_ERROR_CODES } from "../flows.js";
import { IDENTITY_ERROR_CODES } from "../identity.js";
import { ORGANIZATION_ERROR_CODES } from "../organizations.js";
import { SERVICE_ACCOUNT_ERROR_CODES } from "../service-accounts.js";
import { SESSION_ERROR_CODES } from "../sessions.js";
import { TEST_RUN_OUTPUT_NOT_FOUND_MESSAGE, TESTING_ERROR_CODES } from "../test-runs.js";
import { VALIDATION_RULES_ERROR_CODES } from "../validation-rules.js";
import { PUBLIC_API_ERROR_CODES, PUBLIC_API_ERROR_MESSAGES } from "./errors.js";

describe("the public surface's new codes (D25 decision 20, Preflight ruling 7)", () => {
  it("are the five the ruling names, each in one union, with decision 20's words", () => {
    expect(PUBLIC_API_ERROR_CODES).toEqual(["insufficient_access", "organization_required", "ottl_lint_unavailable"]);
    expect(PUBLIC_API_ERROR_MESSAGES).toEqual({
      insufficient_access: "This token can't make changes.",
      organization_required: "Send the organization's id in X-Telflo-Org.",
      ottl_lint_unavailable: "OTTL lint is unavailable right now. Try again shortly.",
    });
    expect(CONFIGURATION_ERROR_CODES).toContain("configuration_invalid");
    expect(CONFIGURATION_INVALID_MESSAGE).toBe("The configuration is not valid.");
    expect(TESTING_ERROR_CODES).toContain("test_run_output_not_found");
    expect(TEST_RUN_OUTPUT_NOT_FOUND_MESSAGE).toBe("This run has no output.");
  });

  it("none of the public surface's own is another module's", () => {
    const others = new Set<string>([
      ...CONFIGURATION_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...FLEET_ERROR_CODES,
      ...VALIDATION_RULES_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...SERVICE_ACCOUNT_ERROR_CODES,
    ]);
    for (const code of PUBLIC_API_ERROR_CODES) expect(others.has(code)).toBe(false);
  });
});
