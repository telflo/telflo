import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { setConsentStatus } from "~/lib/cookie-consent.js";
import { QUICK_DEPLOY_SECRET } from "~/test/fleets.js";
import { buildApiToken, TOKEN_START } from "~/test/service-accounts.js";
import { mockPostHog, settle, type PostHogMock } from "~/test/posthog.js";
import type { CaptureResult } from "posthog-js";
import type { AnalyticsSettings } from "./analytics.js";

// posthog-js is mocked at its module boundary, with a fresh analytics module
// for every test (test/posthog.ts). The page is on a public host unless a
// test says otherwise: replay never starts on a local one.

const SETTINGS: AnalyticsSettings = { key: "phc_test", host: null };
const USER = { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" };

let posthog: PostHogMock;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  posthog = mockPostHog();
  vi.stubGlobal("location", new URL("https://telflo.example/pricing"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh analytics module, and root's effect started with `settings`. */
async function start(settings: AnalyticsSettings = SETTINGS) {
  const analytics = await import("./analytics.js");
  renderHook(() => analytics.useAnalytics(settings));
  await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
  await settle();
  return analytics;
}

/** The visitor's choice, made as the banner makes it. */
async function choose(status: "accepted" | "rejected") {
  act(() => setConsentStatus(status));
  await settle();
}

describe("without the setting", () => {
  it("never imports posthog-js, whatever else is called", async () => {
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(null));
    analytics.identifyUser(USER.id, USER.email);
    analytics.captureEvent("user_signed_up", { method: "email" });
    analytics.signedOutLocally();
    await choose("accepted");

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
  });
});

describe("starting", () => {
  it("initializes posthog-js cookieless on reject, and with no replay", async () => {
    const { stripTokens } = await start();

    expect(posthog.imported).toHaveBeenCalledTimes(1);
    expect(posthog.client.init).toHaveBeenCalledWith("phc_test", {
      defaults: "2026-01-30",
      cookieless_mode: "on_reject",
      disable_session_recording: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: ".ph-mask, .ph-mask *",
        recordBody: false,
        recordHeaders: false,
        maskCapturedNetworkRequestFn: expect.any(Function),
      },
      enable_recording_console_log: false,
      mask_personal_data_properties: true,
      custom_personal_data_properties: ["token", "q"],
      before_send: stripTokens,
      mask_all_text: false,
      mask_all_element_attributes: false,
    });
  });

  it("pins replay's masking and turns off network and console capture, whatever PostHog's project says", async () => {
    await start();
    const options = posthog.client.init.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(options.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: ".ph-mask, .ph-mask *",
      recordBody: false,
      recordHeaders: false,
    });
    expect(options.enable_recording_console_log).toBe(false);
  });

  it("points it at TELFLO_POSTHOG_HOST when there is one", async () => {
    await start({ key: "phc_test", host: "https://eu.i.posthog.com" });

    expect(posthog.client.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
  });

  it("initializes once, however often it is started", async () => {
    const analytics = await start();
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await settle();

    expect(posthog.imported).toHaveBeenCalledTimes(1);
    expect(posthog.client.init).toHaveBeenCalledTimes(1);
  });
});

describe("before the visitor chooses", () => {
  it("never opts in and never starts replay", async () => {
    await start();

    expect(posthog.client.clear_opt_in_out_capturing).toHaveBeenCalled();
    expect(posthog.client.stopSessionRecording).toHaveBeenCalled();
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.client.startSessionRecording).not.toHaveBeenCalled();
  });
});

describe("accepting", () => {
  it("opts in to capture and starts session replay", async () => {
    await start();
    await choose("accepted");

    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("applies a choice made on an earlier visit when it starts", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    await start();

    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.client.clear_opt_in_out_capturing).not.toHaveBeenCalled();
  });

  it.each(["localhost", "127.0.0.1", "[::1]", "telflo.test"])(
    "opts in, but never starts replay, on %s",
    async (hostname) => {
      vi.stubGlobal("location", new URL(`https://${hostname}/pricing`));
      await start();
      await choose("accepted");

      expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
      expect(posthog.client.startSessionRecording).not.toHaveBeenCalled();
    },
  );
});

describe("rejecting", () => {
  it("captures nothing: clears the opt-in and keeps replay stopped", async () => {
    await start();
    await choose("rejected");

    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.client.startSessionRecording).not.toHaveBeenCalled();
    expect(posthog.client.clear_opt_in_out_capturing).toHaveBeenCalledTimes(2);
  });

  it("after accepting, clears the opt-in and stops replay", async () => {
    await start();
    await choose("accepted");
    posthog.client.clear_opt_in_out_capturing.mockClear();
    posthog.client.stopSessionRecording.mockClear();

    await choose("rejected");

    expect(posthog.client.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("removes PostHog's session storage, which outlives the cleared opt-in", async () => {
    sessionStorage.setItem("ph_phc_test_window_id", "a-window");
    sessionStorage.setItem("ph_phc_test_primary_window_exists", "true");
    sessionStorage.setItem("telflo.resetPasswordToken", "kept");
    await start();
    await choose("accepted");

    await choose("rejected");

    expect(sessionStorage.getItem("ph_phc_test_window_id")).toBeNull();
    expect(sessionStorage.getItem("ph_phc_test_primary_window_exists")).toBeNull();
    expect(sessionStorage.getItem("telflo.resetPasswordToken")).toBe("kept");
  });

  it("stops listening when root's effect is cleaned up", async () => {
    const analytics = await import("./analytics.js");
    const { unmount } = renderHook(() => analytics.useAnalytics(SETTINGS));
    await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
    unmount();
    await choose("accepted");

    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
  });
});

describe("identifying the signed-in user", () => {
  it("never identifies before the visitor chooses", async () => {
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    expect(posthog.client.identify).not.toHaveBeenCalled();
  });

  it("never identifies after a rejection", async () => {
    const analytics = await start();
    await choose("rejected");
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    expect(posthog.client.identify).not.toHaveBeenCalled();
  });

  it("identifies once the signed-in visitor accepts, and only once", async () => {
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    await choose("accepted");
    await choose("accepted");
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledWith(USER.id, { email: USER.email });
  });

  it("identifies again when the visitor accepts, rejects and accepts again: rejecting drops PostHog's storage", async () => {
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await choose("accepted");
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);

    await choose("rejected");
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);

    await choose("accepted");
    expect(posthog.client.identify).toHaveBeenCalledTimes(2);
    expect(posthog.client.identify).toHaveBeenLastCalledWith(USER.id, { email: USER.email });
  });

  it("identifies at sign-in when the visitor has already accepted", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledWith(USER.id, { email: USER.email });
  });

  it("waits for the init when the layout identifies before root has started it", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await import("./analytics.js");
    analytics.identifyUser(USER.id, USER.email);
    await settle();
    expect(posthog.imported).not.toHaveBeenCalled();

    renderHook(() => analytics.useAnalytics(SETTINGS));
    await vi.waitFor(() => expect(posthog.client.identify).toHaveBeenCalledTimes(1));
    expect(posthog.client.init.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.identify.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never identifies a user who signed out before the client was ready", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await import("./analytics.js");
    analytics.identifyUser(USER.id, USER.email);
    analytics.signedOutLocally();

    renderHook(() => analytics.useAnalytics(SETTINGS));
    await vi.waitFor(() => expect(posthog.client.reset).toHaveBeenCalledTimes(1));
    await settle();

    expect(posthog.client.identify).not.toHaveBeenCalled();
  });
});

