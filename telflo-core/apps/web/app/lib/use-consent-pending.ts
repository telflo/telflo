import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";
import { CONSENT_CHANGED_EVENT, getConsentStatus } from "./cookie-consent.js";

/**
 * Whether the cookie consent banner is (or is about to be) on screen: the
 * server configured analytics (root's loader, which then renders the
 * banner) and no choice is stored yet, until one is made. A modal opened
 * meanwhile would cover the banner, which is modal too, and leave neither
 * answerable, so the playground's and the public editor's welcome dialogs
 * wait for it (D31-1, Ruling 301). With no analytics configured it is
 * false at once: nothing waits.
 *
 * Until the stored choice is read (in an effect, as the banner reads it)
 * it answers true, so nothing opens before the banner could.
 */
export function useConsentPending(): boolean {
  const analytics = (useRouteLoaderData("root") as { analytics?: unknown } | undefined)?.analytics ?? null;
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (analytics === null) return;
    setChosen(getConsentStatus() !== null);
    const answered = () => setChosen(true);
    window.addEventListener(CONSENT_CHANGED_EVENT, answered);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, answered);
  }, [analytics]);
  return analytics !== null && chosen !== true;
}
