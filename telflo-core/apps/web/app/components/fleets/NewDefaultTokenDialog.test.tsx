import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenRevealedResponse, type FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { expectNoAttributeHolds, expectTextOnlyInsideNoCapture, FLEET_ID } from "~/test/fleets.js";
import {
  CONTAINER_REINSTALL,
  DEFAULT_TOKEN_EXISTS,
  ISSUE_DEFAULT_FAILED_MESSAGE,
  NEW_DEFAULT_DESCRIPTION,
  NEW_DEFAULT_DESCRIPTION_KUBERNETES,
  NEW_DEFAULT_RESULT,
  NEW_DEFAULT_RESULT_KUBERNETES,
  NewDefaultTokenDialog,
} from "./NewDefaultTokenDialog.js";

/*
 * A new default token (D17c-1 decisions 4 and 45; Preflight ruling 31), to
 * follow a revoked default token. The tab's side (the button only without a
 * valid default token, the reloads, the focus) is in `TokensTab.test.tsx`.
 */

const NEW_ID = "c0ffee00-0000-4000-8000-0000000000d1";
const BEARER = "tfd_new-default-canary-5b3e";
const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const issued = (bearer = BEARER): EnrollmentTokenRevealedResponse => ({ token: { id: NEW_ID, kind: "default", bearer, expiresAt: null } });
const EXISTS = () => refusal("enrollment_token_default_exists", "The fleet already has a valid default token.", 409);

type Answer = EnrollmentTokenRevealedResponse | "hang" | Error;