describe("signing out", () => {
  it("resets PostHog with a new device id, and identifies whoever signs in next afresh", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await settle();

    analytics.signedOutLocally();
    await settle();
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset).toHaveBeenCalledWith(true);

    analytics.identifyUser("00000000-0000-4000-8000-000000000009", "next@example.com");
    await settle();
    expect(posthog.client.identify).toHaveBeenCalledTimes(2);
    expect(posthog.client.identify).toHaveBeenLastCalledWith("00000000-0000-4000-8000-000000000009", {
      email: "next@example.com",
    });
  });

  it("applies the stored acceptance again after the reset, which forgets the opt-in", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await start();
    posthog.client.opt_in_capturing.mockClear();
    posthog.client.startSessionRecording.mockClear();

    analytics.signedOutLocally();
    await settle();

    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.opt_in_capturing.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([["rejected"], ["not yet chosen"]])("with consent %s, captures nothing after the reset", async (choice) => {
    if (choice === "rejected") localStorage.setItem("telflo_cookie_consent", "rejected");
    const analytics = await start();
    posthog.client.clear_opt_in_out_capturing.mockClear();

    analytics.signedOutLocally();
    await settle();

    expect(posthog.client.reset).toHaveBeenCalledWith(true);
    expect(posthog.client.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("resets once, right after the init, however many sign-outs came before PostHog started", async () => {
    localStorage.setItem("telflo_cookie_consent", "accepted");
    const analytics = await import("./analytics.js");
    analytics.signedOutLocally();
    analytics.signedOutLocally();
    analytics.signedOutLocally();

    renderHook(() => analytics.useAnalytics(SETTINGS));
    await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
    await settle();

    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset).toHaveBeenCalledWith(true);
    // The stored acceptance is applied after the reset, which forgets it.
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.opt_in_capturing.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("identifies a user who signs in after an accept that follows the sign-out", async () => {
    const analytics = await start();
    analytics.identifyUser(USER.id, USER.email);
    await choose("accepted");
    analytics.signedOutLocally();
    await choose("rejected");

    analytics.identifyUser(USER.id, USER.email);
    await choose("accepted");

    expect(posthog.client.identify).toHaveBeenCalledTimes(2);
  });
});

describe("no emailed link's token reaches PostHog", () => {
  it("drops the fragment and any token parameter from a URL, and keeps the rest", async () => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens("https://telflo.example/reset-password#token=secret")).toBe("https://telflo.example/reset-password");
    expect(withoutTokens("https://telflo.example/verify-email?token=secret")).toBe("https://telflo.example/verify-email");
    expect(withoutTokens("https://telflo.example/verify-email?utm_source=mail&token=secret&x=1#top")).toBe(
      "https://telflo.example/verify-email?utm_source=mail&x=1",
    );
    expect(withoutTokens("https://telflo.example/verify-email?Token=secret")).toBe("https://telflo.example/verify-email");
    expect(withoutTokens("https://telflo.example/verify-email?%74oken=secret")).toBe("https://telflo.example/verify-email");
    expect(withoutTokens("https://telflo.example/verify-email?token=<MASKED>")).toBe("https://telflo.example/verify-email");
    expect(withoutTokens("https://telflo.example/pricing?tokens=kept")).toBe("https://telflo.example/pricing?tokens=kept");
    expect(withoutTokens("$direct")).toBe("$direct");
    expect(withoutTokens("/app/flows")).toBe("/app/flows");
  });

  it("before_send cleans every URL property, in the event and in its $set and $set_once", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000000",
      event: "$pageview",
      properties: {
        $current_url: "https://telflo.example/reset-password#token=secret",
        $referrer: "https://telflo.example/verify-email?token=secret",
        $initial_current_url: "https://telflo.example/accept-invitation#token=secret",
        $session_entry_url: "https://telflo.example/verify-email?token=secret&x=1",
        $pathname: "/reset-password",
        title: "Reset Password - Telflo #token=not-a-url-property",
        $set: { $current_url: "https://telflo.example/verify-email?token=secret" },
      },
      $set: { $current_url: "https://telflo.example/reset-password#token=secret" },
      $set_once: {
        $initial_current_url: "https://telflo.example/verify-email?token=secret",
        $initial_referrer: "https://mail.example/?token=secret",
        $initial_pathname: "/verify-email",
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned).toEqual({
      ...event,
      properties: {
        $current_url: "https://telflo.example/reset-password",
        $referrer: "https://telflo.example/verify-email",
        $initial_current_url: "https://telflo.example/accept-invitation",
        $session_entry_url: "https://telflo.example/verify-email?x=1",
        $pathname: "/reset-password",
        title: "Reset Password - Telflo #token=not-a-url-property",
        $set: { $current_url: "https://telflo.example/verify-email" },
      },
      $set: { $current_url: "https://telflo.example/reset-password" },
      $set_once: {
        $initial_current_url: "https://telflo.example/verify-email",
        $initial_referrer: "https://mail.example/",
        $initial_pathname: "/verify-email",
      },
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/token=secret/);
  });

  it("before_send cleans the page's address in a recording: the Meta event, and PostHog's own url events", async () => {
    const { stripTokens } = await import("./analytics.js");
    const fullSnapshot = { type: 2, data: { node: { id: 1 } }, timestamp: 2 };
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000001",
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: "https://telflo.example/reset-password#token=secret", width: 800, height: 600 }, timestamp: 1 },
          fullSnapshot,
          { type: 5, data: { tag: "$url_changed", payload: { href: "https://telflo.example/verify-email?token=secret" } }, timestamp: 3 },
        ],
        $session_id: "a-session",
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties.$snapshot_data).toEqual([
      { type: 4, data: { href: "https://telflo.example/reset-password", width: 800, height: 600 }, timestamp: 1 },
      fullSnapshot,
      { type: 5, data: { tag: "$url_changed", payload: { href: "https://telflo.example/verify-email" } }, timestamp: 3 },
    ]);
    expect(cleaned?.properties.$session_id).toBe("a-session");
  });

  it("before_send cleans nested events' URLs, and heatmap data keyed by URL", async () => {
    const { stripTokens } = await import("./analytics.js");
    const point = { x: 10, y: 20, target_fixed: false, type: "click" };
    const later = { x: 30, y: 40, target_fixed: false, type: "click" };
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000002",
      event: "$$heatmap",
      properties: {
        $heatmap_data: {
          "https://telflo.example/reset-password#token=secret": [point],
          "https://telflo.example/reset-password": [later],
          "https://telflo.example/verify-email?token=<MASKED>&x=1": [point],
        },
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1200,
          $current_url: "https://telflo.example/verify-email?token=secret",
          nested: { $referrer: "https://telflo.example/reset-password#token=secret" },
        },
        $web_vitals_LCP_value: 1200,
        $elements: [{ tag_name: "a", attr__href: "#top" }],
        created: new Date(0),
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties.$heatmap_data).toEqual({
      "https://telflo.example/reset-password": [point, later],
      "https://telflo.example/verify-email?x=1": [point],
    });
    expect(cleaned?.properties.$web_vitals_LCP_event).toEqual({
      name: "LCP",
      value: 1200,
      $current_url: "https://telflo.example/verify-email",
      nested: { $referrer: "https://telflo.example/reset-password" },
    });
    // Arrays and anything that isn't a plain object are left as they are.
    expect(cleaned?.properties.$elements).toEqual([{ tag_name: "a", attr__href: "#top" }]);
    expect(cleaned?.properties.created).toEqual(new Date(0));
    expect(cleaned?.properties.$web_vitals_LCP_value).toBe(1200);
    expect(JSON.stringify(cleaned)).not.toMatch(/token=(secret|<MASKED>)/);
  });

  it("before_send passes a dropped event on as dropped", async () => {
    const { stripTokens } = await import("./analytics.js");
    expect(stripTokens(null)).toBeNull();
  });

  it("replay's recorded requests, and the addresses it adds itself, lose their tokens too", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;

    const request = { name: "https://telflo.example/verify-email?token=secret", entryType: "resource", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: "https://telflo.example/verify-email" });
  });

  it.each([
    ["an absolute", "https://telflo.example/api/v1/organizations/x/configurations?q=secret&filter=mine#part"],
    ["a relative", "/api/v1/organizations/x/configurations?q=secret&filter=mine"],
    ["a path-prefixed", "https://host/telflo/api/v1/organizations/x/configurations?q=secret"],
  ])("replay's recorded requests to the API lose their whole query, for %s URL", async (_kind, url) => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: url, entryType: "resource", startTime: 1, duration: 2 };

    const masked = mask?.(request);

    expect(masked).toEqual({ ...request, name: url.split("?")[0] });
    expect(JSON.stringify(masked)).not.toMatch(/secret|mine|part/);
  });

  it("replay's recorded requests outside the API keep their other parameters, as before", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: "https://telflo.example/verify-email?token=secret&a=1", entryType: "resource", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: "https://telflo.example/verify-email?a=1" });
  });

  it("replay treats a request as the API's by its path, not by /api/ in its query", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = {
      name: "https://telflo.example/login?next=/api/v1/organizations&token=secret&a=1",
      entryType: "resource",
      startTime: 1,
      duration: 2,
    };

    expect(mask?.(request)).toEqual({ ...request, name: "https://telflo.example/login?next=/api/v1/organizations&a=1" });
  });
});

describe("the flows library's search never reaches PostHog", () => {
  const LIBRARY = "https://telflo.example/flows";

  it("drops q from the library's address, absolute or relative, and keeps its chips and every other parameter", async () => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens(`${LIBRARY}?q=secret`)).toBe(LIBRARY);
    expect(withoutTokens(`${LIBRARY}?signals=traces&q=secret&tags=migration`)).toBe(`${LIBRARY}?signals=traces&tags=migration`);
    expect(withoutTokens(`${LIBRARY}?q=secret&token=secret#top`)).toBe(LIBRARY);
    expect(withoutTokens("/flows?q=secret&signals=logs")).toBe("/flows?signals=logs");
    // As React Router matches the path: a trailing slash, any case, percent-encoded.
    expect(withoutTokens("https://telflo.example/flows/?q=secret")).toBe("https://telflo.example/flows/");
    expect(withoutTokens("https://telflo.example/FLOWS?q=secret")).toBe("https://telflo.example/FLOWS");
    expect(withoutTokens("https://telflo.example/fl%6Fws?q=secret")).toBe("https://telflo.example/fl%6Fws");
    // The parameter however it is spelled.
    expect(withoutTokens(`${LIBRARY}?Q=secret`)).toBe(LIBRARY);
    expect(withoutTokens(`${LIBRARY}?%71=secret`)).toBe(LIBRARY);
    expect(withoutTokens(`${LIBRARY}?q`)).toBe(LIBRARY);
    expect(withoutTokens(`${LIBRARY}?qq=kept&query=kept`)).toBe(`${LIBRARY}?qq=kept&query=kept`);
  });

  it("keeps q anywhere else: only the library's search is the visitor's typing", async () => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens("https://telflo.example/pricing?q=kept")).toBe("https://telflo.example/pricing?q=kept");
    expect(withoutTokens("https://telflo.example/flows/pii-redaction-gateway?q=kept")).toBe(
      "https://telflo.example/flows/pii-redaction-gateway?q=kept",
    );
    expect(withoutTokens("https://telflo.example/app/flows?q=kept")).toBe("https://telflo.example/app/flows?q=kept");
    expect(withoutTokens("https://search.example/?q=kept")).toBe("https://search.example/?q=kept");
    expect(withoutTokens("$direct")).toBe("$direct");
  });

  it("before_send drops it from every URL property: the event's, its $set and $set_once, and the referrers", async () => {
    const { stripTokens } = await import("./analytics.js");
    const searched = `${LIBRARY}?q=secret&signals=traces`;
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000020",
      event: "$pageview",
      properties: {
        $current_url: searched,
        $referrer: searched,
        $initial_referrer: searched,
        $initial_current_url: searched,
        $session_entry_url: searched,
        $session_entry_referrer: searched,
        $prev_pageview_url: searched,
        $pathname: "/flows?q=secret",
        $referring_domain: "telflo.example",
        title: "Flows - Telflo",
        $set: { $current_url: searched, $referrer: searched },
        $set_once: { $initial_referrer: searched },
      },
      $set: { $current_url: searched, $referrer: searched },
      $set_once: {
        $initial_current_url: searched,
        $initial_referrer: searched,
        $initial_pathname: "/flows",
        $session_entry_referrer: searched,
      },
    };

    const cleaned = stripTokens(event);

    const kept = `${LIBRARY}?signals=traces`;
    expect(cleaned).toEqual({
      ...event,
      properties: {
        $current_url: kept,
        $referrer: kept,
        $initial_referrer: kept,
        $initial_current_url: kept,
        $session_entry_url: kept,
        $session_entry_referrer: kept,
        $prev_pageview_url: kept,
        $pathname: "/flows",
        $referring_domain: "telflo.example",
        title: "Flows - Telflo",
        $set: { $current_url: kept, $referrer: kept },
        $set_once: { $initial_referrer: kept },
      },
      $set: { $current_url: kept, $referrer: kept },
      $set_once: {
        $initial_current_url: kept,
        $initial_referrer: kept,
        $initial_pathname: "/flows",
        $session_entry_referrer: kept,
      },
    });
    expect(JSON.stringify(cleaned)).not.toContain("secret");
  });

  it("before_send drops it from heatmap data keyed by the library's address, and from nested events", async () => {
    const { stripTokens } = await import("./analytics.js");
    const point = { x: 1, y: 2, target_fixed: false, type: "click" };
    const later = { x: 3, y: 4, target_fixed: false, type: "click" };
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000021",
      event: "$$heatmap",
      properties: {
        $heatmap_data: { [`${LIBRARY}?q=secret`]: [point], [`${LIBRARY}?q=other`]: [later] },
        $web_vitals_LCP_event: { name: "LCP", $current_url: `${LIBRARY}?q=secret` },
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties.$heatmap_data).toEqual({ [LIBRARY]: [point, later] });
    expect(cleaned?.properties.$web_vitals_LCP_event).toEqual({ name: "LCP", $current_url: LIBRARY });
    expect(JSON.stringify(cleaned)).not.toMatch(/secret|other/);
  });

  it.each([
    ["the Meta event", { type: 4, data: { href: `${LIBRARY}?q=secret&tags=migration`, width: 800, height: 600 }, timestamp: 1 }],
    ["PostHog's $url_changed", { type: 5, data: { tag: "$url_changed", payload: { href: `${LIBRARY}?q=secret&tags=migration` } }, timestamp: 2 }],
    ["PostHog's $pageview", { type: 5, data: { tag: "$pageview", payload: { href: `${LIBRARY}?q=secret&tags=migration` } }, timestamp: 3 }],
  ])("before_send drops it from replay's page address in %s", async (_kind, recorded) => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000022",
      event: "$snapshot",
      properties: { $snapshot_data: [recorded], $session_id: "a-session" },
    };

    const cleaned = stripTokens(event);

    const [only] = cleaned?.properties.$snapshot_data as { data: { href?: string; payload?: { href: string } } }[];
    expect(only?.data.href ?? only?.data.payload?.href).toBe(`${LIBRARY}?tags=migration`);
    expect(JSON.stringify(cleaned)).not.toContain("secret");
  });

  it("replay's recorded requests to the library's address lose q, and keep the chips", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: `${LIBRARY}?q=secret&signals=traces`, entryType: "navigation", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: `${LIBRARY}?signals=traces` });
  });
});

