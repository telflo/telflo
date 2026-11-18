import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@telflo/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { ActiveMembersPage } from "./ActiveMembersPage.js";
import { CONTRIBUTOR, ORGANIZATION_ID, OWNER, REMOVED, VIEWER, enUsDateTime } from "~/test/members.js";

function renderPage(members: Member[] | null) {
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <ActiveMembersPage
          members={members}
          currentUserId={VIEWER.userId}
          organizationId={ORGANIZATION_ID}
          onChanged={onChanged}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/org-admin"]} />);
  return { onChanged, user: userEvent.setup() };
}

/** The table row whose email cell starts with `email`. */
function rowOf(email: string): HTMLElement {
  const row = screen.getByText(email, { exact: false }).closest("tr");
  if (!row) throw new Error(`No row for ${email}`);
  return row;
}

/** A row's cells, by column. */
function cellsOf(email: string): { email: HTMLElement; role: HTMLElement; joinedAt: HTMLElement; actions: HTMLElement } {
  const [emailCell, role, joinedAt, actions] = within(rowOf(email)).getAllByRole("cell");
  return { email: emailCell!, role: role!, joinedAt: joinedAt!, actions: actions! };
}

describe("ActiveMembersPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its heading, description and columns", async () => {
    renderPage([VIEWER]);

    expect(await screen.findByRole("heading", { level: 1, name: "Active Members" })).toBeInTheDocument();
    expect(screen.getByText("Current members of your organization")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent?.trim())).toEqual([
      "Email",
      "Role",
      "Joined At",
      "Actions",
    ]);
  });

  it("lists only the active members, each with the lowercase role and the en-US date joined", async () => {
    renderPage([VIEWER, OWNER, CONTRIBUTOR, REMOVED]);
    await screen.findByText("Active Members");

    const emails = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    expect(emails).toEqual(["viewer@example.com(you)", "owner@example.com", "contributor@example.com"]);
    expect(screen.queryByText("removed@example.com")).not.toBeInTheDocument();
    expect(cellsOf("contributor@example.com").role).toHaveTextContent(/^contributor$/);
    expect(cellsOf("contributor@example.com").joinedAt.textContent).toMatch(enUsDateTime("Mar 15, 2026"));
    expect(cellsOf("owner@example.com").joinedAt.textContent).toMatch(enUsDateTime("Jan 5, 2026"));
  });

  it("marks the viewer's own row (you), with no role link and no Delete", async () => {
    renderPage([VIEWER, CONTRIBUTOR]);
    await screen.findByText("Active Members");

    const own = cellsOf("viewer@example.com");
    expect(within(own.email).getByText("(you)")).toBeInTheDocument();
    expect(own.role).toHaveTextContent(/^admin$/);
    expect(within(own.role).queryByRole("button")).not.toBeInTheDocument();
    expect(within(own.actions).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByText("(you)")).toHaveLength(1);
  });

  it("gives the owner of a personal organization no role link and no Delete (decision 8)", async () => {
    renderPage([VIEWER, OWNER, CONTRIBUTOR]);
    await screen.findByText("Active Members");

    const owner = cellsOf("owner@example.com");
    expect(owner.role).toHaveTextContent(/^admin$/);
    expect(within(owner.role).queryByRole("button")).not.toBeInTheDocument();
    expect(within(owner.actions).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(owner.email).queryByText("(you)")).not.toBeInTheDocument();
  });

  it("gives any other member a role link and a Delete", async () => {
    renderPage([VIEWER, OWNER, CONTRIBUTOR]);
    await screen.findByText("Active Members");

    const other = cellsOf("contributor@example.com");
    expect(within(other.role).getByRole("button", { name: "contributor" })).toHaveClass("text-brand");
    expect(within(other.actions).getByRole("button", { name: "Delete" })).toHaveClass("text-fail");
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  });

  it("says No active members when there are none", async () => {
    renderPage([REMOVED]);

    expect(await screen.findByText("No active members")).toBeInTheDocument();
  });

  it("shows a spinner, and no table, while the list loads", async () => {
    renderPage(null);

    expect(await screen.findByRole("status", { name: "Loading members" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No active members")).not.toBeInTheDocument();
  });

  it("opens Change Role for the member whose role was clicked", async () => {
    const { user } = renderPage([VIEWER, CONTRIBUTOR]);

    await user.click(await screen.findByRole("button", { name: "contributor" }));

    const dialog = await screen.findByRole("dialog", { name: "Change Role" });
    expect(dialog).toHaveTextContent("Change the user's role for contributor@example.com");
  });

  it("opens Remove Member for the member whose Delete was clicked", async () => {
    const { user } = renderPage([VIEWER, CONTRIBUTOR]);

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Remove Member" });
    expect(dialog).toHaveTextContent("You are removing contributor@example.com from the organization.");
  });
});
