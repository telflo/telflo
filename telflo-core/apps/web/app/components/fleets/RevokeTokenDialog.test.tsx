import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenListed, type FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { FLEET_ID, tokensInEveryState } from "~/test/fleets.js";
import {
  activeWords,
  DEFAULT_REVOKE,
  DEFAULT_REVOKE_KUBERNETES,
  ONLY_VALID_ROTATE,
  onlyValidRotateWords,
  REVOKE_FAILED_MESSAGE,
  RevokeTokenDialog,
  rotateRefusedWords,
  successorWords,
} from "./RevokeTokenDialog.js";

/*
 * Revoke; its tab's flow (revoke, then the reload) is in
 * `TokensTab.test.tsx`. `DeleteGroupDialog.test.tsx` is the pattern here.
 */

const NOW = Date.now();
const tokens = tokensInEveryState(NOW);
const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const RATE_LIMITED_WORDS = "Too many attempts. Please wait and try again.";

type Answer = "revoked" | "hang" | Error;

function serveRevokes(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "revokeEnrollmentToken").mockImplementation((organizationId, fleetId, tokenId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    signals.push(options.signal);
    const answer = answers.shift() ?? "revoked";
    if (answer === "revoked") return Promise.resolve({ token: { ...tokens.current, id: tokenId, revokedAt: new Date().toISOString() } });
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return Promise.reject(answer);
  });
  return { spy, signals };
}

/** The dialog open for `token` among `list` in GROUP_ID, with a Switch to another organization and a Reopen; a loader counts revalidations. */
async function renderDialog(
  token: EnrollmentTokenListed = tokens.current,
  list: EnrollmentTokenListed[] = [tokens.current, tokens.beingReplaced, tokens.defaultToken],
  fleetType: FleetType = "server",
) {
  const onOpenChange = vi.fn();
  const onRevoked = vi.fn();
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
        <RevokeTokenDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          token={token}
          tokens={list}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          fleetType={fleetType}
          onRevoked={onRevoked}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("alertdialog", { name: "Revoke this token?" });
  return { user, onOpenChange, onRevoked, loader };
}

const revokeButton = () => screen.getByRole("button", { name: /^(Revoke token|Revoking\.\.\.)$/ });
const dialog = () => screen.getByRole("alertdialog");