describe("a quick-deploy link's secret never reaches PostHog", () => {
  const ORIGIN = "https://telflo.example";
  const BODY = QUICK_DEPLOY_SECRET.slice("tqd_".length);
  const REDACTED = `${ORIGIN}/quick-deploy/[redacted]`;
  // A link typed without /api/: behind the gateway nginx's own 404, on the dev server root's ErrorBoundary
  // (PostHog never imported); the check is the backstop for a page whose address is the link anyway.
  const TYPED = `${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}`;

  it.each([
    ["typed without /api/", TYPED],
    ["the link itself", `${ORIGIN}/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}`],
    ["with a query and a fragment", `${ORIGIN}/QUICK-DEPLOY/${QUICK_DEPLOY_SECRET}?x=1#top`],
    ["with a trailing slash", `${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}/`],
    ["the prefix's t encoded", `${ORIGIN}/x/%74qd_${BODY}`],
    ["the prefix's q encoded", `${ORIGIN}/x/t%71d_${BODY}`],
    ["the prefix's d encoded", `${ORIGIN}/x/tq%64_${BODY}`],
    ["the prefix's _ encoded", `${ORIGIN}/x/tqd%5F${BODY}`],
    ["the prefix in upper case, encoded", `${ORIGIN}/x/%54%51%44_${BODY}`],
    ["the prefix encoded twice", `${ORIGIN}/x/%2574qd_${BODY}`],
    ["the prefix in another page's query", `${ORIGIN}/pricing?s=${QUICK_DEPLOY_SECRET}`],
    ["the prefix encoded in another page's query", `${ORIGIN}/pricing?s=t%71d_${BODY}`],
    ["the segment without the prefix", `${ORIGIN}/quick-deploy/${BODY}`],
    ["the segment's slashes doubled", `${ORIGIN}//quick-deploy//${BODY}`],
    ["the segment behind a dot segment", `${ORIGIN}/x/../quick-deploy/${BODY}`],
    ["the segment's letter encoded", `${ORIGIN}/%71uick-deploy/${BODY}`],
    ["the segment's slash encoded", `${ORIGIN}/quick-deploy%2F${BODY}`],
    ["the segment alone", `${ORIGIN}/quick-deploy`],
  ])("replaces a URL holding it whole, keeping only the origin: %s", async (_kind, url) => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens(url)).toBe(REDACTED);
  });

  it("replaces a path holding it, or anything else that isn't a URL, by the fixed path", async () => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens(`/quick-deploy/${QUICK_DEPLOY_SECRET}`)).toBe("/quick-deploy/[redacted]");
    expect(withoutTokens(`/api/v1/quick-deploy/%74qd_${BODY}?x=1`)).toBe("/quick-deploy/[redacted]");
    expect(withoutTokens(`quick-deploy/${QUICK_DEPLOY_SECRET}`)).toBe("/quick-deploy/[redacted]");
    expect(withoutTokens(`android-app://tqd_${BODY}`)).toBe("/quick-deploy/[redacted]");
  });

  it("leaves every other URL as it was: the links' own routes, a lookalike, and pages without the prefix", async () => {
    const { withoutTokens } = await import("./analytics.js");

    for (const url of [
      `${ORIGIN}/app/fleets/f1`,
      `${ORIGIN}/api/v1/organizations/o1/fleets/f1/quick-deploy-links?limit=5`,
      `/api/v1/organizations/o1/fleets/f1/groups/g1/quick-deploy-links`,
      `${ORIGIN}/docs/quick-deployment`,
      `${ORIGIN}/pricing?q=tqd&x=tq_d`,
      `${ORIGIN}/pricing?x=%74qd`,
      "https://search.example/?q=quick-deploy",
      "/app/flows",
      "$direct",
    ]) {
      expect(withoutTokens(url)).toBe(url);
    }
  });

  it("before_send cleans every URL property: the event's, its $set and $set_once, the referrers and the paths", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000030",
      event: "$pageview",
      properties: {
        $current_url: TYPED,
        $pathname: `/quick-deploy/${QUICK_DEPLOY_SECRET}`,
        $referrer: `${ORIGIN}/api/v1/quick-deploy/t%71d_${BODY}`,
        $initial_referrer: TYPED,
        $initial_current_url: TYPED,
        $session_entry_url: TYPED,
        $session_entry_pathname: `/quick-deploy/${QUICK_DEPLOY_SECRET}`,
        $prev_pageview_url: TYPED,
        $prev_pageview_pathname: `/%74qd_${BODY}`,
        $referring_domain: "telflo.example",
        title: "Page not found - Telflo",
        $set: { $current_url: TYPED, $pathname: `/quick-deploy/${QUICK_DEPLOY_SECRET}` },
      },
      $set: { $current_url: TYPED, $referrer: TYPED },
      $set_once: { $initial_current_url: TYPED, $initial_referrer: TYPED, $initial_pathname: `/quick-deploy/${QUICK_DEPLOY_SECRET}` },
    };

    const cleaned = stripTokens(event);

    const path = "/quick-deploy/[redacted]";
    expect(cleaned).toEqual({
      ...event,
      properties: {
        $current_url: REDACTED,
        $pathname: path,
        $referrer: REDACTED,
        $initial_referrer: REDACTED,
        $initial_current_url: REDACTED,
        $session_entry_url: REDACTED,
        $session_entry_pathname: path,
        $prev_pageview_url: REDACTED,
        $prev_pageview_pathname: path,
        $referring_domain: "telflo.example",
        title: "Page not found - Telflo",
        $set: { $current_url: REDACTED, $pathname: path },
      },
      $set: { $current_url: REDACTED, $referrer: REDACTED },
      $set_once: { $initial_current_url: REDACTED, $initial_referrer: REDACTED, $initial_pathname: path },
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send cleans heatmap data keyed by the link, nested events, and replay's page addresses", async () => {
    const { stripTokens } = await import("./analytics.js");
    const point = { x: 1, y: 2, target_fixed: false, type: "click" };
    const heatmap: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000031",
      event: "$$heatmap",
      properties: {
        $heatmap_data: { [TYPED]: [point] },
        $web_vitals_LCP_event: { name: "LCP", $current_url: TYPED },
      },
    };
    const snapshot: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000032",
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: TYPED, width: 800, height: 600 }, timestamp: 1 },
          { type: 5, data: { tag: "$url_changed", payload: { href: TYPED } }, timestamp: 2 },
          { type: 5, data: { tag: "$pageview", payload: { href: TYPED } }, timestamp: 3 },
        ],
        $session_id: "a-session",
      },
    };

    const cleanedHeatmap = stripTokens(heatmap);
    const cleanedSnapshot = stripTokens(snapshot);

    expect(cleanedHeatmap?.properties.$heatmap_data).toEqual({ [REDACTED]: [point] });
    expect(cleanedHeatmap?.properties.$web_vitals_LCP_event).toEqual({ name: "LCP", $current_url: REDACTED });
    expect(cleanedSnapshot?.properties.$snapshot_data).toEqual([
      { type: 4, data: { href: REDACTED, width: 800, height: 600 }, timestamp: 1 },
      { type: 5, data: { tag: "$url_changed", payload: { href: REDACTED } }, timestamp: 2 },
      { type: 5, data: { tag: "$pageview", payload: { href: REDACTED } }, timestamp: 3 },
    ]);
    expect(JSON.stringify([cleanedHeatmap, cleanedSnapshot])).not.toContain(BODY);
  });

  it("before_send leaves an ordinary event as it was", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000033",
      event: "$pageview",
      properties: {
        $current_url: `${ORIGIN}/app/fleets/f1?tab=groups`,
        $pathname: "/app/fleets/f1",
        $referrer: `${ORIGIN}/app/fleets`,
        $set: { $current_url: `${ORIGIN}/app/fleets/f1?tab=groups` },
      },
      $set_once: { $initial_pathname: "/app" },
    };

    expect(stripTokens(event)).toEqual(event);
  });

  it.each([
    ["a navigation to the link typed without /api/", TYPED, REDACTED],
    ["a request to the link", `${ORIGIN}/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}?x=1`, REDACTED],
    ["a relative request to the link", `/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}`, "/quick-deploy/[redacted]"],
    ["a request with the prefix encoded", `${ORIGIN}/assets/%74qd_${BODY}.js`, REDACTED],
  ])("replay's recorded requests lose it: %s", async (_kind, url, expected) => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: url, entryType: "navigation", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: expected });
  });

  it.each([
    ["a link typed without /api/", `a.font-medium:attr__href="/quick-deploy/${QUICK_DEPLOY_SECRET}"href="/quick-deploy/${QUICK_DEPLOY_SECRET}"nth-child="1"nth-of-type="1"text="Download";p:nth-child="2"nth-of-type="1"`],
    ["the link itself, masked but for its href", `a:attr__href="${ORIGIN}/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}"nth-child="1"nth-of-type="1"`],
    ["the prefix encoded twice", `a:attr__href="/x/%2574qd_${BODY}"nth-child="1"nth-of-type="1"`],
    ["the segment without the prefix, after a class with a #", `a.bg-[#fff]:attr__class="bg-[#fff]"attr__href="/quick-deploy/${BODY}"nth-child="1"nth-of-type="1"`],
    ["the link as the element's text", `span:nth-child="1"nth-of-type="1"text="${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}";a:attr__href="/app"`],
  ])("before_send replaces a clicked element's description that holds it, and drops its other forms: %s", async (_kind, chain) => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000034",
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $elements_chain: chain,
        $elements: [{ tag_name: "a", attr__href: `/quick-deploy/${QUICK_DEPLOY_SECRET}`, $el_text: "Download" }],
        $el_text: `${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}`,
        $current_url: `${ORIGIN}/docs`,
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties).toEqual({
      $event_type: "click",
      $elements_chain: 'a:href="/quick-deploy/[redacted]"',
      $current_url: `${ORIGIN}/docs`,
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send leaves a clicked element's description without it as it was: the links' own routes", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000035",
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $elements_chain: 'a.bg-[#fff]:attr__href="/app/fleets/f1/quick-deploy-links?tab=x"nth-child="1"nth-of-type="1"text="Quick deploy";div:nth-child="1"',
        $elements: [{ tag_name: "a", attr__href: "/app/fleets/f1/quick-deploy-links?tab=x" }],
        $el_text: "Quick deploy",
      },
    };

    expect(stripTokens(event)).toEqual(event);
  });

  it.each([
    ["the clicked element's text, past the 400 characters the chain keeps", (text: string) => ({ $el_text: text, $elements: [{ tag_name: "button", $el_text: text }] })],
    ["the clicked element's text alone, without $elements", (text: string) => ({ $el_text: text })],
    ["an ancestor's text in $elements", (text: string) => ({ $el_text: "Copy", $elements: [{ tag_name: "button", $el_text: "Copy" }, { tag_name: "div", $el_text: text }] })],
    ["an attribute's value in $elements", () => ({ $el_text: "Copy", $elements: [{ tag_name: "button", $el_text: "Copy", attr__title: `${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}` }] })],
    ["an attribute's value in $elements, the prefix encoded", () => ({ $elements: [{ tag_name: "a", attr__href: `/x/%74qd_${BODY}` }] })],
  ])("before_send drops the elements' other forms when they hold it where the chain doesn't: %s", async (_kind, others) => {
    const { stripTokens } = await import("./analytics.js");
    // posthog-js 1.376.0 keeps the first 400 characters of an element's
    // text in the chain, and sends $el_text and $elements' values whole.
    const lead = `${"x".repeat(250)} ${"y".repeat(200)}`;
    const text = `${lead} ${ORIGIN}/quick-deploy/${QUICK_DEPLOY_SECRET}`;
    const chain = `button:nth-child="1"nth-of-type="1"text="${text.slice(0, 400)}";div:nth-child="1"nth-of-type="1"`;
    expect(chain).not.toContain("quick-deploy");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000036",
      event: "$autocapture",
      properties: { $event_type: "click", $elements_chain: chain, ...others(text), $current_url: `${ORIGIN}/docs` },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties).toEqual({
      $event_type: "click",
      $elements_chain: 'a:href="/quick-deploy/[redacted]"',
      $current_url: `${ORIGIN}/docs`,
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send drops $elements holding it from an event without a chain, and adds none", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000037",
      event: "$autocapture",
      properties: { $event_type: "click", $elements: [{ tag_name: "a", attr__href: `/quick-deploy/${QUICK_DEPLOY_SECRET}` }] },
    };

    expect(stripTokens(event)?.properties).toEqual({ $event_type: "click" });
  });

  it.each([
    ["address holds a link's secret", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/pricing?s=${QUICK_DEPLOY_SECRET}`));
      return () => {};
    }],
    ["referrer is a link", () => {
      const referrer = vi.spyOn(Document.prototype, "referrer", "get").mockReturnValue(TYPED);
      return () => referrer.mockRestore();
    }],
  ])("never starts PostHog in a document whose %s, whatever comes after", async (_kind, arrange) => {
    const restore = arrange();
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    // A client-side navigation to a clean page, an accept there, and App
    // mounted again (after a root error): the document is the same.
    restore();
    vi.stubGlobal("location", new URL(`${ORIGIN}/pricing`));
    expect(document.referrer).toBe("");
    await choose("accepted");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
  });

  it("replay's recorded requests to the links' own routes are kept as before, the API's query dropped", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const url = `${ORIGIN}/api/v1/organizations/o1/fleets/f1/quick-deploy-links?limit=5`;
    const request = { name: url, entryType: "resource", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: `${ORIGIN}/api/v1/organizations/o1/fleets/f1/quick-deploy-links` });
  });
});

describe("a library link never reaches PostHog", () => {
  // A hand-written fixture, visibly fake: nothing here is signed, so it may be compared directly.
  const ORIGIN = "https://telflo.example";
  const LINK = `tll_${"FAKE".repeat(17)}FAK`;
  const BODY = LINK.slice("tll_".length);
  const REDACTED = `${ORIGIN}/library-links/[redacted]`;
  const PATH = "/library-links/[redacted]";
  // The link itself, as Copy curl's command names it (with the page's own origin), opened in the browser.
  const OPENED = `${ORIGIN}/api/v1/library-links/${LINK}`;

  it.each([
    ["the link itself", OPENED],
    ["typed without /api/", `${ORIGIN}/library-links/${LINK}`],
    ["with a query and a fragment", `${ORIGIN}/API/V1/LIBRARY-LINKS/${LINK}?x=1#top`],
    ["with a trailing slash", `${ORIGIN}/api/v1/library-links/${LINK}/`],
    ["the prefix's t encoded", `${ORIGIN}/x/%74ll_${BODY}`],
    ["the prefix's first l encoded", `${ORIGIN}/x/t%6cl_${BODY}`],
    ["the prefix's second l encoded", `${ORIGIN}/x/tl%6C_${BODY}`],
    ["the prefix's _ encoded", `${ORIGIN}/x/tll%5F${BODY}`],
    ["the prefix in upper case, encoded", `${ORIGIN}/x/%54%4C%4C_${BODY}`],
    ["the prefix encoded twice", `${ORIGIN}/x/%2574ll_${BODY}`],
    ["the prefix in another page's query", `${ORIGIN}/library?s=${LINK}`],
    ["the prefix encoded in another page's query", `${ORIGIN}/pricing?s=t%6cl_${BODY}`],
    ["the segment without the prefix", `${ORIGIN}/api/v1/library-links/${BODY}`],
    ["the segment's slashes doubled", `${ORIGIN}//library-links//${BODY}`],
    ["the segment behind a dot segment", `${ORIGIN}/x/../library-links/${BODY}`],
    ["the segment's letter encoded", `${ORIGIN}/%6cibrary-links/${BODY}`],
    ["the segment's slash encoded", `${ORIGIN}/library-links%2F${BODY}`],
    ["the segment alone", `${ORIGIN}/library-links`],
  ])("replaces a URL holding it whole, keeping only the origin: %s", async (_kind, url) => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens(url)).toBe(REDACTED);
  });

  it("replaces a path holding it, or anything else that isn't a URL, by the fixed path", async () => {
    const { withoutTokens } = await import("./analytics.js");

    expect(withoutTokens(`/api/v1/library-links/${LINK}`)).toBe(PATH);
    expect(withoutTokens(`/api/v1/library-links/%74ll_${BODY}?x=1`)).toBe(PATH);
    expect(withoutTokens(`library-links/${LINK}`)).toBe(PATH);
    expect(withoutTokens(`android-app://tll_${BODY}`)).toBe(PATH);
  });

  it("leaves every other URL as it was: the library's own pages and routes, a lookalike, and pages without the prefix", async () => {
    const { withoutTokens } = await import("./analytics.js");

    for (const url of [
      `${ORIGIN}/library`,
      `${ORIGIN}/product-admin/library`,
      `${ORIGIN}/api/v1/library-files`,
      "/api/v1/library-files/0199f400-0000-7000-8000-000000000001/link",
      "/api/v1/library-files/0199f400-0000-7000-8000-000000000001/file",
      `${ORIGIN}/docs/library-linking`,
      `${ORIGIN}/pricing?q=tll&x=tl_l`,
      `${ORIGIN}/pricing?x=%74ll`,
      "https://search.example/?q=library-links",
      "$direct",
    ]) {
      expect(withoutTokens(url)).toBe(url);
    }
  });

  it("before_send cleans every URL property: the event's, its $set and $set_once, the referrers and the paths", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000060",
      event: "$pageview",
      properties: {
        $current_url: OPENED,
        $pathname: `/api/v1/library-links/${LINK}`,
        $referrer: `${ORIGIN}/api/v1/library-links/t%6cl_${BODY}`,
        $initial_referrer: OPENED,
        $initial_current_url: OPENED,
        $session_entry_url: OPENED,
        $session_entry_pathname: `/library-links/${LINK}`,
        $prev_pageview_url: OPENED,
        $prev_pageview_pathname: `/%74ll_${BODY}`,
        $referring_domain: "telflo.example",
        title: "Library - Telflo",
        $set: { $current_url: OPENED, $pathname: `/library-links/${LINK}` },
      },
      $set: { $current_url: OPENED, $referrer: OPENED },
      $set_once: { $initial_current_url: OPENED, $initial_referrer: OPENED, $initial_pathname: `/library-links/${LINK}` },
    };

    const cleaned = stripTokens(event);

    expect(cleaned).toEqual({
      ...event,
      properties: {
        $current_url: REDACTED,
        $pathname: PATH,
        $referrer: REDACTED,
        $initial_referrer: REDACTED,
        $initial_current_url: REDACTED,
        $session_entry_url: REDACTED,
        $session_entry_pathname: PATH,
        $prev_pageview_url: REDACTED,
        $prev_pageview_pathname: PATH,
        $referring_domain: "telflo.example",
        title: "Library - Telflo",
        $set: { $current_url: REDACTED, $pathname: PATH },
      },
      $set: { $current_url: REDACTED, $referrer: REDACTED },
      $set_once: { $initial_current_url: REDACTED, $initial_referrer: REDACTED, $initial_pathname: PATH },
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send cleans heatmap data keyed by the link, nested events, and replay's page addresses", async () => {
    const { stripTokens } = await import("./analytics.js");
    const point = { x: 1, y: 2, target_fixed: false, type: "click" };
    const heatmap: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000061",
      event: "$$heatmap",
      properties: {
        $heatmap_data: { [OPENED]: [point] },
        $web_vitals_LCP_event: { name: "LCP", $current_url: OPENED },
      },
    };
    const snapshot: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000062",
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: OPENED, width: 800, height: 600 }, timestamp: 1 },
          { type: 5, data: { tag: "$url_changed", payload: { href: OPENED } }, timestamp: 2 },
          { type: 5, data: { tag: "$pageview", payload: { href: OPENED } }, timestamp: 3 },
        ],
        $session_id: "a-session",
      },
    };

    const cleanedHeatmap = stripTokens(heatmap);
    const cleanedSnapshot = stripTokens(snapshot);

    expect(cleanedHeatmap?.properties.$heatmap_data).toEqual({ [REDACTED]: [point] });
    expect(cleanedHeatmap?.properties.$web_vitals_LCP_event).toEqual({ name: "LCP", $current_url: REDACTED });
    expect(cleanedSnapshot?.properties.$snapshot_data).toEqual([
      { type: 4, data: { href: REDACTED, width: 800, height: 600 }, timestamp: 1 },
      { type: 5, data: { tag: "$url_changed", payload: { href: REDACTED } }, timestamp: 2 },
      { type: 5, data: { tag: "$pageview", payload: { href: REDACTED } }, timestamp: 3 },
    ]);
    expect(JSON.stringify([cleanedHeatmap, cleanedSnapshot])).not.toContain(BODY);
  });

  it("before_send leaves the library's own pages' events as they were", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000063",
      event: "$pageview",
      properties: {
        $current_url: `${ORIGIN}/library`,
        $pathname: "/library",
        $referrer: `${ORIGIN}/product-admin/library`,
        $set: { $current_url: `${ORIGIN}/library` },
      },
      $set_once: { $initial_pathname: "/app" },
    };

    expect(stripTokens(event)).toEqual(event);
  });

  it.each([
    ["a navigation to the link", OPENED, REDACTED],
    ["a request to the link", `${OPENED}?x=1`, REDACTED],
    ["a relative request to the link", `/api/v1/library-links/${LINK}`, PATH],
    ["a request with the prefix encoded", `${ORIGIN}/assets/%74ll_${BODY}.js`, REDACTED],
  ])("replay's recorded requests lose it: %s", async (_kind, url, expected) => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: url, entryType: "navigation", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: expected });
  });

  it("replay's recorded requests to the library's own routes are kept as before, the API's query dropped: the link's POST names an id only", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const url = `${ORIGIN}/api/v1/library-files/0199f400-0000-7000-8000-000000000001/link?x=1`;
    const request = { name: url, entryType: "resource", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: `${ORIGIN}/api/v1/library-files/0199f400-0000-7000-8000-000000000001/link` });
  });

  it.each([
    ["the link as a clicked anchor's href", `a.font-medium:attr__href="${OPENED}"href="${OPENED}"nth-child="1"nth-of-type="1"text="Download";p:nth-child="2"nth-of-type="1"`],
    ["the prefix encoded twice", `a:attr__href="/x/%2574ll_${BODY}"nth-child="1"nth-of-type="1"`],
    ["the segment without the prefix, after a class with a #", `a.bg-[#fff]:attr__class="bg-[#fff]"attr__href="/library-links/${BODY}"nth-child="1"nth-of-type="1"`],
    ["the command as the element's text", `span:nth-child="1"nth-of-type="1"text="curl -fL '${OPENED}' -o 'x'";a:attr__href="/app"`],
  ])("before_send replaces a clicked element's description that holds it, and drops its other forms: %s", async (_kind, chain) => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000064",
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $elements_chain: chain,
        $elements: [{ tag_name: "a", attr__href: `/library-links/${LINK}`, $el_text: "Download" }],
        $el_text: OPENED,
        $current_url: `${ORIGIN}/library`,
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties).toEqual({
      $event_type: "click",
      $elements_chain: 'a:href="/library-links/[redacted]"',
      $current_url: `${ORIGIN}/library`,
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send replaces a description where only the chain holds it: an ancestor's href, no $elements, the button's own text", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000067",
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $elements_chain: `button:nth-child="1"nth-of-type="1"text="Curl";a:attr__href="/api/v1/library-links/${LINK}"nth-child="1"nth-of-type="1"`,
        $el_text: "Curl",
        $current_url: `${ORIGIN}/library`,
      },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties).toEqual({
      $event_type: "click",
      $elements_chain: 'a:href="/library-links/[redacted]"',
      $current_url: `${ORIGIN}/library`,
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it("before_send leaves a clicked element's description without it as it was: the members' Curl and Download buttons", async () => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000065",
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $elements_chain: 'button.bg-[#fff]:attr__title="Copy a curl command that downloads this file"nth-child="1"nth-of-type="1"text="Curl";td:nth-child="3"',
        $elements: [{ tag_name: "button", attr__title: "Copy a curl command that downloads this file", $el_text: "Curl" }],
        $el_text: "Curl",
      },
    };

    expect(stripTokens(event)).toEqual(event);
  });

  it.each([
    ["the clicked element's text alone, without $elements", (text: string) => ({ $el_text: text })],
    ["an ancestor's text in $elements", (text: string) => ({ $el_text: "Curl", $elements: [{ tag_name: "button", $el_text: "Curl" }, { tag_name: "div", $el_text: text }] })],
    ["an attribute's value in $elements, the prefix encoded", () => ({ $elements: [{ tag_name: "a", attr__href: `/x/%74ll_${BODY}` }] })],
  ])("before_send drops the elements' other forms when they hold it where the chain doesn't: %s", async (_kind, others) => {
    const { stripTokens } = await import("./analytics.js");
    const text = `curl -fL '${OPENED}' -o 'x'`;
    const chain = 'button:nth-child="1"nth-of-type="1"text="Curl";div:nth-child="1"nth-of-type="1"';
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000066",
      event: "$autocapture",
      properties: { $event_type: "click", $elements_chain: chain, ...others(text), $current_url: `${ORIGIN}/library` },
    };

    const cleaned = stripTokens(event);

    expect(cleaned?.properties).toEqual({
      $event_type: "click",
      $elements_chain: 'a:href="/library-links/[redacted]"',
      $current_url: `${ORIGIN}/library`,
    });
    expect(JSON.stringify(cleaned)).not.toContain(BODY);
  });

  it.each([
    ["address holds a library link", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/pricing?s=${LINK}`));
      return () => {};
    }],
    ["address is a link's route without the prefix", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/library-links/${BODY}`));
      return () => {};
    }],
    ["referrer is a link", () => {
      const referrer = vi.spyOn(Document.prototype, "referrer", "get").mockReturnValue(OPENED);
      return () => referrer.mockRestore();
    }],
  ])("never starts PostHog in a document whose %s, whatever comes after", async (_kind, arrange) => {
    const restore = arrange();
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    restore();
    vi.stubGlobal("location", new URL(`${ORIGIN}/pricing`));
    expect(document.referrer).toBe("");
    await choose("accepted");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
  });

  it("starts PostHog as usual on the members' library page", async () => {
    vi.stubGlobal("location", new URL(`${ORIGIN}/library`));

    await start();

    expect(posthog.client.init).toHaveBeenCalled();
  });
});

