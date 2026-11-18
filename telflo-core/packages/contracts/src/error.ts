import { z } from "zod";

/**
 * The one error envelope, used by every endpoint (Global Constraints).
 * `code` is machine-readable and stable; `message` is for humans and may change.
 */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .strict();

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
