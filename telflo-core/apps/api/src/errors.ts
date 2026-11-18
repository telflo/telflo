import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendPlainTextRefusal } from "./http/plain-text-refusal.js";
import { isPublicPath } from "./http/public-path.js";
import { loggedRequestUrl, urlMayHoldPublicLinkSecret } from "./http/request-log.js";

/**
 * An error with a stable, machine-readable code. `message` is for humans and
 * may be reworded freely; `code` is part of the contract and must not change.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  /**
   * Response headers the error handler sets with the envelope: a 429's
   * `retry-after`, when the limit is checked where the reply isn't at hand
   * (D6 Preflight ruling 11's mail limit, in the service).
   */
  readonly headers?: Readonly<Record<string, string | number>> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    details?: unknown,
    headers?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.headers = headers;
  }
}

/**
 * Every response leaving this API uses the one error envelope
 * (Global Constraints). Unexpected errors are logged in full and reported
 * generically, so internal detail never reaches a client.
 */
export function registerErrorHandling(server: FastifyInstance): void {
  server.setNotFoundHandler(sendNotFound);

  server.setErrorHandler((error: AppError | FastifyError, request, reply) => {
    if (error instanceof AppError) {
      // A 5xx AppError is a server failure given a deliberate, generic
      // response (sign-in's missing personal organization, say). The client
      // learns nothing more, but the failure must still reach the logs.
      if (error.statusCode >= 500) request.log.error({ err: error }, "server error");
      if (error.headers) void reply.headers(error.headers);
      // The public surface's refusals in fixed words carry `{ path, message }` (D25 Ruling 187); the browser's keep their shape.
      const details = error.details && isPublicRequest(request) ? publicRefusalDetails(error.details) : error.details;
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(details ? { details } : {}) },
      });
      return;
    }

    // A bare `error.statusCode === 400` check is not enough: Fastify's own
    // content-type/body-parsing errors (e.g. FST_ERR_CTP_INVALID_JSON_BODY)
    // also carry statusCode 400 but are not validation errors, and forwarding
    // their .message would leak arbitrary third-party error text to the
    // client. hasZodFastifySchemaValidationErrors narrows to genuine Zod
    // schema-validation failures specifically — confirmed empirically
    // (see errors.test.ts) by registering a route with a Zod body schema:
    // a real validation failure has error.code === "FST_ERR_VALIDATION" and
    // a non-empty error.validation array of Zod-tagged issues; a malformed
    // JSON body has error.code === "FST_ERR_CTP_INVALID_JSON_BODY" and no
    // `validation` property at all, so it correctly falls through below.
    if (hasZodFastifySchemaValidationErrors(error)) {
      void reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "The request was not valid.",
          // The public surface's details name places and codes only (D25 Ruling 175); the browser's keep Zod's issues.
          details: isPublicRequest(request) ? publicValidationDetails(error.validation) : error.validation,
        },
      });
      return;
    }

    // Fastify raises its own 4xx errors before a route handler — or even the
    // Zod validator above — ever runs: malformed JSON
    // (FST_ERR_CTP_INVALID_JSON_BODY, 400), a body over bodyLimit
    // (FST_ERR_CTP_BODY_TOO_LARGE, 413), an unsupported content type
    // (FST_ERR_CTP_INVALID_MEDIA_TYPE, 415), and similar. These are genuine
    // client mistakes, not server failures: falling through to the 500
    // branch below reports the wrong status to the caller and, at
    // "error" level, buries the "unhandled error" log line that is
    // supposed to mean something went wrong on our end. error.message is
    // still never forwarded — Fastify's own wording for these is
    // implementation detail, not a stable contract — so only a generic,
    // per-status message is sent.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, "client error");
      void reply.status(error.statusCode).send({
        error: { code: genericClientErrorCode(error.statusCode), message: genericClientErrorMessage(error.statusCode) },
      });
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    void reply.status(500).send({
      error: { code: "internal_error", message: "Something went wrong. Please try again." },
    });
  });
}

/** The public surface's prefix, as its routes are registered (modules/public-api/route-guard.ts' PUBLIC_API_PREFIX). */
const PUBLIC_API_ROUTE_PREFIX = "/api/public/v1";

/** A request on the public surface: one http/public-path.ts puts under the prefix, or one a public route matched. */
function isPublicRequest(request: FastifyRequest): boolean {
  const routeUrl = request.routeOptions?.url;
  return (
    isPublicPath(request.url) ||
    (routeUrl !== undefined && (routeUrl === PUBLIC_API_ROUTE_PREFIX || routeUrl.startsWith(`${PUBLIC_API_ROUTE_PREFIX}/`)))
  );
}

/** A path segment shown as itself: a schema's camelCase key. Anything else (a caller's text) is UNKNOWN_KEY. */
const SCHEMA_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const UNKNOWN_KEY = "<unknown>";

/** One issue of a public 400's details (D25 Ruling 175): where, and Zod's code, never a value. */
export interface PublicValidationIssue {
  path: Array<string | number>;
  code: string;
}

/**
 * A Zod validation failure's details for the public surface (D25 decision
 * 20, Ruling 175): each issue's path (the field's keys and indexes) and
 * Zod's code, nothing else. No message, `received`, `params` or `keys`,
 * so no value the caller sent, an enum's, an unknown key's name or a
 * pasted `tf_` token, comes back in an error. An unrecognized key is
 * named UNKNOWN_KEY, and so is any path segment that isn't a schema's
 * camelCase key (belt and braces: a record's key would be the caller's).
 */
