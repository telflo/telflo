import { z } from "zod";
import { emailSchema } from "./shared.js";

/** The inquiry's limits, after trimming. */
export const SALES_INQUIRY_NAME_MAXIMUM_LENGTH = 200;
export const SALES_INQUIRY_MESSAGE_MAXIMUM_LENGTH = 5000;
export const SALES_INQUIRY_WEBSITE_MAXIMUM_LENGTH = 200;

/**
 * `POST /api/v1/sales-inquiries`: a contact form's inquiry (switched by
 * TELFLO_SALES_INQUIRY). The email is the contract's, at most 254 characters
 * and lowercased.
 *
 * `website` is a honeypot the form hides from people. The API answers a
 * filled one with 202 and sends nothing, before this schema runs, so a bot
 * learns nothing from a refusal.
 */
export const SalesInquiryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(SALES_INQUIRY_NAME_MAXIMUM_LENGTH),
    email: emailSchema,
    message: z.string().trim().min(1).max(SALES_INQUIRY_MESSAGE_MAXIMUM_LENGTH),
    website: z.string().trim().max(SALES_INQUIRY_WEBSITE_MAXIMUM_LENGTH).optional(),
  })
  .strict();

export type SalesInquiryRequest = z.infer<typeof SalesInquiryRequestSchema>;

/**
 * The error codes of the sales inquiry endpoint, named once so a misspelled
 * code is a type error. A failed send is the only one of its own; the rest
 * are the envelope's shared codes (`invalid_request`, `rate_limited`).
 */
export const SALES_INQUIRY_ERROR_CODES = ["sales_inquiry_failed"] as const;

export type SalesInquiryErrorCode = (typeof SALES_INQUIRY_ERROR_CODES)[number];
