import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

// A real OpenID Provider on loopback, for tests only: vitest and the
// browser tests. Built on node:http and jose alone. It never ships:
// .dockerignore leaves apps/api/src/testing out of the images, and a lint
// rule keeps production code from importing it.
//
// It serves discovery, a JWKS, /authorize and /token, as Google does for the
// authorization-code flow with PKCE:
// - /authorize signs someone in either through a small HTML form (browser
//   tests fill it in, so parallel tests never share an identity)
//   or, for vitest, through the one-shot identity set by nextSignIn();
// - /token accepts client_secret_post only (the registry pins it), checks
//   the PKCE verifier, and makes each code single use;
// - ID tokens are RS256, and `authorization_response_iss_parameter_supported`
//   isn't advertised, as Google doesn't.

export const FAKE_OIDC_CLIENT_ID = "telflo-fake-oidc-client";
/** A fixed, public test credential. */
export const FAKE_OIDC_CLIENT_SECRET = "telflo-fake-oidc-client-secret";

/** The identity the provider asserts. Anything left out gets a default. */
export interface FakeOidcClaims {
  /** Default: a random subject. */
  sub?: string;
  /** Default: a random `@gmail.com` address, which Google is authoritative for. */
  email?: string;
  /** Default: `true`. A string is sent as a string, for tests of that refusal. */
  email_verified?: boolean | string;
  /** The Google Workspace domain. Default: none. */
  hd?: string;
}

/**
 * Ways to break the next ID token, each of which the relying party must
 * refuse:
 * - `wrong_nonce`: a nonce other than the one the authorization request sent;
 * - `wrong_audience`: an `aud` naming another client;
 * - `foreign_key`: signed by a key the JWKS doesn't publish (under the
 *   published key's `kid`), which only a signature check catches.
 */
export type FakeIdTokenFault = "wrong_nonce" | "wrong_audience" | "foreign_key";

export interface FakeSignInOptions {
  fault?: FakeIdTokenFault;
}

export interface FakeOidcRequests {
  discovery: number;
  jwks: number;
  /** Every /authorize request's parameters, GET query or POSTed form, in order. */
  authorize: URLSearchParams[];
  /** Every /token request's form body, in order. */
  token: URLSearchParams[];
}

export interface FakeOidcProvider {
  /** `http://<hostname>:<port>`, with no trailing slash. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  requests: FakeOidcRequests;
  /**
   * The next /authorize request signs in as `claims` without showing the
   * form. One shot; vitest only, since it runs serially.
   */
  nextSignIn(claims?: FakeOidcClaims, options?: FakeSignInOptions): void;
  /** The next /authorize request redirects back with `error` (the user cancelled). One shot. */
  nextAuthorizeError(error?: string): void;
  close(): Promise<void>;
}

export interface FakeOidcProviderOptions {
  /** Default 0: any free port. */
  port?: number;
  /** The host to listen on and to name in the issuer. Default `127.0.0.1`. */
  hostname?: "127.0.0.1" | "localhost";
  clientId?: string;
  clientSecret?: string;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | undefined;
  claims: Required<Pick<FakeOidcClaims, "sub" | "email" | "email_verified">> & Pick<FakeOidcClaims, "hd">;
  fault: FakeIdTokenFault | undefined;
}

