import { randomBytes } from "node:crypto";
import { hashToken } from "../identity/tokens.js";

/*
 * An API token (D22 decision 7; ADR 0023): `tf_` and 32 random bytes in
 * base64url (256 bits, 46 characters in all), a fixed format, so a secret
 * scanner can match it. Shown once, in the create's reply, and
 * stored only as its sha-256 (hex, as every hashed token of the platform's:
 * identity/tokens.ts) and its first 11 characters, the prefix the list
 * shows. The token is a credential like a fleet's bearer (decision 48):
 * never logged, audited, put in an error or returned again.
 */

const API_TOKEN_BYTES = 32;
const API_TOKEN_MARK = "tf_";

/** How many of the token's first characters are stored and listed: `tf_` and eight. */
export const API_TOKEN_PREFIX_LENGTH = 11;

/** A token just minted: the token itself, to hand back once, and what is stored. */
export interface MintedApiToken {
  token: string;
  /** sha-256 (lowercase hex) of the whole token: what the table stores and the token check looks up. */
  tokenHash: string;
  /** Its first 11 characters. */
  tokenPrefix: string;
}

/** sha-256 (lowercase hex) of a token, as the table stores it. */
export function apiTokenHash(token: string): string {
  return hashToken(token);
}

/** A new token, its hash and its prefix. */
export function mintApiToken(): MintedApiToken {
  const token = `${API_TOKEN_MARK}${randomBytes(API_TOKEN_BYTES).toString("base64url")}`;
  return { token, tokenHash: apiTokenHash(token), tokenPrefix: token.slice(0, API_TOKEN_PREFIX_LENGTH) };
}
