import { THEME_COOKIE_NAME, type Theme } from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { themeCookieOptions, type ThemeCookieSettings } from "../sessions/cookies.js";
import type { IUserSettingsRepository } from "./repositories/user-settings-repository.js";

/**
 * Sets the `telflo_theme` cookie: one word, `light`, `dark` or `navy`,
 * nothing personal. Root's server loader reads it to paint the auth screens
 * in the theme this browser was last told. Nothing clears it: sign-out keeps
 * it.
 */
export function setThemeCookie(reply: FastifyReply, settings: ThemeCookieSettings, theme: Theme): void {
  void reply.setCookie(THEME_COOKIE_NAME, theme, themeCookieOptions(settings));
}

/**
 * Sets the cookie to the person's stored theme (Dark with no row), on every
 * reply that sets session cookies: the password sign-in, the refresh
 * (rotation and grace) and the OIDC sign-in.
 *
 * Best-effort: it runs after `setSessionCookies`, once the sign-in or the
 * rotation has committed, and its read stands outside that transaction. A
 * failure of any kind is logged at warn with the user's id and nothing else
 * (never the error, whose text could name a value), sets no cookie, and
 * never throws: a throw here would lose the reply whose new refresh cookie
 * the browser needs, and the next refresh would be a reuse.
 */
export async function setStoredThemeCookie(
  reply: FastifyReply,
  settings: ThemeCookieSettings,
  settingsRepository: Pick<IUserSettingsRepository, "findTheme">,
  userId: string,
  log: Pick<FastifyBaseLogger, "warn">,
): Promise<void> {
  try {
    setThemeCookie(reply, settings, await settingsRepository.findTheme(userId));
  } catch {
    try {
      log.warn({ userId }, "The theme cookie wasn't set: the stored theme couldn't be read");
    } catch {
      // A logger that throws loses only its line.
    }
  }
}