function serveIssues(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "issueDefaultEnrollmentToken").mockImplementation((organizationId, fleetId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    signals.push(options.signal);
    const answer = answers.shift() ?? issued();
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

/** The dialog open in GROUP_ID for a fleet of `fleetType`, with a Switch to another organization and a Reopen. */
async function renderDialog(fleetType: FleetType = "server") {
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
        <button type="button" onClick={() => setOpen(false)}>
          Close from outside
        </button>
        <NewDefaultTokenDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          fleetType={fleetType}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog");
  return { user, onOpenChange, onChanged, loader };
}

const dialog = () => screen.getByRole("dialog", { name: "New default token" });
const button = (name: string) => within(dialog()).getByRole("button", { name });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NewDefaultTokenDialog (decision 45)", () => {
  it("says what issuing does, with Cancel and Issue token, and sends nothing until asked", async () => {
    const { spy } = serveIssues();
    await renderDialog();
    expect(dialog()).toHaveTextContent(NEW_DEFAULT_DESCRIPTION);
    expect(NEW_DEFAULT_DESCRIPTION).toBe(
      "Issues a new default token for installing collectors. The revoked one stays revoked: collectors whose supervisors restart with it are refused until their install command is re-run with the new token.",
    );
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Cancel", "Issue token", "Close"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('issues one: "Issuing…", then the bearer only inside ph-no-capture with its words and Done, and the tab reloads', async () => {
    let finish!: () => void;
    const spy = vi.spyOn(apiClient, "issueDefaultEnrollmentToken").mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(issued()))),
    );
    const { user, onChanged, onOpenChange } = await renderDialog();
    await user.click(button("Issue token"));
    expect(button("Issuing…")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    expect(within(dialog()).queryByRole("button", { name: "Close" })).toBeNull();
    expect(spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { signal: expect.any(AbortSignal) });
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(await within(dialog()).findByText(BEARER)).toBeInTheDocument();
    expectTextOnlyInsideNoCapture(BEARER);
    expect(button("Copy default token")).toBeInTheDocument();
    expect(dialog()).toHaveTextContent(NEW_DEFAULT_RESULT);
    expect(NEW_DEFAULT_RESULT).toBe("It is shown now only; Reveal gives it again. Re-run the install command on each host that used the revoked token.");
    // Ruling 62: a container host's re-install meets the old container's fixed name.
    expect(dialog()).toHaveTextContent(CONTAINER_REINSTALL);
    expect(CONTAINER_REINSTALL).toBe(
      "On a container host, remove the old container first (docker rm -f telflo-collector); keep the telflo-opamp volume to keep the same collector.",
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);

    await user.click(button("Done"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(BEARER);
    expectNoAttributeHolds(BEARER);
  });

  it("on a Kubernetes-supervisor fleet, speaks of its groups' Helm releases and Install with Helm, whose pods restart with the new token: no install command, no container line, no kubectl (Ruling 55; D17d-2 Preflight ruling 32; D18 decision 30)", async () => {
    serveIssues();
    const { user } = await renderDialog("kubernetes-supervisor");
    expect(dialog()).toHaveAccessibleDescription(NEW_DEFAULT_DESCRIPTION_KUBERNETES);
    expect(NEW_DEFAULT_DESCRIPTION_KUBERNETES).toBe(
      "Issues a new default token for installing collectors. The revoked one stays revoked: pods that start with it are refused until their group's Helm release is upgraded with the new token.",
    );
    await user.click(button("Issue token"));
    expect(await within(dialog()).findByText(BEARER)).toBeInTheDocument();
    expectTextOnlyInsideNoCapture(BEARER);
    expect(dialog()).toHaveTextContent(NEW_DEFAULT_RESULT_KUBERNETES);
    expect(NEW_DEFAULT_RESULT_KUBERNETES).toBe(
      "It is shown now only; Reveal gives it again. Run each group's Install with Helm again: its pods restart with the new token.",
    );
    expect(dialog()).not.toHaveTextContent(/install command|docker|container host|kubectl|rollout/);
  });

  it("on a server fleet, keeps the install command's and the container's words, never the Helm release's", async () => {
    serveIssues();
    const { user } = await renderDialog("server");
    expect(dialog()).toHaveAccessibleDescription(NEW_DEFAULT_DESCRIPTION);
    await user.click(button("Issue token"));
    expect(await within(dialog()).findByText(BEARER)).toBeInTheDocument();
    expect(dialog()).toHaveTextContent(`${NEW_DEFAULT_RESULT}${CONTAINER_REINSTALL}`);
    expect(dialog()).not.toHaveTextContent(/Helm/);
  });

  it("sends once on a double click", async () => {
    const { spy } = serveIssues("hang");
    await renderDialog();
    fireEvent.click(button("Issue token"));
    fireEvent.click(button("Issuing…"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("can't be closed while issuing: no X, Escape and an outside click do nothing", async () => {
    serveIssues("hang");
    const { user, onOpenChange } = await renderDialog();
    await user.click(button("Issue token"));
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it.each([
    ["fleet_archived", refusal("fleet_archived", "The fleet is archived.", 409), "The fleet is archived.", true],
    ["a 429", refusal("rate_limited", "Too many requests. Try again in 30 seconds.", 429), "Too many requests. Try again in 30 seconds.", false],
    ["an unknown refusal", refusal("invalid_request", "The request was not valid.", 400), ISSUE_DEFAULT_FAILED_MESSAGE, false],
  ])("shows %s's words in the dialog, which stays open with Issue token", async (_which, failure, words, reloads) => {
    serveIssues(failure);
    const { user, onOpenChange, onChanged } = await renderDialog();
    await user.click(button("Issue token"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    expect(ISSUE_DEFAULT_FAILED_MESSAGE).toBe("Failed to issue token");
    expect(button("Issue token")).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(reloads ? 1 : 0);
  });

  it("says the fleet already has a valid default token (another member issued one), reloads the tab, and leaves only Close", async () => {
    serveIssues(EXISTS());
    const { user, onChanged, onOpenChange } = await renderDialog();
    await user.click(button("Issue token"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(DEFAULT_TOKEN_EXISTS);
    expect(DEFAULT_TOKEN_EXISTS).toBe("The fleet already has a valid default token: Reveal shows it.");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(dialog()).queryByRole("button", { name: "Issue token" })).toBeNull();
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Close", "Close"]);
    await user.click(within(dialog()).getAllByRole("button", { name: "Close" }).find((each) => each.textContent === "Close")!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 503", () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503)],
    // Task 1's review: the opamp-server made the token, then failed to mint its bearer (a 500): a valid default token nobody received.
    ["a 500 after the token was made", () => refusal("internal_error", "Something went wrong.", 500)],
    ["no connection", () => new ApiError("network_error", "Could not reach the server.")],
  ])("after %s, shows the 503's words with Try again and reloads the tab; a retry answering 409 says Reveal shows it", async (_why, failure) => {
    const { spy } = serveIssues(failure(), EXISTS());
    const { user, onChanged } = await renderDialog();
    await user.click(button("Issue token"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(dialog()).queryByRole("button", { name: "Issue token" })).toBeNull();

    await user.click(button("Try again"));
    expect(await within(dialog()).findByText(DEFAULT_TOKEN_EXISTS)).toBeInTheDocument();
    expect(screen.queryByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("after an unknown outcome, a retry that issues shows the bearer", async () => {
    serveIssues(refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503), issued());
    const { user } = await renderDialog();
    await user.click(button("Issue token"));
    await within(dialog()).findByRole("alert");
    await user.click(button("Try again"));
    expect(await within(dialog()).findByText(BEARER)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ends an issue that never answers at 30 s, with the 503's words and Try again", async () => {
    const { signals } = serveIssues("hang");
    await renderDialog();
    vi.useFakeTimers();
    fireEvent.click(button("Issue token"));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(signals[0]!.aborted).toBe(false);
    expect(button("Issuing…")).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signals[0]!.aborted).toBe(true);
    vi.useRealTimers();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(button("Try again")).toBeEnabled();
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads", async () => {
    serveIssues(refusal("fleet_not_found", "Fleet not found.", 404));
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog();
    await user.click(button("Issue token"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveIssues(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged, loader } = await renderDialog();
    const loads = loader.mock.calls.length;
    await user.click(button("Issue token"));
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    serveIssues(refusal("unauthenticated", "You need to sign in.", 401));
    const { user, onOpenChange } = await renderDialog();
    await user.click(button("Issue token"));
    await waitFor(() => expect(button("Issue token")).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    ["the bearer", (settle: { resolve: (value: EnrollmentTokenRevealedResponse) => void }) => settle.resolve(issued())],
    ["a 503", (settle: { reject: (failure: unknown) => void }) => settle.reject(refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503))],
  ] as const)("drops %s answered after the organization changed: nothing shown, no reload", async (_why, answerWith) => {
    let settle!: { resolve: (value: EnrollmentTokenRevealedResponse) => void; reject: (failure: unknown) => void };
    vi.spyOn(apiClient, "issueDefaultEnrollmentToken").mockImplementation(() => new Promise((resolve, reject) => (settle = { resolve, reject })));
    const { user, onChanged } = await renderDialog();
    await user.click(button("Issue token"));
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => answerWith(settle));
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(BEARER);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["Done", "done"],
    ["Escape", "escape"],
    ["a close from outside (the page closes it)", "outside"],
  ] as const)(
    "gives the bearer up as the dialog closes by %s, while its content is still mounted for the exit animation (the Task 7 review's P1)",
    async (_how, how) => {
      // Radix's Presence keeps the content while an exit animation runs: one emulated through the computed style.
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
        const style = real(element, pseudo);
        if (!element.hasAttribute?.("data-state")) return style;
        return new Proxy(style, {
          get: (target, key) =>
            key === "animationName" ? (element.getAttribute("data-state") === "closed" ? "exit" : "enter") : (Reflect.get(target, key) as unknown),
        });
      });
      serveIssues(issued());
      const { user } = await renderDialog();
      await user.click(button("Issue token"));
      await within(dialog()).findByText(BEARER);
      expect(getComputedStyle(dialog()).animationName).toBe("enter");
      if (how === "done") await user.click(button("Done"));
      else if (how === "escape") await user.keyboard("{Escape}");
      else fireEvent.click(screen.getByRole("button", { name: "Close from outside", hidden: true }));
      // Closing, still mounted (the emulated exit animation): the bearer already gone from it.
      const closing = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(getComputedStyle(closing).animationName).toBe("exit");
      expect(document.body.textContent).not.toContain(BEARER);
    },
  );

  it("opens afresh: no earlier refusal, and the bearer gone once closed", async () => {
    serveIssues(issued());
    const { user } = await renderDialog();
    await user.click(button("Issue token"));
    await within(dialog()).findByText(BEARER);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(BEARER);
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("dialog");
    expect(button("Issue token")).toBeEnabled();
    expect(dialog()).not.toHaveTextContent(BEARER);
  });
});
