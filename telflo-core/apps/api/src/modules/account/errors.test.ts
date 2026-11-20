import { ACCOUNT_ERROR_CODES, PERSONAL_API_TOKEN_ERROR_CODES } from "@telflo/contracts";
import { describe, expect, it } from "vitest";
import {
  cannotRevokeCurrentSession,
  currentPasswordIncorrect,
  identityAlreadyLinked,
  identityNotLinked,
  passwordNotSet,
  personalApiTokenLimitReached,
  personalApiTokenNameTaken,
  personalApiTokenNotFound,
  providerUnavailable,
  sessionNotFound,
  unlinkRequiresPassword,
} from "./errors.js";

describe("the account's refusals", () => {
  it("are one builder per code, with its status and fixed message, word for word", () => {
    const built = [
      currentPasswordIncorrect(),
      passwordNotSet(),
      identityAlreadyLinked(),
      identityNotLinked(),
      unlinkRequiresPassword(),
      sessionNotFound(),
      cannotRevokeCurrentSession(),
      providerUnavailable(),
    ].map(({ code, statusCode, message }) => ({ code, statusCode, message }));

    expect(built).toEqual([
      { code: "current_password_incorrect", statusCode: 400, message: "The current password is incorrect." },
      {
        code: "password_not_set",
        statusCode: 409,
        message: "Your account has no password yet. Set one from the emailed link.",
      },
      {
        code: "identity_already_linked",
        statusCode: 409,
        message: "Your account already has a sign-in with this provider.",
      },
      { code: "identity_not_linked", statusCode: 404, message: "Your account has no sign-in with this provider." },
      { code: "unlink_requires_password", statusCode: 409, message: "Set a password before removing this sign-in." },
      { code: "session_not_found", statusCode: 404, message: "Session not found" },
      { code: "cannot_revoke_current_session", statusCode: 409, message: "Use Log out to sign out of this browser." },
      {
        code: "provider_unavailable",
        statusCode: 503,
        message: "That sign-in provider isn't available right now. Try again later.",
      },
    ]);
    expect(built.map(({ code }) => code)).toEqual([...ACCOUNT_ERROR_CODES]);
  });

  it("a personal token's refusals are the service-account token codes with a person's words", () => {
    const built = [personalApiTokenNotFound(), personalApiTokenNameTaken(), personalApiTokenLimitReached()].map(
      ({ code, statusCode, message }) => ({ code, statusCode, message }),
    );
    expect(built).toEqual([
      { code: "api_token_not_found", statusCode: 404, message: "Token not found" },
      { code: "api_token_name_taken", statusCode: 409, message: "You already have a token with this name." },
      { code: "api_token_limit_reached", statusCode: 409, message: "You have 20 tokens. Revoke one first." },
    ]);
    expect(built.map(({ code }) => code)).toEqual([...PERSONAL_API_TOKEN_ERROR_CODES]);
  });
});
