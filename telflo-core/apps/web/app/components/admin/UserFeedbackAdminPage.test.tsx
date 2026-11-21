import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FEEDBACK_DEFAULT_REPLY, type UserFeedbackItem, type UserFeedbackPage } from "@telflo/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Outlet, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import {
  FEEDBACK_ACKNOWLEDGE_FAILED_MESSAGE,
  FEEDBACK_ACKNOWLEDGED_MESSAGE,
  FEEDBACK_ADMIN_LOAD_FAILED_MESSAGE,
  FEEDBACK_DISMISS_FAILED_MESSAGE,
  FEEDBACK_DISMISSED_MESSAGE,
  UserFeedbackAdminPage,
} from "./UserFeedbackAdminPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { formatDateTime } from "~/lib/format.js";
import { attributesHolding } from "~/test/fleets.js";
import { holdsText, quietQueries, showsText, waitUntilGone } from "~/test/service-accounts.js";

/*
 * Product admin's User Feedback page: its texts; the pending list with "Load
 * more"; the full text; acknowledge (the default reply, Ok disabled while
 * blank, "Sending...") and dismiss, each removing the row and revalidating
 * the layout (the nav's count); a deleted sender's row with Dismiss only; the
 * refusals (an item handled meanwhile or its sender deleted: the API's words
 * and the list read again; 403 to /app; an ended session silent); replay's
 * rules (no email, text or reply in an attribute or a toast; the reply's box
 * uncontrolled inside `ph-no-capture`).
 *
 * The emails and texts are made-up fixtures; checks on them are booleans
 * with fixed labels, and failed queries print no DOM (quietQueries).
 */

const BEN_EMAIL = "zq-ben@example.com";

/** Whether browser storage (localStorage, sessionStorage, the page's cookies) holds `text`: a boolean, nothing printed. */
function storageHolds(text: string): boolean {
  const stores = [window.localStorage, window.sessionStorage];
  const inStore = stores.some((store) =>
    Array.from({ length: store.length }, (_, index) => store.key(index) ?? "").some(
      (key) => key.includes(text) || (store.getItem(key) ?? "").includes(text),
    ),
  );
  return inStore || document.cookie.includes(text);
}

const CARA_ANONYMOUS = "deleted-0123456789abcdef01234567@deleted-accounts.telflo.invalid";
const LONG_TEXT = `zq-feedback ${"please add a Kafka receiver and more. ".repeat(10)}`;

function feedback(overrides: Partial<UserFeedbackItem> = {}): UserFeedbackItem {
  return {
    id: "0199f400-0000-7000-8000-000000000001",
    email: BEN_EMAIL,
    text: LONG_TEXT,
    createdAt: "2026-10-26T12:00:00.000Z",
    authorDeleted: false,
    ...overrides,
  };
}

const BENS = feedback();
const CARAS = feedback({ id: "0199f400-0000-7000-8000-000000000002", email: CARA_ANONYMOUS, text: "zq-cara's words", authorDeleted: true });
const THIRD = feedback({ id: "0199f400-0000-7000-8000-000000000003", text: "zq-third words", createdAt: "2026-10-20T08:30:00.000Z" });

const FORBIDDEN = new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 });
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
const NOT_FOUND = new ApiError("feedback_not_found", "Feedback not found.", { status: 404 });
const AUTHOR_DELETED = new ApiError("feedback_author_deleted", "The sender's account was deleted, so no reply can be sent.", {
  status: 409,
});
const SERVER_ERROR = new ApiError("unexpected_response", "Unexpected response", { status: 500 });

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

let layoutLoads = 0;

