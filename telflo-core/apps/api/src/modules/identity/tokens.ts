import { createHash, randomBytes } from "node:crypto";

/** 32 bytes — 256 bits of entropy, well beyond guessing range. */
const TOKEN_BYTES = 32;

/**
 * SHA-256 rather than Argon2. Unlike a password, this token is 256 random bits,
 * so there is no dictionary to attack and no work factor worth paying: the
 * lookup happens on every verification request and must stay cheap. Hashing at
 * all is what matters — it means a leaked database yields no usable links.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A random opaque token (32 bytes, base64url) and the hash to store. The
 * plaintext is never persisted. Email verification and session refresh
 * tokens both use it.
 */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/**
 * Returns the plaintext token to email and the hash to store. The plaintext is
 * never persisted; if the email is lost, a new token is issued rather than the
 * old one recovered.
 */
export function generateVerificationToken(): { token: string; tokenHash: string } {
  return generateToken();
}
