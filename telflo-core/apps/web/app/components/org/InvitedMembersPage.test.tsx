import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invitation, InvitationResponse, OrganizationType, SiteSettings } from "@telflo/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { InvitedMembersPage } from "./InvitedMembersPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { EXPIRED_INVITATION, INVITED_CONTRIBUTOR, ORGANIZATION_ID, enUsDateTime } from "~/test/members.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

/**
 * The page in a group organization unless `organizationType` says otherwise,
 * on the open source's defaults (invite-only) unless a `site` is given.
 */
function renderPage(
  invitations: Invitation[] | null,
  { organizationType = "group", site }: { organizationType?: OrganizationType; site?: SiteSettings } = {},
) {
  const onChanged = vi.fn();
  const pages: Parameters<typeof createRoutesStub>[0] = [
    {
      path: "/org-admin",
      Component: () => (
        <InvitedMembersPage
          invitations={invitations}
          organizationId={ORGANIZATION_ID}
          organizationName="Acme Observability"
          organizationType={organizationType}
          onChanged={onChanged}
        />
      ),
    },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ];
  const Stub = createRoutesStub(site === undefined ? pages : underSite(site, pages));
  render(<Stub initialEntries={["/org-admin"]} />);
  return { onChanged, user: userEvent.setup() };
}

/** A row's cells, by column. */
function cellsOf(email: string): { email: HTMLElement; role: HTMLElement; invitedAt: HTMLElement; actions: HTMLElement } {
  const row = screen.getByText(email).closest("tr");
  if (!row) throw new Error(`No row for ${email}`);
  const [emailCell, role, invitedAt, actions] = within(row).getAllByRole("cell");
  return { email: emailCell!, role: role!, invitedAt: invitedAt!, actions: actions! };
}

