import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "~/components/tour/tour-theme.css";
import type { OrganizationType } from "@telflo/contracts";
import { isNamedByEmail } from "~/lib/organization-names.js";

/* A one-step driver.js callout, shown the
 * first time someone lands in the app after joining an organization from an
 * invitation. The accept page goes to /app?joined_org=<organizationId>; the
 * signed-in layout consumes the parameter (removing it, so a refresh never
 * shows the callout again) and points this at the sidebar's organization
 * switcher. */

const SWITCHER_SELECTOR = '[data-tour-step="org-switcher"]';

/* driver.js renders the popover's title and description as HTML;
 * organization names are user-controlled, so they are escaped before they
 * are interpolated. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The callout's words; a personal workspace named by its owner's email is
 * "<email>'s organization" (lib/organization-names.ts' rule): "Welcome to
 * <email>'s organization", working in <strong><email>'s</strong>
 * organization, the invite dialog's bold. */
export function orgWelcomeMessage(
  orgName: string,
  orgType: OrganizationType,
): {
  title: string;
  description: string;
} {
  const safeName = escapeHtml(orgName);
  const byEmail = isNamedByEmail(orgName, orgType);
  return {
    title: byEmail ? `Welcome to ${safeName}'s organization` : `Welcome to the ${safeName} organization`,
    description:
      `Your account is now working in ${byEmail ? `<strong>${safeName}'s</strong> organization` : `<strong>${safeName}</strong>`} — its ` +
      "configurations, tests, and fleets are what you'll see everywhere in " +
      "the app. To change organizations, use this Org Switcher any time.",
  };
}

/** Where the accept page goes once the invitation is accepted. With no
 * organization (an acceptance that matched no invitation), a plain
 * /app landing with no callout. */
export function postAcceptRedirectUrl(orgId: string | null): string {
  return orgId ? `/app?joined_org=${encodeURIComponent(orgId)}` : "/app";
}

/** How long the sidebar gets to settle before the callout. */
export const ORG_WELCOME_TOUR_DELAY_MS = 600;

/** Shows the callout once the sidebar has settled. Safe to call
 * unconditionally: it does nothing if the switcher isn't in the page. */
export function startOrgWelcomeTour(orgName: string, orgType: OrganizationType): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    if (!document.querySelector(SWITCHER_SELECTOR)) return;
    const { title, description } = orgWelcomeMessage(orgName, orgType);
    driver({
      animate: true,
      smoothScroll: true,
      allowClose: true,
      overlayColor: "black",
      overlayOpacity: 0.5,
      stagePadding: 8,
      stageRadius: 8,
      showProgress: false,
      popoverClass: "tour-popover",
      doneBtnText: "Got it",
      steps: [
        {
          element: SWITCHER_SELECTOR,
          popover: { title, description, side: "right", align: "end" },
        },
      ],
    }).drive();
  }, ORG_WELCOME_TOUR_DELAY_MS);
}