describe("an organization's logo address never reaches replay's network entries", () => {
  // Fake ids: a logo's address names the organization and its logo, and appears only as an <img>'s src
  // inside ph-no-capture; its load is a request replay records once the PostHog project turns
  // network capture on.
  const ORIGIN = "https://telflo.example";
  const ORGANIZATION = "00000000-0000-4000-8000-0000000000a1";
  const LOGO = "00000000-0000-4000-8000-0000000000b2";
  const REDACTED = `${ORIGIN}/api/v1/organization-logos/[redacted]`;

  it.each([
    ["an absolute request", `${ORIGIN}/api/v1/organization-logos/${ORGANIZATION}/${LOGO}`, REDACTED],
    ["a relative request", `/api/v1/organization-logos/${ORGANIZATION}/${LOGO}`, "/api/v1/organization-logos/[redacted]"],
    ["with a query and a fragment", `${ORIGIN}/api/v1/organization-logos/${ORGANIZATION}/${LOGO}?v=1#x`, REDACTED],
    ["the segment's letter percent-encoded", `${ORIGIN}/api/v1/%6Frganization-logos/${ORGANIZATION}/${LOGO}`, REDACTED],
    ["the segment's dash percent-encoded", `${ORIGIN}/api/v1/organization%2Dlogos/${ORGANIZATION}/${LOGO}`, REDACTED],
    ["the segment's slash percent-encoded", `${ORIGIN}/api/v1/organization-logos%2F${ORGANIZATION}%2F${LOGO}`, REDACTED],
    ["a doubled slash", `${ORIGIN}/api/v1//organization-logos//${ORGANIZATION}/${LOGO}`, REDACTED],
    ["behind a dot segment", `${ORIGIN}/api/v1/x/../organization-logos/${ORGANIZATION}/${LOGO}`, REDACTED],
    ["in upper case", `${ORIGIN}/API/V1/ORGANIZATION-LOGOS/${ORGANIZATION}/${LOGO}`, REDACTED],
  ])("names the entry by the route alone, keeping it: %s", async (_kind, url, expected) => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: url, entryType: "resource", startTime: 1, duration: 2 };

    const masked = mask?.(request);

    expect(masked).toEqual({ ...request, name: expected });
    expect(JSON.stringify(masked)).not.toContain(ORGANIZATION);
    expect(JSON.stringify(masked)).not.toContain(LOGO);
  });

  it("leaves the organizations' own routes as before, the API's query dropped", async () => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: `${ORIGIN}/api/v1/organizations/${ORGANIZATION}?x=1`, entryType: "resource", startTime: 1, duration: 2 };

    expect(mask?.(request)).toEqual({ ...request, name: `${ORIGIN}/api/v1/organizations/${ORGANIZATION}` });
  });
});

