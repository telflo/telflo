import { startFakeOidcProvider } from "../apps/api/src/testing/fake-oidc-provider.js";
import { E2E_OIDC_HOSTNAME, E2E_OIDC_PORT } from "./support/environment.js";

// The browser tests' OpenID Provider: the fake from apps/api/src/testing, on
// 127.0.0.1:28090, which the E2E API's Google settings name as the issuer
// (e2eApiEnv). 127.0.0.1 is a different site from the web app's localhost,
// so every sign-in crosses sites on the way back, as it does with Google. Every browser test signs in through its /authorize form,
// typing its own email, so parallel tests never share an identity (D2c
// Ruling 4). It lives under e2e/ and never ships. playwright.config.ts
// starts it, and waits for its discovery document.

const provider = await startFakeOidcProvider({ port: E2E_OIDC_PORT, hostname: E2E_OIDC_HOSTNAME });

async function stop(): Promise<void> {
  await provider.close();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
