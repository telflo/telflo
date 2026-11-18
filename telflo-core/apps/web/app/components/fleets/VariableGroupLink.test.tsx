import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, MemoryRouter } from "react-router";
import type { Collector } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { forgetVariableGroupNames } from "~/lib/variable-group-display.js";
import { GROUP_ID, signedInMember } from "~/test/configurations.js";
import { collector, collectorGroup, expectNoAttributeHolds, FLEET_ID, gatewaysGroup, GATEWAYS_GROUP_ID } from "~/test/fleets.js";
import { organizationVariable, variableGroup, variableGroupDetail, variableGroupOverride } from "~/test/variables.js";
import { CollectorDetailsDialog } from "./CollectorDetailsDialog.js";
import { GroupDetailsDialog } from "./GroupDetailsDialog.js";
import {
  COLLECTOR_VALUES_DESCRIPTION,
  GROUP_LEVEL_UNKNOWN_WORDS,
  GROUP_VALUES_DESCRIPTION,
  UNKNOWN_SOURCE,
  VARIABLE_VALUES_FAILED_MESSAGE,
  VARIABLE_VALUES_TITLE,
  VariableGroupLink,
} from "./VariableGroupLink.js";

/*
 * A variable group named in a fleet screen (D20 default 25; Q84): the
 * trigger names the variable group ("Organization values" for
 * none), and its dialog lists every organization variable, the value it
 * takes and where it comes from; here through D20's two levels (the pinned
 * variable group's override, then the collector group's, then the
 * organization's value).
 */

const PINNED_ID = "7b000000-0000-4000-8000-0000000000a1";
const BOUND_ID = "7b000000-0000-4000-8000-0000000000b1";
const ENDPOINT_ID = "7a000000-0000-4000-8000-000000000011";
const REGION_ID = "7a000000-0000-4000-8000-000000000012";
const TIER_ID = "7a000000-0000-4000-8000-000000000013";

const VARIABLES = [
  organizationVariable({ id: ENDPOINT_ID, name: "OTLP_EP", value: "https://org.example", description: "The endpoint" }),
  organizationVariable({ id: REGION_ID, name: "REGION", value: "org-region", description: null }),
  organizationVariable({ id: TIER_ID, name: "TIER", value: "org-tier", description: null }),
];

function serve() {
  vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([
    variableGroup({ id: PINNED_ID, name: "canary-pin" }),
    variableGroup({ id: BOUND_ID, name: "eu-edge" }),
  ]);
  vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue(VARIABLES);
  return vi.spyOn(apiClient, "getVariableGroup").mockImplementation(async (_organizationId, variableGroupId) =>
    variableGroupId === PINNED_ID
      ? variableGroupDetail({ id: PINNED_ID, name: "canary-pin" }, [variableGroupOverride({ variableId: ENDPOINT_ID, value: "https://pin.example" })])
      : variableGroupDetail({ id: BOUND_ID, name: "eu-edge" }, [
          variableGroupOverride({ variableId: ENDPOINT_ID, value: "https://group.example" }),
          variableGroupOverride({ variableId: REGION_ID, value: "eu-west" }),
        ]),
  );
}

function rowOf(dialog: HTMLElement, name: string): string[] {
  const row = within(dialog).getByText(name).closest("tr")!;
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
});

afterEach(() => {
  useUserStore.getState().clear();
  forgetVariableGroupNames();
});

