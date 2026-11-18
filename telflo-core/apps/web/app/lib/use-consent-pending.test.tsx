import { createRoutesStub } from "react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setConsentStatus } from "./cookie-consent.js";
import { useConsentPending } from "./use-consent-pending.js";

/*
 * Whether the cookie banner still asks (Ruling 301): only with analytics
 * configured (root's loader), until a choice is stored or made.
 */

function Probe() {
  return <p data-testid="pending">{String(useConsentPending())}</p>;
}

function renderWith(analytics: unknown) {
  const Stub = createRoutesStub([{ id: "root", path: "/", loader: () => ({ analytics }), Component: Probe }]);
  return render(<Stub initialEntries={["/"]} />);
}

afterEach(() => {
  window.localStorage.clear();
});

describe("useConsentPending", () => {
  it("is false at once with no analytics configured: nothing waits", async () => {
    renderWith(null);
    expect(await screen.findByTestId("pending")).toHaveTextContent("false");
  });

  it("is true with analytics configured and no choice stored, until the visitor answers", async () => {
    renderWith({ key: "phc_test", host: "https://posthog.example" });
    expect(await screen.findByTestId("pending")).toHaveTextContent("true");
    act(() => setConsentStatus("accepted"));
    expect(screen.getByTestId("pending")).toHaveTextContent("false");
  });

  it("is false with analytics configured once a choice is stored", async () => {
    window.localStorage.setItem("telflo_cookie_consent", "rejected");
    renderWith({ key: "phc_test", host: "https://posthog.example" });
    // True until the effect has read the stored choice, then false (Ruling 303: waited for, not raced).
    await waitFor(() => expect(screen.getByTestId("pending")).toHaveTextContent("false"));
  });
});
