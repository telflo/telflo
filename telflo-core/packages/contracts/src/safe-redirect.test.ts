import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect.js";

describe("safeRedirectPath", () => {
  describe("allowed (same-origin relative paths)", () => {
    it("preserves a simple path", () => {
      expect(safeRedirectPath("/app")).toBe("/app");
    });

    it("preserves a deep path with query and fragment", () => {
      expect(safeRedirectPath("/configurations/abc?foo=bar#section")).toBe(
        "/configurations/abc?foo=bar#section",
      );
    });

    it("preserves the root path", () => {
      expect(safeRedirectPath("/")).toBe("/");
    });
  });

  describe("rejected (open-redirect vectors)", () => {
    it("rejects absolute https URL", () => {
      expect(safeRedirectPath("https://evil.example")).toBe("/app");
    });

    it("rejects absolute http URL", () => {
      expect(safeRedirectPath("http://evil.example")).toBe("/app");
    });

    it("rejects protocol-relative URL", () => {
      expect(safeRedirectPath("//evil.example")).toBe("/app");
    });

    it("rejects backslash-prefixed URL (some browsers treat \\ as /)", () => {
      expect(safeRedirectPath("/\\evil.example")).toBe("/app");
    });

    it("rejects javascript: URI", () => {
      expect(safeRedirectPath("javascript:alert(1)")).toBe("/app");
    });

    it("rejects data: URI", () => {
      expect(safeRedirectPath("data:text/html,<script>alert(1)</script>")).toBe(
        "/app",
      );
    });

    it("rejects relative paths without leading slash", () => {
      expect(safeRedirectPath("app/configurations")).toBe("/app");
    });

    it("rejects an oversized payload", () => {
      expect(safeRedirectPath("/" + "a".repeat(5000))).toBe("/app");
    });
  });

  // D2c's preflight: a browser's URL parser strips tabs and newlines from
  // anywhere in a URL, so these become `//evil.example`, another site.
  describe("rejected (control characters and backslashes anywhere)", () => {
    it("rejects a tab between the slashes", () => {
      expect(safeRedirectPath("/\t/evil.example")).toBe("/app");
    });

    it("rejects a tab that arrived percent-encoded and was decoded", () => {
      expect(safeRedirectPath(decodeURIComponent("/%09/evil.example"))).toBe("/app");
    });

    it("rejects a newline", () => {
      expect(safeRedirectPath("/\n/evil.example")).toBe("/app");
    });

    it("rejects a carriage return", () => {
      expect(safeRedirectPath("/app\r")).toBe("/app");
    });

    it("rejects a NUL and the last C0 control character, U+001F", () => {
      expect(safeRedirectPath("/app\u0000")).toBe("/app");
      expect(safeRedirectPath("/app\u001f")).toBe("/app");
    });

    it("rejects a backslash later in the path", () => {
      expect(safeRedirectPath("/app/\\evil.example")).toBe("/app");
    });

    it("keeps a percent-encoded tab that was not decoded, which a browser does not strip", () => {
      expect(safeRedirectPath("/search?q=%09")).toBe("/search?q=%09");
    });

    it("keeps a space, which is not a control character", () => {
      expect(safeRedirectPath("/app?q=a b")).toBe("/app?q=a b");
    });
  });

  describe("empty inputs", () => {
    it("returns fallback for null", () => {
      expect(safeRedirectPath(null)).toBe("/app");
    });

    it("returns fallback for undefined", () => {
      expect(safeRedirectPath(undefined)).toBe("/app");
    });

    it("returns fallback for empty string", () => {
      expect(safeRedirectPath("")).toBe("/app");
    });
  });

  describe("custom fallback", () => {
    it("honors a custom fallback path", () => {
      expect(safeRedirectPath("https://evil.example", "/dashboard")).toBe(
        "/dashboard",
      );
    });

    it("uses custom fallback for null input", () => {
      expect(safeRedirectPath(null, "/home")).toBe("/home");
    });
  });
});
