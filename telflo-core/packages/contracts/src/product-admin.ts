import { z } from "zod";
import { hasUnstorableCharacter } from "./configurations.js";
import { OrganizationRoleSchema } from "./organizations.js";
import { emailSchema } from "./shared.js";

/*
 * Product administration (D29 decisions 28, 31 to 34): the routes under
 * `/api/v1/product-admin/`, each `[authenticate, requireProductAdmin]`
 * (403 `product_admin_required` otherwise, and also when the caller lost
 * the flag while a write waited: Rulings 257 and 258), every answer
 * `Cache-Control: no-store`; and "Contact us"'s `POST /api/v1/feedback`
 * for any signed-in person with the current terms.
 *
 *   GET    /api/v1/product-admin/product-admins                    → ProductAdminsResponseSchema
 *   POST   /api/v1/product-admin/product-admins                    GrantProductAdminRequestSchema → 201 ProductAdminSchema (granted), 200 (already one)
 *   DELETE /api/v1/product-admin/product-admins/:userId            → 204
 *   GET    /api/v1/product-admin/users?q=&cursor=                  ListAdminUsersQuerySchema → AdminUsersPageSchema
 *   DELETE /api/v1/product-admin/users/:userId                     → 204
 *   GET    /api/v1/product-admin/feedback?cursor=                  ListUserFeedbackQuerySchema → UserFeedbackPageSchema
 *   GET    /api/v1/product-admin/feedback/pending-count            → PendingFeedbackCountSchema
 *   POST   /api/v1/product-admin/feedback/:id/acknowledge          AcknowledgeFeedbackRequestSchema → 204
 *   POST   /api/v1/product-admin/feedback/:id/dismiss              → 204
 *   GET    /api/v1/product-admin/settings                          → ProductAdminSettingsSchema
 *   PATCH  /api/v1/product-admin/settings                          ChangeProductAdminSettingsRequestSchema → 200 ProductAdminSettingsSchema
 *   POST   /api/v1/feedback                                        CreateFeedbackRequestSchema → 201 CreateFeedbackResponseSchema
 *
 * Every id in a path goes through the API's canonicalIdOf: one that isn't a
 * canonical UUID is the route's 404. Other people's emails, organization
 * names, roles, feedback text and the reply are personal data (decision
 * 41): JSON bodies only, never a URL but the Users search's `q` (which no
 * log keeps), never an error's message or `details`.
 */

/** The Users search's longest term, after trimming (an address's limit, RFC 5321). */
export const ADMIN_USERS_SEARCH_MAXIMUM_LENGTH = 254;

/** The Users page's page size (decision 9). */
export const ADMIN_USERS_PAGE_SIZE = 50;

/** The User Feedback page's page size (decision 33). */
export const USER_FEEDBACK_PAGE_SIZE = 25;

/** The longest cursor the lists accept: base64url of a timestamp and an id is far shorter. */
export const PRODUCT_ADMIN_CURSOR_MAXIMUM_LENGTH = 200;

/** A feedback's text, and an acknowledgement's reply, after trimming (decisions 15 and 34; the table's check). */
export const FEEDBACK_TEXT_MAXIMUM_LENGTH = 5000;
export const FEEDBACK_REPLY_MAXIMUM_LENGTH = 5000;

/** The default reply, which the acknowledge dialog starts from (decision 40). */
export const FEEDBACK_DEFAULT_REPLY =
  "Thank you for your feedback. We sincerely appreciate you taking the time to help us improve.";

const uuid = z.string().uuid();

/**
 * Trimmed text of 1 to `maximum` characters with nothing Postgres can't
 * store exactly (U+0000, a lone surrogate): the feedback's text and the
 * reply. Personal data: the messages name no value.
 */
const personalTextSchema = (required: string, maximum: number) =>
  z
    .string()
    .trim()
    .min(1, required)
    .max(maximum)
    .refine((text) => !hasUnstorableCharacter(text), "The text can't contain U+0000 or a lone surrogate.");

// --- Product admins (decisions 27 and 28) -----------------------------------

/** A product admin, as the page lists one. */
export const ProductAdminSchema = z.object({ id: uuid, email: z.string() }).strict();

