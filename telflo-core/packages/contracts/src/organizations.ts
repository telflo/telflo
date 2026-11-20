import { z } from "zod";
import type { RegistrationMode } from "./site.js";

/** The limit, after trimming. The database allows 300, for personal names. */
export const ORGANIZATION_NAME_MAXIMUM_LENGTH = 100;

/**
 * The roles a member can hold: an admin administers the organization, and
 * every member changes its content. The viewer role is retired, so a request
 * naming it is 400 `invalid_request`.
 */
export const OrganizationRoleSchema = z.enum(["admin", "contributor"]);

export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

/** A personal organization is its owner's workspace; a group organization is anyone's to create. */
export const OrganizationTypeSchema = z.enum(["personal", "group"]);

export type OrganizationType = z.infer<typeof OrganizationTypeSchema>;

/**
 * A group organization's name: trimmed, then 1 to 100 characters. The
 * empty-name message is shown as is.
 */
export const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1, "Organization name is required")
  .max(ORGANIZATION_NAME_MAXIMUM_LENGTH);

/** `POST /api/v1/organizations`: creates a group organization with the caller as its admin. */
export const CreateOrganizationRequestSchema = z.object({ name: OrganizationNameSchema }).strict();

export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

/**
 * `PATCH /api/v1/organizations/:organizationId` as JSON: the name and,
 * optionally, `removeLogo: true`, which clears the logo in the same request.
 * A new logo travels as multipart instead (`ORGANIZATION_PART_NAMES`), never
 * here.
 */
export const ChangeOrganizationRequestSchema = z
  .object({ name: OrganizationNameSchema, removeLogo: z.literal(true).optional() })
  .strict();

export type ChangeOrganizationRequest = z.infer<typeof ChangeOrganizationRequestSchema>;

/**
 * A create or a change with a logo: multipart, the name then the file, in
 * this order, the file last.
 */
export const ORGANIZATION_PART_NAMES = ["name", "file"] as const;

/**
 * `logoId` names the organization's logo, null for none: the web builds
 * the image's address from the two ids,
 * `/api/v1/organization-logos/<id>/<logoId>`. Never a URL, never the type.
 */
export const OrganizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: OrganizationTypeSchema,
    logoId: z.string().uuid().nullable(),
  })
  .strict();

export type Organization = z.infer<typeof OrganizationSchema>;

/** The answer of creating and of renaming. */
export const OrganizationResponseSchema = z.object({ organization: OrganizationSchema }).strict();

export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

/**
 * An organization's settings: whether its public install links (Linux Quick
 * Deploy and Helm values links) are on, true by default.
 *
 *   GET   /api/v1/organizations/{organizationId}/settings   → OrganizationSettingsSchema (any member)
 *   PATCH /api/v1/organizations/{organizationId}/settings   OrganizationSettingsSchema → OrganizationSettingsSchema
 *         (an admin; `organization_admin_required` otherwise)
 */
export const OrganizationSettingsSchema = z.object({ publicInstallLinks: z.boolean() }).strict();

export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

/**
 * A member of the active organization, as the Permissions page lists them.
 * `isOrganizationOwner` marks the user whose personal organization this is:
 * their role can't be changed and they can't be removed. The timestamps are
 * ISO 8601; `deletedAt` is when the member was removed, and null for an
 * active member.
 */
export const MemberSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string(),
    role: OrganizationRoleSchema,
    isOrganizationOwner: z.boolean(),
    createdAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .strict();

export type Member = z.infer<typeof MemberSchema>;

/**
 * `GET /api/v1/organizations/:organizationId/members`: every member with a
 * live account, active and removed. Not paginated, so there is no
 * `nextCursor`.
 */
export const MembersResponseSchema = z.object({ items: z.array(MemberSchema) }).strict();

export type MembersResponse = z.infer<typeof MembersResponseSchema>;

/** `PATCH /api/v1/organizations/:organizationId/members/:userId`: either role. */
export const ChangeMemberRoleRequestSchema = z.object({ role: OrganizationRoleSchema }).strict();

export type ChangeMemberRoleRequest = z.infer<typeof ChangeMemberRoleRequestSchema>;

/**
 * The error codes of the organization endpoints and of switching, and of
 * invitations, named once so a misspelled code is a type error. A refusal's
 * message is what the web shows the user. `member_is_service_account` is the
 * `409` of a role change, a removal or a restoration naming a service account.
 * `organization_logo_type_unsupported` (415) and `organization_logo_too_large`
 * (413) refuse a create's or a change's logo before anything is written.
 * `organization_creation_restricted` (403) refuses a create while the site
 * lets only product admins create organizations.
 * `personal_organization_invitations_disabled` (403) refuses an invite or a
 * resend from a personal organization while registration isn't open.
 */
export const ORGANIZATION_ERROR_CODES = [
  "organization_not_found",
  "organization_name_taken",
  "organization_admin_required",
  "organization_access_denied",
  "cannot_change_own_membership",
  "member_not_found",
  "member_not_active",
  "member_not_removed",
  "personal_organization_protected",
  "member_already_active",
  "member_removed",
  "invitation_already_pending",
  "invitation_not_found",
  "invitation_email_failed",
  "invitation_expired",
  "invitation_already_accepted",
  "invitation_email_mismatch",
  "account_exists",
  "member_is_service_account",
  "organization_logo_type_unsupported",
  "organization_logo_too_large",
  "organization_creation_restricted",
  "personal_organization_invitations_disabled",
] as const;

export type OrganizationErrorCode = (typeof ORGANIZATION_ERROR_CODES)[number];

/** `organization_creation_restricted`'s fixed words: the web shows them too. */
export const ORGANIZATION_CREATION_RESTRICTED_MESSAGE = "Only product admins can create organizations on this site.";

/**
 * Whether an organization of `organizationType` may send invitations on a
 * site in registration mode `registration`: a group organization always; a
 * personal one only while registration is open. Under `invite-only` (and
 * `closed`) a person's own workspace invites no one: people join a site
 * through its organizations.
 */
export function mayInviteFrom(registration: RegistrationMode, organizationType: OrganizationType): boolean {
  return organizationType === "group" || registration === "open";
}

/** `personal_organization_invitations_disabled`'s fixed words: the web shows them in place of Invite Member. */
export const PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE =
  "Invitations can't be sent from a personal workspace on this site.";
