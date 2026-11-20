import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProductAdmin, ProductAdminsResponse } from "@telflo/contracts";
import { LAST_PRODUCT_ADMIN_MESSAGE, PRODUCT_ADMIN_NOT_FOUND_MESSAGE, PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import {
  PRODUCT_ADMIN_ADD_FAILED_MESSAGE,
  PRODUCT_ADMIN_INVALID_EMAIL_MESSAGE,
  PRODUCT_ADMIN_REMOVE_FAILED_MESSAGE,
  PRODUCT_ADMINS_LOAD_FAILED_MESSAGE,
  PRODUCT_ADMINS_READ_TIMEOUT_MS,
  ProductAdminsPage,
} from "./ProductAdminsPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { MEMBER_ID, signedInMember } from "~/test/configurations.js";
import { attributesHolding } from "~/test/fleets.js";
import { holdsText, quietQueries, showsText, waitUntilGone } from "~/test/service-accounts.js";

/*
 * The Product admins page: the list with "(you)", Add by exact email,
 * Remove behind a confirmation, each refusal's toast in fixed words (the
 * last-admin 409 among them), a removal of yourself going to `/app`, a 403
 * going there too, and replay's rules: the typed email inside
 * `ph-no-capture` with no placeholder, no email in an attribute, a toast,
 * the title or the page's address.
 *
 * The API is its client's functions, spied on; toasts are spied on. Emails
 * are other people's personal data: checked as booleans with fixed labels
 * (showsText, holdsText, attributesHolding's count), the queries quieted
 * so a failure prints no DOM.
 */

const ME: ProductAdmin = { id: MEMBER_ID, email: "zq-me@example.com" };
const ANA: ProductAdmin = { id: "0199f400-0000-7000-8000-000000000001", email: "zq-ana@example.com" };
const BEN: ProductAdmin = { id: "0199f400-0000-7000-8000-000000000002", email: "zq-ben@example.com" };
/** The API's order (by email); the page shows it as it comes. */
const ADMINS = [ANA, BEN, ME];
const EMAILS = ADMINS.map((admin) => admin.email);
const TYPED = "zq-cara@example.com";

const FORBIDDEN = new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 });
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
const TARGET_NOT_FOUND = new ApiError("product_admin_target_not_found", PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE, { status: 404 });
const NOT_ONE = new ApiError("product_admin_not_found", PRODUCT_ADMIN_NOT_FOUND_MESSAGE, { status: 404 });
const LAST_ADMIN = new ApiError("last_product_admin", LAST_PRODUCT_ADMIN_MESSAGE, { status: 409 });
const RATE_LIMITED = new ApiError("rate_limited", "Too many requests. Try again shortly.", { status: 429, retryAfterSeconds: 30 });
const SERVER_ERROR = new ApiError("unexpected_response", "Unexpected response", { status: 500 });

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

/** The router's address as the page last rendered under it: path, query and hash. */
let pageAddress = "";

function PageAt() {
  const location = useLocation();
  pageAddress = location.pathname + location.search + location.hash;
  return <ProductAdminsPage />;
}

