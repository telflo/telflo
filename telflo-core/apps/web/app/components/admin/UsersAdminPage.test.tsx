import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import type { AdminUser, AdminUsersPage } from "@telflo/contracts";
import { BLOCKED_WITHOUT_ROW, USER_DELETED_MESSAGE } from "./UserDeleteDialog.js";
import { USERS_LOAD_FAILED_MESSAGE, USERS_SUBTITLE, UsersAdminPage } from "./UsersAdminPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { signedInMember } from "~/test/configurations.js";
import { quietQueries } from "~/test/service-accounts.js";

/*
 * The Users page: its states (loading, the list with "(you)" and no Delete on
 * the caller's row, the two empty rows), the search sent as `q` after the
 * pause and never in the address, an attribute or storage, Load more with the
 * same term, the read's failures (a toast, the way out on a 403, nothing when
 * the session ended), and the delete's outcomes through the page: the row
 * gone; a block that appeared since the list read again with the same term
 * and shown from the row taken by id, or by its kind alone when the row is
 * gone; busy toasted with the dialog kept open. Replay's rules: no email or
 * organization name in an attribute, a toast, the title or the address.
 * Emails and organization names are fixtures with the marker "zq", compared
 * as booleans only.
 */

const ME = "0199f400-0000-7000-8000-0000000000a1";
const ANA_EMAIL = "zq-ana@example.com";

function adminUser(n: number, overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: `0199f400-0000-7000-8000-0000000000${(0xb0 + n).toString(16)}`,
    email: `zq-person-${n}@example.com`,
    createdAt: "2026-10-01T12:00:00.000Z",
    isProductAdmin: false,
    block: null,
    ...overrides,
  };
}

const SELF: AdminUser = { id: ME, email: ANA_EMAIL, createdAt: "2026-09-01T12:00:00.000Z", isProductAdmin: true, block: { kind: "product_admin" } };
const CARA = adminUser(1);
const DAN = adminUser(2, { block: { kind: "member", organizationName: "zq-Shared Team", role: "admin" } });
const PAGE: AdminUsersPage = { items: [SELF, CARA, DAN], nextCursor: null };

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

/** The router's address as the page last rendered under it. */
let pageAddress = "";

function UsersAt() {
  const location = useLocation();
  pageAddress = location.pathname + location.search + location.hash;
  return <UsersAdminPage />;
}

