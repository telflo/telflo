import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import userEvent from "@testing-library/user-event";
import { Outlet, createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type CreateFleetRequest,
  type EnrollmentTokenListed,
  type EnrollmentTokenRevealedResponse,
} from "@telflo/contracts";
import {
  CREATE_FAILED_MESSAGE,
  EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE,
  MAY_ALREADY_EXIST_MESSAGE,
  UNKNOWN_OUTCOME_MESSAGE,
} from "./NewFleetDialog.js";
import { NewServerFleetDialog } from "./NewServerFleetDialog.js";
import { COPY_THEM_NOW } from "./CreatedFleetTokens.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type FleetCreateOutcome } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID } from "~/test/configurations.js";
import { DEFAULT_TOKEN_ID, FLEET_ID, ROTATE_TOKEN_ID, fleet, fleetCreated, listedToken } from "~/test/fleets.js";

/*
 * The server fleet's create dialog, and through it the create every dialog
 * shares (`NewFleetDialog`).
 */

const DEFAULT_BEARER = fleetCreated().tokens.default.bearer;
const ROTATE_BEARER = fleetCreated().tokens.rotate.bearer;
const REVEALED_DEFAULT = "tfd_revealed-default-canary";
const REVEALED_ROTATE = "tfr_revealed-rotate-canary";
const BEARERS = [DEFAULT_BEARER, ROTATE_BEARER, REVEALED_DEFAULT, REVEALED_ROTATE];

const DAY_MS = 86_400_000;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const refusal = (code: string, message: string, status: number, options: { details?: unknown; retryAfterSeconds?: number } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const RATE_LIMITED = () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429, { retryAfterSeconds: 30 });
const LABEL_TAKEN = () => refusal("fleet_label_taken", "Another of the organization's fleets has this label.", 409);
const CONFLICT = () => refusal("fleet_conflict", "A fleet with this id already exists.", 409);
const TERMS = () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403);
const ORGANIZATION_GONE = () => refusal("organization_not_found", "Organization not found", 404);
const SESSION_ENDED = () => refusal("unauthenticated", "You need to sign in.", 401);

/** Each way a create can end with its outcome unknown, but the 30 s abort (its own test). */
const UNKNOWN_OUTCOMES: Array<[string, () => ApiError]> = [
  ["a 503", UNAVAILABLE],
  ["a 500", () => refusal("internal_error", "Something went wrong.", 500)],
  ["a 502 with an HTML body", () => new ApiError("unexpected_response", "The server returned an unexpected error.", { status: 502 })],
  ["a network_error", () => new ApiError("network_error", "Could not reach the server. Check your connection.")],
  ["a 201 that doesn't parse", () => new ApiError("unexpected_response", "The server returned an unexpected response.")],
];

/** Where Done went: the fleet's page. */
function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/** The dialog open on the list's page (which can reopen it), with a loader to count revalidations. */
async function renderDialog() {
  const onOpenChange = vi.fn();
  const onMayHaveCreated = vi.fn();
  const loader = vi.fn(() => null);

  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <NewServerFleetDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          organizationId={GROUP_ID}
          onMayHaveCreated={onMayHaveCreated}
        />
      </>
    );
  }

  const Stub = createRoutesStub([
    { path: "/fleet-management", Component: Page, loader, HydrateFallback: () => null },
    { path: "/fleet-management/:fleetId", Component: Landed },
  ]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "New server fleet" });
  return { user, onOpenChange, onMayHaveCreated, loader };
}

type Answer = "created" | "existing" | "hang" | Error;

/** The create, answering each call in turn (then "created"); every request and signal kept. */
function serveCreates(...answers: Answer[]) {
  const requests: CreateFleetRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "createFleet").mockImplementation((organizationId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    requests.push(request);
    signals.push(options.signal);
    const answer = answers.shift() ?? "created";
    const made = { id: request.id ?? FLEET_ID, label: request.label, type: request.type };
    if (answer === "created") {
      const created = fleetCreated(made);
      return Promise.resolve<FleetCreateOutcome>({ kind: "created", ...created });
    }
    if (answer === "existing") return Promise.resolve<FleetCreateOutcome>({ kind: "existing", fleet: fleet(made) });
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return Promise.reject(answer);
  });
  return { spy, requests, signals };
}

