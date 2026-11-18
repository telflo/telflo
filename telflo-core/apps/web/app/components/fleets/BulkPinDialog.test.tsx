import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type Collector,
  type CollectorGroup,
  type Configuration,
  type FleetType,
  type PinCollectorsRequest,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { answerFor, GROUP_ID, PERSONAL_ID, signedInMember, THEIRS, versionFixture } from "~/test/configurations.js";
import { organizationVariable, variableGroup } from "~/test/variables.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DEFAULT_GROUP_ID,
  expectNoAttributeHolds,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  manyCollectors,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { VERSIONS_FAILED_MESSAGE } from "./CollectorPinPicker.js";
import { BulkPinDialog, bulkPinWords, PIN_COLLECTORS_FAILED_MESSAGE, pinnedWords } from "./BulkPinDialog.js";
import { KUBERNETES_PIN_NOTE } from "./EditCollectorDialog.js";
import { VARIABLES_UNDEFINED_HINT, VARIABLES_USED_LABEL, allDefinedWords } from "./VariableGroupChoice.js";

/*
 * "Pin collectors" (D17b-1 decisions 8, 12 and 27; Preflight rulings 5 and
 * 13): the grid's selected collectors pinned to a chosen version in one
 * request.
 */

const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);

const PAYMENTS_ID = "c0ffee00-0000-4000-8000-000000000001";
const P2_ID = "c0ffee00-0000-4000-8000-000000000102";
const P1_ID = "c0ffee00-0000-4000-8000-000000000101";
const V5_ID = "c0ffee00-0000-4000-8000-000000000005";

const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };
const PAYMENTS: Configuration = { ...THEIRS, id: PAYMENTS_ID, name: "payments-otel" };
const GROUPS = (): CollectorGroup[] => [collectorGroup(), gatewaysGroup()];

/** Collectors in Default (nothing assigned) unless moved by `overrides`. */
const ROWS = (count = 2) => manyCollectors(count);

/** A collector pinned to "checkout-otel @v4", in Default (nothing assigned). */
const versionPinned = (row: Collector): Collector => ({
  ...row,
  groupId: DEFAULT_GROUP_ID,
  pin: { kind: "version", versionId: publishedVersion().versionId, publishedVersionId: PUBLISHED_VERSION_ID, version: publishedVersion() },
});

type PinAnswer = { updated: string[]; notFound: string[] } | "hang" | Error;

interface Api {
  pins: PinAnswer[];
  requests: PinCollectorsRequest[];
}

let api: Api;

