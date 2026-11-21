import { INVITATION_TTL_DAYS, type OrganizationType } from "@telflo/contracts";
import { escapeHtml } from "../identity/emails.js";
import { organizationInSentence } from "./organization-names.js";

/**
 * An invitation to join an organization. One message whether or not the
 * address has an account, since the accept page decides what to show. Plain
 * like the verification and reset emails, with no footer saying the reader has
 * a Telflo account, since an invitee may have none.
 *
 * A personal workspace named by its owner's email is "<email>'s
 * organization" in the subject and both bodies; any other name is itself.
 * The organization's name is an admin's free text, so it is escaped in the
 * HTML part. The caller puts the token in the link's fragment,
 * `/accept-invitation#token=…`, so it never reaches a server or its logs.
 */
export function buildInvitationEmail(input: {
  organizationName: string;
  organizationType: OrganizationType;
  acceptUrl: string;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const named = organizationInSentence(input.organizationName, input.organizationType);
  const safeName = escapeHtml(named);
  const safeUrl = escapeHtml(input.acceptUrl);
  const expiry = `This link expires in ${INVITATION_TTL_DAYS} days.`;
  const ignore = "If you weren't expecting this invitation, you can ignore this email.";
  return {
    subject: `You've been invited to join ${named} on Telflo`,
    text: [
      `You've been invited to join ${named} on Telflo, the visual OpenTelemetry pipeline builder.`,
      "",
      "Open this link to accept your invitation:",
      input.acceptUrl,
      "",
      expiry,
      "",
      ignore,
    ].join("\n"),
    html: [
      `<p>You've been invited to join ${safeName} on Telflo, the visual OpenTelemetry pipeline builder.</p>`,
      "<p>Open this link to accept your invitation:</p>",
      `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
      `<p>${expiry}</p>`,
      `<p>${ignore}</p>`,
    ].join("\n"),
  };
}