function renderPage() {
  pageAddress = "";
  const current = signedInMember();
  useUserStore.getState().setCurrent({ ...current, user: { id: ME, email: ANA_EMAIL }, isProductAdmin: true });
  const Stub = createRoutesStub([
    { path: "/product-admin/users", Component: UsersAt },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/users"]} />);
  return userEvent.setup();
}

let list: MockInstance<typeof apiClient.getAdminUsers>;
let remove: MockInstance<typeof apiClient.deleteAdminUser>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

beforeEach(() => {
  vi.restoreAllMocks();
  list = vi.spyOn(apiClient, "getAdminUsers").mockResolvedValue(PAGE);
  remove = vi.spyOn(apiClient, "deleteAdminUser").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

// Testing Library's failed queries would print the page, which shows the fixtures' emails.
let loud: () => void;
beforeEach(() => {
  loud = quietQueries();
});

afterEach(() => {
  loud();
  useUserStore.getState().clear();
});

/** Whether `text` is shown as some element's whole text (a boolean, never printed). */
const shows = (text: string) => [...document.querySelectorAll("*")].some((element) => element.children.length === 0 && element.textContent === text);
/** Whether any attribute on the page holds `text`. */
const attributesHold = (text: string) =>
  [...document.querySelectorAll("*")].some((element) => [...element.attributes].some((attribute) => attribute.value.includes(text)));
const toastsHold = (text: string) => JSON.stringify([toastError.mock.calls, toastSuccess.mock.calls]).includes(text);
/** The Delete of `user`'s row, by its accessible name (a fixed word and the email cell). */
const deleteOf = (user: AdminUser) => screen.getByRole("button", { name: `Delete ${user.email}` });
/** Whether a row shows `user`'s email (the DOM's rows: an open dialog hides them from the accessibility tree). */
const listed = (user: AdminUser) => [...document.querySelectorAll("tbody tr")].some((row) => row.textContent?.includes(user.email) === true);

describe("the Users page", () => {
  it("shows the heading, Refresh, the subtitle, the filter box and Loading users..., then Email with (you), Created and a Delete on every row but the caller's", async () => {
    let answer!: (page: AdminUsersPage) => void;
    list.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Users" })).toBeInTheDocument();
    expect(screen.getByText(USERS_SUBTITLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing..." })).toBeDisabled();
    expect(screen.getByText("Loading users...")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith({}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    answer(PAGE);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Email", "Created", "Actions"]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.length).toBe(3);
    expect(within(rows[0]!).getByText("(you)")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByRole("button").textContent).toBe("Delete");
    expect(deleteOf(CARA)).toBeInTheDocument();
    expect(shows("Oct 1, 2026")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    // Replay's rules: emails and organization names in no attribute and not the title.
    for (const text of [ANA_EMAIL, CARA.email, DAN.email, "zq-Shared Team"]) {
      expect({ attribute: attributesHold(text), title: document.title.includes(text) }).toEqual({ attribute: false, title: false });
    }
    const filter = screen.getByRole("searchbox", { name: "Filter by email or organization" });
    expect(filter.closest(".ph-no-capture")).not.toBeNull();
    expect(filter.getAttribute("placeholder")).toBe("Filter by email or organization...");
  });

  it("shows No users found, and No users match the filter for a search", async () => {
    list.mockResolvedValue({ items: [], nextCursor: null });
    const user = renderPage();
    expect(await screen.findByText("No users found")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "zq-nobody");
    expect(await screen.findByText("No users match the filter")).toBeInTheDocument();
  });

  it("sends the trimmed term as q after the typing pauses, never in the address, an attribute or storage; Refresh reads it again", async () => {
    const user = renderPage();
    await screen.findByRole("button", { name: "Refresh" });
    list.mockClear();
    list.mockResolvedValue({ items: [CARA], nextCursor: null });
    await user.type(screen.getByRole("searchbox"), "  zq-Person-1  ");
    await waitFor(() => expect(list).toHaveBeenCalledWith({ q: "zq-Person-1" }, expect.anything()));
    expect(list.mock.calls.filter(([query]) => query?.q !== undefined).length).toBe(1);
    await waitFor(() => expect(listed(DAN)).toBe(false));
    expect(pageAddress).toBe("/product-admin/users");
    expect(attributesHold("zq-Person-1")).toBe(false);
    expect(JSON.stringify({ ...localStorage }).includes("zq-Person-1") || JSON.stringify({ ...sessionStorage }).includes("zq-Person-1")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(list.mock.calls.filter(([query]) => query?.q === "zq-Person-1").length).toBe(2));
  });

  it("loads the next page with the same term and the cursor, appended; Load more goes on the last page", async () => {
    list.mockResolvedValueOnce({ items: [SELF, CARA], nextCursor: "cursor-1" });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" }, expect.anything());
    await waitFor(() => expect(listed(DAN)).toBe(true));
    expect(screen.getAllByRole("row").length).toBe(4);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    list.mockClear();
    list.mockResolvedValueOnce({ items: [CARA], nextCursor: "cursor-2" }).mockResolvedValueOnce({ items: [DAN], nextCursor: null });
    await user.type(screen.getByRole("searchbox"), "zq");
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(list).toHaveBeenLastCalledWith({ q: "zq", cursor: "cursor-2" }, expect.anything());
  });

  it("toasts Failed to load users on a failed first read and shows Try again, never No users found, until a read succeeds", async () => {
    list.mockRejectedValueOnce(new Error("network"));
    const user = renderPage();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(USERS_LOAD_FAILED_MESSAGE));
    const again = await screen.findByRole("button", { name: "Try again" });
    expect(shows("No users found")).toBe(false);
    await user.click(again);
    await waitFor(() => expect(listed(CARA)).toBe(true));
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" }) === null, "Try again gone once a read succeeded").toBe(true);
  });

  it("says nothing when the session ended (the session-ended handler has the page)", async () => {
    list.mockRejectedValueOnce(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    renderPage();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("goes to /app, replacing the page, when the read answers 403 product_admin_required", async () => {
    list.mockRejectedValueOnce(new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 }));
    renderPage();
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("deletes after the email is typed: the fixed toast, the row gone, the focus on the filter box", async () => {
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: `Delete ${CARA.email}` }));
    const dialog = screen.getByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), CARA.email);
    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null, "the dialog closed").toBe(true));
    expect(remove).toHaveBeenCalledWith(CARA.id);
    expect(toastSuccess).toHaveBeenCalledWith(USER_DELETED_MESSAGE);
    expect(listed(CARA)).toBe(false);
    expect(listed(DAN)).toBe(true);
    await waitFor(() => expect(document.activeElement === screen.getByRole("searchbox")).toBe(true));
    expect(toastsHold(CARA.email)).toBe(false);
  });

  it("shows a listed block without asking to delete, and gives the focus back to its Delete on Close", async () => {
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: `Delete ${DAN.email}` }));
    expect(screen.getByRole("alertdialog", { name: "Cannot delete user" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement === deleteOf(DAN)).toBe(true));
    expect(remove).not.toHaveBeenCalled();
  });

  it("on a 409 user_delete_blocked reads the first page again with the same term and shows the block from the row taken by id", async () => {
    const blockedNow = { ...CARA, block: { kind: "owner", organizationName: "zq-Cara's workspace" } } as const;
    remove.mockRejectedValue(new ApiError("user_delete_blocked", "This account can't be deleted yet.", { status: 409, details: { kind: "owner" } }));
    const user = renderPage();
    await user.type(screen.getByRole("searchbox"), "zq");
    await waitFor(() => expect(list).toHaveBeenCalledWith({ q: "zq" }, expect.anything()));
    list.mockClear();
    list.mockResolvedValueOnce({ items: [SELF, blockedNow, DAN], nextCursor: null });
    await user.click(await screen.findByRole("button", { name: `Delete ${CARA.email}` }));
    await user.type(within(screen.getByRole("alertdialog")).getByRole("textbox"), CARA.email);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    await screen.findByRole("alertdialog", { name: "Cannot delete user" });
    expect(list).toHaveBeenCalledWith({ q: "zq" }, expect.anything());
    const text = (screen.getByRole("alertdialog").textContent ?? "").replace(/\s+/g, " ");
    expect(text.includes(`${CARA.email} owns organization zq-Cara's workspace.`)).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("on a 409 user_delete_blocked whose re-read no longer lists the person, shows the kind's sentence in fixed words only", async () => {
    remove.mockRejectedValue(new ApiError("user_delete_blocked", "This account can't be deleted yet.", { status: 409, details: { kind: "owner" } }));
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: `Delete ${CARA.email}` }));
    list.mockResolvedValueOnce({ items: [SELF, DAN], nextCursor: null });
    await user.type(within(screen.getByRole("alertdialog")).getByRole("textbox"), CARA.email);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    await screen.findByRole("alertdialog", { name: "Cannot delete user" });
    expect((screen.getByRole("alertdialog").textContent ?? "").includes(BLOCKED_WITHOUT_ROW.owner)).toBe(true);
    expect((screen.getByRole("alertdialog").textContent ?? "").includes(CARA.email)).toBe(false);
    expect(toastsHold(CARA.email)).toBe(false);
  });

  it("on a 409 user_delete_busy toasts its fixed words and keeps the confirmation open to try again", async () => {
    remove.mockRejectedValueOnce(new ApiError("user_delete_busy", "The account changed while it was being deleted. Try again.", { status: 409 }));
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: `Delete ${CARA.email}` }));
    await user.type(within(screen.getByRole("alertdialog")).getByRole("textbox"), CARA.email);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The account changed while it was being deleted. Try again."));
    expect(screen.getByRole("alertdialog").textContent?.includes("Nuclear delete")).toBe(true);
    expect(listed(CARA)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null, "the dialog closed").toBe(true));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(listed(CARA)).toBe(false);
  });

  it("goes to /app, replacing the page, when the delete answers 403 product_admin_required", async () => {
    remove.mockRejectedValueOnce(new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 }));
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: `Delete ${CARA.email}` }));
    await user.type(within(screen.getByRole("alertdialog")).getByRole("textbox"), CARA.email);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
  });
});