export function publicValidationDetails(validation: readonly unknown[]): PublicValidationIssue[] {
  return validation.map((item) => {
    const issue = (item as { params?: { issue?: { code?: unknown; path?: unknown } } } | null)?.params?.issue;
    const code = typeof issue?.code === "string" ? issue.code : "invalid";
    const path: Array<string | number> = (Array.isArray(issue?.path) ? (issue.path as unknown[]) : []).map((segment) =>
      typeof segment === "number" ? segment : typeof segment === "string" && SCHEMA_KEY.test(segment) ? segment : UNKNOWN_KEY,
    );
    if (code === "unrecognized_keys") path.push(UNKNOWN_KEY);
    return { path, code };
  });
}

/** One entry of a public refusal's details in the routes' and services' own fixed words (D25 Ruling 187). */
export interface PublicRefusalIssue {
  path: Array<string | number>;
  message: string;
}

/** The fleets area's entry (fleets/errors.ts' fieldDetail, Zod-like for the browser): its path and fixed words only. */
function fieldDetailIssue(item: unknown): PublicRefusalIssue | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { keyword, message, params } = item as { keyword?: unknown; message?: unknown; params?: { issue?: { path?: unknown } } };
  const path = params?.issue?.path;
  if (keyword !== "custom" || typeof message !== "string" || !Array.isArray(path)) return undefined;
  if (!path.every((segment) => typeof segment === "string" || typeof segment === "number")) return undefined;
  return { path: [...(path as Array<string | number>)], message };
}

/**
 * An AppError's details as the public surface answers them (D25 Ruling
 * 187): a 400 `invalid_request` carries exactly one of two shapes, Zod's
 * issues as `{ path, code }` (publicValidationDetails, Ruling 175) or a
 * route's or a service's own refusal as `{ path, message }`, the message
 * its fixed words. The fleets area's entries (fieldDetail: a Zod-like
 * issue, which the browser's screens read) become `{ path, message }`;
 * every other entry and every non-array details object (a rule's index,
 * a validation's errors) is left as it is.
 */
export function publicRefusalDetails(details: unknown): unknown {
  if (!Array.isArray(details)) return details;
  return details.map((item: unknown) => fieldDetailIssue(item) ?? item);
}

/**
 * The 404 for a request no route matched, in the envelope: the root's, and
 * the public surface's plugin's after its token check (D25 Preflight ruling
 * 3: the root's words). The URL as the request log spells it (D17c-2
 * Preflight ruling 11): a mistyped quick-deploy link's reply never echoes
 * its secret, nor an OIDC callback's, a fleet route's or a public route's
 * query, whoever reads the reply on its way back (a proxy's or a client's
 * log).
 */
export function sendNotFound(request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send({
    error: { code: "not_found", message: `No route for ${request.method} ${loggedRequestUrl(request.url, undefined)}` },
  });
}

/**
 * Fastify's `frameworkErrors` (server.ts): a request the router refused
 * before any route or hook ran — a malformed percent-escape
 * (FST_ERR_BAD_URL, 400), a parameter over `maxParamLength`
 * (FST_ERR_MAX_PARAM_LENGTH, 414), a failed async constraint (500).
 * Fastify's own reply quotes the path, which may hold a quick-deploy
 * link's secret (D17c-2) or a library link (D23-2 decision 47): this one
 * answers generic words and logs the error's code only, never its message
 * (which quotes the path) or the URL. On a path that may hold either
 * (request-log.ts' urlMayHoldPublicLinkSecret), the words are
 * the public route's plain text with its headers (no-store, nosniff,
 * no-referrer: D17c-2 Ruling 36), as its own refusals; elsewhere the
 * envelope, `no-store` on a path under `/api/public/v1` (D25 Ruling 187). The request's own log line goes through the request log's
 * redaction (request-log.ts).
 */
export function respondToFrameworkError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const isServerError = !(typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500);
  if (isServerError) request.log.error({ code: error.code }, "unhandled error");
  else request.log.warn({ code: error.code }, "client error");
  const statusCode = isServerError ? 500 : (error.statusCode as number);
  const code = isServerError ? "internal_error" : genericClientErrorCode(statusCode);
  const message = isServerError ? INTERNAL_ERROR_MESSAGE : genericClientErrorMessage(statusCode);
  if (urlMayHoldPublicLinkSecret(request.url, undefined)) {
    void sendPlainTextRefusal(reply, statusCode, message);
    return;
  }
  // The public surface's replies are never cached (D25 Ruling 185), its router's refusals included (Ruling 187).
  if (isPublicPath(request.url)) void reply.header("cache-control", "no-store");
  void reply.status(statusCode).send({ error: { code, message } });
}

const INTERNAL_ERROR_MESSAGE = "Something went wrong. Please try again.";

/**
 * A small, stable vocabulary for the 4xx errors Fastify itself can raise
 * before a route's own schema or handler runs. Deliberately coarse — this
 * is not meant to enumerate every FastifyErrorCode, only to give the
 * common cases (and any future one) a status-appropriate machine code
 * instead of "internal_error".
 */
function genericClientErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 414:
      return "uri_too_long";
    default:
      return "invalid_request";
  }
}

function genericClientErrorMessage(statusCode: number): string {
  switch (statusCode) {
    case 413:
      return "The request body is too large.";
    case 415:
      return "Unsupported content type.";
    case 414:
      return "The request's URL is too long.";
    default:
      return "The request was not valid.";
  }
}
