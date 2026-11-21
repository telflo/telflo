/*
 * The API reference link: Settings › Service Accounts' intro and Settings ›
 * Account's "API tokens" card link the public surface's reference page,
 * Swagger UI served by the API itself. A plain `<a>`, not the router's Link:
 * the page is the API's, not a route of the web app, so the browser
 * navigates to it whole (through the gateway, the same origin). With its
 * slash: `/docs` is the API's 301 to it.
 */

/** The reference page's path, with its slash. */
export const API_REFERENCE_PATH = "/api/public/v1/docs/";

/** The words both places say, "API reference" the link. */
export function ApiReferenceNote({ className }: { className?: string }) {
  return (
    <p className={className}>
      The{" "}
      <a href={API_REFERENCE_PATH} className="font-medium text-brand hover:underline">
        API reference
      </a>{" "}
      lists the API&rsquo;s routes and lets you try them with a token.
    </p>
  );
}
