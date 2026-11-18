/*
 * The API reference page's start (D25 decision 49, Preflight ruling 20):
 * Swagger UI over the public surface's OpenAPI document, with try-it. The
 * one page where a tf_ token is typed (brief-rules' D25 paragraph), so:
 *
 *   - Authorize keeps it in memory only (persistAuthorization: false): no
 *     browser storage, gone with the page;
 *   - no input on the page is remembered by the browser: autocomplete="off"
 *     on every input and textarea, set as each appears (Firefox's form
 *     history stored the token on disk without it, Preflight B18);
 *   - the curl block after try-it names the token's variable,
 *     `Authorization: Bearer $TELFLO_TOKEN`, never the token (the DOM held
 *     it otherwise);
 *   - try-it requests send no cookie (credentials "omit"): the public
 *     surface reads none, and the session cookie was sent otherwise;
 *   - nothing reaches the URL (deepLinking and queryConfigEnabled off), no
 *     outside validator is called (validatorUrl null), no request snippets.
 *
 * Static, served with the page from the API's own origin under a CSP of
 * 'self' alone (reference-page.ts); a classic script, after the
 * vendored bundle, which defines SwaggerUIBundle (eslint.config.js lints it
 * as such).
 */
"use strict";

(function () {
  /** Every input and textarea under `root`, autocomplete="off". */
  function noFormHistory(root) {
    var fields = root.querySelectorAll("input, textarea");
    for (var index = 0; index < fields.length; index += 1) {
      if (fields[index].getAttribute("autocomplete") !== "off") fields[index].setAttribute("autocomplete", "off");
    }
  }
  new MutationObserver(function () {
    noFormHistory(document);
  }).observe(document.documentElement, { childList: true, subtree: true });

  /** The curl block shows the token's variable, never the token. */
  function TokenlessCurl(system) {
    return {
      wrapComponents: {
        curl: function (Original) {
          return function (props) {
            var request = props.request;
            var headers = request && request.get("headers");
            var shown =
              headers && headers.get("Authorization")
                ? request.setIn(["headers", "Authorization"], "Bearer $TELFLO_TOKEN")
                : request;
            return system.React.createElement(Original, Object.assign({}, props, { request: shown }));
          };
        },
      },
    };
  }

  SwaggerUIBundle({
    url: "/api/public/v1/openapi.json",
    dom_id: "#swagger-ui",
    persistAuthorization: false,
    tryItOutEnabled: true,
    deepLinking: false,
    validatorUrl: null,
    queryConfigEnabled: false,
    requestSnippetsEnabled: false,
    withCredentials: false,
    displayRequestDuration: true,
    plugins: [TokenlessCurl],
    // The public surface reads no cookie: send none.
    requestInterceptor: function (request) {
      request.credentials = "omit";
      return request;
    },
  });
})();
