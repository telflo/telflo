import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredToken, takeAddressBarToken } from "./address-bar-token.js";

const KEY = "telflo.someToken";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("taking an emailed link's token out of the address bar (D4 Ruling 14)", () => {
  it("from a fragment: removes the whole fragment and keeps the query", () => {
    window.history.replaceState(null, "", "/reset-password?utm_source=mail#token=secret");

    expect(takeAddressBarToken("fragment", KEY)).toBe("secret");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/reset-password?utm_source=mail",
    );
    expect(sessionStorage.getItem(KEY)).toBe("secret");
  });

  it("from a query: removes only the token parameter, keeping the others and the fragment", () => {
    window.history.replaceState(null, "", "/verify-email?utm_source=mail&token=secret#top");

    expect(takeAddressBarToken("query", KEY)).toBe("secret");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/verify-email?utm_source=mail#top",
    );
  });

  it("replaces the history entry rather than pushing one, so no entry keeps the token", () => {
    window.history.replaceState(null, "", "/accept-invitation#token=secret");
    const historyLength = window.history.length;

    takeAddressBarToken("fragment", KEY);

    expect(window.history.length).toBe(historyLength);
    expect(window.location.href).not.toContain("secret");
  });

  it("keeps the router's state for the entry", () => {
    window.history.replaceState({ usr: null, key: "abc", idx: 0 }, "", "/verify-email?token=secret");

    takeAddressBarToken("query", KEY);

    expect(window.history.state).toEqual({ usr: null, key: "abc", idx: 0 });
  });

  it("leaves a place without a token alone, and returns the one stored earlier in this tab", () => {
    sessionStorage.setItem(KEY, "stored");
    window.history.replaceState(null, "", "/reset-password?token=in-the-query");
    const replace = vi.spyOn(window.history, "replaceState");

    expect(takeAddressBarToken("fragment", KEY)).toBe("stored");
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?token=in-the-query");
  });

  it("replaces a stored token with a new link's", () => {
    sessionStorage.setItem(KEY, "older");
    window.history.replaceState(null, "", "/verify-email?token=newer");

    expect(takeAddressBarToken("query", KEY)).toBe("newer");
    expect(sessionStorage.getItem(KEY)).toBe("newer");
  });

  it("removes an empty token's fragment too, and reads what was stored", () => {
    sessionStorage.setItem(KEY, "stored-earlier");
    window.history.replaceState(null, "", "/accept-invitation#token=");

    expect(takeAddressBarToken("fragment", KEY)).toBe("stored-earlier");
    expect(window.location.hash).toBe("");
  });

  it("removes an empty token too, and falls back to the stored one", () => {
    window.history.replaceState(null, "", "/verify-email?token=");

    expect(takeAddressBarToken("query", KEY)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("is safe to call again: the second call reads the stored token", () => {
    window.history.replaceState(null, "", "/reset-password#token=secret");

    expect(takeAddressBarToken("fragment", KEY)).toBe("secret");
    expect(takeAddressBarToken("fragment", KEY)).toBe("secret");
  });

  it("keeps the token for the page's life when sessionStorage refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    window.history.replaceState(null, "", "/reset-password#token=secret");

    expect(takeAddressBarToken("fragment", KEY)).toBe("secret");
    expect(window.location.hash).toBe("");
    expect(takeAddressBarToken("fragment", KEY)).toBe("secret");

    clearStoredToken(KEY);
    expect(takeAddressBarToken("fragment", KEY)).toBeNull();
  });

  it("forgets the stored token when cleared", () => {
    sessionStorage.setItem(KEY, "stored");

    clearStoredToken(KEY);

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeAddressBarToken("query", KEY)).toBeNull();
  });
});