/** The page under a layout whose loader counts its runs (the nav's pending count), `/app` beside it. */
function renderPage() {
  layoutLoads = 0;
  const Stub = createRoutesStub([
    {
      id: "routes/product-admin",
      Component: Outlet,
      loader: () => {
        layoutLoads += 1;
        return null;
      },
      HydrateFallback: () => null,
      children: [{ path: "/product-admin/user-feedback", Component: UserFeedbackAdminPage }],
    },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/user-feedback"]} />);
  return userEvent.setup();
}

const page = (items: UserFeedbackItem[], nextCursor: string | null = null): UserFeedbackPage => ({ items, nextCursor });

let list: MockInstance<typeof apiClient.getUserFeedback>;
let acknowledge: MockInstance<typeof apiClient.acknowledgeFeedback>;
let dismiss: MockInstance<typeof apiClient.dismissFeedback>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;
let unquiet: () => void;

beforeEach(() => {
  vi.restoreAllMocks();
  unquiet = quietQueries();
  list = vi.spyOn(apiClient, "getUserFeedback").mockResolvedValue(page([BENS, CARAS]));
  acknowledge = vi.spyOn(apiClient, "acknowledgeFeedback").mockResolvedValue(undefined);
  dismiss = vi.spyOn(apiClient, "dismissFeedback").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

afterEach(() => {
  unquiet();
});

/** The body's rows, in order (an open dialog hides the page from the accessibility tree: found hidden too). */
const bodyRows = () => screen.getAllByRole("row", { hidden: true }).slice(1);

/** Whether `text` is in any toast's arguments (a boolean). */
const toastsHold = (text: string) => holdsText([toastError.mock.calls, toastSuccess.mock.calls], text);

async function loadedPage() {
  const user = renderPage();
  await screen.findByRole("heading", { name: "Pending User Feedback" });
  await waitUntilGone(() => screen.queryByText("Loading feedback..."), "loading ended");
  return user;
}

describe("UserFeedbackAdminPage", () => {
  it("shows the heading and loading words, then the pending items: Email, Feedback, Created At, Actions; a deleted sender's row with Dismiss only", async () => {
    let answer: (value: UserFeedbackPage) => void = () => undefined;
    list.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    renderPage();
    expect(await screen.findByText("Loading feedback...")).toBeInTheDocument();
    answer(page([BENS, CARAS]));
    await waitUntilGone(() => screen.queryByText("Loading feedback..."), "loading ended");

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Email", "Feedback", "Created At", "Actions"]);
    const [ben, cara] = bodyRows();
    expect({
      benEmail: within(ben!).getAllByRole("cell")[0]!.textContent === BEN_EMAIL,
      benText: within(ben!).getAllByRole("button")[0]!.textContent === LONG_TEXT,
      benCreated: within(ben!).getAllByRole("cell")[2]!.textContent === formatDateTime(BENS.createdAt),
      benActions: within(ben!)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
      caraEmail: within(cara!).getAllByRole("cell")[0]!.textContent === CARA_ANONYMOUS,
      caraActions: within(cara!)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    }).toEqual({
      benEmail: true,
      benText: true,
      benCreated: true,
      benActions: ["Acknowledge", "Dismiss"],
      caraEmail: true,
      caraActions: ["Dismiss"],
    });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("names each row's actions through aria-labelledby, the action and the row's email; no attribute or title holds an email or a text", async () => {
    await loadedPage();
    const [ben] = bodyRows();
    const [, acknowledgeButton, dismissButton] = within(ben!).getAllByRole("button");
    const name = (element: HTMLElement) =>
      (element.getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect({
      acknowledge: name(acknowledgeButton!) === `Acknowledge ${BEN_EMAIL}`,
      dismiss: name(dismissButton!) === `Dismiss ${BEN_EMAIL}`,
    }).toEqual({
      acknowledge: true,
      dismiss: true,
    });
    expect({
      email: attributesHolding(BEN_EMAIL).length,
      anonymous: attributesHolding(CARA_ANONYMOUS).length,
      text: attributesHolding("zq-feedback").length,
      caraText: attributesHolding("zq-cara").length,
      titles: document.querySelectorAll("[title]").length,
      inDocumentTitle: document.title.includes("zq"),
    }).toEqual({ email: 0, anonymous: 0, text: 0, caraText: 0, titles: 0, inDocumentTitle: false });
  });

  it('says "No pending user feedback" with none pending', async () => {
    list.mockResolvedValue(page([]));
    await loadedPage();
    expect(screen.getByText("No pending user feedback")).toBeInTheDocument();
  });

  it('opens the full text in a dialog titled Feedback (sr-only "Full feedback text"), the focus back on the text\'s button as it closes', async () => {
    const user = await loadedPage();
    const textButton = within(bodyRows()[0]!).getAllByRole("button")[0]!;
    await user.click(textButton);
    const dialog = await screen.findByRole("dialog", { name: "Feedback" });
    expect(within(dialog).getByText("Full feedback text")).toHaveClass("sr-only");
    expect(showsText(LONG_TEXT, dialog)).toBe(true);
    await user.keyboard("{Escape}");
    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Feedback" }), "the dialog closed");
    expect(document.activeElement === textButton).toBe(true);
  });

  it('acknowledges with the edited reply, trimmed: "Feedback acknowledged", the row gone, the layout revalidated; the reply in no attribute or toast', async () => {
    const user = await loadedPage();
    const loadsBefore = layoutLoads;
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Acknowledge / }));
    const dialog = await screen.findByRole("dialog", { name: "Acknowledge Feedback" });
    expect(within(dialog).getByText("Edit the response below. This will be emailed to the user.")).toBeInTheDocument();
    const box = within(dialog).getByRole("textbox", { name: "Response" }) as HTMLTextAreaElement;
    expect(box.value).toBe(FEEDBACK_DEFAULT_REPLY);
    expect({ insideNoCapture: box.closest(".ph-no-capture") !== null, maxLength: box.maxLength }).toEqual({
      insideNoCapture: true,
      maxLength: 5000,
    });
    const ok = within(dialog).getByRole("button", { name: "Ok" });
    expect(ok).toBeEnabled();

    await user.clear(box);
    await user.type(box, "   ");
    expect(ok).toBeDisabled();
    const reply = "zq-reply-marker: thanks, it's on the list.";
    await user.type(box, `${reply}\n`);
    expect(ok).toBeEnabled();
    expect({ attributes: attributesHolding("zq-reply-marker").length, storage: storageHolds("zq-reply-marker") }).toEqual({
      attributes: 0,
      storage: false,
    });
    await user.click(ok);

    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Acknowledge Feedback" }), "the dialog closed");
    expect(acknowledge.mock.calls.length).toBe(1);
    expect({ id: acknowledge.mock.calls[0]![0], trimmed: acknowledge.mock.calls[0]![1].reply === reply }).toEqual({
      id: BENS.id,
      trimmed: true,
    });
    expect(toastSuccess).toHaveBeenCalledWith(FEEDBACK_ACKNOWLEDGED_MESSAGE);
    expect(bodyRows().length).toBe(1);
    await waitFor(() => expect(layoutLoads).toBeGreaterThan(loadsBefore));
    expect(toastsHold("zq-reply-marker") || toastsHold(BEN_EMAIL) || toastsHold("zq-feedback")).toBe(false);
    // The heading takes the focus: the row's button went with the row.
    expect(document.activeElement === screen.getByRole("heading", { name: "Pending User Feedback" })).toBe(true);
  });

  it('shows "Sending..." while it acknowledges and can\'t be closed; a failure keeps the dialog and the reply, toasting "Failed to acknowledge feedback"', async () => {
    let fail: (error: unknown) => void = () => undefined;
    acknowledge.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const user = await loadedPage();
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Acknowledge / }));
    const dialog = await screen.findByRole("dialog", { name: "Acknowledge Feedback" });
    await user.click(within(dialog).getByRole("button", { name: "Ok" }));
    expect(within(dialog).getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Acknowledge Feedback" }) !== null).toBe(true);

    fail(SERVER_ERROR);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]![0]).toBe(FEEDBACK_ACKNOWLEDGE_FAILED_MESSAGE);
    expect(within(dialog).getByRole("button", { name: "Ok" })).toBeEnabled();
    expect((within(dialog).getByRole("textbox", { name: "Response" }) as HTMLTextAreaElement).value).toBe(FEEDBACK_DEFAULT_REPLY);
    expect(bodyRows().length).toBe(2);
  });

  it("answers a deleted sender's 409 with the API's words, closes and reads the list again (the row now Dismiss only), revalidating", async () => {
    acknowledge.mockRejectedValue(AUTHOR_DELETED);
    const user = await loadedPage();
    list.mockResolvedValue(page([feedback({ authorDeleted: true, email: CARA_ANONYMOUS, id: BENS.id }), CARAS]));
    const loadsBefore = layoutLoads;
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Acknowledge / }));
    await user.click(within(await screen.findByRole("dialog", { name: "Acknowledge Feedback" })).getByRole("button", { name: "Ok" }));

    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Acknowledge Feedback" }), "the dialog closed");
    expect(toastError).toHaveBeenCalledWith(AUTHOR_DELETED.message, { className: "ph-no-capture" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(bodyRows()[0]!).queryByRole("button", { name: /^Acknowledge / })).toBeNull());
    await waitFor(() => expect(layoutLoads).toBeGreaterThan(loadsBefore));
  });

  it('dismisses: "Feedback dismissed", the row gone, the layout revalidated, no email asked for', async () => {
    const user = await loadedPage();
    const loadsBefore = layoutLoads;
    await user.click(within(bodyRows()[1]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(bodyRows().length).toBe(1));
    expect(dismiss.mock.calls).toEqual([[CARAS.id]]);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(FEEDBACK_DISMISSED_MESSAGE);
    await waitFor(() => expect(layoutLoads).toBeGreaterThan(loadsBefore));
  });

  it('answers an item handled meanwhile (404) with the API\'s words and reads the list again; another failure "Failed to dismiss feedback", the row kept', async () => {
    dismiss.mockRejectedValueOnce(NOT_FOUND).mockRejectedValueOnce(SERVER_ERROR);
    const user = await loadedPage();
    list.mockResolvedValue(page([CARAS]));
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(bodyRows().length).toBe(1));
    expect(toastError).toHaveBeenCalledWith(NOT_FOUND.message, { className: "ph-no-capture" });
    expect(list).toHaveBeenCalledTimes(2);

    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    expect(toastError.mock.calls[1]![0]).toBe(FEEDBACK_DISMISS_FAILED_MESSAGE);
    expect(bodyRows().length).toBe(1);
  });

  it("reads the first page again when every loaded row is handled while more are pending: never the empty row with Load more hidden", async () => {
    list.mockResolvedValueOnce(page([BENS, CARAS], "cursor-1")).mockResolvedValueOnce(page([THIRD]));
    const user = await loadedPage();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
    await user.click(within(bodyRows()[1]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(bodyRows().length).toBe(1));
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / }));

    await waitFor(() => expect(showsText("zq-third words")).toBe(true));
    expect({ reads: list.mock.calls.length, firstPage: list.mock.calls[1]![0] }).toEqual({ reads: 2, firstPage: {} });
    expect(screen.queryByText("No pending user feedback")).toBeNull();
  });

  it("keeps Dismiss focusable while it sends (aria-disabled, never disabled: a browser would drop the focus to the body), and a second press sends nothing", async () => {
    let finish: () => void = () => undefined;
    dismiss.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(undefined))));
    const user = await loadedPage();
    const button = within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / });
    await user.click(button);
    expect({
      disabled: button.hasAttribute("disabled"),
      ariaDisabled: button.getAttribute("aria-disabled"),
      focused: document.activeElement === button,
    }).toEqual({
      disabled: false,
      ariaDisabled: "true",
      focused: true,
    });
    await user.click(button);
    expect(dismiss).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(bodyRows().length).toBe(1));
    expect(document.activeElement === within(bodyRows()[0]!).getAllByRole("button")[1]).toBe(true);
  });

  it("moves the focus from a dismissed row to the row now in its place, then the row before, then the heading", async () => {
    list.mockResolvedValue(page([BENS, CARAS, THIRD]));
    const user = await loadedPage();
    const actionOf = (index: number) => within(bodyRows()[index]!).getAllByRole("button")[1]!;

    // Bens's row (first): the focus to the row now first (Cara's: Dismiss is its only action).
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(bodyRows().length).toBe(2));
    expect(document.activeElement === actionOf(0)).toBe(true);
    expect(actionOf(0).textContent).toBe("Dismiss");

    // The last row: to the row before it.
    await user.click(within(bodyRows()[1]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(bodyRows().length).toBe(1));
    expect(document.activeElement === actionOf(0)).toBe(true);

    // The only row: to the heading.
    await user.click(within(bodyRows()[0]!).getByRole("button", { name: /^Dismiss / }));
    await waitFor(() => expect(screen.queryByText("No pending user feedback") !== null).toBe(true));
    expect(document.activeElement === screen.getByRole("heading", { name: "Pending User Feedback" })).toBe(true);
  });

  it('reads the next page with "Load more", appended, until the last', async () => {
    list.mockResolvedValueOnce(page([BENS, CARAS], "cursor-1")).mockResolvedValueOnce(page([CARAS, THIRD]));
    const user = await loadedPage();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(bodyRows().length).toBe(3));
    expect(list.mock.calls[1]![0]).toEqual({ cursor: "cursor-1" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(showsText("zq-third words")).toBe(true);
  });

  it("goes to /app, replacing the page, on 403 product_admin_required on the read", async () => {
    list.mockRejectedValue(FORBIDDEN);
    renderPage();
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("goes to /app, replacing the page, on 403 product_admin_required on a dismiss", async () => {
    list.mockResolvedValue(page([BENS]));
    dismiss.mockRejectedValue(FORBIDDEN);
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /^Dismiss / }));
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts "Failed to load feedback" when the list can\'t be read, shows no table and never "No pending user feedback"; Try again reads it', async () => {
    list.mockRejectedValueOnce(SERVER_ERROR).mockResolvedValueOnce(page([]));
    const user = await loadedPage();
    expect(toastError).toHaveBeenCalledWith(FEEDBACK_ADMIN_LOAD_FAILED_MESSAGE);
    expect({ table: screen.queryByRole("table") !== null, empty: screen.queryByText("No pending user feedback") !== null }).toEqual({
      table: false,
      empty: false,
    });

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No pending user feedback")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says nothing when the session ended (the session-ended handler has the page)", async () => {
    list.mockRejectedValue(SESSION_ENDED);
    await loadedPage();
    expect(list).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
