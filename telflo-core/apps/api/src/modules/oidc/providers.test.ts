import { authorizationCodeGrant, type CustomFetch } from "openid-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OidcProviderSettings } from "../../settings.js";
import { startFakeOidcProvider, type FakeOidcProvider } from "../../testing/fake-oidc-provider.js";
import { authorizeAtProvider, exchangeCode } from "../../testing/oidc-grant.js";
import { createOidcProviderRegistry, isGoogleEmailAuthoritative } from "./providers.js";

let fake: FakeOidcProvider;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
});

afterAll(async () => {
  await fake.close();
});

function googleAtFake(): OidcProviderSettings {
  return { id: "google", name: "Google", issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret };
}

/** Passes every request to the real fetch, and counts them. */
function countingFetch(): CustomFetch & { calls: string[] } {
  const calls: string[] = [];
  const wrapped = ((url, options) => {
    calls.push(url);
    return fetch(url, options as RequestInit);
  }) as CustomFetch & { calls: string[] };
  wrapped.calls = calls;
  return wrapped;
}

describe("the OIDC provider registry", () => {
  describe("list and get", () => {
    it("lists no provider when none is configured", () => {
      const registry = createOidcProviderRegistry({ oidcProviders: [] });
      expect(registry.list()).toEqual([]);
      expect(registry.get("google")).toBeUndefined();
    });

    it("lists Google by id and name only, never its credentials", () => {
      const registry = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] });
      expect(registry.list()).toEqual([{ id: "google", name: "Google" }]);
      expect(JSON.stringify(registry.list())).not.toContain(fake.clientSecret);
      expect(registry.get("google")).toMatchObject({ id: "google", name: "Google" });
    });

    it.each(["github", "__proto__", "constructor", "toString", "GOOGLE"])("has no provider %j", (id) => {
      const registry = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] });
      expect(registry.get(id)).toBeUndefined();
    });
  });

  describe("discovery", () => {
    it("discovers the provider's configuration on first use, from its issuer", async () => {
      const fetch = countingFetch();
      const registry = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }, { fetch });
      expect(fetch.calls).toEqual([]);

      const config = await registry.get("google")!.configuration();

      expect(config.serverMetadata().issuer).toBe(fake.issuer);
      expect(config.clientMetadata().client_id).toBe(fake.clientId);
      expect(fetch.calls).toEqual([`${fake.issuer}/.well-known/openid-configuration`]);
    });

    it("caches the configuration after a success, sharing one discovery between concurrent callers", async () => {
      const fetch = countingFetch();
      const provider = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }, { fetch }).get("google")!;

      const [first, second] = await Promise.all([provider.configuration(), provider.configuration()]);
      const third = await provider.configuration();

      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(fetch.calls).toHaveLength(1);
    });

    it("retries discovery after a failure", async () => {
      let failures = 1;
      const calls: string[] = [];
      const flaky: CustomFetch = (url, options) => {
        calls.push(url);
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new TypeError("fetch failed"));
        }
        return fetch(url, options as RequestInit);
      };
      const provider = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }, { fetch: flaky }).get(
        "google",
      )!;

      await expect(provider.configuration()).rejects.toThrow();
      const config = await provider.configuration();

      expect(config.serverMetadata().issuer).toBe(fake.issuer);
      expect(calls).toHaveLength(2);
    });

    it("sends every later request through the injected fetch", async () => {
      const fetch = countingFetch();
      const config = await createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }, { fetch })
        .get("google")!
        .configuration();
      fake.nextSignIn();

      await exchangeCode(config, await authorizeAtProvider(config));

      expect(fetch.calls).toEqual([
        `${fake.issuer}/.well-known/openid-configuration`,
        `${fake.issuer}/token`,
        `${fake.issuer}/jwks`,
      ]);
    });
  });

  describe("plain http", () => {
    it("refuses to discover an http issuer that isn't loopback, without sending a request", async () => {
      const fetch = vi.fn<CustomFetch>();
      const provider = createOidcProviderRegistry(
        { oidcProviders: [{ ...googleAtFake(), issuer: "http://issuer.telflo.example" }] },
        { fetch },
      ).get("google")!;

      await expect(provider.configuration()).rejects.toMatchObject({ code: "OAUTH_HTTP_REQUEST_FORBIDDEN" });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("never allows plain http to an https issuer, even to a loopback endpoint it advertises", async () => {
      const issuer = "https://issuer.telflo.example";
      // Served in place of the network: tests never reach the internet.
      const offline: CustomFetch = async (url) => {
        if (url !== `${issuer}/.well-known/openid-configuration`) throw new Error(`unexpected request to ${url}`);
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${fake.issuer}/token`,
          jwks_uri: `${fake.issuer}/jwks`,
          response_types_supported: ["code"],
        });
      };
      const config = await createOidcProviderRegistry(
        { oidcProviders: [{ ...googleAtFake(), issuer }] },
        { fetch: offline },
      )
        .get("google")!
        .configuration();
      const tokenRequests = fake.requests.token.length;

      const grant = authorizationCodeGrant(config, new URL("https://telflo.example/callback?code=c&state=s"), {
        expectedState: "s",
        pkceCodeVerifier: "v".repeat(43),
      });

      await expect(grant).rejects.toMatchObject({ code: "OAUTH_HTTP_REQUEST_FORBIDDEN" });
      expect(fake.requests.token).toHaveLength(tokenRequests);
    });
  });

  describe("the ID token's signature (Ruling 2)", () => {
    it("accepts an ID token signed with the provider's published key", async () => {
      const config = await createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }).get("google")!.configuration();
      fake.nextSignIn({ sub: "signed-by-the-provider" });

      const tokens = await exchangeCode(config, await authorizeAtProvider(config));

      expect(tokens.claims()?.sub).toBe("signed-by-the-provider");
    });

    it("refuses an ID token signed by another key, though it came over the provider's own token endpoint", async () => {
      const config = await createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }).get("google")!.configuration();
      fake.nextSignIn({}, { fault: "foreign_key" });

      await expect(exchangeCode(config, await authorizeAtProvider(config))).rejects.toMatchObject({
        code: "OAUTH_INVALID_RESPONSE",
        cause: { message: "JWT signature verification failed" },
      });
    });
  });

  describe("email authority (Ruling 7)", () => {
    it.each([
      ["a @gmail.com address", { email: "someone@gmail.com" }],
      ["a @gmail.com address in capitals", { email: "Someone@GMAIL.COM" }],
      ["a @googlemail.com address, Gmail's older alias", { email: "someone@googlemail.com" }],
      ["a Workspace account (hd)", { email: "someone@company.example", hd: "company.example" }],
    ])("Google is authoritative for %s", (_label, claims) => {
      expect(isGoogleEmailAuthoritative(claims)).toBe(true);
    });

    it.each([
      ["another domain without hd", { email: "someone@company.example" }],
      ["a domain ending in gmail.com", { email: "someone@notgmail.com" }],
      ["a domain ending in googlemail.com", { email: "someone@notgooglemail.com" }],
      ["gmail.com as a subdomain", { email: "someone@gmail.com.evil.example" }],
      ["an empty hd", { email: "someone@company.example", hd: "" }],
      ["a non-string hd", { email: "someone@company.example", hd: true }],
      ["no email", {}],
      ["a non-string email", { email: ["someone@gmail.com"] }],
    ])("Google is not authoritative for %s", (_label, claims) => {
      expect(isGoogleEmailAuthoritative(claims)).toBe(false);
    });

    it("gives the configured Google provider Google's rule", () => {
      const google = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }).get("google")!;
      expect(google.isEmailAuthoritative({ email: "someone@gmail.com" })).toBe(true);
      expect(google.isEmailAuthoritative({ email: "someone@company.example" })).toBe(false);
    });

    it("keeps Google's rule for Google's own issuer", () => {
      const google = createOidcProviderRegistry({
        oidcProviders: [{ ...googleAtFake(), issuer: "https://accounts.google.com" }],
      }).get("google")!;
      expect(google.isEmailAuthoritative({ email: "someone@gmail.com" })).toBe(true);
      expect(google.isEmailAuthoritative({ email: "someone@company.example", hd: "company.example" })).toBe(true);
      expect(google.isEmailAuthoritative({ email: "someone@company.example" })).toBe(false);
    });

    it("keeps Google's rule for a loopback issuer (the fake provider)", () => {
      expect(fake.issuer).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):/);
      const google = createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }).get("google")!;
      expect(google.isEmailAuthoritative({ email: "someone@gmail.com" })).toBe(true);
      expect(google.isEmailAuthoritative({ email: "someone@company.example", hd: "company.example" })).toBe(true);
    });

    it("trusts no email under the id google from an https issuer that isn't Google's (Ruling 17)", () => {
      const impostor = createOidcProviderRegistry({
        oidcProviders: [{ ...googleAtFake(), issuer: "https://idp.telflo.example" }],
      }).get("google")!;
      expect(impostor.isEmailAuthoritative({ email: "someone@gmail.com" })).toBe(false);
      expect(impostor.isEmailAuthoritative({ email: "someone@googlemail.com" })).toBe(false);
      expect(impostor.isEmailAuthoritative({ email: "someone@gmail.com", hd: "gmail.com" })).toBe(false);
      expect(impostor.isEmailAuthoritative({ email: "someone@company.example", hd: "company.example" })).toBe(false);
    });

    it("trusts no email from a provider without a rule, not even @gmail.com with hd", () => {
      const other = createOidcProviderRegistry({
        oidcProviders: [{ ...googleAtFake(), id: "okta", name: "Okta" }],
      }).get("okta")!;
      expect(other.isEmailAuthoritative({ email: "someone@gmail.com", hd: "gmail.com" })).toBe(false);
    });
  });

  describe("relinksByEmail (Q126, Ruling 92)", () => {
    it("is true for a configured provider with an email-authority rule: Google at Google's issuer or the fake", () => {
      expect(createOidcProviderRegistry({ oidcProviders: [googleAtFake()] }).relinksByEmail("google")).toBe(true);
      const atGoogle = createOidcProviderRegistry({
        oidcProviders: [{ ...googleAtFake(), issuer: "https://accounts.google.com" }],
      });
      expect(atGoogle.relinksByEmail("google")).toBe(true);
    });

    it("is false for Google at an issuer that isn't Google's: it has no rule, so no sign-in links by email", () => {
      const impostor = createOidcProviderRegistry({
        oidcProviders: [{ ...googleAtFake(), issuer: "https://idp.telflo.example" }],
      });
      expect(impostor.get("google")).toBeDefined();
      expect(impostor.relinksByEmail("google")).toBe(false);
    });

    it("is false for a configured provider without a rule, and for one not configured", () => {
      const registry = createOidcProviderRegistry({ oidcProviders: [googleAtFake(), { ...googleAtFake(), id: "okta", name: "Okta" }] });
      expect(registry.relinksByEmail("okta")).toBe(false);
      expect(registry.relinksByEmail("legacy-idp")).toBe(false);
      expect(createOidcProviderRegistry({ oidcProviders: [] }).relinksByEmail("google")).toBe(false);
    });
  });
});