/** A promise the test settles when it chooses. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("InvitedMembersPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its heading, button, description and columns", async () => {
    renderPage([INVITED_CONTRIBUTOR]);

    expect(await screen.findByRole("heading", { level: 1, name: "Invited Members" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite Member" })).toBeInTheDocument();
    expect(screen.getByText("Pending invitations to your organization")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent?.trim())).toEqual([
      "Email",
      "Role",
      "Invited At",
      "Actions",
    ]);
  });

  // D36-1 decision 57 (Q268): a personal workspace invites only while registration is open.
  const NO_PERSONAL_INVITATIONS = "Invitations can't be sent from a personal workspace on this site.";

  it("in a personal workspace on an invite-only site: no Invite Member and no Resend, the line in the button's place, Cancel kept", async () => {
    renderPage([INVITED_CONTRIBUTOR], { organizationType: "personal" });

    expect(await screen.findByText(NO_PERSONAL_INVITATIONS)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Member" })).not.toBeInTheDocument();
    const actions = cellsOf("invited@example.com").actions;
    expect(within(actions).queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("in a personal workspace on a closed site: the same", async () => {
    renderPage([INVITED_CONTRIBUTOR], { organizationType: "personal", site: { ...SAAS_SITE, registration: "closed" } });

    expect(await screen.findByText(NO_PERSONAL_INVITATIONS)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Member" })).not.toBeInTheDocument();
    expect(within(cellsOf("invited@example.com").actions).queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
  });

  it.each([
    ["a personal workspace on an open site", "personal", SAAS_SITE],
    ["a group organization on an open site", "group", SAAS_SITE],
    ["a group organization on an invite-only site", "group", undefined],
  ] as const)("in %s: Invite Member and Resend, and no such line", async (_label, organizationType, site) => {
    renderPage([INVITED_CONTRIBUTOR], { organizationType, ...(site === undefined ? {} : { site }) });

    expect(await screen.findByRole("button", { name: "Invite Member" })).toBeInTheDocument();
    expect(within(cellsOf("invited@example.com").actions).getByRole("button", { name: "Resend" })).toBeInTheDocument();
    expect(screen.queryByText(NO_PERSONAL_INVITATIONS)).not.toBeInTheDocument();
  });

  it("lists each invitation in the API's order, with the lowercase role, the en-US date invited and Resend and Cancel", async () => {
    renderPage([INVITED_CONTRIBUTOR, EXPIRED_INVITATION]);
    await screen.findByText("Invited Members");

    const emails = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    expect(emails).toEqual(["invited@example.com", "expired@example.com"]);
    const invited = cellsOf("invited@example.com");
    expect(invited.role).toHaveTextContent(/^contributor$/);
    expect(cellsOf("expired@example.com").role).toHaveTextContent(/^admin$/);
    expect(invited.invitedAt.textContent).toMatch(enUsDateTime("May 2, 2026"));
    expect(within(invited.actions).getByRole("button", { name: "Resend" })).toHaveClass("text-brand");
    expect(within(invited.actions).getByRole("button", { name: "Cancel" })).toHaveClass("text-fail");
  });

  it("says Expired beside an expired invitation's date, and only there", async () => {
    renderPage([INVITED_CONTRIBUTOR, EXPIRED_INVITATION]);
    await screen.findByText("Invited Members");

    const expired = cellsOf("expired@example.com").invitedAt;
    expect(within(expired).getByText("Expired")).toBeInTheDocument();
    expect(expired.textContent).toMatch(/^Apr 1, 2026, \d{2}:\d{2} (AM|PM)Expired$/);
    expect(within(cellsOf("invited@example.com").invitedAt).queryByText("Expired")).not.toBeInTheDocument();
    expect(screen.getAllByText("Expired")).toHaveLength(1);
  });

  it("says No pending invitations when there are none", async () => {
    renderPage([]);

    expect(await screen.findByText("No pending invitations")).toBeInTheDocument();
  });

  it("shows the spinner, and no table, while the list loads", async () => {
    renderPage(null);

    expect(await screen.findByRole("status", { name: "Loading invitations" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No pending invitations")).not.toBeInTheDocument();
  });

  it("resends, says Sending... on that row only meanwhile, toasts Invitation resent and reloads the list", async () => {
    const answer = held<InvitationResponse>();
    const resendInvitation = vi.spyOn(apiClient, "resendInvitation").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const { user, onChanged } = renderPage([INVITED_CONTRIBUTOR, EXPIRED_INVITATION]);

    await user.click(within(cellsOf("expired@example.com").actions).getByRole("button", { name: "Resend" }));

    expect(resendInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, EXPIRED_INVITATION.id);
    expect(within(cellsOf("expired@example.com").actions).getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(within(cellsOf("invited@example.com").actions).getByRole("button", { name: "Resend" })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
    answer.resolve({ invitation: { ...EXPIRED_INVITATION, isExpired: false } });

    await waitFor(() => expect(success).toHaveBeenCalledWith("Invitation resent"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(cellsOf("expired@example.com").actions).getByRole("button", { name: "Resend" })).toBeEnabled();
  });

  it.each([
    ["404 invitation_not_found", "invitation_not_found", "No pending invitation found for this user"],
    [
      "502 invitation_email_failed",
      "invitation_email_failed",
      "The invitation's link was renewed, but its email couldn't be sent. Use Resend to try again.",
    ],
    ["429 rate_limited", "rate_limited", "Too many attempts. Please wait and try again."],
  ])("toasts the API's refusal of a resend (%s) and reloads the list", async (_, code, message) => {
    vi.spyOn(apiClient, "resendInvitation").mockRejectedValue(new ApiError(code, message));
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderPage([INVITED_CONTRIBUTOR]);

    await user.click(await screen.findByRole("button", { name: "Resend" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith(message));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled();
  });

  it("toasts Failed to resend invitation when resending fails unexpectedly, without reloading", async () => {
    vi.spyOn(apiClient, "resendInvitation").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderPage([INVITED_CONTRIBUTOR]);

    await user.click(await screen.findByRole("button", { name: "Resend" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to resend invitation"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a 403 organization_admin_required from a resend, toasts its message and goes to /app", async () => {
    vi.spyOn(apiClient, "resendInvitation").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const { user } = renderPage([INVITED_CONTRIBUTOR]);

    await user.click(await screen.findByRole("button", { name: "Resend" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("opens Cancel Invitation for the invitation whose Cancel was clicked", async () => {
    const { user } = renderPage([INVITED_CONTRIBUTOR, EXPIRED_INVITATION]);

    await user.click(within(cellsOf("expired@example.com").actions).getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Cancel Invitation" });
    expect(dialog).toHaveTextContent("You are permanently cancelling the invitation for expired@example.com.");
  });

  it("opens Invite Members from Invite Member", async () => {
    const { user } = renderPage([]);

    await user.click(await screen.findByRole("button", { name: "Invite Member" }));

    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });
    expect(dialog).toHaveTextContent("Send invitations to join the Acme Observability organization.");
  });
});
