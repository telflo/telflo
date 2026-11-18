import type { IdentityErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/**
 * Refuses consent to any terms but the current ones (D2c decision 6, Ruling
 * 18): a page showing older terms gets `terms_version_not_current` rather
 * than recording consent to terms that no longer apply. Registration and the
 * terms PUT share it, so they refuse alike. `current` is the site's Terms
 * version (settings' `site.terms.version`, TELFLO_TERMS_VERSION; D36-1
 * decision 29); a missing `version` is refused as an old one is. A site
 * that asks for no Terms (`current` is "", decision 32) has no version to
 * consent to, so every version is refused: registration doesn't call this
 * there (`siteAsksForTerms`), and the terms PUT answers 400.
 */
export function assertCurrentTermsVersion(version: string | undefined, current: string): void {
  if (current === "" || version !== current) {
    throw new AppError(
      "terms_version_not_current" satisfies IdentityErrorCode,
      "These terms are out of date. Reload the page to see the current terms.",
      400,
    );
  }
}

/** Whether the site asks for Terms acceptance: a Terms version is set (D36-1 decision 32). */
export function siteAsksForTerms(current: string): boolean {
  return current !== "";
}