function renderPage() {
  pageAddress = "";
  const Stub = createRoutesStub([
    { path: "/product-admin/product-admins", Component: PageAt },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/product-admins"]} />);
  return { user: userEvent.setup() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let list: MockInstance<typeof apiClient.getProductAdmins>;
let grant: MockInstance<typeof apiClient.grantProductAdmin>;
let remove: MockInstance<typeof apiClient.removeProductAdmin>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;
let loud: () => void;

beforeEach(() => {
  vi.restoreAllMocks();
  loud = quietQueries();
  localStorage.clear();
  sessionStorage.clear();
  useUserStore.getState().clear();
  const member = signedInMember();
  useUserStore.getState().setCurrent({ ...member, user: { id: ME.id, email: ME.email }, isProductAdmin: true });
  list = vi.spyOn(apiClient, "getProductAdmins").mockResolvedValue({ items: ADMINS });
  grant = vi.spyOn(apiClient, "grantProductAdmin").mockResolvedValue({ id: "0199f400-0000-7000-8000-000000000003", email: TYPED });
  remove = vi.spyOn(apiClient, "removeProductAdmin").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

afterEach(() => {
  loud();
  vi.useRealTimers();
});

type User = ReturnType<typeof userEvent.setup>;

/** The table's body rows. */
const bodyRows = () => screen.getAllByRole("row").slice(1);

/** The row whose Email cell shows `email` (found by a boolean, never a query naming it). */
function rowOf(email: string): HTMLElement {
  const row = bodyRows().find((candidate) => within(candidate).getAllByRole("cell")[0]?.querySelector("span")?.textContent === email);
  if (row === undefined) throw new Error("no row shows that admin");
  return row;
}

/** Waits for the list, then opens `admin`'s Remove. */
async function openRemove(user: User, admin: ProductAdmin) {
  await screen.findByRole("table");
  await user.click(within(rowOf(admin.email)).getByRole("button", { name: /^Remove product admin / }));
  return screen.findByRole("dialog", { name: "Remove product admin" });
}

/** Types `text` into the email field. */
async function typeEmail(user: User, text: string) {
  const field = await screen.findByLabelText("Email");
  await user.type(field, text);
  return field as HTMLInputElement;
}

/** Whether local or session storage holds `text` in a key or a value, case aside (a boolean: nothing is printed). */
function storageHolds(text: string): boolean {
  const needle = text.toLowerCase();
  return [localStorage, sessionStorage].some((storage) =>
    Object.entries({ ...storage }).some(([key, value]) => `${key}\n${String(value)}`.toLowerCase().includes(needle)),
  );
}

/** Whether any toast was called with something holding `text`. */
const toastsHold = (text: string) => [...toastError.mock.calls, ...toastSuccess.mock.calls].some((call) => holdsText(call, text));

describe("the Product admins page", () => {
  it("lists the product admins in the API's order, '(you)' on the caller's row only, each with a Remove named by fixed words and the row's email cell", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Product admins" })).toBeInTheDocument();
    await screen.findByRole("table");

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Email", "Actions"]);
    const shown = bodyRows().map((row) => row.querySelector("td span")?.textContent ?? "");
    expect(shown.length).toBe(3);
    expect(shown.every((email, index) => email === EMAILS[index]), "the rows in the API's order").toBe(true);
    expect(bodyRows().map((row) => (within(row).getAllByRole("cell")[0]!.textContent ?? "").endsWith("(you)"))).toEqual([false, false, true]);

    for (const admin of ADMINS) {
      const button = within(rowOf(admin.email)).getByRole("button", { name: /^Remove product admin / });
      const [label, cell] = (button.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id));
      expect(label?.textContent).toBe("Remove product admin");
      expect(cell?.textContent === admin.email, "the Remove is named by the row's email cell").toBe(true);
    }
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("says 'Loading product admins...' until the first read answers, and 'No product admins' for an empty list", async () => {
    const answer = deferred<ProductAdminsResponse>();
    list.mockReturnValueOnce(answer.promise);
    renderPage();
    expect(await screen.findByText("Loading product admins...")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    answer.resolve({ items: [] });
    expect(await screen.findByRole("cell", { name: "No product admins" })).toBeInTheDocument();
  });

  it("toasts 'Failed to load product admins' when the read fails, shows no table and never 'No product admins'; Try again reads it", async () => {
    list.mockRejectedValueOnce(SERVER_ERROR).mockResolvedValueOnce({ items: [] });
    const { user } = renderPage();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(PRODUCT_ADMINS_LOAD_FAILED_MESSAGE));
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    expect({ table: screen.queryByRole("table") !== null, empty: screen.queryByText("No product admins") !== null }).toEqual({
      table: false,
      empty: false,
    });

    await user.click(tryAgain);
    expect(await screen.findByRole("cell", { name: "No product admins" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the listed admins when a later read fails (no Try again over a list)", async () => {
    list.mockResolvedValueOnce({ items: ADMINS }).mockRejectedValueOnce(SERVER_ERROR);
    const { user } = renderPage();
    const dialog = await openRemove(user, ANA);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(PRODUCT_ADMINS_LOAD_FAILED_MESSAGE));
    expect(bodyRows().length).toBe(3);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says nothing when the read fails because the session ended (the session-ended handler has the browser)", async () => {
    list.mockRejectedValueOnce(SESSION_ENDED);
    renderPage();
    await screen.findByRole("button", { name: "Try again" });
    expect(list).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("aborts a read that never answers after the hang guard and toasts it as a failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let signal: AbortSignal | undefined;
    list.mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () => reject(new ApiError("request_aborted", "aborted")));
        }),
    );
    renderPage();
    await waitFor(() => expect(signal).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRODUCT_ADMINS_READ_TIMEOUT_MS);
    });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(PRODUCT_ADMINS_LOAD_FAILED_MESSAGE));
  });

  it("goes to /app, replacing the page, when the read is refused 403 product_admin_required", async () => {
    list.mockRejectedValueOnce(FORBIDDEN);
    renderPage();
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  describe("Add product admin", () => {
    it("is disabled until an email is typed; sends the trimmed address, toasts 'Product admin added', empties the field and reads the list again", async () => {
      const { user } = renderPage();
      await screen.findByRole("table");
      const add = screen.getByRole("button", { name: "Add" });
      expect(add).toBeDisabled();
      const field = await typeEmail(user, `  ${TYPED.toUpperCase()} `);
      expect(add).toBeEnabled();
      await user.click(add);

      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin added"));
      expect(grant).toHaveBeenCalledOnce();
      expect(grant.mock.calls[0]![0].email === TYPED, "the address sent, trimmed and lower-cased").toBe(true);
      expect(field.value).toBe("");
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    });

    it("adds on Enter in the field", async () => {
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, `${TYPED}{Enter}`);
      await waitFor(() => expect(grant).toHaveBeenCalledOnce());
    });

    it("refuses an address the contract would refuse in fixed words, sending nothing", async () => {
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, "zq-not-an-address");
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(PRODUCT_ADMIN_INVALID_EMAIL_MESSAGE));
      expect(grant).not.toHaveBeenCalled();
    });

    it.each([
      ["404 product_admin_target_not_found", TARGET_NOT_FOUND, PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE],
      ["429 rate_limited", RATE_LIMITED, RATE_LIMITED.message],
      ["a 500", SERVER_ERROR, PRODUCT_ADMIN_ADD_FAILED_MESSAGE],
    ])("toasts a refused add (%s) in fixed words, keeping the field for another try", async (_label, error, words) => {
      grant.mockRejectedValueOnce(error);
      const { user } = renderPage();
      await screen.findByRole("table");
      const field = await typeEmail(user, TYPED);
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(field.value === TYPED, "the typed address kept").toBe(true);
      expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
      expect(list).toHaveBeenCalledOnce();
    });

    it("says nothing when the add fails because the session ended", async () => {
      grant.mockRejectedValueOnce(SESSION_ENDED);
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, TYPED);
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(grant).toHaveBeenCalledOnce());
      expect(toastError).not.toHaveBeenCalled();
    });

    it("goes to /app when the add is refused 403 product_admin_required (the flag lost while it waited)", async () => {
      grant.mockRejectedValueOnce(FORBIDDEN);
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, TYPED);
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("shows 'Adding...' and refuses a second send while the first is in flight", async () => {
      const answer = deferred<ProductAdmin>();
      grant.mockReturnValueOnce(answer.promise);
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, TYPED);
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByRole("button", { name: "Adding..." })).toBeDisabled();
      answer.resolve({ id: "0199f400-0000-7000-8000-000000000003", email: TYPED });
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin added"));
      expect(grant).toHaveBeenCalledOnce();
    });
  });

  describe("Remove", () => {
    it("asks 'Remove <email>'s product-admin role?' for another admin; Remove sends their id, toasts 'Product admin removed' and reads the list again, staying on the page", async () => {
      const { user } = renderPage();
      const dialog = await openRemove(user, ANA);
      expect(showsText(`Remove ${ANA.email}'s product-admin role?`, dialog), "the question names the admin").toBe(true);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));

      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin removed"));
      expect(remove).toHaveBeenCalledWith(ANA.id);
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(pageAddress).toBe("/product-admin/product-admins");
    });

    it("asks in its own words for yourself, and a removal of yourself goes to /app, replacing the page", async () => {
      const { user } = renderPage();
      const dialog = await openRemove(user, ME);
      expect(showsText("Remove your own product-admin role? You'll lose access to these pages at once.", dialog)).toBe(true);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
      expect(remove).toHaveBeenCalledWith(ME.id);
      expect(toastSuccess).toHaveBeenCalledWith("Product admin removed");
    });

    it("toasts the last-admin refusal (409 last_product_admin) in its fixed words, closes the confirmation and stays", async () => {
      remove.mockRejectedValueOnce(LAST_ADMIN);
      const { user } = renderPage();
      const dialog = await openRemove(user, ME);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Telflo needs at least one product admin."));
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(pageAddress).toBe("/product-admin/product-admins");
      expect(screen.queryByText(/landed on/)).toBeNull();
    });

    it("toasts 404 product_admin_not_found (removed by another admin meanwhile) in fixed words and reads the list again", async () => {
      remove.mockRejectedValueOnce(NOT_ONE);
      const { user } = renderPage();
      const dialog = await openRemove(user, BEN);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(PRODUCT_ADMIN_NOT_FOUND_MESSAGE));
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    });

    it.each([
      ["a 500", SERVER_ERROR, PRODUCT_ADMIN_REMOVE_FAILED_MESSAGE],
      ["429 rate_limited", RATE_LIMITED, RATE_LIMITED.message],
    ])("toasts a failed removal (%s) and leaves the confirmation open to try again", async (_label, error, words) => {
      remove.mockRejectedValueOnce(error);
      const { user } = renderPage();
      const dialog = await openRemove(user, ANA);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
      expect(within(dialog).getByRole("button", { name: "Remove" })).toBeEnabled();
      expect(screen.queryByRole("dialog") !== null, "the confirmation still open").toBe(true);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin removed"));
      expect(remove).toHaveBeenCalledTimes(2);
    });

    it("goes to /app when the removal is refused 403 product_admin_required", async () => {
      remove.mockRejectedValueOnce(FORBIDDEN);
      const { user } = renderPage();
      const dialog = await openRemove(user, ANA);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("shows 'Removing...' and can't be closed while it removes; Cancel sends nothing", async () => {
      const answer = deferred<undefined>();
      remove.mockReturnValueOnce(answer.promise);
      const { user } = renderPage();
      const dialog = await openRemove(user, ANA);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(await within(dialog).findByRole("button", { name: "Removing..." })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog") !== null, "still open while it removes").toBe(true);
      answer.resolve(undefined);
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");

      const again = await openRemove(user, BEN);
      expect(within(again).getByRole("button", { name: "Remove" })).toBeEnabled();
      await user.click(within(again).getByRole("button", { name: "Cancel" }));
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      expect(remove).toHaveBeenCalledOnce();
    });

    it("gives the focus back to the Remove that opened the confirmation when it is canceled", async () => {
      const { user } = renderPage();
      await screen.findByRole("table");
      const opener = within(rowOf(BEN.email)).getByRole("button", { name: /^Remove product admin / });
      await user.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "Remove product admin" });
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      await waitFor(() => expect(document.activeElement === opener, "the focus on the opener").toBe(true));
    });

    it("moves the focus to the email field when the removed admin's row has gone", async () => {
      list.mockResolvedValueOnce({ items: ADMINS }).mockResolvedValueOnce({ items: [BEN, ME] });
      const { user } = renderPage();
      const dialog = await openRemove(user, ANA);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitUntilGone(() => screen.queryByRole("dialog"), "the confirmation closed");
      await waitFor(() => expect(bodyRows().length).toBe(2));
      await waitFor(() => expect(document.activeElement === screen.getByLabelText("Email"), "the focus on the email field").toBe(true));
    });
  });

  describe("replay's rules", () => {
    it("keeps the typed email inside ph-no-capture with no placeholder, and no email in an attribute, storage, a toast, the title or the address", async () => {
      const { user } = renderPage();
      await screen.findByRole("table");
      const field = await typeEmail(user, TYPED);
      expect(field.closest(".ph-no-capture") !== null, "the email field inside ph-no-capture").toBe(true);
      expect(field.hasAttribute("placeholder"), "the email field has a placeholder").toBe(false);
      expect(storageHolds(TYPED.split("@")[0]!), "local or session storage holding the typed email, as typed").toBe(false);
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin added"));
      expect(storageHolds(TYPED.split("@")[0]!), "local or session storage holding the typed email, after the add").toBe(false);

      const dialog = await openRemove(user, ANA);
      expect(showsText(`Remove ${ANA.email}'s product-admin role?`, dialog)).toBe(true);
      for (const email of [...EMAILS, TYPED]) {
        expect(attributesHolding(email).length, "attributes holding an email").toBe(0);
        expect(attributesHolding(email.split("@")[0]!).length, "attributes holding an email's local part").toBe(0);
        expect(document.title.includes(email), "an email in the title").toBe(false);
        expect(storageHolds(email.split("@")[0]!), "local or session storage holding an email").toBe(false);
        expect(pageAddress.includes(email) || pageAddress.includes(encodeURIComponent(email)), "an email in the address").toBe(false);
      }
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Product admin removed"));
      expect(EMAILS.some(toastsHold) || toastsHold(TYPED) || toastsHold("zq-"), "a toast holding an email").toBe(false);
    });

    it("puts no email in a refusal's toast", async () => {
      grant.mockRejectedValueOnce(TARGET_NOT_FOUND);
      remove.mockRejectedValueOnce(LAST_ADMIN);
      const { user } = renderPage();
      await screen.findByRole("table");
      await typeEmail(user, TYPED);
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
      const dialog = await openRemove(user, ME);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
      expect(toastsHold("zq-"), "a toast holding an email").toBe(false);
    });
  });
});
