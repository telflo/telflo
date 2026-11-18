import {
  FEEDBACK_AUTHOR_DELETED_MESSAGE,
  FEEDBACK_NOT_FOUND_MESSAGE,
  LAST_PRODUCT_ADMIN_MESSAGE,
  PRODUCT_ADMIN_NOT_FOUND_MESSAGE,
  PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE,
  USER_DELETE_BLOCKED_MESSAGE,
  USER_DELETE_BUSY_MESSAGE,
  USER_DELETE_SELF_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
  type AdminUserBlockKind,
  type FeedbackErrorCode,
  type IdentityErrorCode,
  type ProductAdminErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * Product administration's refusals (D29 decisions 28, 31 and 34; Rulings
 * 257 and 258), each in the contracts' fixed words: no message or `details`
 * names a person, an email, an organization or a feedback's text (decision
 * 41). `user_delete_blocked`'s details carry the block's kind only.
 */

/** The caller isn't a product admin, or stopped being one while a write waited (a write's `forbidden`, the gate's 42501). */
export function productAdminRequired(): AppError {
  return new AppError("product_admin_required" satisfies IdentityErrorCode, "Only a product admin can do that.", 403);
}

/** A grant's email names no live, verified person (decision 28). */
export function productAdminTargetNotFound(): AppError {
  return new AppError("product_admin_target_not_found" satisfies ProductAdminErrorCode, PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE, 404);
}

/** A removal's id isn't a live product admin's (a non-canonical id alike). */
export function productAdminNotFound(): AppError {
  return new AppError("product_admin_not_found" satisfies ProductAdminErrorCode, PRODUCT_ADMIN_NOT_FOUND_MESSAGE, 404);
}

/** The removal would leave no product admin (decision 5). */
export function lastProductAdmin(): AppError {
  return new AppError("last_product_admin" satisfies ProductAdminErrorCode, LAST_PRODUCT_ADMIN_MESSAGE, 409);
}

/** A delete's id isn't a live person's (a non-canonical id alike). */
export function userNotFound(): AppError {
  return new AppError("user_not_found" satisfies ProductAdminErrorCode, USER_NOT_FOUND_MESSAGE, 404);
}

/** A block read under the delete's locks (decision 30): the kind only, never a name. */
export function userDeleteBlocked(kind: AdminUserBlockKind): AppError {
  return new AppError("user_delete_blocked" satisfies ProductAdminErrorCode, USER_DELETE_BLOCKED_MESSAGE, 409, { kind });
}

/** A product admin's delete of their own account. */
export function userDeleteSelf(): AppError {
  return new AppError("user_delete_self" satisfies ProductAdminErrorCode, USER_DELETE_SELF_MESSAGE, 409);
}

/** The person's memberships kept changing under the delete's locks (Ruling 258): try again. */
export function userDeleteBusy(): AppError {
  return new AppError("user_delete_busy" satisfies ProductAdminErrorCode, USER_DELETE_BUSY_MESSAGE, 409);
}

/** A feedback item missing or already handled. */
export function feedbackNotFound(): AppError {
  return new AppError("feedback_not_found" satisfies FeedbackErrorCode, FEEDBACK_NOT_FOUND_MESSAGE, 404);
}

/** An acknowledge whose sender's account is deleted: the item stays pending (decision 34). */
export function feedbackAuthorDeleted(): AppError {
  return new AppError("feedback_author_deleted" satisfies FeedbackErrorCode, FEEDBACK_AUTHOR_DELETED_MESSAGE, 409);
}

/** A list cursor `encodeCursor` couldn't have made: the envelope's shared code and words, as a refused query's. */
export function invalidCursor(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400);
}
