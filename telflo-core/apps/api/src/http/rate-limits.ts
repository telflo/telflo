import rateLimit from "@fastify/rate-limit";
import {
  VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER,
  type AccountErrorCode,
  type SessionErrorCode,
} from "@telflo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { requireAuthentication } from "../modules/sessions/authenticate.js";
import { createFailureLimiter, DEFAULT_FAILURE_LIMITER_MAX_KEYS, type FailureLimiter } from "./failure-limiter.js";

/** One limit: at most `max` requests per key in each `windowMs`. */
export interface RateLimit {
  max: number;
  windowMs: number;
}

export interface RateLimits {
  /**
   * Sign-in, register, verify-email, the password-reset endpoints and
   * resending the confirmation email together, per client IP.
   */
  identityPerIp: RateLimit;
  /** Refresh, per client IP. */
  refreshPerIp: RateLimit;
  /**
   * Failed sign-ins (wrong password or unknown address), per email address,
   * and wrong current passwords given in Settings for the signed-in
   * account's address, in the same budget. Here `max` counts failures, not
   * requests.
   */
  signInPerEmail: RateLimit;
  /**
   * Requests to the email endpoints (a reset link, another confirmation
   * email), per submitted address, whether or not it has an account. Here
   * `max` counts every request.
   */
  emailPerAddress: RateLimit;
  /**
   * Invitation emails, invites and resends together, per inviting user. Here
   * `max` counts every request that reaches the limit.
   */
  invitationEmailsPerUser: RateLimit;
  /**
   * The sales inquiries' contact form, per client IP. Here `max` counts every
   * request, a honeypot or an invalid body included.
   */
  salesInquiriesPerIp: RateLimit;
  /**
   * A version's validations, per person, counted after the read and before
   * the validator is asked; a retired answer counts too. Here `max` counts
   * every check that reaches the limit.
   */
  validationsPerUser: RateLimit;
  /**
   * The flows' security lint, per product admin, counted once the request is
   * a product admin's. Here `max` counts every lint that reaches the limit.
   */
  flowLintsPerUser: RateLimit;
  /**
   * Test file uploads and pasted samples together, per person, per
   * organization, counted after the session, the terms and the organization's
   * check and before the body is read. The heads of a test file, a run's input
   * and a definition's input, and a definition's create, count with them. Here
   * `max` counts every upload that reaches the limit.
   */
  testFileUploadsPerUser: RateLimit;
  /**
   * Test runs queued, per person, per organization (20 a minute), counted
   * after the run's checks (session, membership, version, pin, input, the
   * tester's down state) and before the cap of waiting runs. A run from a
   * suite's definition isn't counted. A run refused before its input is copied
   * gives its count back; one whose copy began keeps it spent. Here `max`
   * counts every run that reaches the limit.
   */
  testRunsPerUser: RateLimit;
  /**
   * Saves of a validation rule the OTTL evaluator checks (its regex or
   * OTTL), per person, per organization, counted after the save's read and
   * checks and just before the evaluator is asked, and never given back. A
   * save that needs no check (a text rule, a rename) isn't counted. Here
   * `max` counts every check that reaches the limit.
   */
  validationRuleChecksPerUser: RateLimit;
  /**
   * The fleet routes' reads, per person, per organization: every GET of
   * theirs, a configuration's fleet usage and a configuration delete's usage
   * check included. Counted after the platform's own checks (the session, the
   * terms, the organization, the path's ids, the body) and just before the
   * first call to the opamp-server. Here `max` counts every read that reaches
   * the limit.
   */
  fleetReadsPerUser: RateLimit;
  /**
   * The fleet routes' writes but the four bearer replies, per person, per
   * organization, counted as the reads are.
   */
  fleetWritesPerUser: RateLimit;
  /**
   * The four replies that carry a bearer (a fleet's create, a token's
   * reveal, a rotation and a new default token), one count for all
   * four, per person, per organization; each spends only this count.
   */
  fleetBearerRepliesPerUser: RateLimit;
  /**
   * The public download, per client IP: every request to the route, unknown
   * and refused secrets included, counted in an `onRequest` hook before
   * anything else is read.
   */
  quickDeployPerIp: RateLimit;
  /**
   * The public download, per link: every attempt on a link found by its
   * secret, counted after the lookup, whatever then refuses it. Here `max`
   * counts every attempt that reaches the limit.
   */
  quickDeployPerLink: RateLimit;
  /**
   * The public logo read, per client IP: every request to the route
   * counted in an `onRequest` hook before anything is read. Generous:
   * every signed-in page shows logos.
   */
  organizationLogosPerIp: RateLimit;
  /**
   * A library file's downloads, per person, counted after the session and the
   * terms and before the file is looked up. Here `max` counts every download
   * that reaches the limit.
   */
  libraryFileDownloadsPerUser: RateLimit;
  /**
   * New library links, per person, counted after the session and the terms and
   * before the file is looked up. Here `max` counts every link asked for that
   * reaches the limit.
   */
  libraryFileLinksPerUser: RateLimit;
  /**
   * The library link's public route, per client IP: every request counted in
   * an `onRequest` hook before the link is read, a malformed or forged one's
   * included.
   */
  libraryLinksPerIp: RateLimit;
  /**
   * The library link's downloads, per link: every attempt on a link a key
   * signed, keyed by its file's id and its expiry (never the link), counted
   * after the check, whatever then refuses it.
   */
  libraryLinkDownloadsPerLink: RateLimit;
  /**
   * The public surface's token check, per client IP: every request carrying an
   * `Authorization` header counts one failure up front, before the lookup, and
   * a request whose token is accepted takes its own count back. Here `max`
   * counts failures.
   */
  apiTokenFailuresPerIp: RateLimit;
  /**
   * The public surface's requests, per token: every request to a route of the
   * `/api/public/v1/` plugin, a 404 after the check included, counted right
   * after the token check accepts it, keyed by the token's id (never the
   * bearer), before anything else runs. `/health`, `/openapi.json` and the
   * reference page are outside it.
   */
  publicApiPerToken: RateLimit;
  /**
   * The public surface's OTTL lints, per person, per organization: counted
   * once a lint request has passed its checks and just before its first call
   * to the OTTL evaluator (a YAML that holds no expression calls none and
   * counts nothing). Here `max` counts every lint that reaches the limit.
   */
  ottlLintsPerUser: RateLimit;
  /**
   * The public surface's anonymous validations, per client IP (`request.ip`,
   * which honours the trusted hops): every request to
   * `POST /api/public/v1/validate/anonymous` that passed its body's checks,
   * counted before the catalogue's reads, with
   * ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP at once. Here `max` counts every
   * request admitted; a refusal (this level's or the overall's) counts
   * nothing.
   */
  anonymousValidationsPerIp: RateLimit;
  /**
   * The same requests across every anonymous caller, with
   * ANONYMOUS_VALIDATIONS_IN_FLIGHT at once, so the validator keeps room for
   * signed-in validations. Checked with the per-address level before either
   * is recorded.
   */
  anonymousValidations: RateLimit;
  /**
   * A product admin's writes: grants, removals, acknowledgements and
   * dismissals together, per product admin, counted after the body's
   * validation and the gate. Here `max` counts every write that reaches the
   * limit.
   */
  productAdminWritesPerUser: RateLimit;
  /** A product admin's deletes of people, per product admin, counted as the writes are. */
  productAdminDeletesPerUser: RateLimit;
  /**
   * "Contact us", per person, counted after the session, the terms and
   * the body's validation. Here `max` counts every message that reaches
   * the limit.
   */
  feedbackPerUser: RateLimit;
  /**
   * The open flow read, per client IP (`request.ip`, which honours the trusted
   * hops): every request to `GET /api/v1/published-flows` and
   * `GET /api/v1/published-flows/:slug` together, one count for both, in an
   * `onRequest` hook before anything is read (an unknown slug's request counts
   * too). Never the showcase's (`/api/v1/flow-showcase`), which the web server
   * calls from its own address for every landing view.
   */
  publishedFlowReadsPerIp: RateLimit;
}

