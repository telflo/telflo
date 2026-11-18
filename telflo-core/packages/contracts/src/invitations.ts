import { z } from "zod";
import { RegisterRequestSchema } from "./identity.js";
import { OrganizationRoleSchema, OrganizationTypeSchema } from "./organizations.js";
import { ActiveOrganizationSchema } from "./sessions.js";
import { emailSchema } from "./shared.js";

/*
 * Organization invitations (D6). The error codes are in organizations.ts,
 * with the rest of the organization endpoints' codes: sessions.ts imports
 * organizations.ts, so this module, which imports sessions.ts, can't be
 * where organizations.ts reads them from.
 */

/**
 * How long an invitation link works, from its latest send (D6 decision 2).
 * A constant, as D3's reset lifetime is; the email states it.
 */
export const INVITATION_TTL_DAYS = 7;

/*
 * The invitee's refusals (D6 decision 9), which the API answers with and the
 * accept page shows without asking, from a preview's status or a missing
 * token. One source, so the page and the API can't drift apart.
 */

/** `invitation_not_found`: an unknown, revoked or superseded token, a deleted organization, or no token at all. */
export const INVITATION_NOT_FOUND_MESSAGE =
  "Invalid or expired invite link. Please ask your admin to resend the invitation.";

/** `invitation_expired`. */
export const INVITATION_EXPIRED_MESSAGE =
  "This invitation link has expired. Please ask your admin to resend the invitation.";

/** `invitation_already_accepted`. */
export const INVITATION_ALREADY_ACCEPTED_MESSAGE = "This invitation has already been accepted.";
/**
 * An invitation that can't make an account on this site (D36-1 decision 52:
 * a personal organization's, under invite-only): the registration's 403
 * `registration_not_open` and the accept page's notice alike. Nothing about
 * whether the address has an account.
 */
export const INVITATION_SIGN_IN_ONLY_MESSAGE =
  "This invitation can't create a new account. Sign in with an existing account to accept it.";

/** `invitation_email_mismatch`: names the invited address, which only it can accept (decision 3). */
export function invitationEmailMismatchMessage(email: string): string {
  return `This invitation was sent to ${email}. Sign in with that address to accept it.`;
}

/**
 * `POST /api/v1/organizations/:organizationId/invitations`. The address is
 * trimmed and lowercased, as registration's is. The role is admin or
 * contributor (D7 decision 2).
 */
export const CreateInvitationRequestSchema = z.object({ email: emailSchema, role: OrganizationRoleSchema }).strict();

export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

/**
 * A pending invitation, as the Invited tab lists it (decision 7).
 * `invitedAt` is when it was created; `expiresAt` moves with every resend.
 * `isExpired` is the API's comparison with its own clock, so the page never
 * decides it from the browser's. The timestamps are ISO 8601.
 */
export const InvitationSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    role: OrganizationRoleSchema,
    invitedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    isExpired: z.boolean(),
  })
  .strict();

export type Invitation = z.infer<typeof InvitationSchema>;

/** The answer of inviting and of resending. */
export const InvitationResponseSchema = z.object({ invitation: InvitationSchema }).strict();

export type InvitationResponse = z.infer<typeof InvitationResponseSchema>;

/**
 * `GET /api/v1/organizations/:organizationId/invitations`: pending ones,
 * expired included, newest first. Not paginated, as members aren't.
 */
export const InvitationsResponseSchema = z.object({ items: z.array(InvitationSchema) }).strict();

export type InvitationsResponse = z.infer<typeof InvitationsResponseSchema>;

/**
 * The link's token, bounded as the other emailed tokens are. It travels
 * only in a body, never a path or query, so it stays out of access logs.
 */
const InvitationTokenSchema = z.string().min(1).max(512);

/** `POST /api/v1/invitation-previews` and `POST /api/v1/invitation-acceptances`. */
export const InvitationTokenRequestSchema = z.object({ token: InvitationTokenSchema }).strict();

export type InvitationTokenRequest = z.infer<typeof InvitationTokenRequestSchema>;

/** A revoked or superseded invitation isn't a status: it is a 404 (decision 9). */
export const InvitationStatusSchema = z.enum(["pending", "expired", "accepted"]);

export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

/**
 * What the accept page shows. `hasAccount` says whether an account holds
 * the invited address, so the page offers sign-in or sign-up; only someone
 * holding the token learns it, and only about the address it was sent to.
 * `mayRegister` says whether this invitation can make a new account on this
 * site (D36-1 decisions 35 and 52): false under `closed`, and under
 * `invite-only` for an invitation from a personal organization; then the
 * page offers sign-in only. It reads the site's mode and the organization's
 * type, nothing about the address. `organizationType` lets the page name a
 * personal workspace called by its owner's email as "<email>'s
 * organization" (D36-1 Q264), as the invite dialog does.
 */
export const InvitationPreviewResponseSchema = z
  .object({
    invitation: z
      .object({
        organizationName: z.string(),
        organizationType: OrganizationTypeSchema,
        email: z.string(),
        role: OrganizationRoleSchema,
        status: InvitationStatusSchema,
        hasAccount: z.boolean(),
        mayRegister: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponseSchema>;

/**
 * `POST /api/v1/invitation-registrations`: registration's password and
 * terms rules, and the token in place of the address, which is the
 * invitation's.
 */
export const InvitationRegistrationRequestSchema = RegisterRequestSchema.pick({
  password: true,
  acceptedTermsVersion: true,
})
  .extend({ token: InvitationTokenSchema })
  .strict();

export type InvitationRegistrationRequest = z.infer<typeof InvitationRegistrationRequestSchema>;

/**
 * The answer of accepting and of registering from an invitation: the
 * organization joined, which the session now acts in, in the shape a switch
 * answers with.
 */
export const JoinedOrganizationResponseSchema = z.object({ organization: ActiveOrganizationSchema }).strict();

export type JoinedOrganizationResponse = z.infer<typeof JoinedOrganizationResponseSchema>;
