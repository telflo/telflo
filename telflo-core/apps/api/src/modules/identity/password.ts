import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters. These follow OWASP's recommended configuration
 * (19 MiB memory, 2 iterations, 1 degree of parallelism), which balances
 * resistance to GPU cracking against per-request cost on a modest server.
 *
 * Raising memoryCost or timeCost later is safe: the encoded hash carries its
 * own parameters, so existing hashes keep verifying. Only new hashes change.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Returns false for a wrong password AND for a malformed or empty hash.
 *
 * Throwing on a malformed hash would turn a corrupted database column into a
 * 500 on a sign-in attempt, which is both a worse user experience and a more
 * informative one for an attacker. Failure to verify is failure to verify.
 */
export async function verifyPassword(hashValue: string, plaintext: string): Promise<boolean> {
  if (!hashValue) return false;
  try {
    return await verify(hashValue, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
