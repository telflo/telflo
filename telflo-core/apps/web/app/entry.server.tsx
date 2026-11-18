// This is React Router's default server entry, revealed with `react-router
// reveal entry.server` (7.18.4). It differs from the default in three ways.
// It adds `handleError` below. A streaming render error is logged through
// `handleError` instead of `console.error`. Two `let`s are `const`, as the
// lint asks. The first two follow D33-1 decision 13 and Preflight ruling 15.
// The web server's stdout and stderr never hold a request's URL or path.
// React Router's default `handleError` writes `No route matches URL
// "<path>"` for every 404.
import { PassThrough } from "node:stream";

import type { AppLoadContext, EntryContext, HandleErrorFunction } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

export const streamTimeout = 5_000;

/**
 * The text of `error` (its stack, or its message) with the request's URL and
 * path replaced by a fixed word, raw and decoded, longest first. A
 * one-letter piece ("/") is left: it names nothing. Only the URL and the
 * path are removed: another value an error's message quotes (a param in a
 * loader's own message) is the app's error text and stays.
 */
function withoutRequestUrl(error: unknown, request: Request): string {
  let text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  const url = new URL(request.url);
  const forms = new Set<string>();
  for (const piece of [url.href, `${url.pathname}${url.search}`, url.pathname, url.search]) {
    forms.add(piece);
    try {
      forms.add(decodeURIComponent(piece));
    } catch {
      // A malformed escape has no decoded form; the raw one is enough.
    }
  }
  const sorted = [...forms].filter((form) => form.length > 1).sort((a, b) => b.length - a.length);
  for (const form of sorted) text = text.split(form).join("[request]");
  return text;
}

/**
 * React Router calls this for every error on the server. A 404 (no route,
 * or a loader's) and an aborted request write nothing; another route error
 * response writes its status only (React Router's own messages quote the
 * path); any other error writes its message and stack without the
 * request's URL.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error)) {
    if (error.status !== 404) console.error(`[web] route error response (${error.status})`);
    return;
  }
  console.error(`[web] server error: ${withoutRequestUrl(error, request)}`);
};

// React Router requires the entry's default export.
// eslint-disable-next-line no-restricted-syntax
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext,
  // If you have middleware enabled:
  // loadContext: RouterContextProvider
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            handleError(error, { request, params: {}, context: loadContext });
          }
        },
      },
    );
  });
}
