import axios, { type AxiosError, type AxiosResponse } from "axios";
import { createAuthRefresh } from "axios-auth-refresh";
import {
  AcceptedResponseSchema,
  AdminUsersPageSchema,
  CreateFeedbackResponseSchema,
  PendingFeedbackCountSchema,
  ProductAdminSchema,
  ProductAdminSettingsSchema,
  ProductAdminsResponseSchema,
  UserFeedbackPageSchema,
  type AcknowledgeFeedbackRequest,
  type AdminUsersPage,
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  type GrantProductAdminRequest,
  type ProductAdmin,
  type ProductAdminSettings,
  type ProductAdminsResponse,
  type UserFeedbackPage,
  ApiTokensResponseSchema,
  CreatedApiTokenResponseSchema,
  ServiceAccountResponseSchema,
  ServiceAccountsResponseSchema,
  type ApiTokensResponse,
  type CreateApiTokenRequest,
  type CreatePersonalApiTokenRequest,
  type CreatedApiTokenResponse,
  type CreateServiceAccountRequest,
  type RenameServiceAccountRequest,
  type ServiceAccountResponse,
  type ServiceAccountsResponse,
  OrganizationVariableResponseSchema,
  OrganizationVariablesResponseSchema,
  VariableDraftsResponseSchema,
  VariableGroupDetailSchema,
  VariableGroupOverrideResponseSchema,
  VariableGroupResponseSchema,
  VariableGroupsResponseSchema,
  type CreateOrganizationVariableRequest,
  type CreateVariableGroupRequest,
  type OrganizationVariable,
  type UpdateOrganizationVariableRequest,
  type UpdateVariableGroupRequest,
  type VariableDraftsResponse,
  type VariableGroup,
  type VariableGroupDetail,
  type VariableGroupOverride,
  CollectorDistributionsResponseSchema,
  CollectorErrorsPageSchema,
  CollectorGroupResponseSchema,
  CollectorGroupsResponseSchema,
  CollectorResponseSchema,
  CollectorsPageSchema,
  ConfigurationResponseSchema,
  ConfigurationVersionResponseSchema,
  ConfigurationVersionSummaryResponseSchema,
  ConfigurationWithVersionResponseSchema,
  ConfigurationsPageSchema,
  ConfigurationValidationResponseSchema,
  PublicValidateResponseSchema,
  type PublicValidateRequest,
  type PublicValidateResponse,
  ConfigurationVersionsResponseSchema,
  CSRF_HEADER_NAME,
  EnrollmentTokenEventsPageSchema,
  EnrollmentTokenResponseSchema,
  EnrollmentTokenRevealedResponseSchema,
  EnrollmentTokenRotatedResponseSchema,
  EnrollmentTokensResponseSchema,
  FleetCreatedResponseSchema,
  FleetDetailResponseSchema,
  FleetResponseSchema,
  FleetsPageSchema,
  InstallFactsSchema,
  HelmInstallFactsSchema,
  installBundleFileName,
  CreateQuickDeployLinkResponseSchema,
  QuickDeployLinkResponseSchema,
  QuickDeployLinksPageSchema,
  CSRF_HEADER_VALUE,
  CreateSessionResponseSchema,
  CurrentUserResponseSchema,
  UserPreferencesSchema,
  AccountSessionsResponseSchema,
  IdentityLinkResponseSchema,
  SignInMethodsResponseSchema,
  ErrorResponseSchema,
  FlowLintResponseSchema,
  FlowResponseSchema,
  FlowsResponseSchema,
  PublishedFlowResponseSchema,
  PublishedFlowsResponseSchema,
  InvitationPreviewResponseSchema,
  InvitationResponseSchema,
  InvitationsResponseSchema,
  JoinedOrganizationResponseSchema,
  LibraryFileLinkResponseSchema,
  LibraryFileResponseSchema,
  LibraryFilesResponseSchema,
  MembersResponseSchema,
  OrganizationResponseSchema,
  OrganizationSettingsSchema,
  PinCollectorsResponseSchema,
  RegisterResponseSchema,
  SwitchOrganizationResponseSchema,
  TestDefinitionResponseSchema,
  TestDefinitionsResponseSchema,
  TestFileResponseSchema,
  TestFilesResponseSchema,
  TestRunResponseSchema,
  TestRegexesResponseSchema,
  TestRegexResponseSchema,
  TestRunsResponseSchema,
  TestSuiteResponseSchema,
  TestSuitesResponseSchema,
  TestTemplateResponseSchema,
  TestTemplatesResponseSchema,
  testSampleFileName,
  ValidationPipelineResponseSchema,
  ValidationPipelinesResponseSchema,
  ValidationRuleResponseSchema,
  ValidationRulesResponseSchema,
  VerifyEmailResponseSchema,
  type AcceptedResponse,
  type ChangeMemberRoleRequest,
  type ChangeOrganizationRequest,
  type Collector,
  type CollectorDistributionsResponse,
  type CollectorErrorsPage,
  type CollectorGroup,
  type CollectorGroupsResponse,
  type CollectorsPage,
  type ConfigurationResponse,
  type ConfigurationVersionResponse,
  type ConfigurationVersionSummaryResponse,
  type ConfigurationWithVersionResponse,
  type ConfigurationsListFilter,
  type ConfigurationsPage,
  type ConfigurationValidationResponse,
  type ConfigurationVersionsFilter,
  type ConfigurationVersionsResponse,
  type CreateConfigurationRequest,
  type CreateConfigurationVersionRequest,
  type CreateFlowRequest,
  type CreateInvitationRequest,
  type CreateSessionRequest,
  type CreateOrganizationRequest,
  type CreateSessionResponse,
  type CurrentUserResponse,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
  type AccountSessionsResponse,
  type ChangePasswordRequest,
  type IdentityLinkRequest,
  type IdentityLinkResponse,
  type SignInMethodsResponse,
  type UnlinkIdentityRequest,
  type CreateFleetRequest,
  type CreateCollectorGroupRequest,
  type EnrollmentTokenEventsPage,
  type EnrollmentTokenResponse,
  type EnrollmentTokenRevealedResponse,
  type EnrollmentTokenRotatedResponse,
  type EnrollmentTokensResponse,
  type InstallBundleRequestInput,
  type InstallFacts,
  type HelmInstallFacts,
  type CreateQuickDeployLinkRequestInput,
  type CreateQuickDeployLinkResponse,
  type QuickDeployLinkExtension,
  type QuickDeployLinkResponse,
  type QuickDeployLinksPage,
  type Fleet,
  type FleetCreatedResponse,
  type FleetDetail,
  type FleetsPage,
  type FleetStatus,
  type FlowLintResponse,
  type FlowResponse,
  type FlowsResponse,
  type PublishedFlowResponse,
  type PublishedFlowsResponse,
  type InvitationPreviewResponse,
  type InvitationRegistrationRequest,
  type InvitationResponse,
  type InvitationsResponse,
  type InvitationTokenRequest,
  type JoinedOrganizationResponse,
  type LibraryFileLinkResponse,
  type LibraryFileResponse,
  type LibraryFilesResponse,
  type ListCollectorsQuery,
  type MembersResponse,
  type OrganizationResponse,
  type OrganizationSettings,
  type PasswordReset,
  type PasswordResetRequest,
  type PinCollectorsRequest,
  type PinCollectorsResponse,
  type PublishConfigurationVersionRequest,
  type RegisterRequest,
  type RegisterResponse,
  type RenameConfigurationVersionRequest,
  type RotateEnrollmentTokenRequest,
  type SaveConfigurationVersionRequest,
  type SelectConfigurationVersionRequest,
  type SwitchOrganizationRequest,
  type SwitchOrganizationResponse,
  type TermsAcceptanceRequest,
  type CreateTestDefinitionRequest,
  type CreateTestRegexRequest,
  type CreateTestSuiteRequest,
  type QueueTestRunRequest,
  type TestDefinitionResponse,
  type TestDefinitionsResponse,
  type TestFileResponse,
  type TestFilesResponse,
  type TestRegexesResponse,
  type TestRegexResponse,
  type TestRunFile,
  type TestRunResponse,
  type TestRunsResponse,
  type TestSampleFormat,
  type TestSuiteResponse,
  type TestSuitesResponse,
  type TestRunSignal,
  type TestTemplateResponse,
  type TestTemplatesResponse,
  type UpdateTestRegexRequest,
  type UpdateTestSuiteRequest,
  type UpdateTestTemplateRequest,
  type UpdateCollectorGroupRequest,
  type UpdateCollectorRequest,
  type UpdateConfigurationRequest,
  type UpdateFleetRequest,
  type UpdateFlowRequest,
  type UpdateLibraryFileRequest,
  type UpdateValidationRuleRequest,
  type CreateValidationPipelineRequest,
  type CreateValidationRuleRequest,
  type ValidationPipelineResponse,
  type ValidationPipelinesResponse,
  type ValidationRuleResponse,
  type ValidationRulesResponse,
  type ValidateConfigurationVersionRequest,
  type SessionErrorCode,
  type VerificationEmailRequest,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from "@telflo/contracts";
import { signedOutInThisBrowser } from "~/lib/signed-out.js";

declare module "axios" {
  interface AxiosRequestConfig {
    /**
     * Read by axios-auth-refresh: a request carrying it is never
     * intercepted for a refresh. Set on the refresh call itself and on every
     * retried request.
     */
    skipAuthRefresh?: boolean;
  }
}

/**
 * Same-origin by default: the browser calls `/api/...` on whatever host served
 * the page, and something in front of the web app routes it to the API —
 * Vite's dev proxy locally, the gateway in the container stack. So one built
 * image works at any customer's hostname; nothing about where the API lives is
 * baked in at build time. VITE_TELFLO_API_URL remains as an escape hatch for a
 * deployment that serves the API from a different origin, which then relies on
 * the API's CORS configuration.
 */
const API_BASE_URL = import.meta.env.VITE_TELFLO_API_URL ?? "";

const REFRESH_PATH = "/api/v1/auth/refresh";

/** The only code that triggers a refresh. */
const ACCESS_TOKEN_EXPIRED: SessionErrorCode = "access_token_expired";
const UNAUTHENTICATED: SessionErrorCode = "unauthenticated";

/**
 * An API failure with the server's machine-readable code attached, and, when
 * the server answered, its HTTP status. `retryAfterSeconds` is the answer's
 * `Retry-After` (on a 429), in whole seconds, when it gave one the client
 * could read (delta-seconds, or an HTTP date from now). `details` is the
 * envelope's `error.details` as the server sent it, unchecked (a reader
 * parses what it needs: 400 `validation_rule_invalid`'s problems, each with
 * its field); undefined when the envelope had none.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

/**
 * Whether a request failed because the session is over: a 401
 * `unauthenticated`, a refused refresh's included. A read that toasts its
 * failures says nothing then: the session-ended handler owns it, taking the
 * browser to sign in, and while Logout has the handler suspended the page is
 * leaving for Logout's `/login`, where a "Failed to load…" toast would follow
 * it.
 */
export function isSessionEnded(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === UNAUTHENTICATED;
}

/**
 * A `Retry-After` header in whole seconds (RFC 9110 §10.2.3): delta-seconds
 * as written, an HTTP date as the seconds from now to it (0 once past);
 * undefined when absent or unreadable.
 */
export function retryAfterSecondsOf(header: unknown, now: number = Date.now()): number | undefined {
  if (typeof header !== "string") return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  // Every HTTP date form begins with the day's name; Date.parse alone reads "1.5" or "-1" as dates.
  if (!/^[A-Za-z]/.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Sends the browser to sign in again, and back here afterwards. Only ever
 * called in a browser: this module is also imported during server
 * rendering, where there is no window, and nothing here touches it at import
 * time.
 */
function goToLogin(): void {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  window.location.assign("/login?redirectTo=" + encodeURIComponent(pathname + search));
}

let sessionEndedHandler: () => void = goToLogin;

/**
 * Whether the handler has run since the last successful request. Requests
 * that fail together (five in parallel, say, or three waiting on one refused
 * refresh) all mean the same ended session, so only the first calls it.
 */
let sessionEndedNotified = false;

/**
 * Whether PostHog has been told this session ended. The handler may be
 * suspended, and then every failing request notifies again; PostHog is
 * reset once per ended session all the same.
 */
let analyticsToldSessionEnded = false;

/**
 * What happens when the session is over: a request failed with 401
 * `unauthenticated`, or a refresh was refused with 401. Called at most
 * once until a later request, or refresh, succeeds, however many requests
 * failed together. The default sends the browser to
 * `/login?redirectTo=<current path>`. Setting a handler re-arms it.
 */
export function setSessionEndedHandler(handler: () => void): void {
  sessionEndedHandler = handler;
  sessionEndedNotified = false;
  analyticsToldSessionEnded = false;
}

/** How many callers have the handler suspended; see suspendSessionEndedHandler. */
let sessionEndedSuspensions = 0;

/**
 * Keeps the session-ended handler from running until the returned release is
 * called, by every caller that suspended it. A session that ends meanwhile is
 * only the requests' ApiError. The accept page does this: a visitor whose
 * session has ended is shown the page signed out, not sent to `/login`.
 * Suspended, a session ending doesn't count as notified, so the first one
 * after the release still calls the handler.
 */
export function suspendSessionEndedHandler(): () => void {
  sessionEndedSuspensions += 1;
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    sessionEndedSuspensions -= 1;
  };
}

function notifySessionEnded(): void {
  if (sessionEndedNotified) return;
  // The user is gone, whether or not the handler is suspended, so PostHog
  // forgets them as a sign-out does: once per ended session, not on every
  // request that fails while suspended, and only once PostHog has started
  // (signedOutLocally waits for it, and without analytics does nothing).
  if (!analyticsToldSessionEnded) {
    analyticsToldSessionEnded = true;
    // And the staged playground edit goes, as at any sign-out.
    signedOutInThisBrowser();
  }
  if (sessionEndedSuspensions > 0) return;
  sessionEndedNotified = true;
  sessionEndedHandler();
}

const client = axios.create({ baseURL: API_BASE_URL, withCredentials: true });

// The API refuses any state-changing /api/v1 request without it. The
// refresh call goes through here too.
client.interceptors.request.use((config) => {
  if (config.method?.toUpperCase() !== "GET") config.headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  return config;
});

function errorCodeOf(error: AxiosError): string | undefined {
  const parsed = ErrorResponseSchema.safeParse(error.response?.data);
  return parsed.success ? parsed.data.error.code : undefined;
}

/**
 * How the most recent refresh failed. axios-auth-refresh rejects a request
 * that was *sent* while that refresh was in flight (it holds such requests
 * in a request interceptor) with a bare CanceledError, which says nothing
 * about why; this lets `toApiError` give it the refresh's own failure, like
 * the requests that were already waiting.
 *
 * It can't go stale, because of when it is read. A held request's
 * CanceledError reaches `toApiError` in the same microtask cascade as its
 * refresh's rejection, which set this; any later refresh needs a network
 * round trip before it can overwrite it, so every cancellation is mapped
 * before that. The only requests this client cancels are those whose caller
 * aborts them through a signal (`validateVersion`'s), and `send` answers
 * those itself, as `REQUEST_ABORTED`, before `toApiError` runs, so there is
 * no other cancellation to misreport. A successful refresh clears it all the
 * same.
 */
let lastRefreshFailure: ApiError | undefined;

/**
 * The one refresh. axios-auth-refresh calls this once per refresh however
 * many requests failed with `access_token_expired`: the second and later
 * failures wait on the promise it returned (single-flight), and reject with
 * this refresh's own failure, so `send` never sees their 401s. The
 * session-ended handler is called here for a refused refresh.
 *
 * `client.post` must be called synchronously. The library installs its
 * request-holding interceptor right after this returns; axios collects a
 * request's interceptors when the request is made, so a refresh made after
 * an `await` would be held behind itself and never sent.
 */
function refreshAccessToken(): Promise<void> {
  return client.post(REFRESH_PATH, undefined, { skipAuthRefresh: true }).then(
    () => {
      lastRefreshFailure = undefined;
      sessionEndedNotified = false;
      analyticsToldSessionEnded = false;
    },
    (error: unknown) => {
      const refused = axios.isAxiosError(error) && error.response?.status === 401;
      const failure = refused
        ? new ApiError(UNAUTHENTICATED, "Your session has ended. Sign in again.")
        : toApiError(error);
      lastRefreshFailure = failure;
      if (refused) notifySessionEnded();
      throw failure;
    },
  );
}

createAuthRefresh(client, refreshAccessToken, {
  // Only an expired access token is worth a refresh; any other 401 means the
  // session is over, and a 403 is a refusal.
  shouldRefresh: (error) =>
    error.response?.status === 401 && errorCodeOf(error) === ACCESS_TOKEN_EXPIRED,
  // A request that is retried after the refresh, or that was sent while it
  // was in flight, is never intercepted again: a second
  // `access_token_expired` is a failure, not another refresh. The library's
  // own default would refresh up to 3 times in a row.
  onRetry: (config) => {
    config.skipAuthRefresh = true;
    return config;
  },
  // Despite its name, this option doesn't deduplicate the refresh call (the
  // library always shares one in-flight refresh). When true, it stops
  // intercepting *any* failure from this client while a refresh is in
  // flight, so a request whose `access_token_expired` arrives during the
  // refresh would fail instead of waiting for it. The refresh call itself is
  // kept out of the interceptor by `skipAuthRefresh`, which is what this
  // option exists to spare callers from doing.
  deduplicateRefresh: false,
});

/**
 * Maps any failure to the ApiError vocabulary: the server's own code from
 * its error envelope, `unexpected_response` for a body that isn't one (a
 * gateway's html error page, say), and `network_error` when no response
 * arrived.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // A request its caller aborted through a signal never gets here (`send`
  // answers it first), so any cancellation that does is axios-auth-refresh
  // releasing a request held behind a failed refresh.
  if (axios.isCancel(error) && lastRefreshFailure) return lastRefreshFailure;
  if (axios.isAxiosError(error) && error.response) {
    const { status } = error.response;
    const retryAfterSeconds = retryAfterSecondsOf(error.response.headers?.["retry-after"]);
    const answer = retryAfterSeconds === undefined ? { status } : { status, retryAfterSeconds };
    const parsed = ErrorResponseSchema.safeParse(error.response.data);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      return new ApiError(code, message, details === undefined ? answer : { ...answer, details });
    }
    return new ApiError("unexpected_response", "The server returned an unexpected error.", answer);
  }
  return new ApiError("network_error", "Could not reach the server. Check your connection.");
}

type ResponseParser<Response> = { parse(value: unknown): Response };

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a request may carry beyond its body. */
interface SendOptions {
  /** Aborts the request: it then rejects with `REQUEST_ABORTED`, whatever else happened. */
  signal?: AbortSignal | undefined;
  /**
   * `bytes`: the answer is read as bytes, never decoded as text (a test run's
   * files: UTF-16 survives). A refusal's body is still the JSON envelope,
   * decoded for its code (and so for the refresh).
   */
  read?: "bytes";
}

/**
 * `value` as a Uint8Array over the same memory when it is an ArrayBuffer or
 * a view of one, else null. By its tag, not `instanceof`: a buffer from
 * another realm (a worker, a test environment's globals) is one too.
 */
function asBytes(value: unknown): Uint8Array | null {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** `bytes` as text, for a refusal's envelope; anything else as it is. */
function decodedEnvelope(data: unknown): unknown {
  const bytes = asBytes(data);
  const text = bytes === null ? data : new TextDecoder().decode(bytes);
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A bytes read's answer, transformed as axios hands it over: a success's
 * body stays bytes; a refusal's (status 400 and up) is decoded as its JSON
 * envelope, so `toApiError` and the refresh's `shouldRefresh` read its code
 * as they do any other request's.
 */
function bytesOrEnvelope(data: unknown, _headers: unknown, status?: number): unknown {
  return status !== undefined && status >= 400 ? decodedEnvelope(data) : data;
}

/** A bytes read's success: the body as a Uint8Array (a string, as a test adapter may give, as its UTF-8). */
const BYTES: ResponseParser<Uint8Array> = {
  parse(value: unknown): Uint8Array {
    const bytes = asBytes(value);
    if (bytes !== null) return bytes;
    if (typeof value === "string") return new TextEncoder().encode(value);
    throw new Error("Expected bytes.");
  },
};

/** The code of the ApiError a request rejects with once its caller aborted it. */
export const REQUEST_ABORTED = "request_aborted";

/**
 * The one way this client talks to the API. Responses are parsed with the
 * same Zod schema the server serializes with, so a drifted contract fails
 * here rather than as `undefined` three components later. A body that is not
 * the expected envelope becomes an ApiError rather than a parse crash.
 *
 * With no schema the endpoint answers 204, and a success resolves
 * `undefined`. A 204 where a schema is expected is contract drift, reported
 * as `unexpected_response` like any other success-path mismatch.
 *
 * An expired access token is refreshed and the request retried once, by the
 * interceptor above; nothing here knows about it.
 *
 * A 401 `unauthenticated` means the session is over, whether the request was a
 * first attempt or a retry, so it calls the session-ended handler. The status
 * is read from the raw axios error, since ApiError carries none: sign-in's 401
 * is `invalid_credentials`, and must not. Requests held behind a refused
 * refresh arrive as its ApiError or as a CanceledError, not as a 401; the
 * refresh has already called the handler.
 */
function send<Response>(
  method: HttpMethod,
  path: string,
  body: unknown,
  schema: ResponseParser<Response>,
  options?: SendOptions,
): Promise<Response>;
function send(
  method: HttpMethod,
  path: string,
  body: unknown,
  schema: undefined,
  options?: SendOptions,
): Promise<undefined>;
function send<Response>(
  method: HttpMethod,
  path: string,
  body: unknown,
  schema: ResponseParser<Response> | undefined,
  options: SendOptions = {},
): Promise<Response | undefined> {
  const sending = sendNow(method, path, body, schema, options);
  trackInFlight(sending);
  return sending;
}

/**
 * Every request `send` has made that hasn't settled yet, each as a promise
 * that settles, never rejecting, once its `send` has: after any session-ended
 * handling its failure caused, a refused refresh's included.
 */
const requestsInFlight = new Set<Promise<void>>();

function trackInFlight(sending: Promise<unknown>): void {
  const settled = sending.then(
    () => undefined,
    () => undefined,
  );
  requestsInFlight.add(settled);
  void settled.then(() => requestsInFlight.delete(settled));
}

/**
 * Resolves once every request in flight now has settled, however it
 * settled; requests made after the call don't count. Logout waits on it to
 * release the session-ended handler (use-logout.ts): a read sent before
 * the session was revoked can still answer 401 after it, and that is the
 * logout's doing, not a session that ended.
 */
export function whenRequestsInFlightSettle(): Promise<void> {
  return Promise.all([...requestsInFlight]).then(() => undefined);
}

async function sendNow<Response>(
  method: HttpMethod,
  path: string,
  body: unknown,
  schema: ResponseParser<Response> | undefined,
  options: SendOptions,
): Promise<Response | undefined> {
  const { signal, read } = options;
  let response: AxiosResponse<unknown>;
  try {
    response = await client.request({
      method,
      url: path,
      data: body,
      ...(signal === undefined ? {} : { signal }),
      ...(read === "bytes" ? { responseType: "arraybuffer", transformResponse: [bytesOrEnvelope] } : {}),
    });
  } catch (error) {
    // The caller's own abort: no answer, and nothing about the session.
    if (signal?.aborted === true) throw new ApiError(REQUEST_ABORTED, "The request was cancelled.");
    if (axios.isAxiosError(error) && error.response?.status === 401 && errorCodeOf(error) === UNAUTHENTICATED) {
      notifySessionEnded();
    }
    throw toApiError(error);
  }
  sessionEndedNotified = false;
  analyticsToldSessionEnded = false;

  if (schema === undefined) return undefined;
  if (response.status === 204) {
    throw new ApiError("unexpected_response", "The server returned an unexpected response.");
  }

  try {
    // A body that wasn't JSON arrives as a string and fails here too.
    return schema.parse(response.data);
  } catch {
    // A 200 whose body doesn't match the response schema is contract drift
    // on the success path — exactly what this parsing exists to catch. It
    // must surface in ApiError's own vocabulary, not as a raw ZodError.
    throw new ApiError("unexpected_response", "The server returned an unexpected response.");
  }
}

export function postRegister(request: RegisterRequest): Promise<RegisterResponse> {
  return send("POST", "/api/v1/auth/register", request, RegisterResponseSchema);
}

export function postVerifyEmail(request: VerifyEmailRequest): Promise<VerifyEmailResponse> {
  return send("POST", "/api/v1/auth/verify-email", request, VerifyEmailResponseSchema);
}

/** Sign in. The API sets the session cookies on the response. */
export function createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
  return send("POST", "/api/v1/auth/sessions", request, CreateSessionResponseSchema);
}

/** Log out of this browser's session. The API clears the session cookies. */
export function deleteCurrentSession(): Promise<undefined> {
  return send("DELETE", "/api/v1/auth/sessions/current", undefined, undefined);
}

/** The signed-in user, their active organization, and their organizations. */
export function getCurrentUser(): Promise<CurrentUserResponse> {
  return send("GET", "/api/v1/auth/me", undefined, CurrentUserResponseSchema);
}

/** The signed-in person's preferences: every key, defaults filled in. */
export function getPreferences(options: { signal?: AbortSignal } = {}): Promise<UserPreferences> {
  return send("GET", "/api/v1/auth/me/preferences", undefined, UserPreferencesSchema, { signal: options.signal });
}

/**
 * Saves preferences (a write, CSRF): Settings sends one key at a time, and
 * the API merges it onto the stored ones. Answers every preference after the
 * change. A change of the theme also sets the `telflo_theme` cookie.
 */
export function updatePreferences(
  request: UpdateUserPreferencesRequest,
  options: { signal?: AbortSignal } = {},
): Promise<UserPreferences> {
  return send("PATCH", "/api/v1/auth/me/preferences", request, UserPreferencesSchema, { signal: options.signal });
}

/**
 * Changes the signed-in account's password (a write, CSRF):
 * `current_password_incorrect` for a wrong current password,
 * `password_not_set` for an account with none. Every session is kept.
 */
export function changePassword(request: ChangePasswordRequest): Promise<undefined> {
  return send("PUT", "/api/v1/auth/me/password", request, undefined);
}

/** How the signed-in account can sign in: its password, its identities, the configured providers. */
export function getSignInMethods(options: { signal?: AbortSignal } = {}): Promise<SignInMethodsResponse> {
  return send("GET", "/api/v1/auth/me/sign-in-methods", undefined, SignInMethodsResponseSchema, { signal: options.signal });
}

/**
 * Starts linking a provider to the signed-in account (a POST, so the CSRF
 * header goes and the password stays out of the URL). Answers the provider's
 * authorization URL, where the browser goes next.
 */
export function createIdentityLinkRequest(request: IdentityLinkRequest): Promise<IdentityLinkResponse> {
  return send("POST", "/api/v1/auth/me/identity-link-requests", request, IdentityLinkResponseSchema);
}

/** Removes the account's sign-in with `provider`: a DELETE whose body carries the current password. */
export function unlinkIdentity(provider: string, request: UnlinkIdentityRequest): Promise<undefined> {
  return send("DELETE", `/api/v1/auth/me/identities/${encodeURIComponent(provider)}`, request, undefined);
}

/** The signed-in account's live sessions, the current one first. */
export function listSessions(options: { signal?: AbortSignal } = {}): Promise<AccountSessionsResponse> {
  return send("GET", "/api/v1/auth/sessions", undefined, AccountSessionsResponseSchema, { signal: options.signal });
}

/** Signs out one of the account's other sessions. */
export function deleteSession(sessionId: string): Promise<undefined> {
  return send("DELETE", `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`, undefined, undefined);
}

/** Signs out every session of the account, this one included; the API clears the session cookies. */
export function deleteAllSessions(): Promise<undefined> {
  return send("DELETE", "/api/v1/auth/sessions", undefined, undefined);
}

/** Asks for a password reset link. Answers the same whether or not an account exists. */
export function requestPasswordReset(request: PasswordResetRequest): Promise<AcceptedResponse> {
  return send("POST", "/api/v1/auth/password-reset-requests", request, AcceptedResponseSchema);
}

/** Sets a new password with the emailed token, which signs out every session. */
export function resetPassword(request: PasswordReset): Promise<undefined> {
  return send("POST", "/api/v1/auth/password-resets", request, undefined);
}

/** Asks for another confirmation email. Answers the same whether or not an account exists. */
export function requestVerificationEmail(request: VerificationEmailRequest): Promise<AcceptedResponse> {
  return send("POST", "/api/v1/auth/verification-emails", request, AcceptedResponseSchema);
}

/**
 * Accepts the current terms. Any version but the current one is refused with
 * `terms_version_not_current`.
 */
export function acceptTerms(request: TermsAcceptanceRequest): Promise<undefined> {
  return send("PUT", "/api/v1/auth/me/terms-acceptance", request, undefined);
}

/**
 * Makes another of the user's organizations this session's active one.
 * The API sets a new access cookie naming it.
 */
export function switchOrganization(request: SwitchOrganizationRequest): Promise<SwitchOrganizationResponse> {
  return send("PUT", "/api/v1/auth/sessions/current/organization", request, SwitchOrganizationResponseSchema);
}

/** Creates a group organization with the caller as its admin. It doesn't switch to it. */
export function createOrganization(request: CreateOrganizationRequest): Promise<OrganizationResponse> {
  return send("POST", "/api/v1/organizations", request, OrganizationResponseSchema);
}

/**
 * Renames the active organization, and with `removeLogo: true` removes its
 * logo in the same request; the caller must be its admin.
 */
export function renameOrganization(organizationId: string, request: ChangeOrganizationRequest): Promise<OrganizationResponse> {
  return send("PATCH", `/api/v1/organizations/${encodeURIComponent(organizationId)}`, request, OrganizationResponseSchema);
}

/**
 * An organization's multipart body: the parts `name` then `file`, in the
 * only order the API accepts (ORGANIZATION_PART_NAMES). The content type is
 * never set here: the browser writes it, with its boundary. The file's name
 * goes as the part's filename only (the API never reads it: the logo's type
 * comes from its bytes).
 */
function organizationForm(name: string, file: File): FormData {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file, file.name);
  return form;
}

/**
 * Creates a group organization with its logo, in one request, all or nothing.
 * Refusals: 413 `organization_logo_too_large`, 415
 * `organization_logo_type_unsupported`, 400 `invalid_request`, and create's
 * own.
 */
export function createOrganizationWithLogo(name: string, file: File): Promise<OrganizationResponse> {
  return send("POST", "/api/v1/organizations", organizationForm(name, file), OrganizationResponseSchema);
}

/**
 * Renames the active organization and sets its logo, in one request, all or
 * nothing; the caller must be its admin. Refusals as
 * createOrganizationWithLogo's, and the rename's own.
 */
export function changeOrganizationWithLogo(organizationId: string, name: string, file: File): Promise<OrganizationResponse> {
  return send(
    "PATCH",
    `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
    organizationForm(name, file),
    OrganizationResponseSchema,
  );
}

/** The public address of an organization's logo: ids only. */
export function organizationLogoPath(organizationId: string, logoId: string): string {
  return `/api/v1/organization-logos/${encodeURIComponent(organizationId)}/${encodeURIComponent(logoId)}`;
}

/**
 * Deletes the active group organization; the caller must be its admin. Its
 * members' sessions move to their fallback organizations.
 */
export function deleteOrganization(organizationId: string): Promise<undefined> {
  return send("DELETE", `/api/v1/organizations/${encodeURIComponent(organizationId)}`, undefined, undefined);
}

/**
 * The organization's settings (a read, any member): whether its public
 * install links (Linux Quick Deploy and Helm values links) are on. The
 * install dialogs read it at their opening.
 */
export function getOrganizationSettings(organizationId: string, options: { signal?: AbortSignal } = {}): Promise<OrganizationSettings> {
  return send("GET", `/api/v1/organizations/${encodeURIComponent(organizationId)}/settings`, undefined, OrganizationSettingsSchema, {
    signal: options.signal,
  });
}

/**
 * Turns the organization's public install links on or off (a write, CSRF; an
 * admin's: `organization_admin_required` otherwise). Answers the settings as
 * saved.
 */
export function updateOrganizationSettings(
  organizationId: string,
  request: OrganizationSettings,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationSettings> {
  return send("PATCH", `/api/v1/organizations/${encodeURIComponent(organizationId)}/settings`, request, OrganizationSettingsSchema, {
    signal: options.signal,
  });
}

function membersPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/members`;
}

function memberPath(organizationId: string, userId: string): string {
  return `${membersPath(organizationId)}/${encodeURIComponent(userId)}`;
}

/** The active organization's members, active and removed; the caller must be its admin. */
export function getMembers(organizationId: string): Promise<MembersResponse> {
  return send("GET", membersPath(organizationId), undefined, MembersResponseSchema);
}

/** Changes an active member's role in the active organization. */
export function changeMemberRole(organizationId: string, userId: string, request: ChangeMemberRoleRequest): Promise<undefined> {
  return send("PATCH", memberPath(organizationId, userId), request, undefined);
}

/**
 * Removes a member from the active organization (soft). Their sessions acting
 * in it move to their fallback organizations.
 */
export function removeMember(organizationId: string, userId: string): Promise<undefined> {
  return send("DELETE", memberPath(organizationId, userId), undefined, undefined);
}

/** Restores a removed member of the active organization. */
export function restoreMember(organizationId: string, userId: string): Promise<undefined> {
  return send("PUT", `${memberPath(organizationId, userId)}/restoration`, undefined, undefined);
}

function invitationsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/invitations`;
}

function invitationPath(organizationId: string, invitationId: string): string {
  return `${invitationsPath(organizationId)}/${encodeURIComponent(invitationId)}`;
}

/** The active organization's pending invitations, expired ones included, newest first; the caller must be its admin. */
export function getInvitations(organizationId: string): Promise<InvitationsResponse> {
  return send("GET", invitationsPath(organizationId), undefined, InvitationsResponseSchema);
}

/** Invites an address to the active organization, and emails it the link. */
export function inviteMember(organizationId: string, request: CreateInvitationRequest): Promise<InvitationResponse> {
  return send("POST", invitationsPath(organizationId), request, InvitationResponseSchema);
}

/** Sends a pending invitation again, with a new link and expiry; the old link stops working. */
export function resendInvitation(organizationId: string, invitationId: string): Promise<InvitationResponse> {
  return send("POST", `${invitationPath(organizationId, invitationId)}/deliveries`, undefined, InvitationResponseSchema);
}

/** Cancels a pending invitation; its link stops working. */
export function cancelInvitation(organizationId: string, invitationId: string): Promise<undefined> {
  return send("DELETE", invitationPath(organizationId, invitationId), undefined, undefined);
}

function serviceAccountsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/service-accounts`;
}

function serviceAccountPath(organizationId: string, serviceAccountId: string): string {
  return `${serviceAccountsPath(organizationId)}/${encodeURIComponent(serviceAccountId)}`;
}

function apiTokensPath(organizationId: string, serviceAccountId: string): string {
  return `${serviceAccountPath(organizationId, serviceAccountId)}/api-tokens`;
}

/**
 * The active organization's live service accounts, newest first (an admin's:
 * `organization_admin_required` otherwise, reads included).
 */
export function getServiceAccounts(organizationId: string, options: { signal?: AbortSignal } = {}): Promise<ServiceAccountsResponse> {
  return send("GET", serviceAccountsPath(organizationId), undefined, ServiceAccountsResponseSchema, { signal: options.signal });
}

/** One live service account; 404 `service_account_not_found` for an unknown, deleted or another organization's. */
export function getServiceAccount(
  organizationId: string,
  serviceAccountId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ServiceAccountResponse> {
  return send("GET", serviceAccountPath(organizationId, serviceAccountId), undefined, ServiceAccountResponseSchema, {
    signal: options.signal,
  });
}

/** Creates a service account (201): a contributor of the active organization, with its slug address. */
export function createServiceAccount(organizationId: string, request: CreateServiceAccountRequest): Promise<ServiceAccountResponse> {
  return send("POST", serviceAccountsPath(organizationId), request, ServiceAccountResponseSchema);
}

/** Renames a service account; its address is kept. */
export function renameServiceAccount(
  organizationId: string,
  serviceAccountId: string,
  request: RenameServiceAccountRequest,
): Promise<ServiceAccountResponse> {
  return send("PATCH", serviceAccountPath(organizationId, serviceAccountId), request, ServiceAccountResponseSchema);
}

/** Deletes a service account: its membership removed and every token revoked, in one transaction. */
export function deleteServiceAccount(organizationId: string, serviceAccountId: string): Promise<undefined> {
  return send("DELETE", serviceAccountPath(organizationId, serviceAccountId), undefined, undefined);
}

/** A service account's tokens not revoked, live and expired, newest first: each by its prefix, never the token. */
export function getApiTokens(
  organizationId: string,
  serviceAccountId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ApiTokensResponse> {
  return send("GET", apiTokensPath(organizationId, serviceAccountId), undefined, ApiTokensResponseSchema, { signal: options.signal });
}

/**
 * Creates a token on a service account (201, `Cache-Control: no-store`): the
 * only answer that carries the token. The caller shows it once and keeps it
 * nowhere else.
 */
export function createApiToken(
  organizationId: string,
  serviceAccountId: string,
  request: CreateApiTokenRequest,
): Promise<CreatedApiTokenResponse> {
  return send("POST", apiTokensPath(organizationId, serviceAccountId), request, CreatedApiTokenResponseSchema);
}

/** Revokes a token (204); 404 `api_token_not_found` for an unknown, another account's or an already revoked one. */
export function revokeApiToken(organizationId: string, serviceAccountId: string, tokenId: string): Promise<undefined> {
  return send("DELETE", `${apiTokensPath(organizationId, serviceAccountId)}/${encodeURIComponent(tokenId)}`, undefined, undefined);
}

/** A person's own API tokens' path: the session's person, no organization. */
const PERSONAL_API_TOKENS_PATH = "/api/v1/auth/me/api-tokens";

/** The signed-in person's own tokens not revoked, live and expired, newest first: each by its prefix, never the token. */
export function getPersonalApiTokens(options: { signal?: AbortSignal } = {}): Promise<ApiTokensResponse> {
  return send("GET", PERSONAL_API_TOKENS_PATH, undefined, ApiTokensResponseSchema, { signal: options.signal });
}

/**
 * Creates one of the person's own tokens (201, `Cache-Control: no-store`):
 * the only answer that carries it. The caller shows it once and keeps it
 * nowhere else.
 */
export function createPersonalApiToken(request: CreatePersonalApiTokenRequest): Promise<CreatedApiTokenResponse> {
  return send("POST", PERSONAL_API_TOKENS_PATH, request, CreatedApiTokenResponseSchema);
}

/** Revokes one of the person's own tokens (204); 404 `api_token_not_found` for an unknown, another person's or an already revoked one. */
export function revokePersonalApiToken(tokenId: string): Promise<undefined> {
  return send("DELETE", `${PERSONAL_API_TOKENS_PATH}/${encodeURIComponent(tokenId)}`, undefined, undefined);
}

/**
 * The collector catalog: every distribution, in the catalog's order,
 * each with the versions it offers, newest first (deprecated ones are never
 * listed). Signed in, but not an organization's: the catalog is global.
 */
export function getCollectorDistributions(): Promise<CollectorDistributionsResponse> {
  return send("GET", "/api/v1/collector-distributions", undefined, CollectorDistributionsResponseSchema);
}

/**
 * Every flow the caller may see, in full, in the gallery's order: the
 * published ones, and the hidden ones too for a product admin (the API
 * decides). Signed in, not an organization's: flows are global. The YAML
 * is in the list, so the create dialog's picker copies a flow without a
 * second read.
 */
export function getFlows(): Promise<FlowsResponse> {
  return send("GET", "/api/v1/flows", undefined, FlowsResponseSchema);
}

/** One flow by its slug, in full; 404 `flow_not_found` for one the caller may not see. */
export function getFlow(slug: string): Promise<FlowResponse> {
  return send("GET", `/api/v1/flows/${encodeURIComponent(slug)}`, undefined, FlowResponseSchema);
}

/**
 * The open flow read: every published flow, in the gallery's order, YAML
 * included, with no session, for the playground's gallery. Called from the
 * browser only, never a server loader, so its per-address limit (60 a minute
 * over both reads, 429 `rate_limited` with Retry-After) counts the visitor.
 */
export function getPublishedFlows(): Promise<PublishedFlowsResponse> {
  return send("GET", "/api/v1/published-flows", undefined, PublishedFlowsResponseSchema);
}

/** One published flow by its slug, for the playground's flow page; 404 `flow_not_found` for a hidden or unknown one. */
export function getPublishedFlow(slug: string): Promise<PublishedFlowResponse> {
  return send("GET", `/api/v1/published-flows/${encodeURIComponent(slug)}`, undefined, PublishedFlowResponseSchema);
}

/*
 * Product admin's flows writes, from `/product-admin/flows`:
 * each is refused with 403 `product_admin_required` for anyone without the
 * flag, read live on every request.
 */

/**
 * Creates a flow, its source always `telflo`; 409 `flow_slug_taken` for a
 * slug another flow has, 400 `collector_distribution_unknown` or
 * `collector_version_unknown` for a pin the catalog doesn't offer.
 */
export function createFlow(request: CreateFlowRequest): Promise<FlowResponse> {
  return send("POST", "/api/v1/flows", request, FlowResponseSchema);
}

/**
 * Changes the fields `request` names, and only those: a pin it leaves out
 * stays, even one the catalog no longer offers. The visibility switch
 * sends `published` alone.
 */
export function updateFlow(flowId: string, request: UpdateFlowRequest): Promise<FlowResponse> {
  return send("PATCH", `/api/v1/flows/${encodeURIComponent(flowId)}`, request, FlowResponseSchema);
}

/** Deletes a flow for good; configurations made from it keep their copy. */
export function deleteFlow(flowId: string): Promise<undefined> {
  return send("DELETE", `/api/v1/flows/${encodeURIComponent(flowId)}`, undefined, undefined);
}

/**
 * The security check over a configuration's text: advisory, nothing stored.
 * Its findings and destinations quote the text, so they are configuration
 * text. 429 `rate_limited` past 20 a minute.
 */
export function lintFlow(yaml: string): Promise<FlowLintResponse> {
  return send("POST", "/api/v1/flows/lint", { yaml }, FlowLintResponseSchema);
}

function configurationsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/configurations`;
}

function configurationPath(organizationId: string, configurationId: string): string {
  return `${configurationsPath(organizationId)}/${encodeURIComponent(configurationId)}`;
}

function configurationVersionsPath(organizationId: string, configurationId: string): string {
  return `${configurationPath(organizationId, configurationId)}/versions`;
}

function configurationVersionPath(organizationId: string, configurationId: string, versionId: string): string {
  return `${configurationVersionsPath(organizationId, configurationId)}/${encodeURIComponent(versionId)}`;
}

/**
 * What a page of the configurations list asks for: how many, after which
 * cursor, the search text, and which filter: every configuration the caller
 * sees, their own, or the published ones.
 */
export interface ConfigurationsQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  filter?: ConfigurationsListFilter;
}

/**
 * The list's query string. An empty search is none, and the filter is sent
 * only when it isn't `all`, so the plain list's address has no query at all:
 * the API's filter is then `all`.
 */
function configurationsQueryString({ limit, cursor, q, filter }: ConfigurationsQuery): string {
  const parameters = new URLSearchParams();
  if (limit !== undefined) parameters.set("limit", String(limit));
  if (cursor !== undefined) parameters.set("cursor", cursor);
  if (q !== undefined && q.trim() !== "") parameters.set("q", q.trim());
  if (filter !== undefined && filter !== "all") parameters.set("filter", filter);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * A page of the active organization's configurations, newest update first.
 * `options.signal` aborts it (`REQUEST_ABORTED`): the pin picker's hang
 * guard.
 */
export function getConfigurations(
  organizationId: string,
  query: ConfigurationsQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<ConfigurationsPage> {
  return send("GET", configurationsPath(organizationId) + configurationsQueryString(query), undefined, ConfigurationsPageSchema, {
    signal: options.signal,
  });
}

/**
 * A configuration's versions without their content or layout: each its id,
 * number, label and published date, highest number first;
 * `filter: "published"` leaves the drafts out (the pin picker's), and the
 * API's `all` is sent as no query at all. The same visibility as the
 * configuration's read: 404 `configuration_not_found` for one the person can't
 * see.
 */
export function getConfigurationVersions(
  organizationId: string,
  configurationId: string,
  options: { filter?: ConfigurationVersionsFilter; signal?: AbortSignal } = {},
): Promise<ConfigurationVersionsResponse> {
  const query = options.filter === undefined || options.filter === "all" ? "" : `?filter=${options.filter}`;
  return send(
    "GET",
    configurationVersionsPath(organizationId, configurationId) + query,
    undefined,
    ConfigurationVersionsResponseSchema,
    { signal: options.signal },
  );
}

/** Creates a configuration in the active organization, with the caller as its creator. */
export function createConfiguration(organizationId: string, request: CreateConfigurationRequest): Promise<ConfigurationResponse> {
  return send("POST", configurationsPath(organizationId), request, ConfigurationResponseSchema);
}

/**
 * A configuration of the active organization, the version the editor opens
 * with its YAML (the caller's selection, else the newest), and every
 * version's summary, newest first.
 */
export function getConfiguration(organizationId: string, configurationId: string): Promise<ConfigurationWithVersionResponse> {
  return send("GET", configurationPath(organizationId, configurationId), undefined, ConfigurationWithVersionResponseSchema);
}

/**
 * A configuration of the active organization, that version of it with its
 * YAML, and every version's summary. A version that isn't the
 * configuration's is 404 `configuration_version_not_found`. `signal` aborts
 * it (the group dialogs' "Variables used" read: a new choice aborts the
 * previous one).
 */
export function getConfigurationVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ConfigurationWithVersionResponse> {
  return send(
    "GET",
    configurationVersionPath(organizationId, configurationId, versionId),
    undefined,
    ConfigurationWithVersionResponseSchema,
    { signal: options.signal },
  );
}

/**
 * Creates the configuration's next version from `sourceVersionId`, holding
 * the text and graph sent: the open version with its unsaved changes. The
 * source is left as it was.
 */
export function createConfigurationVersion(
  organizationId: string,
  configurationId: string,
  request: CreateConfigurationVersionRequest,
): Promise<ConfigurationVersionResponse> {
  return send(
    "POST",
    configurationVersionsPath(organizationId, configurationId),
    request,
    ConfigurationVersionResponseSchema,
  );
}

/** Renames a version; the answer is its summary. */
export function renameConfigurationVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: RenameConfigurationVersionRequest,
): Promise<ConfigurationVersionSummaryResponse> {
  return send(
    "PUT",
    `${configurationVersionPath(organizationId, configurationId, versionId)}/label`,
    request,
    ConfigurationVersionSummaryResponseSchema,
  );
}

/**
 * Publishes a version. The body carries `expectedUpdatedAt`, the open
 * version's `updatedAt` as the tab last loaded or saved it, so a version
 * saved since is refused rather than published unseen. The answer is its
 * summary, now published, as a rename's is. Refusals carry the
 * configuration's codes: 409 `configuration_version_published` (already
 * published), `configuration_version_changed` (saved since the tab saw it,
 * or meanwhile) and `configuration_version_empty`; 503
 * `publishing_unavailable`; 404 `configuration_not_found` and
 * `configuration_version_not_found`.
 */
export function publishConfigurationVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: PublishConfigurationVersionRequest,
): Promise<ConfigurationVersionSummaryResponse> {
  return send(
    "POST",
    `${configurationVersionPath(organizationId, configurationId, versionId)}/publish`,
    request,
    ConfigurationVersionSummaryResponseSchema,
  );
}

/**
 * Checks `yaml` with the collector the version is pinned to:
 * `collectorVersion` is the tab's unsaved pick, left out to use the version's
 * saved pin; the distribution is always the configuration's. Nothing is
 * stored. Refusals carry the configuration's codes: 503
 * `validation_unavailable` (the validator couldn't check it), 429
 * `validation_rate_limited` (with `retryAfterSeconds`), 400
 * `collector_version_unknown`; 404 `configuration_not_found` and
 * `configuration_version_not_found`. Aborted through `options.signal`, it
 * rejects with `REQUEST_ABORTED` (the editor aborts a superseded check). The
 * abort is the browser's only: the API still holds the person's in-flight slot
 * until the validator answers.
 */
export function validateVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: ValidateConfigurationVersionRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ConfigurationValidationResponse> {
  return send(
    "POST",
    `${configurationVersionPath(organizationId, configurationId, versionId)}/validation`,
    request,
    ConfigurationValidationResponseSchema,
    { signal: options.signal },
  );
}

/**
 * Records the version as the caller's selection of the configuration, which
 * `/editor/{id}` opens next.
 */
export function selectConfigurationVersion(
  organizationId: string,
  configurationId: string,
  request: SelectConfigurationVersionRequest,
): Promise<undefined> {
  return send("PUT", `${configurationPath(organizationId, configurationId)}/selected-version`, request, undefined);
}

/**
 * Saves the YAML over one of the configuration's versions, exactly as given.
 * There is no revision check: the last save wins.
 */
export function saveConfigurationVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: SaveConfigurationVersionRequest,
): Promise<ConfigurationVersionResponse> {
  return send(
    "PATCH",
    configurationVersionPath(organizationId, configurationId, versionId),
    request,
    ConfigurationVersionResponseSchema,
  );
}

/** Renames a configuration or changes its description; the editor's toolbar renames with it. */
export function updateConfiguration(
  organizationId: string,
  configurationId: string,
  request: UpdateConfigurationRequest,
): Promise<ConfigurationResponse> {
  return send("PATCH", configurationPath(organizationId, configurationId), request, ConfigurationResponseSchema);
}

/**
 * Deletes a configuration (softly). A published one is first checked against
 * the fleets: 409 `configuration_in_use` while a collector group or a
 * collector uses one of its published versions, 429 `rate_limited` past the
 * person's fleet limits (with `Retry-After`), 503 `fleets_unavailable` when
 * that couldn't be checked; each deletes nothing.
 */
export function deleteConfiguration(organizationId: string, configurationId: string): Promise<undefined> {
  return send("DELETE", configurationPath(organizationId, configurationId), undefined, undefined);
}

// ---------------------------------------------------------------------------
// Fleets. Every member of the organization may call each. Each takes an
// optional `{signal}`: the poll's 10 s hang guard on the reads, the dialogs'
// on the writes (the client has no timeout of its own); an abort rejects with
// `REQUEST_ABORTED`. A fleet's label, a token's bearer and a cursor never go
// in a path; the ids are encoded. Refusals carry the fleets' codes
// (`FLEET_ERROR_CODES`), `organization_not_found`, `rate_limited` (429, with
// `retryAfterSeconds`; the person's fleet limits), `invalid_request` and the
// one 503 `fleets_unavailable`.

function fleetsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/fleets`;
}

function fleetPath(organizationId: string, fleetId: string): string {
  return `${fleetsPath(organizationId)}/${encodeURIComponent(fleetId)}`;
}

/** A page of the fleet list: which status (none for every fleet), how many (50 by default, 100 at most), after which cursor. */
export interface FleetsQuery {
  status?: FleetStatus | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** The list's query string; the first page of every fleet has none. */
function fleetsQueryString({ status, limit, cursor }: FleetsQuery): string {
  const parameters = new URLSearchParams();
  if (status !== undefined) parameters.set("status", status);
  if (limit !== undefined) parameters.set("limit", String(limit));
  if (cursor !== undefined) parameters.set("cursor", cursor);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

/** A page of the organization's fleets, newest first, each with its summary. */
export function getFleets(
  organizationId: string,
  query: FleetsQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<FleetsPage> {
  return send("GET", fleetsPath(organizationId) + fleetsQueryString(query), undefined, FleetsPageSchema, {
    signal: options.signal,
  });
}

/** One fleet with its summary; 404 `fleet_not_found` for one the organization doesn't have. */
export function getFleet(
  organizationId: string,
  fleetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<FleetDetail> {
  return send("GET", fleetPath(organizationId, fleetId), undefined, FleetDetailResponseSchema, {
    signal: options.signal,
  }).then(({ fleet }) => fleet);
}

/**
 * A create's answer: `created` (201) with the fleet, its Default group and
 * both tokens' bearers, given this once; `existing` (200), a retry of a
 * create that had already made the fleet (the same id, label and type), with
 * the fleet alone and no bearer.
 */
export type FleetCreateOutcome = ({ kind: "created" } & FleetCreatedResponse) | { kind: "existing"; fleet: Fleet };

/** 201's shape or 200's: both strict, so no answer fits both. */
const FleetCreateAnswerSchema = FleetCreatedResponseSchema.or(FleetResponseSchema);

const FLEET_CREATE_ANSWER: ResponseParser<FleetCreateOutcome> = {
  parse(value: unknown): FleetCreateOutcome {
    const answer = FleetCreateAnswerSchema.parse(value);
    return "tokens" in answer ? { kind: "created", ...answer } : { kind: "existing", fleet: answer.fleet };
  },
};

/**
 * Creates a fleet. The request's `id` is the dialog's own, so a retry
 * after an unknown outcome is safe: the same id, label and type answer
 * `existing`. A reply that fits neither shape is `unexpected_response`, an
 * unknown outcome too.
 */
export function createFleet(
  organizationId: string,
  request: CreateFleetRequest,
  options: { signal?: AbortSignal } = {},
): Promise<FleetCreateOutcome> {
  return send("POST", fleetsPath(organizationId), request, FLEET_CREATE_ANSWER, { signal: options.signal });
}

/** Renames, archives or unarchives a fleet; the answer has no summary (a read gives one). */
export function updateFleet(
  organizationId: string,
  fleetId: string,
  request: UpdateFleetRequest,
  options: { signal?: AbortSignal } = {},
): Promise<Fleet> {
  return send("PATCH", fleetPath(organizationId, fleetId), request, FleetResponseSchema, {
    signal: options.signal,
  }).then(({ fleet }) => fleet);
}

/**
 * Deletes a fleet with its groups, collectors and tokens. The API
 * waits up to 25 s, then answers 503 `fleets_unavailable` while the
 * opamp-server finishes it; a repeat meanwhile answers the same 503 at
 * once.
 */
export function deleteFleet(
  organizationId: string,
  fleetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send("DELETE", fleetPath(organizationId, fleetId), undefined, undefined, { signal: options.signal });
}

/** Every token of the fleet, newest first, without a bearer. */
export function getEnrollmentTokens(
  organizationId: string,
  fleetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokensResponse> {
  return send("GET", `${fleetPath(organizationId, fleetId)}/tokens`, undefined, EnrollmentTokensResponseSchema, {
    signal: options.signal,
  });
}

/**
 * A fresh bearer for one of the fleet's tokens (`no-store`; one of the
 * person's 10 bearer replies a minute). 409 `enrollment_token_expired` or
 * `enrollment_token_revoked` for a token that can't be used.
 */
export function revealEnrollmentToken(
  organizationId: string,
  fleetId: string,
  tokenId: string,
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokenRevealedResponse> {
  return send(
    "POST",
    `${fleetPath(organizationId, fleetId)}/tokens/${encodeURIComponent(tokenId)}/reveal`,
    undefined,
    EnrollmentTokenRevealedResponseSchema,
    { signal: options.signal },
  );
}

/**
 * Rotates the fleet's rotate token (`no-store`; one of the person's 10 bearer
 * replies a minute): the new token's expiry (null for never) and when the
 * current one's grace ends. The answer (201) is the new token with its
 * bearer, given this once, and the token it succeeds (`predecessorId`, null
 * when none was valid). 409 `fleet_archived` on an archived fleet; 400
 * `invalid_request` with details on `expiresAt` or `graceEndsAt`.
 */
export function rotateEnrollmentToken(
  organizationId: string,
  fleetId: string,
  request: RotateEnrollmentTokenRequest,
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokenRotatedResponse> {
  return send("POST", `${fleetPath(organizationId, fleetId)}/tokens/rotate`, request, EnrollmentTokenRotatedResponseSchema, {
    signal: options.signal,
  });
}

/**
 * Revokes one of the fleet's tokens: idempotent, an already revoked token
 * answers as it is. The answer is the token, without a bearer; 404
 * `enrollment_token_not_found` for one the fleet doesn't hold.
 */
export function revokeEnrollmentToken(
  organizationId: string,
  fleetId: string,
  tokenId: string,
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokenResponse> {
  return send(
    "POST",
    `${fleetPath(organizationId, fleetId)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
    undefined,
    EnrollmentTokenResponseSchema,
    { signal: options.signal },
  );
}

/**
 * Issues the fleet a new default token once all its default tokens are
 * revoked (`no-store`; one of the person's bearer replies a minute). No
 * body: the actor is the session's. The answer (201) is the token with its
 * bearer, the reveal's shape. 409 `enrollment_token_default_exists` while a
 * default token is valid (another member issued one, or an earlier try
 * landed), `fleet_archived` on an archived fleet; 404 `fleet_not_found`.
 */
export function issueDefaultEnrollmentToken(
  organizationId: string,
  fleetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokenRevealedResponse> {
  return send("POST", `${fleetPath(organizationId, fleetId)}/tokens/default`, undefined, EnrollmentTokenRevealedResponseSchema, {
    signal: options.signal,
  });
}

/** Every group of the fleet, the Default group first, then by name; each with its assigned published version. */
export function getCollectorGroups(
  organizationId: string,
  fleetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CollectorGroupsResponse> {
  return send("GET", `${fleetPath(organizationId, fleetId)}/groups`, undefined, CollectorGroupsResponseSchema, {
    signal: options.signal,
  });
}

function groupPath(organizationId: string, fleetId: string, groupId: string): string {
  return `${fleetPath(organizationId, fleetId)}/groups/${encodeURIComponent(groupId)}`;
}

/**
 * Creates a group in the fleet: its name (trimmed by the caller) and,
 * optionally, a published configuration version's id to assign
 * (`assignedVersionId`) and its `annotations` (a server group's mounts under
 * `"telflo"`, made by `annotationsWithDockerMounts`; the paths are
 * configuration text, in the body only). The answer (201) is the group. 409
 * `collector_group_name_taken`; 422 `configuration_version_not_published`; 404
 * `configuration_version_not_found`.
 */
export function createCollectorGroup(
  organizationId: string,
  fleetId: string,
  request: CreateCollectorGroupRequest,
  options: { signal?: AbortSignal } = {},
): Promise<CollectorGroup> {
  return send("POST", `${fleetPath(organizationId, fleetId)}/groups`, request, CollectorGroupResponseSchema, {
    signal: options.signal,
  }).then(({ group }) => group);
}

/**
 * Renames a group, assigns it a published version or clears its assignment
 * (`assignedVersionId: null`), or replaces its `annotations` (an object, the
 * whole of it: the one read with `"telflo"` replaced) or clears them (`null`),
 * in one write: only the fields sent change. The answer is the group as it now
 * is. 409 `collector_group_is_default` for a rename of the Default group.
 */
export function updateCollectorGroup(
  organizationId: string,
  fleetId: string,
  groupId: string,
  request: UpdateCollectorGroupRequest,
  options: { signal?: AbortSignal } = {},
): Promise<CollectorGroup> {
  return send("PATCH", groupPath(organizationId, fleetId, groupId), request, CollectorGroupResponseSchema, {
    signal: options.signal,
  }).then(({ group }) => group);
}

/**
 * A group's install facts (`no-store`): the image its published version's
 * collector version picks, the agent endpoint, whether insecure connections
 * are allowed, the collector, the variables the version's YAML reads
 * (configuration text), the group's mounts and its id. No bearer: the
 * dialog reveals one itself. Refusals: 404 `fleet_not_found`,
 * `collector_group_not_found`; 409 `fleet_archived`,
 * `fleet_type_not_installable`, `collector_group_unassigned`,
 * `collector_group_assignment_deleted`, `collector_version_not_offered`;
 * 503 `install_unavailable` (the templates can't be read).
 */
export function getInstallFacts(
  organizationId: string,
  fleetId: string,
  groupId: string,
  options: { signal?: AbortSignal } = {},
): Promise<InstallFacts> {
  return send("GET", `${groupPath(organizationId, fleetId, groupId)}/install`, undefined, InstallFactsSchema, {
    signal: options.signal,
  });
}

/**
 * A Kubernetes group's install facts (`no-store`): the facts route's
 * Kubernetes form, `HelmInstallFactsSchema` (the image, the endpoint, the
 * insecure flag, the collector, the variables the chart can carry, the group's
 * id, and its Helm install: the chart and its version, the image's repository,
 * the release, role, namespace, replicas and volumes). No bearer: the dialog
 * reveals one itself. Refusals: the server facts' (404 `fleet_not_found`,
 * `collector_group_not_found`; 409 `fleet_archived`,
 * `fleet_type_not_installable`, `collector_group_unassigned`,
 * `collector_group_assignment_deleted`, `collector_version_not_offered`; 503
 * `install_unavailable`) and 409 `collector_group_settings_unreadable`.
 */
export function getHelmInstallFacts(
  organizationId: string,
  fleetId: string,
  groupId: string,
  options: { signal?: AbortSignal } = {},
): Promise<HelmInstallFacts> {
  return send("GET", `${groupPath(organizationId, fleetId, groupId)}/install`, undefined, HelmInstallFactsSchema, {
    signal: options.signal,
  });
}

/** A Linux bundle as the browser saves it: its bytes, and the file name the API's Content-Disposition carries too. */
export interface InstallBundle {
  fileName: string;
  archive: Uint8Array;
}

/**
 * Downloads a group's Linux bundle: a POST whose body holds the method, the
 * arch, the paths and the included variables (configuration text: in the body,
 * never the URL), answered with the `.tar.gz` as its bytes, never decoded
 * (`read: "bytes"`); a refusal's envelope is still read for its code. The file
 * name is the contracts' `installBundleFileName`, the one the API names it
 * with: a cross-origin API's `Content-Disposition` isn't readable here. No
 * bearer in it. The facts' refusals, and 400 `invalid_request` with details on
 * the fields (`env.N.value`, `rootPath`, `executablePath`).
 */
export function downloadInstallBundle(
  organizationId: string,
  fleetId: string,
  groupId: string,
  request: InstallBundleRequestInput,
  options: { signal?: AbortSignal } = {},
): Promise<InstallBundle> {
  return send("POST", `${groupPath(organizationId, fleetId, groupId)}/install-bundle`, request, BYTES, {
    signal: options.signal,
    read: "bytes",
  }).then((archive) => ({ fileName: installBundleFileName(request.method, request.arch), archive }));
}

/**
 * Deletes a group (204): its collectors (and their error history) are deleted
 * in the same transaction. 409 `collector_group_is_default` for the Default
 * group; 404 `collector_group_not_found`. A group of many collectors can take
 * a while: the platform's API waits up to 25 s for the opamp-server (its
 * opamp-server client's `LONG_DELETES`, as for a fleet's or an organization's
 * delete), then answers 503 `fleets_unavailable`; the opamp-server finishes
 * the delete after that hang-up (it runs on its own deadline, not the
 * request's): a later read shows the group gone. The browser's write hang
 * guard (`FLEET_WRITE_TIMEOUT_MS`, 30 s) outlasts the 25 s, so the dialog
 * sees the 503 as an unknown outcome, closes and reloads.
 */
export function deleteCollectorGroup(
  organizationId: string,
  fleetId: string,
  groupId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send("DELETE", groupPath(organizationId, fleetId, groupId), undefined, undefined, { signal: options.signal });
}

function collectorsPath(organizationId: string, fleetId: string): string {
  return `${fleetPath(organizationId, fleetId)}/collectors`;
}

function collectorPath(organizationId: string, fleetId: string, collectorId: string): string {
  return `${collectorsPath(organizationId, fleetId)}/${encodeURIComponent(collectorId)}`;
}

/**
 * A page of a fleet's collectors: the search text (a name or an address it
 * must contain; trimmed, and none when empty), one group's, the sort and its
 * order (the API's newest first when there is none), how many (50 by
 * default, 100 at most) and after which cursor (one of the same sort and
 * order's, else 400 `invalid_request` naming `cursor`).
 */
export interface CollectorsQuery {
  q?: string | undefined;
  groupId?: string | undefined;
  sort?: ListCollectorsQuery["sort"];
  order?: ListCollectorsQuery["order"];
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** The list's query string; the first page with nothing asked has none. */
function collectorsQueryString({ q, groupId, sort, order, limit, cursor }: CollectorsQuery): string {
  const parameters = new URLSearchParams();
  if (q !== undefined && q.trim() !== "") parameters.set("q", q.trim());
  if (groupId !== undefined) parameters.set("groupId", groupId);
  if (sort !== undefined) parameters.set("sort", sort);
  if (order !== undefined) parameters.set("order", order);
  if (limit !== undefined) parameters.set("limit", String(limit));
  if (cursor !== undefined) parameters.set("cursor", cursor);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * A page of the fleet's collectors (`no-store`: each carries its reported
 * attributes and its last error). No total: the page counts on the
 * fleet's summary.
 */
export function getCollectors(
  organizationId: string,
  fleetId: string,
  query: CollectorsQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<CollectorsPage> {
  return send("GET", collectorsPath(organizationId, fleetId) + collectorsQueryString(query), undefined, CollectorsPageSchema, {
    signal: options.signal,
  });
}

/** One of the fleet's collectors (`no-store`); 404 `collector_not_found` for one the fleet doesn't hold. */
export function getCollector(
  organizationId: string,
  fleetId: string,
  collectorId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Collector> {
  return send("GET", collectorPath(organizationId, fleetId, collectorId), undefined, CollectorResponseSchema, {
    signal: options.signal,
  }).then(({ collector }) => collector);
}

/**
 * Renames a collector, moves it to another of the fleet's groups, pins it
 * (by its `kind` and `versionId`) or unpins it (`pin: null`), in one
 * opamp-server transaction: the fields sent land together or not at all.
 * The answer is the collector as it now is.
 */
export function updateCollector(
  organizationId: string,
  fleetId: string,
  collectorId: string,
  request: UpdateCollectorRequest,
  options: { signal?: AbortSignal } = {},
): Promise<Collector> {
  return send("PATCH", collectorPath(organizationId, fleetId, collectorId), request, CollectorResponseSchema, {
    signal: options.signal,
  }).then(({ collector }) => collector);
}

/** Deletes a collector's record and its error history (204). */
export function deleteCollector(
  organizationId: string,
  fleetId: string,
  collectorId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send("DELETE", collectorPath(organizationId, fleetId, collectorId), undefined, undefined, {
    signal: options.signal,
  });
}

/**
 * Pins, or unpins (`pin: null`), up to 500 of the fleet's collectors in one
 * transaction: the ids now pinned as asked (`updated`), and those the fleet
 * no longer holds (`notFound`).
 */
export function pinCollectors(
  organizationId: string,
  fleetId: string,
  request: PinCollectorsRequest,
  options: { signal?: AbortSignal } = {},
): Promise<PinCollectorsResponse> {
  return send("POST", `${collectorsPath(organizationId, fleetId)}/pin`, request, PinCollectorsResponseSchema, {
    signal: options.signal,
  });
}

/** A page's size and cursor: a collector's errors, a fleet's token history. */
export interface PageQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
}

function pageQueryString({ limit, cursor }: PageQuery): string {
  const parameters = new URLSearchParams();
  if (limit !== undefined) parameters.set("limit", String(limit));
  if (cursor !== undefined) parameters.set("cursor", cursor);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * A page of a collector's error history, newest first (`no-store`: each
 * message is the collector's own text). The opamp-server keeps a
 * collector's newest 100 for 30 days.
 */
export function getCollectorErrors(
  organizationId: string,
  fleetId: string,
  collectorId: string,
  query: PageQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<CollectorErrorsPage> {
  return send(
    "GET",
    `${collectorPath(organizationId, fleetId, collectorId)}/errors${pageQueryString(query)}`,
    undefined,
    CollectorErrorsPageSchema,
    { signal: options.signal },
  );
}

/**
 * A page of the fleet's token history, newest first: each event's token id,
 * kind of event, actor (`{userId, email}`, or null) and time; never a bearer
 * or the token's kind. 50 by default, 100 at most; a cursor the API no longer
 * takes answers 400 `invalid_request` naming `cursor`. Not `no-store`: ids,
 * times and members' emails.
 */
export function getEnrollmentTokenEvents(
  organizationId: string,
  fleetId: string,
  query: PageQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<EnrollmentTokenEventsPage> {
  return send(
    "GET",
    `${fleetPath(organizationId, fleetId)}/tokens/events${pageQueryString(query)}`,
    undefined,
    EnrollmentTokenEventsPageSchema,
    { signal: options.signal },
  );
}

/*
 * The quick-deploy links. A link's secret is a credential: it crosses the
 * platform once, inside the create's `url` (`no-store`), and never in a URL
 * this client requests; the list, an extend and a revoke answer links without
 * it.
 */

function quickDeployLinkPath(organizationId: string, fleetId: string, linkId: string): string {
  return `${fleetPath(organizationId, fleetId)}/quick-deploy-links/${encodeURIComponent(linkId)}`;
}

/**
 * Makes a quick-deploy link for a group (a write; `no-store`): the Linux
 * bundle's request (the method, the arch, the paths and the included
 * variables with their values, configuration text in the body only) plus
 * `systemd`. The answer (201) is the link and its `url`, the one copy of
 * the secret, which the contracts' schema checks against
 * `QUICK_DEPLOY_URL_PATTERN` before the dialog builds a command from it.
 * The install's refusals (the facts' and the bundle's, 400
 * `invalid_request` with details on `rootPath`, `executablePath`,
 * `env.N.name`, `env.N.value`), 409 `enrollment_token_default_missing` and
 * `quick_deploy_link_limit_reached`.
 */
export function createQuickDeployLink(
  organizationId: string,
  fleetId: string,
  groupId: string,
  request: CreateQuickDeployLinkRequestInput,
  options: { signal?: AbortSignal } = {},
): Promise<CreateQuickDeployLinkResponse> {
  return send("POST", `${groupPath(organizationId, fleetId, groupId)}/quick-deploy-links`, request, CreateQuickDeployLinkResponseSchema, {
    signal: options.signal,
  });
}

/**
 * A page of the fleet's quick-deploy links, newest first (a read): 50 by
 * default, 100 at most; a cursor the API no longer takes answers 400
 * `invalid_request` naming `cursor`. Each link without a secret, a hash or
 * a value. Not `no-store`: ids, times, emails, paths and names, as the
 * token history.
 */
export function getQuickDeployLinks(
  organizationId: string,
  fleetId: string,
  query: PageQuery = {},
  options: { signal?: AbortSignal } = {},
): Promise<QuickDeployLinksPage> {
  return send(
    "GET",
    `${fleetPath(organizationId, fleetId)}/quick-deploy-links${pageQueryString(query)}`,
    undefined,
    QuickDeployLinksPageSchema,
    { signal: options.signal },
  );
}

/**
 * Extends a link from now by one of the presets (`never`: no expiry). The
 * answer is the link as it now is; 409 `quick_deploy_link_revoked`, 409
 * `quick_deploy_link_limit_reached` (the fleet's other active links already
 * at the cap: an expired link's extend, which would make one more active),
 * 404 `quick_deploy_link_not_found` (another fleet's or organization's too).
 */
export function extendQuickDeployLink(
  organizationId: string,
  fleetId: string,
  linkId: string,
  by: QuickDeployLinkExtension,
  options: { signal?: AbortSignal } = {},
): Promise<QuickDeployLinkResponse> {
  return send("POST", `${quickDeployLinkPath(organizationId, fleetId, linkId)}/extend`, { by }, QuickDeployLinkResponseSchema, {
    signal: options.signal,
  });
}

/**
 * Revokes a link (idempotent: a revoked link answers as it is). The answer
 * is the link as it now is; 404 `quick_deploy_link_not_found`.
 */
export function revokeQuickDeployLink(
  organizationId: string,
  fleetId: string,
  linkId: string,
  options: { signal?: AbortSignal } = {},
): Promise<QuickDeployLinkResponse> {
  return send("POST", `${quickDeployLinkPath(organizationId, fleetId, linkId)}/revoke`, undefined, QuickDeployLinkResponseSchema, {
    signal: options.signal,
  });
}

// ---------------------------------------------------------------------------
// The organization's variables and variable groups. Every path names ids only:
// a variable's name, value or description, and a variable group's name or
// description, are configuration text and travel in bodies alone, never in a
// URL, and no read takes a query (the Variables page's search runs in the
// browser). Refusals carry the variables' codes (`VARIABLE_ERROR_CODES`, the
// one 503 `variables_unavailable` among them), `organization_not_found`,
// `rate_limited` and `invalid_request`.

function variablesPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/variables`;
}

function variablePath(organizationId: string, variableId: string): string {
  return `${variablesPath(organizationId)}/${encodeURIComponent(variableId)}`;
}

function variableGroupsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/variable-groups`;
}

function variableGroupPath(organizationId: string, variableGroupId: string): string {
  return `${variableGroupsPath(organizationId)}/${encodeURIComponent(variableGroupId)}`;
}

/** Every variable of the organization, by name, each with its value (no secrets), who changed it and when. */
export function getOrganizationVariables(
  organizationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationVariable[]> {
  return send("GET", variablesPath(organizationId), undefined, OrganizationVariablesResponseSchema, {
    signal: options.signal,
  }).then(({ variables }) => variables);
}

/**
 * Creates a variable under the browser's own id: a retry with the same
 * id, name, value and description answers it again (200), as the first
 * answer did (201). 409 `variable_name_taken`, `variable_limit_reached`,
 * `variable_conflict` (the id holds another variable).
 */
export function createOrganizationVariable(
  organizationId: string,
  request: CreateOrganizationVariableRequest,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationVariable> {
  return send("POST", variablesPath(organizationId), request, OrganizationVariableResponseSchema, {
    signal: options.signal,
  }).then(({ variable }) => variable);
}

/**
 * Renames a variable, sets its value or its description (null removes it):
 * only the fields sent change. 409 `variable_in_use` for a rename while a
 * used published version references the name (its details name the uses),
 * `variable_name_taken`; 404 `variable_not_found`.
 */
export function updateOrganizationVariable(
  organizationId: string,
  variableId: string,
  request: UpdateOrganizationVariableRequest,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationVariable> {
  return send("PATCH", variablePath(organizationId, variableId), request, OrganizationVariableResponseSchema, {
    signal: options.signal,
  }).then(({ variable }) => variable);
}

/** Deletes a variable. 409 `variable_in_use` while a used published version references it (its details name the uses); 404 `variable_not_found`. */
export function deleteOrganizationVariable(
  organizationId: string,
  variableId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send("DELETE", variablePath(organizationId, variableId), undefined, undefined, { signal: options.signal });
}

/**
 * Default 21's warning: the configurations, among those the member can see,
 * whose current draft references the variable's name. The variable is named
 * by its id, never its name.
 */
export function getVariableDrafts(
  organizationId: string,
  variableId: string,
  options: { signal?: AbortSignal } = {},
): Promise<VariableDraftsResponse["configurations"]> {
  return send("GET", `${variablePath(organizationId, variableId)}/drafts`, undefined, VariableDraftsResponseSchema, {
    signal: options.signal,
  }).then(({ configurations }) => configurations);
}

/** Every variable group of the organization, by name, each with its overrides counted and what uses it. */
export function getVariableGroups(
  organizationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<VariableGroup[]> {
  return send("GET", variableGroupsPath(organizationId), undefined, VariableGroupsResponseSchema, {
    signal: options.signal,
  }).then(({ variableGroups }) => variableGroups);
}

/** Creates a variable group under the browser's own id (a retry is safe). 409 `variable_group_name_taken`, `variable_group_limit_reached`, `variable_group_conflict`. */
export function createVariableGroup(
  organizationId: string,
  request: CreateVariableGroupRequest,
  options: { signal?: AbortSignal } = {},
): Promise<VariableGroup> {
  return send("POST", variableGroupsPath(organizationId), request, VariableGroupResponseSchema, {
    signal: options.signal,
  }).then(({ variableGroup }) => variableGroup);
}

/** A variable group and its overrides; a variable it doesn't override takes the organization's value. 404 `variable_group_not_found`. */
export function getVariableGroup(
  organizationId: string,
  variableGroupId: string,
  options: { signal?: AbortSignal } = {},
): Promise<VariableGroupDetail> {
  return send("GET", variableGroupPath(organizationId, variableGroupId), undefined, VariableGroupDetailSchema, {
    signal: options.signal,
  });
}

/** Renames a variable group or sets its description (null removes it). 409 `variable_group_name_taken`; 404 `variable_group_not_found`. */
export function updateVariableGroup(
  organizationId: string,
  variableGroupId: string,
  request: UpdateVariableGroupRequest,
  options: { signal?: AbortSignal } = {},
): Promise<VariableGroup> {
  return send("PATCH", variableGroupPath(organizationId, variableGroupId), request, VariableGroupResponseSchema, {
    signal: options.signal,
  }).then(({ variableGroup }) => variableGroup);
}

/** Deletes a variable group. 409 `variable_group_in_use` while a collector group or a collector uses it (its details name them); 404 `variable_group_not_found`. */
export function deleteVariableGroup(
  organizationId: string,
  variableGroupId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send("DELETE", variableGroupPath(organizationId, variableGroupId), undefined, undefined, { signal: options.signal });
}

/** Sets a variable's value in a variable group (an override): a new one, a replace and the same value again alike. 404 `variable_group_not_found`, `variable_not_found`. */
export function setVariableGroupOverride(
  organizationId: string,
  variableGroupId: string,
  variableId: string,
  value: string,
  options: { signal?: AbortSignal } = {},
): Promise<VariableGroupOverride> {
  return send(
    "PUT",
    `${variableGroupPath(organizationId, variableGroupId)}/overrides/${encodeURIComponent(variableId)}`,
    { value },
    VariableGroupOverrideResponseSchema,
    { signal: options.signal },
  ).then(({ override }) => override);
}

/** The Reset: the variable takes the organization's value in the group again (204, with an override or none). */
export function resetVariableGroupOverride(
  organizationId: string,
  variableGroupId: string,
  variableId: string,
  options: { signal?: AbortSignal } = {},
): Promise<undefined> {
  return send(
    "DELETE",
    `${variableGroupPath(organizationId, variableGroupId)}/overrides/${encodeURIComponent(variableId)}`,
    undefined,
    undefined,
    { signal: options.signal },
  );
}

/**
 * What the accept page shows for the link's token: the organization, the
 * address, the role, the status, and whether an account holds the
 * address. Needs no session.
 */
export function previewInvitation(request: InvitationTokenRequest): Promise<InvitationPreviewResponse> {
  return send("POST", "/api/v1/invitation-previews", request, InvitationPreviewResponseSchema);
}

/**
 * Accepts the invitation as the signed-in user, who must hold the invited
 * address, and moves the session into the organization when it can.
 */
export function acceptInvitation(request: InvitationTokenRequest): Promise<JoinedOrganizationResponse> {
  return send("POST", "/api/v1/invitation-acceptances", request, JoinedOrganizationResponseSchema);
}

/**
 * Creates an account at the invited address and joins, signed in, in the
 * organization. The API sets the session cookies on the response.
 */
export function registerFromInvitation(request: InvitationRegistrationRequest): Promise<JoinedOrganizationResponse> {
  return send("POST", "/api/v1/invitation-registrations", request, JoinedOrganizationResponseSchema);
}

/*
 * Testing: the caller's own test files in the active organization ("My
 * Files"), and a version's test runs. A file's names, its description, a run's
 * text, its logs and its input's name are private text: they travel only in
 * these bodies, never in a URL.
 */

function testFilesPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/test-files`;
}

function testRunsPath(organizationId: string, configurationId: string, versionId: string): string {
  return `${configurationVersionPath(organizationId, configurationId, versionId)}/test-runs`;
}

function testRunPath(organizationId: string, configurationId: string, versionId: string, runId: string): string {
  return `${testRunsPath(organizationId, configurationId, versionId)}/${encodeURIComponent(runId)}`;
}

/**
 * A test file's multipart body: the parts `displayName`, `description` and
 * `file`, in the only order the API accepts. The content type is never set
 * here: the browser writes it, with its boundary.
 */
function testFileForm(displayName: string, description: string, file: Blob, fileName: string): FormData {
  const form = new FormData();
  form.append("displayName", displayName);
  form.append("description", description);
  form.append("file", file, fileName);
  return form;
}

/** The caller's own test files in the organization, newest first. */
export function getTestFiles(organizationId: string): Promise<TestFilesResponse> {
  return send("GET", testFilesPath(organizationId), undefined, TestFilesResponseSchema);
}

/** An upload: a file from the person's disk, with its display name and description (`''` for none). */
export interface TestFileUpload {
  displayName: string;
  description: string;
  file: File;
}

/**
 * Uploads a test file: up to 10 MiB, its type from its name's
 * extension, one of the six. Refusals: 413 `test_file_too_large`, 415
 * `test_file_type_unsupported`, 429 `rate_limited`, 400 `invalid_request`.
 */
export function uploadTestFile(organizationId: string, upload: TestFileUpload): Promise<TestFileResponse> {
  const form = testFileForm(upload.displayName, upload.description, upload.file, upload.file.name);
  return send("POST", testFilesPath(organizationId), form, TestFileResponseSchema);
}

/** A pasted sample: its display name, its text and its format (JSON or raw lines). */
export interface TestSample {
  displayName: string;
  text: string;
  format: TestSampleFormat;
}

/**
 * Saves a pasted sample to My Files: up to 1 MiB of UTF-8. The
 * file part is typed by its format (`application/json` or `text/plain`),
 * which the API names it by (`testSampleFileName`). The same refusals as an
 * upload's.
 */
export function saveTestSample(organizationId: string, sample: TestSample): Promise<TestFileResponse> {
  const type = sample.format === "json" ? "application/json" : "text/plain";
  const form = testFileForm(
    sample.displayName,
    "",
    new Blob([sample.text], { type }),
    testSampleFileName(sample.displayName, sample.format),
  );
  return send("POST", `${testFilesPath(organizationId)}/samples`, form, TestFileResponseSchema);
}

/**
 * The first TEST_FILE_HEAD_MAXIMUM_BYTES (64 KiB) of one of the caller's test
 * files, as its bytes, never decoded: the run dialog's fixture-shape check
 * for a file from an earlier session. 404 `test_file_not_found` for anyone
 * else's file.
 */
export function getTestFileHead(organizationId: string, fileId: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return send("GET", `${testFilesPath(organizationId)}/${encodeURIComponent(fileId)}/head`, undefined, BYTES, {
    signal: options.signal,
    read: "bytes",
  });
}

/** Deletes one of the caller's test files, its bytes with it; runs keep their own copies. 404 `test_file_not_found`. */
export function deleteTestFile(organizationId: string, fileId: string): Promise<undefined> {
  return send("DELETE", `${testFilesPath(organizationId)}/${encodeURIComponent(fileId)}`, undefined, undefined);
}

/**
 * Queues a run of the version: the raw text the editor holds (the API
 * substitutes organization variables), the pin on screen, the pipeline and
 * its signal, the duration, and one input. Refusals: 503
 * `testing_unavailable`; 429 `test_run_rate_limited` (with
 * `retryAfterSeconds`) and `test_run_queue_full`; 400
 * `collector_version_retired`, `collector_version_unknown` and
 * `invalid_request`; 404 `test_file_not_found`, `test_run_not_found`,
 * `configuration_not_found` and `configuration_version_not_found`.
 */
export function queueTestRun(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: QueueTestRunRequest,
): Promise<TestRunResponse> {
  return send("POST", testRunsPath(organizationId, configurationId, versionId), request, TestRunResponseSchema);
}

/** The version's runs the caller can see, newest first, each with its place in the queue. */
export function getTestRuns(
  organizationId: string,
  configurationId: string,
  versionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TestRunsResponse> {
  return send("GET", testRunsPath(organizationId, configurationId, versionId), undefined, TestRunsResponseSchema, {
    signal: options.signal,
  });
}

/** One run in full: its snapshot and, once it has ended, its results. 404 `test_run_not_found`. */
export function getTestRun(
  organizationId: string,
  configurationId: string,
  versionId: string,
  runId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TestRunResponse> {
  return send("GET", testRunPath(organizationId, configurationId, versionId, runId), undefined, TestRunResponseSchema, {
    signal: options.signal,
  });
}

/**
 * The first TEST_FILE_HEAD_MAXIMUM_BYTES (64 KiB) of a run's input, as its
 * bytes, never decoded: the fixture-shape check before a
 * re-run, without reading the whole input. 404 `test_run_not_found` for a
 * run the caller can't see.
 */
export function getTestRunInputHead(
  organizationId: string,
  configurationId: string,
  versionId: string,
  runId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  return send("GET", `${testRunPath(organizationId, configurationId, versionId, runId)}/files/input/head`, undefined, BYTES, {
    signal: options.signal,
    read: "bytes",
  });
}

/**
 * One of a run's files, as its bytes, never decoded (a UTF-16 input
 * survives). 404 `test_run_not_found` for a file the run didn't store.
 */
export function getTestRunFile(
  organizationId: string,
  configurationId: string,
  versionId: string,
  runId: string,
  file: TestRunFile,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  return send(
    "GET",
    `${testRunPath(organizationId, configurationId, versionId, runId)}/files/${encodeURIComponent(file)}`,
    undefined,
    BYTES,
    { signal: options.signal, read: "bytes" },
  );
}

/*
 * Test suites and their definitions, under a configuration version. A suite's
 * and a definition's names and descriptions, and a definition's input's name,
 * are configuration text: they travel only in these bodies, never in a URL.
 */

function testSuitesPath(organizationId: string, configurationId: string, versionId: string): string {
  return `${configurationVersionPath(organizationId, configurationId, versionId)}/test-suites`;
}

function testSuitePath(organizationId: string, configurationId: string, versionId: string, suiteId: string): string {
  return `${testSuitesPath(organizationId, configurationId, versionId)}/${encodeURIComponent(suiteId)}`;
}

function testDefinitionsPath(organizationId: string, configurationId: string, versionId: string, suiteId: string): string {
  return `${testSuitePath(organizationId, configurationId, versionId, suiteId)}/definitions`;
}

/** The version's suites the caller can see, oldest first. 404 `configuration_not_found` or `configuration_version_not_found`. */
export function getTestSuites(
  organizationId: string,
  configurationId: string,
  versionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TestSuitesResponse> {
  return send("GET", testSuitesPath(organizationId, configurationId, versionId), undefined, TestSuitesResponseSchema, {
    signal: options.signal,
  });
}

/** Creates a suite on the version (any version, published or not). A version's 101st is 409 `test_suite_limit_reached`. */
export function createTestSuite(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: CreateTestSuiteRequest,
): Promise<TestSuiteResponse> {
  return send("POST", testSuitesPath(organizationId, configurationId, versionId), request, TestSuiteResponseSchema);
}

/** Renames a suite, describes it, or both. 404 `test_suite_not_found`. */
export function updateTestSuite(
  organizationId: string,
  configurationId: string,
  versionId: string,
  suiteId: string,
  request: UpdateTestSuiteRequest,
): Promise<TestSuiteResponse> {
  return send("PATCH", testSuitePath(organizationId, configurationId, versionId, suiteId), request, TestSuiteResponseSchema);
}

/** Deletes a suite and its definitions (and any input no other definition uses). 404 `test_suite_not_found`. */
export function deleteTestSuite(organizationId: string, configurationId: string, versionId: string, suiteId: string): Promise<undefined> {
  return send("DELETE", testSuitePath(organizationId, configurationId, versionId, suiteId), undefined, undefined);
}

/** A suite's definitions, oldest first. 404 `test_suite_not_found`. */
export function getTestDefinitions(
  organizationId: string,
  configurationId: string,
  versionId: string,
  suiteId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TestDefinitionsResponse> {
  return send("GET", testDefinitionsPath(organizationId, configurationId, versionId, suiteId), undefined, TestDefinitionsResponseSchema, {
    signal: options.signal,
  });
}

/**
 * Creates a definition in a suite, its input copied at once from one of the
 * caller's files (`inputFileId`) or a live template (`templateId`).
 * Refusals: 409 `test_definition_limit_reached` (a suite's 101st); 404
 * `test_suite_not_found`, `test_file_not_found`, `test_template_not_found`;
 * 429 `rate_limited` (counted with the uploads).
 */
export function createTestDefinition(
  organizationId: string,
  configurationId: string,
  versionId: string,
  suiteId: string,
  request: CreateTestDefinitionRequest,
): Promise<TestDefinitionResponse> {
  return send("POST", testDefinitionsPath(organizationId, configurationId, versionId, suiteId), request, TestDefinitionResponseSchema);
}

/** Deletes a definition (never edited). 404 `test_definition_not_found`. */
export function deleteTestDefinition(
  organizationId: string,
  configurationId: string,
  versionId: string,
  suiteId: string,
  definitionId: string,
): Promise<undefined> {
  return send(
    "DELETE",
    `${testDefinitionsPath(organizationId, configurationId, versionId, suiteId)}/${encodeURIComponent(definitionId)}`,
    undefined,
    undefined,
  );
}

/*
 * Validation pipelines and their rules, under a configuration version. A
 * pipeline's name and a rule's name, description, pattern and OTTL are
 * configuration text: they travel only in these bodies, never in a URL.
 */

function validationPipelinesPath(organizationId: string, configurationId: string, versionId: string): string {
  return `${configurationVersionPath(organizationId, configurationId, versionId)}/validation-pipelines`;
}

function validationPipelinePath(organizationId: string, configurationId: string, versionId: string, validationPipelineId: string): string {
  return `${validationPipelinesPath(organizationId, configurationId, versionId)}/${encodeURIComponent(validationPipelineId)}`;
}

function validationRulesPath(organizationId: string, configurationId: string, versionId: string, validationPipelineId: string): string {
  return `${validationPipelinePath(organizationId, configurationId, versionId, validationPipelineId)}/rules`;
}

/** The version's validation pipelines the caller can see, oldest first. 404 `configuration_not_found` or `configuration_version_not_found`. */
export function getValidationPipelines(
  organizationId: string,
  configurationId: string,
  versionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ValidationPipelinesResponse> {
  return send("GET", validationPipelinesPath(organizationId, configurationId, versionId), undefined, ValidationPipelinesResponseSchema, {
    signal: options.signal,
  });
}

/**
 * Creates a YAML pipeline's validation pipeline on the version (any version,
 * published or not), by the pipeline's name; the API takes its signal from
 * the name. A second for the same pipeline is 409
 * `validation_pipeline_exists`.
 */
export function createValidationPipeline(
  organizationId: string,
  configurationId: string,
  versionId: string,
  request: CreateValidationPipelineRequest,
): Promise<ValidationPipelineResponse> {
  return send("POST", validationPipelinesPath(organizationId, configurationId, versionId), request, ValidationPipelineResponseSchema);
}

/** Deletes a validation pipeline and its rules. 404 `validation_pipeline_not_found`. */
export function deleteValidationPipeline(
  organizationId: string,
  configurationId: string,
  versionId: string,
  validationPipelineId: string,
): Promise<undefined> {
  return send("DELETE", validationPipelinePath(organizationId, configurationId, versionId, validationPipelineId), undefined, undefined);
}

/** A validation pipeline's rules, in position order. 404 `validation_pipeline_not_found`. */
export function getValidationRules(
  organizationId: string,
  configurationId: string,
  versionId: string,
  validationPipelineId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ValidationRulesResponse> {
  return send("GET", validationRulesPath(organizationId, configurationId, versionId, validationPipelineId), undefined, ValidationRulesResponseSchema, {
    signal: options.signal,
  });
}

/**
 * Adds a rule at the end of a validation pipeline. Its OTTL or regex is
 * checked by the evaluator first: 400 `validation_rule_invalid`
 * in the evaluator's words, 503 `rules_unavailable` while it can't be
 * reached, 429 `validation_rule_rate_limited`; a pipeline's 201st is 409
 * `validation_rule_limit_reached`.
 */
export function createValidationRule(
  organizationId: string,
  configurationId: string,
  versionId: string,
  validationPipelineId: string,
  request: CreateValidationRuleRequest,
): Promise<ValidationRuleResponse> {
  return send("POST", validationRulesPath(organizationId, configurationId, versionId, validationPipelineId), request, ValidationRuleResponseSchema);
}

/**
 * Changes a rule: what it checks travels whole (its kind, target and pattern
 * or OTTL), its name and description with it. Refused as a create is; 404
 * `validation_rule_not_found`.
 */
export function updateValidationRule(
  organizationId: string,
  configurationId: string,
  versionId: string,
  validationPipelineId: string,
  ruleId: string,
  request: UpdateValidationRuleRequest,
): Promise<ValidationRuleResponse> {
  return send(
    "PATCH",
    `${validationRulesPath(organizationId, configurationId, versionId, validationPipelineId)}/${encodeURIComponent(ruleId)}`,
    request,
    ValidationRuleResponseSchema,
  );
}

/** Deletes a rule. 404 `validation_rule_not_found`. */
export function deleteValidationRule(
  organizationId: string,
  configurationId: string,
  versionId: string,
  validationPipelineId: string,
  ruleId: string,
): Promise<undefined> {
  return send(
    "DELETE",
    `${validationRulesPath(organizationId, configurationId, versionId, validationPipelineId)}/${encodeURIComponent(ruleId)}`,
    undefined,
    undefined,
  );
}

/**
 * The first TEST_FILE_HEAD_MAXIMUM_BYTES (64 KiB) of a definition's input,
 * as its bytes, never decoded: Play one's fixture-shape check.
 * 404 `test_definition_not_found`.
 */
export function getTestDefinitionInputHead(
  organizationId: string,
  configurationId: string,
  versionId: string,
  suiteId: string,
  definitionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  return send(
    "GET",
    `${testDefinitionsPath(organizationId, configurationId, versionId, suiteId)}/${encodeURIComponent(definitionId)}/input/head`,
    undefined,
    BYTES,
    { signal: options.signal, read: "bytes" },
  );
}

/*
 * Test templates: the product-wide library of sample inputs, read by every
 * member with the current terms. A template's name, description and file name
 * are configuration text: they travel only in these bodies, never in a URL,
 * which names a template by its id alone.
 */

function testTemplatePath(templateId: string): string {
  return `/api/v1/test-templates/${encodeURIComponent(templateId)}`;
}

/**
 * The live templates, newest first, at most TEST_TEMPLATES_LIST_MAXIMUM.
 * Aborted through `options.signal` (its callers' 10 s hang guard), it
 * rejects with REQUEST_ABORTED.
 */
export function getTestTemplates(options: { signal?: AbortSignal } = {}): Promise<TestTemplatesResponse> {
  return send("GET", "/api/v1/test-templates", undefined, TestTemplatesResponseSchema, { signal: options.signal });
}

/**
 * A live template's bytes, whole and never decoded (the Templates step's
 * viewer and download). 404 `test_template_not_found` for a deleted one; 429
 * `rate_limited`, counted with the person's uploads.
 */
export function getTestTemplateFile(templateId: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return send("GET", `${testTemplatePath(templateId)}/file`, undefined, BYTES, { signal: options.signal, read: "bytes" });
}

/**
 * The first TEST_FILE_HEAD_MAXIMUM_BYTES (64 KiB) of a live template's
 * bytes, never decoded: the fixture-shape check before a one-off run from a
 * template. 404 `test_template_not_found`.
 */
export function getTestTemplateFileHead(templateId: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return send("GET", `${testTemplatePath(templateId)}/file/head`, undefined, BYTES, { signal: options.signal, read: "bytes" });
}

/*
 * Product admin's template writes, from `/product-admin/test-templates`: each
 * is refused with 403 `product_admin_required` for anyone without the flag,
 * read live on every request, as flows' writes are.
 */

/** A new template: a file from the admin's disk, with its name, description (`''` for none), receiver type and signal. */
export interface TestTemplateUpload {
  name: string;
  description: string;
  receiverType: string;
  signal: TestRunSignal;
  file: File;
}

/**
 * Uploads a template: multipart, the parts `name`, `description`,
 * `receiverType`, `signal` and `file`, in the only order the API accepts
 * (TEST_TEMPLATE_PART_NAMES); the content type is never set here (the
 * browser writes it, with its boundary). Up to 10 MiB, its type from its
 * name's extension, one of the six. Refusals: 413 `test_file_too_large`,
 * 415 `test_file_type_unsupported`, 400 `invalid_request`.
 */
export function createTestTemplate(upload: TestTemplateUpload): Promise<TestTemplateResponse> {
  const form = new FormData();
  form.append("name", upload.name);
  form.append("description", upload.description);
  form.append("receiverType", upload.receiverType);
  form.append("signal", upload.signal);
  form.append("file", upload.file, upload.file.name);
  return send("POST", "/api/v1/test-templates", form, TestTemplateResponseSchema);
}

/** Changes the metadata `request` names, and only that; the file never changes. 404 `test_template_not_found`. */
export function updateTestTemplate(templateId: string, request: UpdateTestTemplateRequest): Promise<TestTemplateResponse> {
  return send("PATCH", testTemplatePath(templateId), request, TestTemplateResponseSchema);
}

/** Deletes a template (soft; its bytes go): definitions and runs made from it keep their own copies. */
export function deleteTestTemplate(templateId: string): Promise<undefined> {
  return send("DELETE", testTemplatePath(templateId), undefined, undefined);
}

/*
 * The library: the global helper files the Learning Telflo tutorials use,
 * read by every member with the current terms (a product admin's list with
 * or without them). A file's name, description and file name are Telflo's
 * own content: they travel only in these bodies, never in a URL, which
 * names a file by its id alone. A library link (`POST …/:fileId/link`'s
 * path) is a secret: it lives only in that reply's body and, built into the
 * curl command, on the clipboard.
 */

function libraryFilePath(fileId: string): string {
  return `/api/v1/library-files/${encodeURIComponent(fileId)}`;
}

/** The files, newest first, at most LIBRARY_FILES_LIST_MAXIMUM. */
export function getLibraryFiles(options: { signal?: AbortSignal } = {}): Promise<LibraryFilesResponse> {
  return send("GET", "/api/v1/library-files", undefined, LibraryFilesResponseSchema, { signal: options.signal });
}

/**
 * A file's bytes, whole and never decoded (the members' Download, saved
 * under the list's file name by `downloadBlob`). 404
 * `library_file_not_found`; 429 `rate_limited`, counted per person.
 */
export function getLibraryFileBytes(fileId: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return send("GET", `${libraryFilePath(fileId)}/file`, undefined, BYTES, { signal: options.signal, read: "bytes" });
}

/**
 * A library link to the file, valid 24 hours: `{ path }`, the link's path
 * under the API's own origin (the caller puts `window.location.origin` in
 * front). A secret: handed straight to the clipboard, never kept, shown
 * or logged. 404 `library_file_not_found`; 429 `rate_limited`.
 */
export function createLibraryFileLink(fileId: string): Promise<LibraryFileLinkResponse> {
  return send("POST", `${libraryFilePath(fileId)}/link`, undefined, LibraryFileLinkResponseSchema);
}

/*
 * Product admin's library writes, from `/product-admin/library`: each is
 * refused with 403 `product_admin_required` for anyone without the flag, read
 * live.
 */

/** A new library file: a file from the admin's disk, with its name and description (`''` for none). */
export interface LibraryFileUpload {
  name: string;
  description: string;
  file: File;
}

/**
 * Uploads a library file: multipart, the parts `name`, `description` and
 * `file`, in the only order the API accepts (LIBRARY_FILE_PART_NAMES); the
 * content type is never set here (the browser writes it, with its
 * boundary). Any type, up to 10 MiB. Refusals: 413
 * `library_file_too_large`, 400 `invalid_request` (no details).
 */
export function createLibraryFile(upload: LibraryFileUpload): Promise<LibraryFileResponse> {
  const form = new FormData();
  form.append("name", upload.name);
  form.append("description", upload.description);
  form.append("file", upload.file, upload.file.name);
  return send("POST", "/api/v1/library-files", form, LibraryFileResponseSchema);
}

/** Changes the name or the description `request` names, and only those; the file never changes. 404 `library_file_not_found`. */
export function updateLibraryFile(fileId: string, request: UpdateLibraryFileRequest): Promise<LibraryFileResponse> {
  return send("PATCH", libraryFilePath(fileId), request, LibraryFileResponseSchema);
}

/** Deletes a library file (hard; its bytes go after the commit). 404 `library_file_not_found`. */
export function deleteLibraryFile(fileId: string): Promise<undefined> {
  return send("DELETE", libraryFilePath(fileId), undefined, undefined);
}

/*
 * The regex library: the product-wide named patterns the validation-rule
 * picker offers, read by every member with the current terms (a product admin
 * without them, as the test templates' list). An entry's name, category,
 * description and regex are configuration text: they travel only in these
 * bodies, never in a URL, which names an entry by its id alone.
 */

function testRegexPath(testRegexId: string): string {
  return `/api/v1/test-regexes/${encodeURIComponent(testRegexId)}`;
}

/**
 * Every entry, ordered by category, then name (the API's order, under the
 * database's collation). Aborted through `options.signal` (its callers' 10 s
 * hang guard), it rejects with REQUEST_ABORTED.
 */
export function getTestRegexes(options: { signal?: AbortSignal } = {}): Promise<TestRegexesResponse> {
  return send("GET", "/api/v1/test-regexes", undefined, TestRegexesResponseSchema, { signal: options.signal });
}

/*
 * Product admin's regex library writes, from `/product-admin/test-regex`:
 * each is refused with 403 `product_admin_required` for anyone without the
 * flag, read live. A create, and a change of the regex, is checked by the
 * OTTL evaluator's RE2 first: 400 `test_regex_invalid` (its words, each
 * problem under `regex` in `details.problems`), 503 `rules_unavailable`, 429
 * `validation_rule_rate_limited`; a name another entry has is 409
 * `test_regex_name_taken`.
 */

/** Adds an entry (201). */
export function createTestRegex(request: CreateTestRegexRequest): Promise<TestRegexResponse> {
  return send("POST", "/api/v1/test-regexes", request, TestRegexResponseSchema);
}

/** Changes the fields `request` names, and only those. 404 `test_regex_not_found`. */
export function updateTestRegex(testRegexId: string, request: UpdateTestRegexRequest): Promise<TestRegexResponse> {
  return send("PATCH", testRegexPath(testRegexId), request, TestRegexResponseSchema);
}

/** Deletes an entry for good (204): a rule copied its regex, never its id. 404 `test_regex_not_found`. */
export function deleteTestRegex(testRegexId: string): Promise<undefined> {
  return send("DELETE", testRegexPath(testRegexId), undefined, undefined);
}

/*
 * Product administration, from `/product-admin/users`,
 * `/product-admin/product-admins` and `/product-admin/user-feedback`: each
 * is refused with 403 `product_admin_required` for anyone without the flag,
 * read live (and when the flag was cleared while a write waited). Other
 * people's emails, organization names and feedback text travel only in
 * these bodies; a path names a person or an item by its id alone, and the
 * Users search's term is the query `q` only, which no log keeps and which
 * never reaches the address bar (the page holds it in state).
 */

const PRODUCT_ADMIN_PATH = "/api/v1/product-admin";

/** What a page of the Users list asks for: the search (trimmed; empty is none) and a previous page's cursor. */
export interface AdminUsersQuery {
  q?: string;
  cursor?: string;
}

/** A page of live people, newest first, 50 at most, each with the block that stops a delete. */
export function getAdminUsers(query: AdminUsersQuery = {}, options: { signal?: AbortSignal } = {}): Promise<AdminUsersPage> {
  const parameters = new URLSearchParams();
  if (query.q !== undefined && query.q.trim() !== "") parameters.set("q", query.q.trim());
  if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
  const search = parameters.toString();
  return send("GET", `${PRODUCT_ADMIN_PATH}/users${search === "" ? "" : `?${search}`}`, undefined, AdminUsersPageSchema, {
    signal: options.signal,
  });
}

/**
 * Deletes a person (204). 404 `user_not_found`; 409 `user_delete_blocked`
 * (`details.kind`), `user_delete_self` or `user_delete_busy`; 429
 * `rate_limited`.
 */
export function deleteAdminUser(userId: string): Promise<undefined> {
  return send("DELETE", `${PRODUCT_ADMIN_PATH}/users/${encodeURIComponent(userId)}`, undefined, undefined);
}

/** Every product admin, by email. */
export function getProductAdmins(options: { signal?: AbortSignal } = {}): Promise<ProductAdminsResponse> {
  return send("GET", `${PRODUCT_ADMIN_PATH}/product-admins`, undefined, ProductAdminsResponseSchema, { signal: options.signal });
}

/**
 * Makes the live, verified person with this exact email a product admin:
 * 201 on a grant, 200 when they already were one (both answer `{ id, email
 * }`). 404 `product_admin_target_not_found`; 429 `rate_limited`.
 */
export function grantProductAdmin(request: GrantProductAdminRequest): Promise<ProductAdmin> {
  return send("POST", `${PRODUCT_ADMIN_PATH}/product-admins`, request, ProductAdminSchema);
}

/** Removes a product admin's flag (204). 404 `product_admin_not_found`; 409 `last_product_admin`; 429 `rate_limited`. */
export function removeProductAdmin(userId: string): Promise<undefined> {
  return send("DELETE", `${PRODUCT_ADMIN_PATH}/product-admins/${encodeURIComponent(userId)}`, undefined, undefined);
}

/**
 * The site's settings a product admin changes: who may create an
 * organization. No personal data.
 */
export function getProductAdminSettings(options: { signal?: AbortSignal } = {}): Promise<ProductAdminSettings> {
  return send("GET", `${PRODUCT_ADMIN_PATH}/settings`, undefined, ProductAdminSettingsSchema, { signal: options.signal });
}

/** Changes them (200 with the settings, changed or already so). 429 `rate_limited`. */
export function updateProductAdminSettings(
  request: ProductAdminSettings,
  options: { signal?: AbortSignal } = {},
): Promise<ProductAdminSettings> {
  return send("PATCH", `${PRODUCT_ADMIN_PATH}/settings`, request, ProductAdminSettingsSchema, { signal: options.signal });
}

/** A page of pending feedback, newest first, 25 at most, after a previous page's cursor. */
export function getUserFeedback(query: { cursor?: string } = {}, options: { signal?: AbortSignal } = {}): Promise<UserFeedbackPage> {
  const search = query.cursor === undefined ? "" : `?${new URLSearchParams({ cursor: query.cursor }).toString()}`;
  return send("GET", `${PRODUCT_ADMIN_PATH}/feedback${search}`, undefined, UserFeedbackPageSchema, { signal: options.signal });
}

/** How many feedback items are pending: the nav's badge, after a refresh (the server loader reads it otherwise). */
export async function getPendingFeedbackCount(options: { signal?: AbortSignal } = {}): Promise<number> {
  const { count } = await send("GET", `${PRODUCT_ADMIN_PATH}/feedback/pending-count`, undefined, PendingFeedbackCountSchema, {
    signal: options.signal,
  });
  return count;
}

/**
 * Acknowledges a pending item (204): the reply is emailed to its sender and
 * never stored. 404 `feedback_not_found`; 409 `feedback_author_deleted`;
 * 429 `rate_limited`.
 */
export function acknowledgeFeedback(feedbackId: string, request: AcknowledgeFeedbackRequest): Promise<undefined> {
  return send("POST", `${PRODUCT_ADMIN_PATH}/feedback/${encodeURIComponent(feedbackId)}/acknowledge`, request, undefined);
}

/** Dismisses a pending item (204), no email. 404 `feedback_not_found`; 429 `rate_limited`. */
export function dismissFeedback(feedbackId: string): Promise<undefined> {
  return send("POST", `${PRODUCT_ADMIN_PATH}/feedback/${encodeURIComponent(feedbackId)}/dismiss`, undefined, undefined);
}

/**
 * "Contact us": sends the signed-in person's message, in their active
 * organization (201 `{ id }`). 429 `rate_limited` past 10 an hour.
 */
export function createFeedback(request: CreateFeedbackRequest): Promise<CreateFeedbackResponse> {
  return send("POST", "/api/v1/feedback", request, CreateFeedbackResponseSchema);
}

/**
 * The anonymous validate (`POST /api/public/v1/validate/anonymous`), for the
 * playground and the blank public editor: the text, the distribution and the
 * pin, no session, no organization. The answer is the validator's verdict; 429
 * `rate_limited` with `Retry-After` past the route's limits (per address and
 * overall, a minute's count and checks in flight); 400
 * `collector_version_retired` or `collector_version_unknown` for a pin it
 * doesn't check; 413 `payload_too_large` past its 1 MiB body; 503
 * `validation_unavailable`. Every reply is `no-store`, and the route logs the
 * request line only: the text goes into the request body alone, never the URL.
 */
export function validateAnonymously(
  request: PublicValidateRequest,
  options: { signal?: AbortSignal } = {},
): Promise<PublicValidateResponse> {
  return send("POST", "/api/public/v1/validate/anonymous", request, PublicValidateResponseSchema, { signal: options.signal });
}
