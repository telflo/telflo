import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
import { ApiError } from "./api-client.js";
import {
  fetchCurrentUser,
  fetchFlow,
  fetchFlows,
  fetchOidcProviders,
  fetchPendingFeedbackCount,
} from "./api-client.server.js";
import { HIDDEN, TAIL_SAMPLING } from "~/test/flows.js";

const currentUser = {
  user: { id: "0b9f4e0e-6f55-4a8e-9d1c-2f3a4b5c6d7e", email: "person@example.com" },
  organization: { id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", name: "Acme", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", name: "Acme", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function incoming(headers: Record<string, string> = {}): Request {
  return new Request("http://web.example/app/configurations?x=1", { headers });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchCurrentUser", () => {
  it("is signed_in with the parsed current user on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200, currentUser));
    expect(await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).toEqual({
      status: "signed_in",
      currentUser,
    });
  });

  it("forwards the incoming cookie header and nothing else", async () => {
    const fetchMock = mockFetch(200, currentUser);
    vi.stubGlobal("fetch", fetchMock);
    await fetchCurrentUser(
      incoming({
        cookie: "telflo_access=a; telflo_refresh=b",
        authorization: "Bearer stolen",
        "user-agent": "browser",
        "x-forwarded-for": "203.0.113.9",
        "x-telflo-csrf": "1",
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const sent = [...new Headers(init?.headers).entries()];
    expect(sent).toEqual([["cookie", "telflo_access=a; telflo_refresh=b"]]);
    expect(init?.method).toBe("GET");
  });

  it("sends no headers at all when the request has no cookie", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { code: "unauthenticated", message: "You need to sign in." } }), {
        status: 401,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchCurrentUser(incoming({ "user-agent": "browser" }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect([...new Headers(init?.headers).entries()]).toEqual([]);
  });

  it("does not send the CSRF header on its GET", async () => {
    const fetchMock = mockFetch(200, currentUser);
    vi.stubGlobal("fetch", fetchMock);
    await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).has("x-telflo-csrf")).toBe(false);
  });

  it("calls TELFLO_API_INTERNAL_URL when it is set", async () => {
    vi.stubEnv("TELFLO_API_INTERNAL_URL", "http://api:8080");
    const fetchMock = mockFetch(200, currentUser);
    vi.stubGlobal("fetch", fetchMock);
    await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }));

    expect(fetchMock.mock.calls[0]![0]).toBe("http://api:8080/api/v1/auth/me");
  });

  it("defaults to http://localhost:8080 when TELFLO_API_INTERNAL_URL is unset", async () => {
    vi.stubEnv("TELFLO_API_INTERNAL_URL", undefined);
    const fetchMock = mockFetch(200, currentUser);
    vi.stubGlobal("fetch", fetchMock);
    await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }));

    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:8080/api/v1/auth/me");
  });

  it("is refresh_needed on a 401 access_token_expired", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: { code: "access_token_expired", message: "Expired." } }));
    expect(await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).toEqual({ status: "refresh_needed" });
  });

  it.each(["unauthenticated", "invalid_credentials", "forbidden"])("is signed_out on a 401 %s", async (code) => {
    vi.stubGlobal("fetch", mockFetch(401, { error: { code, message: "No session." } }));
    expect(await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).toEqual({ status: "signed_out" });
  });

  it("is signed_out on a 401 whose JSON body isn't the error envelope", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { code: "access_token_expired" }));
    expect(await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).toEqual({ status: "signed_out" });
  });

  it("is signed_out on a 401 whose body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Unauthorized</html>", { status: 401 })),
    );
    expect(await fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).toEqual({ status: "signed_out" });
  });

  it("throws an ApiError carrying the server's code on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }),
    );
    const result = fetchCurrentUser(incoming({ cookie: "telflo_access=a" }));
    await expect(result).rejects.toThrow(ApiError);
    await expect(result).rejects.toMatchObject({ code: "internal_error" });
  });

  it("throws an ApiError, not null, when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = fetchCurrentUser(incoming({ cookie: "telflo_access=a" }));
    await expect(result).rejects.toThrow(ApiError);
    await expect(result).rejects.toMatchObject({ code: "network_error" });
  });

  it("throws an ApiError when a 200 doesn't match the current-user schema", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { user: { id: "not-a-uuid" } }));
    await expect(fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("throws an ApiError when an error body is not the expected envelope", async () => {
    vi.stubGlobal("fetch", mockFetch(502, "<html>Bad Gateway</html>"));
    await expect(fetchCurrentUser(incoming({ cookie: "telflo_access=a" }))).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });
});

describe("fetchOidcProviders", () => {
  const listed = { providers: [{ id: "google", name: "Google" }] };

  it("returns the parsed providers from TELFLO_API_INTERNAL_URL", async () => {
    vi.stubEnv("TELFLO_API_INTERNAL_URL", "http://api:8080");
    const fetchMock = mockFetch(200, listed);
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchOidcProviders(incoming({ cookie: "telflo_access=a" }))).toEqual(listed.providers);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api:8080/api/v1/auth/oidc-providers");
    expect(init?.method).toBe("GET");
  });

  it("returns an empty list when none is configured", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { providers: [] }));
    expect(await fetchOidcProviders(incoming())).toEqual([]);
  });

  it("forwards nothing from the browser's request, not even its cookies", async () => {
    const fetchMock = mockFetch(200, listed);
    vi.stubGlobal("fetch", fetchMock);
    await fetchOidcProviders(incoming({ cookie: "telflo_access=a", authorization: "Bearer stolen" }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect([...new Headers(init?.headers).entries()]).toEqual([]);
  });

  it("throws an ApiError when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(fetchOidcProviders(incoming())).rejects.toMatchObject({ code: "network_error" });
  });

  it("throws an ApiError carrying the server's code on a 500", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: { code: "internal_error", message: "Something went wrong." } }));
    await expect(fetchOidcProviders(incoming())).rejects.toMatchObject({ code: "internal_error" });
  });

  it.each([
    ["an unexpected shape", { providers: [{ id: "google" }] }],
    ["an extra field", { providers: [], issuer: "https://accounts.google.com" }],
  ])("throws an ApiError when a 200 has %s", async (_label, body) => {
    vi.stubGlobal("fetch", mockFetch(200, body));
    await expect(fetchOidcProviders(incoming())).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("throws an ApiError when the body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502 })));
    await expect(fetchOidcProviders(incoming())).rejects.toBeInstanceOf(ApiError);
  });
});