const KEY_ID = "fake-oidc-key";
const ID_TOKEN_TTL_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function defaultClaims(claims: FakeOidcClaims = {}): IssuedCode["claims"] {
  return {
    sub: claims.sub ?? randomUUID(),
    email: claims.email ?? `fake-${randomUUID()}@gmail.com`,
    email_verified: claims.email_verified ?? true,
    ...(claims.hd === undefined ? {} : { hd: claims.hd }),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function redirect(response: ServerResponse, location: URL): void {
  response.writeHead(302, { location: location.href });
  response.end();
}

/** The authorization request's parameters the form carries through, hidden. */
const CARRIED_PARAMETERS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
] as const;

function signInForm(params: URLSearchParams): string {
  const hidden = CARRIED_PARAMETERS.flatMap((name) => {
    const value = params.get(name);
    return value === null ? [] : [`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`];
  }).join("\n      ");
  const email = `fake-${randomUUID()}@gmail.com`;
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fake OIDC provider</title></head>
  <body>
    <h1>Fake OIDC provider</h1>
    <form method="post" action="/authorize">
      ${hidden}
      <label>Email <input name="email" type="email" value="${escapeHtml(email)}"></label>
      <label>Subject <input name="sub" value="${escapeHtml(randomUUID())}"></label>
      <label><input name="email_verified" type="checkbox" value="true" checked> Email verified</label>
      <label>Hosted domain <input name="hd" value=""></label>
      <button type="submit" name="decision" value="allow">Sign in</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </body>
</html>`;
}

/**
 * Starts the provider. Close it after the tests: it holds a listening socket.
 */
export async function startFakeOidcProvider(options: FakeOidcProviderOptions = {}): Promise<FakeOidcProvider> {
  const hostname = options.hostname ?? "127.0.0.1";
  const clientId = options.clientId ?? FAKE_OIDC_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FAKE_OIDC_CLIENT_SECRET;

  const signingKey = await generateKeyPair("RS256");
  const foreignKey = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(signingKey.publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

  const codes = new Map<string, IssuedCode>();
  const requests: FakeOidcRequests = { discovery: 0, jwks: 0, authorize: [], token: [] };
  let pendingSignIn: { claims: FakeOidcClaims; fault: FakeIdTokenFault | undefined } | undefined;
  let pendingError: string | undefined;
  let issuer = "";

  function discoveryDocument(): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      claims_supported: ["sub", "email", "email_verified", "hd"],
    };
  }

  /** A refusal a real provider shows on its own page, because the redirect URI isn't trusted. */
  function invalidAuthorizationRequest(params: URLSearchParams): string | undefined {
    if (params.get("client_id") !== clientId) return "unknown client_id";
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri || !URL.canParse(redirectUri)) return "missing or malformed redirect_uri";
    if (params.get("response_type") !== "code") return "response_type must be code";
    if (!(params.get("scope") ?? "").split(" ").includes("openid")) return "scope must include openid";
    if (!params.get("code_challenge")) return "code_challenge is required";
    if (params.get("code_challenge_method") !== "S256") return "code_challenge_method must be S256";
    return undefined;
  }

  function callbackUrl(params: URLSearchParams, extra: Record<string, string>): URL {
    const url = new URL(params.get("redirect_uri") as string);
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
    const state = params.get("state");
    if (state !== null) url.searchParams.set("state", state);
    return url;
  }

  function issueCode(params: URLSearchParams, claims: FakeOidcClaims, fault: FakeIdTokenFault | undefined): URL {
    const code = randomToken();
    codes.set(code, {
      clientId,
      redirectUri: params.get("redirect_uri") as string,
      codeChallenge: params.get("code_challenge") as string,
      nonce: params.get("nonce") ?? undefined,
      claims: defaultClaims(claims),
      fault,
    });
    return callbackUrl(params, { code });
  }

  function handleAuthorize(params: URLSearchParams, response: ServerResponse, form: URLSearchParams | undefined): void {
    requests.authorize.push(params);
    const invalid = invalidAuthorizationRequest(params);
    if (invalid) return sendText(response, 400, invalid);

    if (form) {
      if (form.get("decision") !== "allow") {
        return redirect(response, callbackUrl(params, { error: "access_denied" }));
      }
      // An empty field takes the default, as a claim nextSignIn() leaves out.
      const claims: FakeOidcClaims = { email_verified: form.get("email_verified") === "true" };
      for (const name of ["sub", "email", "hd"] as const) {
        const value = form.get(name);
        if (value) claims[name] = value;
      }
      return redirect(response, issueCode(params, claims, undefined));
    }

    if (pendingError !== undefined) {
      const error = pendingError;
      pendingError = undefined;
      return redirect(response, callbackUrl(params, { error }));
    }
    if (pendingSignIn !== undefined) {
      const { claims, fault } = pendingSignIn;
      pendingSignIn = undefined;
      return redirect(response, issueCode(params, claims, fault));
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(signInForm(params));
  }

  async function idToken(issued: IssuedCode): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { ...issued.claims };
    const nonce = issued.fault === "wrong_nonce" ? randomToken() : issued.nonce;
    if (nonce !== undefined) payload.nonce = nonce;
    const key: CryptoKey = issued.fault === "foreign_key" ? foreignKey.privateKey : signingKey.privateKey;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(issued.claims.sub)
      .setAudience(issued.fault === "wrong_audience" ? "another-client" : issued.clientId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + ID_TOKEN_TTL_SECONDS)
      .sign(key);
  }

  async function handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(request));
    requests.token.push(body);

    // client_secret_post and nothing else: the registry pins it.
    if (request.headers.authorization !== undefined) {
      return sendJson(response, 401, { error: "invalid_client", error_description: "use client_secret_post" });
    }
    if (body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret) {
      return sendJson(response, 401, { error: "invalid_client" });
    }
    if (body.get("grant_type") !== "authorization_code") {
      return sendJson(response, 400, { error: "unsupported_grant_type" });
    }

    const code = body.get("code") ?? "";
    const issued = codes.get(code);
    // Single use: a code is spent by its first exchange, whatever the outcome.
    codes.delete(code);
    if (!issued || issued.clientId !== body.get("client_id")) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "unknown or used code" });
    }
    if (body.get("redirect_uri") !== issued.redirectUri) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }
    const verifier = body.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (verifier === "" || challenge !== issued.codeChallenge) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    sendJson(response, 200, {
      access_token: randomToken(),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: await idToken(issued),
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", issuer);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /.well-known/openid-configuration":
        requests.discovery += 1;
        return sendJson(response, 200, discoveryDocument());
      case "GET /jwks":
        requests.jwks += 1;
        return sendJson(response, 200, { keys: [publicJwk] });
      case "GET /authorize":
        return handleAuthorize(url.searchParams, response, undefined);
      case "POST /authorize": {
        const form = new URLSearchParams(await readBody(request));
        const params = new URLSearchParams();
        for (const name of CARRIED_PARAMETERS) {
          const value = form.get(name);
          if (value !== null) params.set(name, value);
        }
        return handleAuthorize(params, response, form);
      }
      case "POST /token":
        return handleToken(request, response);
      default:
        return sendText(response, 404, "not found");
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendText(response, 500, String(error));
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  issuer = `http://${hostname}:${port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    requests,
    nextSignIn(claims = {}, signInOptions = {}) {
      pendingSignIn = { claims, fault: signInOptions.fault };
    },
    nextAuthorizeError(error = "access_denied") {
      pendingError = error;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // fetch keeps connections alive; without this, close waits for them.
        server.closeAllConnections();
      });
    },
  };
}