export type ProductAdmin = z.infer<typeof ProductAdminSchema>;

/** Every live product admin, by email (unpaged: a handful). */
export const ProductAdminsResponseSchema = z.object({ items: z.array(ProductAdminSchema) }).strict();

export type ProductAdminsResponse = z.infer<typeof ProductAdminsResponseSchema>;

/** "Add product admin": the exact email of a live, verified person. */
export const GrantProductAdminRequestSchema = z.object({ email: emailSchema }).strict();

export type GrantProductAdminRequest = z.infer<typeof GrantProductAdminRequestSchema>;

// --- Users (decisions 9, 30 and 31) -----------------------------------------

/**
 * Why a person can't be deleted (decision 30): a member of an organization
 * not theirs alone (with their role there), the owner of their personal
 * organization while it has another live member or a pending invitation,
 * or a product admin. Never a delete: the dialog explains it.
 */
export const AdminUserBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), organizationName: z.string(), role: OrganizationRoleSchema }).strict(),
  z.object({ kind: z.literal("owner"), organizationName: z.string() }).strict(),
  z.object({ kind: z.literal("product_admin") }).strict(),
]);

export type AdminUserBlock = z.infer<typeof AdminUserBlockSchema>;

export const ADMIN_USER_BLOCK_KINDS = ["member", "owner", "product_admin"] as const;

export type AdminUserBlockKind = (typeof ADMIN_USER_BLOCK_KINDS)[number];

/** One live person on the Users page. */
export const AdminUserSchema = z
  .object({
    id: uuid,
    email: z.string(),
    createdAt: z.string().datetime(),
    isProductAdmin: z.boolean(),
    block: AdminUserBlockSchema.nullable(),
  })
  .strict();

export type AdminUser = z.infer<typeof AdminUserSchema>;

/** A page of people, newest first; `nextCursor` opaque, null on the last page. */
export const AdminUsersPageSchema = z
  .object({ items: z.array(AdminUserSchema), nextCursor: z.string().nullable() })
  .strict();

export type AdminUsersPage = z.infer<typeof AdminUsersPageSchema>;

/**
 * The Users list's query: `q` trimmed (empty is no search), at most
 * ADMIN_USERS_SEARCH_MAXIMUM_LENGTH; `cursor` a previous page's
 * `nextCursor` (a bad one is 400). The cursor carries no term: a client
 * sends the same `q` with every page. Strict.
 */