const MINUTE_MS = 60_000;

/**
 * At most this many of a person's validations wait on the validator at once,
 * so one person can't hold its slots (it runs eight). Not a test override:
 * every server, test servers included, has the real number.
 */
export const VALIDATIONS_IN_FLIGHT_PER_USER = 2;

/**
 * At most this many of a person's fleet requests in one organization wait on
 * the opamp-server at once, whatever each calls (a request is one slot). The
 * fleet screens poll every 15 seconds: the fleet list one read; a fleet's page
 * at most four at once (its fleet, with the Tokens tab its tokens, its
 * history's first page and its install links' first page; with the Collectors
 * tab its collectors' page and its groups, with the Groups tab its groups).
 * Three browser tabs aligned (a restored session) send at most 12, a person's
 * write in each at most 15, within 16. Not a test override.
 */
export const FLEET_REQUESTS_IN_FLIGHT_PER_USER = 16;

/**
 * At most this many of one address's anonymous validations at once, and this
 * many of all anonymous callers' (the validator runs eight: four stay for
 * signed-in validations). Not a test override: every server, test servers
 * included, has the real numbers.
 */
export const ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP = 1;
export const ANONYMOUS_VALIDATIONS_IN_FLIGHT = 4;

/**
 * The per-IP numbers for sign-in and sign-up, token verification and token
 * refresh. The invitation limit: with no member cap anyone signed up could
 * otherwise use invitations to mail any address. The sales inquiry limit
 * has no per-instance cap. The test runs' 20 a minute, the uploads' 30 a
 * minute and the rule checks' 30 a minute. The fleet routes': 240 reads and
 * 240 writes a minute, against the fleet screens polling every 15 seconds
 * in a few tabs (16 reads a minute a tab), and 10 bearer replies, a
 * create's, a reveal's, a rotation's or a new default token's. The flow
 * lint's (`/api/v1/flows/lint`) is 20 a minute, keyed by the signed-in
 * product admin. The public download's: 30 requests a minute per IP and 60
 * downloads a minute per link. The token check's 30 failures per 5 minutes
 * per IP, sign-in's per-IP bucket's size. The public logo read's 600 a
 * minute per IP, and the library's: 60 downloads and 30 links a minute per
 * person, and the link's public route as quick-deploy's, 30 requests a
 * minute per IP and 60 downloads a minute per link. The public surface's 60
 * requests a minute per token, and its OTTL lints' 30 a minute per person
 * per organization, on top of the token's 60. The anonymous validations' 10
 * a minute per address and 120 a minute overall. A product admin's 30
 * writes and 10 deletes a minute, and a person's 10 feedback messages an
 * hour. The open flow read's 60 a minute per address. Production always
 * runs with these; buildServer's override is for tests.
 */
export const RATE_LIMITS: RateLimits = {
  identityPerIp: { max: 30, windowMs: 5 * MINUTE_MS },
  refreshPerIp: { max: 150, windowMs: 5 * MINUTE_MS },
  signInPerEmail: { max: 10, windowMs: 15 * MINUTE_MS },
  emailPerAddress: { max: 5, windowMs: 60 * MINUTE_MS },
  invitationEmailsPerUser: { max: 50, windowMs: 60 * MINUTE_MS },
  salesInquiriesPerIp: { max: 3, windowMs: 10 * MINUTE_MS },
  validationsPerUser: { max: 60, windowMs: MINUTE_MS },
  flowLintsPerUser: { max: 20, windowMs: MINUTE_MS },
  testFileUploadsPerUser: { max: 30, windowMs: MINUTE_MS },
  testRunsPerUser: { max: 20, windowMs: MINUTE_MS },
  validationRuleChecksPerUser: { max: VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER, windowMs: MINUTE_MS },
  fleetReadsPerUser: { max: 240, windowMs: MINUTE_MS },
  fleetWritesPerUser: { max: 240, windowMs: MINUTE_MS },
  fleetBearerRepliesPerUser: { max: 10, windowMs: MINUTE_MS },
  quickDeployPerIp: { max: 30, windowMs: MINUTE_MS },
  quickDeployPerLink: { max: 60, windowMs: MINUTE_MS },
  organizationLogosPerIp: { max: 600, windowMs: MINUTE_MS },
  libraryFileDownloadsPerUser: { max: 60, windowMs: MINUTE_MS },
  libraryFileLinksPerUser: { max: 30, windowMs: MINUTE_MS },
  libraryLinksPerIp: { max: 30, windowMs: MINUTE_MS },
  libraryLinkDownloadsPerLink: { max: 60, windowMs: MINUTE_MS },
  apiTokenFailuresPerIp: { max: 30, windowMs: 5 * MINUTE_MS },
  publicApiPerToken: { max: 60, windowMs: MINUTE_MS },
  ottlLintsPerUser: { max: 30, windowMs: MINUTE_MS },
  anonymousValidationsPerIp: { max: 10, windowMs: MINUTE_MS },
  anonymousValidations: { max: 120, windowMs: MINUTE_MS },
  productAdminWritesPerUser: { max: 30, windowMs: MINUTE_MS },
  productAdminDeletesPerUser: { max: 10, windowMs: MINUTE_MS },
  feedbackPerUser: { max: 10, windowMs: 60 * MINUTE_MS },
  publishedFlowReadsPerIp: { max: 60, windowMs: MINUTE_MS },
};