describe("no event property names a logo or holds a library link, at any depth, arrays included", () => {
  // Fake ids and a visibly fake link: nothing here is signed, so it may be compared directly.
  const ORIGIN = "https://telflo.example";
  const ORGANIZATION = "00000000-0000-4000-8000-0000000000a1";
  const LOGO = "00000000-0000-4000-8000-0000000000b2";
  const LOGO_URL = `${ORIGIN}/api/v1/organization-logos/${ORGANIZATION}/${LOGO}`;
  const REDACTED_LOGO = `${ORIGIN}/api/v1/organization-logos/[redacted]`;
  const LINK = `tll_${"FAKE".repeat(17)}FAK`;
  const BODY = LINK.slice("tll_".length);
  const REDACTED_LINK = "/library-links/[redacted]";

  /** A `$web_vitals` event as posthog-js builds it: `$web_vitals_LCP_event` is the metric, `entries` its PerformanceEntry list. */
  function webVitals(entries: unknown[], extra: Record<string, unknown> = {}): CaptureResult {
    return {
      uuid: "0190a8b0-0000-7000-8000-0000000000c3",
      event: "$web_vitals",
      properties: {
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1200,
          entries,
          $current_url: `${ORIGIN}/settings/organization`,
          ...extra,
        },
        $web_vitals_LCP_value: 1200,
      },
    };
  }

  /** Whether `value`, as posthog-js would send it, names the logo or holds the link anywhere (a boolean). */
  function namesLogoOrLink(value: unknown): boolean {
    const sent = JSON.stringify(value);
    return sent.includes(ORGANIZATION) || sent.includes(LOGO) || sent.includes(BODY);
  }

  it("redacts a $web_vitals LCP event whose entries[0].url is a logo's address, keeping the rest", async () => {
    const { stripTokens } = await import("./analytics.js");
    const entry = { name: "", entryType: "largest-contentful-paint", url: LOGO_URL, size: 576, startTime: 812 };

    const cleaned = stripTokens(webVitals([entry]));

    expect(namesLogoOrLink(cleaned)).toBe(false);
    expect(cleaned?.properties.$web_vitals_LCP_event).toEqual({
      name: "LCP",
      value: 1200,
      entries: [{ ...entry, url: REDACTED_LOGO }],
      $current_url: `${ORIGIN}/settings/organization`,
    });
    expect(cleaned?.properties.$web_vitals_LCP_value).toBe(1200);
  });

  it("reads the browser's PerformanceEntry objects (not plain: their fields are getters, sent through toJSON)", async () => {
    const { stripTokens } = await import("./analytics.js");
    class LargestContentfulPaint {
      get url(): string {
        return LOGO_URL;
      }
      get size(): number {
        return 576;
      }
      toJSON() {
        return { entryType: "largest-contentful-paint", url: this.url, size: this.size };
      }
    }
    const sneaky = new LargestContentfulPaint();
    expect(namesLogoOrLink(sneaky)).toBe(true);

    const cleaned = stripTokens(webVitals([sneaky], { attribution: { url: LOGO_URL, element: "img.ph-no-capture" } }));

    expect(namesLogoOrLink(cleaned)).toBe(false);
    const metric = cleaned?.properties.$web_vitals_LCP_event as { entries: unknown[]; attribution: unknown };
    expect(metric.entries).toEqual([{ entryType: "largest-contentful-paint", url: REDACTED_LOGO, size: 576 }]);
    expect(metric.attribution).toEqual({ url: REDACTED_LOGO, element: "img.ph-no-capture" });
  });

  it.each([
    ["a relative address in a nested array", [[`/api/v1/organization-logos/${ORGANIZATION}/${LOGO}`]], [["/api/v1/organization-logos/[redacted]"]]],
    ["the segment's dash percent-encoded", [`${ORIGIN}/api/v1/organization%2Dlogos/${ORGANIZATION}/${LOGO}`], [REDACTED_LOGO]],
    ["the segment's slash percent-encoded", [`${ORIGIN}/api/v1/organization-logos%2F${ORGANIZATION}%2F${LOGO}`], [REDACTED_LOGO]],
    ["in upper case, in free text", [`see /API/V1/ORGANIZATION-LOGOS/${ORGANIZATION}/${LOGO} here`], ["/api/v1/organization-logos/[redacted]"]],
    ["a library link in free text", [`curl -fL '${ORIGIN}/api/v1/library-links/${LINK}' -o x`], [REDACTED_LINK]],
    ["a library link, absolute, in an array of objects", [{ note: `${ORIGIN}/api/v1/library-links/${LINK}` }], [{ note: `${ORIGIN}${REDACTED_LINK}` }]],
    ["the link's prefix encoded, after a fragment", [`#top then %74ll_${BODY}`], [REDACTED_LINK]],
    ["the link's prefix encoded twice", [`x %2574ll_${BODY}`], [REDACTED_LINK]],
    ["the segment without the prefix", [`/library-links/${BODY}`], [REDACTED_LINK]],
  ])("redacts any string, not only a URL property: %s", async (_kind, list, expected) => {
    const { stripTokens } = await import("./analytics.js");
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-0000000000c4",
      event: "clicked",
      properties: { list, deep: { deeper: { list } } },
      $set: { list },
      $set_once: { list },
    };

    const cleaned = stripTokens(event);

    expect(namesLogoOrLink(cleaned)).toBe(false);
    expect(cleaned?.properties.list).toEqual(expected);
    expect(cleaned?.properties.deep).toEqual({ deeper: { list: expected } });
    expect(cleaned?.$set).toEqual({ list: expected });
    expect(cleaned?.$set_once).toEqual({ list: expected });
  });

  it("leaves what names neither as it was (the same objects), and a cleaned event cleans to itself", async () => {
    const { stripTokens } = await import("./analytics.js");
    const entries = [{ url: `${ORIGIN}/api/v1/organizations/${ORGANIZATION}`, element: "100% width", word: "organization-logos-guide" }];
    const created = new Date(0);
    const event = webVitals(entries, { created });

    const cleaned = stripTokens(event);
    const metric = cleaned?.properties.$web_vitals_LCP_event as { entries: unknown; created: unknown };

    expect(metric.entries).toBe(entries);
    expect(metric.created).toBe(created);
    const redacted = stripTokens(webVitals([{ url: LOGO_URL }, `${ORIGIN}/api/v1/library-links/${LINK}`]));
    expect(stripTokens(redacted)).toEqual(redacted);
  });

  /** A `$snapshot` event whose recording holds one node with `attributes` (rrweb's full snapshot, much shortened). */
  function snapshot(attributes: Record<string, string>): CaptureResult {
    return {
      uuid: "0190a8b0-0000-7000-8000-0000000000c5",
      event: "$snapshot",
      properties: {
        $session_id: "a-session",
        $snapshot_data: [{ type: 2, data: { node: { type: 2, tagName: "style", attributes, childNodes: [] } }, timestamp: 1 }],
      },
    };
  }

  it("reads the recording too: a node's attribute naming a logo is redacted", async () => {
    const { stripTokens } = await import("./analytics.js");

    const cleaned = stripTokens(snapshot({ style: `background-image: url(${LOGO_URL})` }));

    expect(namesLogoOrLink(cleaned)).toBe(false);
  });

  it("costs a string of percentages with no keyword no URL parse and no decodeURIComponent, however long", async () => {
    const { stripTokens } = await import("./analytics.js");
    let parsed = 0;
    const RealUrl = URL;
    vi.stubGlobal(
      "URL",
      class CountingUrl extends RealUrl {
        constructor(...args: ConstructorParameters<typeof URL>) {
          super(...args);
          parsed += 1;
        }
      },
    );
    const decode = vi.spyOn(globalThis, "decodeURIComponent");
    // About 1 MB of a stylesheet's percentages, rrweb's inlined _cssText: `%` everywhere, no escape spelling a keyword.
    const css = ".a{width:50%;height:100%;margin:0 2% 3%;background:url(/img/x%20y.png)}".repeat(15_000);
    expect(css.length).toBeGreaterThan(1_000_000);

    const cleaned = stripTokens(snapshot({ _cssText: css }));

    const [recorded] = cleaned?.properties.$snapshot_data as { data: { node: { attributes: { _cssText: string } } } }[];
    expect(recorded!.data.node.attributes._cssText).toBe(css);
    expect(parsed).toBe(0);
    expect(decode).not.toHaveBeenCalled();
    // The counters count: a percent-encoded keyword does go on to the full checks.
    stripTokens(snapshot({ _cssText: `${css}/api/v1/organization%2Dlogos/${ORGANIZATION}/${LOGO}` }));
    expect(parsed + decode.mock.calls.length).toBeGreaterThan(0);
    decode.mockRestore();
  });

  it("reads a plain object with a toJSON by what it returns, as JSON.stringify sends it", async () => {
    const { stripTokens } = await import("./analytics.js");
    const entry = { toJSON: () => ({ url: LOGO_URL }), kept: "never sent" };
    expect(namesLogoOrLink(entry)).toBe(true);

    const cleaned = stripTokens(webVitals([entry]));

    expect(namesLogoOrLink(cleaned)).toBe(false);
    expect((cleaned?.properties.$web_vitals_LCP_event as { entries: unknown[] }).entries).toEqual([{ url: REDACTED_LOGO }]);
  });

  it("reads an object whose toJSON returns itself by its own properties (no endless walk)", async () => {
    const { stripTokens } = await import("./analytics.js");
    class SelfJson {
      url = LOGO_URL;
      toJSON() {
        return this;
      }
    }
    const kept = new SelfJson();
    kept.url = `${ORIGIN}/pricing`;

    const cleaned = stripTokens(webVitals([new SelfJson(), kept]));

    expect(namesLogoOrLink(cleaned)).toBe(false);
    const { entries } = cleaned?.properties.$web_vitals_LCP_event as { entries: unknown[] };
    expect(entries[0]).toEqual({ url: REDACTED_LOGO });
    expect(entries[1]).toBe(kept);
  });

  it("reads an object shared by two places in each, and drops an event holding a cycle", async () => {
    const { stripTokens } = await import("./analytics.js");
    const shared = { url: LOGO_URL };

    const cleaned = stripTokens(webVitals([shared, shared], { again: shared }));

    expect(namesLogoOrLink(cleaned)).toBe(false);
    const cyclic: Record<string, unknown> = { url: `${ORIGIN}/pricing` };
    cyclic.self = cyclic;
    expect(stripTokens(webVitals([cyclic]))).toBeNull();
  });

  it("drops an event it can't clean (a toJSON that throws) rather than send it as it was", async () => {
    const { stripTokens } = await import("./analytics.js");
    const entry = {
      url: LOGO_URL,
      toJSON: () => {
        throw new Error("unreadable");
      },
    };

    expect(stripTokens(webVitals([entry]))).toBeNull();
  });
});