function serve() {
  serveNoVariables();
  vi.spyOn(apiClient, "getConfigurations").mockImplementation(async (organizationId, query = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    // No search (Ruling 35): a read never sends q.
    expect(query).toEqual({ filter: "published", limit: 100 });
    return { items: [CHECKOUT, PAYMENTS], nextCursor: null };
  });
  vi.spyOn(apiClient, "getConfigurationVersions").mockImplementation(async (_organizationId, configurationId) => ({
    versions:
      configurationId === PAYMENTS_ID
        ? [configurationVersionListItem({ id: P2_ID, versionNumber: 2 }), configurationVersionListItem({ id: P1_ID, versionNumber: 1 })]
        : [configurationVersionListItem({ id: V5_ID, versionNumber: 5 }), configurationVersionListItem()],
  }));
  return vi.spyOn(apiClient, "pinCollectors").mockImplementation((organizationId, fleetId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    api.requests.push(request);
    const answer = api.pins.shift() ?? { updated: request.collectorIds, notFound: [] };
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
}

let pinSpy: ReturnType<typeof serve>;

/** The dialog open for `rows` in GROUP_ID; Switch changes the organization (the dialog stays, to see its answer dropped); a loader counts revalidations. */
async function renderPin(rows: Collector[] = ROWS(), groups: CollectorGroup[] | null = GROUPS(), fleetType?: FleetType) {
  const mounted = mountPin(rows, groups, fleetType);
  await screen.findByRole("dialog", { name: "Pin collectors" });
  return { user: userEvent.setup(), ...mounted };
}

function mountPin(rows: Collector[], groups: CollectorGroup[] | null, fleetType?: FleetType) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <BulkPinDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collectors={rows}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          groups={groups}
          {...(fleetType === undefined ? {} : { fleetType })}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  return { onOpenChange, onChanged, loader };
}

type User = ReturnType<typeof userEvent.setup>;

const combobox = (name: string) => screen.getByRole("combobox", { name });
const pinButton = () => screen.getByRole("button", { name: /^(Pin \d+|Pinning…)$/ });

/** Opens the Select labelled `label`, once its read has put it there, and picks `option`. */
async function choose(user: User, label: string, option: string | RegExp) {
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Moves the Published version choice off "Leave as is" to "A published version" (Q103). */
async function pickAVersion(user: User) {
  await choose(user, "Published version", "A published version");
}

/** Picks "payments-otel" (its newest, @v2, chosen with it), "A published version" chosen first. */
async function choosePayments(user: User) {
  await pickAVersion(user);
  await choose(user, "Configuration", "payments-otel");
  await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
}

beforeEach(() => {
  vi.restoreAllMocks();
  api = { pins: [], requests: [] };
  pinSpy = serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BulkPinDialog's pin", () => {
  it("pins the selected collectors to a chosen version in one request", async () => {
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choosePayments(user);
    await choose(user, "Version", /@v1/);
    await user.click(pinButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: { kind: "version", versionId: P1_ID } }]);
  });
});

