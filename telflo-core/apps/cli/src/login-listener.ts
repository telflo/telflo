/*
 * The CLI's side of `/cli-auth` (D27 decision 20, Ruling 234): a one-shot
 * HTTP listener on `127.0.0.1` that takes the token the page hands over.
 *
 * - It binds `127.0.0.1` on a free port and serves one path, `/callback`.
 * - It accepts only `POST /callback` with `Origin` equal to the server's
 *   origin, `Host` equal to `127.0.0.1:<port>`, `Content-Type:
 *   application/json` and a body of at most 4 KiB holding exactly
 *   `{ state, token }` or `{ state, error: "denied" }`, the state compared
 *   in constant time; and the CORS preflight for it (`OPTIONS`), answered
 *   with `-Allow-Methods: POST`, `-Allow-Headers: content-type`, and
 *   `-Allow-Private-Network: true` only when the preflight asks for it.
 * - Every reply (the preflight's, the 204, a 403 or 404) carries
 *   `Access-Control-Allow-Origin: <server's origin>`, never `*`, so the page
 *   can read the answer; none has a body.
 * - Anything else is refused (403 or 404) and it keeps waiting; ten refusals
 *   stop it. A body past 4 KiB is refused at once and its request destroyed
 *   (never read to its end). It stops after an accepted answer, `close()`,
 *   or five minutes.
 *
 * It never logs, and never says why a request was refused. It imports only
 * node's built-ins: the browser tests import it (Preflight ruling 17).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The one path the listener serves. */
export const CALLBACK_PATH = "/callback";
/** How long the listener waits for the page (decision 20). */
export const LISTENER_TIMEOUT_MS = 5 * 60 * 1000;
/** Refused requests that stop the listener. */
export const MAXIMUM_REFUSALS = 10;
/** The largest body the listener reads. */
export const MAXIMUM_BODY_BYTES = 4096;
/** A state: 32 random bytes, base64url (43 characters). */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How the wait ended. */
export type ListenerOutcome =
  | { kind: "token"; token: string }
  | { kind: "denied" }
  | { kind: "timeout" }
  | { kind: "refused" }
  | { kind: "closed" };

export interface LoginListener {
  /** The address the listener is bound to: `127.0.0.1`, never another interface. */
  address: string;
  /** The port the listener is bound to on `127.0.0.1`. */
  port: number;
  /** Settles once: the first accepted answer, the timeout, the tenth refusal, or `close()`. */
  answer: Promise<ListenerOutcome>;
  /** Stops the listener (its answer then `closed`, unless it had settled already). */
  close(): void;
}

export interface ListenerOptions {
  /** The server's origin: the only `Origin` the listener answers. */
  origin: string;
  /** This login's state (`newState()`). */
  state: string;
  timeoutMs?: number;
  maximumRefusals?: number;
}

/** A fresh state: 32 random bytes, base64url. */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

/** The page's address with the listener's parameters in its fragment (Preflight ruling 13). */
export function cliAuthUrl(server: string, parameters: { state: string; port: number; host: string }): string {
  return `${server}/cli-auth#state=${parameters.state}&port=${parameters.port}&host=${parameters.host}`;
}

/** Whether two states are the same, in time that doesn't depend on where they differ (or their lengths). */
function sameState(given: string, expected: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer a body holds, or null when it's anything but `{ state, token }` or `{ state, error: "denied" }` with this state. */
function answerOf(text: string, state: string): ListenerOutcome | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || typeof body.state !== "string") return null;
  const keys = Object.keys(body).sort().join(",");
  let outcome: ListenerOutcome;
  if (keys === "state,token" && typeof body.token === "string" && body.token !== "") outcome = { kind: "token", token: body.token };
  else if (keys === "error,state" && body.error === "denied") outcome = { kind: "denied" };
  else return null;
  return sameState(body.state, state) ? outcome : null;
}

function isJson(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Starts the listener on `127.0.0.1` and a free port. */
export function startLoginListener(options: ListenerOptions): Promise<LoginListener> {
  const { origin, state } = options;
  const maximumRefusals = options.maximumRefusals ?? MAXIMUM_REFUSALS;
  let port = 0;
  let refusals = 0;
  let settled = false;
  let resolveAnswer!: (outcome: ListenerOutcome) => void;
  const answer = new Promise<ListenerOutcome>((resolve) => {
    resolveAnswer = resolve;
  });

  const reply = (response: ServerResponse, status: number, headers: OutgoingHttpHeaders = {}): void => {
    response.writeHead(status, {
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "no-store",
      Connection: "close",
      "Content-Length": "0",
      ...headers,
    });
    response.end();
  };

  const server = createServer((request, response) => handle(request, response));

  const settle = (outcome: ListenerOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveAnswer(outcome);
    server.close();
    server.closeIdleConnections();
  };

  const refuse = (request: IncomingMessage, response: ServerResponse, status: 403 | 404, { drop = false } = {}): void => {
    // A body too large is never read to its end: the request is destroyed once the 403 is sent.
    if (drop) response.once("finish", () => request.destroy());
    else request.resume();
    reply(response, status);
    if (settled) return;
    refusals += 1;
    if (refusals >= maximumRefusals) settle({ kind: "refused" });
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (settled) return refuse(request, response, 403);
    if (request.url !== CALLBACK_PATH || (request.method !== "POST" && request.method !== "OPTIONS")) {
      return refuse(request, response, 404);
    }
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== origin) return refuse(request, response, 403);

    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST") return refuse(request, response, 403);
      const privateNetwork = request.headers["access-control-request-private-network"] === "true";
      request.resume();
      return reply(response, 204, {
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
        ...(privateNetwork ? { "Access-Control-Allow-Private-Network": "true" } : {}),
      });
    }

    // node's parser refuses a malformed length itself; a chunked body is counted as it comes.
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > MAXIMUM_BODY_BYTES) return refuse(request, response, 403, { drop: true });
    if (!isJson(request.headers["content-type"])) return refuse(request, response, 403);
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size <= MAXIMUM_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      // Past 4 KiB (a body sent without a length): refused at once, nothing more read.
      tooLarge = true;
      chunks.length = 0;
      refuse(request, response, 403, { drop: true });
    });
    request.on("end", () => {
      if (tooLarge) return;
      const outcome = answerOf(Buffer.concat(chunks).toString("utf8"), state);
      // `settled`: another answer was taken while this one's body arrived (two at once).
      if (outcome === null || settled) return refuse(request, response, 403);
      reply(response, 204);
      settle(outcome);
    });
    request.on("error", () => undefined);
  };

  const timer = setTimeout(() => settle({ kind: "timeout" }), options.timeoutMs ?? LISTENER_TIMEOUT_MS);

  return new Promise<LoginListener>((resolve, reject) => {
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address() as AddressInfo;
      port = bound.port;
      resolve({
        address: bound.address,
        port,
        answer,
        close: () => {
          settle({ kind: "closed" });
          server.closeAllConnections();
        },
      });
    });
  });
}