describe("an API token never reaches PostHog", () => {
  // A token is built at run time and never printed: every result is checked
  // with a boolean canary before it is compared, each expected value is written without it, and the tables'
  // titles name the case only.
  const ORIGIN = "https://telflo.example";
  const REDACTED = `${ORIGIN}/[redacted]`;
  let token: string;
  let body: string;

  beforeEach(() => {
    token = buildApiToken();
    body = token.slice(TOKEN_START.length);
  });

  /** Whether `value` holds any of the token, case aside: its body's first eight characters (its prefix's) or its last eight. */
  function holdsToken(value: unknown): boolean {
    const text = (JSON.stringify(value) ?? "").toLowerCase();
    return [body.slice(0, 8), body.slice(-8)].some((piece) => text.includes(piece.toLowerCase()));
  }

  /** `value` holds none of the token: a boolean, before anything compares it. */
  function expectNoToken(value: unknown, label: string): void {
    expect(holdsToken(value), `${label} holds the token`).toBe(false);
  }

  const urls: Array<[string, () => string]> = [
    ["in the path", () => `${ORIGIN}/app/${token}`],
    ["in an API request's path", () => `${ORIGIN}/api/v1/organizations/o1/${token}`],
    ["in another page's query", () => `${ORIGIN}/pricing?s=${token}`],
    ["as a query parameter's name", () => `${ORIGIN}/pricing?${token}=1`],
    ["beside a token parameter, with a fragment", () => `${ORIGIN}/verify-email?token=abc&s=${token}#top`],
    ["in upper case", () => `${ORIGIN}/x/${token.toUpperCase()}`],
    ["its t encoded", () => `${ORIGIN}/x/%74f_${body}`],
    ["its f encoded", () => `${ORIGIN}/x/t%66_${body}`],
    ["its _ encoded", () => `${ORIGIN}/x/tf%5F${body}`],
    ["upper case and every character encoded", () => `${ORIGIN}/x/%54%46%5f${body}`],
    ["encoded twice", () => `${ORIGIN}/x/%2574f_${body}`],
    ["encoded twice, after a lone %", () => `${ORIGIN}/100%/x?s=%2574f_${body}`],
  ];

  it.each(urls)("replaces a URL holding it whole, keeping only the origin: %s", async (_kind, url) => {
    const { withoutTokens } = await import("./analytics.js");

    const cleaned = withoutTokens(url());

    expectNoToken(cleaned, "the URL");
    expect(cleaned).toBe(REDACTED);
  });

  it("replaces a path holding it, or anything else that isn't a URL, by the fixed path", async () => {
    const { withoutTokens } = await import("./analytics.js");

    const cleaned = [`/settings/${token}`, `/x?s=t%66_${body}`, `settings/${token}`, `android-app://${token}`].map(withoutTokens);

    expectNoToken(cleaned, "a path");
    expect(cleaned).toEqual(["/[redacted]", "/[redacted]", "/[redacted]", "/[redacted]"]);
  });

  it("leaves every other URL as it was, and one holding it only in its fragment loses the fragment as always", async () => {
    const { withoutTokens } = await import("./analytics.js");

    for (const url of [
      `${ORIGIN}/app/settings/service-accounts/5a000000-0000-4000-8000-000000000001`,
      `${ORIGIN}/docs/tf-providers`,
      `${ORIGIN}/pricing?x=tf&y=t_f&z=%74f`,
      "/app/flows",
      "$direct",
    ]) {
      expect(withoutTokens(url)).toBe(url);
    }
    const cleaned = withoutTokens(`${ORIGIN}/pricing#${token}`);
    expectNoToken(cleaned, "the URL");
    expect(cleaned).toBe(`${ORIGIN}/pricing`);
  });

  it("before_send cleans every URL property: the event's, its $set and $set_once, the referrers and the paths", async () => {
    const { stripTokens } = await import("./analytics.js");
    const pasted = `${ORIGIN}/app/${token}`;
    const path = `/app/${token}`;
    const event: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000040",
      event: "$pageview",
      properties: {
        $current_url: pasted,
        $pathname: path,
        $referrer: `${ORIGIN}/pricing?s=t%66_${body}`,
        $initial_referrer: pasted,
        $initial_current_url: pasted,
        $session_entry_url: pasted,
        $session_entry_pathname: path,
        $prev_pageview_url: pasted,
        $prev_pageview_pathname: path,
        $referring_domain: "telflo.example",
        title: "Settings - Telflo",
        $set: { $current_url: pasted, $pathname: path },
      },
      $set: { $current_url: pasted, $referrer: pasted },
      $set_once: { $initial_current_url: pasted, $initial_referrer: pasted, $initial_pathname: path },
    };

    const cleaned = stripTokens(event);

    expectNoToken(cleaned, "the event");
    expect(cleaned).toEqual({
      uuid: "0190a8b0-0000-7000-8000-000000000040",
      event: "$pageview",
      properties: {
        $current_url: REDACTED,
        $pathname: "/[redacted]",
        $referrer: REDACTED,
        $initial_referrer: REDACTED,
        $initial_current_url: REDACTED,
        $session_entry_url: REDACTED,
        $session_entry_pathname: "/[redacted]",
        $prev_pageview_url: REDACTED,
        $prev_pageview_pathname: "/[redacted]",
        $referring_domain: "telflo.example",
        title: "Settings - Telflo",
        $set: { $current_url: REDACTED, $pathname: "/[redacted]" },
      },
      $set: { $current_url: REDACTED, $referrer: REDACTED },
      $set_once: { $initial_current_url: REDACTED, $initial_referrer: REDACTED, $initial_pathname: "/[redacted]" },
    });
  });

  it("before_send cleans heatmap data keyed by such a URL, nested events, and replay's page addresses", async () => {
    const { stripTokens } = await import("./analytics.js");
    const pasted = `${ORIGIN}/pricing?s=${token}`;
    const point = { x: 1, y: 2, target_fixed: false, type: "click" };
    const heatmap: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000041",
      event: "$$heatmap",
      properties: {
        $heatmap_data: { [pasted]: [point] },
        $web_vitals_LCP_event: { name: "LCP", $current_url: pasted },
      },
    };
    const snapshot: CaptureResult = {
      uuid: "0190a8b0-0000-7000-8000-000000000042",
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: pasted, width: 800, height: 600 }, timestamp: 1 },
          { type: 5, data: { tag: "$url_changed", payload: { href: pasted } }, timestamp: 2 },
          { type: 5, data: { tag: "$pageview", payload: { href: pasted } }, timestamp: 3 },
        ],
        $session_id: "a-session",
      },
    };

    const cleanedHeatmap = stripTokens(heatmap);
    const cleanedSnapshot = stripTokens(snapshot);

    expectNoToken([cleanedHeatmap, cleanedSnapshot], "the events");
    expect(cleanedHeatmap?.properties.$heatmap_data).toEqual({ [REDACTED]: [point] });
    expect(cleanedHeatmap?.properties.$web_vitals_LCP_event).toEqual({ name: "LCP", $current_url: REDACTED });
    expect(cleanedSnapshot?.properties.$snapshot_data).toEqual([
      { type: 4, data: { href: REDACTED, width: 800, height: 600 }, timestamp: 1 },
      { type: 5, data: { tag: "$url_changed", payload: { href: REDACTED } }, timestamp: 2 },
      { type: 5, data: { tag: "$pageview", payload: { href: REDACTED } }, timestamp: 3 },
    ]);
  });

  it.each<[string, () => string, string]>([
    ["a navigation to a page holding it", () => `${ORIGIN}/app/${token}?x=1`, REDACTED],
    ["a request to the API holding it in its path", () => `${ORIGIN}/api/v1/organizations/o1/${token}`, REDACTED],
    ["a relative request to the API", () => `/api/v1/x/%74f_${body}`, "/[redacted]"],
    ["a request holding it in its query", () => `${ORIGIN}/assets/app.js?v=${token}`, REDACTED],
  ])("replay's recorded requests lose it: %s", async (_kind, url, expected) => {
    const { initOptions } = await import("./analytics.js");
    const mask = initOptions(SETTINGS).session_recording?.maskCapturedNetworkRequestFn;
    const request = { name: url(), entryType: "navigation", startTime: 1, duration: 2 };

    const masked = mask?.(request);

    expectNoToken(masked, "the request");
    expect(masked).toEqual({ name: expected, entryType: "navigation", startTime: 1, duration: 2 });
  });

  it.each<[string, () => () => void]>([
    ["address's path holds it", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/app/${token}`));
      return () => {};
    }],
    ["address's query holds it, encoded", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/pricing?s=t%66_${body}`));
      return () => {};
    }],
    ["address's fragment holds it (posthog-js would store it)", () => {
      vi.stubGlobal("location", new URL(`${ORIGIN}/pricing#${token}`));
      return () => {};
    }],
    ["referrer holds it", () => {
      const referrer = vi.spyOn(Document.prototype, "referrer", "get").mockReturnValue(`${ORIGIN}/app/${token}`);
      return () => referrer.mockRestore();
    }],
  ])("never starts PostHog in a document whose %s, whatever comes after", async (_kind, arrange) => {
    const restore = arrange();
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    // A client-side navigation to a clean page, an accept there, and App mounted again: the document is the same.
    restore();
    vi.stubGlobal("location", new URL(`${ORIGIN}/pricing`));
    expect(document.referrer).toBe("");
    await choose("accepted");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
  });

  it("starts PostHog as before in a document whose address holds no token", async () => {
    vi.stubGlobal("location", new URL(`${ORIGIN}/pricing?x=tf&y=t_f#top`));

    await start();

    expect(posthog.client.init).toHaveBeenCalledOnce();
  });
});