type User = ReturnType<typeof userEvent.setup>;

function nameField() {
  return screen.getByLabelText("Name");
}

function expiryField() {
  return screen.getByRole("combobox", { name: "Token expiry" });
}

async function typeAndCreate(user: User, label = "edge-prod") {
  await user.type(nameField(), label);
  await user.click(screen.getByRole("button", { name: "Create fleet" }));
}

/** The dialog after an unknown outcome: locked, with "Try again". */
async function expectLocked() {
  expect(await screen.findByText(UNKNOWN_OUTCOME_MESSAGE)).toBeInTheDocument();
  expect(nameField()).toBeDisabled();
  expect(expiryField()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Create fleet" })).toBeNull();
}

async function tryAgain(user: User) {
  await user.click(screen.getByRole("button", { name: "Try again" }));
}

/** The tokens step, with both of these bearers. */
async function expectTokens(defaultBearer = DEFAULT_BEARER, rotateBearer = ROTATE_BEARER) {
  expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
  expect(screen.getByText(maskSecret(defaultBearer))).toBeInTheDocument();
  expect(screen.getByText(maskSecret(rotateBearer))).toBeInTheDocument();
  expect(screen.getByText(COPY_THEM_NOW)).toBeInTheDocument();
}

/**
 * Masked, no text holds a whole bearer; shown (both Show buttons pressed),
 * every text node holding one is inside `ph-no-capture`; and no attribute
 * anywhere holds one.
 */
function expectBearersOnlyInNoCapture() {
  for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
  fireEvent.click(screen.getByRole("button", { name: "Show default token" }));
  fireEvent.click(screen.getByRole("button", { name: "Show rotate token" }));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let found = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!BEARERS.some((bearer) => node.textContent?.includes(bearer))) continue;
    found += 1;
    expect(node.parentElement?.closest(".ph-no-capture"), "a bearer outside ph-no-capture").not.toBeNull();
  }
  expect(found).toBeGreaterThan(0);
  for (const element of document.documentElement.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      for (const bearer of BEARERS) expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain(bearer);
    }
  }
  expect(document.querySelector("input, textarea")).toBeNull();
}

/** Every toast's arguments, none holding a bearer. */
function expectNoBearerInAToast(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  for (const spy of spies) {
    const said = JSON.stringify(spy.mock.calls);
    for (const bearer of BEARERS) expect(said).not.toContain(bearer);
  }
}

/** The events Radix listens for, outside the dialog (user-event won't click through the overlay). */
function clickOutside() {
  const shown = screen.getByRole("dialog");
  const overlay = shown.previousElementSibling ?? document.body;
  fireEvent.pointerDown(overlay);
  fireEvent.mouseDown(overlay);
  fireEvent.click(overlay);
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
}

/** The fleet's tokens as a retry's 200 path finds them, newest first. */
const LISTED_TOKENS: EnrollmentTokenListed[] = [
  listedToken({ id: "7a000000-0000-4000-8000-000000000001", revokedAt: "2026-10-13T10:00:00.000Z" }),
  listedToken({ id: "7a000000-0000-4000-8000-000000000002", doRefresh: true, expiresAt: "2026-10-20T10:00:00.000Z" }),
  listedToken({ id: ROTATE_TOKEN_ID, expiresAt: "2027-10-13T09:00:00.000Z" }),
  listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }),
];

function revealed(tokenId: string): EnrollmentTokenRevealedResponse {
  return tokenId === DEFAULT_TOKEN_ID
    ? { token: { id: tokenId, kind: "default", bearer: REVEALED_DEFAULT, expiresAt: null } }
    : { token: { id: tokenId, kind: "rotate", bearer: REVEALED_ROTATE, expiresAt: "2027-10-13T09:00:00.000Z" } };
}