/**
 * For every test server that is not testing rate limiting. Each integration
 * file shares one server that registers and signs in many users from one
 * address, so the production limits would fail unrelated tests with 429.
 */
export const TEST_RATE_LIMITS: RateLimits = {
  identityPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  refreshPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  signInPerEmail: { max: 1_000_000, windowMs: MINUTE_MS },
  emailPerAddress: { max: 1_000_000, windowMs: MINUTE_MS },
  invitationEmailsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  salesInquiriesPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  validationsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  flowLintsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  testFileUploadsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  testRunsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  validationRuleChecksPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  fleetReadsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  fleetWritesPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  fleetBearerRepliesPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  quickDeployPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  quickDeployPerLink: { max: 1_000_000, windowMs: MINUTE_MS },
  organizationLogosPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  libraryFileDownloadsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  libraryFileLinksPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  libraryLinksPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  libraryLinkDownloadsPerLink: { max: 1_000_000, windowMs: MINUTE_MS },
  apiTokenFailuresPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  publicApiPerToken: { max: 1_000_000, windowMs: MINUTE_MS },
  ottlLintsPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  anonymousValidationsPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
  anonymousValidations: { max: 1_000_000, windowMs: MINUTE_MS },
  productAdminWritesPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  productAdminDeletesPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  feedbackPerUser: { max: 1_000_000, windowMs: MINUTE_MS },
  publishedFlowReadsPerIp: { max: 1_000_000, windowMs: MINUTE_MS },
};

export const RATE_LIMITED_MESSAGE = "Too many attempts. Please wait and try again.";

type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Sign-in's per-email limit: only failed sign-ins count, and a successful
 * one clears the address. The preHandler counts each attempt it admits as a
 * failure up front, so concurrent attempts cannot all slip past the check
 * while their passwords are still being verified; the handler then settles
 * the attempt with exactly one of the other two calls.
 */
export interface SignInPerEmailLimiter {
  /**
   * `preHandler` hook: it needs the parsed, validated body. Refuses with 429
   * while the address is blocked, otherwise counts the attempt as a failure.
   */
  preHandler: RateLimitHook;
  /** The sign-in succeeded: the address starts again from zero. */
  succeeded(email: string): void;
  /**
   * The sign-in threw `error`. Only `invalid_credentials` (a wrong password
   * or an unknown address) keeps the attempt's count; anything else —
   * `email_not_verified`, whose password was right, or a server failure —
   * takes it back.
   */
  failed(email: string, error: unknown): void;
  /**
   * The session-keyed form, for the routes that ask for the current password:
   * a `preHandler` placed after `authenticate`, keyed on the signed-in
   * account's email as the session check read it, never on anything in the
   * body. It counts against sign-in's own failures, so the sign-in form and
   * Settings share one budget per address. Refuses with 429 while the address
   * is blocked, otherwise counts one failure up front; the handler then
   * settles the request exactly once (in a `finally`) with one of the two
   * calls below.
   */
  reauthenticationPreHandler: RateLimitHook;
  /** The current password was verified: the address starts again from zero, as after a successful sign-in. */
  reauthenticated(email: string): void;
  /**
   * Anything else. Only `current_password_incorrect` (a wrong password, or
   * one that changed since it was verified) keeps the count; any other
   * outcome (a 404, a 409, a 503, a server failure) takes it back.
   */
  reauthenticationSettled(email: string, error: unknown): void;
}

/** Why a validation was refused, for the service to answer 429. */
export type ValidationAdmission =
  /** Admitted and counted. `release` frees its in-flight slot, once; a no-op when it took none. */
  | { isAdmitted: true; release: () => void }
  /** Over the person's checks in the window: retry once it ends. */
  | { isAdmitted: false; reason: "per_minute"; retryAfterSeconds: number }
  /** VALIDATIONS_IN_FLIGHT_PER_USER of theirs are waiting on the validator already. */
  | { isAdmitted: false; reason: "in_flight"; retryAfterSeconds: number };

/**
 * A person's validations: 60 a minute, and at most two waiting on the
 * validator at once. In memory, per API process, as every limit is.
 */
export interface ValidationLimiter {
  /**
   * Admits one check by `userId`, or says why not. Synchronous, so a check
   * and its count never interleave with another request's. A check that
   * asks the validator (`callsValidator`) also takes one of the person's
   * in-flight slots, which `release` gives back; a retired answer takes
   * none, but counts toward the minute. A refusal counts nothing.
   */
  admit(userId: string, options: { callsValidator: boolean }): ValidationAdmission;
}

/** Which of the fleet limits a request spends. */
export type FleetRequestKind = "read" | "write" | "bearer";

/** A fleet request's admission: `release` frees its in-flight slot, once. */
export type FleetAdmission =
  | { isAdmitted: true; release: () => void }
  /** Over the person's count of its kind in the window: retry once it ends. */
  | { isAdmitted: false; reason: "per_minute"; retryAfterSeconds: number }
  /** FLEET_REQUESTS_IN_FLIGHT_PER_USER of theirs in the organization are waiting already. */
  | { isAdmitted: false; reason: "in_flight"; retryAfterSeconds: number };

