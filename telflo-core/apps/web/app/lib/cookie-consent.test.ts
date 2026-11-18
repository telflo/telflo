import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_CHANGED_EVENT, getConsentStatus, setConsentStatus } from "./cookie-consent.js";

describe("the stored cookie consent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is undecided until a choice is stored", () => {
    expect(getConsentStatus()).toBeNull();
  });

  it("keeps the choice under its key, and announces it with its event", () => {
    const listener = vi.fn();
    window.addEventListener(CONSENT_CHANGED_EVENT, listener);

    setConsentStatus("rejected");

    window.removeEventListener(CONSENT_CHANGED_EVENT, listener);
    expect(localStorage.getItem("telflo_cookie_consent")).toBe("rejected");
    expect(getConsentStatus()).toBe("rejected");
    expect(CONSENT_CHANGED_EVENT).toBe("telflo:cookie-consent-changed");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe("rejected");
  });
});
