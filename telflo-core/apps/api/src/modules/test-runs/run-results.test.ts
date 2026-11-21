import { describe, expect, it } from "vitest";
import type { TesterUnavailableReason } from "../../otelcol-testing/client.js";
import {
  failureResults,
  storableText,
  TEST_RUN_FAILURES,
  unavailableFailure,
  validationResults,
  versionRetiredFailure,
  versionUnavailableFailure,
  versionUnknownFailure,
} from "./run-results.js";

// What the dispatcher stores: strings cut to the contract's bounds in code
// points, never splitting a pair; no NUL or lone surrogate; fixed failures
// that hold no error's own text.

describe("a run's stored results", () => {
  describe("storableText", () => {
    it("keeps a string within the bound as it is", () => {
      expect(storableText("abc", 3)).toBe("abc");
    });

    it("cuts at the bound, counted in code points, a pair kept whole", () => {
      expect(storableText("abcdef", 4)).toBe("abcd");
      expect(storableText("😀😀😀", 2)).toBe("😀😀");
      expect(storableText("a😀b", 2)).toBe("a😀");
      expect(storableText("😀".repeat(5), 5)).toBe("😀".repeat(5));
    });

    it("turns a NUL and a lone surrogate into U+FFFD, one code point for one", () => {
      expect(storableText("a\u0000b", 10)).toBe("a\uFFFDb");
      expect(storableText("a\uD800b\uDC00", 10)).toBe("a\uFFFDb\uFFFD");
      expect(storableText("😀", 10)).toBe("😀");
    });
  });

  describe("validationResults", () => {
    it("keeps each result's five fields in order, as JSON, and makes every string storable: a NUL from an output becomes U+FFFD", () => {
      const results = [
        { id: "a", passed: true, error: null, advisory: "Only \u0000 checked", detail: null },
        {
          id: "b",
          passed: false,
          error: null,
          advisory: null,
          detail: {
            kind: "unexpected_match" as const,
            source: "output" as const,
            totalMatchCount: 1,
            moreMatches: false,
            matches: [{ text: "x\u0000y", textTruncated: false, before: "\uD800", after: "", record: { index: 0, path: "body" } }],
          },
        },
      ];
      expect(validationResults(results)).toEqual([
        { id: "a", passed: true, error: null, advisory: "Only \uFFFD checked", detail: null },
        {
          id: "b",
          passed: false,
          error: null,
          advisory: null,
          detail: {
            kind: "unexpected_match",
            source: "output",
            totalMatchCount: 1,
            moreMatches: false,
            matches: [{ text: "x\uFFFDy", textTruncated: false, before: "\uFFFD", after: "", record: { index: 0, path: "body" } }],
          },
        },
      ]);
    });
  });

  describe("fixed failures", () => {
    it("say what happened, with no path and no error's own text", () => {
      expect(TEST_RUN_FAILURES).toEqual({
        interrupted: { code: "interrupted", message: "The run was interrupted. Run it again." },
        testerTimeout: { code: "tester_timeout", message: "The tester didn't answer in time. Run it again." },
        testerConnectionLost: { code: "tester_connection_lost", message: "The connection to the tester was lost. Run it again." },
        testerError: { code: "tester_error", message: "The tester couldn't run this test. Try again later." },
        inputUnavailable: { code: "input_unavailable", message: "The run's input couldn't be read." },
        storageFailed: { code: "storage_failed", message: "The run's results couldn't be saved. Run it again." },
        internalError: { code: "internal_error", message: "Something went wrong running the test. Run it again." },
        // The evaluator's refusal's words, exactly.
        rulesUnavailable: {
          code: "rules_unavailable",
          message: "Validation rules couldn't be checked: the rule evaluator is unavailable.",
        },
        // The queue's refusals' words, exactly.
        variablesUnavailable: { code: "variables_unavailable", message: "The organization's variables couldn't be reached. Run it again." },
        filledInTooLong: {
          code: "filled_in_too_long",
          message: "The configuration with its organization variables filled in is over 262,144 characters.",
        },
      });
      for (const failure of Object.values(TEST_RUN_FAILURES)) expect(failure.code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    });

    it("version_unavailable names the version", () => {
      expect(versionUnavailableFailure("0.162.0")).toEqual({
        code: "version_unavailable",
        message: "Collector v0.162.0 isn't installed in the tester. Pick another version or try again later.",
      });
    });

    it("version_retired names the version, in its own words", () => {
      expect(versionRetiredFailure("0.162.0")).toEqual({
        code: "version_retired",
        message: "Collector v0.162.0 is no longer offered by the tester. Pick a newer collector version.",
      });
      expect(unavailableFailure("version_retired", "0.162.0")).toEqual(versionRetiredFailure("0.162.0"));
    });

    it("version_unknown names the version, in its own neutral words", () => {
      expect(versionUnknownFailure("0.162.0")).toEqual({
        code: "version_unknown",
        message: "Collector v0.162.0 isn't available in the tester. Pick another collector version.",
      });
      expect(unavailableFailure("version_unknown", "0.162.0")).toEqual(versionUnknownFailure("0.162.0"));
    });

    it.each<[TesterUnavailableReason, string]>([
      ["version_unavailable", "version_unavailable"],
      ["version_retired", "version_retired"],
      ["version_unknown", "version_unknown"],
      ["timeout", "tester_timeout"],
      ["network", "tester_connection_lost"],
      ["aborted", "interrupted"],
      ["unauthorized", "tester_error"],
      ["malformed_reply", "tester_error"],
      ["oversized_reply", "tester_error"],
      ["http_status", "tester_error"],
      ["invalid_request", "tester_error"],
    ])("a run the tester didn't answer, %s: %s", (reason, code) => {
      expect(unavailableFailure(reason, "0.162.0").code).toBe(code);
    });

    it("is stored as the error's code and message, and nothing else", () => {
      expect(failureResults(TEST_RUN_FAILURES.interrupted)).toEqual({
        error_code: "interrupted",
        error_message: "The run was interrupted. Run it again.",
      });
    });
  });
});
