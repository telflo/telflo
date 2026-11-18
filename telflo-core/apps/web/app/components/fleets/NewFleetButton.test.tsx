import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { NewFleetButton, NewFleetDialogs, useNewFleetDialogs } from "./NewFleetButton.js";
import { UNKNOWN_OUTCOME_MESSAGE } from "./NewFleetDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { anyStateHolds, DEFAULT_TOKEN_ID, ROTATE_TOKEN_ID, fleet, fleetCreated, listedToken } from "~/test/fleets.js";

/** "New Fleet": the button, the type chooser, then that type's create dialog (D17a decision 24). */

function renderButton() {
  const onMayHaveCreated = vi.fn();
  function Page() {
    const dialogs = useNewFleetDialogs();
    return (
      <>
        <NewFleetButton dialogs={dialogs} />
        <NewFleetDialogs dialogs={dialogs} onMayHaveCreated={onMayHaveCreated} />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page }]);
  const { container } = render(<Stub initialEntries={["/fleet-management"]} />);
  return { user: userEvent.setup(), onMayHaveCreated, container };
}

describe("NewFleetButton (D17a decision 24)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  });

  it("opens the chooser, and a type picked closes it and opens that type's create dialog", async () => {
    const { user } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    expect(await screen.findByRole("dialog", { name: "New server fleet" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Create a new fleet" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Kubernetes (Helm)"));
    expect(await screen.findByRole("dialog", { name: "New Kubernetes Supervisor Fleet" })).toBeInTheDocument();
  });

  it("creates in the active organization", async () => {
    const create = vi.spyOn(apiClient, "createFleet").mockRejectedValue(new ApiError("rate_limited", "Too many attempts.", { status: 429 }));
    const { user } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-prod");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    await screen.findByText("Too many attempts.");
    expect(create).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ label: "edge-prod", type: "server" }), expect.anything());
  });

  it("calls onMayHaveCreated when a create dialog closes after an unknown outcome", async () => {
    vi.spyOn(apiClient, "createFleet").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    const { user, onMayHaveCreated } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Kubernetes (Helm)"));
    await user.type(await screen.findByLabelText("Name"), "prod-cluster");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    await screen.findByText(UNKNOWN_OUTCOME_MESSAGE);
    expect(onMayHaveCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onMayHaveCreated).toHaveBeenCalledTimes(1);
  });

  it("closes a create dialog under way when the active organization changes, and opens fresh after (no trap in Creating…)", async () => {
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
    let finish!: () => void;
    const create = vi.spyOn(apiClient, "createFleet").mockImplementation(
      (_organizationId, request) =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: "created", ...fleetCreated({ id: request.id!, label: request.label }) });
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, container } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-prod");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    // A switch elsewhere, while the create is under way.
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The create made in the organization before answers (201): nothing shows, its bearers never, no toast.
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(fleetCreated().tokens.default.bearer);
    expect(success).not.toHaveBeenCalled();
    expect(anyStateHolds(fleetCreated().tokens.default.bearer, container)).toBe(false);

    // A new create starts afresh, in the new organization.
    await user.click(screen.getByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    expect(await screen.findByLabelText("Name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create fleet" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(PERSONAL_ID, expect.anything(), expect.anything());
  });

  it("drops a retry's 200 whose reveals answer after the active organization changed: no tokens, no toast", async () => {
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
    vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => ({
      kind: "existing",
      fleet: fleet({ id: request.id!, label: request.label }),
    }));
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({
      tokens: [listedToken({ id: ROTATE_TOKEN_ID }), listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" })],
    });
    const answers: Array<() => void> = [];
    const reveal = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(
      (_organizationId, _fleetId, tokenId) =>
        new Promise((resolve) => {
          answers.push(() =>
            resolve({
              token:
                tokenId === DEFAULT_TOKEN_ID
                  ? { id: tokenId, kind: "default", bearer: "tfd_revealed-canary", expiresAt: null }
                  : { id: tokenId, kind: "rotate", bearer: "tfr_revealed-canary", expiresAt: null },
            }),
          );
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, container } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-prod");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    // The 200 read the tokens, and both reveals are under way.
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));

    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => answers.forEach((answer) => answer()));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("revealed-canary");
    expect(success).not.toHaveBeenCalled();
    expect(anyStateHolds("revealed-canary", container)).toBe(false);
  });

  it("drops the bearers from the closed dialog's state when the active organization changes while they show", async () => {
    vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => ({
      kind: "created",
      ...fleetCreated({ id: request.id!, label: request.label }),
    }));
    const { user, container } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-prod");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    const bearer = fleetCreated().tokens.rotate.bearer;
    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toHaveTextContent(maskSecret(bearer));
    expect(anyStateHolds(bearer, container)).toBe(true);

    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(document.body.textContent).not.toContain(bearer);
    expect(anyStateHolds(bearer, container)).toBe(false);
    expect(anyStateHolds(fleetCreated().tokens.default.bearer, container)).toBe(false);
  });

  it("closes the type chooser when the active organization changes", async () => {
    const { user } = renderButton();
    await user.click(await screen.findByRole("button", { name: "New Fleet" }));
    expect(await screen.findByRole("dialog", { name: "Create a new fleet" })).toBeInTheDocument();
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("is disabled with no active organization", async () => {
    useUserStore.getState().clear();
    renderButton();
    expect(await screen.findByRole("button", { name: "New Fleet" })).toBeDisabled();
  });
});