/**
 * A person's fleet requests in one organization: a count a minute for reads,
 * one for writes and one for the four bearer replies, and at most
 * FLEET_REQUESTS_IN_FLIGHT_PER_USER requests in flight across the three
 * counts. In memory, per API process, as every limit is.
 */
export interface FleetLimiter {
  /**
   * Admits one request of `kind` by the person in the organization, or says
   * why not. Synchronous, so a check and its count never interleave with
   * another request's. An admission counts one of its kind and takes a
   * slot, which `release` gives back (in a `finally`); a refusal counts
   * nothing and takes no slot. An admission's count is never refunded,
   * whatever the request then does.
   */
  admit(userId: string, organizationId: string, kind: FleetRequestKind): FleetAdmission;
}

/** The hooks a route attaches to take part in a limit. */
export interface RateLimiters {
  /**
   * `onRequest` hook for sign-in, register, verify-email, the password-reset
   * endpoints and resending the confirmation email. One hook instance, and so
   * one bucket, shared by all of them.
   */
  identityPerIp: RateLimitHook;
  /** `onRequest` hook for refresh. */
  refreshPerIp: RateLimitHook;
  signInPerEmail: SignInPerEmailLimiter;
  /**
   * `preHandler` hook for the email endpoints: it needs the validated body,
   * so a body refused by validation is not counted. One instance, and so one
   * budget, shared by every route that sends email.
   */
  emailPerAddress: RateLimitHook;
  /**
   * Counts one invitation email for the user, or throws the 429, with its
   * `retry-after`, when they have none left. Not a hook: the organization
   * service calls it once the request has passed the active-organization
   * and role checks, so a path naming another organization still gets its
   * 404 first.
   */
  invitationEmailsPerUser(userId: string): void;
  /**
   * `onRequest` hook for the sales inquiry endpoint: its own store, so it
   * shares nothing with the identity routes' bucket.
   */
  salesInquiriesPerIp: RateLimitHook;
  /**
   * A version's validations. Not a hook: the validation service admits a
   * check after its read, so a path naming a version the caller can't see
   * still gets its 404 first, and the refusal is its own 429
   * `validation_rate_limited`.
   */
  validationsPerUser: ValidationLimiter;
  /**
   * Counts one flow lint for the product admin, or throws the 429, with its
   * `retry-after`, when they have none left. Not a hook: the lint route
   * calls it after `requireProductAdmin`, so a request refused for its
   * session or the flag counts nothing.
   */
  flowLintsPerUser(userId: string): void;
  /**
   * Counts one test file upload or sample for the person in the
   * organization, or throws the 429 `rate_limited`, with its `retry-after`,
   * when they have none left there (a person's uploads in one organization
   * never spend another's). Not a hook: the upload's preHandler calls it
   * after `authenticate`, the terms and the organization's check, so a
   * request refused for any of those counts nothing, and before the body is
   * read. A route with no organization (the global templates') passes null:
   * the person's own count, apart from every organization's.
   */
  testFileUploadsPerUser(userId: string, organizationId: string | null): void;
  /**
   * A queued run's limit, per person, per organization. Not a hook: the runs
   * service admits a run after its checks, so a path naming a version the
   * caller can't see still gets its 404 first, and the refusal is its own 429
   * `test_run_rate_limited`. An admission counts; a refusal counts nothing.
   */
  testRunsPerUser: PerUserLimiter;
  /**
   * A validation rule's checked saves, per person, per organization; a
   * regex library entry's per person alone (`admit(userId, null)`). Not a
   * hook: the rules service admits a check after its read, so a path naming
   * a pipeline the caller can't see still gets its 404 first, and the
   * refusal is its own 429 `validation_rule_rate_limited`. An admission
   * counts and is never refunded: the evaluator was asked.
   */
  validationRuleChecksPerUser: PerUserLimiter;
  /**
   * The fleet routes' requests. Not a hook: the fleets service admits a
   * request after the platform's own checks (the organization, the path's ids,
   * the body, a version's resolution), so a path naming another organization
   * still gets its 404 first, and just before its first call to the
   * opamp-server. A published configuration's delete spends a read of it too,
   * after its rights' read, for its fleet usage check. The refusal is the
   * generic 429 `rate_limited` with Retry-After.
   */
  fleetsPerUser: FleetLimiter;
  /**
   * `onRequest` hook for the public download, per client IP: it runs before
   * the secret is read, so every request counts, an unknown or malformed
   * secret's included. Its 429 carries Retry-After; the route's own error
   * handler answers it in plain text (public-download.ts).
   */
  quickDeployPerIp: RateLimitHook;
  /**
   * The public download's count per link. Not a hook: the route counts an
   * attempt once the secret's lookup has found the link, keyed by its id
   * (never the secret), before any other refusal.
   */
  quickDeployPerLink: PerKeyLimiter;
  /**
   * `onRequest` hook for the public logo read, per client IP, before the ids
   * are read; its 429 carries Retry-After and is answered in plain text by the
   * route's error handler.
   */
  organizationLogosPerIp: RateLimitHook;
  /**
   * Counts one download of a library file for the person, or throws the
   * 429 `rate_limited`, with its `retry-after`, when they have none left.
   * Not a hook: the route calls it after `authenticate` and the terms,
   * before the file is looked up.
   */
  libraryFileDownloadsPerUser(userId: string): void;
  /**
   * Counts one new library link for the person, or throws the 429, as
   * libraryFileDownloadsPerUser.
   */
  libraryFileLinksPerUser(userId: string): void;
  /**
   * `onRequest` hook for the library link's public route, per client IP,
   * before the link is read; its 429 carries Retry-After and is answered in
   * plain text by the route's error handler.
   */
  libraryLinksPerIp: RateLimitHook;
  /**
   * The library link's count per link. Not a hook: the route counts an
   * attempt once the link's check has passed, keyed by `${fileId}:${expiry}`,
   * never the link.
   */
  libraryLinkDownloadsPerLink: PerKeyLimiter;
  /**
   * The token check's failures per client IP. Not a hook: the check
   * (modules/public-api/) calls it before it reads the header, so a blocked
   * address is refused before its header is read, and a request with no header
   * counts nothing.
   */
  apiTokenFailuresPerIp: ApiTokenFailureLimiter;
  /**
   * The public surface's per-token count. Not a hook: the plugin's `onRequest`
   * counts `token:<tokenId>` right after the token check accepts a request,
   * with the generic 429 `rate_limited` and its Retry-After.
   */
  publicApiPerToken: PerKeyLimiter;
  /**
   * The public surface's OTTL lints, per person, per organization. Not a
   * hook: the lint service admits a lint once its request has passed its
   * checks, just before the evaluator is asked; the refusal is the generic
   * 429 `rate_limited` with Retry-After. An admission counts and is never
   * refunded.
   */
  ottlLintsPerUser: PerUserLimiter;
  /**
   * The public surface's anonymous validations: per address and overall, each
   * a minute's count and slots in flight. Not a hook: the route admits a
   * request once its body passed its checks, before the catalogue's reads; the
   * refusal is the generic 429 `rate_limited` with Retry-After.
   */
  anonymousValidations: AnonymousValidationLimiter;
  /**
   * Counts one product-admin write for the caller, or throws the 429
   * `rate_limited`, with its `retry-after`, when they have none left. Not a
   * hook: the service calls it after the body's validation and the gate, so
   * a refused request counts nothing.
   */
  productAdminWritesPerUser(userId: string): void;
  /** Counts one delete of a person for the product admin, or throws the 429, as productAdminWritesPerUser. */
  productAdminDeletesPerUser(userId: string): void;
  /** Counts one feedback message for the person, or throws the 429, as productAdminWritesPerUser. */
  feedbackPerUser(userId: string): void;
  /**
   * `onRequest` hook for the open flow read's two routes, per client IP: one
   * hook instance, so one bucket, shared by the list and the slug, run before
   * the slug is read. Its 429 is the generic `rate_limited` with Retry-After.
   */
  publishedFlowReadsPerIp: RateLimitHook;
}

