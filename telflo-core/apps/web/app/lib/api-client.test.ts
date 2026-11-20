import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  collectorVersionNotOfferedMessage,
  DEFAULT_USER_PREFERENCES,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  FLEETS_UNAVAILABLE_MESSAGE,
  INSTALL_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  QUICK_DEPLOY_LINK_EXTENSIONS,
  type CreateQuickDeployLinkRequestInput,
  type InstallBundleRequestInput,
} from "@telflo/contracts";
import {
  COLLECTOR_ID,
  DATA_MOUNT,
  DEFAULT_GROUP_ID,
  DEFAULT_TOKEN_ID,
  EMPTY_SUMMARY,
  FLEET_ID,
  GATEWAYS_GROUP_ID,
  REPLACED_TOKEN_ID,
  ROTATE_TOKEN_ID,
  TOKEN_EVENT_ID,
  collector,
  collectorError,
  collectorGroup,
  configurationVersionListItem,
  fleet,
  fleetCreated,
  fleetDetail,
  gatewaysGroup,
  helmInstallFacts,
  installFacts,
  listedToken,
  mountsAnnotations,
  NGINX_MOUNT,
  QUICK_DEPLOY_LINK_ID,
  QUICK_DEPLOY_SECRET,
  QUICK_DEPLOY_URL,
  quickDeployLink,
  quickDeployLinkCreated,
  quickDeployLinksPage,
  tokenEvent,
} from "~/test/fleets.js";
import { HIDDEN, TAIL_SAMPLING } from "~/test/flows.js";

// PostHog's reset when the session ends, watched at the analytics
// module's boundary. The mock outlives loadClient's resetModules.
const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", () => analytics);

/**
 * The client talks to a fake API through a custom axios adapter: no network,
 * no fetch stub. Each test says how the fake API answers each
 * "METHOD /path", and afterwards reads back every request that reached it.
 */

type SeenRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  withCredentials: boolean | undefined;
  responseType: string | undefined;
};

/**
 * An answer: JSON (`body`), an HTML page (`html`), bytes (`bytes`), or a
 * JSON envelope sent as bytes (`envelopeAsBytes`), as a browser hands an
 * arraybuffer read's refusal over.
 */
type Reply =
  | { status: number; body?: unknown; html?: string; bytes?: Uint8Array; envelopeAsBytes?: boolean; headers?: Record<string, string> }
  | "network-error"
  | "canceled";

type Route = (request: SeenRequest) => Reply | Promise<Reply>;

const api = {
  routes: {} as Record<string, Route>,
  requests: [] as SeenRequest[],
  /** The AbortSignal each request that reached the fake API carried, in order. */
  signals: [] as (AbortSignal | undefined)[],
  /** The requests that reached the fake API for one route. */
  seen(route: string): SeenRequest[] {
    return this.requests.filter((request) => `${request.method} ${request.url}` === route);
  },
};

function serve(routes: Record<string, Route>): void {
  api.routes = routes;
}

function lowercaseKeys(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
}

/**
 * A fresh copy of the client, with axios answering through the fake API.
 * The adapter goes on axios's defaults before the client module is
 * imported, because `axios.create` copies them when the module loads.
 */
async function loadClient() {
  vi.resetModules();
  const { default: axios, AxiosError, AxiosHeaders, CanceledError } = await import("axios");

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const seen: SeenRequest = {
      method: (config.method ?? "get").toUpperCase(),
      url: `${config.baseURL ?? ""}${config.url ?? ""}`,
      headers: lowercaseKeys(config.headers.toJSON()),
      body: typeof config.data === "string" ? JSON.parse(config.data) : config.data,
      withCredentials: config.withCredentials,
      responseType: config.responseType,
    };
    api.requests.push(seen);
    api.signals.push(config.signal as AbortSignal | undefined);

    const route = api.routes[`${seen.method} ${seen.url}`];
    const reply: Reply = route
      ? await route(seen)
      : { status: 404, body: { error: { code: "not_found", message: `No route ${seen.method} ${seen.url}` } } };

    if (reply === "network-error") {
      throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, {});
    }
    // A cancellation from outside the refresh: this client makes none, so
    // only a test can produce one.
    if (reply === "canceled") throw new CanceledError(undefined, undefined, config);
    // As the network would deliver it: text, which axios then parses.
    const json = reply.body === undefined ? "" : JSON.stringify(reply.body);
    const response = {
      data:
        reply.bytes !== undefined
          ? reply.bytes.buffer.slice(reply.bytes.byteOffset, reply.bytes.byteOffset + reply.bytes.byteLength)
          : reply.envelopeAsBytes === true
            ? new TextEncoder().encode(json).buffer
            : (reply.html ?? json),
      status: reply.status,
      statusText: "",
      headers: new AxiosHeaders({
        "content-type": reply.bytes !== undefined ? "application/gzip" : reply.html === undefined ? "application/json" : "text/html",
        ...reply.headers,
      }),
      config,
      request: {},
    };
    if (config.validateStatus ? config.validateStatus(reply.status) : true) return response;
    throw new AxiosError(
      `Request failed with status code ${reply.status}`,
      reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response,
    );
  };
  axios.defaults.adapter = adapter;

  return import("./api-client.js");
}

let client: Awaited<ReturnType<typeof loadClient>>;
let sessionEnded: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  client = await loadClient();
});

