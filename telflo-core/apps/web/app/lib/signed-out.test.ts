import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The one sign-out clean-up (Q211, Ruling 317): the staged playground edit
 * removed, PostHog reset.
 */

const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", () => ({ signedOutLocally: analytics.signedOutLocally }));

const { signedOutInThisBrowser } = await import("./signed-out.js");
const { STAGED_EDIT_KEY } = await import("./playground/staged-edit.js");

afterEach(() => {
  window.localStorage.clear();
  analytics.signedOutLocally.mockReset();
});

describe("signedOutInThisBrowser", () => {
  it("removes the staged playground edit, its one key, and resets analytics", () => {
    window.localStorage.setItem(STAGED_EDIT_KEY, JSON.stringify({ version: 1 }));
    window.localStorage.setItem("telflo-playground-theme", "navy");
    signedOutInThisBrowser();
    expect(window.localStorage.getItem(STAGED_EDIT_KEY)).toBeNull();
    // Only that key: the playground's theme word stays.
    expect(window.localStorage.getItem("telflo-playground-theme")).toBe("navy");
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
  });

  it("does nothing more with nothing staged, and survives storage that refuses", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => signedOutInThisBrowser()).not.toThrow();
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
