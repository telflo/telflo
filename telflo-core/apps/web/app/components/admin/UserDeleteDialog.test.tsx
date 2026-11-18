import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { AdminUser } from "@telflo/contracts";
import {
  BLOCKED_WITHOUT_ROW,
  USER_DELETE_CONFIRM_WORDS,
  USER_DELETE_FAILED_MESSAGE,
  USER_DELETED_MESSAGE,
  UserDeleteDialog,
  type UserDeleteDialogProps,
  type UserDeleteTarget,
} from "./UserDeleteDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { quietQueries } from "~/test/service-accounts.js";

/*
 * The Users page's delete dialog (D29 decisions 29, 30, 38 and 41;
 * Preflight rulings 15 and 21; Ruling 258): the block's sentence per kind
 * around the visible values; the kind alone in fixed words; the
 * type-to-confirm (uncontrolled, inside ph-no-capture, labelled, no
 * placeholder, enabled only on the exact email); each answer. Emails and
 * organization names are fixtures carrying the marker "zq"; they are
 * compared as booleans only, never printed by a matcher.
 */

const EMAIL = "zq-cara@example.com";
const ORGANIZATION = "zq-Acme Platform";

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "0199f400-0000-7000-8000-0000000000c1",
    email: EMAIL,
    createdAt: "2026-10-01T12:00:00.000Z",
    isProductAdmin: false,
    block: null,
    ...overrides,
  };
}

let remove: MockInstance<typeof apiClient.deleteAdminUser>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

// Testing Library's failed queries would print the page, which shows the fixtures' email.
let loud: () => void;
afterEach(() => loud());