describe("fetchFlows and fetchFlow", () => {
  it("lists the flows from TELFLO_API_INTERNAL_URL, forwarding the cookie and nothing else", async () => {
    vi.stubEnv("TELFLO_API_INTERNAL_URL", "http://api.internal:9000");
    const fetchMock = mockFetch(200, { flows: [TAIL_SAMPLING, HIDDEN] });
    vi.stubGlobal("fetch", fetchMock);

    const read = await fetchFlows(incoming({ cookie: "telflo_access=a", authorization: "Bearer stolen", "x-forwarded-for": "203.0.113.9" }));

    expect(read).toEqual({ status: "loaded", data: [TAIL_SAMPLING, HIDDEN] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.internal:9000/api/v1/flows");
    expect(init?.method).toBe("GET");
    expect([...new Headers(init?.headers).entries()]).toEqual([["cookie", "telflo_access=a"]]);
  });

  it("reads one flow by its slug, encoded, forwarding no header without a cookie", async () => {
    const fetchMock = mockFetch(200, { flow: TAIL_SAMPLING });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchFlow(incoming(), "a/b")).toEqual({ status: "loaded", data: TAIL_SAMPLING });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:8080/api/v1/flows/a%2Fb");
    expect([...new Headers(init?.headers).entries()]).toEqual([]);
  });

  it("is refresh_needed on a 401 access_token_expired, and signed_out on any other 401", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(401, { error: { code: "access_token_expired", message: "The access token has expired." } }),
    );
    expect(await fetchFlows(incoming())).toEqual({ status: "refresh_needed" });
    expect(await fetchFlow(incoming(), TAIL_SAMPLING.slug)).toEqual({ status: "refresh_needed" });

    vi.stubGlobal("fetch", mockFetch(401, { error: { code: "unauthenticated", message: "Sign in." } }));
    expect(await fetchFlows(incoming())).toEqual({ status: "signed_out" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 401 })));
    expect(await fetchFlow(incoming(), TAIL_SAMPLING.slug)).toEqual({ status: "signed_out" });
  });

  it("throws the API's flow_not_found for a flow the visitor may not see", async () => {
    vi.stubGlobal("fetch", mockFetch(404, { error: { code: "flow_not_found", message: "Flow not found" } }));

    const thrown = await fetchFlow(incoming(), HIDDEN.slug).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ code: "flow_not_found" });
  });

  it("throws an ApiError when the API is unreachable, unreadable, or answers what isn't the contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(fetchFlows(incoming())).rejects.toMatchObject({ code: "network_error" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(fetchFlows(incoming())).rejects.toMatchObject({ code: "unexpected_response" });

    vi.stubGlobal("fetch", mockFetch(200, { flows: [{ slug: "x" }] }));
    await expect(fetchFlows(incoming())).rejects.toMatchObject({ code: "unexpected_response" });

    vi.stubGlobal("fetch", mockFetch(500, { nope: true }));
    await expect(fetchFlow(incoming(), "x")).rejects.toMatchObject({ code: "unexpected_response" });

    vi.stubGlobal("fetch", mockFetch(500, { error: { code: "internal_error", message: "Something went wrong." } }));
    await expect(fetchFlow(incoming(), "x")).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("fetchPendingFeedbackCount", () => {
  it("reads the count from TELFLO_API_INTERNAL_URL, forwarding the cookie and nothing else", async () => {
    vi.stubEnv("TELFLO_API_INTERNAL_URL", "http://api.internal:9000");
    const fetchMock = mockFetch(200, { count: 5 });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchPendingFeedbackCount(incoming({ cookie: "telflo_access=a", authorization: "Bearer stolen" }))).toEqual({
      status: "loaded",
      data: 5,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.internal:9000/api/v1/product-admin/feedback/pending-count");
    expect([...new Headers(init?.headers).entries()]).toEqual([["cookie", "telflo_access=a"]]);
  });

  it("is refresh_needed or signed_out on a 401, and throws on a refusal or an answer that isn't the contract", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: { code: "access_token_expired", message: "The access token has expired." } }));
    expect(await fetchPendingFeedbackCount(incoming())).toEqual({ status: "refresh_needed" });
    vi.stubGlobal("fetch", mockFetch(401, { error: { code: "unauthenticated", message: "Sign in." } }));
    expect(await fetchPendingFeedbackCount(incoming())).toEqual({ status: "signed_out" });
    vi.stubGlobal("fetch", mockFetch(403, { error: { code: "product_admin_required", message: "Only a product admin can do that." } }));
    await expect(fetchPendingFeedbackCount(incoming())).rejects.toMatchObject({ code: "product_admin_required" });
    vi.stubGlobal("fetch", mockFetch(200, { count: "many" }));
    await expect(fetchPendingFeedbackCount(incoming())).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