describe("PostHog never starts on the CLI's sign-in page", () => {
  const ORIGIN = "https://telflo.example";
  const STATE = `${"S".repeat(20)}-_${"t".repeat(21)}`;
  const FRAGMENT = `#state=${STATE}&port=54321&host=ada-laptop`;

  it.each([
    ["address is /cli-auth with its fragment", `${ORIGIN}/cli-auth${FRAGMENT}`],
    ["address is /cli-auth, the fragment already taken out", `${ORIGIN}/cli-auth`],
    ["address is /cli-auth in capitals with a trailing slash", `${ORIGIN}/CLI-Auth/`],
    ["address is /cli-auth percent-encoded", `${ORIGIN}/cli%2Dauth`],
    ["address is /login with a redirectTo naming it", `${ORIGIN}/login?redirectTo=%2Fcli-auth${FRAGMENT}`],
    ["address is /login with a redirectTo naming it as spelt", `${ORIGIN}/login?redirectTo=/cli-auth`],
    ["address is /login with a redirectTo naming it encoded twice", `${ORIGIN}/login?redirectTo=%252Fcli-auth`],
    ["address is /login with a redirectTo naming it in capitals, a trailing slash", `${ORIGIN}/Login/?error=oauth_failed&redirectTo=%2FCLI-AUTH%2F`],
  ])("never starts PostHog in a document whose %s, whatever comes after", async (_kind, href) => {
    vi.stubGlobal("location", new URL(href));
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    // A client-side navigation to a clean page, an accept there, and App mounted again: the document is the same.
    vi.stubGlobal("location", new URL(`${ORIGIN}/pricing`));
    await choose("accepted");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await choose("accepted");

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
  });

  it.each([
    ["a lookalike path", `${ORIGIN}/cli-authx`],
    ["a page under it", `${ORIGIN}/cli-auth/x`],
    ["/login with another redirectTo", `${ORIGIN}/login?redirectTo=%2Fapp`],
    ["/login with a lookalike redirectTo", `${ORIGIN}/login?redirectTo=%2Fcli-authx`],
    ["/register with a redirectTo naming it", `${ORIGIN}/register?redirectTo=%2Fcli-auth`],
    ["another page with the parameters' names", `${ORIGIN}/pricing?host=box&port=1`],
  ])("starts PostHog as before in a document whose address is %s", async (_kind, href) => {
    vi.stubGlobal("location", new URL(href));

    await start();

    expect(posthog.client.init).toHaveBeenCalledOnce();
  });
});

