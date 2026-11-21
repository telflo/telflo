import { EmailNotificationsSection } from "~/components/settings/EmailNotificationsSection.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/**
 * Settings › Notifications' switch: with TELFLO_EMAIL_NOTIFICATIONS off,
 * the open source's default, the page is a 404, as an unknown page is. The
 * preferences it shows stay in `/me` and their PATCH either way.
 */
export function loader() {
  notFoundUnless(siteSettings().emailNotifications);
  return null;
}

/** Settings › Notifications: the two email switches. */
export default function SettingsNotificationsRoute() {
  return <EmailNotificationsSection />;
}
