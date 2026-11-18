import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { setStoredThemeCookie, setThemeCookie } from "./theme-cookie.js";

/*
 * The theme cookie's writers (D21 decision 23, Preflight ruling 4). The
 * replies that set it are the routes' integration tests; here, the
 * best-effort read: a failure never reaches the sign-in or the refresh.
 */

const USER_ID = "0b9f4e0e-6f55-4a8e-9d1c-2f3a4b5c6d7e";
const settings = { isCookieSecure: true };
/** A failure whose text names a value, which must never reach the log. */
const FAILURE_TEXT = 'Failing row contains (person@example.com, navy)';

function fakeReply() {
  const setCookie = vi.fn();
  return { reply: { setCookie } as unknown as FastifyReply, setCookie };
}

describe("setThemeCookie", () => {
  it("sets telflo_theme to the one word, with the theme cookie's options", () => {
    const { reply, setCookie } = fakeReply();

    setThemeCookie(reply, settings, "navy");

    expect(setCookie).toHaveBeenCalledOnce();
    expect(setCookie).toHaveBeenCalledWith("telflo_theme", "navy", {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 31_536_000,
    });
  });
});

describe("setStoredThemeCookie", () => {
  it("sets the stored theme", async () => {
    const { reply, setCookie } = fakeReply();
    const findTheme = vi.fn(async () => "light" as const);
    const warn = vi.fn();

    await setStoredThemeCookie(reply, settings, { findTheme }, USER_ID, { warn });

    expect(findTheme).toHaveBeenCalledOnce();
    expect(findTheme).toHaveBeenCalledWith(USER_ID);
    expect(setCookie).toHaveBeenCalledOnce();
    expect(setCookie).toHaveBeenCalledWith("telflo_theme", "light", expect.objectContaining({ path: "/" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("a failing theme read sets no cookie, logs only the user's id and doesn't throw", async () => {
    for (const findTheme of [
      vi.fn(async () => {
        throw new Error(FAILURE_TEXT);
      }),
      // Thrown before any promise exists: caught all the same.
      vi.fn(() => {
        throw new Error(FAILURE_TEXT);
      }),
    ]) {
      const { reply, setCookie } = fakeReply();
      const warn = vi.fn();

      await expect(setStoredThemeCookie(reply, settings, { findTheme }, USER_ID, { warn })).resolves.toBeUndefined();

      expect(setCookie).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      const [fields, message] = warn.mock.calls[0]!;
      expect(fields).toEqual({ userId: USER_ID });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(FAILURE_TEXT);
      expect(message).not.toContain("person@example.com");
    }
  });

  it("doesn't throw when the logger throws too", async () => {
    const { reply, setCookie } = fakeReply();
    const findTheme = vi.fn(async () => {
      throw new Error(FAILURE_TEXT);
    });
    const warn = vi.fn(() => {
      throw new Error("the log is closed");
    });

    await expect(setStoredThemeCookie(reply, settings, { findTheme }, USER_ID, { warn })).resolves.toBeUndefined();
    expect(setCookie).not.toHaveBeenCalled();
  });
});
