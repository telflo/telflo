/*
 * `/robots.txt` (D36-1 decision 21, Preflight ruling 12): an install's pages
 * aren't for search engines, so every path is disallowed, the sign-in page
 * included. It names no sitemap: the marketing site and its sitemap left the
 * web app (decision 20). A site with public pages of its own serves its own
 * robots.txt ahead of this one, through the gateway (`gateway.extraRoutes`,
 * decision 24).
 */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export function loader() {
  return new Response(ROBOTS_TXT, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
