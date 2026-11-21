import { createRoutesStub, useLocation } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTOR_LOCKED_WORDS } from "~/components/fleets/CollectorsTab.js";
import { FLEET_ACTION_LOCKED_WORDS } from "~/components/fleets/FleetActionDialogs.js";
import { GROUP_LOCKED_WORDS } from "~/components/fleets/GroupsTab.js";
import { KUBERNETES_GROUP_LOCKED_WORDS } from "~/components/fleets/KubernetesGroupsTab.js";
import { NEW_FLEET_LOCKED_WORDS } from "~/components/fleets/NewFleetButton.js";
import { ASSIGN_LOCKED_WORDS } from "~/components/fleets/SetupChecklist.js";
import { TOKEN_LOCKED_WORDS } from "~/components/fleets/TokensTab.js";
import { VARIABLE_VALUES_LOCKED_WORDS } from "~/components/fleets/VariableGroupLink.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import { SAMPLE_READS } from "~/lib/playground/sample-reads.js";
import { SAMPLE_FLEET_IDS } from "~/lib/playground/sample/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { ORGANIZATION_VALUES } from "~/lib/variable-group-display.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { INSTALL_LOCKED_WORDS } from "./fleet-management.$fleetId.js";
import PlaygroundLayout from "./playground.js";
import PlaygroundFleet from "./playground.fleet-management.$fleetId.js";
import PlaygroundFleets from "./playground.fleet-management.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

/*
 * The playground's fleet pages: the list and both kinds of fleet page on
 * the sample, inside the shell, read through the seam and never the API
 * client; reads open (a collector's details, a group's details, an install
 * link's View); every write locked at its opener, the sign-up prompt with
 * its own words and no dialog of its own; "Fleet not found" for an id the
 * sample doesn't hold; links inside the reused components landing on the
 * playground's pages. The fleets' labels and the collectors' names are the
 * sample's own words.
 */

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderPlayground(path: string) {
  const Stub = createRoutesStub([
    {
      path: "/playground",
      Component: PlaygroundLayout,
      children: [
        {
          path: "fleet-management",
          Component: () => (
            <>
              <PlaygroundFleets />
              <Where />
            </>
          ),
        },
        {
          path: "fleet-management/:fleetId",
          Component: () => (
            <>
              <PlaygroundFleet />
              <Where />
            </>
          ),
        },
      ],
    },
    { path: "*", Component: Where },
  ]);
  render(<Stub initialEntries={[path]} />);
  return userEvent.setup();
}

const prompt = () => screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });

/** Presses `button` and expects the sign-up prompt with `words`, then closes it ("Keep exploring"). */
async function expectLocked(user: ReturnType<typeof userEvent.setup>, button: HTMLElement, words: string) {
  const dialogsBefore = document.querySelectorAll('[role="dialog"]').length;
  await user.click(button);
  const dialog = await prompt();
  expect(within(dialog).getByText(signupPromptText(words))).toBeInTheDocument();
  // The prompt is the only dialog opened: the action's own never did.
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(dialogsBefore + 1);
  await user.click(within(dialog).getByRole("button", { name: "Keep exploring" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: SIGNUP_PROMPT_TITLE })).toBeNull());
}

let spies: ReturnType<typeof spyOnTheClient>;

beforeEach(() => {
  vi.restoreAllMocks();
  spies = spyOnTheClient();
});
afterEach(() => {
  // Cleared first, so one test's failure here never carries into the next.
  useUserStore.getState().clear();
  document.body.className = "";
  // No reader reached the API client: the playground reads the sample only.
  for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
});

