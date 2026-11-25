import { z } from "zod";

/**
 * Field schemas and limits used by more than one contract module. Internal to
 * the package, except `emailSchema`, which index.ts re-exports for the API's
 * settings.
 */

/** Bounded so a huge body cannot make every Argon2id hash arbitrarily costly. */
export const PASSWORD_MAXIMUM_LENGTH = 128;

/**
 * A current password as typed: anything not empty, as sign-in takes it, up
 * to the Argon2id bound. Deliberately not trimmed (`RegisterRequestSchema`).
 * The account's re-authentications and an API token's create.
 */
export const CurrentPasswordSchema = z.string().min(1).max(PASSWORD_MAXIMUM_LENGTH);

/** RFC 5321 caps an address at 254 characters. */
const EMAIL_MAXIMUM_LENGTH = 254;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(EMAIL_MAXIMUM_LENGTH);