describe("BulkPinDialog (decision 27)", () => {
  it("says decision 9's description for one selected collector", async () => {
    await renderPin(ROWS(1));
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Pin the selected collector to a published version, a variable group, or both; “Follow each collector's group” clears that pin, and “Leave as is” keeps each collector's. A pinned version wins over the group's; a pinned variable group's overrides come first, then the group's variable group's.",
    );
  });

  it('opens on "Leave as is" for both choices, "Pin {n}" disabled until a choice moves and a version is complete (Q103)', async () => {
    const { user } = await renderPin(ROWS(3));
    // D16c (decision 9): the description and the choices name published versions only.
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Pin the 3 selected collectors to a published version, a variable group, or both; “Follow each collector's group” clears that pin, and “Leave as is” keeps each collector's. A pinned version wins over the group's; a pinned variable group's overrides come first, then the group's variable group's.",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/import/i);
    expect(combobox("Published version")).toHaveTextContent("Leave as is");
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("Leave as is");
    expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
    expect(pinButton()).toHaveTextContent("Pin 3");
    expect(pinButton()).toBeDisabled();
    await pickAVersion(user);
    // A version chosen without its version yet is incomplete.
    expect(pinButton()).toBeDisabled();
    await choose(user, "Configuration", "payments-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    expect(pinButton()).toBeEnabled();
  });

  // D17b-2 Ruling 35 (the owner's): no search box; more than a page is reached by "Load more".
  it("offers no configuration search box, and no text field at all", async () => {
    const { user } = await renderPin(ROWS());
    await pickAVersion(user);
    await screen.findByRole("combobox", { name: "Configuration" });
    expect(screen.queryByRole("searchbox", { hidden: true })).toBeNull();
    expect(screen.queryByRole("textbox", { hidden: true })).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it("preselects the newest version once a failed versions read is tried again", async () => {
    vi.mocked(apiClient.getConfigurationVersions).mockRejectedValueOnce(UNAVAILABLE());
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await pickAVersion(user);
    await choose(user, "Configuration", "payments-otel");
    expect(await screen.findByText(VERSIONS_FAILED_MESSAGE)).toBeInTheDocument();
    expect(pinButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: { kind: "version", versionId: P2_ID } }]);
  });

  // The final reviews' Minor 3: the picker's state lived in a child the Pin choice unmounts.
  it("keeps the configuration chosen when the Pin choice switches away and back, nothing read again", async () => {
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choosePayments(user);

    await choose(user, "Published version", "Follow each collector's group");
    expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
    await choose(user, "Published version", "A published version");

    expect(apiClient.getConfigurations).toHaveBeenCalledTimes(1);
    expect(combobox("Configuration")).toHaveTextContent("payments-otel");
    expect(combobox("Version")).toHaveTextContent("@v2");
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: { kind: "version", versionId: P2_ID } }]);
  });

  it('pins to a version, toasts "Pinned {n} collectors.", closes and reloads', async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const rows = ROWS();
    const { user, onOpenChange, onChanged } = await renderPin(rows);
    await choosePayments(user);
    await user.click(pinButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: { kind: "version", versionId: P2_ID } }]);
    expect(toastSuccess).toHaveBeenCalledWith("Pinned 2 collectors.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('unpins with "Follow each collector\'s group" (pin null), toasting "Unpinned {n} collectors."', async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choose(user, "Published version", "Follow each collector's group");
    await user.click(pinButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: null }]);
    expect(toastSuccess).toHaveBeenCalledWith("Unpinned 2 collectors.");
  });

  it.each([
    [{ updated: ["a"], notFound: ["b"] }, "Pinned 1 collector. 1 was deleted meanwhile."],
    [{ updated: ["a"], notFound: ["b", "c"] }, "Pinned 1 collector. 2 were deleted meanwhile."],
  ])("says how many were deleted meanwhile (notFound): %j", async (answer, words) => {
    const toastSuccess = vi.spyOn(toast, "success");
    api.pins = [answer];
    const { user, onChanged } = await renderPin(ROWS(3));
    await choosePayments(user);
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith(words);
    expect(pinnedWords(0, true, 2)).toBe("Unpinned 0 collectors. 2 were deleted meanwhile.");
  });

  it.each([
    ["configuration_version_not_published", () => refusal("configuration_version_not_published", "That version isn't published.", 409), "That version isn't published."],
    ["configuration_version_not_found", () => refusal("configuration_version_not_found", "Configuration version not found.", 404), "Configuration version not found."],
    ["a 429", () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429), "Too many attempts. Please wait and try again."],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), PIN_COLLECTORS_FAILED_MESSAGE],
  ])("shows %s inline and stays open for another try", async (_why, failure, words) => {
    api.pins = [failure()];
    const { user, onOpenChange, onChanged } = await renderPin();
    await choosePayments(user);
    await user.click(pinButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(pinButton()).toBeEnabled();
  });

  it("shows an unknown outcome's words and stays open; a retry sends the same pin; closed after, it reloads", async () => {
    api.pins = [UNAVAILABLE()];
    const { user, onOpenChange, onChanged } = await renderPin();
    await choosePayments(user);
    await user.click(pinButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onChanged).not.toHaveBeenCalled();
    api.pins = [UNAVAILABLE()];
    await user.click(pinButton());
    await waitFor(() => expect(api.requests).toHaveLength(2));
    expect(api.requests[1]).toEqual(api.requests[0]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("ends a pin that never answers at 30 s as an unknown outcome (fake timers)", async () => {
    api.pins = ["hang"];
    const { user } = await renderPin();
    await choosePayments(user);

    vi.useFakeTimers();
    fireEvent.click(pinButton());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(pinButton()).toHaveTextContent("Pinning…");
    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads", async () => {
    api.pins = [refusal("fleet_not_found", "Fleet not found.", 404)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onChanged } = await renderPin();
    await choosePayments(user);
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout", async (_why, failure) => {
    api.pins = [failure()];
    const { user, onOpenChange, loader } = await renderPin();
    const loads = loader.mock.calls.length;
    await choosePayments(user);
    await user.click(pinButton());
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("can't be closed while pinning: Cancel disabled, no X, Escape does nothing; a double click sends once", async () => {
    api.pins = ["hang"];
    const { user, onOpenChange } = await renderPin();
    await choosePayments(user);
    // Both clicks before React renders again.
    act(() => {
      fireEvent.click(pinButton());
      fireEvent.click(pinButton());
    });
    await waitFor(() => expect(pinButton()).toHaveTextContent("Pinning…"));

    expect(pinSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("drops an answer after the organization changed: no toast, no close, no reload", async () => {
    let settle!: (value: { updated: string[]; notFound: string[] }) => void;
    pinSpy.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderPin();
    await choosePayments(user);
    await user.click(pinButton());
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => settle({ updated: [], notFound: [] }));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('marks the group\'s version "(group default)" when every selected collector is in that group, and not otherwise', async () => {
    const inGateways = ROWS().map((row) => ({ ...row, groupId: GATEWAYS_GROUP_ID }));
    const { user } = await renderPin(inGateways);
    await pickAVersion(user);
    await user.click(await screen.findByRole("combobox", { name: "Configuration" }));
    expect(await screen.findByRole("option", { name: "checkout-otel (group default)" })).toBeInTheDocument();
  });

  it("marks no group default for a selection across groups", async () => {
    const rows = ROWS();
    rows[1] = { ...rows[1]!, groupId: GATEWAYS_GROUP_ID };
    const { user } = await renderPin(rows);
    await pickAVersion(user);
    await user.click(await screen.findByRole("combobox", { name: "Configuration" }));
    expect(await screen.findByRole("option", { name: "checkout-otel" })).toBeInTheDocument();
  });
});

// D16c (decision 10): Q18's refusal is gone; following the group is never refused.
describe("BulkPinDialog's Follow each collector's group", () => {
  it.each([
    ["in a group with no published version", GROUPS()],
    ["without the tab's groups", null],
  ])("is never refused, the choices exactly the published version's and the group's, %s", async (_where, groups) => {
    const rows = ROWS(2);
    const { user } = await renderPin([versionPinned(rows[0]!), rows[1]!], groups);
    expect(screen.queryByText(/of the selected run|couldn't be read|import/i)).toBeNull();
    expect(combobox("Published version")).not.toHaveAccessibleDescription();
    await user.click(combobox("Published version"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Leave as is",
      "Follow each collector's group",
      "A published version",
    ]);
    expect(screen.getByRole("option", { name: "Follow each collector's group" })).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("option", { name: "Follow each collector's group" }));
    await user.click(pinButton());
    await waitFor(() => expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: null }]));
  });
});

// D17d-1 decision 4; Preflight ruling 27.
describe("BulkPinDialog's canary note", () => {
  it("is under the Pin select on a Kubernetes-supervisor fleet, describing it, whatever the Pin chosen", async () => {
    const { user } = await renderPin(ROWS(), GROUPS(), "kubernetes-supervisor");
    const note = screen.getByText(KUBERNETES_PIN_NOTE);
    expect(note).toHaveClass("text-muted-foreground");
    expect(combobox("Published version")).toHaveAttribute("aria-describedby", note.id);
    expect(combobox("Published version")).toHaveAccessibleDescription(KUBERNETES_PIN_NOTE);
    await choose(user, "Published version", "Follow each collector's group");
    expect(combobox("Published version")).toHaveAccessibleDescription(KUBERNETES_PIN_NOTE);
  });

  it("is absent on a server fleet", async () => {
    await renderPin(ROWS(), GROUPS(), "server");
    expect(screen.queryByText(KUBERNETES_PIN_NOTE)).toBeNull();
    expect(combobox("Published version")).not.toHaveAttribute("aria-describedby");
  });
});

describe("BulkPinDialog's privacy (decision 32)", () => {
  it("holds no collector, group or configuration name in an attribute: every Select open and chosen", async () => {
    const collectorName = "canary-collector-8c1d";
    const groupName = "canary-group-9d2e";
    const configurationName = "canary-configuration-ae3f";
    const label = "canary-label-bf40";
    vi.mocked(apiClient.getConfigurations).mockResolvedValue({ items: [{ ...CHECKOUT, name: configurationName }], nextCursor: null });
    vi.mocked(apiClient.getConfigurationVersions).mockResolvedValue({ versions: [configurationVersionListItem({ label })] });
    const rows = ROWS().map((row) => ({ ...row, name: collectorName, groupId: GATEWAYS_GROUP_ID }));
    const groups = [collectorGroup(), gatewaysGroup({ name: groupName, assignedVersion: publishedVersion({ configurationName, versionLabel: label }) })];
    const { user } = await renderPin([{ ...versionPinned(rows[0]!), groupId: GATEWAYS_GROUP_ID }, rows[1]!], groups);
    const canaries = [collectorName, groupName, configurationName, label];
    for (const text of canaries) expectNoAttributeHolds(text);

    await pickAVersion(user);
    await user.click(await screen.findByRole("combobox", { name: "Configuration" }));
    await screen.findByRole("option", { name: `${configurationName} (group default)` });
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.click(screen.getByRole("option", { name: `${configurationName} (group default)` }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(combobox("Version")).toHaveTextContent(label);
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.click(combobox("Version"));
    await screen.findByRole("option", { name: new RegExp(label) });
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.keyboard("{Escape}");
  });
});

// D20 (Q103; Preflight rulings 33 and 42; Ruling 50): the Variable group choice beside the version's.
describe("BulkPinDialog's Variable group choice (Q103)", () => {
  const EU_ID = "7b000000-0000-4000-8000-0000000000e1";
  const US_ID = "7b000000-0000-4000-8000-0000000000e2";

  beforeEach(() => {
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name: "eu-edge" }), variableGroup({ id: US_ID, name: "us-edge" })]);
  });

  it("offers Leave as is, Follow each collector's group, then the organization's variable groups, read once at the opening", async () => {
    const { user } = await renderPin();
    await user.click(await screen.findByRole("combobox", { name: "Variable group" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Leave as is",
      "Follow each collector's group",
      "eu-edge",
      "us-edge",
    ]);
    await user.keyboard("{Escape}");
    expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(1);
    expect(apiClient.getVariableGroups).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("sets the variable group alone: no pin sent, toasting \"Variable group set on 2 collectors.\"", async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choose(user, "Variable group", "eu-edge");
    expect(pinButton()).toBeEnabled();
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pinnedVariableGroupId: EU_ID }]);
    expect(api.requests[0]).not.toHaveProperty("pin");
    expect(toastSuccess).toHaveBeenCalledWith("Variable group set on 2 collectors.");
  });

  it("sends a null for Follow each collector's group, toasting \"2 collectors follow their group's variable group.\"", async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choose(user, "Variable group", "Follow each collector's group");
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pinnedVariableGroupId: null }]);
    expect(toastSuccess).toHaveBeenCalledWith("2 collectors follow their group's variable group.");
  });

  it("sends both choices when both moved, toasting \"Pin and variable group set on 2 collectors.\"", async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choosePayments(user);
    await choose(user, "Variable group", "us-edge");
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([
      { collectorIds: rows.map((row) => row.id), pin: { kind: "version", versionId: P2_ID }, pinnedVariableGroupId: US_ID },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Pin and variable group set on 2 collectors.");
  });

  it("leaves the variable group out when only the version moved, and a version left as is out of a variable group's", async () => {
    const rows = ROWS();
    const { user, onChanged } = await renderPin(rows);
    await choose(user, "Published version", "Follow each collector's group");
    await user.click(pinButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ collectorIds: rows.map((row) => row.id), pin: null }]);
    expect(api.requests[0]).not.toHaveProperty("pinnedVariableGroupId");
  });

  it("enables Pin again only once a choice moves back off Leave as is", async () => {
    const { user } = await renderPin();
    await choose(user, "Variable group", "eu-edge");
    expect(pinButton()).toBeEnabled();
    await choose(user, "Variable group", "Leave as is");
    expect(pinButton()).toBeDisabled();
  });

  it("words each toast with its counts (Q103; Ruling 50), never a name", () => {
    expect(bulkPinWords({ pin: undefined, variableGroupId: EU_ID }, 1, 0)).toBe("Variable group set on 1 collector.");
    expect(bulkPinWords({ pin: undefined, variableGroupId: null }, 1, 0)).toBe("1 collector follows its group's variable group.");
    expect(bulkPinWords({ pin: undefined, variableGroupId: null }, 12, 0)).toBe("12 collectors follow their group's variable group.");
    expect(bulkPinWords({ pin: null, variableGroupId: null }, 12, 0)).toBe("Pin and variable group set on 12 collectors.");
    expect(bulkPinWords({ pin: null, variableGroupId: undefined }, 12, 0)).toBe("Unpinned 12 collectors.");
    expect(bulkPinWords({ pin: { kind: "version", versionId: P2_ID }, variableGroupId: undefined }, 12, 0)).toBe("Pinned 12 collectors.");
    expect(bulkPinWords({ pin: undefined, variableGroupId: EU_ID }, 12, 2)).toBe("Variable group set on 12 collectors. 2 were deleted meanwhile.");
  });

  it("shows a 422 variables_undefined's words and its names, at most 100, then … and N more", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `UNDEFINED_${index}`);
    api.pins = [
      new ApiError("variables_undefined", "The published version references organization variables that aren't defined: define them first.", {
        status: 422,
        details: { names, totalNames: 103 },
      }),
    ];
    const { user, onOpenChange } = await renderPin();
    await choosePayments(user);
    await user.click(pinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The published version references organization variables that aren't defined: define them first.",
    );
    expect(screen.getByText("UNDEFINED_0")).toBeInTheDocument();
    expect(screen.getByText("UNDEFINED_99")).toBeInTheDocument();
    expect(screen.getByText("… and 3 more")).toBeInTheDocument();
    expect(screen.getByText("UNDEFINED_0").closest(".ph-no-capture")).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows a 404 variable_group_not_found's words inline, and reads the variable groups again", async () => {
    api.pins = [new ApiError("variable_group_not_found", "Variable group not found", { status: 404 })];
    const { user } = await renderPin();
    await choose(user, "Variable group", "eu-edge");
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: US_ID, name: "us-edge" })]);
    await user.click(pinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Variable group not found");
    await waitFor(() => expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("A variable group no longer listed");
  });

  it("says the variable groups couldn't be read, with Try again, and sends no variable group meanwhile", async () => {
    vi.mocked(apiClient.getVariableGroups).mockRejectedValueOnce(UNAVAILABLE());
    const { user } = await renderPin();
    expect(await screen.findByText("Failed to load variable groups")).toBeInTheDocument();
    expect(pinButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("Leave as is");
  });

  // D17c-1 Ruling 66's probe: a parent's reload while the dialog is open moves nothing of its baseline.
  it("keeps the selection and the lists it offers as they were at the opening when the parent reloads", async () => {
    const opened = ROWS(2);
    const reloaded = manyCollectors(3, 10);
    function Page() {
      const [rows, setRows] = useState(opened);
      const [groups, setGroups] = useState<CollectorGroup[] | null>(GROUPS());
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setRows(reloaded);
              setGroups(null);
            }}
          >
            Reload
          </button>
          <BulkPinDialog open onOpenChange={vi.fn()} collectors={rows} organizationId={GROUP_ID} fleetId={FLEET_ID} groups={groups} onChanged={vi.fn()} />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Page, loader: () => null, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Pin collectors" });
    expect(pinButton()).toHaveTextContent("Pin 2");
    fireEvent.click(screen.getByRole("button", { name: "Reload", hidden: true }));
    expect(pinButton()).toHaveTextContent("Pin 2");
    await choose(user, "Variable group", "eu-edge");
    await user.click(pinButton());
    await waitFor(() => expect(api.requests).toHaveLength(1));
    expect(api.requests[0]!.collectorIds).toEqual(opened.map((row) => row.id));
    expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(1);
  });

  it("holds no variable group's name in an attribute; its Select's trigger and list sit inside ph-no-capture (Q88)", async () => {
    const name = "canary-variable-group-5a1";
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name })]);
    const { user } = await renderPin();
    await user.click(await screen.findByRole("combobox", { name: "Variable group" }));
    const option = await screen.findByRole("option", { name });
    expectNoAttributeHolds(name);
    expect(option.closest(".ph-no-capture")).not.toBeNull();
    await user.click(option);
    expect(combobox("Variable group")).toHaveTextContent(name);
    expect(combobox("Variable group")).toHaveClass("ph-no-capture");
    expectNoAttributeHolds(name);
    // Radix's hidden native <select> inside the form holds the names as its options' text: inside ph-no-capture too.
    const native = [...document.querySelectorAll("select option")].filter((each) => (each.textContent ?? "").includes(name));
    expect(native.length).toBeGreaterThan(0);
    for (const each of native) expect(each.closest(".ph-no-capture")).not.toBeNull();
    await user.click(pinButton());
    await waitFor(() => expect(api.requests).toHaveLength(1));
    const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((each) => each.textContent ?? "");
    for (const text of toasts) expect(text).not.toContain(name);
  });
});