describe("masking autocapture while a surface with private data is shown", () => {
  /** The masking posthog-js was last told, by its init or a set_config since. */
  function lastMasking(): unknown {
    const lastSet = posthog.client.set_config.mock.calls.at(-1)?.[0];
    if (lastSet !== undefined) return lastSet;
    const options = posthog.client.init.mock.calls[0]?.[1] as Record<string, unknown>;
    return { mask_all_text: options.mask_all_text, mask_all_element_attributes: options.mask_all_element_attributes };
  }

  const MASKED = { mask_all_text: true, mask_all_element_attributes: true };
  const UNMASKED = { mask_all_text: false, mask_all_element_attributes: false };

  it("masks text and attributes while one surface is shown, and unmasks when it goes", async () => {
    const analytics = await start();
    expect(lastMasking()).toEqual(UNMASKED);

    const release = analytics.setAnalyticsMasked(true);
    await settle();
    expect(posthog.client.set_config).toHaveBeenLastCalledWith(MASKED);

    release();
    await settle();
    expect(posthog.client.set_config).toHaveBeenLastCalledWith(UNMASKED);
  });

  it("counts: stays masked until every surface has gone, and a second release changes nothing", async () => {
    const analytics = await start();
    const releaseShell = analytics.setAnalyticsMasked(true);
    const releaseDrawer = analytics.setAnalyticsMasked(true);
    await settle();

    releaseDrawer();
    releaseDrawer();
    await settle();
    expect(lastMasking()).toEqual(MASKED);

    releaseShell();
    await settle();
    expect(lastMasking()).toEqual(UNMASKED);
    expect(posthog.client.set_config).toHaveBeenCalledTimes(2);
  });

  it("masks nothing for a surface that isn't shown", async () => {
    const analytics = await start();
    const release = analytics.setAnalyticsMasked(false);
    release();
    await settle();

    expect(posthog.client.set_config).not.toHaveBeenCalled();
    expect(lastMasking()).toEqual(UNMASKED);
  });

  it("starts masked when a shell was shown before root started PostHog (the layout's effects run first)", async () => {
    const analytics = await import("./analytics.js");
    const release = analytics.setAnalyticsMasked(true);
    renderHook(() => analytics.useAnalytics(SETTINGS));
    await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
    await settle();

    expect(posthog.client.init).toHaveBeenCalledWith("phc_test", expect.objectContaining(MASKED));
    expect(posthog.client.set_config).not.toHaveBeenCalled();

    release();
    await settle();
    expect(posthog.client.set_config).toHaveBeenLastCalledWith(UNMASKED);
  });

  it("tells a client that is still loading the masking as it is once it is ready", async () => {
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    const release = analytics.setAnalyticsMasked(true);
    release();
    await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
    await settle();

    expect(lastMasking()).toEqual(UNMASKED);
  });

  it("without the setting, never loads PostHog", async () => {
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(null));
    const release = analytics.setAnalyticsMasked(true);
    await settle();
    release();
    await settle();

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.set_config).not.toHaveBeenCalled();
  });
});

describe("capturing an event", () => {
  it("passes it to PostHog, which drops it unless the visitor has accepted", async () => {
    const analytics = await start();
    analytics.captureEvent("user_signed_up", { method: "email" });
    await settle();

    expect(posthog.client.capture).toHaveBeenCalledWith("user_signed_up", { method: "email" });
  });
});

describe("feature flags (ported; nothing uses them yet)", () => {
  /** A page under a root whose loader passes `settings`, showing `useValue`'s answer. */
  function renderUnderRoot(settings: AnalyticsSettings | null, useValue: () => unknown) {
    function Page() {
      return <p>value: {JSON.stringify(useValue()) ?? "undefined"}</p>;
    }
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ publicWebUrl: null, analytics: settings }),
        HydrateFallback: () => null,
        Component: Page,
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
  }

  /** Answers PostHog's flags as `flags`, once the page asks for them. */
  async function flagsArrive(flags: Record<string, boolean | string>) {
    await vi.waitFor(() => expect(posthog.client.onFeatureFlags).toHaveBeenCalled());
    posthog.client.isFeatureEnabled.mockImplementation((flag: string) => Boolean(flags[flag]));
    posthog.client.getFeatureFlag.mockImplementation((flag: string) => flags[flag]);
    act(() => {
      for (const [callback] of posthog.client.onFeatureFlags.mock.calls) (callback as () => void)();
    });
  }

  it("turns every flag on without analytics, and never loads PostHog", async () => {
    const { useFeatureFlag, useFeatureFlagWithLoading } = await import("./analytics.js");
    renderUnderRoot(null, () => [useFeatureFlag("builder"), useFeatureFlagWithLoading("builder")]);

    expect(await screen.findByText('value: [true,{"isLoaded":true}]')).toBeInTheDocument();
    await settle();
    expect(posthog.imported).not.toHaveBeenCalled();
  });

  it("with analytics, a flag is off until PostHog's flags arrive, then follows them", async () => {
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    renderUnderRoot(SETTINGS, () => analytics.useFeatureFlag("builder"));
    expect(await screen.findByText("value: false")).toBeInTheDocument();

    await flagsArrive({ builder: true });

    expect(await screen.findByText("value: true")).toBeInTheDocument();
  });

  it("with analytics, the loading variant reports the flag's value once it has loaded", async () => {
    const analytics = await import("./analytics.js");
    renderHook(() => analytics.useAnalytics(SETTINGS));
    renderUnderRoot(SETTINGS, () => analytics.useFeatureFlagWithLoading("variant"));
    expect(await screen.findByText('value: {"isLoaded":false}')).toBeInTheDocument();

    await flagsArrive({ variant: "b" });

    expect(await screen.findByText('value: {"value":"b","isLoaded":true}')).toBeInTheDocument();
  });
});
