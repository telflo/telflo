import {
  INVITATION_ALREADY_ACCEPTED_MESSAGE,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  ORGANIZATION_CREATION_RESTRICTED_MESSAGE,
  PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE,
  invitationEmailMismatchMessage,
  type OrganizationErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The refusals of the organization endpoints and of switching and of
 * invitations, each under its contract code. The web shows the messages to the
 * user as they are.
 */

function organizationError(code: OrganizationErrorCode, message: string, statusCode: number): AppError {
  return new AppError(code, message, statusCode);
}

/** Any organization but the active one, or a deleted one: a non-member learns nothing. */
export function organizationNotFound(): AppError {
  return organizationError("organization_not_found", "Organization not found", 404);
}

/** A clash. */
export function organizationNameTaken(): AppError {
  return organizationError("organization_name_taken", "That name is invalid or already exists", 409);
}

/** The site lets only product admins create organizations, and the caller isn't one. */
export function organizationCreationRestricted(): AppError {
  return organizationError("organization_creation_restricted", ORGANIZATION_CREATION_RESTRICTED_MESSAGE, 403);
}

export function organizationAdminRequired(): AppError {
  return organizationError("organization_admin_required", "Only an admin of this organization can do that", 403);
}

/** Fixed words, for an unknown or deleted organization as for one the user left. */
export function organizationAccessDenied(): AppError {
  return organizationError("organization_access_denied", "You are not an active member of this organization", 403);
}

export function cannotChangeOwnRole(): AppError {
  return organizationError("cannot_change_own_membership", "You cannot change your own role", 409);
}

export function cannotRemoveYourself(): AppError {
  return organizationError("cannot_change_own_membership", "You cannot remove yourself from the organization", 409);
}

export function memberNotFound(): AppError {
  return organizationError("member_not_found", "Member not found", 404);
}

export function memberNotActiveForRoleChange(): AppError {
  return organizationError("member_not_active", "Only active members can have their role changed", 409);
}

export function memberNotActiveForRemoval(): AppError {
  return organizationError("member_not_active", "Only active members can be removed", 409);
}

export function memberNotRemoved(): AppError {
  return organizationError("member_not_removed", "Only deleted members can be restored", 409);
}

/**
 * A role change, a removal or a restoration naming a service account: it is a
 * fixed contributor, deleted only from its own page. Fixed words: never its
 * name or address.
 */
export function memberIsServiceAccount(): AppError {
  return organizationError(
    "member_is_service_account",
    "Service accounts are managed in Settings › Service Accounts.",
    409,
  );
}

export function personalOrganizationNotDeletable(): AppError {
  return organizationError("personal_organization_protected", "A personal organization can't be deleted", 409);
}

export function personalOrganizationOwnerProtected(): AppError {
  return organizationError(
    "personal_organization_protected",
    "The owner of a personal organization can't be removed or have their role changed",
    409,
  );
}

/*
 * Inviting, resending and cancelling.
 */

/** The address belongs to an active member, the caller's own included. */
export function memberAlreadyActive(): AppError {
  return organizationError("member_already_active", "User is already a member of this organization", 409);
}

/** Naming the address: the admin restores a removed member rather than inviting them again. */
export function memberRemovedFromOrganization(email: string): AppError {
  return organizationError(
    "member_removed",
    `${email} was previously removed from this organization. Restore them from the Deleted view instead of re-inviting.`,
    409,
  );
}

/** A pending invitation to the address exists, expired or not: Resend revives it. */
export function invitationAlreadyPending(): AppError {
  return organizationError("invitation_already_pending", "User has already been invited to this organization", 409);
}

/**
 * An invite or a resend from a personal organization while the site's
 * registration isn't open: fixed words, which the web shows in place of
 * Invite Member too.
 */
export function personalOrganizationInvitationsDisabled(): AppError {
  return organizationError(
    "personal_organization_invitations_disabled",
    PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE,
    403,
  );
}

/** Resending or cancelling anything but a pending invitation of the active organization. */
export function pendingInvitationNotFound(): AppError {
  return organizationError("invitation_not_found", "No pending invitation found for this user", 404);
}

/**
 * The invitation committed, and only its email failed. It carries neither
 * details nor the mailer's error, which is logged on its own.
 */
export function invitationEmailFailed(): AppError {
  return organizationError(
    "invitation_email_failed",
    "The invitation was created, but its email couldn't be sent. Use Resend to try again.",
    502,
  );
}

/** As `invitationEmailFailed`, for a resend: its new token committed, and only the email failed. */
export function resentInvitationEmailFailed(): AppError {
  return organizationError(
    "invitation_email_failed",
    "The invitation's link was renewed, but its email couldn't be sent. Use Resend to try again.",
    502,
  );
}

/*
 * The invitee's side: previewing, accepting and creating an account. The four
 * messages the accept page also shows are the contracts', so the two can't
 * drift apart.
 */

/** An unknown, revoked or superseded token, or a deleted organization: all alike, so a dead link tells nothing. */
export function invitationNotFound(): AppError {
  return organizationError("invitation_not_found", INVITATION_NOT_FOUND_MESSAGE, 404);
}

export function invitationExpired(): AppError {
  return organizationError("invitation_expired", INVITATION_EXPIRED_MESSAGE, 410);
}

export function invitationAlreadyAccepted(): AppError {
  return organizationError("invitation_already_accepted", INVITATION_ALREADY_ACCEPTED_MESSAGE, 409);
}

/** Only the invited address may accept; the message names it, for the page to show. */
export function invitationEmailMismatch(email: string): AppError {
  return organizationError("invitation_email_mismatch", invitationEmailMismatchMessage(email), 403);
}

/** The invitee was a member, and was removed: an admin restores them, and an invitation doesn't. */
export function removedMemberCannotAccept(): AppError {
  return organizationError(
    "member_removed",
    "You were removed from this organization. Ask an admin to restore you.",
    409,
  );
}

/** A live or soft-deleted account holds the invited address: its owner signs in and accepts instead. */
export function accountExists(): AppError {
  return organizationError(
    "account_exists",
    "An account already exists for this email address. Sign in to accept the invitation.",
    409,
  );
}

/*
 * An organization's logo: refused before anything is written, with no details
 * (they could echo a name). The browser checks first and shows its own words;
 * these are the API's.
 */

/** An empty file, or bytes that aren't a PNG, a JPEG or a WebP image (SVG included). */
export function organizationLogoTypeUnsupported(): AppError {
  return organizationError("organization_logo_type_unsupported", "The logo must be a PNG, JPEG or WebP image.", 415);
}

/** A file over ORGANIZATION_LOGO_MAXIMUM_BYTES (2 MiB), busboy's cut seen by `finish`. */
export function organizationLogoTooLarge(): AppError {
  return organizationError("organization_logo_too_large", "The logo must be 2 MB or smaller.", 413);
}

/**
 * The public logo read's one refusal, answered in plain text as "Not found.":
 * a malformed id, an organization deleted or never there, an old or removed
 * logo's id and bytes that are gone, all alike.
 */
export function organizationLogoNotFound(): AppError {
  return new AppError("organization_logo_not_found", "Not found.", 404);
}