// D20 final review side 2, Minor 5 (Q86: the platform's dialogs show the names before Save too): the group dialogs'
// "Variables used", for the published version chosen.
describe("BulkPinDialog's Variables used (Q86)", () => {
  beforeEach(() => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    vi.mocked(apiClient.getConfigurationVersion).mockImplementation(async (organizationId, configurationId, versionId) => {
      expect(organizationId).toBe(GROUP_ID);
      const yamlContent = versionId === P2_ID ? "exporters:\n  otlp:\n    endpoint: ${org:OTLP_EP}\n    headers: { region: ${org:REGION} }\n" : "a: ${org:OTLP_EP}";
      return answerFor({ ...THEIRS, id: configurationId }, versionFixture({ id: versionId, configurationId, yamlContent }));
    });
    vi.mocked(apiClient.getOrganizationVariables).mockResolvedValue([organizationVariable({ name: "OTLP_EP" })]);
  });

  afterEach(() => {
    useUserStore.getState().clear();
    forgetOrgVariableNames();
  });

  it('lists the chosen version\'s names no organization variable has before Pin, inside ph-no-capture, with "Saving is refused…"', async () => {
    const { user } = await renderPin();
    expect(screen.queryByText(VARIABLES_USED_LABEL)).toBeNull();
    await choosePayments(user);
    const missing = await screen.findByText("REGION");
    expect(missing.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText(VARIABLES_UNDEFINED_HINT)).toBeInTheDocument();
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    expect(apiClient.getConfigurationVersion).toHaveBeenCalledWith(
      GROUP_ID,
      PAYMENTS_ID,
      P2_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expectNoAttributeHolds("REGION");

    await choose(user, "Configuration", "checkout-otel");
    expect(await screen.findByText(allDefinedWords(1))).toBeInTheDocument();
    expect(screen.queryByText("REGION")).toBeNull();
    // Leave as is, or Follow each collector's group: no version, nothing to check.
    await choose(user, "Published version", "Follow each collector's group");
    expect(screen.queryByText(VARIABLES_USED_LABEL)).toBeNull();
  });
});