describe("VariableGroupLink (default 25; Q84)", () => {
  it("resolves a collector's every variable through its pinned variable group, then its group's, then the organization's", async () => {
    const detail = serve();
    const user = userEvent.setup();
    render(<VariableGroupLink pinnedVariableGroupId={PINNED_ID} groupVariableGroupId={BOUND_ID} />);
    await user.click(await screen.findByRole("button", { name: "canary-pin" }));
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    expect(dialog).toHaveAccessibleDescription(COLLECTOR_VALUES_DESCRIPTION);
    await within(dialog).findByText("OTLP_EP");
    expect(rowOf(dialog, "OTLP_EP")).toEqual(["OTLP_EPThe endpoint", "https://pin.example", "Pinned variable group"]);
    expect(rowOf(dialog, "REGION")).toEqual(["REGION", "eu-west", "Group's variable group"]);
    expect(rowOf(dialog, "TIER")).toEqual(["TIER", "org-tier", "Organization value"]);
    expect(within(dialog).getByText("canary-pin")).toBeInTheDocument();
    expect(within(dialog).getByText("eu-edge")).toBeInTheDocument();
    expect(detail).toHaveBeenCalledWith(GROUP_ID, PINNED_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(detail).toHaveBeenCalledWith(GROUP_ID, BOUND_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("resolves a group's through its own variable group: Override, else the organization's value", async () => {
    serve();
    const user = userEvent.setup();
    render(<VariableGroupLink groupVariableGroupId={BOUND_ID} />);
    await user.click(await screen.findByRole("button", { name: "eu-edge" }));
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    expect(dialog).toHaveAccessibleDescription(GROUP_VALUES_DESCRIPTION);
    await within(dialog).findByText("OTLP_EP");
    expect(rowOf(dialog, "OTLP_EP")).toEqual(["OTLP_EPThe endpoint", "https://group.example", "Override"]);
    expect(rowOf(dialog, "TIER")).toEqual(["TIER", "org-tier", "Organization value"]);
    expect(within(dialog).queryByText("Pinned variable group")).toBeNull();
  });

  it("shows Organization values for none, reading no variable group, and the organization's values in its dialog", async () => {
    const detail = serve();
    const user = userEvent.setup();
    render(<VariableGroupLink pinnedVariableGroupId={null} groupVariableGroupId={null} />);
    await user.click(screen.getByRole("button", { name: "Organization values" }));
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    await within(dialog).findByText("OTLP_EP");
    expect(rowOf(dialog, "OTLP_EP")).toEqual(["OTLP_EPThe endpoint", "https://org.example", "Organization value"]);
    expect(detail).not.toHaveBeenCalled();
    expect(apiClient.getVariableGroups).not.toHaveBeenCalled();
  });

  it("says the values couldn't be read, with Try again", async () => {
    serve();
    vi.mocked(apiClient.getOrganizationVariables).mockRejectedValueOnce(new ApiError("variables_unavailable", "x", { status: 503 }));
    const user = userEvent.setup();
    render(<VariableGroupLink groupVariableGroupId={null} />);
    await user.click(screen.getByRole("button", { name: "Organization values" }));
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    expect(await within(dialog).findByText(VARIABLE_VALUES_FAILED_MESSAGE)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("OTLP_EP")).toBeInTheDocument();
  });

  it("keeps every name, value and description out of attributes and inside ph-no-capture; its title fixed words (Q88)", async () => {
    serve();
    vi.mocked(apiClient.getOrganizationVariables).mockResolvedValue([
      organizationVariable({ id: ENDPOINT_ID, name: "CANARY_NAME_1F", value: "value-canary-1f", description: "description-canary-1f" }),
    ]);
    const user = userEvent.setup();
    render(<VariableGroupLink pinnedVariableGroupId={PINNED_ID} groupVariableGroupId={BOUND_ID} />);
    const trigger = await screen.findByRole("button", { name: "canary-pin" });
    expect(screen.getByText("canary-pin").closest(".ph-no-capture")).not.toBeNull();
    expect(trigger).not.toHaveAttribute("title");
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    const value = await within(dialog).findByText("https://pin.example");
    expect(value.closest(".ph-no-capture")).not.toBeNull();
    expect(within(dialog).getByText("CANARY_NAME_1F").closest(".ph-no-capture")).not.toBeNull();
    expect(within(dialog).getByText("description-canary-1f").closest(".ph-no-capture")).not.toBeNull();
    for (const text of ["canary-pin", "eu-edge", "CANARY_NAME_1F", "value-canary-1f", "description-canary-1f", "https://pin.example"]) {
      expectNoAttributeHolds(text);
    }
    expect(document.title).not.toContain("canary-pin");
  });
});

describe("VariableGroupLink with the collector's group unknown (Q84: each row's source)", () => {
  it("shows the pin's overrides, says the group's variable group couldn't be read, and marks every other row Unknown", async () => {
    const detail = serve();
    const user = userEvent.setup();
    render(<VariableGroupLink pinnedVariableGroupId={PINNED_ID} groupVariableGroupId={undefined} />);
    await user.click(await screen.findByRole("button", { name: "canary-pin" }));
    const dialog = await screen.findByRole("dialog", { name: VARIABLE_VALUES_TITLE });
    await within(dialog).findByText("OTLP_EP");
    expect(rowOf(dialog, "OTLP_EP")).toEqual(["OTLP_EPThe endpoint", "https://pin.example", "Pinned variable group"]);
    expect(rowOf(dialog, "REGION")).toEqual(["REGION", "—", UNKNOWN_SOURCE]);
    expect(rowOf(dialog, "TIER")).toEqual(["TIER", "—", UNKNOWN_SOURCE]);
    expect(within(dialog).queryByText("org-region")).toBeNull();
    expect(within(dialog).queryByText("Organization value")).toBeNull();
    expect(within(dialog).getByText(GROUP_LEVEL_UNKNOWN_WORDS)).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledWith(GROUP_ID, PINNED_ID, expect.anything());
  });

  it("shows a dash for a collector with no pin while its group is unknown", () => {
    serve();
    render(<VariableGroupLink pinnedVariableGroupId={null} groupVariableGroupId={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("the details' Variable group rows (default 25)", () => {
  it("shows a group's variable group in its details", async () => {
    serve();
    render(
      <MemoryRouter>
        <GroupDetailsDialog open onOpenChange={vi.fn()} group={gatewaysGroup({ variableGroupId: BOUND_ID })} />
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole("dialog", { name: "gateways" });
    expect(await within(dialog).findByRole("button", { name: "eu-edge" })).toBeInTheDocument();
  });

  it("shows a collector's pinned variable group, and the effective one (the pin's, else its group's)", async () => {
    serve();
    vi.spyOn(apiClient, "getCollector").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] });
    vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null });
    const groups = [collectorGroup(), gatewaysGroup({ variableGroupId: BOUND_ID })];
    const renderDetails = (row: Collector) => {
      const Stub = createRoutesStub([
        {
          path: "/",
          Component: () => (
            <CollectorDetailsDialog
              open
              onOpenChange={vi.fn()}
              collector={row}
              organizationId={GROUP_ID}
              fleetId={FLEET_ID}
              groups={groups}
              onCollectorGone={vi.fn()}
            />
          ),
          HydrateFallback: () => null,
        },
      ]);
      render(<Stub initialEntries={["/"]} />);
    };
    const effectiveRow = () => screen.getByText("Variable group", { selector: "div" }).nextElementSibling as HTMLElement;

    renderDetails(collector({ groupId: GATEWAYS_GROUP_ID, pinnedVariableGroupId: PINNED_ID }));
    const label = await screen.findByText("Pinned variable group");
    await waitFor(() => expect(label.nextElementSibling).toHaveTextContent(/^canary-pin$/));
    // The pinned one's name as text inside ph-no-capture; neither name in any attribute of the details.
    expect(within(label.nextElementSibling as HTMLElement).getByText("canary-pin").closest(".ph-no-capture")).not.toBeNull();
    const details = screen.getByRole("dialog");
    expectNoAttributeHolds("canary-pin", details);
    expectNoAttributeHolds("eu-edge", details);
    expect(within(effectiveRow()).getByRole("button")).toHaveTextContent(/^canary-pin$/);
    cleanup();

    renderDetails(collector({ groupId: GATEWAYS_GROUP_ID }));
    expect((await screen.findByText("Pinned variable group")).nextElementSibling).toHaveTextContent(/^None: follows its group$/);
    expect(await within(effectiveRow()).findByRole("button", { name: "eu-edge" })).toBeInTheDocument();
  });
});