beforeEach(() => {
  api.routes = {};
  api.requests = [];
  api.signals = [];
  sessionEnded = vi.fn();
  client.setSessionEndedHandler(sessionEnded);
  analytics.signedOutLocally.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run, and then some. */
function aMoment(): Promise<void> {
  return new Promise((settle) => setTimeout(settle, 5));
}

const ME = "GET /api/v1/auth/me";
const REFRESH = "POST /api/v1/auth/refresh";
const REGISTER = "POST /api/v1/auth/register";

const CURRENT_USER = {
  user: { id: "0b9f4e0e-6f55-4a8e-9d1c-2f3a4b5c6d7e", email: "person@example.com" },
  organization: { id: "5d1c2f3a-4b5c-4d7e-8f9a-0b1c2d3e4f5a", name: "Acme", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "5d1c2f3a-4b5c-4d7e-8f9a-0b1c2d3e4f5a", name: "Acme", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

const EXPIRED: Reply = {
  status: 401,
  body: { error: { code: "access_token_expired", message: "Your access token has expired." } },
};
const UNAUTHENTICATED: Reply = {
  status: 401,
  body: { error: { code: "unauthenticated", message: "You need to sign in." } },
};
const REFRESHED: Reply = { status: 200, body: { user: CURRENT_USER.user } };

const registration = {
  email: "person@example.com",
  password: "a-sufficiently-long-password",
  acceptedTermsVersion: "2026-01-01",
};

describe("postRegister", () => {
  it("returns the parsed response on success", async () => {
    serve({ [REGISTER]: () => ({ status: 200, body: { status: "verification_sent" } }) });
    expect(await client.postRegister(registration)).toEqual({ status: "verification_sent" });
  });

  it("posts json to the register endpoint", async () => {
    serve({ [REGISTER]: () => ({ status: 200, body: { status: "verification_sent" } }) });
    await client.postRegister(registration);

    const [request] = api.seen(REGISTER);
    expect(request!.headers["content-type"]).toContain("application/json");
    expect(request!.body).toEqual(registration);
  });

  it("sends the CSRF header the API requires on every POST", async () => {
    serve({ [REGISTER]: () => ({ status: 200, body: { status: "verification_sent" } }) });
    await client.postRegister(registration);

    expect(api.seen(REGISTER)[0]!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying the server's code", async () => {
    serve({
      [REGISTER]: () => ({ status: 400, body: { error: { code: "invalid_request", message: "Bad." } } }),
    });
    const failure = client.postRegister(registration);
    await expect(failure).rejects.toThrow(client.ApiError);
    await expect(failure).rejects.toMatchObject({ code: "invalid_request", message: "Bad." });
  });

  it("throws a generic ApiError when the body is not the expected envelope", async () => {
    // A proxy or gateway can return html; that must not surface as a parse crash.
    serve({ [REGISTER]: () => ({ status: 502, html: "<html>Bad Gateway</html>" }) });
    await expect(client.postRegister(registration)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError when a success body isn't JSON", async () => {
    serve({ [REGISTER]: () => ({ status: 200, html: "<html>Welcome</html>" }) });
    await expect(client.postRegister(registration)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError when the network is unreachable", async () => {
    serve({ [REGISTER]: () => "network-error" });
    await expect(client.postRegister(registration)).rejects.toMatchObject({ code: "network_error" });
  });

  it("throws an ApiError when a 200 response doesn't match the response schema", async () => {
    // Contract drift on the success path: the server returned 200 with a body
    // that isn't a RegisterResponse. This must surface in the client's own
    // ApiError vocabulary, not as a raw ZodError.
    serve({ [REGISTER]: () => ({ status: 200, body: { status: "not-a-real-status" } }) });
    const failure = client.postRegister(registration);
    await expect(failure).rejects.toThrow(client.ApiError);
    await expect(failure).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("createSession", () => {
  const SESSIONS = "POST /api/v1/auth/sessions";
  const credentials = { email: "person@example.com", password: "whatever-they-have" };
  const signedIn = { user: CURRENT_USER.user };

  it("posts the credentials to the sessions endpoint with the CSRF header", async () => {
    serve({ [SESSIONS]: () => ({ status: 200, body: signedIn }) });
    expect(await client.createSession(credentials)).toEqual(signedIn);

    const [request] = api.seen(SESSIONS);
    expect(request!.withCredentials).toBe(true);
    expect(request!.body).toEqual(credentials);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying the server's code on refused credentials", async () => {
    serve({
      [SESSIONS]: () => ({
        status: 401,
        body: { error: { code: "invalid_credentials", message: "Invalid email or password." } },
      }),
    });
    await expect(client.createSession(credentials)).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(api.seen(REFRESH)).toHaveLength(0);
  });

  it("treats a 204 where a body is expected as an unexpected response", async () => {
    serve({ [SESSIONS]: () => ({ status: 204 }) });
    await expect(client.createSession(credentials)).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("deleteCurrentSession", () => {
  const CURRENT_SESSION = "DELETE /api/v1/auth/sessions/current";

  it("sends DELETE to the current-session endpoint with the CSRF header and no body", async () => {
    serve({ [CURRENT_SESSION]: () => ({ status: 204 }) });
    await client.deleteCurrentSession();

    const [request] = api.seen(CURRENT_SESSION);
    expect(request!.withCredentials).toBe(true);
    expect(request!.body).toBeUndefined();
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("resolves undefined on a 204", async () => {
    serve({ [CURRENT_SESSION]: () => ({ status: 204 }) });
    await expect(client.deleteCurrentSession()).resolves.toBeUndefined();
  });

  it("maps a 500 error envelope to an ApiError", async () => {
    serve({
      [CURRENT_SESSION]: () => ({
        status: 500,
        body: { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
      }),
    });
    const failure = client.deleteCurrentSession();
    await expect(failure).rejects.toThrow(client.ApiError);
    await expect(failure).rejects.toMatchObject({
      code: "internal_error",
      message: "Something went wrong. Please try again.",
    });
  });

  it("throws an ApiError when the network is unreachable", async () => {
    serve({ [CURRENT_SESSION]: () => "network-error" });
    await expect(client.deleteCurrentSession()).rejects.toMatchObject({ code: "network_error" });
  });
});

const PASSWORD_RESET_REQUESTS = "POST /api/v1/auth/password-reset-requests";
const PASSWORD_RESETS = "POST /api/v1/auth/password-resets";
const VERIFICATION_EMAILS = "POST /api/v1/auth/verification-emails";
const TERMS_ACCEPTANCE = "PUT /api/v1/auth/me/terms-acceptance";
const ACCEPTED: Reply = { status: 202, body: { status: "accepted" } };
const reset = { token: "the-emailed-token", password: "a-new-sufficiently-long-password" };

describe("requestPasswordReset", () => {
  it("posts the address with the CSRF header and parses the accepted response", async () => {
    serve({ [PASSWORD_RESET_REQUESTS]: () => ACCEPTED });
    expect(await client.requestPasswordReset({ email: "person@example.com" })).toEqual({ status: "accepted" });

    const [request] = api.seen(PASSWORD_RESET_REQUESTS);
    expect(request!.body).toEqual({ email: "person@example.com" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError when the response isn't the accepted one", async () => {
    serve({ [PASSWORD_RESET_REQUESTS]: () => ({ status: 202, body: { status: "sent" } }) });
    await expect(client.requestPasswordReset({ email: "person@example.com" })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });
});

describe("resetPassword", () => {
  it("posts the token and password with the CSRF header and resolves undefined on a 204", async () => {
    serve({ [PASSWORD_RESETS]: () => ({ status: 204 }) });
    await expect(client.resetPassword(reset)).resolves.toBeUndefined();

    const [request] = api.seen(PASSWORD_RESETS);
    expect(request!.body).toEqual(reset);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });
});

describe("acceptTerms", () => {
  it("puts the version with the CSRF header and resolves undefined on a 204", async () => {
    serve({ [TERMS_ACCEPTANCE]: () => ({ status: 204 }) });
    await expect(client.acceptTerms({ version: "2026-01-01" })).resolves.toBeUndefined();

    const [request] = api.seen(TERMS_ACCEPTANCE);
    expect(request!.body).toEqual({ version: "2026-01-01" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying terms_version_not_current and the server's message", async () => {
    serve({
      [TERMS_ACCEPTANCE]: () => ({
        status: 400,
        body: { error: { code: "terms_version_not_current", message: "These terms are out of date." } },
      }),
    });
    await expect(client.acceptTerms({ version: "2025-01-01" })).rejects.toMatchObject({
      code: "terms_version_not_current",
      message: "These terms are out of date.",
    });
  });
});

describe("requestVerificationEmail", () => {
  it("posts the address with the CSRF header and parses the accepted response", async () => {
    serve({ [VERIFICATION_EMAILS]: () => ACCEPTED });
    expect(await client.requestVerificationEmail({ email: "person@example.com" })).toEqual({ status: "accepted" });

    const [request] = api.seen(VERIFICATION_EMAILS);
    expect(request!.body).toEqual({ email: "person@example.com" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError when the response isn't the accepted one", async () => {
    serve({ [VERIFICATION_EMAILS]: () => ({ status: 202, body: { status: "sent" } }) });
    await expect(client.requestVerificationEmail({ email: "person@example.com" })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });
});

describe("getCurrentUser", () => {
  it("gets /me with credentials and parses it", async () => {
    serve({ [ME]: () => ({ status: 200, body: CURRENT_USER }) });
    expect(await client.getCurrentUser()).toEqual(CURRENT_USER);
    expect(api.seen(ME)[0]!.withCredentials).toBe(true);
  });

  it("doesn't send the CSRF header on a GET", async () => {
    serve({ [ME]: () => ({ status: 200, body: CURRENT_USER }) });
    await client.getCurrentUser();
    expect(api.seen(ME)[0]!.headers).not.toHaveProperty("x-telflo-csrf");
  });

  it("throws an ApiError when /me doesn't match its schema", async () => {
    serve({ [ME]: () => ({ status: 200, body: { user: CURRENT_USER.user } }) });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

const PREFERENCES_GET = "GET /api/v1/auth/me/preferences";
const PREFERENCES_PATCH = "PATCH /api/v1/auth/me/preferences";
const NAVY_PREFERENCES = {
  theme: "navy",
  editor: { tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true },
  email: { productUpdates: false, productTips: true },
} as const;

describe("getPreferences and updatePreferences", () => {
  it("gets the preferences with credentials and no CSRF header, and parses them", async () => {
    serve({ [PREFERENCES_GET]: () => ({ status: 200, body: NAVY_PREFERENCES }) });
    expect(await client.getPreferences()).toEqual(NAVY_PREFERENCES);
    const [request] = api.seen(PREFERENCES_GET);
    expect(request!.withCredentials).toBe(true);
    expect(request!.headers).not.toHaveProperty("x-telflo-csrf");
  });

  it("patches one key with the CSRF header, and parses every preference after it", async () => {
    serve({ [PREFERENCES_PATCH]: () => ({ status: 200, body: NAVY_PREFERENCES }) });
    expect(await client.updatePreferences({ editor: { fontSize: 16 } })).toEqual(NAVY_PREFERENCES);
    const [request] = api.seen(PREFERENCES_PATCH);
    expect(request!.body).toEqual({ editor: { fontSize: 16 } });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError when the answer doesn't match its schema", async () => {
    serve({ [PREFERENCES_PATCH]: () => ({ status: 200, body: { ...NAVY_PREFERENCES, theme: "system" } }) });
    await expect(client.updatePreferences({ theme: "navy" })).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

const SESSION_A = "4b3a2f1e-0d9c-4b8a-9f7e-6d5c4b3a2f1e";

describe("the account's security calls", () => {
  it("changePassword puts both passwords in the body with the CSRF header, and resolves undefined on a 204", async () => {
    const route = "PUT /api/v1/auth/me/password";
    serve({ [route]: () => ({ status: 204 }) });
    expect(await client.changePassword({ currentPassword: "old one", newPassword: "a new password" })).toBeUndefined();
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ currentPassword: "old one", newPassword: "a new password" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
    expect(request!.url).not.toContain("old");
  });

  it("changePassword carries the API's refusal", async () => {
    serve({
      "PUT /api/v1/auth/me/password": () => ({
        status: 400,
        body: { error: { code: "current_password_incorrect", message: "The current password is incorrect." } },
      }),
    });
    await expect(client.changePassword({ currentPassword: "x", newPassword: "a new password" })).rejects.toMatchObject({
      code: "current_password_incorrect",
      message: "The current password is incorrect.",
    });
  });

  it("getSignInMethods reads and parses them", async () => {
    const methods = {
      hasPassword: true,
      identities: [
        { provider: "google", email: "person@example.com", linkedAt: "2026-10-09T12:00:00.000Z", relinksByEmail: true },
      ],
      providers: [{ id: "google", name: "Google" }],
    };
    serve({ "GET /api/v1/auth/me/sign-in-methods": () => ({ status: 200, body: methods }) });
    expect(await client.getSignInMethods()).toEqual(methods);
  });

  it("createIdentityLinkRequest posts the provider and the password with the CSRF header, and parses the URL", async () => {
    const route = "POST /api/v1/auth/me/identity-link-requests";
    const authorizationUrl = "https://accounts.example.test/authorize?state=s";
    serve({ [route]: () => ({ status: 201, body: { authorizationUrl } }) });
    expect(await client.createIdentityLinkRequest({ provider: "google", currentPassword: "pw" })).toEqual({ authorizationUrl });
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ provider: "google", currentPassword: "pw" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("unlinkIdentity sends DELETE to the provider's path with the password in the body, never the URL", async () => {
    const route = "DELETE /api/v1/auth/me/identities/google";
    serve({ [route]: () => ({ status: 204 }) });
    expect(await client.unlinkIdentity("google", { currentPassword: "secret-pw" })).toBeUndefined();
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ currentPassword: "secret-pw" });
    expect(request!.url).not.toContain("secret-pw");
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("listSessions reads and parses the sessions", async () => {
    const page = {
      items: [
        {
          id: SESSION_A,
          isCurrent: true,
          signedInAt: "2026-10-20T09:15:05.000Z",
          lastActiveAt: "2026-10-22T10:00:00.000Z",
          ipAddress: "203.0.113.7",
          browser: "firefox",
          os: "macos",
        },
      ],
      total: 1,
    };
    serve({ "GET /api/v1/auth/sessions": () => ({ status: 200, body: page }) });
    expect(await client.listSessions()).toEqual(page);
  });

  it("deleteSession and deleteAllSessions send DELETE with the CSRF header", async () => {
    const one = `DELETE /api/v1/auth/sessions/${SESSION_A}`;
    const all = "DELETE /api/v1/auth/sessions";
    serve({ [one]: () => ({ status: 204 }), [all]: () => ({ status: 204 }) });
    expect(await client.deleteSession(SESSION_A)).toBeUndefined();
    expect(await client.deleteAllSessions()).toBeUndefined();
    expect(api.seen(one)[0]!.headers["x-telflo-csrf"]).toBe("1");
    expect(api.seen(all)[0]!.headers["x-telflo-csrf"]).toBe("1");
  });
});

const SWITCH = "PUT /api/v1/auth/sessions/current/organization";
const ORGANIZATIONS = "POST /api/v1/organizations";
const GROUP_ID = "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b";
const GROUP = { id: GROUP_ID, name: "Group", type: "group", logoId: null };

describe("switchOrganization", () => {
  it("puts the organization with the CSRF header and parses the new active organization", async () => {
    const organization = { ...GROUP, role: "contributor" };
    serve({ [SWITCH]: () => ({ status: 200, body: { organization } }) });
    expect(await client.switchOrganization({ organizationId: GROUP_ID })).toEqual({ organization });

    const [request] = api.seen(SWITCH);
    expect(request!.body).toEqual({ organizationId: GROUP_ID });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying organization_access_denied and the server's message", async () => {
    serve({
      [SWITCH]: () => ({
        status: 403,
        body: { error: { code: "organization_access_denied", message: "You are not an active member of this organization" } },
      }),
    });
    await expect(client.switchOrganization({ organizationId: GROUP_ID })).rejects.toMatchObject({
      code: "organization_access_denied",
      message: "You are not an active member of this organization",
    });
  });
});

describe("createOrganization", () => {
  it("posts the name with the CSRF header and parses the created organization", async () => {
    serve({ [ORGANIZATIONS]: () => ({ status: 201, body: { organization: GROUP } }) });
    expect(await client.createOrganization({ name: "Group" })).toEqual({ organization: GROUP });

    const [request] = api.seen(ORGANIZATIONS);
    expect(request!.body).toEqual({ name: "Group" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying organization_name_taken and the server's message", async () => {
    serve({
      [ORGANIZATIONS]: () => ({
        status: 409,
        body: { error: { code: "organization_name_taken", message: "That name is invalid or already exists" } },
      }),
    });
    await expect(client.createOrganization({ name: "Group" })).rejects.toMatchObject({
      code: "organization_name_taken",
      message: "That name is invalid or already exists",
    });
  });
});

describe("renameOrganization", () => {
  it("patches the organization's path with the name and the CSRF header, and parses the renamed organization", async () => {
    const route = `PATCH /api/v1/organizations/${GROUP_ID}`;
    const renamed = { ...GROUP, name: "Renamed" };
    serve({ [route]: () => ({ status: 200, body: { organization: renamed } }) });
    expect(await client.renameOrganization(GROUP_ID, { name: "Renamed" })).toEqual({ organization: renamed });

    const [request] = api.seen(route);
    expect(request!.body).toEqual({ name: "Renamed" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("sends removeLogo: true with the name when asked, in the one JSON request", async () => {
    const route = `PATCH /api/v1/organizations/${GROUP_ID}`;
    serve({ [route]: () => ({ status: 200, body: { organization: GROUP } }) });
    expect(await client.renameOrganization(GROUP_ID, { name: "Group", removeLogo: true })).toEqual({ organization: GROUP });

    const [request] = api.seen(route);
    expect(request!.body).toEqual({ name: "Group", removeLogo: true });
  });
});

/** A multipart body's parts, in order: strings as they are, files as name, type and text. */
async function organizationPartsOf(body: unknown): Promise<[string, unknown][]> {
  expect(body).toBeInstanceOf(FormData);
  const parts: [string, unknown][] = [];
  for (const [name, value] of (body as FormData).entries()) {
    if (typeof value === "string") {
      parts.push([name, value]);
    } else {
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(value);
      });
      parts.push([name, { name: value.name, type: value.type, text }]);
    }
  }
  return parts;
}

describe("organizations with a logo", () => {
  const LOGO_ID = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
  const WITH_LOGO = { ...GROUP, logoId: LOGO_ID };

  it("creates multipart: name then file, with the CSRF header and no content type set by hand, and parses the logo id", async () => {
    serve({ [ORGANIZATIONS]: () => ({ status: 201, body: { organization: WITH_LOGO } }) });
    const file = new File(["png-bytes"], "logo.png", { type: "image/png" });

    expect(await client.createOrganizationWithLogo("Group", file)).toEqual({ organization: WITH_LOGO });

    const [request] = api.seen(ORGANIZATIONS);
    expect(await organizationPartsOf(request!.body)).toEqual([
      ["name", "Group"],
      ["file", { name: "logo.png", type: "image/png", text: "png-bytes" }],
    ]);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
    expect(request!.headers["content-type"] ?? "").not.toMatch(/multipart/i);
  });

  it("changes multipart on the organization's path: name then file", async () => {
    const route = `PATCH /api/v1/organizations/${GROUP_ID}`;
    serve({ [route]: () => ({ status: 200, body: { organization: { ...WITH_LOGO, name: "Renamed" } } }) });
    const file = new File(["webp-bytes"], "logo.webp", { type: "image/webp" });

    expect(await client.changeOrganizationWithLogo(GROUP_ID, "Renamed", file)).toEqual({
      organization: { ...WITH_LOGO, name: "Renamed" },
    });

    const [request] = api.seen(route);
    expect(await organizationPartsOf(request!.body)).toEqual([
      ["name", "Renamed"],
      ["file", { name: "logo.webp", type: "image/webp", text: "webp-bytes" }],
    ]);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it.each([
    { status: 413, code: "organization_logo_too_large", message: "The logo must be 2 MB or smaller." },
    { status: 415, code: "organization_logo_type_unsupported", message: "The logo must be a PNG, JPEG or WebP image." },
  ])("carries the API's $status refusal as its code and words", async ({ status, code, message }) => {
    serve({ [ORGANIZATIONS]: () => ({ status, body: { error: { code, message } } }) });
    const file = new File(["x"], "logo.png", { type: "image/png" });

    await expect(client.createOrganizationWithLogo("Group", file)).rejects.toMatchObject({ code, message, status });
  });

  it("builds the public logo's path from the two ids", () => {
    expect(client.organizationLogoPath(GROUP_ID, LOGO_ID)).toBe(`/api/v1/organization-logos/${GROUP_ID}/${LOGO_ID}`);
  });
});

describe("deleteOrganization", () => {
  it("sends DELETE to the organization's path with the CSRF header, and resolves undefined on a 204", async () => {
    const route = `DELETE /api/v1/organizations/${GROUP_ID}`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.deleteOrganization(GROUP_ID)).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying personal_organization_protected and the server's message", async () => {
    const route = `DELETE /api/v1/organizations/${GROUP_ID}`;
    serve({
      [route]: () => ({
        status: 409,
        body: { error: { code: "personal_organization_protected", message: "A personal organization can't be deleted" } },
      }),
    });
    await expect(client.deleteOrganization(GROUP_ID)).rejects.toMatchObject({
      code: "personal_organization_protected",
      message: "A personal organization can't be deleted",
    });
  });
});

const MEMBER_ID = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const MEMBERS = `GET /api/v1/organizations/${GROUP_ID}/members`;
const MEMBER = `/api/v1/organizations/${GROUP_ID}/members/${MEMBER_ID}`;
const LISTED_MEMBER = {
  userId: MEMBER_ID,
  email: "member@example.com",
  role: "contributor",
  isOrganizationOwner: false,
  createdAt: "2026-03-15T12:00:00.000Z",
  deletedAt: null,
};

describe("getMembers", () => {
  it("gets the organization's members without the CSRF header, and parses them", async () => {
    serve({ [MEMBERS]: () => ({ status: 200, body: { items: [LISTED_MEMBER] } }) });
    expect(await client.getMembers(GROUP_ID)).toEqual({ items: [LISTED_MEMBER] });

    const [request] = api.seen(MEMBERS);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("refreshes an expired access token and retries, as every browser request does", async () => {
    let accessTokenValid = false;
    serve({
      [MEMBERS]: () => (accessTokenValid ? { status: 200, body: { items: [LISTED_MEMBER] } } : EXPIRED),
      [REFRESH]: () => {
        accessTokenValid = true;
        return REFRESHED;
      },
    });

    expect(await client.getMembers(GROUP_ID)).toEqual({ items: [LISTED_MEMBER] });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([MEMBERS, REFRESH, MEMBERS]);
  });

  it("reports a member missing isOrganizationOwner as unexpected_response (contract drift)", async () => {
    const { isOrganizationOwner: _, ...drifted } = LISTED_MEMBER;
    serve({ [MEMBERS]: () => ({ status: 200, body: { items: [drifted] } }) });
    await expect(client.getMembers(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError carrying organization_admin_required and the server's message", async () => {
    serve({
      [MEMBERS]: () => ({
        status: 403,
        body: { error: { code: "organization_admin_required", message: "Only an admin of this organization can do that" } },
      }),
    });
    await expect(client.getMembers(GROUP_ID)).rejects.toMatchObject({
      code: "organization_admin_required",
      message: "Only an admin of this organization can do that",
    });
    expect(api.seen(REFRESH)).toHaveLength(0);
  });
});

describe("changeMemberRole", () => {
  it("patches the member's path with the role and the CSRF header, and resolves undefined on a 204", async () => {
    const route = `PATCH ${MEMBER}`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.changeMemberRole(GROUP_ID, MEMBER_ID, { role: "admin" })).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.body).toEqual({ role: "admin" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying cannot_change_own_membership and the server's message", async () => {
    serve({
      [`PATCH ${MEMBER}`]: () => ({
        status: 409,
        body: { error: { code: "cannot_change_own_membership", message: "You cannot change your own role" } },
      }),
    });
    await expect(client.changeMemberRole(GROUP_ID, MEMBER_ID, { role: "admin" })).rejects.toMatchObject({
      code: "cannot_change_own_membership",
      message: "You cannot change your own role",
    });
  });
});

describe("removeMember", () => {
  it("sends DELETE to the member's path with the CSRF header, and resolves undefined on a 204", async () => {
    const route = `DELETE ${MEMBER}`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.removeMember(GROUP_ID, MEMBER_ID)).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });
});

describe("restoreMember", () => {
  it("puts the member's restoration with the CSRF header, and resolves undefined on a 204", async () => {
    const route = `PUT ${MEMBER}/restoration`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.restoreMember(GROUP_ID, MEMBER_ID)).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying member_not_removed and the server's message", async () => {
    serve({
      [`PUT ${MEMBER}/restoration`]: () => ({
        status: 409,
        body: { error: { code: "member_not_removed", message: "Only deleted members can be restored" } },
      }),
    });
    await expect(client.restoreMember(GROUP_ID, MEMBER_ID)).rejects.toMatchObject({
      code: "member_not_removed",
      message: "Only deleted members can be restored",
    });
  });
});

const INVITATION_ID = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const INVITATIONS = `/api/v1/organizations/${GROUP_ID}/invitations`;
const INVITATION = `${INVITATIONS}/${INVITATION_ID}`;
const LISTED_INVITATION = {
  id: INVITATION_ID,
  email: "invitee@example.com",
  role: "contributor",
  invitedAt: "2026-09-20T12:00:00.000Z",
  expiresAt: "2026-09-27T12:00:00.000Z",
  isExpired: false,
};

describe("the service accounts' calls", () => {
  const ACCOUNT_ID = "5a000000-0000-4000-8000-000000000001";
  const TOKEN_ID = "5b000000-0000-4000-8000-000000000001";
  const ACCOUNTS = `/api/v1/organizations/${GROUP_ID}/service-accounts`;
  const ACCOUNT = `${ACCOUNTS}/${ACCOUNT_ID}`;
  const TOKENS = `${ACCOUNT}/api-tokens`;
  // Built at run time, never a literal, and compared as a boolean only.
  const TOKEN_START = "tf_";
  const token = `${TOKEN_START}${"Ab0_-".repeat(8)}xyz`;
  const SERVICE_ACCOUNT = {
    id: ACCOUNT_ID,
    name: "ci-pipeline",
    email: "ci-pipeline-a3f9c1e2@service-accounts.telflo.invalid",
    createdAt: "2026-09-01T12:00:00.000Z",
    createdBy: { userId: MEMBER_ID, email: "admin@example.com" },
    tokenCount: 1,
  };
  const API_TOKEN = {
    id: TOKEN_ID,
    name: "deploy",
    prefix: token.slice(0, 11),
    access: "write",
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-09-02T12:00:00.000Z",
    isExpired: false,
  };

  it("reads the accounts, an account and its tokens without the CSRF header, and parses them", async () => {
    serve({
      [`GET ${ACCOUNTS}`]: () => ({ status: 200, body: { items: [SERVICE_ACCOUNT] } }),
      [`GET ${ACCOUNT}`]: () => ({ status: 200, body: { serviceAccount: SERVICE_ACCOUNT } }),
      [`GET ${TOKENS}`]: () => ({ status: 200, body: { items: [API_TOKEN] } }),
    });
    expect(await client.getServiceAccounts(GROUP_ID)).toEqual({ items: [SERVICE_ACCOUNT] });
    expect(await client.getServiceAccount(GROUP_ID, ACCOUNT_ID)).toEqual({ serviceAccount: SERVICE_ACCOUNT });
    const listed = await client.getApiTokens(GROUP_ID, ACCOUNT_ID);
    // Booleans first: the list holds the prefix and never the token, then the rest.
    expect(JSON.stringify(listed).includes(token), "the list holding the token").toBe(false);
    expect(listed.items[0]?.prefix === token.slice(0, 11), "the listed prefix").toBe(true);
    expect(listed).toEqual({ items: [API_TOKEN] });
    for (const route of [`GET ${ACCOUNTS}`, `GET ${ACCOUNT}`, `GET ${TOKENS}`]) {
      expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBeUndefined();
    }
  });

  it("creates, renames and deletes an account with the CSRF header, the name in the body", async () => {
    serve({
      [`POST ${ACCOUNTS}`]: () => ({ status: 201, body: { serviceAccount: SERVICE_ACCOUNT } }),
      [`PATCH ${ACCOUNT}`]: () => ({ status: 200, body: { serviceAccount: { ...SERVICE_ACCOUNT, name: "ci-prod" } } }),
      [`DELETE ${ACCOUNT}`]: () => ({ status: 204 }),
    });
    expect(await client.createServiceAccount(GROUP_ID, { name: "ci-pipeline" })).toEqual({ serviceAccount: SERVICE_ACCOUNT });
    expect((await client.renameServiceAccount(GROUP_ID, ACCOUNT_ID, { name: "ci-prod" })).serviceAccount.name).toBe("ci-prod");
    expect(await client.deleteServiceAccount(GROUP_ID, ACCOUNT_ID)).toBeUndefined();
    expect(api.seen(`POST ${ACCOUNTS}`)[0]!.body).toEqual({ name: "ci-pipeline" });
    expect(api.seen(`PATCH ${ACCOUNT}`)[0]!.body).toEqual({ name: "ci-prod" });
    for (const route of [`POST ${ACCOUNTS}`, `PATCH ${ACCOUNT}`, `DELETE ${ACCOUNT}`]) {
      expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBe("1");
      expect(api.seen(route)[0]!.url).not.toContain("ci-");
    }
  });

  it("creates a token and hands its reply back, the token compared only as a boolean", async () => {
    serve({ [`POST ${TOKENS}`]: () => ({ status: 201, body: { apiToken: API_TOKEN, token }, headers: { "cache-control": "no-store" } }) });
    const created = await client.createApiToken(GROUP_ID, ACCOUNT_ID, { name: "deploy", access: "write", expiresInDays: 30 });
    expect(created.token === token, "the reply's token").toBe(true);
    expect(created.apiToken.id).toBe(TOKEN_ID);
    const [request] = api.seen(`POST ${TOKENS}`);
    expect(request!.body).toEqual({ name: "deploy", access: "write", expiresInDays: 30 });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("a create reply whose token isn't one is unexpected_response", async () => {
    serve({ [`POST ${TOKENS}`]: () => ({ status: 201, body: { apiToken: API_TOKEN, token: "not-a-token" } }) });
    await expect(client.createApiToken(GROUP_ID, ACCOUNT_ID, { name: "deploy", access: "read", expiresInDays: null })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("revokes a token with DELETE and the CSRF header", async () => {
    const route = `DELETE ${TOKENS}/${TOKEN_ID}`;
    serve({ [route]: () => ({ status: 204 }) });
    expect(await client.revokeApiToken(GROUP_ID, ACCOUNT_ID, TOKEN_ID)).toBeUndefined();
    expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("carries a refusal's code and fixed message", async () => {
    serve({
      [`GET ${ACCOUNT}`]: () => ({
        status: 404,
        body: { error: { code: "service_account_not_found", message: "Service account not found." } },
      }),
    });
    await expect(client.getServiceAccount(GROUP_ID, ACCOUNT_ID)).rejects.toMatchObject({
      code: "service_account_not_found",
      message: "Service account not found.",
    });
  });
});

describe("getInvitations", () => {
  it("gets the organization's invitations without the CSRF header, and parses them", async () => {
    serve({ [`GET ${INVITATIONS}`]: () => ({ status: 200, body: { items: [LISTED_INVITATION] } }) });
    expect(await client.getInvitations(GROUP_ID)).toEqual({ items: [LISTED_INVITATION] });

    const [request] = api.seen(`GET ${INVITATIONS}`);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("reports an invitation missing isExpired as unexpected_response (contract drift)", async () => {
    const { isExpired: _, ...drifted } = LISTED_INVITATION;
    serve({ [`GET ${INVITATIONS}`]: () => ({ status: 200, body: { items: [drifted] } }) });
    await expect(client.getInvitations(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("inviteMember", () => {
  it("posts the address and role with the CSRF header, and parses the invitation", async () => {
    serve({ [`POST ${INVITATIONS}`]: () => ({ status: 201, body: { invitation: LISTED_INVITATION } }) });
    expect(await client.inviteMember(GROUP_ID, { email: "invitee@example.com", role: "contributor" })).toEqual({
      invitation: LISTED_INVITATION,
    });

    const [request] = api.seen(`POST ${INVITATIONS}`);
    expect(request!.body).toEqual({ email: "invitee@example.com", role: "contributor" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying invitation_already_pending and the server's message", async () => {
    serve({
      [`POST ${INVITATIONS}`]: () => ({
        status: 409,
        body: { error: { code: "invitation_already_pending", message: "User has already been invited to this organization" } },
      }),
    });
    await expect(client.inviteMember(GROUP_ID, { email: "invitee@example.com", role: "admin" })).rejects.toMatchObject({
      code: "invitation_already_pending",
      message: "User has already been invited to this organization",
    });
  });
});

describe("resendInvitation", () => {
  it("posts a delivery of the invitation with the CSRF header, and parses the invitation", async () => {
    const route = `POST ${INVITATION}/deliveries`;
    serve({ [route]: () => ({ status: 201, body: { invitation: LISTED_INVITATION } }) });
    expect(await client.resendInvitation(GROUP_ID, INVITATION_ID)).toEqual({ invitation: LISTED_INVITATION });

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying invitation_not_found and the server's message", async () => {
    serve({
      [`POST ${INVITATION}/deliveries`]: () => ({
        status: 404,
        body: { error: { code: "invitation_not_found", message: "No pending invitation found for this user" } },
      }),
    });
    await expect(client.resendInvitation(GROUP_ID, INVITATION_ID)).rejects.toMatchObject({
      code: "invitation_not_found",
      message: "No pending invitation found for this user",
    });
  });
});

describe("cancelInvitation", () => {
  it("sends DELETE to the invitation's path with the CSRF header, and resolves undefined on a 204", async () => {
    const route = `DELETE ${INVITATION}`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.cancelInvitation(GROUP_ID, INVITATION_ID)).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });
});

const CONFIGURATION_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const CONFIGURATIONS = `/api/v1/organizations/${GROUP_ID}/configurations`;
const CONFIGURATION = `${CONFIGURATIONS}/${CONFIGURATION_ID}`;
const LISTED_CONFIGURATION = {
  id: CONFIGURATION_ID,
  name: "Production Monitoring",
  description: "Collects traces",
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-21T12:00:00.000Z",
  createdBy: { userId: MEMBER_ID, email: "member@example.com" },
  published: true,
  collectorDistribution: "otelcol-contrib",
};

describe("getConfigurations", () => {
  it("gets the first page with no query string and no CSRF header, and parses it", async () => {
    const route = `GET ${CONFIGURATIONS}`;
    const page = { items: [LISTED_CONFIGURATION], nextCursor: "next-page" };
    serve({ [route]: () => ({ status: 200, body: page }) });

    expect(await client.getConfigurations(GROUP_ID)).toEqual(page);
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("sends the limit, the cursor, the search text encoded and trimmed, and the filter", async () => {
    const route = `GET ${CONFIGURATIONS}?limit=10&cursor=abc_-1&q=a+%26+b%25%3F&filter=mine`;
    serve({ [route]: () => ({ status: 200, body: { items: [], nextCursor: null } }) });

    await expect(
      client.getConfigurations(GROUP_ID, { limit: 10, cursor: "abc_-1", q: "  a & b%?  ", filter: "mine" }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(api.seen(route)).toHaveLength(1);
  });

  it("sends filter=published, with the cursor of a next page", async () => {
    const route = `GET ${CONFIGURATIONS}?cursor=abc_-1&filter=published`;
    serve({ [route]: () => ({ status: 200, body: { items: [], nextCursor: null } }) });

    await client.getConfigurations(GROUP_ID, { cursor: "abc_-1", filter: "published" });

    expect(api.seen(route)).toHaveLength(1);
  });

  it("leaves out an empty search and the filter all, which the API takes when there is none", async () => {
    const route = `GET ${CONFIGURATIONS}`;
    serve({ [route]: () => ({ status: 200, body: { items: [], nextCursor: null } }) });

    await client.getConfigurations(GROUP_ID, { q: "   ", filter: "all" });
    await client.getConfigurations(GROUP_ID, { q: "" });

    expect(api.seen(route)).toHaveLength(2);
  });

  it("parses a configuration whose creator's account is gone", async () => {
    const route = `GET ${CONFIGURATIONS}`;
    const page = { items: [{ ...LISTED_CONFIGURATION, createdBy: null }], nextCursor: null };
    serve({ [route]: () => ({ status: 200, body: page }) });

    expect(await client.getConfigurations(GROUP_ID)).toEqual(page);
  });

  it("reports a page missing nextCursor as unexpected_response (contract drift)", async () => {
    serve({ [`GET ${CONFIGURATIONS}`]: () => ({ status: 200, body: { items: [LISTED_CONFIGURATION] } }) });
    await expect(client.getConfigurations(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError carrying terms_acceptance_required and the server's message", async () => {
    serve({
      [`GET ${CONFIGURATIONS}`]: () => ({
        status: 403,
        body: { error: { code: "terms_acceptance_required", message: "Accept the current Terms of Service to continue." } },
      }),
    });
    await expect(client.getConfigurations(GROUP_ID)).rejects.toMatchObject({
      code: "terms_acceptance_required",
      message: "Accept the current Terms of Service to continue.",
    });
  });

  it("carries the caller's AbortSignal on the list's read; aborted in flight, it rejects with REQUEST_ABORTED", async () => {
    const route = `GET ${CONFIGURATIONS}?limit=100&filter=published`;
    serve({ [route]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = client
      .getConfigurations(GROUP_ID, { limit: 100, filter: "published" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    expect(sessionEnded).not.toHaveBeenCalled();
  });
});

describe("getConfigurationVersions", () => {
  const VERSIONS = `GET ${CONFIGURATION}/versions`;

  it("gets the published versions with filter=published, no CSRF header, and parses the four keys", async () => {
    const versions = [
      configurationVersionListItem({ id: VERSION_ID, versionNumber: 5, label: "canary" }),
      configurationVersionListItem({ id: "c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0", versionNumber: 2 }),
    ];
    serve({ [`${VERSIONS}?filter=published`]: () => ({ status: 200, body: { versions } }) });

    expect(await client.getConfigurationVersions(GROUP_ID, CONFIGURATION_ID, { filter: "published" })).toEqual({ versions });
    const [request] = api.seen(`${VERSIONS}?filter=published`);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("sends no query for every version (the API's default filter), and encodes the configuration's id", async () => {
    serve({ [VERSIONS]: () => ({ status: 200, body: { versions: [] } }) });
    await client.getConfigurationVersions(GROUP_ID, CONFIGURATION_ID);
    await client.getConfigurationVersions(GROUP_ID, CONFIGURATION_ID, { filter: "all" });
    expect(api.seen(VERSIONS)).toHaveLength(2);

    const encoded = `GET ${CONFIGURATIONS}/..%2Fx/versions`;
    serve({ [encoded]: () => ({ status: 200, body: { versions: [] } }) });
    await client.getConfigurationVersions(GROUP_ID, "../x");
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports a version carrying more than its four keys as unexpected_response (contract drift)", async () => {
    const body = { versions: [{ ...configurationVersionListItem(), yamlContent: "receivers: {}" }] };
    serve({ [VERSIONS]: () => ({ status: 200, body }) });
    await expect(client.getConfigurationVersions(GROUP_ID, CONFIGURATION_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("a 404: configuration_not_found", async () => {
    serve({
      [VERSIONS]: () => ({ status: 404, body: { error: { code: "configuration_not_found", message: "Configuration not found" } } }),
    });
    await expect(client.getConfigurationVersions(GROUP_ID, CONFIGURATION_ID)).rejects.toMatchObject({
      code: "configuration_not_found",
      status: 404,
    });
  });

  it("carries the caller's AbortSignal", async () => {
    serve({ [`${VERSIONS}?filter=published`]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = client
      .getConfigurationVersions(GROUP_ID, CONFIGURATION_ID, { filter: "published", signal: controller.signal })
      .catch((caught: unknown) => caught);
    await aMoment();
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
  });
});

describe("getCollectorDistributions", () => {
  const route = "GET /api/v1/collector-distributions";
  const CATALOGUE = {
    distributions: [
      {
        id: "otelcol-contrib",
        label: "OpenTelemetry Collector Contrib",
        description: "The full upstream component catalog.",
        icon: "otel",
        isDefault: true,
        versions: [
          {
            version: "0.162.0",
            label: "v0.162.0",
            description: "Current default.",
            releasedAt: "2026-09-29",
            isDefault: true,
            supportedComponents: null,
          },
          {
            version: "0.161.0",
            label: "v0.161.0",
            description: null,
            releasedAt: "2026-09-16",
            isDefault: false,
            supportedComponents: null,
          },
        ],
        renamedTypes: [{ kind: "receiver", name: "file_log", deprecatedName: "filelog", since: "0.149.0" }],
      },
    ],
  };

  it("gets the catalogue, not an organization's, with no CSRF header, and parses it in the API's order", async () => {
    serve({ [route]: () => ({ status: 200, body: CATALOGUE }) });

    expect(await client.getCollectorDistributions()).toEqual(CATALOGUE);
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("reports an answer that isn't the catalogue as unexpected_response", async () => {
    serve({ [route]: () => ({ status: 200, body: { distributions: [{ id: "otelcol-contrib" }] } }) });

    await expect(client.getCollectorDistributions()).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("getFlows and getFlow", () => {
  it("lists every flow the caller may see, not an organization's, with no CSRF header, parsed with the contract", async () => {
    const route = "GET /api/v1/flows";
    const flows = [TAIL_SAMPLING, HIDDEN];
    serve({ [route]: () => ({ status: 200, body: { flows } }) });

    expect(await client.getFlows()).toEqual({ flows });
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("reads one flow by its slug, encoded into the path", async () => {
    serve({ "GET /api/v1/flows/a%2Fb": () => ({ status: 200, body: { flow: TAIL_SAMPLING } }) });

    expect(await client.getFlow("a/b")).toEqual({ flow: TAIL_SAMPLING });
  });

  it("rejects with flow_not_found for a flow the caller may not see", async () => {
    serve({
      [`GET /api/v1/flows/${HIDDEN.slug}`]: () => ({
        status: 404,
        body: { error: { code: "flow_not_found", message: "Flow not found" } },
      }),
    });

    await expect(client.getFlow(HIDDEN.slug)).rejects.toMatchObject({ code: "flow_not_found" });
  });

  it("reports an answer that isn't the list as unexpected_response", async () => {
    serve({ "GET /api/v1/flows": () => ({ status: 200, body: { flows: [{ slug: "x" }] } }) });

    await expect(client.getFlows()).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("validateAnonymously", () => {
  const route = "POST /api/public/v1/validate/anonymous";

  it("posts the text in the body only, to the exact path with no query, with the CSRF header", async () => {
    // A marker in the visitor's text: checked by booleans only, never printed.
    const canary = `zq-anonymous-${crypto.randomUUID()}`;
    const yaml = `receivers:\n  otlp: {}\n# ${canary}\n`;
    serve({ [route]: () => ({ status: 200, body: { valid: true, collectorVersion: "0.162.0", errors: [] } }) });

    const answer = await client.validateAnonymously({ yaml, distribution: "otelcol-contrib", collectorVersion: "0.162.0" });

    expect(answer).toEqual({ valid: true, collectorVersion: "0.162.0", errors: [] });
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(`${request!.method} ${request!.url}`).toBe(route);
    expect(request!.url.includes("?")).toBe(false);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
    expect(JSON.stringify(request!.body).includes(canary)).toBe(true);
    // The text is in the body only: no header and no part of the address carries it.
    expect(request!.url.includes(canary)).toBe(false);
    expect(Object.values(request!.headers).some((value) => value.includes(canary))).toBe(false);
    expect(Object.keys(request!.body as Record<string, unknown>).sort()).toEqual(["collectorVersion", "distribution", "yaml"]);
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it("answers a 429 as rate_limited with its Retry-After, and ends no session", async () => {
    serve({
      [route]: () => ({ status: 429, headers: { "retry-after": "3" }, body: { error: { code: "rate_limited", message: "Too many requests." } } }),
    });
    await expect(client.validateAnonymously({ yaml: "receivers: {}\n" })).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 3 });
    expect(sessionEnded).not.toHaveBeenCalled();
  });
});

describe("getPublishedFlows and getPublishedFlow", () => {
  /** A flow as the open read answers it: in full but its id, published, sortOrder and createdAt. */
  const published = (flow: typeof TAIL_SAMPLING) => {
    const { id: _id, published: _published, sortOrder: _sortOrder, createdAt: _createdAt, ...rest } = flow;
    return rest;
  };

  it("lists the published flows from the open route, with no CSRF header, parsed with the contract", async () => {
    const route = "GET /api/v1/published-flows";
    serve({ [route]: () => ({ status: 200, body: { flows: [published(TAIL_SAMPLING)] } }) });

    expect(await client.getPublishedFlows()).toEqual({ flows: [published(TAIL_SAMPLING)] });
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("reads one by its slug, encoded into the path", async () => {
    serve({ "GET /api/v1/published-flows/a%2Fb": () => ({ status: 200, body: { flow: published(TAIL_SAMPLING) } }) });

    expect(await client.getPublishedFlow("a/b")).toEqual({ flow: published(TAIL_SAMPLING) });
  });

  it("rejects with flow_not_found for a hidden or unknown slug, and rate_limited with its Retry-After", async () => {
    serve({
      [`GET /api/v1/published-flows/${HIDDEN.slug}`]: () => ({
        status: 404,
        body: { error: { code: "flow_not_found", message: "Flow not found" } },
      }),
      "GET /api/v1/published-flows": () => ({
        status: 429,
        headers: { "retry-after": "12" },
        body: { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } },
      }),
    });

    await expect(client.getPublishedFlow(HIDDEN.slug)).rejects.toMatchObject({ code: "flow_not_found" });
    await expect(client.getPublishedFlows()).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 12 });
  });

  it("reports a flow in full (with its id and published) as unexpected_response: the open read's shape is strict", async () => {
    serve({ "GET /api/v1/published-flows": () => ({ status: 200, body: { flows: [TAIL_SAMPLING] } }) });

    await expect(client.getPublishedFlows()).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("the product admin's flows writes", () => {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, source: _source, authorUrl: _authorUrl, ...fields } =
    TAIL_SAMPLING;

  it("creates a flow with the CSRF header, parsed with the contract", async () => {
    const route = "POST /api/v1/flows";
    serve({ [route]: () => ({ status: 201, body: { flow: TAIL_SAMPLING } }) });

    expect(await client.createFlow(fields)).toEqual({ flow: TAIL_SAMPLING });
    const [request] = api.seen(route);
    expect(request!.body).toEqual(fields);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("changes only the fields it is given, at the flow's id, encoded", async () => {
    const route = "PATCH /api/v1/flows/a%2Fb";
    serve({ [route]: () => ({ status: 200, body: { flow: HIDDEN } }) });

    expect(await client.updateFlow("a/b", { published: false })).toEqual({ flow: HIDDEN });
    expect(api.seen(route)[0]!.body).toEqual({ published: false });
    expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("deletes a flow, answering nothing", async () => {
    const route = `DELETE /api/v1/flows/${TAIL_SAMPLING.id}`;
    serve({ [route]: () => ({ status: 204 }) });

    await expect(client.deleteFlow(TAIL_SAMPLING.id)).resolves.toBeUndefined();
    expect(api.seen(route)).toHaveLength(1);
  });

  it("runs the security check over the text, parsed with the contract", async () => {
    const route = "POST /api/v1/flows/lint";
    const answer = {
      blocked: true,
      findings: [{ severity: "block", code: "hardcoded-credential", message: "a key", path: ".exporters.otlp.headers" }],
      destinations: ["exporters.otlp.endpoint → https://collector.example"],
    };
    serve({ [route]: () => ({ status: 200, body: answer }) });

    expect(await client.lintFlow("receivers: {}\n")).toEqual(answer);
    expect(api.seen(route)[0]!.body).toEqual({ yaml: "receivers: {}\n" });
  });

  it("refuses with the API's code and message: a non-admin's 403, the lint's 429", async () => {
    serve({
      "PATCH /api/v1/flows/x": () => ({
        status: 403,
        body: { error: { code: "product_admin_required", message: "Only a product admin can do that." } },
      }),
      "POST /api/v1/flows/lint": () => ({
        status: 429,
        body: { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } },
      }),
    });

    await expect(client.updateFlow("x", { name: "N" })).rejects.toMatchObject({ code: "product_admin_required", status: 403 });
    await expect(client.lintFlow("a: 1\n")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      message: "Too many attempts. Please wait and try again.",
    });
  });

  it("reports a lint answer that isn't the contract's as unexpected_response", async () => {
    serve({ "POST /api/v1/flows/lint": () => ({ status: 200, body: { blocked: false, findings: [] } }) });

    await expect(client.lintFlow("a: 1\n")).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("the collector fields in the configurations requests", () => {
  it("createConfiguration sends the picked distribution", async () => {
    const route = `POST ${CONFIGURATIONS}`;
    serve({ [route]: () => ({ status: 201, body: { configuration: LISTED_CONFIGURATION } }) });

    await client.createConfiguration(GROUP_ID, { name: "A", description: "", collectorDistribution: "otelcol-contrib" });

    expect(api.seen(route)[0]!.body).toEqual({ name: "A", description: "", collectorDistribution: "otelcol-contrib" });
  });

  it("saveConfigurationVersion and createConfigurationVersion send the collector version", async () => {
    const save = `PATCH ${CONFIGURATION}/versions/${VERSION_ID}`;
    const create = `POST ${CONFIGURATION}/versions`;
    const empty = { yamlContent: "", nodes: [], edges: [], pipelines: [] };
    serve({
      [save]: () => ({ status: 200, body: { version: { ...OPENED_VERSION, collectorVersion: "0.161.0" } } }),
      [create]: () => ({ status: 201, body: { version: { ...OPENED_VERSION, collectorVersion: "0.161.0" } } }),
    });

    await client.saveConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { ...empty, collectorVersion: "0.161.0" });
    await client.createConfigurationVersion(GROUP_ID, CONFIGURATION_ID, {
      sourceVersionId: VERSION_ID,
      ...empty,
      collectorVersion: "0.161.0",
    });

    expect(api.seen(save)[0]!.body).toEqual({ ...empty, collectorVersion: "0.161.0" });
    expect(api.seen(create)[0]!.body).toEqual({ sourceVersionId: VERSION_ID, ...empty, collectorVersion: "0.161.0" });
  });
});

describe("createConfiguration", () => {
  it("posts the name and description with the CSRF header, and parses the configuration", async () => {
    const route = `POST ${CONFIGURATIONS}`;
    serve({ [route]: () => ({ status: 201, body: { configuration: LISTED_CONFIGURATION } }) });

    expect(
      await client.createConfiguration(GROUP_ID, { name: "Production Monitoring", description: "Collects traces" }),
    ).toEqual({ configuration: LISTED_CONFIGURATION });
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ name: "Production Monitoring", description: "Collects traces" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying organization_not_found and the server's message", async () => {
    serve({
      [`POST ${CONFIGURATIONS}`]: () => ({
        status: 404,
        body: { error: { code: "organization_not_found", message: "Organization not found" } },
      }),
    });
    await expect(client.createConfiguration(GROUP_ID, { name: "A" })).rejects.toMatchObject({
      code: "organization_not_found",
      message: "Organization not found",
    });
  });
});

describe("updateConfiguration", () => {
  it("patches the configuration's path with the changes and the CSRF header, and parses the configuration", async () => {
    const route = `PATCH ${CONFIGURATION}`;
    const renamed = { ...LISTED_CONFIGURATION, name: "Renamed", description: "" };
    serve({ [route]: () => ({ status: 200, body: { configuration: renamed } }) });

    expect(await client.updateConfiguration(GROUP_ID, CONFIGURATION_ID, { name: "Renamed", description: "" })).toEqual({
      configuration: renamed,
    });
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ name: "Renamed", description: "" });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying configuration_not_found and the server's message", async () => {
    serve({
      [`PATCH ${CONFIGURATION}`]: () => ({
        status: 404,
        body: { error: { code: "configuration_not_found", message: "Configuration not found" } },
      }),
    });
    await expect(client.updateConfiguration(GROUP_ID, CONFIGURATION_ID, { name: "Renamed" })).rejects.toMatchObject({
      code: "configuration_not_found",
      message: "Configuration not found",
    });
  });
});

const VERSION_ID = "0199c000-0000-7000-8000-000000000001";
const OPENED_VERSION = {
  id: VERSION_ID,
  configurationId: CONFIGURATION_ID,
  versionNumber: 1,
  label: "Initial version",
  createdBy: { userId: MEMBER_ID, email: "member@example.com" },
  yamlContent: "receivers:\r\n  otlp:\n",
  nodes: [],
  edges: [],
  pipelines: [],
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-21T12:00:00.000Z",
  // A draft.
  publishedAt: null,
  publishedBy: null,
  collectorVersion: "0.162.0",
  collectorVersionDeprecated: false,
  collectorVersionDeprecatedNote: null,
};
/**
 * A second version, unnamed and by a creator who is gone, published by the
 * member: the list's summary of it.
 */
const NEWER_VERSION_SUMMARY = {
  id: "0199c000-0000-7000-8000-000000000002",
  versionNumber: 2,
  label: null,
  createdBy: null,
  createdAt: "2026-09-22T12:00:00.000Z",
  updatedAt: "2026-09-23T12:00:00.000Z",
  publishedAt: "2026-09-23T13:00:00.000Z",
  publishedBy: { userId: MEMBER_ID, email: "member@example.com" },
  // Pinned to a version the catalogue deprecated since.
  collectorVersion: "0.155.0",
  collectorVersionDeprecated: true,
  collectorVersionDeprecatedNote: "Retired: upgrade to 0.162.0.",
};
const OPENED_VERSION_SUMMARY = {
  id: OPENED_VERSION.id,
  versionNumber: OPENED_VERSION.versionNumber,
  label: OPENED_VERSION.label,
  createdBy: OPENED_VERSION.createdBy,
  createdAt: OPENED_VERSION.createdAt,
  updatedAt: OPENED_VERSION.updatedAt,
  publishedAt: OPENED_VERSION.publishedAt,
  publishedBy: OPENED_VERSION.publishedBy,
  collectorVersion: OPENED_VERSION.collectorVersion,
  collectorVersionDeprecated: OPENED_VERSION.collectorVersionDeprecated,
  collectorVersionDeprecatedNote: OPENED_VERSION.collectorVersionDeprecatedNote,
};
/** A read's answer: the configuration, the version, and every version's summary. */
const OPENED = {
  configuration: LISTED_CONFIGURATION,
  version: OPENED_VERSION,
  versions: [NEWER_VERSION_SUMMARY, OPENED_VERSION_SUMMARY],
};

describe("getConfiguration", () => {
  it("gets the configuration's path with no CSRF header, and parses it, its version and the version list", async () => {
    const route = `GET ${CONFIGURATION}`;
    serve({ [route]: () => ({ status: 200, body: OPENED }) });

    expect(await client.getConfiguration(GROUP_ID, CONFIGURATION_ID)).toEqual(OPENED);
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("encodes the ids in the path", async () => {
    const route = `GET /api/v1/organizations/a%2F..%2Fb/configurations/c%3Fd%23e`;
    serve({ [route]: () => ({ status: 200, body: OPENED }) });
    await client.getConfiguration("a/../b", "c?d#e");
    expect(api.seen(route)).toHaveLength(1);
  });

  it.each([
    ["without its version", { configuration: LISTED_CONFIGURATION, versions: [OPENED_VERSION_SUMMARY] }],
    ["without the version list", { configuration: LISTED_CONFIGURATION, version: OPENED_VERSION }],
    [
      "with a version without its label",
      { ...OPENED, version: { ...OPENED_VERSION, label: undefined } },
    ],
  ])("reports an answer %s as unexpected_response (contract drift)", async (_label, body) => {
    serve({ [`GET ${CONFIGURATION}`]: () => ({ status: 200, body }) });
    await expect(client.getConfiguration(GROUP_ID, CONFIGURATION_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError carrying configuration_not_found and the server's message", async () => {
    serve({
      [`GET ${CONFIGURATION}`]: () => ({
        status: 404,
        body: { error: { code: "configuration_not_found", message: "Configuration not found" } },
      }),
    });
    await expect(client.getConfiguration(GROUP_ID, CONFIGURATION_ID)).rejects.toMatchObject({
      code: "configuration_not_found",
      message: "Configuration not found",
    });
  });
});

describe("saveConfigurationVersion", () => {
  /** A graph as a version stores it. */
  const GRAPH = {
    nodes: [
      {
        id: "node_0",
        type: "receiver" as const,
        position: { x: 50, y: 70 },
        data: {
          label: "OTLP",
          componentType: "receiver" as const,
          componentSubType: "otlp",
          config: { protocols: {} },
        },
      },
    ],
    edges: [{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep" as const }],
    pipelines: [{ id: "pipeline_0", name: "traces", signalType: "traces" as const, color: "#f97316" }],
  };
  const EMPTY_GRAPH = { nodes: [], edges: [], pipelines: [] };

  it("patches the version's path with the YAML exactly as given, the graph and the CSRF header, and parses the version", async () => {
    const route = `PATCH ${CONFIGURATION}/versions/${VERSION_ID}`;
    const yamlContent = "  receivers:\r\n    otlp: {}\n\n";
    const saved = { ...OPENED_VERSION, yamlContent, ...GRAPH, updatedAt: "2026-09-22T12:00:00.000Z" };
    serve({ [route]: () => ({ status: 200, body: { version: saved } }) });

    expect(
      await client.saveConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yamlContent, ...GRAPH }),
    ).toEqual({ version: saved });
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ yamlContent, ...GRAPH });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("accepts an answer whose graph another writer shaped: the response's columns are arrays of anything", async () => {
    const route = `PATCH ${CONFIGURATION}/versions/${VERSION_ID}`;
    const saved = {
      ...OPENED_VERSION,
      nodes: [{ id: "group-pipeline-traces", measured: {} }],
      edges: [1],
      pipelines: [null],
    };
    serve({ [route]: () => ({ status: 200, body: { version: saved } }) });

    expect(
      await client.saveConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, {
        yamlContent: "",
        ...EMPTY_GRAPH,
      }),
    ).toEqual({ version: saved });
  });

  it("encodes every id in the save's path", async () => {
    const route = `PATCH /api/v1/organizations/a%2Fb/configurations/..%2Fc/versions/..%2F..%2Fd%3Fe`;
    serve({ [route]: () => ({ status: 200, body: { version: OPENED_VERSION } }) });
    await client.saveConfigurationVersion("a/b", "../c", "../../d?e", { yamlContent: "", ...EMPTY_GRAPH });
    expect(api.seen(route)).toHaveLength(1);
  });

  it("reports an answer that isn't a version as unexpected_response (contract drift)", async () => {
    serve({ [`PATCH ${CONFIGURATION}/versions/${VERSION_ID}`]: () => ({ status: 200, body: { version: { id: VERSION_ID } } }) });
    await expect(
      client.saveConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yamlContent: "", ...EMPTY_GRAPH }),
    ).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError carrying organization_not_found and the server's message", async () => {
    serve({
      [`PATCH ${CONFIGURATION}/versions/${VERSION_ID}`]: () => ({
        status: 404,
        body: { error: { code: "organization_not_found", message: "Organization not found" } },
      }),
    });
    await expect(
      client.saveConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, {
        yamlContent: "a: 1\n",
        ...EMPTY_GRAPH,
      }),
    ).rejects.toMatchObject({ code: "organization_not_found", message: "Organization not found" });
  });
});

describe("getConfigurationVersion", () => {
  const route = `GET ${CONFIGURATION}/versions/${VERSION_ID}`;

  it("gets the version's path with no CSRF header, and parses the configuration, the version and the list", async () => {
    serve({ [route]: () => ({ status: 200, body: OPENED }) });

    expect(await client.getConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID)).toEqual(OPENED);
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  it("carries the caller's AbortSignal on a version's read; aborted in flight, it rejects with REQUEST_ABORTED", async () => {
    serve({ [route]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = client
      .getConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
  });

  it("encodes every id in the read's path", async () => {
    const encoded = `GET /api/v1/organizations/a%2Fb/configurations/..%2Fc/versions/..%2F..%2Fd%3Fe`;
    serve({ [encoded]: () => ({ status: 200, body: OPENED }) });
    await client.getConfigurationVersion("a/b", "../c", "../../d?e");
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports an answer whose list holds a whole version as unexpected_response (contract drift)", async () => {
    serve({ [route]: () => ({ status: 200, body: { ...OPENED, versions: [OPENED_VERSION] } }) });
    await expect(client.getConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID)).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("throws an ApiError carrying configuration_version_not_found and the server's message", async () => {
    serve({
      [route]: () => ({
        status: 404,
        body: { error: { code: "configuration_version_not_found", message: "Version not found" } },
      }),
    });
    await expect(client.getConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID)).rejects.toMatchObject({
      code: "configuration_version_not_found",
      message: "Version not found",
    });
  });
});

describe("createConfigurationVersion", () => {
  const route = `POST ${CONFIGURATION}/versions`;
  const request = {
    sourceVersionId: VERSION_ID,
    label: "Add tail sampling",
    yamlContent: "receivers:\r\n  otlp: {} # unsaved\n",
    nodes: [],
    edges: [],
    pipelines: [],
  };
  const CREATED = {
    ...OPENED_VERSION,
    id: NEWER_VERSION_SUMMARY.id,
    versionNumber: 2,
    label: "Add tail sampling",
    yamlContent: request.yamlContent,
  };

  it("posts the source, the label and the content with the CSRF header, and parses the new version", async () => {
    serve({ [route]: () => ({ status: 201, body: { version: CREATED } }) });

    expect(await client.createConfigurationVersion(GROUP_ID, CONFIGURATION_ID, request)).toEqual({ version: CREATED });
    const [seen] = api.seen(route);
    expect(seen!.body).toEqual(request);
    expect(seen!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("encodes every id in the create's path", async () => {
    const encoded = `POST /api/v1/organizations/a%2Fb/configurations/..%2Fc%3Fd/versions`;
    serve({ [encoded]: () => ({ status: 201, body: { version: CREATED } }) });
    await client.createConfigurationVersion("a/b", "../c?d", request);
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports an answer that is a summary, not a version, as unexpected_response (contract drift)", async () => {
    serve({ [route]: () => ({ status: 201, body: { version: NEWER_VERSION_SUMMARY } }) });
    await expect(client.createConfigurationVersion(GROUP_ID, CONFIGURATION_ID, request)).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("throws an ApiError carrying configuration_version_not_found and the server's message", async () => {
    serve({
      [route]: () => ({
        status: 404,
        body: { error: { code: "configuration_version_not_found", message: "Version not found" } },
      }),
    });
    await expect(client.createConfigurationVersion(GROUP_ID, CONFIGURATION_ID, request)).rejects.toMatchObject({
      code: "configuration_version_not_found",
      message: "Version not found",
    });
  });
});

describe("renameConfigurationVersion", () => {
  const route = `PUT ${CONFIGURATION}/versions/${VERSION_ID}/label`;
  const RENAMED = { ...OPENED_VERSION_SUMMARY, label: "Renamed" };

  it("puts the label on the version's label path with the CSRF header, and parses the summary", async () => {
    serve({ [route]: () => ({ status: 200, body: { version: RENAMED } }) });

    expect(await client.renameConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { label: "Renamed" })).toEqual({
      version: RENAMED,
    });
    const [seen] = api.seen(route);
    expect(seen!.body).toEqual({ label: "Renamed" });
    expect(seen!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("encodes every id in the rename's path", async () => {
    const encoded = `PUT /api/v1/organizations/a%2Fb/configurations/..%2Fc/versions/..%2F..%2Fd%3Fe/label`;
    serve({ [encoded]: () => ({ status: 200, body: { version: RENAMED } }) });
    await client.renameConfigurationVersion("a/b", "../c", "../../d?e", { label: "Renamed" });
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports an answer that is a whole version as unexpected_response (contract drift)", async () => {
    serve({ [route]: () => ({ status: 200, body: { version: { ...OPENED_VERSION, label: "Renamed" } } }) });
    await expect(
      client.renameConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { label: "Renamed" }),
    ).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError carrying configuration_not_found and the server's message", async () => {
    serve({
      [route]: () => ({
        status: 404,
        body: { error: { code: "configuration_not_found", message: "Configuration not found" } },
      }),
    });
    await expect(
      client.renameConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { label: "Renamed" }),
    ).rejects.toMatchObject({ code: "configuration_not_found", message: "Configuration not found" });
  });
});

describe("publishConfigurationVersion", () => {
  const route = `POST ${CONFIGURATION}/versions/${VERSION_ID}/publish`;
  const PUBLISHED = {
    ...OPENED_VERSION_SUMMARY,
    publishedAt: "2026-10-04T12:00:00.000Z",
    publishedBy: { userId: MEMBER_ID, email: "member@example.com" },
  };

  const EXPECTED = { expectedUpdatedAt: OPENED_VERSION.updatedAt };

  it("posts the updatedAt the tab saw to the version's publish path with the CSRF header, and parses the summary", async () => {
    serve({ [route]: () => ({ status: 200, body: { version: PUBLISHED } }) });

    expect(await client.publishConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, EXPECTED)).toEqual({
      version: PUBLISHED,
    });
    const [seen] = api.seen(route);
    expect(seen!.body).toEqual({ expectedUpdatedAt: OPENED_VERSION.updatedAt });
    expect(seen!.headers["x-telflo-csrf"]).toBe("1");
    expect(seen!.withCredentials).toBe(true);
  });

  it("encodes every id in the path", async () => {
    const encoded = `POST /api/v1/organizations/a%2Fb/configurations/..%2Fc/versions/..%2F..%2Fd%3Fe/publish`;
    serve({ [encoded]: () => ({ status: 200, body: { version: PUBLISHED } }) });
    await client.publishConfigurationVersion("a/b", "../c", "../../d?e", EXPECTED);
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports an answer that is a whole version, or a summary missing its publish fields, as unexpected_response (contract drift)", async () => {
    serve({ [route]: () => ({ status: 200, body: { version: { ...OPENED_VERSION, publishedAt: PUBLISHED.publishedAt } } }) });
    await expect(client.publishConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, EXPECTED)).rejects.toMatchObject({
      code: "unexpected_response",
    });
    const { publishedAt: _publishedAt, ...withoutPublishedAt } = PUBLISHED;
    serve({ [route]: () => ({ status: 200, body: { version: withoutPublishedAt } }) });
    await expect(client.publishConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, EXPECTED)).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it.each([
    [409, "configuration_version_published", "Version 1 is already published."],
    [409, "configuration_version_changed", "This version changed while it was being published. Try again."],
    [409, "configuration_version_empty", "An empty version can't be published."],
    [503, "publishing_unavailable", "Publishing is unavailable right now. Try again."],
    [404, "configuration_version_not_found", "Version not found"],
  ])("throws an ApiError carrying a %i %s and the server's message", async (status, code, message) => {
    serve({ [route]: () => ({ status, body: { error: { code, message } } }) });
    await expect(client.publishConfigurationVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, EXPECTED)).rejects.toMatchObject({
      code,
      message,
    });
  });
});

describe("validateVersion", () => {
  const route = `POST ${CONFIGURATION}/versions/${VERSION_ID}/validation`;
  const ANSWER = {
    status: "invalid",
    collectorVersion: "0.162.0",
    errors: [{ message: "unknown type", componentPath: "exporters::otlp/2" }],
    requirements: [{ category: "env_var", title: "Set environment variable X", description: "d", componentPath: null }],
  };

  it("posts the text, and the tab's pick when given, to the version's validation path with the CSRF header, and parses the answer", async () => {
    serve({ [route]: () => ({ status: 200, body: ANSWER }) });

    expect(await client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" })).toEqual(ANSWER);
    await client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n", collectorVersion: "0.161.0" });
    const [first, second] = api.seen(route);
    expect(first!.body).toEqual({ yaml: "a: 1\n" });
    expect(second!.body).toEqual({ yaml: "a: 1\n", collectorVersion: "0.161.0" });
    expect(first!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("encodes every id in the path", async () => {
    const encoded = `POST /api/v1/organizations/a%2Fb/configurations/..%2Fc/versions/..%2F..%2Fd%3Fe/validation`;
    serve({ [encoded]: () => ({ status: 200, body: ANSWER }) });
    await client.validateVersion("a/b", "../c", "../../d?e", { yaml: "a: 1\n" });
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("reports an answer the contract doesn't allow as unexpected_response", async () => {
    serve({ [route]: () => ({ status: 200, body: { ...ANSWER, status: "maybe" } }) });
    await expect(client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("a 503: the code, the message and the status", async () => {
    const message = "Validation is unavailable. Your YAML was not checked — retry shortly.";
    serve({ [route]: () => ({ status: 503, body: { error: { code: "validation_unavailable", message } } }) });
    const error = await client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(client.ApiError);
    expect(error).toMatchObject({ code: "validation_unavailable", message, status: 503, retryAfterSeconds: undefined });
  });

  it("a 429: retryAfterSeconds from Retry-After", async () => {
    const message = "Too many checks in the last minute. Checking again shortly.";
    serve({
      [route]: () => ({
        status: 429,
        body: { error: { code: "validation_rate_limited", message } },
        headers: { "retry-after": "42" },
      }),
    });
    await expect(client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" })).rejects.toMatchObject({
      code: "validation_rate_limited",
      message,
      status: 429,
      retryAfterSeconds: 42,
    });
  });

  it("no response at all: network_error, with no status", async () => {
    serve({ [route]: () => "network-error" });
    await expect(client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" })).rejects.toMatchObject({
      code: "network_error",
      status: undefined,
    });
  });

  it("carries the caller's AbortSignal on a validation; aborted in flight, it rejects with REQUEST_ABORTED, the session untouched", async () => {
    const controller = new AbortController();
    // As axios's own adapters do: an abort while waiting cancels the request.
    serve({
      [route]: () =>
        new Promise<Reply>((settle) => {
          controller.signal.addEventListener("abort", () => settle("canceled"));
        }),
    });

    const pending = client
      .validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();

    const error = await pending;
    expect(error).toBeInstanceOf(client.ApiError);
    expect(error).toMatchObject({ code: client.REQUEST_ABORTED, status: undefined });
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it("an AbortSignal already aborted: rejects with REQUEST_ABORTED, nothing sent", async () => {
    serve({ [route]: () => ({ status: 200, body: ANSWER }) });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.validateVersion(GROUP_ID, CONFIGURATION_ID, VERSION_ID, { yaml: "a: 1\n" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: client.REQUEST_ABORTED });
    expect(api.seen(route)).toEqual([]);
  });
});

describe("retryAfterSecondsOf (RFC 9110's Retry-After)", () => {
  const NOW = Date.parse("2026-10-07T12:00:00.000Z");

  it("reads delta-seconds as written", () => {
    expect(client.retryAfterSecondsOf("0", NOW)).toBe(0);
    expect(client.retryAfterSecondsOf(" 17 ", NOW)).toBe(17);
  });

  it("reads an HTTP date as the whole seconds from now to it, 0 once past", () => {
    expect(client.retryAfterSecondsOf("Wed, 07 Oct 2026 12:00:30 GMT", NOW)).toBe(30);
    expect(client.retryAfterSecondsOf("Wed, 07 Oct 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it("is undefined when absent or unreadable", () => {
    for (const header of [undefined, null, "", "soon", "-1", "1.5", 3]) {
      expect(client.retryAfterSecondsOf(header, NOW)).toBeUndefined();
    }
  });
});

describe("selectConfigurationVersion", () => {
  const route = `PUT ${CONFIGURATION}/selected-version`;

  it("puts the version id on the configuration's selected-version path with the CSRF header, and resolves undefined on a 204", async () => {
    serve({ [route]: () => ({ status: 204 }) });

    await expect(
      client.selectConfigurationVersion(GROUP_ID, CONFIGURATION_ID, { versionId: VERSION_ID }),
    ).resolves.toBeUndefined();
    const [seen] = api.seen(route);
    expect(seen!.body).toEqual({ versionId: VERSION_ID });
    expect(seen!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("encodes every id in the select's path", async () => {
    const encoded = `PUT /api/v1/organizations/a%2Fb/configurations/..%2Fc%3Fd/selected-version`;
    serve({ [encoded]: () => ({ status: 204 }) });
    await client.selectConfigurationVersion("a/b", "../c?d", { versionId: VERSION_ID });
    expect(api.seen(encoded)).toHaveLength(1);
  });

  it("throws an ApiError carrying configuration_version_not_found and the server's message", async () => {
    serve({
      [route]: () => ({
        status: 404,
        body: { error: { code: "configuration_version_not_found", message: "Version not found" } },
      }),
    });
    await expect(
      client.selectConfigurationVersion(GROUP_ID, CONFIGURATION_ID, { versionId: VERSION_ID }),
    ).rejects.toMatchObject({ code: "configuration_version_not_found", message: "Version not found" });
  });
});

describe("deleteConfiguration", () => {
  it("sends DELETE to the configuration's path with the CSRF header, and resolves undefined on a 204", async () => {
    const route = `DELETE ${CONFIGURATION}`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.deleteConfiguration(GROUP_ID, CONFIGURATION_ID)).resolves.toBeUndefined();

    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("encodes the ids in the path", async () => {
    const route = `DELETE /api/v1/organizations/${GROUP_ID}/configurations/a%2Fb%3Fc`;
    serve({ [route]: () => ({ status: 204 }) });
    await expect(client.deleteConfiguration(GROUP_ID, "a/b?c")).resolves.toBeUndefined();
    expect(api.seen(route)).toHaveLength(1);
  });
});

const FLEETS = `/api/v1/organizations/${GROUP_ID}/fleets`;
const FLEET = `${FLEETS}/${FLEET_ID}`;
const FLEETS_UNAVAILABLE: Reply = { status: 503, body: { error: { code: "fleets_unavailable", message: FLEETS_UNAVAILABLE_MESSAGE } } };

/** A route that answers only once the request's own signal aborts it, as axios's adapters do. */
function hangsUntilAborted(): Route {
  return () =>
    new Promise<Reply>((settle) => {
      const signal = api.signals.at(-1);
      signal?.addEventListener("abort", () => settle("canceled"));
    });
}

describe("the fleet calls", () => {
  describe("getFleets", () => {
    it("gets the first page of every fleet with no query string and no CSRF header, and parses it", async () => {
      const page = { fleets: [fleetDetail()], nextCursor: "next-page" };
      serve({ [`GET ${FLEETS}`]: () => ({ status: 200, body: page }) });

      expect(await client.getFleets(GROUP_ID)).toEqual(page);
      const [request] = api.seen(`GET ${FLEETS}`);
      expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
      expect(request!.withCredentials).toBe(true);
    });

    it("sends the status, the limit and the cursor, encoded", async () => {
      const route = `GET ${FLEETS}?status=archived&limit=100&cursor=a%2Bb%2F%3D`;
      serve({ [route]: () => ({ status: 200, body: { fleets: [], nextCursor: null } }) });

      await expect(client.getFleets(GROUP_ID, { status: "archived", limit: 100, cursor: "a+b/=" })).resolves.toEqual({
        fleets: [],
        nextCursor: null,
      });
      expect(api.seen(route)).toHaveLength(1);
    });

    it("parses a summary's last seen and rotate token state, set and null", async () => {
      const seen = fleetDetail({
        summary: {
          ...EMPTY_SUMMARY,
          collectors: 1,
          online: 1,
          inSync: 1,
          lastSeenAt: "2026-10-14T11:59:30.000Z",
          rotateToken: { expiresAt: "2027-10-14T00:00:00.000Z", graceEndsAt: "2026-11-01T00:00:00.000Z", validCount: 2 },
        },
      });
      const suspended = fleetDetail({ id: FLEET_ID.replace("0a", "0b"), summary: { ...EMPTY_SUMMARY, rotateToken: null } });
      const page = { fleets: [seen, suspended], nextCursor: null };
      serve({ [`GET ${FLEETS}`]: () => ({ status: 200, body: page }) });

      expect(await client.getFleets(GROUP_ID)).toEqual(page);
    });

    it("reports a page whose fleet lacks its summary's new fields as unexpected_response (contract drift)", async () => {
      const { lastSeenAt: _lastSeenAt, ...withoutLastSeen } = EMPTY_SUMMARY;
      serve({
        [`GET ${FLEETS}`]: () => ({ status: 200, body: { fleets: [{ ...fleetDetail(), summary: withoutLastSeen }], nextCursor: null } }),
      });
      await expect(client.getFleets(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("a 429: rate_limited with retryAfterSeconds from Retry-After", async () => {
      serve({
        [`GET ${FLEETS}`]: () => ({
          status: 429,
          body: { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } },
          headers: { "retry-after": "17" },
        }),
      });
      await expect(client.getFleets(GROUP_ID)).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 17 });
    });

    it("a 503: fleets_unavailable with its message", async () => {
      serve({ [`GET ${FLEETS}`]: () => FLEETS_UNAVAILABLE });
      await expect(client.getFleets(GROUP_ID)).rejects.toMatchObject({
        code: "fleets_unavailable",
        message: FLEETS_UNAVAILABLE_MESSAGE,
        status: 503,
      });
    });

    it("carries the caller's AbortSignal; aborted in flight, it rejects with REQUEST_ABORTED, the session untouched", async () => {
      serve({ [`GET ${FLEETS}`]: hangsUntilAborted() });
      const controller = new AbortController();

      const pending = client.getFleets(GROUP_ID, {}, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      expect(api.signals).toEqual([controller.signal]);
      controller.abort();

      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED, status: undefined });
      expect(sessionEnded).not.toHaveBeenCalled();
    });
  });

  describe("getFleet", () => {
    it("gets the fleet by its encoded id, and answers the fleet with its summary", async () => {
      serve({ [`GET ${FLEET}`]: () => ({ status: 200, body: { fleet: fleetDetail() } }) });
      expect(await client.getFleet(GROUP_ID, FLEET_ID)).toEqual(fleetDetail());

      const encoded = `GET ${FLEETS}/..%2F..%2Fauth%2Fme`;
      serve({ [encoded]: () => ({ status: 200, body: { fleet: fleetDetail() } }) });
      await client.getFleet(GROUP_ID, "../../auth/me");
      expect(api.seen(encoded)).toHaveLength(1);
    });

    it("a 404: fleet_not_found", async () => {
      serve({
        [`GET ${FLEET}`]: () => ({ status: 404, body: { error: { code: "fleet_not_found", message: "Fleet not found." } } }),
      });
      await expect(client.getFleet(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "fleet_not_found", status: 404 });
    });

    it("reports a fleet without its summary as unexpected_response", async () => {
      serve({ [`GET ${FLEET}`]: () => ({ status: 200, body: { fleet: fleet() } }) });
      await expect(client.getFleet(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`GET ${FLEET}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.getFleet(GROUP_ID, FLEET_ID, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("createFleet", () => {
    const REQUEST = { id: FLEET_ID, label: "edge-prod", type: "server", rotateExpiresAt: null } as const;

    it("posts the request with the CSRF header; a 201 is created, with the fleet, its Default group and both bearers", async () => {
      serve({ [`POST ${FLEETS}`]: () => ({ status: 201, body: fleetCreated() }) });

      expect(await client.createFleet(GROUP_ID, REQUEST)).toEqual({ kind: "created", ...fleetCreated() });
      const [request] = api.seen(`POST ${FLEETS}`);
      expect(request!.body).toEqual(REQUEST);
      expect(request!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("a 200 (a retry of a create that had made the fleet) is existing, with the fleet alone", async () => {
      serve({ [`POST ${FLEETS}`]: () => ({ status: 200, body: { fleet: fleet() } }) });
      expect(await client.createFleet(GROUP_ID, REQUEST)).toEqual({ kind: "existing", fleet: fleet() });
    });

    it("decides the outcome by the body's shape, not the status: a 201 carrying a 200's shape is existing, a 200 carrying a 201's created", async () => {
      // Both shapes are strict, so a body fits one or neither, whatever the status says.
      serve({ [`POST ${FLEETS}`]: () => ({ status: 201, body: { fleet: fleet() } }) });
      expect(await client.createFleet(GROUP_ID, REQUEST)).toEqual({ kind: "existing", fleet: fleet() });
      serve({ [`POST ${FLEETS}`]: () => ({ status: 200, body: fleetCreated() }) });
      expect(await client.createFleet(GROUP_ID, REQUEST)).toEqual({ kind: "created", ...fleetCreated() });
    });

    it.each([
      ["a 201 missing a bearer", { ...fleetCreated(), tokens: { default: { id: DEFAULT_TOKEN_ID } } }],
      ["a 200 with a field the contract doesn't have", { fleet: fleet(), defaultGroup: null }],
      ["a body that isn't a fleet", { ok: true }],
    ])("reports %s as unexpected_response (an unknown outcome)", async (_name, body) => {
      serve({ [`POST ${FLEETS}`]: () => ({ status: 200, body }) });
      await expect(client.createFleet(GROUP_ID, REQUEST)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("a 409: fleet_label_taken with its message", async () => {
      const message = "Another of the organization's fleets has this label.";
      serve({ [`POST ${FLEETS}`]: () => ({ status: 409, body: { error: { code: "fleet_label_taken", message } } }) });
      await expect(client.createFleet(GROUP_ID, REQUEST)).rejects.toMatchObject({ code: "fleet_label_taken", message, status: 409 });
    });

    it("a 400 invalid_request keeps its details for the dialog to map to a field", async () => {
      const details = [
        {
          keyword: "custom",
          instancePath: "/rotateExpiresAt",
          schemaPath: "#/rotateExpiresAt/custom",
          params: { issue: { code: "custom", path: ["rotateExpiresAt"], message: "Must be a time in the future." } },
          message: "Must be a time in the future.",
        },
      ];
      serve({
        [`POST ${FLEETS}`]: () => ({
          status: 400,
          body: { error: { code: "invalid_request", message: "rotateExpiresAt must be a time in the future.", details } },
        }),
      });
      await expect(client.createFleet(GROUP_ID, REQUEST)).rejects.toMatchObject({ code: "invalid_request", details });
    });

    it("carries the caller's AbortSignal; its abort is REQUEST_ABORTED", async () => {
      serve({ [`POST ${FLEETS}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.createFleet(GROUP_ID, REQUEST, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      expect(api.signals).toEqual([controller.signal]);
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("updateFleet", () => {
    it("patches the fleet with the CSRF header, and answers the fleet without a summary", async () => {
      const renamed = fleet({ label: "edge-prod-eu" });
      serve({ [`PATCH ${FLEET}`]: () => ({ status: 200, body: { fleet: renamed } }) });

      expect(await client.updateFleet(GROUP_ID, FLEET_ID, { label: "edge-prod-eu" })).toEqual(renamed);
      await client.updateFleet(GROUP_ID, FLEET_ID, { status: "archived" });
      const [rename, archive] = api.seen(`PATCH ${FLEET}`);
      expect(rename!.body).toEqual({ label: "edge-prod-eu" });
      expect(archive!.body).toEqual({ status: "archived" });
      expect(rename!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("encodes the ids in the path", async () => {
      const route = `PATCH /api/v1/organizations/a%2Fb/fleets/..%2Fc`;
      serve({ [route]: () => ({ status: 200, body: { fleet: fleet() } }) });
      await client.updateFleet("a/b", "../c", { status: "active" });
      expect(api.seen(route)).toHaveLength(1);
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`PATCH ${FLEET}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client
        .updateFleet(GROUP_ID, FLEET_ID, { status: "archived" }, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("deleteFleet", () => {
    it("sends DELETE to the fleet's path with the CSRF header, and resolves undefined on a 204", async () => {
      serve({ [`DELETE ${FLEET}`]: () => ({ status: 204 }) });
      await expect(client.deleteFleet(GROUP_ID, FLEET_ID)).resolves.toBeUndefined();
      expect(api.seen(`DELETE ${FLEET}`)[0]!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("a 503 after the API's 25 s: fleets_unavailable", async () => {
      serve({ [`DELETE ${FLEET}`]: () => FLEETS_UNAVAILABLE });
      await expect(client.deleteFleet(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "fleets_unavailable", status: 503 });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`DELETE ${FLEET}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.deleteFleet(GROUP_ID, FLEET_ID, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("getEnrollmentTokens", () => {
    it("gets the fleet's tokens, newest first, without a bearer", async () => {
      const tokens = [listedToken(), listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" })];
      serve({ [`GET ${FLEET}/tokens`]: () => ({ status: 200, body: { tokens } }) });
      expect(await client.getEnrollmentTokens(GROUP_ID, FLEET_ID)).toEqual({ tokens });
      expect(api.seen(`GET ${FLEET}/tokens`)[0]!.headers["x-telflo-csrf"]).toBeUndefined();
    });

    it("reports a token carrying a bearer as unexpected_response (the list never has one)", async () => {
      serve({ [`GET ${FLEET}/tokens`]: () => ({ status: 200, body: { tokens: [{ ...listedToken(), bearer: "tfr_x" }] } }) });
      await expect(client.getEnrollmentTokens(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`GET ${FLEET}/tokens`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.getEnrollmentTokens(GROUP_ID, FLEET_ID, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("revealEnrollmentToken", () => {
    const ROUTE = `POST ${FLEET}/tokens/${ROTATE_TOKEN_ID}/reveal`;
    const REVEALED = { token: { id: ROTATE_TOKEN_ID, kind: "rotate", bearer: "tfr_revealed-canary", expiresAt: null } };

    it("posts no body to the token's reveal path with the CSRF header, and answers the bearer; the bearer is never in the URL", async () => {
      serve({ [ROUTE]: () => ({ status: 200, body: REVEALED }) });
      expect(await client.revealEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).toEqual(REVEALED);
      const [request] = api.seen(ROUTE);
      expect(request!.body).toBeUndefined();
      expect(request!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("encodes the token's id in the path", async () => {
      const route = `POST ${FLEET}/tokens/..%2Freveal/reveal`;
      serve({ [route]: () => ({ status: 200, body: REVEALED }) });
      await client.revealEnrollmentToken(GROUP_ID, FLEET_ID, "../reveal");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("a 409: enrollment_token_expired", async () => {
      const message = "This enrollment token has expired.";
      serve({ [ROUTE]: () => ({ status: 409, body: { error: { code: "enrollment_token_expired", message } } }) });
      await expect(client.revealEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).rejects.toMatchObject({
        code: "enrollment_token_expired",
        message,
      });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [ROUTE]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client
        .revealEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });
});

describe("the collector calls", () => {
  const COLLECTORS = `${FLEET}/collectors`;
  const COLLECTOR = `${COLLECTORS}/${COLLECTOR_ID}`;
  const NAME_TAKEN = "Another of the organization's collectors has this name.";

  /** The calls that read, each with its route and a body it parses. */
  const reads: Array<[string, string, () => Promise<unknown>, unknown]> = [
    ["getCollectors", `GET ${COLLECTORS}`, () => client.getCollectors(GROUP_ID, FLEET_ID), { collectors: [], nextCursor: null }],
    ["getCollector", `GET ${COLLECTOR}`, () => client.getCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID), { collector: collector() }],
    [
      "getCollectorErrors",
      `GET ${COLLECTOR}/errors`,
      () => client.getCollectorErrors(GROUP_ID, FLEET_ID, COLLECTOR_ID),
      { errors: [], nextCursor: null },
    ],
    ["getCollectorGroups", `GET ${FLEET}/groups`, () => client.getCollectorGroups(GROUP_ID, FLEET_ID), { groups: [] }],
  ];

  it.each(reads)("%s sends no CSRF header and no body", async (_name, route, call, body) => {
    serve({ [route]: () => ({ status: 200, body }) });
    await call();
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
    expect(request!.body).toBeUndefined();
    expect(request!.withCredentials).toBe(true);
  });

  describe("getCollectors", () => {
    it("gets the first page with no query string, and parses each collector", async () => {
      const page = {
        collectors: [
          collector(),
          collector({
            id: "00000000-0000-4000-9000-000000000002",
            name: "old-host",
            pin: null,
            resolution: null,
            served: null,
            effective: null,
            reported: { collectorVersion: null, ip: null, hostIp: null, attributes: null },
            enrollmentTokenId: null,
            liveness: "offline",
            drift: "unassigned",
          }),
        ],
        nextCursor: "next-page",
      };
      serve({ [`GET ${COLLECTORS}`]: () => ({ status: 200, body: page }) });
      expect(await client.getCollectors(GROUP_ID, FLEET_ID)).toEqual(page);
    });

    it("sends the search trimmed and encoded, the group, the sort, the order, the limit and the cursor", async () => {
      const route = `GET ${COLLECTORS}?q=10.0.4+%26+web&groupId=${GATEWAYS_GROUP_ID}&sort=lastSeen&order=asc&limit=50&cursor=a%2Bb%2F%3D`;
      serve({ [route]: () => ({ status: 200, body: { collectors: [], nextCursor: null } }) });

      await client.getCollectors(GROUP_ID, FLEET_ID, {
        q: "  10.0.4 & web ",
        groupId: GATEWAYS_GROUP_ID,
        sort: "lastSeen",
        order: "asc",
        limit: 50,
        cursor: "a+b/=",
      });
      expect(api.seen(route)).toHaveLength(1);
    });

    it("leaves out an empty or blank search", async () => {
      const route = `GET ${COLLECTORS}?sort=name&order=desc`;
      serve({ [route]: () => ({ status: 200, body: { collectors: [], nextCursor: null } }) });
      await client.getCollectors(GROUP_ID, FLEET_ID, { q: "   ", sort: "name", order: "desc" });
      await client.getCollectors(GROUP_ID, FLEET_ID, { q: "", sort: "name", order: "desc" });
      expect(api.seen(route)).toHaveLength(2);
    });

    it("encodes the organization's and the fleet's ids in the path", async () => {
      const route = "GET /api/v1/organizations/a%2Fb/fleets/..%2Fc/collectors";
      serve({ [route]: () => ({ status: 200, body: { collectors: [], nextCursor: null } }) });
      await client.getCollectors("a/b", "../c");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reports a collector missing its liveness as unexpected_response (contract drift)", async () => {
      const { liveness: _liveness, ...withoutLiveness } = collector();
      serve({ [`GET ${COLLECTORS}`]: () => ({ status: 200, body: { collectors: [withoutLiveness], nextCursor: null } }) });
      await expect(client.getCollectors(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("a stale cursor: 400 invalid_request with its details naming cursor", async () => {
      const details = [
        {
          keyword: "custom",
          instancePath: "/cursor",
          schemaPath: "#/cursor/custom",
          params: { issue: { code: "custom", path: ["cursor"], message: "Not a cursor of this list's: reload the list." } },
          message: "Not a cursor of this list's: reload the list.",
        },
      ];
      serve({
        [`GET ${COLLECTORS}?cursor=old`]: () => ({
          status: 400,
          body: { error: { code: "invalid_request", message: "The list's cursor isn't valid: reload the list.", details } },
        }),
      });
      await expect(client.getCollectors(GROUP_ID, FLEET_ID, { cursor: "old" })).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
        details,
      });
    });

    it("carries the caller's AbortSignal; aborted in flight, it rejects with REQUEST_ABORTED, the session untouched", async () => {
      serve({ [`GET ${COLLECTORS}?limit=50`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.getCollectors(GROUP_ID, FLEET_ID, { limit: 50 }, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      expect(api.signals).toEqual([controller.signal]);
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED, status: undefined });
      expect(sessionEnded).not.toHaveBeenCalled();
    });

    it("a 429: rate_limited with retryAfterSeconds; a 503: fleets_unavailable", async () => {
      serve({
        [`GET ${COLLECTORS}`]: () => ({
          status: 429,
          body: { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } },
          headers: { "retry-after": "3" },
        }),
      });
      await expect(client.getCollectors(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 3 });
      serve({ [`GET ${COLLECTORS}`]: () => FLEETS_UNAVAILABLE });
      await expect(client.getCollectors(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "fleets_unavailable", status: 503 });
    });
  });

  describe("getCollector", () => {
    it("gets the collector by its encoded id, and answers the collector", async () => {
      serve({ [`GET ${COLLECTOR}`]: () => ({ status: 200, body: { collector: collector() } }) });
      expect(await client.getCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID)).toEqual(collector());

      const encoded = `GET ${COLLECTORS}/..%2Fpin`;
      serve({ [encoded]: () => ({ status: 200, body: { collector: collector() } }) });
      await client.getCollector(GROUP_ID, FLEET_ID, "../pin");
      expect(api.seen(encoded)).toHaveLength(1);
    });

    it("parses a pin to a deleted configuration's version (versionId and version null)", async () => {
      const orphan = collector({
        pin: { kind: "version", versionId: null, publishedVersionId: "c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0", version: null },
      });
      serve({ [`GET ${COLLECTOR}`]: () => ({ status: 200, body: { collector: orphan } }) });
      expect(await client.getCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID)).toEqual(orphan);
    });

    it("a 404: collector_not_found", async () => {
      serve({
        [`GET ${COLLECTOR}`]: () => ({ status: 404, body: { error: { code: "collector_not_found", message: "Collector not found." } } }),
      });
      await expect(client.getCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID)).rejects.toMatchObject({
        code: "collector_not_found",
        status: 404,
      });
    });
  });

  describe("updateCollector", () => {
    it("patches the collector with the CSRF header and only the fields given, and answers the collector", async () => {
      const updated = collector({ name: "web-01-eu", groupId: GATEWAYS_GROUP_ID });
      serve({ [`PATCH ${COLLECTOR}`]: () => ({ status: 200, body: { collector: updated } }) });

      expect(
        await client.updateCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID, { name: "web-01-eu", groupId: GATEWAYS_GROUP_ID, pin: null }),
      ).toEqual(updated);
      await client.updateCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID, { pin: { kind: "version", versionId: VERSION_ID } });
      const [all, version] = api.seen(`PATCH ${COLLECTOR}`);
      expect(all!.body).toEqual({ name: "web-01-eu", groupId: GATEWAYS_GROUP_ID, pin: null });
      expect(version!.body).toEqual({ pin: { kind: "version", versionId: VERSION_ID } });
      expect(all!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("a 409: collector_name_taken with its message", async () => {
      serve({ [`PATCH ${COLLECTOR}`]: () => ({ status: 409, body: { error: { code: "collector_name_taken", message: NAME_TAKEN } } }) });
      await expect(client.updateCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID, { name: "web-02" })).rejects.toMatchObject({
        code: "collector_name_taken",
        message: NAME_TAKEN,
        status: 409,
      });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`PATCH ${COLLECTOR}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client
        .updateCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID, { name: "web-02" }, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await aMoment();
      expect(api.signals).toEqual([controller.signal]);
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("deleteCollector", () => {
    it("sends DELETE with the CSRF header, and resolves undefined on a 204", async () => {
      serve({ [`DELETE ${COLLECTOR}`]: () => ({ status: 204 }) });
      await expect(client.deleteCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID)).resolves.toBeUndefined();
      expect(api.seen(`DELETE ${COLLECTOR}`)[0]!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`DELETE ${COLLECTOR}`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.deleteCollector(GROUP_ID, FLEET_ID, COLLECTOR_ID, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("pinCollectors", () => {
    const ROUTE = `POST ${COLLECTORS}/pin`;

    it("posts the ids and the pin with the CSRF header, and answers updated and notFound", async () => {
      const answer = { updated: [COLLECTOR_ID], notFound: ["00000000-0000-4000-9000-000000000002"] };
      serve({ [ROUTE]: () => ({ status: 200, body: answer }) });
      const request = { collectorIds: [COLLECTOR_ID, "00000000-0000-4000-9000-000000000002"], pin: null };
      expect(await client.pinCollectors(GROUP_ID, FLEET_ID, request)).toEqual(answer);
      const [seen] = api.seen(ROUTE);
      expect(seen!.body).toEqual(request);
      expect(seen!.headers["x-telflo-csrf"]).toBe("1");
    });

    it("a 422: configuration_version_not_published with its message", async () => {
      const message = "This version isn't published: publish it before assigning or pinning it.";
      serve({ [ROUTE]: () => ({ status: 422, body: { error: { code: "configuration_version_not_published", message } } }) });
      await expect(
        client.pinCollectors(GROUP_ID, FLEET_ID, { collectorIds: [COLLECTOR_ID], pin: { kind: "version", versionId: VERSION_ID } }),
      ).rejects.toMatchObject({ code: "configuration_version_not_published", message });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [ROUTE]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client
        .pinCollectors(GROUP_ID, FLEET_ID, { collectorIds: [COLLECTOR_ID], pin: null }, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("getCollectorErrors", () => {
    it("gets a page of the collector's errors, with the limit and the cursor", async () => {
      const page = { errors: [collectorError(), collectorError({ id: "00000000-0000-4000-9000-0000000000e2", configSha256: null })], nextCursor: "e-2" };
      const route = `GET ${COLLECTOR}/errors?limit=20&cursor=e%2B1`;
      serve({ [route]: () => ({ status: 200, body: page }) });
      expect(await client.getCollectorErrors(GROUP_ID, FLEET_ID, COLLECTOR_ID, { limit: 20, cursor: "e+1" })).toEqual(page);
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`GET ${COLLECTOR}/errors?limit=20`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client
        .getCollectorErrors(GROUP_ID, FLEET_ID, COLLECTOR_ID, { limit: 20 }, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

  describe("getCollectorGroups", () => {
    it("gets the fleet's groups, Default first, each with its assigned version", async () => {
      const groups = [collectorGroup(), gatewaysGroup()];
      serve({ [`GET ${FLEET}/groups`]: () => ({ status: 200, body: { groups } }) });
      expect(await client.getCollectorGroups(GROUP_ID, FLEET_ID)).toEqual({ groups });
    });

    it("carries the caller's AbortSignal", async () => {
      serve({ [`GET ${FLEET}/groups`]: hangsUntilAborted() });
      const controller = new AbortController();
      const pending = client.getCollectorGroups(GROUP_ID, FLEET_ID, { signal: controller.signal }).catch((caught: unknown) => caught);
      await aMoment();
      controller.abort();
      expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    });
  });

});

describe("the group and token calls", () => {
  const GROUPS = `${FLEET}/groups`;
  const GROUP = `${GROUPS}/${GATEWAYS_GROUP_ID}`;
  const EVENTS = `${FLEET}/tokens/events`;
  const ROTATE = `POST ${FLEET}/tokens/rotate`;
  const REVOKE = `POST ${FLEET}/tokens/${ROTATE_TOKEN_ID}/revoke`;
  const ASSIGNED = "c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0";

  /** Each call, with its route, a reply it parses, and how it is made with a signal. */
  const calls: Array<[string, string, Reply, (options: { signal?: AbortSignal }) => Promise<unknown>]> = [
    [
      "rotateEnrollmentToken",
      ROTATE,
      { status: 201, body: { token: { id: ROTATE_TOKEN_ID, bearer: "tfr_x", expiresAt: null, predecessorId: null } } },
      (options) =>
        client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, { expiresAt: null, graceEndsAt: "2026-11-14T22:59:59.999Z" }, options),
    ],
    [
      "revokeEnrollmentToken",
      REVOKE,
      { status: 200, body: { token: tokenOf(listedToken()) } },
      (options) => client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID, options),
    ],
    [
      "getEnrollmentTokenEvents",
      `GET ${EVENTS}`,
      { status: 200, body: { events: [], nextCursor: null } },
      (options) => client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID, {}, options),
    ],
    [
      "createCollectorGroup",
      `POST ${GROUPS}`,
      { status: 201, body: { group: gatewaysGroup() } },
      (options) => client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways" }, options),
    ],
    [
      "updateCollectorGroup",
      `PATCH ${GROUP}`,
      { status: 200, body: { group: gatewaysGroup() } },
      (options) => client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "gateways" }, options),
    ],
    [
      "deleteCollectorGroup",
      `DELETE ${GROUP}`,
      { status: 204 },
      (options) => client.deleteCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, options),
    ],
  ];

  /** A listed token as a revoke answers it: without `activeCollectors`. */
  function tokenOf(listed: ReturnType<typeof listedToken>) {
    const { activeCollectors: _activeCollectors, ...token } = listed;
    return token;
  }

  it.each(calls)("%s sends the CSRF header on a write, none on a read, and credentials", async (name, route, reply, call) => {
    serve({ [route]: () => reply });
    await call({});
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe(name === "getEnrollmentTokenEvents" ? undefined : "1");
    expect(request!.withCredentials).toBe(true);
  });

  it.each(calls)("%s carries the caller's AbortSignal; aborted in flight, it rejects with REQUEST_ABORTED", async (_name, route, _reply, call) => {
    serve({ [route]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = call({ signal: controller.signal }).catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it.each(calls)("%s answers a 503 as fleets_unavailable", async (_name, route, _reply, call) => {
    serve({ [route]: () => FLEETS_UNAVAILABLE });
    await expect(call({})).rejects.toMatchObject({ code: "fleets_unavailable", status: 503 });
  });

  describe("rotateEnrollmentToken", () => {
    const ROTATED = {
      token: { id: REPLACED_TOKEN_ID, bearer: "tfr_rotated-canary", expiresAt: "2027-10-15T12:00:00.000Z", predecessorId: ROTATE_TOKEN_ID },
    };

    it("posts the expiry and the grace's end to the fleet's rotate path, and answers the new token with its bearer and predecessor", async () => {
      serve({ [ROTATE]: () => ({ status: 201, body: ROTATED }) });
      const request = { expiresAt: "2027-10-15T12:00:00.000Z", graceEndsAt: "2026-11-14T22:59:59.999Z" };
      expect(await client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, request)).toEqual(ROTATED);
      expect(api.seen(ROTATE)[0]!.body).toEqual(request);
    });

    it("parses a rotation with no valid predecessor (predecessorId null) and a new token that never expires", async () => {
      const alone = { token: { ...ROTATED.token, expiresAt: null, predecessorId: null } };
      serve({ [ROTATE]: () => ({ status: 201, body: alone }) });
      expect(await client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, { expiresAt: null, graceEndsAt: "2026-11-14T22:59:59.999Z" })).toEqual(alone);
    });

    it("reports a reply without the bearer as unexpected_response (the rotation's contract)", async () => {
      const { bearer: _bearer, ...withoutBearer } = ROTATED.token;
      serve({ [ROTATE]: () => ({ status: 201, body: { token: withoutBearer } }) });
      await expect(
        client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, { expiresAt: null, graceEndsAt: "2026-11-14T22:59:59.999Z" }),
      ).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("a 409: fleet_archived; a 400: invalid_request with its details on graceEndsAt; a 429: rate_limited with retryAfterSeconds", async () => {
      const request = { expiresAt: null, graceEndsAt: "2026-11-14T22:59:59.999Z" };
      serve({ [ROTATE]: () => ({ status: 409, body: { error: { code: "fleet_archived", message: "This fleet is archived." } } }) });
      await expect(client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, request)).rejects.toMatchObject({ code: "fleet_archived", status: 409 });

      const details = [{ path: ["graceEndsAt"], message: "Must not be after expiresAt." }];
      serve({
        [ROTATE]: () => ({ status: 400, body: { error: { code: "invalid_request", message: "The request was not valid.", details } } }),
      });
      await expect(client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, request)).rejects.toMatchObject({ code: "invalid_request", details });

      serve({
        [ROTATE]: () => ({
          status: 429,
          body: { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } },
          headers: { "retry-after": "12" },
        }),
      });
      await expect(client.rotateEnrollmentToken(GROUP_ID, FLEET_ID, request)).rejects.toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 12,
      });
    });
  });

  describe("revokeEnrollmentToken", () => {
    it("posts no body to the token's revoke path, and answers the token without a bearer", async () => {
      const revoked = tokenOf(listedToken({ revokedAt: "2026-10-15T12:00:00.000Z" }));
      serve({ [REVOKE]: () => ({ status: 200, body: { token: revoked } }) });
      expect(await client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).toEqual({ token: revoked });
      expect(api.seen(REVOKE)[0]!.body).toBeUndefined();
    });

    it("encodes the token's id in the path", async () => {
      const route = `POST ${FLEET}/tokens/..%2Fevents/revoke`;
      serve({ [route]: () => ({ status: 200, body: { token: tokenOf(listedToken()) } }) });
      await client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, "../events");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reports a token carrying a bearer, or a listed token's activeCollectors, as unexpected_response", async () => {
      serve({ [REVOKE]: () => ({ status: 200, body: { token: { ...tokenOf(listedToken()), bearer: "tfr_x" } } }) });
      await expect(client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).rejects.toMatchObject({ code: "unexpected_response" });
      serve({ [REVOKE]: () => ({ status: 200, body: { token: listedToken() } }) });
      await expect(client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    });

    it("a 404: enrollment_token_not_found", async () => {
      serve({
        [REVOKE]: () => ({ status: 404, body: { error: { code: "enrollment_token_not_found", message: "Enrollment token not found" } } }),
      });
      await expect(client.revokeEnrollmentToken(GROUP_ID, FLEET_ID, ROTATE_TOKEN_ID)).rejects.toMatchObject({
        code: "enrollment_token_not_found",
        status: 404,
      });
    });
  });

  describe("getEnrollmentTokenEvents", () => {
    it("gets the first page with no query string and no body, and parses each event, with its actor or none", async () => {
      const page = {
        events: [
          tokenEvent({ id: TOKEN_EVENT_ID, event: "viewed", occurredAt: "2026-10-15T10:00:00.000Z" }),
          tokenEvent({ id: "00000000-0000-4000-a000-000000000002", tokenId: DEFAULT_TOKEN_ID, event: "revoked", actor: null }),
        ],
        nextCursor: "next-page",
      };
      serve({ [`GET ${EVENTS}`]: () => ({ status: 200, body: page }) });
      expect(await client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID)).toEqual(page);
      expect(api.seen(`GET ${EVENTS}`)[0]!.body).toBeUndefined();
    });

    it("sends the limit and the cursor, encoded", async () => {
      const route = `GET ${EVENTS}?limit=50&cursor=a%2Bb%2F%3D`;
      serve({ [route]: () => ({ status: 200, body: { events: [], nextCursor: null } }) });
      expect(await client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID, { limit: 50, cursor: "a+b/=" })).toEqual({
        events: [],
        nextCursor: null,
      });
      expect(api.seen(route)).toHaveLength(1);
    });

    it("encodes the organization's and the fleet's ids in the path", async () => {
      const route = "GET /api/v1/organizations/a%2Fb/fleets/..%2Fc/tokens/events";
      serve({ [route]: () => ({ status: 200, body: { events: [], nextCursor: null } }) });
      await client.getEnrollmentTokenEvents("a/b", "../c");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reports an event carrying a bearer or a token kind, or an unknown event, as unexpected_response", async () => {
      for (const event of [
        { ...tokenEvent(), bearer: "tfr_x" },
        { ...tokenEvent(), kind: "rotate" },
        { ...tokenEvent(), event: "deleted" },
      ]) {
        serve({ [`GET ${EVENTS}`]: () => ({ status: 200, body: { events: [event], nextCursor: null } }) });
        await expect(client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "unexpected_response" });
      }
    });

    it("a stale cursor: 400 invalid_request with its details naming cursor; a 404: fleet_not_found", async () => {
      const details = [{ path: ["cursor"], message: "Not a cursor of this list's: reload the list." }];
      serve({
        [`GET ${EVENTS}?cursor=old`]: () => ({
          status: 400,
          body: { error: { code: "invalid_request", message: "The list's cursor isn't valid: reload the list.", details } },
        }),
        [`GET ${EVENTS}`]: () => ({ status: 404, body: { error: { code: "fleet_not_found", message: "Fleet not found." } } }),
      });
      await expect(client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID, { cursor: "old" })).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
        details,
      });
      await expect(client.getEnrollmentTokenEvents(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "fleet_not_found", status: 404 });
    });
  });

  describe("createCollectorGroup", () => {
    it("posts the name, and the version to assign when given, and answers the group", async () => {
      serve({ [`POST ${GROUPS}`]: () => ({ status: 201, body: { group: gatewaysGroup() } }) });
      expect(await client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways", assignedVersionId: ASSIGNED })).toEqual(gatewaysGroup());
      await client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "db-hosts" });
      const [assigned, bare] = api.seen(`POST ${GROUPS}`);
      expect(assigned!.body).toEqual({ name: "gateways", assignedVersionId: ASSIGNED });
      expect(bare!.body).toEqual({ name: "db-hosts" });
    });

    it("parses a group whose assignment is a deleted configuration's version (assignedVersion null)", async () => {
      const orphan = gatewaysGroup({ assignedVersion: null });
      serve({ [`POST ${GROUPS}`]: () => ({ status: 201, body: { group: orphan } }) });
      expect(await client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways" })).toEqual(orphan);
    });

    it("a 409: collector_group_name_taken with its message; a 422: configuration_version_not_published", async () => {
      const taken = "Another of the fleet's collector groups has this name.";
      serve({
        [`POST ${GROUPS}`]: () => ({ status: 409, body: { error: { code: "collector_group_name_taken", message: taken } } }),
      });
      await expect(client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways" })).rejects.toMatchObject({
        code: "collector_group_name_taken",
        message: taken,
        status: 409,
      });
      const unpublished = "This version isn't published: publish it before assigning or pinning it.";
      serve({
        [`POST ${GROUPS}`]: () => ({ status: 422, body: { error: { code: "configuration_version_not_published", message: unpublished } } }),
      });
      await expect(client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways", assignedVersionId: ASSIGNED })).rejects.toMatchObject({
        code: "configuration_version_not_published",
        message: unpublished,
      });
    });

    it("reports a reply that isn't a group as unexpected_response", async () => {
      serve({ [`POST ${GROUPS}`]: () => ({ status: 201, body: { groups: [gatewaysGroup()] } }) });
      await expect(client.createCollectorGroup(GROUP_ID, FLEET_ID, { name: "gateways" })).rejects.toMatchObject({ code: "unexpected_response" });
    });
  });

  describe("updateCollectorGroup", () => {
    it("patches the group by its encoded id with only the fields given, a cleared assignment as null, and answers the group", async () => {
      const cleared = gatewaysGroup({ assignedPublishedVersionId: null, assignedVersion: null });
      serve({ [`PATCH ${GROUP}`]: () => ({ status: 200, body: { group: cleared } }) });
      expect(await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { assignedVersionId: null })).toEqual(cleared);
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "edge", assignedVersionId: ASSIGNED });
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "edge" });
      expect(api.seen(`PATCH ${GROUP}`).map((request) => request.body)).toEqual([
        { assignedVersionId: null },
        { name: "edge", assignedVersionId: ASSIGNED },
        { name: "edge" },
      ]);

      const encoded = `PATCH ${GROUPS}/..%2F${DEFAULT_GROUP_ID}`;
      serve({ [encoded]: () => ({ status: 200, body: { group: cleared } }) });
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, `../${DEFAULT_GROUP_ID}`, { name: "edge" });
      expect(api.seen(encoded)).toHaveLength(1);
    });

    it("a 409: collector_group_is_default; a 404: collector_group_not_found", async () => {
      serve({
        [`PATCH ${GROUP}`]: () => ({
          status: 409,
          body: { error: { code: "collector_group_is_default", message: "The Default group can't be renamed or deleted." } },
        }),
      });
      await expect(client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "edge" })).rejects.toMatchObject({
        code: "collector_group_is_default",
        status: 409,
      });
      serve({
        [`PATCH ${GROUP}`]: () => ({ status: 404, body: { error: { code: "collector_group_not_found", message: "Collector group not found" } } }),
      });
      await expect(client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "edge" })).rejects.toMatchObject({
        code: "collector_group_not_found",
        status: 404,
      });
    });
  });

  describe("deleteCollectorGroup", () => {
    it("sends DELETE to the group's encoded path with no body, and resolves undefined on a 204", async () => {
      serve({ [`DELETE ${GROUP}`]: () => ({ status: 204 }) });
      await expect(client.deleteCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).resolves.toBeUndefined();
      expect(api.seen(`DELETE ${GROUP}`)[0]!.body).toBeUndefined();

      const encoded = `DELETE ${GROUPS}/..%2Fx`;
      serve({ [encoded]: () => ({ status: 204 }) });
      await client.deleteCollectorGroup(GROUP_ID, FLEET_ID, "../x");
      expect(api.seen(encoded)).toHaveLength(1);
    });

    it("a 409: collector_group_is_default; a 404: collector_group_not_found", async () => {
      serve({
        [`DELETE ${GROUP}`]: () => ({
          status: 409,
          body: { error: { code: "collector_group_is_default", message: "The Default group can't be renamed or deleted." } },
        }),
      });
      await expect(client.deleteCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({
        code: "collector_group_is_default",
      });
      serve({
        [`DELETE ${GROUP}`]: () => ({ status: 404, body: { error: { code: "collector_group_not_found", message: "Collector group not found" } } }),
      });
      await expect(client.deleteCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({
        code: "collector_group_not_found",
      });
    });
  });
});

describe("the install calls and the new default token", () => {
  const GROUPS = `${FLEET}/groups`;
  const FACTS = `GET ${GROUPS}/${GATEWAYS_GROUP_ID}/install`;
  const BUNDLE = `POST ${GROUPS}/${GATEWAYS_GROUP_ID}/install-bundle`;
  const DEFAULT = `POST ${FLEET}/tokens/default`;
  const ISSUED = { token: { id: DEFAULT_TOKEN_ID, kind: "default", bearer: "tfd_issued-canary", expiresAt: null } };
  /** A gzip stream's first bytes, and bytes no text decoding survives. */
  const ARCHIVE = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
  const REQUEST: InstallBundleRequestInput = {
    method: "all-in-one",
    arch: "amd64",
    rootPath: "/etc/otelcol/",
    env: [{ name: "NGINX_ENV", value: "canary-value-it's" }],
  };
  const refusal = (status: number, code: string, message: string, details?: unknown) => ({
    status,
    body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
  });

  /** Each call, with its route, a reply it parses, and how it is made with a signal. */
  const calls: Array<[string, string, Reply, (options: { signal?: AbortSignal }) => Promise<unknown>]> = [
    ["issueDefaultEnrollmentToken", DEFAULT, { status: 201, body: ISSUED }, (options) => client.issueDefaultEnrollmentToken(GROUP_ID, FLEET_ID, options)],
    ["getInstallFacts", FACTS, { status: 200, body: installFacts() }, (options) => client.getInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, options)],
    [
      "downloadInstallBundle",
      BUNDLE,
      { status: 200, bytes: ARCHIVE },
      (options) => client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST, options),
    ],
  ];

  it.each(calls)("%s sends the CSRF header on a write, none on a read, and credentials", async (name, route, reply, call) => {
    serve({ [route]: () => reply });
    await call({});
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe(name === "getInstallFacts" ? undefined : "1");
    expect(request!.withCredentials).toBe(true);
  });

  it.each(calls)("%s carries the caller's AbortSignal; aborted in flight, it rejects with REQUEST_ABORTED", async (_name, route, _reply, call) => {
    serve({ [route]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = call({ signal: controller.signal }).catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  describe("issueDefaultEnrollmentToken", () => {
    it("posts no body to the fleet's default token path, and answers the new token with its bearer; the bearer is never in the URL", async () => {
      serve({ [DEFAULT]: () => ({ status: 201, body: ISSUED }) });
      expect(await client.issueDefaultEnrollmentToken(GROUP_ID, FLEET_ID)).toEqual(ISSUED);
      const [request] = api.seen(DEFAULT);
      expect(request!.body).toBeUndefined();
      expect(request!.url).not.toContain("tfd_");
    });

    it("encodes the organization's and the fleet's ids in the path", async () => {
      const route = "POST /api/v1/organizations/a%2Fb/fleets/..%2Fc/tokens/default";
      serve({ [route]: () => ({ status: 201, body: ISSUED }) });
      await client.issueDefaultEnrollmentToken("a/b", "../c");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reports a reply without the bearer, or with a rotation's predecessor, as unexpected_response", async () => {
      const { bearer: _bearer, ...withoutBearer } = ISSUED.token;
      for (const token of [withoutBearer, { ...ISSUED.token, predecessorId: null }]) {
        serve({ [DEFAULT]: () => ({ status: 201, body: { token } }) });
        await expect(client.issueDefaultEnrollmentToken(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "unexpected_response" });
      }
    });

    it.each([
      [409, "enrollment_token_default_exists", "The fleet already has a valid default token."],
      [409, "fleet_archived", "This fleet is archived."],
      [404, "fleet_not_found", "Fleet not found."],
      [503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE],
    ])("a %i: %s with its message", async (status, code, message) => {
      serve({ [DEFAULT]: () => refusal(status, code, message) });
      await expect(client.issueDefaultEnrollmentToken(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code, message, status });
    });

    it("a 429: rate_limited with retryAfterSeconds", async () => {
      serve({ [DEFAULT]: () => ({ ...refusal(429, "rate_limited", "Too many attempts. Please wait and try again."), headers: { "retry-after": "7" } }) });
      await expect(client.issueDefaultEnrollmentToken(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 7 });
    });
  });

  describe("getInstallFacts", () => {
    it("gets the group's install path with no body, and parses the facts: no bearer", async () => {
      const facts = installFacts({ mounts: [NGINX_MOUNT, DATA_MOUNT], envVarNames: ["NGINX_ENV", "API_KEY"], allowInsecureConnections: true });
      serve({ [FACTS]: () => ({ status: 200, body: facts }) });
      expect(await client.getInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).toEqual(facts);
      expect(api.seen(FACTS)[0]!.body).toBeUndefined();
    });

    it("encodes the organization's, the fleet's and the group's ids in the path", async () => {
      const route = "GET /api/v1/organizations/a%2Fb/fleets/..%2Fc/groups/d%3Fe/install";
      serve({ [route]: () => ({ status: 200, body: installFacts() }) });
      await client.getInstallFacts("a/b", "../c", "d?e");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reports facts carrying a bearer, a mount the contracts refuse or a group id that isn't a UUID as unexpected_response", async () => {
      for (const body of [
        { ...installFacts(), bearer: "tfd_x" },
        installFacts({ mounts: [{ hostPath: "relative", containerPath: "/x", readOnly: true }] }),
        installFacts({ groupId: "gateways" }),
      ]) {
        serve({ [FACTS]: () => ({ status: 200, body }) });
        await expect(client.getInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
      }
    });

    it.each([
      [404, "fleet_not_found", "Fleet not found."],
      [404, "collector_group_not_found", "Collector group not found"],
      [409, "fleet_archived", "This fleet is archived."],
      [409, "fleet_type_not_installable", FLEET_TYPE_NOT_INSTALLABLE_MESSAGE],
      [409, "collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE],
      [409, "collector_group_assignment_deleted", COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE],
      [409, "collector_version_not_offered", collectorVersionNotOfferedMessage("0.150.0")],
      [503, "install_unavailable", INSTALL_UNAVAILABLE_MESSAGE],
    ])("a %i: %s with its message", async (status, code, message) => {
      serve({ [FACTS]: () => refusal(status, code, message) });
      await expect(client.getInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({ code, message, status });
    });
  });

  describe("downloadInstallBundle", () => {
    it("posts the request as the body, the paths and values in no URL, reads the answer as bytes, and names it by method and arch", async () => {
      serve({ [BUNDLE]: () => ({ status: 200, bytes: ARCHIVE, headers: { "content-disposition": 'attachment; filename="ignored.tar.gz"' } }) });
      const bundle = await client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST);
      expect(bundle.fileName).toBe("telflo-collector-all-in-one-amd64.tar.gz");
      expect(bundle.archive).toBeInstanceOf(Uint8Array);
      expect([...bundle.archive]).toEqual([...ARCHIVE]);
      const [request] = api.seen(BUNDLE);
      expect(request!.body).toEqual(REQUEST);
      expect(request!.responseType).toBe("arraybuffer");
      expect(request!.url).not.toContain("otelcol");
      expect(request!.url).not.toContain("canary-value");
    });

    it("names each method and arch's bundle as the contracts do, and sends own-binary's executable path", async () => {
      serve({ [BUNDLE]: () => ({ status: 200, bytes: ARCHIVE }) });
      const ownBinary: InstallBundleRequestInput = {
        method: "own-binary",
        arch: "arm64",
        rootPath: "/opt/otelcol",
        executablePath: "/usr/bin/otelcol-contrib",
        env: [],
      };
      expect((await client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, ownBinary)).fileName).toBe(
        "telflo-collector-own-binary-arm64.tar.gz",
      );
      expect(api.seen(BUNDLE)[0]!.body).toEqual(ownBinary);
    });

    it("encodes the ids in the path", async () => {
      const route = "POST /api/v1/organizations/a%2Fb/fleets/..%2Fc/groups/d%3Fe/install-bundle";
      serve({ [route]: () => ({ status: 200, bytes: ARCHIVE }) });
      await client.downloadInstallBundle("a/b", "../c", "d?e", REQUEST);
      expect(api.seen(route)).toHaveLength(1);
    });

    it("reads a refusal, sent as bytes, as its envelope: invalid_request with its details, install_unavailable, a 429's wait", async () => {
      const details = [{ path: ["env", 0, "value"], message: "Use no control characters (a line break or a tab, say)." }];
      serve({ [BUNDLE]: () => ({ ...refusal(400, "invalid_request", "The request was not valid.", details), envelopeAsBytes: true }) });
      await expect(client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
        details,
      });

      serve({ [BUNDLE]: () => ({ ...refusal(503, "install_unavailable", INSTALL_UNAVAILABLE_MESSAGE), envelopeAsBytes: true }) });
      await expect(client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "install_unavailable",
        message: INSTALL_UNAVAILABLE_MESSAGE,
        status: 503,
      });

      serve({
        [BUNDLE]: () => ({
          ...refusal(429, "rate_limited", "Too many attempts. Please wait and try again."),
          envelopeAsBytes: true,
          headers: { "retry-after": "9" },
        }),
      });
      await expect(client.downloadInstallBundle(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 9,
      });
    });
  });

  describe("the group calls' annotations", () => {
    const GROUP = `${GROUPS}/${GATEWAYS_GROUP_ID}`;
    const withMounts = gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) });

    it("sends a create's annotations in its body, and parses a group answering them", async () => {
      serve({ [`POST ${GROUPS}`]: () => ({ status: 201, body: { group: withMounts } }) });
      const request = { name: "gateways", annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) };
      expect(await client.createCollectorGroup(GROUP_ID, FLEET_ID, request)).toEqual(withMounts);
      expect(api.seen(`POST ${GROUPS}`)[0]!.body).toEqual(request);
    });

    it("sends an update's annotations, an object replacing them or null clearing them, and nothing of them when not given", async () => {
      serve({ [`PATCH ${GROUP}`]: () => ({ status: 200, body: { group: withMounts } }) });
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { annotations: mountsAnnotations() });
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { annotations: null });
      await client.updateCollectorGroup(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "edge" });
      expect(api.seen(`PATCH ${GROUP}`).map((request) => request.body)).toEqual([
        { annotations: mountsAnnotations() },
        { annotations: null },
        { name: "edge" },
      ]);
    });

    it("parses another client's annotations unchanged, and a group with none", async () => {
      const foreign = gatewaysGroup({ annotations: { telflo: "not ours", "example.com/x": [1, { y: null }] } });
      serve({ [`GET ${GROUPS}`]: () => ({ status: 200, body: { groups: [collectorGroup(), foreign] } }) });
      expect(await client.getCollectorGroups(GROUP_ID, FLEET_ID)).toEqual({ groups: [collectorGroup(), foreign] });
    });
  });
});

describe("the quick-deploy links' calls", () => {
  const CREATE = `POST ${FLEET}/groups/${GATEWAYS_GROUP_ID}/quick-deploy-links`;
  const LINKS = `${FLEET}/quick-deploy-links`;
  const EXTEND = `POST ${LINKS}/${QUICK_DEPLOY_LINK_ID}/extend`;
  const REVOKE = `POST ${LINKS}/${QUICK_DEPLOY_LINK_ID}/revoke`;
  const REQUEST: CreateQuickDeployLinkRequestInput = {
    method: "own-binary",
    arch: "arm64",
    rootPath: "/opt/otelcol/",
    executablePath: "/usr/bin/otelcol-contrib",
    env: [{ name: "NGINX_ENV", value: "canary-value-it's" }],
    systemd: true,
  };
  const refusal = (status: number, code: string, message: string, details?: unknown) => ({
    status,
    body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
  });

  /** Each call, with its route, a reply it parses, and how it is made with a signal. */
  const calls: Array<[string, string, Reply, (options: { signal?: AbortSignal }) => Promise<unknown>]> = [
    [
      "createQuickDeployLink",
      CREATE,
      { status: 201, body: quickDeployLinkCreated() },
      (options) => client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST, options),
    ],
    [
      "getQuickDeployLinks",
      `GET ${LINKS}`,
      { status: 200, body: quickDeployLinksPage([]) },
      (options) => client.getQuickDeployLinks(GROUP_ID, FLEET_ID, {}, options),
    ],
    [
      "extendQuickDeployLink",
      EXTEND,
      { status: 200, body: { link: quickDeployLink() } },
      (options) => client.extendQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID, "1w", options),
    ],
    [
      "revokeQuickDeployLink",
      REVOKE,
      { status: 200, body: { link: quickDeployLink({ status: "revoked", revokedAt: "2026-10-17T10:00:00.000Z" }) } },
      (options) => client.revokeQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID, options),
    ],
  ];

  it.each(calls)("%s sends the CSRF header on a write, none on a read, and credentials; no secret in its URL", async (name, route, reply, call) => {
    serve({ [route]: () => reply });
    await call({});
    const [request] = api.seen(route);
    expect(request!.headers["x-telflo-csrf"]).toBe(name === "getQuickDeployLinks" ? undefined : "1");
    expect(request!.withCredentials).toBe(true);
    expect(request!.url).not.toContain("tqd_");
  });

  it.each(calls)("%s carries the caller's AbortSignal; aborted in flight, it rejects with REQUEST_ABORTED", async (_name, route, _reply, call) => {
    serve({ [route]: hangsUntilAborted() });
    const controller = new AbortController();
    const pending = call({ signal: controller.signal }).catch((caught: unknown) => caught);
    await aMoment();
    expect(api.signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toMatchObject({ code: client.REQUEST_ABORTED });
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it.each(calls)("%s answers a 503 as fleets_unavailable", async (_name, route, _reply, call) => {
    serve({ [route]: () => FLEETS_UNAVAILABLE });
    await expect(call({})).rejects.toMatchObject({ code: "fleets_unavailable", status: 503 });
  });

  it.each(calls)("%s reports a link carrying a secret, its hash or a value as unexpected_response", async (_name, route, reply, call) => {
    if (reply === "network-error" || reply === "canceled") throw new Error("a reply with a body");
    for (const extra of [{ secret: QUICK_DEPLOY_SECRET }, { secretHash: "a".repeat(64) }, { envValues: [{ name: "NGINX_ENV", value: "x" }] }]) {
      const leaky = { ...quickDeployLink(), ...extra };
      const body = "links" in (reply.body as object) ? quickDeployLinksPage([leaky]) : { ...(reply.body as object), link: leaky };
      serve({ [route]: () => ({ ...reply, body }) });
      await expect(call({})).rejects.toMatchObject({ code: "unexpected_response" });
    }
  });

  describe("createQuickDeployLink", () => {
    it("posts the request as the body to the group's links path, the paths and values in no URL, and answers the link and its url", async () => {
      serve({ [CREATE]: () => ({ status: 201, body: quickDeployLinkCreated(), headers: { "cache-control": "no-store" } }) });
      expect(await client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).toEqual({
        link: quickDeployLink(),
        url: QUICK_DEPLOY_URL,
      });
      const [request] = api.seen(CREATE);
      expect(request!.body).toEqual(REQUEST);
      expect(request!.url).not.toContain("otelcol");
      expect(request!.url).not.toContain("canary-value");
    });

    it("encodes the organization's, the fleet's and the group's ids in the path", async () => {
      const route = "POST /api/v1/organizations/a%2Fb/fleets/..%2Fc/groups/d%3Fe/quick-deploy-links";
      serve({ [route]: () => ({ status: 201, body: quickDeployLinkCreated() }) });
      await client.createQuickDeployLink("a/b", "../c", "d?e", REQUEST);
      expect(api.seen(route)).toHaveLength(1);
    });

    it.each([
      ["no url", { link: quickDeployLink() }],
      ["a url that isn't a link", { link: quickDeployLink(), url: "https://telflo.example.com/api/v1/quick-deploy/abc" }],
      ["a url with a quote in its base", { link: quickDeployLink(), url: `https://h/it's/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}` }],
      ["a url with a query", { link: quickDeployLink(), url: `${QUICK_DEPLOY_URL}?x=1` }],
      ["a separate secret beside the url", { ...quickDeployLinkCreated(), secret: QUICK_DEPLOY_SECRET }],
      ["a link that isn't one", { link: { ...quickDeployLink(), status: "used" }, url: QUICK_DEPLOY_URL }],
    ])("reports a reply with %s as unexpected_response (the command is never built from it)", async (_what, body) => {
      serve({ [CREATE]: () => ({ status: 201, body }) });
      await expect(client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "unexpected_response",
      });
    });

    it("parses development's http link and a link that never expires", async () => {
      const url = `http://host.docker.internal:50080/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}`;
      serve({ [CREATE]: () => ({ status: 201, body: quickDeployLinkCreated({ expiresAt: null }, url) }) });
      expect(await client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).toEqual({
        link: quickDeployLink({ expiresAt: null }),
        url,
      });
    });

    it.each([
      [409, "quick_deploy_link_limit_reached", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached],
      [409, "enrollment_token_default_missing", QUICK_DEPLOY_LINK_ERROR_MESSAGES.enrollment_token_default_missing],
      [409, "collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE],
      [409, "fleet_archived", "This fleet is archived."],
      [404, "collector_group_not_found", "Collector group not found"],
      [503, "install_unavailable", INSTALL_UNAVAILABLE_MESSAGE],
    ])("a %i: %s with its message", async (status, code, message) => {
      serve({ [CREATE]: () => refusal(status, code, message) });
      await expect(client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({ code, message, status });
    });

    it("a 400: invalid_request with its details on the fields; a 429: rate_limited with retryAfterSeconds", async () => {
      const details = [{ path: ["env", 0, "value"], message: "Use no control characters (a line break or a tab, say)." }];
      serve({ [CREATE]: () => refusal(400, "invalid_request", "The request was not valid.", details) });
      await expect(client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
        details,
      });
      serve({ [CREATE]: () => ({ ...refusal(429, "rate_limited", "Too many attempts. Please wait and try again."), headers: { "retry-after": "8" } }) });
      await expect(client.createQuickDeployLink(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, REQUEST)).rejects.toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 8,
      });
    });
  });

  describe("getQuickDeployLinks", () => {
    it("gets the first page with no query string and no body, and parses each link in each state, a deleted group's and a gone creator's", async () => {
      const page = quickDeployLinksPage(
        [
          quickDeployLink(),
          quickDeployLink({
            id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e71",
            groupName: null,
            createdBy: null,
            choices: { method: "own-binary", arch: "arm64", rootPath: "/opt/otelcol", executablePath: "/usr/bin/otelcol-contrib", systemd: false, envNames: [] },
            expiresAt: "2026-10-16T09:00:00.000Z",
            downloadCount: 3,
            lastDownloadedAt: "2026-10-16T08:00:00.000Z",
            status: "expired",
          }),
          quickDeployLink({ id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e72", expiresAt: null, revokedAt: "2026-10-17T10:00:00.000Z", status: "revoked" }),
        ],
        "next-page",
      );
      serve({ [`GET ${LINKS}`]: () => ({ status: 200, body: page }) });
      expect(await client.getQuickDeployLinks(GROUP_ID, FLEET_ID)).toEqual(page);
      expect(api.seen(`GET ${LINKS}`)[0]!.body).toBeUndefined();
    });

    it("sends the limit and the cursor, encoded", async () => {
      const route = `GET ${LINKS}?limit=50&cursor=a%2Bb%2F%3D`;
      serve({ [route]: () => ({ status: 200, body: quickDeployLinksPage([]) }) });
      expect(await client.getQuickDeployLinks(GROUP_ID, FLEET_ID, { limit: 50, cursor: "a+b/=" })).toEqual(quickDeployLinksPage([]));
      expect(api.seen(route)).toHaveLength(1);
    });

    it("encodes the organization's and the fleet's ids in the path", async () => {
      const route = "GET /api/v1/organizations/a%2Fb/fleets/..%2Fc/quick-deploy-links";
      serve({ [route]: () => ({ status: 200, body: quickDeployLinksPage([]) }) });
      await client.getQuickDeployLinks("a/b", "../c");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("a stale cursor: 400 invalid_request with its details naming cursor; a 404: fleet_not_found", async () => {
      const details = [{ path: ["cursor"], message: "Not a cursor of this list's: reload the list." }];
      serve({
        [`GET ${LINKS}?cursor=old`]: () => refusal(400, "invalid_request", "The list's cursor isn't valid: reload the list.", details),
        [`GET ${LINKS}`]: () => refusal(404, "fleet_not_found", "Fleet not found."),
      });
      await expect(client.getQuickDeployLinks(GROUP_ID, FLEET_ID, { cursor: "old" })).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
        details,
      });
      await expect(client.getQuickDeployLinks(GROUP_ID, FLEET_ID)).rejects.toMatchObject({ code: "fleet_not_found", status: 404 });
    });
  });

  describe("extendQuickDeployLink", () => {
    it.each(QUICK_DEPLOY_LINK_EXTENSIONS)("posts {by: %j} to the link's extend path, and answers the link as it now is", async (by) => {
      const extended = { link: quickDeployLink({ expiresAt: by === "never" ? null : "2026-10-24T09:00:00.000Z" }) };
      serve({ [EXTEND]: () => ({ status: 200, body: extended }) });
      expect(await client.extendQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID, by)).toEqual(extended);
      expect(api.seen(EXTEND)[0]!.body).toEqual({ by });
    });

    it("encodes the ids in the path", async () => {
      const route = "POST /api/v1/organizations/a%2Fb/fleets/..%2Fc/quick-deploy-links/..%2Frevoke/extend";
      serve({ [route]: () => ({ status: 200, body: { link: quickDeployLink() } }) });
      await client.extendQuickDeployLink("a/b", "../c", "../revoke", "1d");
      expect(api.seen(route)).toHaveLength(1);
    });

    it.each([
      [409, "quick_deploy_link_revoked", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked],
      [404, "quick_deploy_link_not_found", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found],
      [404, "fleet_not_found", "Fleet not found."],
    ])("a %i: %s with its message", async (status, code, message) => {
      serve({ [EXTEND]: () => refusal(status, code, message) });
      await expect(client.extendQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID, "1d")).rejects.toMatchObject({ code, message, status });
    });
  });

  describe("revokeQuickDeployLink", () => {
    it("posts no body to the link's revoke path, and answers the link as it now is", async () => {
      const revoked = { link: quickDeployLink({ revokedAt: "2026-10-17T10:00:00.000Z", status: "revoked" }) };
      serve({ [REVOKE]: () => ({ status: 200, body: revoked }) });
      expect(await client.revokeQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID)).toEqual(revoked);
      expect(api.seen(REVOKE)[0]!.body).toBeUndefined();
    });

    it("encodes the ids in the path", async () => {
      const route = "POST /api/v1/organizations/a%2Fb/fleets/..%2Fc/quick-deploy-links/d%3Fe/revoke";
      serve({ [route]: () => ({ status: 200, body: { link: quickDeployLink() } }) });
      await client.revokeQuickDeployLink("a/b", "../c", "d?e");
      expect(api.seen(route)).toHaveLength(1);
    });

    it("a 404: quick_deploy_link_not_found with its message", async () => {
      const message = QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found;
      serve({ [REVOKE]: () => refusal(404, "quick_deploy_link_not_found", message) });
      await expect(client.revokeQuickDeployLink(GROUP_ID, FLEET_ID, QUICK_DEPLOY_LINK_ID)).rejects.toMatchObject({
        code: "quick_deploy_link_not_found",
        message,
        status: 404,
      });
    });
  });
});

const INVITATION_TOKEN = "the-token-from-the-link";
const PREVIEWS = "POST /api/v1/invitation-previews";
const ACCEPTANCES = "POST /api/v1/invitation-acceptances";
const REGISTRATIONS = "POST /api/v1/invitation-registrations";
const PREVIEWED_INVITATION = {
  organizationName: "Group",
  organizationType: "group",
  email: "invitee@example.com",
  role: "contributor",
  status: "pending",
  hasAccount: false,
  mayRegister: true,
};
const JOINED = { organization: { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } };

describe("previewInvitation", () => {
  it("posts the token in the body, never the URL, with the CSRF header, and parses the preview", async () => {
    serve({ [PREVIEWS]: () => ({ status: 200, body: { invitation: PREVIEWED_INVITATION } }) });
    expect(await client.previewInvitation({ token: INVITATION_TOKEN })).toEqual({ invitation: PREVIEWED_INVITATION });

    const [request] = api.seen(PREVIEWS);
    expect(request!.body).toEqual({ token: INVITATION_TOKEN });
    expect(request!.url).not.toContain(INVITATION_TOKEN);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying invitation_not_found and the server's message", async () => {
    const message = "Invalid or expired invite link. Please ask your admin to resend the invitation.";
    serve({ [PREVIEWS]: () => ({ status: 404, body: { error: { code: "invitation_not_found", message } } }) });
    await expect(client.previewInvitation({ token: INVITATION_TOKEN })).rejects.toMatchObject({
      code: "invitation_not_found",
      message,
    });
  });
});

describe("acceptInvitation", () => {
  it("posts the token in the body with the CSRF header, and parses the joined organization", async () => {
    serve({ [ACCEPTANCES]: () => ({ status: 200, body: JOINED }) });
    expect(await client.acceptInvitation({ token: INVITATION_TOKEN })).toEqual(JOINED);

    const [request] = api.seen(ACCEPTANCES);
    expect(request!.body).toEqual({ token: INVITATION_TOKEN });
    expect(request!.url).not.toContain(INVITATION_TOKEN);
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
    expect(request!.withCredentials).toBe(true);
  });

  it("throws an ApiError carrying invitation_email_mismatch and the server's message", async () => {
    const message = "This invitation was sent to invitee@example.com. Sign in with that address to accept it.";
    serve({ [ACCEPTANCES]: () => ({ status: 403, body: { error: { code: "invitation_email_mismatch", message } } }) });
    await expect(client.acceptInvitation({ token: INVITATION_TOKEN })).rejects.toMatchObject({
      code: "invitation_email_mismatch",
      message,
    });
  });
});

describe("registerFromInvitation", () => {
  it("posts the token, password and terms version in the body with the CSRF header, and parses the joined organization", async () => {
    const request = { token: INVITATION_TOKEN, password: "a-long-enough-password", acceptedTermsVersion: "2026-01-01" };
    serve({ [REGISTRATIONS]: () => ({ status: 201, body: JOINED }) });
    expect(await client.registerFromInvitation(request)).toEqual(JOINED);

    const [seen] = api.seen(REGISTRATIONS);
    expect(seen!.body).toEqual(request);
    expect(seen!.url).not.toContain(INVITATION_TOKEN);
    expect(seen!.headers["x-telflo-csrf"]).toBe("1");
  });

  it("throws an ApiError carrying account_exists and the server's message", async () => {
    const message = "An account already exists for this email address. Sign in to accept the invitation.";
    serve({ [REGISTRATIONS]: () => ({ status: 409, body: { error: { code: "account_exists", message } } }) });
    await expect(
      client.registerFromInvitation({ token: INVITATION_TOKEN, password: "a-long-enough-password", acceptedTermsVersion: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "account_exists", message });
  });
});

/**
 * A fake API whose access token has expired: `/me` answers
 * `access_token_expired` until a refresh succeeds. `refreshGate`, when
 * given, holds the refresh's answer until it resolves.
 */
function expiredSession(options: { refresh?: Reply; refreshGate?: Promise<void> } = {}) {
  let accessTokenValid = false;
  serve({
    [ME]: () => (accessTokenValid ? { status: 200, body: CURRENT_USER } : EXPIRED),
    [REFRESH]: async () => {
      await options.refreshGate;
      const reply = options.refresh ?? REFRESHED;
      if (typeof reply !== "string" && reply.status === 200) accessTokenValid = true;
      return reply;
    },
  });
}

describe("refreshing an expired access token", () => {
  it("refreshes once on access_token_expired, then retries the request and resolves with its parsed body", async () => {
    expiredSession();

    window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));
    expect(await client.getCurrentUser()).toEqual(CURRENT_USER);
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([ME, REFRESH, ME]);
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(analytics.signedOutLocally).not.toHaveBeenCalled();
    // A refreshed session isn't a sign-out: the staged edit stays.
    expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(true);
    window.localStorage.removeItem("telflo-playground-staged-edit");
  });

  it("doesn't refresh on a 401 unauthenticated: it rejects with that code and ends the session once", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(api.seen(REFRESH)).toHaveLength(0);
    expect(api.seen(ME)).toHaveLength(1);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an ordinary refusal", { code: "forbidden", message: "Not allowed." }],
    ["a body saying access_token_expired", { code: "access_token_expired", message: "Expired." }],
  ])("doesn't refresh on a 403 with %s", async (_, error) => {
    serve({ [ME]: () => ({ status: 403, body: { error } }) });

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: error.code });
    expect(api.seen(REFRESH)).toHaveLength(0);
    expect(api.seen(ME)).toHaveLength(1);
  });

  it("single-flight: five concurrent requests getting access_token_expired cause one refresh, and all five are retried and resolve", async () => {
    // The refresh answers only once all five have been refused, so each of
    // them fails while it is in flight.
    const allRefused = deferred();
    let refused = 0;
    let accessTokenValid = false;
    serve({
      [ME]: () => {
        if (accessTokenValid) return { status: 200, body: CURRENT_USER };
        if (++refused === 5) allRefused.resolve();
        return EXPIRED;
      },
      [REFRESH]: async () => {
        await allRefused.promise;
        await aMoment();
        accessTokenValid = true;
        return REFRESHED;
      },
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => client.getCurrentUser()));

    expect(results).toEqual(Array(5).fill(CURRENT_USER));
    expect(api.seen(REFRESH)).toHaveLength(1);
    expect(api.seen(ME)).toHaveLength(10);
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  describe("retry once", () => {
    it("a retried request that gets access_token_expired again rejects with it, after exactly one refresh", async () => {
      serve({ [ME]: () => EXPIRED, [REFRESH]: () => REFRESHED });

      await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "access_token_expired" });
      expect(api.seen(REFRESH)).toHaveLength(1);
      expect(api.seen(ME)).toHaveLength(2);
      expect(sessionEnded).not.toHaveBeenCalled();
    });

    it("a retried request that gets unauthenticated rejects with it, and ends the session once", async () => {
      // The session was revoked between the refresh and the retry.
      let refreshed = false;
      serve({
        [ME]: () => (refreshed ? UNAUTHENTICATED : EXPIRED),
        [REFRESH]: () => {
          refreshed = true;
          return REFRESHED;
        },
      });

      await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
      expect(api.seen(REFRESH)).toHaveLength(1);
      expect(api.seen(ME)).toHaveLength(2);
      expect(sessionEnded).toHaveBeenCalledTimes(1);
    });

    it("a request sent while the refresh is in flight waits for it, and isn't refreshed again", async () => {
      const refreshGate = deferred();
      serve({
        [ME]: () => EXPIRED,
        [REFRESH]: async () => {
          await refreshGate.promise;
          return REFRESHED;
        },
      });

      const first = client.getCurrentUser();
      await vi.waitFor(() => expect(api.seen(REFRESH)).toHaveLength(1));
      const sentDuringRefresh = client.getCurrentUser();
      await aMoment();
      // Held by the client until the refresh finishes.
      expect(api.seen(ME)).toHaveLength(1);

      refreshGate.resolve();
      await expect(first).rejects.toMatchObject({ code: "access_token_expired" });
      await expect(sentDuringRefresh).rejects.toMatchObject({ code: "access_token_expired" });
      expect(api.seen(REFRESH)).toHaveLength(1);
      expect(api.seen(ME)).toHaveLength(3);
    });
  });

  it("a refresh answering 401 ends the session once, and every waiting request rejects with unauthenticated", async () => {
    // A staged playground edit: a session the server ended counts as a sign-out.
    window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));
    const refreshGate = deferred();
    expiredSession({ refresh: UNAUTHENTICATED, refreshGate: refreshGate.promise });

    const waiting = Array.from({ length: 3 }, () => client.getCurrentUser());
    await vi.waitFor(() => expect(api.seen(ME)).toHaveLength(3));
    await vi.waitFor(() => expect(api.seen(REFRESH)).toHaveLength(1));
    // And one sent while the refresh is in flight, held until it fails.
    waiting.push(client.getCurrentUser());
    await aMoment();
    refreshGate.resolve();

    const outcomes = await Promise.allSettled(waiting);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(client.ApiError);
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "unauthenticated" });
    }
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    // PostHog forgets the user, once, and the staged playground edit goes.
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(false);
    expect(api.seen(REFRESH)).toHaveLength(1);
    // Nothing is retried after a refused refresh.
    expect(api.seen(ME)).toHaveLength(3);
  });

  it.each<[string, Reply, string]>([
    ["a network error", "network-error", "network_error"],
    [
      "a 500",
      { status: 500, body: { error: { code: "internal_error", message: "Something went wrong." } } },
      "internal_error",
    ],
    [
      "a 429",
      { status: 429, body: { error: { code: "rate_limited", message: "Too many requests." } } },
      "rate_limited",
    ],
  ])("a refresh failing with %s doesn't end the session, and the request rejects with its error", async (_, refresh, code) => {
    expiredSession({ refresh });

    const outcomes = await Promise.allSettled([client.getCurrentUser(), client.getCurrentUser()]);
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(client.ApiError);
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code });
    }
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(api.seen(REFRESH)).toHaveLength(1);
  });

  it("the refresh carries the CSRF header and is sent once, even though it answers 401 access_token_expired itself", async () => {
    expiredSession({ refresh: EXPIRED });

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    const refreshes = api.seen(REFRESH);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.headers["x-telflo-csrf"]).toBe("1");
    expect(refreshes[0]!.withCredentials).toBe(true);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("a successful refresh clears a failed one's error, so a later cancellation isn't reported as it", async () => {
    // A refused refresh records its failure for the requests it cancels.
    expiredSession({ refresh: UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    // A later refresh succeeds.
    expiredSession();
    expect(await client.getCurrentUser()).toEqual(CURRENT_USER);

    serve({ [ME]: () => "canceled" });

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "network_error" });
  });

  it("recovers after a refresh: a later expiry refreshes again", async () => {
    expiredSession();
    await client.getCurrentUser();
    expiredSession();
    await client.getCurrentUser();
    expect(api.seen(REFRESH)).toHaveLength(2);
  });
});

describe("the session ending on any 401 unauthenticated", () => {
  it("five concurrent requests failing with unauthenticated end the session once", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });

    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => client.getCurrentUser()));
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "unauthenticated" });
    }
    expect(api.seen(ME)).toHaveLength(5);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
  });

  it("after a successful request, a later unauthenticated ends the session again", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).toHaveBeenCalledTimes(1);

    serve({ [ME]: () => ({ status: 200, body: CURRENT_USER }) });
    await client.getCurrentUser();
    serve({ [ME]: () => UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });

    expect(sessionEnded).toHaveBeenCalledTimes(2);
  });

  it("a successful refresh re-arms it, even when the retried request then fails with unauthenticated", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).toHaveBeenCalledTimes(1);

    // The refresh succeeds and nothing else does: the retry finds the session
    // revoked in between, so only the refresh can have re-armed the handler.
    let refreshed = false;
    serve({
      [ME]: () => (refreshed ? UNAUTHENTICATED : EXPIRED),
      [REFRESH]: () => {
        refreshed = true;
        return REFRESHED;
      },
    });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });

    expect(api.seen(REFRESH)).toHaveLength(1);
    expect(sessionEnded).toHaveBeenCalledTimes(2);
  });

  it("setting a handler re-arms it, so the new handler runs on the next unauthenticated", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).toHaveBeenCalledTimes(1);

    const replacement = vi.fn();
    client.setSessionEndedHandler(replacement);
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });

    expect(replacement).toHaveBeenCalledTimes(1);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("while suspended, a refused refresh calls nothing; after the release, the next one calls the handler", async () => {
    expiredSession({ refresh: UNAUTHENTICATED });
    const release = client.suspendSessionEndedHandler();

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).not.toHaveBeenCalled();

    release();
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("while suspended, a refused refresh still resets PostHog: the user is gone either way", async () => {
    expiredSession({ refresh: UNAUTHENTICATED });
    const release = client.suspendSessionEndedHandler();

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });

    expect(sessionEnded).not.toHaveBeenCalled();
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
    release();
  });

  it("while suspended, resets PostHog once however many requests fail; after a success, the next ended session resets it again", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });
    const release = client.suspendSessionEndedHandler();

    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);

    serve({ [ME]: () => ({ status: 200, body: CURRENT_USER }) });
    await client.getCurrentUser();
    serve({ [ME]: () => UNAUTHENTICATED });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });

    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(2);
    expect(sessionEnded).not.toHaveBeenCalled();
    release();
  });

  it("stays suspended until every caller has released it, and a second release changes nothing", async () => {
    serve({ [ME]: () => UNAUTHENTICATED });
    const releaseFirst = client.suspendSessionEndedHandler();
    const releaseSecond = client.suspendSessionEndedHandler();

    releaseFirst();
    releaseFirst();
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).not.toHaveBeenCalled();

    releaseSecond();
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("a 401 invalid_credentials from sign-in doesn't end the session", async () => {
    serve({
      "POST /api/v1/auth/sessions": () => ({
        status: 401,
        body: { error: { code: "invalid_credentials", message: "Invalid email or password." } },
      }),
    });

    await expect(
      client.createSession({ email: "person@example.com", password: "whatever-they-have" }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it("a 400 invalid_reset_token doesn't end the session", async () => {
    serve({
      [PASSWORD_RESETS]: () => ({
        status: 400,
        body: { error: { code: "invalid_reset_token", message: "This link has expired." } },
      }),
    });

    await expect(client.resetPassword(reset)).rejects.toMatchObject({ code: "invalid_reset_token" });
    expect(sessionEnded).not.toHaveBeenCalled();
  });
});

describe("whenRequestsInFlightSettle", () => {
  it("resolves at once with nothing in flight", async () => {
    await expect(client.whenRequestsInFlightSettle()).resolves.toBeUndefined();
  });

  it("waits for every request in flight, failed ones included, and only after their session-ended handling; later requests don't count", async () => {
    const meGate = deferred();
    serve({
      [ME]: async () => {
        await meGate.promise;
        return UNAUTHENTICATED;
      },
    });
    const release = client.suspendSessionEndedHandler();
    const read = client.getCurrentUser();
    const settled = client.whenRequestsInFlightSettle();
    let hasSettled = false;
    void settled.then(() => {
      hasSettled = true;
    });
    // A request made after the call, still in flight when the first settles.
    const laterGate = deferred();
    const laterReached = deferred();
    serve({
      [ME]: async () => {
        await meGate.promise;
        return UNAUTHENTICATED;
      },
      [PASSWORD_RESETS]: async () => {
        laterReached.resolve();
        await laterGate.promise;
        return { status: 204 };
      },
    });
    const later = client.resetPassword(reset);

    // Both requests have reached the fake API; the read hasn't answered.
    await laterReached.promise;
    expect(hasSettled).toBe(false);
    meGate.resolve();
    await expect(read).rejects.toMatchObject({ code: "unauthenticated" });
    await settled;
    // The read's 401 was handled (PostHog told) before the wait ended, and the suspended handler never ran.
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
    expect(sessionEnded).not.toHaveBeenCalled();

    release();
    laterGate.resolve();
    await later;
  });
});

describe("the default session-ended handler", () => {
  it("sends the browser to /login with the current path and query to come back to", async () => {
    const freshClient = await loadClient();
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/app/configurations", search: "?tab=yaml&x=1", assign });
    expiredSession({ refresh: UNAUTHENTICATED });

    await expect(freshClient.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      "/login?redirectTo=" + encodeURIComponent("/app/configurations?tab=yaml&x=1"),
    );
  });
});

// A Kubernetes group's Helm facts and the organization's settings.
describe("the Helm install's reads", () => {
  const FACTS = `GET ${FLEET}/groups/${GATEWAYS_GROUP_ID}/install`;
  const SETTINGS = `GET /api/v1/organizations/${GROUP_ID}/settings`;

  it("getHelmInstallFacts gets the group's install path with no body and no CSRF header, and parses the Helm facts: no bearer", async () => {
    const facts = helmInstallFacts({}, { volumes: [{ hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/var/log/app", readOnly: true }] });
    serve({ [FACTS]: () => ({ status: 200, body: facts }) });
    expect(await client.getHelmInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).toEqual(facts);
    const [request] = api.seen(FACTS);
    expect(request!.body).toBeUndefined();
    expect(request!.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("getHelmInstallFacts encodes the ids in the path and carries the caller's AbortSignal", async () => {
    const route = "GET /api/v1/organizations/a%2Fb/fleets/..%2Fc/groups/d%3Fe/install";
    serve({ [route]: () => ({ status: 200, body: helmInstallFacts() }) });
    const controller = new AbortController();
    await client.getHelmInstallFacts("a/b", "../c", "d?e", { signal: controller.signal });
    expect(api.seen(route)).toHaveLength(1);
    expect(api.signals).toEqual([controller.signal]);
  });

  it("getHelmInstallFacts reports a server group's facts, a bearer, or a gateway without replicas as unexpected_response", async () => {
    for (const body of [installFacts(), { ...helmInstallFacts(), bearer: "x" }, helmInstallFacts({}, { replicas: null })]) {
      serve({ [FACTS]: () => ({ status: 200, body }) });
      await expect(client.getHelmInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
    }
  });

  it("getHelmInstallFacts: a 409 collector_group_settings_unreadable with its message", async () => {
    serve({
      [FACTS]: () => ({ status: 409, body: { error: { code: "collector_group_settings_unreadable", message: COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE } } }),
    });
    await expect(client.getHelmInstallFacts(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID)).rejects.toMatchObject({
      code: "collector_group_settings_unreadable",
      message: COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
      status: 409,
    });
  });

  it("updateOrganizationSettings patches the organization's settings path with the value and the CSRF header, and parses the reply", async () => {
    const route = `PATCH /api/v1/organizations/${GROUP_ID}/settings`;
    serve({ [route]: () => ({ status: 200, body: { publicInstallLinks: false } }) });
    expect(await client.updateOrganizationSettings(GROUP_ID, { publicInstallLinks: false })).toEqual({ publicInstallLinks: false });
    const [request] = api.seen(route);
    expect(request!.body).toEqual({ publicInstallLinks: false });
    expect(request!.headers["x-telflo-csrf"]).toBe("1");
    serve({ [route]: () => ({ status: 403, body: { error: { code: "organization_admin_required", message: "Admins only." } } }) });
    await expect(client.updateOrganizationSettings(GROUP_ID, { publicInstallLinks: true })).rejects.toMatchObject({
      code: "organization_admin_required",
      status: 403,
    });
  });

  it("getOrganizationSettings gets the organization's settings path with no CSRF header, and parses them strictly", async () => {
    serve({ [SETTINGS]: () => ({ status: 200, body: { publicInstallLinks: false } }) });
    expect(await client.getOrganizationSettings(GROUP_ID)).toEqual({ publicInstallLinks: false });
    expect(api.seen(SETTINGS)[0]!.headers["x-telflo-csrf"]).toBeUndefined();
    serve({ [SETTINGS]: () => ({ status: 200, body: { publicInstallLinks: true, other: 1 } }) });
    await expect(client.getOrganizationSettings(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

describe("the product-admin calls", () => {
  const USER_ID = "5c000000-0000-4000-8000-000000000001";
  const FEEDBACK_ID = "5d000000-0000-4000-8000-000000000001";
  const BASE = "/api/v1/product-admin";
  const USER = {
    id: USER_ID,
    email: "person@example.com",
    createdAt: "2026-10-26T10:00:00.000Z",
    isProductAdmin: false,
    block: { kind: "member", organizationName: "Acme", role: "contributor" },
  };
  const ITEM = { id: FEEDBACK_ID, email: "person@example.com", text: "Hello", createdAt: "2026-10-26T10:00:00.000Z", authorDeleted: false };

  it("reads the Users list with the search trimmed in q (none when blank) and the cursor, without the CSRF header", async () => {
    serve({
      [`GET ${BASE}/users`]: () => ({ status: 200, body: { items: [USER], nextCursor: "next" } }),
      [`GET ${BASE}/users?q=a+%26+b%25&cursor=abc_-1`]: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    });
    expect(await client.getAdminUsers({ q: "   " })).toEqual({ items: [USER], nextCursor: "next" });
    expect(await client.getAdminUsers({ q: "  a & b%  ", cursor: "abc_-1" })).toEqual({ items: [], nextCursor: null });
    expect(api.seen(`GET ${BASE}/users`)[0]!.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("deletes a user, grants and removes a product admin, with the CSRF header, the email in the body only", async () => {
    serve({
      [`DELETE ${BASE}/users/${USER_ID}`]: () => ({ status: 204 }),
      [`GET ${BASE}/product-admins`]: () => ({ status: 200, body: { items: [{ id: USER_ID, email: "person@example.com" }] } }),
      [`POST ${BASE}/product-admins`]: () => ({ status: 201, body: { id: USER_ID, email: "person@example.com" } }),
      [`DELETE ${BASE}/product-admins/${USER_ID}`]: () => ({ status: 204 }),
    });
    expect(await client.deleteAdminUser(USER_ID)).toBeUndefined();
    expect(await client.getProductAdmins()).toEqual({ items: [{ id: USER_ID, email: "person@example.com" }] });
    expect(await client.grantProductAdmin({ email: "person@example.com" })).toEqual({ id: USER_ID, email: "person@example.com" });
    expect(await client.removeProductAdmin(USER_ID)).toBeUndefined();
    expect(api.seen(`POST ${BASE}/product-admins`)[0]!.body).toEqual({ email: "person@example.com" });
    for (const route of [`DELETE ${BASE}/users/${USER_ID}`, `POST ${BASE}/product-admins`, `DELETE ${BASE}/product-admins/${USER_ID}`]) {
      expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBe("1");
      expect(api.seen(route)[0]!.url.includes("example.com")).toBe(false);
    }
  });

  it("reads the feedback and its count, acknowledges with the reply in the body, dismisses, and sends feedback", async () => {
    serve({
      [`GET ${BASE}/feedback`]: () => ({ status: 200, body: { items: [ITEM], nextCursor: null } }),
      [`GET ${BASE}/feedback?cursor=abc`]: () => ({ status: 200, body: { items: [], nextCursor: null } }),
      [`GET ${BASE}/feedback/pending-count`]: () => ({ status: 200, body: { count: 4 } }),
      [`POST ${BASE}/feedback/${FEEDBACK_ID}/acknowledge`]: () => ({ status: 204 }),
      [`POST ${BASE}/feedback/${FEEDBACK_ID}/dismiss`]: () => ({ status: 204 }),
      ["POST /api/v1/feedback"]: () => ({ status: 201, body: { id: FEEDBACK_ID } }),
    });
    expect(await client.getUserFeedback()).toEqual({ items: [ITEM], nextCursor: null });
    expect(await client.getUserFeedback({ cursor: "abc" })).toEqual({ items: [], nextCursor: null });
    expect(await client.getPendingFeedbackCount()).toBe(4);
    expect(await client.acknowledgeFeedback(FEEDBACK_ID, { reply: "Thanks." })).toBeUndefined();
    expect(await client.dismissFeedback(FEEDBACK_ID)).toBeUndefined();
    expect(await client.createFeedback({ text: "Hello" })).toEqual({ id: FEEDBACK_ID });
    expect(api.seen(`POST ${BASE}/feedback/${FEEDBACK_ID}/acknowledge`)[0]!.body).toEqual({ reply: "Thanks." });
    expect(api.seen("POST /api/v1/feedback")[0]!.body).toEqual({ text: "Hello" });
    for (const route of [`POST ${BASE}/feedback/${FEEDBACK_ID}/acknowledge`, `POST ${BASE}/feedback/${FEEDBACK_ID}/dismiss`, "POST /api/v1/feedback"]) {
      expect(api.seen(route)[0]!.headers["x-telflo-csrf"]).toBe("1");
    }
  });

  it("refuses a count that isn't the contract as unexpected_response", async () => {
    serve({ [`GET ${BASE}/feedback/pending-count`]: () => ({ status: 200, body: { count: -1 } }) });
    await expect(client.getPendingFeedbackCount()).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

