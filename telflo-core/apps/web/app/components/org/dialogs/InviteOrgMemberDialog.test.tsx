import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateInvitationRequest, InvitationResponse, OrganizationType } from "@telflo/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { InviteOrgMemberDialog } from "./InviteOrgMemberDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { INVITED_CONTRIBUTOR, ORGANIZATION_ID } from "~/test/members.js";

const ORGANIZATION_NAME = "Acme Observability";

const ALREADY_INVITED = new ApiError("invitation_already_pending", "User has already been invited to this organization");
const ALREADY_MEMBER = new ApiError("member_already_active", "User is already a member of this organization");

function renderDialog({
  organizationName = ORGANIZATION_NAME,
  organizationType = "group",
}: { organizationName?: string; organizationType?: OrganizationType } = {}) {
  const onOpenChange = vi.fn();
  const onInvited = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <InviteOrgMemberDialog
          open
          onOpenChange={onOpenChange}
          organizationId={ORGANIZATION_ID}
          organizationName={organizationName}
          organizationType={organizationType}
          onInvited={onInvited}
        />
      ),
    },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/org-admin"]} />);
  return { onOpenChange, onInvited, user: userEvent.setup() };
}

/** The API answering each address as `answers` says: an ApiError is a refusal, anything else a 201. */
function answerInvites(answers: Record<string, ApiError | "created"> = {}) {
  return vi.spyOn(apiClient, "inviteMember").mockImplementation(async (_, { email, role }) => {
    const answer = answers[email] ?? "created";
    if (answer instanceof ApiError) throw answer;
    return { invitation: { ...INVITED_CONTRIBUTOR, email, role } };
  });
}

function emailInput(): HTMLElement {
  return screen.getByLabelText("Email Addresses");
}

function sendButton(): HTMLElement {
  return screen.getByRole("button", { name: "Send Invitations" });
}

/** The destructive alert's text, or null when there is none. */
function errorAlert(): string | null {
  const alert = screen.queryAllByRole("alert").find((element) => element.className.includes("text-fail"));
  return alert?.textContent ?? null;
}

