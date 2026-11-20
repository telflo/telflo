// The web app's own server. It does what `react-router-serve` 7.18.4 does
// (@react-router/serve's dist/cli.js) for this app's build, without morgan,
// get-port or source-map-support: compression, `/assets` cached for a year
// as immutable, the build's client files, `public/` for an hour, then React
// Router's request handler.
//
// The invariant: this server's stdout and stderr never hold a request's URL
// or path. Nothing is logged per request (the gateway's redacted access log
// is the record of requests); the start line is fixed; a failed request is
// logged only when it is the server's own failure (5xx), with the request's
// URL and path taken out of the error's text. React Router's own error log
// is app/entry.server.tsx's `handleError`.
//
// The image runs `node server.mjs` (never npx, which writes ~/.npm). Paths are
// resolved against this file's folder, never the working directory.
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The text of `error` (its stack, or its message) with the request's URL and
 * path replaced by a fixed word, raw and decoded, longest first. A one-letter
 * piece ("/") is left: it names nothing. Only the URL and the path are
 * removed: another value an error's message quotes (a param in a loader's
 * own message) is the app's error text and stays.
 */
export function withoutRequestUrl(error, pieces) {
  let text =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  const forms = new Set();
  for (const piece of pieces) {
    if (typeof piece !== "string") continue;
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
 * Whether every part of a raw request target decodes: the path, and each key
 * and value of the query string (split here, not by express's parser, which
 * may swallow a failure). React Router warns with the raw path when a path
 * it is handed doesn't decode (`decodePath`), so such a request never gets
 * that far.
 */
export function decodes(target) {
  const mark = target.indexOf("?");
  const pathPart = mark === -1 ? target : target.slice(0, mark);
  const query = mark === -1 ? "" : target.slice(mark + 1);
  try {
    decodeURIComponent(pathPart);
    for (const pair of query.split("&")) {
      const equals = pair.indexOf("=");
      const key = equals === -1 ? pair : pair.slice(0, equals);
      const value = equals === -1 ? "" : pair.slice(equals + 1);
      decodeURIComponent(key.replace(/\+/g, " "));
      decodeURIComponent(value.replace(/\+/g, " "));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops React Router's one console call that can carry request text and
 * passes every other `console.warn` call through unchanged. React Router's
 * `decodePath` warns `The URL path "<path>" could not be decoded …` when a
 * path it is handed doesn't decode. The edge refusal above stops a raw path
 * or query that doesn't decode, but a value that decodes once to something
 * that doesn't decode again (the manifest route's `paths`, e.g.
 * `%25E0%25A4%25A`) still reaches it, and refusing every such value at the
 * edge would refuse a legitimate `?q=100%25`.
 *
 * The stop rule: two sweeps of react-router 7.18.4's server code found that
 * warning to be the ONLY console call that can carry a request's text.
 * Recheck on every react-router upgrade. Returns a function that puts the
 * original back.
 */
export function installWarnFilter(target = console) {
  const original = target.warn;
  target.warn = function warn(...args) {
    if (typeof args[0] === "string" && args[0].startsWith('The URL path "')) return;
    return original.apply(this, args);
  };
  return () => {
    target.warn = original;
  };
}

/** A fixed plain-text answer: no request text in it, and never sniffed as HTML. */
function answer(res, status, body) {
  res.status(status).set("X-Content-Type-Options", "nosniff").type("text/plain").send(body);
}

/**
 * An express app serving `build` (a React Router server build): the client
 * files from `clientDir`, `public/` from `publicDir`, the rest through
 * React Router. `handler` replaces React Router's request handler (tests).
 */
export function createApp({
  build,
  clientDir,
  publicDir,
  mode = process.env.NODE_ENV ?? "production",
  handler = createRequestHandler({ build, mode }),
}) {
  const app = express();
  // Express reads NODE_ENV when it is created; the app follows `mode`.
  app.set("env", mode);
  app.disable("x-powered-by");
  // A request whose path or query doesn't decode is refused first, without a
  // line: the static mounts and React Router never see it.
  app.use((req, res, next) => (decodes(req.url) ? next() : answer(res, 400, "Bad Request")));
  app.use(compression());
  const publicPath = build.publicPath ?? "/";
  app.use(
    path.posix.join(publicPath, "assets"),
    express.static(path.join(clientDir, "assets"), { immutable: true, maxAge: "1y" }),
  );
  app.use(publicPath, express.static(clientDir));
  app.use(express.static(publicDir, { maxAge: "1h" }));
  app.all("*", handler);
  // Express's own last handler writes every error's stack to stderr, and an
  // undecodable path's message quotes the path. This one answers instead: a
  // request's fault (4xx) writes nothing, the server's (5xx) its error
  // without the request's URL.
  // Express knows an error handler by its four parameters.
  app.use((error, req, res, _next) => {
    const raw = Number(error?.status ?? error?.statusCode);
    const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
    if (status >= 500) {
      console.error(`[web] request failed (${status}): ${withoutRequestUrl(error, [req.originalUrl, req.url, req.path])}`);
    }
    if (res.headersSent) {
      req.socket.destroy();
      return;
    }
    answer(res, status, status >= 500 ? "Internal Server Error" : "Bad Request");
  });
  return app;
}

/** PORT, default 3000; anything else fails rather than moves (no get-port). */
function portOf(value) {
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("[web] PORT must be a whole number from 1 to 65535");
    process.exit(1);
  }
  return port;
}

async function main() {
  installWarnFilter();
  process.env.NODE_ENV = process.env.NODE_ENV ?? "production";
  const port = portOf(process.env.PORT);
  const buildPath = path.join(here, "build", "server", "index.js");
  const build = await import(pathToFileURL(buildPath).href);
  const app = createApp({
    build,
    clientDir: path.resolve(here, build.assetsBuildDirectory),
    publicDir: path.join(here, "public"),
    mode: process.env.NODE_ENV,
  });
  const server = process.env.HOST ? app.listen(port, process.env.HOST) : app.listen(port);
  server.once("listening", () => console.log("[web] the web server is listening"));
  server.once("error", (error) => {
    console.error(`[web] the web server could not listen: ${error.code ?? error.message}`);
    process.exit(1);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

/** Whether this file is the program node ran (`node server.mjs`), not an import. */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) await main();
