import { z } from "zod";

/**
 * Field schemas and limits used by more than one contract module. Internal to
 * the package, except `emailSchema`, which index.ts re-exports for the API's
 * settings.
 */

/** Bounded so a huge body cannot make every Argon2id hash arbitrarily costly. */
export const PASSWORD_MAXIMUM_LENGTH = 128;

/** RFC 5321 caps an address at 254 characters. */
const EMAIL_MAXIMUM_LENGTH = 254;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(EMAIL_MAXIMUM_LENGTH);