describe("RevokeTokenDialog's body, by kind and state", () => {
  it("says what refusing a rotate token does, handed the current one while another valid rotate token remains", async () => {
    // The token being replaced, the current one valid beside it.
    await renderDialog(tokens.beingReplaced);
    expect(dialog()).toHaveTextContent(
      "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token and are handed the fleet's current rotate token.",
    );
    expect(dialog()).not.toHaveTextContent(ONLY_VALID_ROTATE);
    expect(dialog()).not.toHaveTextContent(/Another valid rotate token/);
    // No sentence about a bundled default bearer, a stub configuration or
    // "this rotate".
    expect(dialog()).not.toHaveTextContent(/bundled default bearer|stub config|this rotate\b/i);
  });

  it("drops the hand-off clause, and says it suspends the fleet, for the fleet's only valid rotate token", async () => {
    await renderDialog(tokens.current, [tokens.current, tokens.expired, tokens.revoked, tokens.defaultToken]);
    expect(dialog()).toHaveTextContent(rotateRefusedWords(false));
    expect(rotateRefusedWords(false)).toBe(
      "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token.",
    );
    expect(dialog()).not.toHaveTextContent(/handed the fleet's current rotate token/);
    expect(dialog()).toHaveTextContent(ONLY_VALID_ROTATE);
    expect(ONLY_VALID_ROTATE).toBe(
      "This is the fleet's only valid rotate token. Revoking it suspends the fleet: collectors that enroll or restart are sent no configuration until you rotate again.",
    );
  });

  it("says the token being replaced becomes current until its own expiry, for the current token while it is valid", async () => {
    await renderDialog(tokens.current);
    expect(dialog()).toHaveTextContent(rotateRefusedWords(true));
    expect(dialog()).toHaveTextContent(
      `Another valid rotate token, one being replaced, becomes current until it expires on ${formatDateTime(tokens.beingReplaced.expiresAt)}: collectors that enroll or restart are handed it, and are refused when it expires. Rotate before then.`,
    );
    expect(dialog()).not.toHaveTextContent(ONLY_VALID_ROTATE);
  });

  it("says a rotate token's collectors can't come back through the default token while the fleet has none valid", async () => {
    await renderDialog(tokens.beingReplaced, [tokens.current, tokens.beingReplaced, tokens.revokedDefaultToken]);
    expect(dialog()).toHaveTextContent(rotateRefusedWords(true, true));
    expect(rotateRefusedWords(true, true)).toBe(
      "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token (the fleet has no valid default token now: issue a new default token and re-install them) and are handed the fleet's current rotate token.",
    );
    expect(rotateRefusedWords(false, true)).toBe(
      "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token (the fleet has no valid default token now: issue a new default token and re-install them).",
    );
  });

  it("adds the clause to the only valid rotate token's suspension while the fleet has no valid default token", async () => {
    await renderDialog(tokens.current, [tokens.current, tokens.expired, tokens.revoked, tokens.revokedDefaultToken]);
    expect(onlyValidRotateWords(true)).toBe(
      "This is the fleet's only valid rotate token. Revoking it suspends the fleet: collectors that enroll or restart are sent no configuration until you rotate again (the fleet has no valid default token now: issue a new default token and re-install them).",
    );
    expect(dialog()).toHaveTextContent(onlyValidRotateWords(true));
    expect(onlyValidRotateWords(false)).toBe(ONLY_VALID_ROTATE);
  });

  it("adds the clause to the successor's sentence while the fleet has no valid default token", async () => {
    await renderDialog(tokens.current, [tokens.current, tokens.beingReplaced, tokens.revokedDefaultToken]);
    expect(dialog()).toHaveTextContent(
      `Another valid rotate token, one being replaced, becomes current until it expires on ${formatDateTime(tokens.beingReplaced.expiresAt)}: collectors that enroll or restart are handed it (the fleet has no valid default token now: issue a new default token and re-install them), and are refused when it expires. Rotate before then.`,
    );
    expect(successorWords(null, true)).toBe(
      "Another valid rotate token, one being replaced, becomes current: collectors that enroll or restart are handed it (the fleet has no valid default token now: issue a new default token and re-install them).",
    );
    expect(successorWords(null)).toBe("Another valid rotate token, one being replaced, becomes current: collectors that enroll or restart are handed it.");
  });

  it.each([
    ["a token being replaced", tokens.beingReplaced, [tokens.current, tokens.beingReplaced, tokens.defaultToken]],
    ["the only valid rotate token", tokens.current, [tokens.current, tokens.expired, tokens.revoked, tokens.defaultToken]],
    ["the current token with a successor", tokens.current, [tokens.current, tokens.beingReplaced, tokens.defaultToken]],
  ])("has no such clause for %s while the fleet's default token is valid", async (_which, token, list) => {
    await renderDialog(token, list);
    expect(dialog()).not.toHaveTextContent(/no valid default token/);
  });

  it("names no successor when the token being replaced is the one revoked", async () => {
    await renderDialog(tokens.beingReplaced);
    expect(dialog()).not.toHaveTextContent(successorWords(tokens.current.expiresAt));
  });

  it("says what refusing the default token does, and that a new one can then be issued", async () => {
    await renderDialog(tokens.defaultToken);
    expect(dialog()).toHaveTextContent(DEFAULT_REVOKE);
    expect(DEFAULT_REVOKE).toBe(
      "Collectors still on the default token (those that don't accept connection settings, and every collector while the fleet is suspended) are refused within 10 seconds. New collectors can no longer enroll with it, and collectors whose supervisors restart are refused (they present it). You can then issue a new default token and re-run the install command on each host.",
    );
    expect(dialog()).toHaveTextContent("1 collector seen in the last 5 minutes is on it.");
    expect(dialog()).not.toHaveTextContent(/Collectors holding it|suspends the fleet|Another valid rotate token/);
  });

  it("on a Kubernetes-supervisor fleet, ends the default token's words with Install with Helm, not hosts' install commands", async () => {
    await renderDialog(tokens.defaultToken, undefined, "kubernetes-supervisor");
    expect(dialog()).toHaveTextContent(DEFAULT_REVOKE_KUBERNETES);
    expect(DEFAULT_REVOKE_KUBERNETES).toBe(
      "Collectors still on the default token (those that don't accept connection settings, and every collector while the fleet is suspended) are refused within 10 seconds. New collectors can no longer enroll with it, and collectors whose supervisors restart are refused (they present it). You can issue a new default token, then run each group's Install with Helm again.",
    );
    expect(dialog()).not.toHaveTextContent(/install command|docker/);
  });

  it("keeps a rotate token's words on a Kubernetes-supervisor fleet, and the server fleet's default token words free of Helm", async () => {
    await renderDialog(tokens.current, undefined, "kubernetes-supervisor");
    expect(dialog()).toHaveTextContent(rotateRefusedWords(true));
    expect(dialog()).not.toHaveTextContent(/Helm/);
  });

  it("never speaks of Helm on a server fleet's default token", async () => {
    await renderDialog(tokens.defaultToken, undefined, "server");
    expect(dialog()).not.toHaveTextContent(/Helm/);
  });

  it.each([
    [0, "No collector seen in the last 5 minutes is on it.", false],
    [1, "1 collector seen in the last 5 minutes is on it.", true],
    [3, "3 collectors seen in the last 5 minutes are on it.", true],
  ])("says the active count %s as %j, destructive when any", async (count, words, destructive) => {
    expect(activeWords(count)).toBe(words);
    await renderDialog({ ...tokens.beingReplaced, activeCollectors: count });
    const sentence = screen.getByText(words);
    if (destructive) expect(sentence).toHaveClass("text-fail");
    else expect(sentence).not.toHaveClass("text-fail");
  });

  it("has its title and buttons", async () => {
    await renderDialog();
    expect(screen.getByRole("button", { name: "Revoke token" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("RevokeTokenDialog's revoke", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes, says "Revoking..." and stays open until the API answers, then toasts "Token revoked", closes and reloads', async () => {
    let finish!: () => void;
    const spy = vi.spyOn(apiClient, "revokeEnrollmentToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ token: tokens.current });
        }),
    );
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onRevoked } = await renderDialog(tokens.beingReplaced);

    await user.click(revokeButton());
    expect(spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, tokens.beingReplaced.id, { signal: expect.any(AbortSignal) });
    expect(screen.getByRole("button", { name: "Revoking..." })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Token revoked");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends once on a double click", async () => {
    const revokes = serveRevokes("hang");
    await renderDialog();
    fireEvent.click(revokeButton());
    fireEvent.click(revokeButton());
    expect(revokes.spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 404 enrollment_token_not_found", () => refusal("enrollment_token_not_found", "Enrollment token not found.", 404), "Enrollment token not found."],
    ["a 404 fleet_not_found", () => refusal("fleet_not_found", "Fleet not found.", 404), "Fleet not found."],
    ["a 503, the 503's words", () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503), FLEETS_UNAVAILABLE_MESSAGE],
    ["no connection, the 503's words", () => refusal("network_error", "Network error", 0), FLEETS_UNAVAILABLE_MESSAGE],
  ])("on %s, toasts its words, closes and reloads", async (_why, failure, words) => {
    serveRevokes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRevoked } = await renderDialog();

    await user.click(revokeButton());

    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(words);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ends a revoke that never answers at 30 s: toasts the 503's words, closes and reloads", async () => {
    const revokes = serveRevokes("hang");
    const toastError = vi.spyOn(toast, "error");
    const { onRevoked } = await renderDialog();

    vi.useFakeTimers();
    fireEvent.click(revokeButton());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(revokes.signals[0]!.aborted).toBe(false);
    expect(onRevoked).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(revokes.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
  });

  it.each([
    ["a 429, its own words", () => refusal("rate_limited", RATE_LIMITED_WORDS, 429), RATE_LIMITED_WORDS],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), REVOKE_FAILED_MESSAGE],
  ])("on %s, toasts and stays open for another try", async (_why, failure, words) => {
    serveRevokes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRevoked } = await renderDialog();

    await user.click(revokeButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revoke token" })).toBeEnabled();
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveRevokes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRevoked, loader } = await renderDialog();
    const loads = loader.mock.calls.length;

    await user.click(revokeButton());

    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    serveRevokes(refusal("unauthenticated", "You need to sign in.", 401));
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await user.click(revokeButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke token" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can't be closed while revoking: Cancel disabled, Escape does nothing", async () => {
    serveRevokes("hang");
    const { user, onOpenChange } = await renderDialog();

    await user.click(revokeButton());

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("closes on Cancel without a request", async () => {
    const revokes = serveRevokes();
    const { user, onOpenChange, onRevoked } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(revokes.spy).not.toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it.each([
    ["the revoke", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.resolve()],
    ["a 404", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(refusal("enrollment_token_not_found", "Enrollment token not found.", 404))],
    ["a 503", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503))],
  ])("drops %s answered after the organization changed: no toast, no close, no reload", async (_why, answer) => {
    let settle!: { resolve: () => void; reject: (failure: unknown) => void };
    vi.spyOn(apiClient, "revokeEnrollmentToken").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve: () => resolve({ token: tokens.current }), reject };
        }),
    );
    const toastError = vi.spyOn(toast, "error");
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onRevoked } = await renderDialog();

    await user.click(revokeButton());
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => answer(settle));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('opens afresh: no "Revoking..." left from an opening a revoke outlived', async () => {
    serveRevokes(refusal("rate_limited", RATE_LIMITED_WORDS, 429));
    const { user } = await renderDialog();
    await user.click(revokeButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke token" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(await screen.findByRole("button", { name: "Revoke token" })).toBeEnabled();
  });
});
