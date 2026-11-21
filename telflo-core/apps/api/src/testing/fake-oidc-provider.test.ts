import { randomPKCECodeVerifier, type Configuration } from "openid-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOidcProviderRegistry } from "../modules/oidc/providers.js";
import { startFakeOidcProvider, type FakeOidcProvider } from "./fake-oidc-provider.js";
import { authorizeAtProvider, exchangeCode, startAuthorization, TEST_REDIRECT_URI } from "./oidc-grant.js";

// The fake provider, driven by the real openid-client configuration the
// API uses: discovery, the authorization-code grant with PKCE, and every
// switch the sign-in tests rely on.

let fake: FakeOidcProvider;
let config: Configuration;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  const registry = createOidcProviderRegistry({
    oidcProviders: [
      { id: "google", name: "Google", issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret },
    ],
  });
  config = await registry.get("google")!.configuration();
});

afterAll(async () => {
  await fake.close();
});

function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

/** The hidden fields of the form /authorize served, as a browser would post them. */
function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1] as string] = (match[2] as string).replaceAll("&amp;", "&");
  }
  return fields;
}

describe("the fake OIDC provider", () => {
  it("listens on loopback and serves its discovery document", () => {
    expect(fake.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(config.serverMetadata()).toMatchObject({
      issuer: fake.issuer,
      token_endpoint: `${fake.issuer}/token`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(config.serverMetadata().authorization_response_iss_parameter_supported).toBeUndefined();
  });

  it("completes the authorization-code grant with PKCE, with the claims nextSignIn set", async () => {
    fake.nextSignIn({ sub: "subject-1", email: "someone@gmail.com" });
    const flow = await authorizeAtProvider(config);

    const tokens = await exchangeCode(config, flow);

    expect(tokens.claims()).toMatchObject({
      iss: fake.issuer,
      aud: fake.clientId,
      sub: "subject-1",
      email: "someone@gmail.com",
      email_verified: true,
      nonce: flow.nonce,
    });
    expect(flow.callbackUrl.searchParams.get("state")).toBe(flow.state);
    expect(flow.callbackUrl.searchParams.has("iss")).toBe(false);
  });

  it("sends the client's credentials in the body (client_secret_post), with the PKCE verifier", async () => {
    fake.nextSignIn();
    const flow = await authorizeAtProvider(config);
    await exchangeCode(config, flow);

    const body = fake.requests.token.at(-1)!;
    expect(body.get("client_id")).toBe(fake.clientId);
    expect(body.get("client_secret")).toBe(fake.clientSecret);
    expect(body.get("code_verifier")).toBe(flow.codeVerifier);
    expect(body.get("redirect_uri")).toBe(TEST_REDIRECT_URI);
  });

  it("defaults to a verified, random @gmail.com address", async () => {
    fake.nextSignIn();
    const claims = (await exchangeCode(config, await authorizeAtProvider(config))).claims();
    expect(claims?.email).toMatch(/^fake-[0-9a-f-]+@gmail\.com$/);
    expect(claims?.email_verified).toBe(true);
    expect(claims?.hd).toBeUndefined();
  });

  it("asserts email_verified false and hd when told to", async () => {
    fake.nextSignIn({ email: "someone@company.example", email_verified: false, hd: "company.example" });
    const claims = (await exchangeCode(config, await authorizeAtProvider(config))).claims();
    expect(claims).toMatchObject({ email: "someone@company.example", email_verified: false, hd: "company.example" });
  });

  it("refuses the exchange with a wrong PKCE verifier", async () => {
    fake.nextSignIn();
    const flow = await authorizeAtProvider(config);

    await expect(exchangeCode(config, flow, { codeVerifier: randomPKCECodeVerifier() })).rejects.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("makes each code single use", async () => {
    fake.nextSignIn();
    const flow = await authorizeAtProvider(config);
    await exchangeCode(config, flow);

    await expect(exchangeCode(config, flow)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("spends a code even on a failed exchange", async () => {
    fake.nextSignIn();
    const flow = await authorizeAtProvider(config);
    await expect(exchangeCode(config, flow, { codeVerifier: randomPKCECodeVerifier() })).rejects.toThrow();

    await expect(exchangeCode(config, flow)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refuses the client's credentials sent any other way", async () => {
    const tokenUrl = `${fake.issuer}/token`;
    const basic = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${fake.clientId}:${fake.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: formBody({ grant_type: "authorization_code", code: "x", redirect_uri: TEST_REDIRECT_URI }),
    });
    const wrongSecret = await fetch(tokenUrl, {
      method: "POST",
      body: formBody({ grant_type: "authorization_code", code: "x", client_id: fake.clientId, client_secret: "wrong" }),
    });

    expect(basic.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toMatchObject({ error: "invalid_client" });
  });

  it("redirects back with the error nextAuthorizeError set, and the same state", async () => {
    fake.nextAuthorizeError();
    const flow = await authorizeAtProvider(config);

    expect(flow.callbackUrl.searchParams.get("error")).toBe("access_denied");
    expect(flow.callbackUrl.searchParams.get("state")).toBe(flow.state);
    expect(flow.callbackUrl.searchParams.has("code")).toBe(false);
  });

  it("records each authorization request", async () => {
    fake.nextSignIn();
    const flow = await authorizeAtProvider(config);

    const params = fake.requests.authorize.at(-1)!;
    expect(params.get("state")).toBe(flow.state);
    expect(params.get("nonce")).toBe(flow.nonce);
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  describe("ID token faults, each refused by openid-client", () => {
    // openid-client wraps the reason; the cause names the claim or check.
    it.each([
      ["wrong_nonce", /"nonce" claim value/],
      ["wrong_audience", /"aud" \(audience\) claim value/],
      ["foreign_key", /JWT signature verification failed/],
    ] as const)("%s", async (fault, reason) => {
      fake.nextSignIn({}, { fault });
      await expect(exchangeCode(config, await authorizeAtProvider(config))).rejects.toMatchObject({
        cause: { message: expect.stringMatching(reason) },
      });
    });
  });

  describe("the sign-in form (browser tests)", () => {
    async function formFor(): Promise<{ html: string; state: string; nonce: string; codeVerifier: string }> {
      // No nextSignIn(): /authorize answers with the form instead of a redirect.
      const { url, state, nonce, codeVerifier } = await startAuthorization(config);
      const response = await fetch(url, { redirect: "manual" });
      expect(response.status).toBe(200);
      return { html: await response.text(), state, nonce, codeVerifier };
    }

    async function submit(fields: Record<string, string>): Promise<URL> {
      const response = await fetch(`${fake.issuer}/authorize`, {
        method: "POST",
        body: formBody(fields),
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      return new URL(response.headers.get("location")!);
    }

    it("serves a form with email, subject, email_verified, hosted domain and Deny", async () => {
      const { html } = await formFor();
      for (const name of ["email", "sub", "email_verified", "hd"]) expect(html).toContain(`name="${name}"`);
      expect(html).toContain('value="deny"');
    });

    it("signs in as the identity entered in the form", async () => {
      const { html, state, nonce, codeVerifier } = await formFor();

      const callbackUrl = await submit({
        ...hiddenFields(html),
        email: "typed@company.example",
        sub: "typed-subject",
        hd: "company.example",
        decision: "allow",
      });
      const claims = (await exchangeCode(config, { callbackUrl, state, nonce, codeVerifier })).claims();

      // The checkbox left unticked is absent from the post: not verified.
      expect(claims).toMatchObject({
        sub: "typed-subject",
        email: "typed@company.example",
        email_verified: false,
        hd: "company.example",
      });
    });

    it("redirects back with access_denied and the state when Deny is pressed", async () => {
      const { html, state } = await formFor();

      const callbackUrl = await submit({ ...hiddenFields(html), decision: "deny" });

      expect(callbackUrl.searchParams.get("error")).toBe("access_denied");
      expect(callbackUrl.searchParams.get("state")).toBe(state);
    });
  });
});
