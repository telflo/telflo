import { cn } from "~/lib/utils.js";

/**
 * A link to the Terms of Service or the Privacy Policy from where the terms
 * are accepted (D2c Ruling 20): the site's TELFLO_TERMS_URL or
 * TELFLO_PRIVACY_URL (D36-1 decision 32), an https URL or a path on this
 * origin, as the settings' parser allows no other. It opens a new tab, so
 * the form or dialog isn't lost, with no opener and no referrer. It must
 * sit outside the checkbox's `<label>`, so following it never ticks the
 * box; the agreement names the checkbox with `aria-labelledby` instead.
 */
export function LegalDocumentLink({
  to,
  className,
  children,
}: {
  /** An `https://` URL or a path starting with `/` (the site's settings: contracts' SITE_URL_PATTERN). */
  to: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={to} target="_blank" rel="noopener noreferrer" className={cn("font-medium hover:underline", className)}>
      {children}
    </a>
  );
}