beforeEach(() => {
  loud = quietQueries();
  vi.restoreAllMocks();
  remove = vi.spyOn(apiClient, "deleteAdminUser").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

function renderDialog(target: UserDeleteTarget, overrides: Partial<UserDeleteDialogProps> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    target,
    onDeleted: vi.fn(),
    onBlocked: vi.fn(),
    onProductAdminLost: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<UserDeleteDialog {...props} />);
  return { props, user: userEvent.setup(), unmount };
}

/** The dialog's text with its whitespace folded, for comparing with a sentence: a boolean, never printed. */
const dialogText = () => (screen.getByRole("alertdialog").textContent ?? "").replace(/\s+/g, " ").trim();

/** Every attribute value on the page: whether any holds `text` (a boolean). */
function attributesHold(text: string): boolean {
  return [...document.querySelectorAll("*")].some((element) => [...element.attributes].some((attribute) => attribute.value.includes(text)));
}

const toastsHold = (text: string) => JSON.stringify([toastError.mock.calls, toastSuccess.mock.calls]).includes(text);

describe("UserDeleteDialog", () => {
  it("explains each block in decision 38's fixed words around the visible values, with Close and no delete", async () => {
    const cases = [
      {
        block: { kind: "member", organizationName: ORGANIZATION, role: "contributor" } as const,
        sentence: `${EMAIL} is a member of organization ${ORGANIZATION} (contributor). Remove them from the organization before deleting this account.`,
      },
      {
        block: { kind: "owner", organizationName: ORGANIZATION } as const,
        sentence: `${EMAIL} owns organization ${ORGANIZATION}. Remove its other members and pending invitations first.`,
      },
      { block: { kind: "product_admin" } as const, sentence: `${EMAIL} is a product admin. Remove their product-admin role first.` },
    ];
    for (const { block, sentence } of cases) {
      const { unmount } = render(
        <UserDeleteDialog
          open
          onOpenChange={() => {}}
          target={{ user: adminUser({ block }) }}
          onDeleted={() => {}}
          onBlocked={() => {}}
          onProductAdminLost={() => {}}
        />,
      );
      expect(screen.getByRole("alertdialog", { name: "Cannot delete user" })).toBeInTheDocument();
      expect({ kind: block.kind, sentence: dialogText() === `Cannot delete user${sentence}Close` }).toEqual({ kind: block.kind, sentence: true });
      expect(screen.queryByRole("button", { name: "Permanently delete" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect({ kind: block.kind, email: attributesHold(EMAIL), organization: attributesHold(ORGANIZATION) }).toEqual({
        kind: block.kind,
        email: false,
        organization: false,
      });
      unmount();
    }
  });

  it("names a personal workspace under its default name, its owner's email, as <email>'s organization in the owner's sentence, the email and 's in bold; any other name stays itself (D36-1 Q264)", () => {
    const cases = [
      { name: EMAIL, sentence: `${EMAIL} owns ${EMAIL}'s organization. Remove its other members and pending invitations first.`, bold: `${EMAIL}'s` },
      { name: "zq-Cara's Lab", sentence: `${EMAIL} owns organization zq-Cara's Lab. Remove its other members and pending invitations first.`, bold: "zq-Cara's Lab" },
      { name: "zq-cara@example", sentence: `${EMAIL} owns organization zq-cara@example. Remove its other members and pending invitations first.`, bold: "zq-cara@example" },
    ];
    for (const [index, { name, sentence, bold }] of cases.entries()) {
      const { unmount } = render(
        <UserDeleteDialog
          open
          onOpenChange={() => {}}
          target={{ user: adminUser({ block: { kind: "owner", organizationName: name } }) }}
          onDeleted={() => {}}
          onBlocked={() => {}}
          onProductAdminLost={() => {}}
        />,
      );
      const spans = [...screen.getByRole("alertdialog").querySelectorAll("span.font-medium")].map((span) => span.textContent);
      expect({ index, sentence: dialogText() === `Cannot delete user${sentence}Close`, bold: spans.includes(bold) }).toEqual({
        index,
        sentence: true,
        bold: true,
      });
      expect({ index, email: attributesHold(EMAIL), name: attributesHold(name) }).toEqual({ index, email: false, name: false });
      unmount();
    }
  });

  it("explains a block by its kind alone, in fixed words, when the person is gone from the re-read", () => {
    for (const kind of ["member", "owner", "product_admin"] as const) {
      const { unmount } = render(
        <UserDeleteDialog open onOpenChange={() => {}} target={{ kind }} onDeleted={() => {}} onBlocked={() => {}} onProductAdminLost={() => {}} />,
      );
      expect(dialogText()).toBe(`Cannot delete user${BLOCKED_WITHOUT_ROW[kind]}Close`);
      unmount();
    }
  });

  it("asks for the email in an uncontrolled field inside ph-no-capture, labelled by the confirm sentence, with no placeholder; Permanently delete is enabled only by the exact email, trimmed", async () => {
    const { user } = renderDialog({ user: adminUser() });
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent === `Nuclear delete: ${EMAIL}`).toBe(true);
    const field = within(dialog).getByRole("textbox", { name: USER_DELETE_CONFIRM_WORDS });
    expect(field.closest(".ph-no-capture")).not.toBeNull();
    expect(field.hasAttribute("placeholder")).toBe(false);
    const button = within(dialog).getByRole("button", { name: "Permanently delete" });
    expect(button).toBeDisabled();
    await user.type(field, EMAIL.slice(0, -1));
    expect(button).toBeDisabled();
    await user.type(field, `${EMAIL.slice(-1)}  `);
    expect(button).toBeEnabled();
    await user.clear(field);
    await user.type(field, EMAIL.toUpperCase());
    expect(button).toBeDisabled();
    await user.clear(field);
    await user.type(field, `  ${EMAIL}`);
    expect(button).toBeEnabled();
    // Typed, never an attribute: no value attribute holds it.
    expect(attributesHold(EMAIL)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes: Deleting... while it waits, then the fixed toast (no email) and onDeleted", async () => {
    let finish!: () => void;
    remove.mockReturnValue(new Promise((resolve) => (finish = () => resolve(undefined))));
    const { user, props } = renderDialog({ user: adminUser() });
    await user.type(screen.getByRole("textbox"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(remove).toHaveBeenCalledWith(adminUser().id);
    finish();
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith(adminUser().id));
    expect(toastSuccess).toHaveBeenCalledWith(USER_DELETED_MESSAGE);
    expect(toastsHold(EMAIL)).toBe(false);
  });

  it("answers each refusal: blocked reports its kind; busy toasts its fixed words and stays open to try again; not found toasts and reports the row gone; a lost flag reports it; anything else toasts and stays", async () => {
    const answers: Array<[string, ApiError | Error, (props: UserDeleteDialogProps) => void]> = [
      [
        "blocked",
        new ApiError("user_delete_blocked", "This account can't be deleted yet.", { status: 409, details: { kind: "owner" } }),
        (props) => expect(props.onBlocked).toHaveBeenCalledWith(adminUser().id, "owner"),
      ],
      [
        "busy",
        new ApiError("user_delete_busy", "The account changed while it was being deleted. Try again.", { status: 409 }),
        (props) => {
          expect(toastError).toHaveBeenCalledWith("The account changed while it was being deleted. Try again.");
          expect(props.onDeleted).not.toHaveBeenCalled();
          expect(props.onOpenChange).not.toHaveBeenCalled();
          expect(screen.getByRole("button", { name: "Permanently delete" })).toBeEnabled();
        },
      ],
      [
        "not found",
        new ApiError("user_not_found", "User not found.", { status: 404 }),
        (props) => {
          expect(toastError).toHaveBeenCalledWith("User not found.");
          expect(props.onDeleted).toHaveBeenCalledWith(adminUser().id);
        },
      ],
      [
        "flag lost",
        new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 }),
        (props) => {
          expect(props.onProductAdminLost).toHaveBeenCalled();
          expect(toastError).not.toHaveBeenCalled();
        },
      ],
      [
        "session ended",
        new ApiError("unauthenticated", "You need to sign in.", { status: 401 }),
        (props) => {
          expect(toastError).not.toHaveBeenCalled();
          expect(props.onDeleted).not.toHaveBeenCalled();
        },
      ],
      [
        "anything else",
        new Error(""),
        (props) => {
          expect(toastError).toHaveBeenCalledWith(USER_DELETE_FAILED_MESSAGE);
          expect(props.onDeleted).not.toHaveBeenCalled();
          expect(screen.getByRole("button", { name: "Permanently delete" })).toBeEnabled();
        },
      ],
    ];
    for (const [label, error, check] of answers) {
      toastError.mockClear();
      remove.mockRejectedValueOnce(error);
      const { user, props, unmount } = renderDialog({ user: adminUser() });
      await user.type(screen.getByRole("textbox"), EMAIL);
      await user.click(screen.getByRole("button", { name: "Permanently delete" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Deleting..." }), label).toBeNull());
      check(props);
      expect({ label, email: toastsHold(EMAIL) }).toEqual({ label, email: false });
      unmount();
    }
  });
});