function serveTokens(tokens: EnrollmentTokenListed[] | Error | "hang" = LISTED_TOKENS) {
  return vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation((_organizationId, _fleetId, options = {}) => {
    if (tokens === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return tokens instanceof Error ? Promise.reject(tokens) : Promise.resolve({ tokens });
  });
}

function serveReveals(answer: (tokenId: string, signal: AbortSignal | undefined) => Promise<EnrollmentTokenRevealedResponse> = (tokenId) =>
  Promise.resolve(revealed(tokenId))) {
  return vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation((_organizationId, _fleetId, tokenId, options = {}) =>
    answer(tokenId, options.signal),
  );
}

describe("NewServerFleetDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(toast, "success");
    vi.spyOn(toast, "warning");
    vi.spyOn(toast, "error");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks only for a name and token expiry — no configuration or version pickers", async () => {
    await renderDialog();
    expect(nameField()).toBeInTheDocument();
    expect(expiryField()).toHaveTextContent("Never");
    expect(screen.queryByLabelText("Configuration")).toBeNull();
    expect(screen.queryByLabelText("Version")).toBeNull();
    expect(screen.getByText("Fleet name must be unique within your organization.")).toBeInTheDocument();
    expect(
      screen.getByText("Collectors authenticate to this fleet with a token. You can rotate or revoke it at any time from the Tokens tab."),
    ).toBeInTheDocument();
  });

  it("disables submit until a name is entered, spaces alone not counting", async () => {
    const { user } = await renderDialog();
    const submit = screen.getByRole("button", { name: "Create fleet" });
    expect(submit).toBeDisabled();
    await user.type(nameField(), "   ");
    expect(submit).toBeDisabled();
    await user.type(nameField(), "prod-otel-fleet");
    expect(submit).toBeEnabled();
  });

  it("creates a server fleet with the dialog's id, then shows both tokens once; Done opens the fleet's page", async () => {
    const created = serveCreates("created");
    const { user, onOpenChange, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user, "prod-otel-fleet");

    expect(created.requests).toEqual([{ id: expect.stringMatching(V4), label: "prod-otel-fleet", type: "server", rotateExpiresAt: null }]);
    expect(created.signals[0]).toBeInstanceOf(AbortSignal);
    await expectTokens();
    expect(screen.getByText("The one an install uses. It never expires.")).toBeInTheDocument();
    expect(screen.getByText("It never expires.")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Fleet "prod-otel-fleet" created');

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(`landed on /fleet-management/${created.requests[0]!.id}`)).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMayHaveCreated).not.toHaveBeenCalled();
  });

  // The name.

  it("sends the label trimmed", async () => {
    const created = serveCreates("created");
    const { user } = await renderDialog();
    await typeAndCreate(user, "  edge-prod  ");
    await expectTokens();
    expect(created.requests[0]!.label).toBe("edge-prod");
  });

  it("shows the contract's refusal of a trimmed name under the field, and sends nothing", async () => {
    const created = serveCreates("created");
    const { user } = await renderDialog();
    fireEvent.change(nameField(), { target: { value: " edge\u0007prod " } });
    await user.click(screen.getByRole("button", { name: "Create fleet" }));

    const problem = await screen.findByText("Must not start or end with a space, or hold a control character.");
    expect(problem).toHaveAttribute("role", "alert");
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(nameField().getAttribute("aria-describedby")).toContain(problem.id);
    expect(created.spy).not.toHaveBeenCalled();

    // Editing the name clears it.
    await user.type(nameField(), "x");
    expect(screen.queryByText("Must not start or end with a space, or hold a control character.")).toBeNull();
  });

  it("caps the name at 80 characters", async () => {
    await renderDialog();
    expect(nameField()).toHaveAttribute("maxLength", "80");
  });

  // The Token expiry's instants.

  it.each([
    ["180 days", 180],
    ["1 year", 365],
    ["2 years", 730],
  ])("sends %s as the send's own now plus that many days, computed again at each send", async (preset, days) => {
    const start = Date.parse("2026-10-14T09:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const created = serveCreates(UNAVAILABLE(), "created");
    const { user } = await renderDialog();
    await user.type(nameField(), "edge-prod");
    await user.click(expiryField());
    await user.click(await screen.findByRole("option", { name: preset }));
    expect(expiryField()).toHaveTextContent(preset);
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    await expectLocked();
    expect(created.requests[0]!.rotateExpiresAt).toBe(new Date(start + days * DAY_MS).toISOString());

    // An hour later, the retry's instant is an hour later too.
    vi.setSystemTime(start + 3_600_000);
    await tryAgain(user);
    await expectTokens();
    expect(created.requests[1]!.rotateExpiresAt).toBe(new Date(start + 3_600_000 + days * DAY_MS).toISOString());
    expect(created.requests[1]!.id).toBe(created.requests[0]!.id);
  });

  it("says when the rotate token expires, from the create's answer", async () => {
    vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => {
      const created = fleetCreated({ id: request.id!, label: request.label });
      return { kind: "created", ...created, tokens: { ...created.tokens, rotate: { ...created.tokens.rotate, expiresAt: "2027-10-14T09:00:00.000Z" } } };
    });
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectTokens();
    expect(screen.getByText(/^It expires Oct 14, 2027, /)).toBeInTheDocument();
  });

  // Refusals with no unknown outcome.

  it.each([
    ["label", "/label", "Name"],
    ["rotateExpiresAt", "/rotateExpiresAt", "Token expiry"],
  ])("shows a 400's %s problem under its field, the dialog open", async (path, instancePath, field) => {
    const message = path === "label" ? "Must be 1 to 80 characters." : "Must be a time in the future.";
    const details = [{ instancePath, params: { issue: { path: [path], message } }, message }];
    serveCreates(refusal("invalid_request", "The request was not valid.", 400, { details }));
    const { user } = await renderDialog();
    await typeAndCreate(user);

    const problem = await screen.findByText(message);
    const control = field === "Name" ? nameField() : expiryField();
    expect(control.getAttribute("aria-describedby")).toContain(problem.id);
    expect(screen.queryByText("The request was not valid.")).toBeNull();
    expect(screen.getByRole("button", { name: "Create fleet" })).toBeEnabled();
  });

  it("shows 'Failed to create fleet' for a 400 naming no field, never invalid_request's own message", async () => {
    serveCreates(refusal("invalid_request", "The request was not valid.", 400, { details: [{ instancePath: "/type", message: "No." }] }));
    const { user } = await renderDialog();
    await typeAndCreate(user);
    expect(await screen.findByText(CREATE_FAILED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("The request was not valid.")).toBeNull();
  });

  it("shows a 409 fleet_label_taken in the dialog, the fields open, the id kept", async () => {
    const created = serveCreates(LABEL_TAKEN(), "created");
    const { user } = await renderDialog();
    await typeAndCreate(user, "taken");
    expect(await screen.findByText(LABEL_TAKEN().message)).toBeInTheDocument();
    expect(nameField()).toBeEnabled();

    await user.clear(nameField());
    await typeAndCreate(user, "free");
    await expectTokens();
    expect(created.requests[1]).toMatchObject({ id: created.requests[0]!.id, label: "free" });
  });

  it("makes a new id on a 409 fleet_conflict before any unknown outcome (another organization's fleet), the dialog open", async () => {
    const created = serveCreates(CONFLICT(), "created");
    const { user, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user);
    expect(await screen.findByText(CONFLICT().message)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "New server fleet" })).toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    await expectTokens();
    expect(created.requests[1]!.id).toMatch(V4);
    expect(created.requests[1]!.id).not.toBe(created.requests[0]!.id);
    expect(onMayHaveCreated).not.toHaveBeenCalled();
  });

  it("shows a 429's words, the fields open", async () => {
    serveCreates(RATE_LIMITED());
    const { user } = await renderDialog();
    await typeAndCreate(user);
    expect(await screen.findByText(RATE_LIMITED().message)).toBeInTheDocument();
    expect(nameField()).toBeEnabled();
  });

  it("says nothing when the session has ended: the session-ended handler has the page", async () => {
    serveCreates(SESSION_ENDED());
    const { user } = await renderDialog();
    await typeAndCreate(user);
    expect(await screen.findByRole("button", { name: "Create fleet" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ["terms_acceptance_required", TERMS],
    ["organization_not_found", ORGANIZATION_GONE],
  ])("closes and revalidates the layout on a %s, with no toast", async (_code, failure) => {
    serveCreates(failure());
    const { user, loader, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(toast.error).not.toHaveBeenCalled();
    expect(onMayHaveCreated).not.toHaveBeenCalled();
  });

  // Unknown outcomes.

  it.each(UNKNOWN_OUTCOMES)("locks the fields after %s, and Try again resends the same id, label and type", async (_name, failure) => {
    const created = serveCreates(failure(), "created");
    const { user } = await renderDialog();
    await typeAndCreate(user, " edge-prod ");
    await expectLocked();
    // The create shows its own words, not the 503's "reload before trying again".
    expect(screen.queryByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeNull();

    await tryAgain(user);
    await expectTokens();
    expect(created.requests).toHaveLength(2);
    expect(created.requests[1]).toEqual(created.requests[0]);
    expect(created.requests[1]).toMatchObject({ label: "edge-prod", type: "server" });
  });

  it("ends a create that never answers at 30 s, as an unknown outcome, and retries with the same id", async () => {
    const created = serveCreates("hang", "created");
    const { user } = await renderDialog();
    await user.type(nameField(), "edge-prod");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Create fleet" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(created.signals[0]!.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(created.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    await expectLocked();
    await tryAgain(user);
    await expectTokens();
    expect(created.requests[1]).toEqual(created.requests[0]);
  });

  it("keeps the lock through a 429 while locked, showing its words", async () => {
    const created = serveCreates(UNAVAILABLE(), RATE_LIMITED(), "created");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);
    expect(await screen.findByText(RATE_LIMITED().message)).toBeInTheDocument();
    await expectLocked();

    await tryAgain(user);
    await expectTokens();
    expect(created.requests.map((request) => request.id)).toEqual(Array(3).fill(created.requests[0]!.id));
  });

  it("unlocks on a 409 fleet_label_taken while locked, the id kept", async () => {
    const created = serveCreates(UNAVAILABLE(), LABEL_TAKEN(), "created");
    const { user } = await renderDialog();
    await typeAndCreate(user, "taken");
    await expectLocked();
    await tryAgain(user);

    expect(await screen.findByText(LABEL_TAKEN().message)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_OUTCOME_MESSAGE)).toBeNull();
    expect(nameField()).toBeEnabled();
    expect(expiryField()).toBeEnabled();
    await user.clear(nameField());
    await typeAndCreate(user, "free");
    await expectTokens();
    expect(created.requests[2]).toMatchObject({ id: created.requests[0]!.id, label: "free" });
  });

  it("closes on a 409 fleet_conflict while locked, toasting that the fleet may already exist, and reloads the list", async () => {
    const created = serveCreates(UNAVAILABLE(), CONFLICT());
    const { user, onMayHaveCreated, onOpenChange } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.warning).toHaveBeenCalledWith(MAY_ALREADY_EXIST_MESSAGE);
    expect(onMayHaveCreated).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(created.requests).toHaveLength(2);
    expect(created.requests[1]!.id).toBe(created.requests[0]!.id);
  });

  it("still closes on a fleet_conflict after a fleet_label_taken unlocked an unknown outcome's lock, the id kept", async () => {
    const created = serveCreates(UNAVAILABLE(), LABEL_TAKEN(), CONFLICT());
    const { user, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user, "taken");
    await expectLocked();
    await tryAgain(user);
    await screen.findByText(LABEL_TAKEN().message);
    await user.clear(nameField());
    await typeAndCreate(user, "renamed");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.warning).toHaveBeenCalledWith(MAY_ALREADY_EXIST_MESSAGE);
    expect(onMayHaveCreated).toHaveBeenCalledTimes(1);
    expect(new Set(created.requests.map((request) => request.id)).size).toBe(1);
  });

  it.each([
    ["terms_acceptance_required", TERMS],
    ["organization_not_found", ORGANIZATION_GONE],
  ])("closes and revalidates on a %s while locked too, reloading the list", async (_code, failure) => {
    serveCreates(UNAVAILABLE(), failure());
    const { user, loader, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(onMayHaveCreated).toHaveBeenCalledTimes(1);
  });

  it("reloads the list when closed after an unknown outcome, and not otherwise", async () => {
    serveCreates(RATE_LIMITED(), UNAVAILABLE());
    const { user, onMayHaveCreated } = await renderDialog();
    await typeAndCreate(user);
    await screen.findByText(RATE_LIMITED().message);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onMayHaveCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await typeAndCreate(user);
    await expectLocked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onMayHaveCreated).toHaveBeenCalledTimes(1);
  });

  // The 200 path: a retry finds the fleet made.

  it("on a 200, reads the fleet's tokens and reveals the default and the newest rotate token neither revoked nor rotated", async () => {
    const created = serveCreates(UNAVAILABLE(), "existing");
    const tokens = serveTokens();
    const reveals = serveReveals();
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);

    await expectTokens(REVEALED_DEFAULT, REVEALED_ROTATE);
    const fleetId = created.requests[0]!.id!;
    expect(tokens).toHaveBeenCalledWith(GROUP_ID, fleetId, { signal: expect.any(AbortSignal) });
    expect(reveals).toHaveBeenCalledTimes(2);
    expect(reveals.mock.calls.map((call) => call[2]).sort()).toEqual([DEFAULT_TOKEN_ID, ROTATE_TOKEN_ID].sort());
    for (const call of reveals.mock.calls) {
      expect(call[0]).toBe(GROUP_ID);
      expect(call[1]).toBe(fleetId);
      expect(call[3]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(screen.getByText(/^It expires Oct 13, 2027, /)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Fleet "edge-prod" created');
    expectBearersOnlyInNoCapture();
  });

  it.each<[string, () => void]>([
    ["the tokens can't be read", () => serveTokens(UNAVAILABLE())],
    ["there is no default token", () => serveTokens(LISTED_TOKENS.filter((token) => token.kind !== "default"))],
    ["no rotate token is valid", () => serveTokens(LISTED_TOKENS.filter((token) => token.id !== ROTATE_TOKEN_ID))],
    [
      "a reveal is refused 429",
      () => {
        serveTokens();
        serveReveals((tokenId) => (tokenId === ROTATE_TOKEN_ID ? Promise.reject(RATE_LIMITED()) : Promise.resolve(revealed(tokenId))));
      },
    ],
    [
      "a reveal finds its token expired",
      () => {
        serveTokens();
        serveReveals((tokenId) =>
          tokenId === DEFAULT_TOKEN_ID
            ? Promise.reject(refusal("enrollment_token_expired", "The enrollment token has expired.", 409))
            : Promise.resolve(revealed(tokenId)),
        );
      },
    ],
  ])("on a 200, says the tokens couldn't be shown when %s; Done opens the fleet's page", async (_name, serve) => {
    const created = serveCreates(UNAVAILABLE(), "existing");
    serve();
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);

    expect(await screen.findByText(EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE)).toBeInTheDocument();
    for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(`landed on /fleet-management/${created.requests[0]!.id}`)).toBeInTheDocument();
  });

  it("on a 200, ends a tokens read that never answers at 30 s, with the same words", async () => {
    serveCreates(UNAVAILABLE(), "existing");
    const tokens = serveTokens("hang");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    const signal = tokens.mock.calls[0]![2]!.signal!;
    expect(signal.aborted).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signal.aborted).toBe(true);
    expect(screen.getByText(EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE)).toBeInTheDocument();
  });

  it("on a 200, ends reveals that never answer at 30 s, with the same words", async () => {
    serveCreates(UNAVAILABLE(), "existing");
    serveTokens();
    const signals: Array<AbortSignal | undefined> = [];
    serveReveals((tokenId, signal) => {
      signals.push(signal);
      // The default answers; the rotate token's never does.
      if (tokenId === DEFAULT_TOKEN_ID) return Promise.resolve(revealed(tokenId));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    });
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(screen.getByText(EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE)).toBeInTheDocument();
    for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
  });

  it("on a 200, aborts the other reveal when one fails, with the same words", async () => {
    serveCreates(UNAVAILABLE(), "existing");
    serveTokens();
    const signals = new Map<string, AbortSignal | undefined>();
    serveReveals((tokenId, signal) => {
      signals.set(tokenId, signal);
      // The default's is refused; the rotate token's would never answer but for its signal.
      if (tokenId === DEFAULT_TOKEN_ID) return Promise.reject(RATE_LIMITED());
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    });
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectLocked();
    await tryAgain(user);

    // Long before the 30 s hang guard: the failure itself aborted the rotate token's reveal.
    expect(await screen.findByText(EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE)).toBeInTheDocument();
    expect(signals.size).toBe(2);
    expect(signals.get(ROTATE_TOKEN_ID)?.aborted).toBe(true);
    for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
  });

  // The id.

  it("makes the id with getRandomValues where crypto.randomUUID is missing (an insecure origin)", async () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn((array: Uint8Array) => real.getRandomValues(array));
    vi.stubGlobal("crypto", { getRandomValues });
    const created = serveCreates("created");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectTokens();
    expect(getRandomValues).toHaveBeenCalled();
    expect(created.requests[0]!.id).toMatch(V4);
  });

  it("makes a new id at each opening", async () => {
    const created = serveCreates(RATE_LIMITED(), "created");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await screen.findByText(RATE_LIMITED().message);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    // A fresh form: empty, unlocked, no old words.
    expect(nameField()).toHaveValue("");
    expect(screen.queryByText(RATE_LIMITED().message)).toBeNull();
    await typeAndCreate(user);
    await expectTokens();
    expect(created.requests[1]!.id).not.toBe(created.requests[0]!.id);
  });

  it("sends once for a double Enter", async () => {
    let finish!: () => void;
    const create = vi.spyOn(apiClient, "createFleet").mockImplementation(
      (_organizationId, request) =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: "created", ...fleetCreated({ id: request.id!, label: request.label }) });
        }),
    );
    const { user } = await renderDialog();
    await user.type(nameField(), "edge-prod{Enter}");
    fireEvent.submit(nameField().closest("form")!);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await expectTokens();
  });

  it("sends once for two submits in one batch, before any re-render (the re-entry guard)", async () => {
    const create = vi.spyOn(apiClient, "createFleet").mockImplementation(() => new Promise(() => undefined));
    const { user } = await renderDialog();
    await user.type(nameField(), "edge-prod");
    const form = nameField().closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });

  // Closing, and the bearers.

  it("can't be closed while the create is under way: Cancel disabled, no X, Escape and an outside click do nothing", async () => {
    let fail!: () => void;
    vi.spyOn(apiClient, "createFleet").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(RATE_LIMITED());
        }),
    );
    const { user, onOpenChange } = await renderDialog();
    await typeAndCreate(user);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(nameField()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    await user.keyboard("{Escape}");
    clickOutside();
    expect(screen.getByRole("dialog", { name: "New server fleet" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => fail());
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes only on Done once the tokens show: no X, Escape and an outside click do nothing", async () => {
    serveCreates("created");
    const { user, onOpenChange } = await renderDialog();
    await typeAndCreate(user);
    await expectTokens();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    await user.keyboard("{Escape}");
    clickOutside();
    expect(screen.getByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    expect(screen.getByText(maskSecret(DEFAULT_BEARER))).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows the bearers only inside ph-no-capture, never in an attribute or a toast, and forgets them on Done", async () => {
    serveCreates("created");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectTokens();

    expectBearersOnlyInNoCapture();
    expect(screen.getByRole("button", { name: "Copy default token" }).closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy rotate token" }).closest(".ph-no-capture")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText(/landed on/);
    for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
    expectNoBearerInAToast(vi.mocked(toast.success), vi.mocked(toast.warning), vi.mocked(toast.error));
  });

  it("forgets the bearers on Done itself, the route change aside", async () => {
    serveCreates("created");
    const onOpenChange = vi.fn();
    // The dialog in a layout both paths share, kept open: Done's navigation and close unmount nothing.
    function Layout() {
      return (
        <>
          <NewServerFleetDialog open onOpenChange={onOpenChange} organizationId={GROUP_ID} />
          <Outlet />
        </>
      );
    }
    const Stub = createRoutesStub([
      {
        Component: Layout,
        children: [
          { path: "/fleet-management", Component: () => null },
          { path: "/fleet-management/:fleetId", Component: Landed },
        ],
      },
    ]);
    render(<Stub initialEntries={["/fleet-management"]} />);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "New server fleet" });
    await typeAndCreate(user);
    await expectTokens();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText(/landed on/);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Still mounted and open, and the bearers gone from it.
    expect(screen.getByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    for (const bearer of BEARERS) expect(document.body.textContent).not.toContain(bearer);
    expect(screen.queryByRole("button", { name: /^Copy / })).toBeNull();
  });

  it("copies a bearer to the clipboard alone, never to a toast", async () => {
    serveCreates("created");
    const { user } = await renderDialog();
    await typeAndCreate(user);
    await expectTokens();
    // Copy reads Copied without the bearer reaching anything but the clipboard.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await user.click(screen.getByRole("button", { name: "Copy default token" }));
    expect(writeText).toHaveBeenCalledWith(DEFAULT_BEARER);
    expectNoBearerInAToast(vi.mocked(toast.success), vi.mocked(toast.warning), vi.mocked(toast.error));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
});
