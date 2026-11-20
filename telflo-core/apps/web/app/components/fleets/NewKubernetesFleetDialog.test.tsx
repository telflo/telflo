import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import type { CreateFleetRequest } from "@telflo/contracts";
import { KUBERNETES_FLEET_INTRO, NewKubernetesFleetDialog } from "./NewKubernetesFleetDialog.js";
import { UNKNOWN_OUTCOME_MESSAGE } from "./NewFleetDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { GROUP_ID } from "~/test/configurations.js";
import { fleetCreated } from "~/test/fleets.js";

/*
 * The Kubernetes fleet's create dialog: what it shows, and what differs from
 * the server dialog. The create they share is tested through
 * `NewServerFleetDialog.test.tsx`.
 */

function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

async function renderDialog() {
  function Page() {
    const [open, setOpen] = useState(true);
    return <NewKubernetesFleetDialog open={open} onOpenChange={setOpen} organizationId={GROUP_ID} />;
  }
  const Stub = createRoutesStub([
    { path: "/fleet-management", Component: Page },
    { path: "/fleet-management/:fleetId", Component: Landed },
  ]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  await screen.findByRole("dialog", { name: "New Kubernetes Supervisor Fleet" });
  return { user: userEvent.setup() };
}

function serveCreates(...failures: ApiError[]) {
  const requests: CreateFleetRequest[] = [];
  vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => {
    requests.push(request);
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return { kind: "created", ...fleetCreated({ id: request.id!, label: request.label, type: request.type }) };
  });
  return requests;
}

describe("NewKubernetesFleetDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(toast, "success");
  });

  it("asks only for a name — no configuration, version, or expiry pickers", async () => {
    await renderDialog();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Configuration")).toBeNull();
    expect(screen.queryByLabelText("Version")).toBeNull();
    expect(screen.queryByLabelText("Token expiry")).toBeNull();
    expect(screen.getByText("Give this fleet a name.")).toBeInTheDocument();
  });

  it("says what the platform makes: no bridge or operator, and both tokens shown once (not a static token)", async () => {
    await renderDialog();
    expect(screen.getByText(KUBERNETES_FLEET_INTRO)).toBeInTheDocument();
    expect(KUBERNETES_FLEET_INTRO).toMatch(/^No bridge, no operator/);
    expect(KUBERNETES_FLEET_INTRO).toContain("both of its tokens are shown here once");
    expect(KUBERNETES_FLEET_INTRO).not.toMatch(/static/);
  });

  it("requires a name before the fleet can be created", async () => {
    const { user } = await renderDialog();
    const submit = screen.getByRole("button", { name: "Create fleet" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "supervisor-fleet");
    expect(submit).toBeEnabled();
  });

  it("creates a kubernetes-supervisor fleet whose rotate token never expires, trimmed, and shows both tokens once", async () => {
    const requests = serveCreates();
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText("Name"), " prod-cluster ");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));

    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    expect(requests).toEqual([{ id: expect.any(String), label: "prod-cluster", type: "kubernetes-supervisor", rotateExpiresAt: null }]);
    expect(screen.getByText(maskSecret(fleetCreated().tokens.default.bearer)).closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText(maskSecret(fleetCreated().tokens.rotate.bearer)).closest(".ph-no-capture")).not.toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Fleet "prod-cluster" created');

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(`landed on /fleet-management/${requests[0]!.id}`)).toBeInTheDocument();
  });

  it("locks the name after an unknown outcome and retries with the same request, rotateExpiresAt null again", async () => {
    const requests = serveCreates(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText("Name"), "prod-cluster");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(await screen.findByText(UNKNOWN_OUTCOME_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]!.rotateExpiresAt).toBeNull();
  });

  it("shows a 400's rotateExpiresAt problem as the fallback words, having no Token expiry to show it under", async () => {
    const details = [{ instancePath: "/rotateExpiresAt", params: { issue: { path: ["rotateExpiresAt"] } }, message: "Must be a time in the future." }];
    serveCreates(new ApiError("invalid_request", "The request was not valid.", { status: 400, details }));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText("Name"), "prod-cluster");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(await screen.findByText("Failed to create fleet")).toBeInTheDocument();
  });
});
