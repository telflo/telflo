import { EmailNotificationsSection } from "~/components/settings/EmailNotificationsSection.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/**
 * Settings › Notifications' switch (D36-1 decision 58, Q270): with
 * TELFLO_EMAIL_NOTIFICATIONS off, the open source's default, the page is a
 * 404, as an unknown page is (decision 31's way). The preferences it shows
 * stay in `/me` and their PATCH either way.
 */
export function loader() {
  notFoundUnless(siteSettings().emailNotifications);
  return null;
}

/** Settings › Notifications (D21 decisions 13 and 32): the two email switches. */
export default function SettingsNotificationsRoute() {
  return <EmailNotificationsSection />;
}
