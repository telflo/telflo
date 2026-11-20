import type { OrganizationType } from "@telflo/contracts";

/*
 * How the invitation email names the organization: a new personal workspace is
 * named by its owner's email (personalOrganizationName), and "join
 * someone@example.com on Telflo" reads as joining a person, so a personal
 * workspace whose name is an email address is said as "<email>'s
 * organization". Any other name, a group's or a renamed workspace's, is
 * itself. The web's copy of the rule is apps/web's lib/organization-names.ts;
 * both use the invite dialog's address pattern.
 */

function isEmailAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** The organization as a sentence names it on its own: `<email>'s organization`, or the name. */
export function organizationInSentence(name: string, type: OrganizationType): string {
  return type === "personal" && isEmailAddress(name) ? `${name}'s organization` : name;
}
