import type { OrganizationType } from "@telflo/contracts";

/*
 * How a sentence names an organization (D36-1 Q262, Q264; spec decision
 * 55). A new personal workspace is named by its owner's email (Q263), and
 * "Join someone@example.com" reads as joining a person, so a personal
 * workspace whose name is an email address is said as "<email>'s
 * organization". Any other name, a group's or a renamed workspace's, is
 * itself. One rule for the invite dialog, the invitation page, the welcome
 * callout and the product admin's delete dialog; the API's mail has its
 * own copy (apps/api's organizations/organization-names.ts).
 *
 * The name stays visible text only, where each caller already showed it:
 * never an attribute, a title, a toast or an analytics property.
 */

/** An address pattern, as the invite dialog checks the addresses typed. */
export function isEmailAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** A personal workspace under its default name, its owner's email address (Q263). */
export function isNamedByEmail(name: string, type: OrganizationType): boolean {
  return type === "personal" && isEmailAddress(name);
}

/**
 * The words that stand before "organization" in "the … organization" (the
 * invite dialog, Q262): `<email>'s` for a personal workspace named by its
 * email, else the name.
 */
export function organizationLabel(name: string, type: OrganizationType): string {
  return isNamedByEmail(name, type) ? `${name}'s` : name;
}

/**
 * The organization as a sentence names it on its own, "Join … on Telflo"
 * (Q264): `<email>'s organization` for a personal workspace named by its
 * email, else the name.
 */
export function organizationInSentence(name: string, type: OrganizationType): string {
  return isNamedByEmail(name, type) ? `${name}'s organization` : name;
}
