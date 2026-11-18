import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenListed, type EnrollmentTokenRevealedResponse } from "@telflo/contracts";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { expectTextOnlyInsideNoCapture, FLEET_ID, tokensInEveryState } from "~/test/fleets.js";
import { REVEAL_ARCHIVED, REVEAL_FAILED_MESSAGE, REVEAL_WORDS, RevealTokenDialog } from "./RevealTokenDialog.js";

/*
 * Reveal (D17b-2 decisions 12, 30 and 34): the bearer is shown in
 * `ph-no-capture`, one reveal per opening, on either kind of fleet.
 */

const NOW = Date.now();
const tokens = tokensInEveryState(NOW);
const DEFAULT_BEARER = "tfd_reveal-canary-default-0d1e";
const ROTATE_BEARER = "tfr_reveal-canary-rotate-6a2b";
const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });

/**
 * The bearer shown masked (its prefix, first and last four characters) and
 * nowhere whole; then, once `Show <kind> token` is pressed, whole and only
 * inside ph-no-capture.
 */
async function expectMaskedThenShown(user: UserEvent, kind: "default" | "rotate", bearer: string) {
  expect(await screen.findByText(maskSecret(bearer))).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(bearer);
  const show = screen.getByRole("button", { name: `Show ${kind} token` });
  expect(show).toHaveAttribute("aria-pressed", "false");
  await user.click(show);
  expect(await screen.findByText(bearer)).toBeInTheDocument();
  expectTextOnlyInsideNoCapture(bearer);
}

function revealed(token: EnrollmentTokenListed, bearer: string): EnrollmentTokenRevealedResponse {
  return { token: { id: token.id, kind: token.kind, bearer, expiresAt: token.expiresAt } };
}

type Answer = EnrollmentTokenRevealedResponse | "hang" | Error;

function serveReveals(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation((organizationId, fleetId, _tokenId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    signals.push(options.signal);
    const answer = answers.shift() ?? revealed(tokens.defaultToken, DEFAULT_BEARER);
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
  return { spy, signals };
}

/** The dialog open for `token` in GROUP_ID, with a Switch to another organization and a Reopen. */
async function renderDialog(token: EnrollmentTokenListed = tokens.defaultToken, archived = false) {
  const rendered = mountDialog(token, archived);
  await screen.findByRole("dialog");
  return rendered;
}

/** `renderDialog` without waiting for the dialog: under fake timers, the test steps them. */
function mountDialog(token: EnrollmentTokenListed = tokens.defaultToken, archived = false) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <RevealTokenDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          token={token}
          archived={archived}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  return { user, onOpenChange, onChanged, loader };
}

describe("RevealTokenDialog (decision 30)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals the default token once per opening: "Revealing…", then its bearer masked, whole on Show and only inside ph-no-capture, and reloads the tab', async () => {
    let finish!: () => void;
    const spy = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(revealed(tokens.defaultToken, DEFAULT_BEARER));
        }),
    );
    const { user, onChanged } = await renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Default token" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Revealing…");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, tokens.defaultToken.id, { signal: expect.any(AbortSignal) });
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => finish());
    await expectMaskedThenShown(user, "default", DEFAULT_BEARER);
    expect(within(dialog).getByRole("button", { name: "Copy default token" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(REVEAL_WORDS);
    expect(REVEAL_WORDS).toBe(
      "Anyone holding this token can enroll collectors in this fleet and receive the configuration they are sent. Each reveal is recorded in the token history.",
    );
    expect(dialog).not.toHaveTextContent(REVEAL_ARCHIVED);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('titles a rotate token "Rotate token", its copy "Copy rotate token"', async () => {
    serveReveals(revealed(tokens.current, ROTATE_BEARER));
    const { user } = await renderDialog(tokens.current);
    const dialog = screen.getByRole("dialog", { name: "Rotate token" });
    await expectMaskedThenShown(user, "rotate", ROTATE_BEARER);
    expect(within(dialog).getByRole("button", { name: "Copy rotate token" })).toBeInTheDocument();
  });

  it("says an archived fleet's collectors are refused, still revealing (Preflight ruling 8)", async () => {
    serveReveals();
    await renderDialog(tokens.defaultToken, true);
    expect(await screen.findByText(maskSecret(DEFAULT_BEARER))).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(REVEAL_ARCHIVED);
    expect(REVEAL_ARCHIVED).toBe("This fleet is archived: its collectors are refused until it is unarchived.");
  });

  it("drops the bearer as the dialog closes, and the next opening reveals afresh", async () => {
    const reveals = serveReveals(revealed(tokens.defaultToken, DEFAULT_BEARER), revealed(tokens.defaultToken, `${DEFAULT_BEARER}-again`));
    const { user, onOpenChange } = await renderDialog();
    await expectMaskedThenShown(user, "default", DEFAULT_BEARER);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(DEFAULT_BEARER);
    expect(document.body).not.toHaveTextContent(maskSecret(DEFAULT_BEARER));

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await expectMaskedThenShown(user, "default", `${DEFAULT_BEARER}-again`);
    expect(reveals.spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a revoked token", () => refusal("enrollment_token_revoked", "The token has been revoked.", 409), "The token has been revoked.", true],
    ["an expired token", () => refusal("enrollment_token_expired", "The token has expired.", 409), "The token has expired.", true],
    ["a token not found", () => refusal("enrollment_token_not_found", "Enrollment token not found.", 404), "Enrollment token not found.", true],
    ["a 429, its own words", () => refusal("rate_limited", "Too many requests. Try again in 30 seconds.", 429), "Too many requests. Try again in 30 seconds.", false],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), REVEAL_FAILED_MESSAGE, false],
  ])("shows %s's refusal in the dialog, with no bearer and no Try again", async (_why, failure, words, reloads) => {
    serveReveals(failure());
    const { onOpenChange, onChanged } = await renderDialog();
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(reloads ? 1 : 0);
  });

  it('on an unknown outcome shows the 503\'s words with "Try again", which reveals again', async () => {
    const reveals = serveReveals(refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503), revealed(tokens.defaultToken, DEFAULT_BEARER));
    const { user, onChanged } = await renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onChanged).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await expectMaskedThenShown(user, "default", DEFAULT_BEARER);
    expect(reveals.spy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("ends a reveal that never answers at 30 s: the 503's words with Try again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reveals = serveReveals("hang");
    mountDialog();
    // The layout's route renders, and the reveal starts with its hang guard.
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reveals.spy).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(reveals.signals[0]!.aborted).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reveals.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it('on a 404 fleet_not_found toasts its words, closes and reloads ("Fleet not found")', async () => {
    serveReveals(refusal("fleet_not_found", "Fleet not found.", 404));
    const toastError = vi.spyOn(toast, "error");
    const { onOpenChange, onChanged } = await renderDialog();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveReveals(failure());
    const toastError = vi.spyOn(toast, "error");
    const { onOpenChange, onChanged, loader } = await renderDialog();
    // The page's load, then the layout's revalidation (the reveal starts as the dialog opens).
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("drops a bearer answered after the organization changed: nothing shown, no reload", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(revealed(tokens.defaultToken, DEFAULT_BEARER));
        }),
    );
    const { onChanged } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => finish());
    expect(document.body).not.toHaveTextContent(DEFAULT_BEARER);
    expect(document.body).not.toHaveTextContent(maskSecret(DEFAULT_BEARER));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