/**
 * The token check's failure budget, per client IP. Counted UP FRONT: a request
 * carrying an `Authorization` header counts one attempt before its token is
 * looked up, so a burst of parallel guesses can't all pass the check while
 * their lookups are in flight (counted after the lookup, 200 parallel bad
 * tokens were all looked up; up front, 30 were). An attempt is IN FLIGHT until
 * the check settles it: refused, it becomes a settled failure in the address's
 * window; accepted (or its lookup threw), it is taken back, and only it (never
 * a reset: the window and the address's other failures stand). The address is
 * blocked while its settled failures and its attempts in flight together reach
 * the limit. Blocked by settled failures, the 429's Retry-After is the
 * window's remaining time; blocked only because of attempts in flight, which
 * settle within a lookup's time, it is 1 second: more than `max` concurrent
 * requests from one address are refused, valid tokens' included, and told to
 * retry at once. Keyed by `request.ip`, which honors the trusted hop count,
 * never by the token: the budget is the address's.
 */
export interface ApiTokenFailureLimiter {
  /** Throws the 429 `rate_limited`, with its Retry-After, while the address is blocked. Counts nothing. */
  assertNotBlocked(ip: string): void;
  /** Counts one attempt in flight for the address, before its lookup; the check settles it once. */
  begin(ip: string): ApiTokenAttempt;
}

/** One request's count, in flight until settled; settling it again does nothing. */
export interface ApiTokenAttempt {
  /** The token was refused: the attempt becomes a settled failure in the address's window. */
  fail(): void;
  /** The token was accepted, or its lookup threw: the attempt is taken back, and nothing is counted. */
  refund(): void;
}

/** The Retry-After of a 429 caused only by attempts in flight: they settle within a lookup's time (as the validations' in-flight refusal's). */
const API_TOKEN_IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * In memory, per API process, as every limit. Settled failures are bounded
 * as createFailureLimiter is; attempts in flight hold a key only while a
 * request is in its lookup, and are forgotten at zero.
 */
export function createApiTokenFailureLimiter(limit: RateLimit, options: { now?: () => number } = {}): ApiTokenFailureLimiter {
  const settled = createFailureLimiter({ max: limit.max, windowMs: limit.windowMs, ...options });
  const inFlight = new Map<string, number>();
  const key = (ip: string) => `ip:${ip}`;
  const leaveFlight = (address: string) => {
    const remaining = (inFlight.get(address) ?? 0) - 1;
    if (remaining > 0) inFlight.set(address, remaining);
    else inFlight.delete(address);
  };
  return {
    assertNotBlocked(ip) {
      const address = key(ip);
      const result = settled.check(address);
      if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
      if (settled.count(address) + (inFlight.get(address) ?? 0) >= limit.max) {
        throw rateLimited(API_TOKEN_IN_FLIGHT_RETRY_AFTER_SECONDS);
      }
    },
    begin(ip) {
      const address = key(ip);
      inFlight.set(address, (inFlight.get(address) ?? 0) + 1);
      let isSettled = false;
      const settle = (outcome: "failed" | "refunded") => {
        if (isSettled) return;
        isSettled = true;
        leaveFlight(address);
        if (outcome === "failed") settled.recordFailure(address);
      };
      return { fail: () => settle("failed"), refund: () => settle("refunded") };
    },
  };
}

/**
 * A limit's key for a person in an organization, or the person alone (null) on
 * a route with no organization. Ids are UUIDs, so no two pairs share a key.
 */
function personInOrganizationKey(userId: string, organizationId: string | null): string {
  return organizationId === null ? `user:${userId}` : `organization:${organizationId}:user:${userId}`;
}

/**
 * A count per person per organization, or per person alone when the
 * organization is null, that the caller refuses with its own error (the test
 * runs' limit).
 */
