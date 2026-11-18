import { describe, expect, it } from "vitest";
import {
  PERSONAL_API_TOKEN_ERROR_CODES,
  PERSONAL_API_TOKEN_ERROR_MESSAGES,
  PERSONAL_API_TOKENS_LIVE_MAXIMUM,
} from "./personal-api-tokens.js";
import { SERVICE_ACCOUNT_ERROR_CODES } from "./service-accounts.js";

describe("personal API tokens' contracts (D25 decisions 27-29; Preflight ruling 14)", () => {
  it("reuse D22's api_token_* codes, with a person's words, fixed", () => {
    expect(PERSONAL_API_TOKEN_ERROR_CODES).toEqual(["api_token_not_found", "api_token_name_taken", "api_token_limit_reached"]);
    for (const code of PERSONAL_API_TOKEN_ERROR_CODES) expect(SERVICE_ACCOUNT_ERROR_CODES).toContain(code);
    expect(PERSONAL_API_TOKENS_LIVE_MAXIMUM).toBe(20);
    expect(PERSONAL_API_TOKEN_ERROR_MESSAGES).toEqual({
      api_token_not_found: "Token not found",
      api_token_name_taken: "You already have a token with this name.",
      api_token_limit_reached: "You have 20 tokens. Revoke one first.",
    });
  });
});
