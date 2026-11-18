import { randomBytes } from "node:crypto";
import { QUICK_DEPLOY_PATH_PREFIX } from "@telflo/contracts";
import { hashToken } from "../identity/tokens.js";

/*
 * A quick-deploy link's secret (D17c-2 decision 23; ADR 0023): `tqd_` and 32
 * random bytes in base64url (256 bits), shown once inside the link and
 * stored only as its sha-256, as every hashed token of the platform's
 * (identity/tokens.ts). The secret is a credential: never logged, audited
 * or put in an error.
 */

const SECRET_BYTES = 32;
const SECRET_PREFIX = "tqd_";

/** sha-256 (lowercase hex) of a secret: what the table stores and the lookup takes. */
export function quickDeploySecretHash(secret: string): string {
  return hashToken(secret);
}

/** A new secret and the hash to store. */
export function generateQuickDeploySecret(): { secret: string; secretHash: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, secretHash: quickDeploySecretHash(secret) };
}

/**
 * The link whoever runs the command downloads from (Preflight ruling 8):
 * TELFLO_PUBLIC_API_URL (its trailing `/` already removed by the settings)
 * and `/api/v1/quick-deploy/{secret}`.
 */
export function quickDeployLinkUrl(publicApiUrl: string, secret: string): string {
  return `${publicApiUrl}${QUICK_DEPLOY_PATH_PREFIX}${secret}`;
}