export interface PerUserLimiter {
  /**
   * Admits and counts one for the person in the organization (their count
   * in one organization is apart from another's), or for the person alone
   * (`null`) on a route with no organization (the regex library's checked
   * saves): a count apart from every organization's. Or says when to retry.
   * Synchronous: a check and its count never interleave. An admission the
   * caller then refuses for another reason is given back with `refund`: a
   * refusal doesn't spend the limit. Refunding twice gives back one, and a
   * refund after the admission's window has ended gives nothing (never a
   * count of the window that followed): it is tied to the window the
   * admission was counted in, by when that window opened.
   */
  admit(
    userId: string,
    organizationId: string | null,
  ): { isAdmitted: true; refund: () => void } | { isAdmitted: false; retryAfterSeconds: number };
}

/** A fixed-window count per person, per organization, that the caller refuses with its own error. */
export function createPerUserLimiter(limit: RateLimit, options: { now?: () => number } = {}): PerUserLimiter {
  const counts = createFailureLimiter({ max: limit.max, windowMs: limit.windowMs, ...options });
  return {
    admit(userId, organizationId) {
      const key = personInOrganizationKey(userId, organizationId);
      const result = counts.check(key);
      if (result.isBlocked) return { isAdmitted: false, retryAfterSeconds: result.retryAfterSeconds };
      // The window this admission counts in, not a later reading of the
      // clock: a clock that ticks past the window's end between the two
      // would let the refund take from the next window.
      const windowStartedAt = counts.recordFailure(key);
      let isRefunded = false;
      return {
        isAdmitted: true,
        refund: () => {
          if (isRefunded) return;
          isRefunded = true;
          counts.refund(key, windowStartedAt);
        },
      };
    },
  };
}

/**
 * A count per key that throws the generic 429 (a public download's per-link
 * limit, among others). In memory, per API process, as every limit, and
 * bounded: at most `maxKeys` keys are held (DEFAULT_FAILURE_LIMITER_MAX_KEYS
 * unless told otherwise), the oldest window dropped first
 * (createFailureLimiter's rule).
 */
export interface PerKeyLimiter {
  /**
   * Counts one attempt for `key`, or throws the 429 `rate_limited`, with
   * its Retry-After, when the key has none left in its window; a refusal
   * counts nothing. Synchronous, so a check and its count never interleave
   * with another request's. Never refunded: every attempt counts.
   */
  count(key: string): void;
  /** How many keys are held (for tests of the bound). */
  readonly size: number;
}