export const ListAdminUsersQuerySchema = z
  .object({
    q: z.string().trim().max(ADMIN_USERS_SEARCH_MAXIMUM_LENGTH).optional(),
    cursor: z.string().max(PRODUCT_ADMIN_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

export type ListAdminUsersQuery = z.input<typeof ListAdminUsersQuerySchema>;

/** `user_delete_blocked`'s `details`: the block's kind only, never a name (decision 31). */
export const UserDeleteBlockedDetailsSchema = z.object({ kind: z.enum(ADMIN_USER_BLOCK_KINDS) }).strict();

export type UserDeleteBlockedDetails = z.infer<typeof UserDeleteBlockedDetailsSchema>;

// --- User Feedback (decisions 32 to 34) -------------------------------------

/** One pending feedback item: the sender's current email, and whether their account is deleted. */
export const UserFeedbackItemSchema = z
  .object({
    id: uuid,
    email: z.string(),
    text: z.string(),
    createdAt: z.string().datetime(),
    authorDeleted: z.boolean(),
  })
  .strict();

export type UserFeedbackItem = z.infer<typeof UserFeedbackItemSchema>;

/** A page of pending feedback, newest first; `nextCursor` opaque, null on the last page. */
export const UserFeedbackPageSchema = z
  .object({ items: z.array(UserFeedbackItemSchema), nextCursor: z.string().nullable() })
  .strict();

export type UserFeedbackPage = z.infer<typeof UserFeedbackPageSchema>;

/** The feedback list's query: a previous page's `nextCursor`. Strict. */
export const ListUserFeedbackQuerySchema = z
  .object({ cursor: z.string().max(PRODUCT_ADMIN_CURSOR_MAXIMUM_LENGTH).optional() })
  .strict();

export type ListUserFeedbackQuery = z.input<typeof ListUserFeedbackQuerySchema>;

/** How many feedback items are pending (decision 37): the nav's badge. */
export const PendingFeedbackCountSchema = z.object({ count: z.number().int().min(0) }).strict();

export type PendingFeedbackCount = z.infer<typeof PendingFeedbackCountSchema>;

/** An acknowledgement's reply, emailed to the sender and never stored (decision 34). */
export const AcknowledgeFeedbackRequestSchema = z
  .object({ reply: personalTextSchema("Enter a reply.", FEEDBACK_REPLY_MAXIMUM_LENGTH) })
  .strict();

export type AcknowledgeFeedbackRequest = z.infer<typeof AcknowledgeFeedbackRequestSchema>;

/** "Contact us" (decision 32): the message, trimmed, 1 to 5,000 characters. */
export const CreateFeedbackRequestSchema = z
  .object({ text: personalTextSchema("Enter a message.", FEEDBACK_TEXT_MAXIMUM_LENGTH) })
  .strict();

export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequestSchema>;

export const CreateFeedbackResponseSchema = z.object({ id: uuid }).strict();

export type CreateFeedbackResponse = z.infer<typeof CreateFeedbackResponseSchema>;

// --- The site's settings (D36-1 decision 51) ---------------------------------

/**
 * Who may create a group organization: anyone signed in (`everyone`, the
 * default) or live product admins only (`product-admins`). Organizations
 * that already exist are untouched either way: their admins keep inviting.
 */
export const ORGANIZATION_CREATION_VALUES = ["everyone", "product-admins"] as const;

export const OrganizationCreationSchema = z.enum(ORGANIZATION_CREATION_VALUES);

export type OrganizationCreation = z.infer<typeof OrganizationCreationSchema>;

/** The site's settings a product admin changes: the GET's answer and the PATCH's. No personal data. */
export const ProductAdminSettingsSchema = z.object({ organizationCreation: OrganizationCreationSchema }).strict();

export type ProductAdminSettings = z.infer<typeof ProductAdminSettingsSchema>;

/** The PATCH's body: the one setting, required (strict). */
export const ChangeProductAdminSettingsRequestSchema = z.object({ organizationCreation: OrganizationCreationSchema }).strict();

export type ChangeProductAdminSettingsRequest = z.infer<typeof ChangeProductAdminSettingsRequestSchema>;

// --- Error codes -------------------------------------------------------------

/**
 * The product-admin routes' own refusals for people (decisions 28 and 31;
 * Ruling 258's `user_delete_busy`). `product_admin_required` stays in
 * IDENTITY_ERROR_CODES (Preflight ruling 8). No message names a person.
 */
export const PRODUCT_ADMIN_ERROR_CODES = [
  "product_admin_target_not_found",
  "product_admin_not_found",
  "last_product_admin",
  "user_not_found",
  "user_delete_blocked",
  "user_delete_self",
  "user_delete_busy",
] as const;

export type ProductAdminErrorCode = (typeof PRODUCT_ADMIN_ERROR_CODES)[number];

/** Feedback's own refusals (decision 34): handling an item. */
export const FEEDBACK_ERROR_CODES = ["feedback_not_found", "feedback_author_deleted"] as const;

export type FeedbackErrorCode = (typeof FEEDBACK_ERROR_CODES)[number];

/** Fixed words for each refusal (decisions 5, 28, 31 and 34). */
export const PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE = "No verified account uses that email.";
export const PRODUCT_ADMIN_NOT_FOUND_MESSAGE = "That account isn't a product admin.";
export const LAST_PRODUCT_ADMIN_MESSAGE = "Telflo needs at least one product admin.";
export const USER_NOT_FOUND_MESSAGE = "User not found.";
export const USER_DELETE_BLOCKED_MESSAGE = "This account can't be deleted yet.";
export const USER_DELETE_SELF_MESSAGE = "You can't delete your own account here.";
export const USER_DELETE_BUSY_MESSAGE = "The account changed while it was being deleted. Try again.";
export const FEEDBACK_NOT_FOUND_MESSAGE = "Feedback not found.";
export const FEEDBACK_AUTHOR_DELETED_MESSAGE = "The sender's account was deleted, so no reply can be sent.";
