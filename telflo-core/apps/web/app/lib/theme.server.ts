import { THEME_COOKIE_NAME, themeFromCookie, type Theme } from "@telflo/contracts";

/**
 * The theme the request's `telflo_theme` cookie names, for root's loader: the
 * seven auth screens render it on a full load. The API sets the cookie,
 * HttpOnly, to one word. Only that word can come out of here: the value goes
 * through contracts' `themeFromCookie`, so anything but `light`, `dark` or
 * `navy` (absent, another spelling, an encoding, an oversized value) is Dark,
 * and nothing else from the cookie header is read or passed on.
 *
 * The first `telflo_theme` in the header is the one read, as browsers send
 * the most specific path's first; the API sets it only at `Path=/`.
 */
export function themeFromRequest(request: Request): Theme {
  return themeFromCookie(cookieValue(request.headers.get("cookie"), THEME_COOKIE_NAME));
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}