export function createPerKeyLimiter(limit: RateLimit, options: { maxKeys?: number; now?: () => number } = {}): PerKeyLimiter {
  const counts = createFailureLimiter({
    max: limit.max,
    windowMs: limit.windowMs,
    maxKeys: options.maxKeys ?? DEFAULT_FAILURE_LIMITER_MAX_KEYS,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    count(key) {
      const result = counts.check(key);
      if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
      counts.recordFailure(key);
    },
    get size() {
      return counts.size;
    },
  };
}

/** The validations' in-flight refusal: the in-flight checks end within the client's timeout, so a second is enough to wait. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/** The per-minute count and the in-flight slots, per person. */
export function createValidationLimiter(limit: RateLimit, options: { now?: () => number } = {}): ValidationLimiter {
  const checks = createFailureLimiter({ max: limit.max, windowMs: limit.windowMs, ...options });
  const inFlight = new Map<string, number>();
  return {
    admit(userId, { callsValidator }) {
      const minute = checks.check(userId);
      if (minute.isBlocked) return { isAdmitted: false, reason: "per_minute", retryAfterSeconds: minute.retryAfterSeconds };
      const held = inFlight.get(userId) ?? 0;
      if (callsValidator && held >= VALIDATIONS_IN_FLIGHT_PER_USER) {
        return { isAdmitted: false, reason: "in_flight", retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS };
      }
      checks.recordFailure(userId);
      if (!callsValidator) return { isAdmitted: true, release: () => undefined };
      inFlight.set(userId, held + 1);
      let isReleased = false;
      return {
        isAdmitted: true,
        release: () => {
          if (isReleased) return;
          isReleased = true;
          const remaining = (inFlight.get(userId) ?? 1) - 1;
          if (remaining <= 0) inFlight.delete(userId);
          else inFlight.set(userId, remaining);
        },
      };
    },
  };
}

/** One anonymous validation admitted: `release` frees its two in-flight slots (its address's and the overall's), once. */
export interface AnonymousValidationAdmission {
  release(): void;
}

/**
 * The anonymous validations' two levels: per address, a minute's count and
 * ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP slots; across every anonymous caller,
 * a minute's count and ANONYMOUS_VALIDATIONS_IN_FLIGHT slots. In memory, per
 * API process, as every limit.
 */
export interface AnonymousValidationLimiter {
  /**
   * Admits one validation from `ip`, counting it in both minutes and taking
   * a slot at both levels, or throws the 429 `rate_limited` with its
   * Retry-After (a minute's: the window's remaining time; the slots': 1 s).
   * Both levels are checked before either is recorded, so a refusal at one
   * level spends nothing of the other's (nor of its own). Synchronous, so a
   * check and its count never interleave with another request's. Never
   * refunded: an admitted request counts whatever its answer.
   */
  admit(ip: string): AnonymousValidationAdmission;
}

/** Both levels checked, then both recorded. */
export function createAnonymousValidationLimiter(
  limits: Pick<RateLimits, "anonymousValidationsPerIp" | "anonymousValidations">,
  options: { now?: () => number } = {},
): AnonymousValidationLimiter {
  // Bounded as every per-key count (DEFAULT_FAILURE_LIMITER_MAX_KEYS addresses, the oldest window dropped first).
  const perIp = createFailureLimiter({ ...limits.anonymousValidationsPerIp, ...options });
  const overall = createFailureLimiter({ ...limits.anonymousValidations, ...options });
  const OVERALL = "overall";
  // An address holds a key only while one of its validations is in flight.
  const inFlightPerIp = new Map<string, number>();
  let inFlight = 0;
  return {
    admit(ip) {
      const address = `ip:${ip}`;
      const addressMinute = perIp.check(address);
      if (addressMinute.isBlocked) throw rateLimited(addressMinute.retryAfterSeconds);
      const held = inFlightPerIp.get(address) ?? 0;
      if (held >= ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP) throw rateLimited(IN_FLIGHT_RETRY_AFTER_SECONDS);
      const overallMinute = overall.check(OVERALL);
      if (overallMinute.isBlocked) throw rateLimited(overallMinute.retryAfterSeconds);
      if (inFlight >= ANONYMOUS_VALIDATIONS_IN_FLIGHT) throw rateLimited(IN_FLIGHT_RETRY_AFTER_SECONDS);
      // Both levels admit it: only now is either recorded.
      perIp.recordFailure(address);
      overall.recordFailure(OVERALL);
      inFlightPerIp.set(address, held + 1);
      inFlight += 1;
      let isReleased = false;
      return {
        release: () => {
          if (isReleased) return;
          isReleased = true;
          inFlight -= 1;
          const remaining = (inFlightPerIp.get(address) ?? 1) - 1;
          if (remaining <= 0) inFlightPerIp.delete(address);
          else inFlightPerIp.set(address, remaining);
        },
      };
    },
  };
}

/** The three counts a minute and the in-flight slots, per person, per organization. */
export function createFleetLimiter(
  limits: Pick<RateLimits, "fleetReadsPerUser" | "fleetWritesPerUser" | "fleetBearerRepliesPerUser">,
  options: { now?: () => number } = {},
): FleetLimiter {
  const counts: Record<FleetRequestKind, FailureLimiter> = {
    read: createFailureLimiter({ ...limits.fleetReadsPerUser, ...options }),
    write: createFailureLimiter({ ...limits.fleetWritesPerUser, ...options }),
    bearer: createFailureLimiter({ ...limits.fleetBearerRepliesPerUser, ...options }),
  };
  const inFlight = new Map<string, number>();
  return {
    admit(userId, organizationId, kind) {
      const key = personInOrganizationKey(userId, organizationId);
      const minute = counts[kind].check(key);
      if (minute.isBlocked) return { isAdmitted: false, reason: "per_minute", retryAfterSeconds: minute.retryAfterSeconds };
      const held = inFlight.get(key) ?? 0;
      if (held >= FLEET_REQUESTS_IN_FLIGHT_PER_USER) {
        return { isAdmitted: false, reason: "in_flight", retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS };
      }
      counts[kind].recordFailure(key);
      inFlight.set(key, held + 1);
      let isReleased = false;
      return {
        isAdmitted: true,
        release: () => {
          if (isReleased) return;
          isReleased = true;
          const remaining = (inFlight.get(key) ?? 1) - 1;
          if (remaining <= 0) inFlight.delete(key);
          else inFlight.set(key, remaining);
        },
      };
    },
  };
}

/** The generic 429, with its Retry-After when the caller knows it. */
export function rateLimited(retryAfterSeconds?: number): AppError {
  return new AppError(
    "rate_limited" satisfies SessionErrorCode,
    RATE_LIMITED_MESSAGE,
    429,
    undefined,
    retryAfterSeconds === undefined ? undefined : { "retry-after": retryAfterSeconds },
  );
}

/**
 * Registers `@fastify/rate-limit` with `global: false` and its in-memory
 * store, and returns the hooks routes attach.
 *
 * How the identity routes share one bucket: sharing comes from store
 * identity, not from the key format. The plugin's in-memory store gives
 * every route-level `config.rateLimit` its own child store
 * (`LocalStore.prototype.child` builds a fresh LRU), so the same
 * `keyGenerator` and `nameSpace` on several routes would still count them
 * separately — `nameSpace` is read only by the Redis store. Instead,
 * `server.rateLimit(options)` builds one handler around one child store, and
 * that one handler instance is attached to every one of those routes. Two separate
 * `server.rateLimit` calls would build two stores, whatever their keys.
 *
 * Never attach two `server.rateLimit` hooks to one route: every handler the
 * plugin builds marks the request as already limited (`rateLimitRan`) and
 * skips it the second time, so the second hook silently never counts.
 *
 * The per-email limit does not use the plugin at all: the plugin counts every
 * request it sees, and this limit counts only failed sign-ins, so it is our
 * own synchronous fixed-window counter (`createFailureLimiter`), one per
 * server, in memory, throwing the same 429. The per-address email limit is
 * another one, which counts every request it admits: it keys on the validated
 * body, which the plugin's `onRequest` hooks run too early to see.
 *
 * A known quirk of the per-IP limits (the per-email limiter is synchronous
 * and does not share it): @fastify/rate-limit 11.2.0's LocalStore does
 * not check and increment atomically for requests dispatched in the same
 * microtask batch, so a burst larger than `max` arriving together is
 * rejected entirely, not admitted up to `max`. It fails closed (it never
 * admits more than the limit), and real socket traffic rarely batches that
 * way. If it ever matters, the remedy is our own fixed-window limiter with a
 * synchronous check-and-increment, or an upstream fix.
 *
 * The decorators exist only once the plugin has loaded, after buildServer
 * returns, so each per-IP limiter is built on its first request. That is
 * still one limiter, and one store, per server.
 *
 * Per-IP keys use `request.ip`, which honors the trusted hop count and never
 * a raw X-Forwarded-For. A request the CSRF guard refuses is not counted:
 * the guard is a root `onRequest` hook, so it runs before these route-level
 * ones, and a refused request costs the API nothing worth limiting.
 */
export function registerRateLimits(server: FastifyInstance, limits: RateLimits): RateLimiters {
  void server.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => rateLimited(),
  });

  const perIp = (name: string, limit: RateLimit): RateLimitHook => {
    let hook: ReturnType<FastifyInstance["rateLimit"]> | undefined;
    return async (request, reply) => {
      hook ??= server.rateLimit({
        max: limit.max,
        timeWindow: limit.windowMs,
        // Each limiter has its own store, so `name` separates nothing; it
        // only labels the key for anyone inspecting a store while debugging.
        keyGenerator: (keyed) => `${name}:ip:${keyed.ip}`,
      });
      await hook.call(server, request, reply);
    };
  };

  const failures = createFailureLimiter({
    max: limits.signInPerEmail.max,
    windowMs: limits.signInPerEmail.windowMs,
  });
  // The validated body is already trimmed and lowercased; lowercasing again
  // keeps the key right should the contract ever change.
  const emailKey = (email: string) => email.toLowerCase();
  const signInPerEmail: SignInPerEmailLimiter = {
    preHandler: async (request, reply) => {
      const email = (request.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== "string") return;
      const key = emailKey(email);
      const result = failures.check(key);
      if (result.isBlocked) {
        void reply.header("retry-after", result.retryAfterSeconds);
        throw rateLimited();
      }
      failures.recordFailure(key);
    },
    succeeded: (email) => failures.reset(emailKey(email)),
    failed: (email, error) => {
      const isInvalidCredentials =
        error instanceof AppError && error.code === ("invalid_credentials" satisfies SessionErrorCode);
      if (!isInvalidCredentials) failures.refund(emailKey(email));
    },
    // The same store and the same key as sign-in's: the address as the
    // session's user row holds it (stored lowercased), never a body's.
    reauthenticationPreHandler: async (request, reply) => {
      const key = emailKey(requireAuthentication(request).email);
      const result = failures.check(key);
      if (result.isBlocked) {
        void reply.header("retry-after", result.retryAfterSeconds);
        throw rateLimited();
      }
      failures.recordFailure(key);
    },
    reauthenticated: (email) => failures.reset(emailKey(email)),
    reauthenticationSettled: (email, error) => {
      const isIncorrect =
        error instanceof AppError && error.code === ("current_password_incorrect" satisfies AccountErrorCode);
      if (!isIncorrect) failures.refund(emailKey(email));
    },
  };

  // Keyed on the address as submitted, never on whether it has an account,
  // so a 429 tells nothing about existence.
  const emailRequests = createFailureLimiter({
    max: limits.emailPerAddress.max,
    windowMs: limits.emailPerAddress.windowMs,
  });
  const emailPerAddress: RateLimitHook = async (request, reply) => {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== "string") return;
    const key = emailKey(email);
    const result = emailRequests.check(key);
    if (result.isBlocked) {
      void reply.header("retry-after", result.retryAfterSeconds);
      throw rateLimited();
    }
    emailRequests.recordFailure(key);
  };

  // Keyed by the inviting user, not the invited address: an admin inviting
  // someone must not use up that person's password-reset budget. The reply
  // isn't at hand where this runs, so the error carries its retry-after for
  // the error handler to set.
  const invitationEmails = createFailureLimiter({
    max: limits.invitationEmailsPerUser.max,
    windowMs: limits.invitationEmailsPerUser.windowMs,
  });
  const invitationEmailsPerUser = (userId: string): void => {
    const result = invitationEmails.check(userId);
    if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
    invitationEmails.recordFailure(userId);
  };

  // Keyed by the product admin.
  const flowLints = createFailureLimiter({
    max: limits.flowLintsPerUser.max,
    windowMs: limits.flowLintsPerUser.windowMs,
  });
  const flowLintsPerUser = (userId: string): void => {
    const result = flowLints.check(userId);
    if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
    flowLints.recordFailure(userId);
  };

  // Keyed by the person in the organization: uploads, samples, heads and
  // definitions' creates share one budget there.
  const testFileUploads = createFailureLimiter({
    max: limits.testFileUploadsPerUser.max,
    windowMs: limits.testFileUploadsPerUser.windowMs,
  });
  const testFileUploadsPerUser = (userId: string, organizationId: string | null): void => {
    const key = personInOrganizationKey(userId, organizationId);
    const result = testFileUploads.check(key);
    if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
    testFileUploads.recordFailure(key);
  };

  // Keyed by the person: a library file is global, so no organization; so
  // are a product admin's writes and deletes and a person's feedback (a
  // product admin administers the product, and feedback's limit is the
  // person's whichever organization they send from).
  const perUser = (limit: RateLimit): ((userId: string) => void) => {
    const counts = createFailureLimiter({ max: limit.max, windowMs: limit.windowMs });
    return (userId) => {
      const result = counts.check(userId);
      if (result.isBlocked) throw rateLimited(result.retryAfterSeconds);
      counts.recordFailure(userId);
    };
  };

  return {
    identityPerIp: perIp("identity", limits.identityPerIp),
    refreshPerIp: perIp("refresh", limits.refreshPerIp),
    signInPerEmail,
    emailPerAddress,
    invitationEmailsPerUser,
    salesInquiriesPerIp: perIp("sales-inquiries", limits.salesInquiriesPerIp),
    validationsPerUser: createValidationLimiter(limits.validationsPerUser),
    flowLintsPerUser,
    testFileUploadsPerUser,
    testRunsPerUser: createPerUserLimiter(limits.testRunsPerUser),
    validationRuleChecksPerUser: createPerUserLimiter(limits.validationRuleChecksPerUser),
    fleetsPerUser: createFleetLimiter(limits),
    quickDeployPerIp: perIp("quick-deploy", limits.quickDeployPerIp),
    quickDeployPerLink: createPerKeyLimiter(limits.quickDeployPerLink),
    organizationLogosPerIp: perIp("organization-logos", limits.organizationLogosPerIp),
    libraryFileDownloadsPerUser: perUser(limits.libraryFileDownloadsPerUser),
    libraryFileLinksPerUser: perUser(limits.libraryFileLinksPerUser),
    libraryLinksPerIp: perIp("library-links", limits.libraryLinksPerIp),
    libraryLinkDownloadsPerLink: createPerKeyLimiter(limits.libraryLinkDownloadsPerLink),
    apiTokenFailuresPerIp: createApiTokenFailureLimiter(limits.apiTokenFailuresPerIp),
    publicApiPerToken: createPerKeyLimiter(limits.publicApiPerToken),
    ottlLintsPerUser: createPerUserLimiter(limits.ottlLintsPerUser),
    anonymousValidations: createAnonymousValidationLimiter(limits),
    productAdminWritesPerUser: perUser(limits.productAdminWritesPerUser),
    productAdminDeletesPerUser: perUser(limits.productAdminDeletesPerUser),
    feedbackPerUser: perUser(limits.feedbackPerUser),
    publishedFlowReadsPerIp: perIp("published-flow-reads", limits.publishedFlowReadsPerIp),
  };
}
