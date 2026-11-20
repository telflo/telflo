import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@telflo/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { DeletedMembersPage } from "./DeletedMembersPage.js";
import { CONTRIBUTOR, ORGANIZATION_ID, REMOVED, VIEWER, enUsDateTime } from "~/test/members.js";

function renderPage(members: Member[] | null) {
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin/deleted-members",
      Component: () => <DeletedMembersPage members={members} organizationId={ORGANIZATION_ID} onChanged={onChanged} />,
    },
  ]);
  render(<Stub initialEntries={["/org-admin/deleted-members"]} />);
  return { onChanged, user: userEvent.setup() };
}

describe("DeletedMembersPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its heading, description and columns", async () => {
    renderPage([REMOVED]);

    expect(await screen.findByRole("heading", { level: 1, name: "Deleted Members" })).toBeInTheDocument();
    expect(screen.getByText("Previously removed members")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent?.trim())).toEqual([
      "Email",
      "Role",
      "Deleted At",
      "Actions",
    ]);
  });

  it("lists only the removed members, with the role, the en-US date removed and Restore", async () => {
    const earlier: Member = { ...REMOVED, userId: "00000000-0000-4000-8000-000000000014", email: "earlier@example.com", role: "admin", deletedAt: "2026-02-03T12:00:00.000Z" };
    renderPage([VIEWER, CONTRIBUTOR, REMOVED, earlier]);
    await screen.findByText("Deleted Members");

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([
      "removed@example.com",
      "earlier@example.com",
    ]);
    const [email, role, deletedAt, actions] = within(rows[0]!).getAllByRole("cell");
    expect(email).not.toHaveTextContent("(you)");
    expect(role).toHaveTextContent(/^contributor$/);
    // The membership's deletedAt, not when it joined.
    expect(deletedAt!.textContent).toMatch(enUsDateTime("Apr 20, 2026"));
    expect(within(actions!).getByRole("button", { name: "Restore" })).toHaveClass("text-ok");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent(/^admin$/);
    expect(within(rows[1]!).getAllByRole("cell")[2]!.textContent).toMatch(enUsDateTime("Feb 3, 2026"));
  });

  it("says No deleted members when there are none", async () => {
    renderPage([VIEWER, CONTRIBUTOR]);

    expect(await screen.findByText("No deleted members")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("shows the spinner, and no table, while the list loads", async () => {
    renderPage(null);

    expect(await screen.findByRole("status", { name: "Loading members" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No deleted members")).not.toBeInTheDocument();
  });

  it("opens Restore Member for the member whose Restore was clicked", async () => {
    const { user } = renderPage([REMOVED]);

    await user.click(await screen.findByRole("button", { name: "Restore" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Restore Member" });
    expect(dialog).toHaveTextContent("You are restoring removed@example.com's access to the organization.");
  });
});
