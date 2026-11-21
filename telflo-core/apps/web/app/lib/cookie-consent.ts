// The cookie choice: kept in localStorage under its key, and a change is
// announced with its event, which lib/analytics.ts and the consent
// components listen for.
const CONSENT_KEY = "telflo_cookie_consent";
export const CONSENT_CHANGED_EVENT = "telflo:cookie-consent-changed";

export type ConsentStatus = "accepted" | "rejected" | null;

export function getConsentStatus(): ConsentStatus {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CONSENT_KEY) as ConsentStatus;
}

export function setConsentStatus(status: "accepted" | "rejected"): void {
  localStorage.setItem(CONSENT_KEY, status);
  window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: status }));
}