describe("InviteOrgMemberDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its title and fields, its description naming the organization in bold (Q261), with Contributor selected and its help text, and Send Invitations disabled while empty", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });

    expect(dialog).toHaveTextContent(`Send invitations to join the ${ORGANIZATION_NAME} organization.`);
    expect(screen.getByText(ORGANIZATION_NAME, { selector: "strong" })).toBeInTheDocument();
    expect(emailInput()).toHaveAttribute("placeholder", "user@example.com, another@example.com");
    expect(emailInput()).toHaveFocus();
    expect(screen.getByText("Separate multiple emails with commas.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("Contributor");
    expect(screen.getByText("Can create and edit configurations.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names a personal workspace under its default name, its email (Q263), as the <email>'s organization, the email and 's in bold (Q262)", async () => {
    renderDialog({ organizationName: "someone@example.com", organizationType: "personal" });
    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });

    expect(dialog).toHaveTextContent("Send invitations to join the someone@example.com's organization.");
    expect(dialog).not.toHaveTextContent("workspace");
    expect(screen.getByText("someone@example.com's", { selector: "strong" })).toBeInTheDocument();
  });

  it("names a renamed personal workspace, and a group named by an email address, by their whole names (Q262, Q263)", async () => {
    renderDialog({ organizationName: "Sam's Lab", organizationType: "personal" });
    expect(await screen.findByRole("dialog", { name: "Invite Members" })).toHaveTextContent(
      "Send invitations to join the Sam's Lab organization.",
    );
    cleanup();

    renderDialog({ organizationName: "ops@example.com", organizationType: "group" });
    expect(await screen.findByRole("dialog", { name: "Invite Members" })).toHaveTextContent(
      "Send invitations to join the ops@example.com organization.",
    );
    expect(screen.getByText("ops@example.com", { selector: "strong" })).toBeInTheDocument();
  });

  it("puts the organization's name in no attribute, only the description's text, since replay records attributes (D4 Ruling 16, Q261)", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });
    expect(dialog).toHaveTextContent(ORGANIZATION_NAME);

    // Every attribute value in the document, the dialog's portal included.
    const attributeValues = [...document.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    expect(attributeValues.some((value) => value.includes(ORGANIZATION_NAME))).toBe(false);
  });

  it("puts a personal workspace's email in no attribute either (Q262)", async () => {
    const email = "someone@example.com";
    renderDialog({ organizationName: email, organizationType: "personal" });
    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });
    expect(dialog).toHaveTextContent(email);

    const attributeValues = [...document.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    expect(attributeValues.some((value) => value.includes(email))).toBe(false);
  });

  it("names a personal workspace renamed to something only like an email, or still under the old <email>'s workspace, by its whole name, with no 's added (Q263)", async () => {
    for (const name of ["sam@example", "sam @example.com", "someone@example.com's workspace"]) {
      renderDialog({ organizationName: name, organizationType: "personal" });
      expect(await screen.findByRole("dialog", { name: "Invite Members" })).toHaveTextContent(
        `Send invitations to join the ${name} organization.`,
      );
      expect(screen.getByText(name, { selector: "strong" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("offers Contributor and Admin, in that order, and shows Admin's help text once chosen", async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole("combobox", { name: "Role" }));

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Contributor", "Admin"]);
    await user.click(screen.getByRole("option", { name: "Admin" }));

    expect(screen.getByText("Full access to manage the organization and its members.")).toBeInTheDocument();
    expect(screen.queryByText("Can create and edit configurations.")).not.toBeInTheDocument();
  });

  it("keeps Send Invitations disabled for blank input, and enables it once there is text", async () => {
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "   ");
    expect(sendButton()).toBeDisabled();

    await user.type(emailInput(), "a");
    expect(sendButton()).toBeEnabled();
  });

  it("says At least one email is required for input that is only commas, and sends nothing", async () => {
    const inviteMember = answerInvites();
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), " , ,");
    await user.click(sendButton());

    expect(errorAlert()).toBe("At least one email is required");
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it.each([
    ["one", "good@example.com, not-an-email", "Invalid email: not-an-email"],
    ["several", "bad, good@example.com, worse@nowhere", "Invalid emails: bad, worse@nowhere"],
  ])("names %s invalid address in its message, and sends nothing", async (_, input, message) => {
    const inviteMember = answerInvites();
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), input);
    await user.click(sendButton());

    expect(errorAlert()).toBe(message);
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it("invites one address, trimmed and lowercased, in the chosen role; says Invitation Sent, resets the form and reloads the list", async () => {
    const inviteMember = answerInvites();
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "  New.Person@Example.COM ");
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(sendButton());

    expect(await screen.findByText("Invitation Sent")).toBeInTheDocument();
    expect(inviteMember).toHaveBeenCalledTimes(1);
    expect(inviteMember).toHaveBeenCalledWith(ORGANIZATION_ID, { email: "new.person@example.com", role: "admin" });
    expect(errorAlert()).toBeNull();
    expect(emailInput()).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("Contributor");
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it("invites several addresses one request at a time, in order, saying Sending... meanwhile, then Invitations Sent", async () => {
    const pending: { request: CreateInvitationRequest; answer: (response: InvitationResponse) => void }[] = [];
    const inviteMember = vi.spyOn(apiClient, "inviteMember").mockImplementation(
      (_, request) =>
        new Promise((resolve) => {
          pending.push({ request, answer: resolve });
        }),
    );
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com, second@example.com,third@example.com");
    await user.click(sendButton());

    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(emailInput()).toBeDisabled();
    for (const expected of ["first@example.com", "second@example.com", "third@example.com"]) {
      await waitFor(() => expect(pending).toHaveLength(1));
      // The next request waits for this one's answer.
      expect(pending[0]!.request).toEqual({ email: expected, role: "contributor" });
      const { request, answer } = pending.shift()!;
      answer({ invitation: { ...INVITED_CONTRIBUTOR, email: request.email } });
    }

    expect(await screen.findByText("Invitations Sent")).toBeInTheDocument();
    expect(inviteMember.mock.calls.map(([, request]) => request.email)).toEqual([
      "first@example.com",
      "second@example.com",
      "third@example.com",
    ]);
    expect(emailInput()).toHaveValue("");
    expect(sendButton()).toBeDisabled();
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it("with one failure among several, shows both alerts, the failure's own message, keeps the form and reloads the list", async () => {
    answerInvites({ "second@example.com": ALREADY_INVITED });
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com, second@example.com");
    await user.click(sendButton());

    expect(await screen.findByText("Invitation Sent")).toBeInTheDocument();
    expect(errorAlert()).toBe("User has already been invited to this organization");
    expect(emailInput()).toHaveValue("first@example.com, second@example.com");
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it("with several failures, shows email: message per line, and reloads nothing when none succeeded", async () => {
    answerInvites({ "first@example.com": ALREADY_INVITED, "second@example.com": ALREADY_MEMBER });
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com, second@example.com");
    await user.click(sendButton());

    await waitFor(() =>
      expect(errorAlert()).toBe(
        "first@example.com: User has already been invited to this organization\n" +
          "second@example.com: User is already a member of this organization",
      ),
    );
    expect(screen.queryByText(/^Invitations? Sent$/)).not.toBeInTheDocument();
    expect(emailInput()).toHaveValue("first@example.com, second@example.com");
    expect(onInvited).not.toHaveBeenCalled();
  });

  it("shows Failed to invite for an unexpected failure", async () => {
    answerInvites({ "first@example.com": new ApiError("internal_error", "Something went wrong.") });
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com");
    await user.click(sendButton());

    await waitFor(() => expect(errorAlert()).toBe("Failed to invite"));
  });

  it("shows the mail limit's message when invitations are rate limited", async () => {
    answerInvites({ "first@example.com": new ApiError("rate_limited", "Too many attempts. Please wait and try again.") });
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com");
    await user.click(sendButton());

    await waitFor(() => expect(errorAlert()).toBe("Too many attempts. Please wait and try again."));
  });

  it("shows the API's words for an address at the reserved domain, 422 email_reserved, not Failed to invite (D22 Preflight ruling 23)", async () => {
    answerInvites({
      "ci-1a2b3c4d@service-accounts.telflo.invalid": new ApiError("email_reserved", "This address can't be used"),
    });
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "ci-1a2b3c4d@service-accounts.telflo.invalid");
    await user.click(sendButton());

    await waitFor(() => expect(errorAlert()).toBe("This address can't be used"));
    expect(onInvited).not.toHaveBeenCalled();
  });

  it("reloads the list when an invitation was created but its email wasn't sent", async () => {
    const message = "The invitation was created, but its email couldn't be sent. Use Resend to try again.";
    answerInvites({ "first@example.com": new ApiError("invitation_email_failed", message) });
    const { user, onInvited } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com");
    await user.click(sendButton());

    await waitFor(() => expect(errorAlert()).toBe(message));
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it("on a 403 organization_admin_required, stops, toasts its message, closes and goes to /app", async () => {
    const inviteMember = answerInvites({
      "first@example.com": new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    });
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com, second@example.com");
    await user.click(sendButton());

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(inviteMember).toHaveBeenCalledTimes(1);
  });

  it("closes on Cancel without a request", async () => {
    const inviteMember = answerInvites();
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole("dialog", { name: "Invite Members" });

    await user.type(emailInput(), "first@example.com");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(inviteMember).not.toHaveBeenCalled();
  });
});
