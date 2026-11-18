import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";

// Drives one authorization-code flow with PKCE, as a relying party does,
// against a provider that answers /authorize with a redirect (the fake
// provider after nextSignIn() or nextAuthorizeError()). For tests only.

/** Never fetched: the flow stops at the provider's redirect to it. */
export const TEST_REDIRECT_URI = "https://telflo.example/api/v1/auth/oidc/google/callback";

export interface AuthorizedFlow {
  /** Where the provider redirected the browser back to. */
  callbackUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** A fresh authorization request, as the start endpoint builds one. */
export async function startAuthorization(config: Configuration): Promise<AuthorizationRequest> {
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const url = buildAuthorizationUrl(config, {
    redirect_uri: TEST_REDIRECT_URI,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
  return { url, state, nonce, codeVerifier };
}

export async function authorizeAtProvider(config: Configuration): Promise<AuthorizedFlow> {
  const { url, state, nonce, codeVerifier } = await startAuthorization(config);
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || location === null) {
    throw new Error(`expected a redirect from /authorize, received ${response.status}`);
  }
  return { callbackUrl: new URL(location), state, nonce, codeVerifier };
}

/** The token exchange for `flow`, with the checks the callback makes. */
export function exchangeCode(
  config: Configuration,
  flow: AuthorizedFlow,
  overrides: { codeVerifier?: string } = {},
): ReturnType<typeof authorizationCodeGrant> {
  return authorizationCodeGrant(config, flow.callbackUrl, {
    pkceCodeVerifier: overrides.codeVerifier ?? flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
}
