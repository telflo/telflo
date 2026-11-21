/**
 * Validates a user-supplied `redirectTo` value before it reaches `redirect()`
 * or `navigate()`. Returns the input unchanged if it's a same-origin
 * relative path; otherwise returns `fallback`.
 *
 * Closes the open-redirect class of bug where an attacker phishes a user
 * with `https://telflo.com/login?redirectTo=https://evil.example` and lands
 * them on attacker infrastructure after a legitimate login.
 *
 * Allowed shapes:  `/app`, `/configurations/abc?x=1#frag`
 * Rejected shapes: `https://evil.example`, `//evil.example` (protocol-relative),
 *                  `/\evil.example` (backslash variant), `javascript:...`,
 *                  empty/null, anything not starting with a single `/`,
 *                  and anything holding a control character or a backslash.
 *
 * A browser's URL parser strips tabs and newlines, so `/\t/evil.example` would
 * become `//evil.example`, another site. So any C0 control character or
 * backslash, anywhere, is refused. One implementation, here, serves the web
 * and the API (the OIDC flow cleans `redirectTo` when it starts and when it
 * ends).
 */
export function safeRedirectPath(
  input: string | null | undefined,
  fallback = "/app",
): string {
  if (!input) return fallback;
  if (input.length > 2048) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  if (hasControlCharacter(input)) return fallback;
  // Some browsers treat `\` as `/`, so `/\evil.example` is protocol-relative.
  if (input.includes("\\")) return fallback;
  return input;
}

/** True when `input` holds a C0 control character (U+0000 to U+001F). */
function hasControlCharacter(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (input.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}