describe("the fleet list", () => {
  it("shows the sample's four fleets inside the shell, with no stats strip or usage", async () => {
    renderPlayground("/playground/fleet-management");
    expect(screen.getByText("You're in the playground")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Fleets" })).toBeInTheDocument();
    expect(screen.getByText("Acme Observability", { selector: "span" })).toBeInTheDocument();
    for (const label of ["prod-us-east", "staging-eu", "edge-import-pilot", "k8s-prod-us-west"]) {
      expect(await screen.findByRole("link", { name: label })).toBeInTheDocument();
    }
    // The stats strip is a fleet page's (its "Version drift" tile); one page holds the four.
    expect(screen.queryByText("Version drift")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("reads the sample even for a signed-in visitor, whose own organization never reaches the reads", async () => {
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
    renderPlayground("/playground/fleet-management");
    expect(await screen.findByRole("link", { name: "prod-us-east" })).toBeInTheDocument();
  });

  it("locks New Fleet and each row's Rename, Archive and Delete at their openers", async () => {
    const user = renderPlayground("/playground/fleet-management");
    await screen.findByRole("link", { name: "prod-us-east" });
    await expectLocked(user, screen.getByRole("button", { name: "New Fleet" }), NEW_FLEET_LOCKED_WORDS);
    await expectLocked(user, screen.getByRole("button", { name: "Rename prod-us-east" }), FLEET_ACTION_LOCKED_WORDS.rename);
    await expectLocked(user, screen.getByRole("button", { name: "Archive prod-us-east" }), FLEET_ACTION_LOCKED_WORDS.archive);
    await expectLocked(user, screen.getByRole("button", { name: "Delete prod-us-east" }), FLEET_ACTION_LOCKED_WORDS.delete);
  });

  it("sends a fleet's link (its signed-in path in the DOM) to the playground's fleet page", async () => {
    const user = renderPlayground("/playground/fleet-management");
    const link = await screen.findByRole("link", { name: "staging-eu" });
    expect(link).toHaveAttribute("href", `/fleet-management/${SAMPLE_FLEET_IDS.staging}`);
    await user.click(link);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/playground/fleet-management/${SAMPLE_FLEET_IDS.staging}`));
    expect(await screen.findByRole("heading", { level: 1, name: "staging-eu" })).toBeInTheDocument();
  });
});

describe("a server fleet's page", () => {
  const PROD = `/playground/fleet-management/${SAMPLE_FLEET_IDS.prod}`;

  it("shows the header, the stats strip and the Collectors tab on the sample", async () => {
    renderPlayground(PROD);
    expect(await screen.findByRole("heading", { level: 1, name: "prod-us-east" })).toBeInTheDocument();
    expect(screen.getByText("Version drift")).toBeInTheDocument();
    expect(screen.getByText("Token expires")).toBeInTheDocument();
    for (const tab of ["Collectors", "Groups", "Tokens"]) expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    for (const name of ["loving-tortoise", "brave-falcon", "quiet-meadow", "wandering-comet", "noble-ibex"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("opens a collector's details (a read), with its error history; its edit is locked", async () => {
    const user = renderPlayground(PROD);
    await user.click(await screen.findByRole("button", { name: "brave-falcon" }));
    const details = await screen.findByRole("dialog", { name: "brave-falcon" });
    expect(await within(details).findAllByText(/unknown type "tailsampling"/)).not.toHaveLength(0);
    await user.click(within(details).getByRole("button", { name: "Edit collector" }));
    const dialog = await prompt();
    expect(within(dialog).getByText(signupPromptText(COLLECTOR_LOCKED_WORDS.edit))).toBeInTheDocument();
  });

  it("locks the header's actions, install and every collector write at their openers", async () => {
    const user = renderPlayground(PROD);
    await screen.findByRole("button", { name: "brave-falcon" });
    await expectLocked(user, screen.getByRole("button", { name: "Install collector" }), INSTALL_LOCKED_WORDS.server);
    await expectLocked(user, screen.getByRole("button", { name: "Rename" }), FLEET_ACTION_LOCKED_WORDS.rename);
    await expectLocked(user, screen.getByRole("button", { name: "Archive" }), FLEET_ACTION_LOCKED_WORDS.archive);
    await expectLocked(user, screen.getByRole("button", { name: "Delete" }), FLEET_ACTION_LOCKED_WORDS.delete);
    await expectLocked(user, screen.getByRole("button", { name: "Edit loving-tortoise" }), COLLECTOR_LOCKED_WORDS.edit);
    await expectLocked(user, screen.getByRole("button", { name: "Delete loving-tortoise" }), COLLECTOR_LOCKED_WORDS.delete);
    await user.click(screen.getByRole("checkbox", { name: "Select brave-falcon" }));
    await expectLocked(user, screen.getByRole("button", { name: "Pin selected collectors" }), COLLECTOR_LOCKED_WORDS.pin);
    await expectLocked(user, screen.getByRole("button", { name: "Move to group" }), COLLECTOR_LOCKED_WORDS.move);
    await expectLocked(user, screen.getByRole("button", { name: "Delete selected collectors" }), COLLECTOR_LOCKED_WORDS.bulkDelete);
  });

  it("opens the setup guide (a read) and locks its Assign, shown for a Default group with nothing assigned", async () => {
    // Every sample fleet's Default group has a published version (the step done, no Assign): answer one without.
    const { groups } = await SAMPLE_READS.getCollectorGroups(SAMPLE_ORGANIZATION_ID, SAMPLE_FLEET_IDS.prod);
    vi.spyOn(SAMPLE_READS, "getCollectorGroups").mockResolvedValue({
      groups: groups.map((group) => (group.isDefault ? { ...group, assignedPublishedVersionId: null, assignedVersion: null } : group)),
    });
    const user = renderPlayground(PROD);
    await user.click(await screen.findByRole("button", { name: "Setup guide" }));
    const guide = await screen.findByRole("region", { name: "Fleet setup" });
    await expectLocked(user, await within(guide).findByRole("button", { name: "Assign" }), ASSIGN_LOCKED_WORDS);
  });

  it("Groups: a group's details open; New group, Edit, Delete, a row's Install and the variable values are locked", async () => {
    const user = renderPlayground(`${PROD}?tab=groups`);
    await user.click(await screen.findByRole("button", { name: "More about canary" }));
    const details = await screen.findByRole("dialog", { name: "canary" });
    await expectLocked(user, within(details).getByRole("button", { name: ORGANIZATION_VALUES }), VARIABLE_VALUES_LOCKED_WORDS);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectLocked(user, screen.getByRole("button", { name: "New group" }), GROUP_LOCKED_WORDS.create);
    await expectLocked(user, screen.getByRole("button", { name: "Edit canary" }), GROUP_LOCKED_WORDS.edit);
    await expectLocked(user, screen.getByRole("button", { name: "Delete canary" }), GROUP_LOCKED_WORDS.delete);
    await expectLocked(user, screen.getByRole("button", { name: "Install into canary" }), INSTALL_LOCKED_WORDS.server);
  });

  it("Tokens: Rotate (the banner's too), Reveal and Revoke are locked", async () => {
    const user = renderPlayground(`/playground/fleet-management/${SAMPLE_FLEET_IDS.staging}?tab=tokens`);
    const rotates = await screen.findAllByRole("button", { name: "Rotate token" });
    // The header's and the banner's: the rotate token expires within 30 days.
    expect(rotates).toHaveLength(2);
    for (const rotate of rotates) await expectLocked(user, rotate, TOKEN_LOCKED_WORDS.rotate);
    await expectLocked(user, screen.getByRole("button", { name: "Reveal the default token" }), TOKEN_LOCKED_WORDS.reveal);
    await expectLocked(user, screen.getAllByRole("button", { name: /^Revoke the rotate token/ })[0]!, TOKEN_LOCKED_WORDS.revoke);
  });

  it("Tokens: an install link's View opens (a read); Extend and Revoke are locked", async () => {
    const user = renderPlayground(`${PROD}?tab=tokens`);
    const view = (await screen.findAllByRole("button", { name: /^View / }))[0]!;
    await user.click(view);
    expect(await screen.findByRole("dialog", { name: "Install link" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectLocked(user, screen.getAllByRole("button", { name: /^Extend / })[0]!, TOKEN_LOCKED_WORDS.extendLink);
    await expectLocked(user, screen.getAllByRole("button", { name: /^Revoke the install link|^Revoke .*link/ })[0]!, TOKEN_LOCKED_WORDS.revokeLink);
  });
});

describe("the Kubernetes fleet's page", () => {
  const K8S = `/playground/fleet-management/${SAMPLE_FLEET_IDS.kubernetes}`;

  it("shows its collectors, and locks Install with Helm", async () => {
    const user = renderPlayground(K8S);
    expect(await screen.findByRole("heading", { level: 1, name: "k8s-prod-us-west" })).toBeInTheDocument();
    for (const name of ["node-agent", "otel-gateway", "payments-agent", "checkout-sidecar", "staging-agent", "logging-agent"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }
    await expectLocked(user, screen.getByRole("button", { name: "Install with Helm" }), INSTALL_LOCKED_WORDS["kubernetes-supervisor"]);
  });

  it("Kubernetes groups: the Agent, the Cluster and the gateways; details open; Add gateway, Edit and Delete are locked", async () => {
    const user = renderPlayground(`${K8S}?tab=groups`);
    await user.click(await screen.findByRole("button", { name: "More about payments" }));
    expect(await screen.findByRole("dialog", { name: /payments/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectLocked(user, screen.getByRole("button", { name: "Add gateway" }), KUBERNETES_GROUP_LOCKED_WORDS.add);
    await expectLocked(user, screen.getByRole("button", { name: "Edit payments" }), KUBERNETES_GROUP_LOCKED_WORDS.edit);
    await expectLocked(user, screen.getByRole("button", { name: "Delete payments" }), KUBERNETES_GROUP_LOCKED_WORDS.delete);
  });

  it("Tokens: its Helm values links, View opening; Revoke locked", async () => {
    const user = renderPlayground(`${K8S}?tab=tokens`);
    const views = await screen.findAllByRole("button", { name: /^View / });
    expect(views.length).toBeGreaterThan(0);
    await user.click(views[0]!);
    expect(await screen.findByRole("dialog", { name: "Install link" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectLocked(user, screen.getAllByRole("button", { name: /^Revoke .*link/ })[0]!, TOKEN_LOCKED_WORDS.revokeLink);
  });
});

describe("an id the sample doesn't hold", () => {
  it.each([["0199a000-0000-7000-8000-0000000000ff"], ["abc"]])("%s is the page's own Fleet not found, its back link to the playground's list", async (id) => {
    const user = renderPlayground(`/playground/fleet-management/${id}`);
    expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Fleets" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/playground\/fleet-management$/));
  });
});

describe("a signed-in visitor", () => {
  // Signed in to a real organization: the user store holds it, and the playground's pages still read the sample
  // only. Every tab, a collector's details and the install links, and the afterEach's spies see no API client call.
  beforeEach(() => {
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
  });

  it.each([
    ["the server fleet", SAMPLE_FLEET_IDS.prod, "brave-falcon", "More about canary"],
    ["the Kubernetes fleet", SAMPLE_FLEET_IDS.kubernetes, "node-agent", "More about payments"],
  ])("%s: each tab and a collector's details read the sample, never the API", async (_fleet, fleetId, collectorName, groupMore) => {
    const user = renderPlayground(`/playground/fleet-management/${fleetId}`);
    await user.click(await screen.findByRole("button", { name: collectorName }));
    const details = await screen.findByRole("dialog", { name: collectorName });
    // The details' reads answered: the collector's token row and its errors, from the sample.
    await waitFor(() => expect(within(details).queryByText(/Loading/)).toBeNull());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("tab", { name: "Groups" }));
    await user.click(await screen.findByRole("button", { name: groupMore }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("tab", { name: "Tokens" }));
    expect((await screen.findAllByRole("button", { name: /^View / })).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: "Reveal the default token" })).toBeInTheDocument();
  });
});
