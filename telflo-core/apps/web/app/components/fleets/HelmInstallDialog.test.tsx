import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  DEFAULT_HELM_CHART_REFERENCE,
  DEFAULT_HELM_CHART_VERSION,
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  helmInstallCommand,
  helmQuickDeployCommand,
  helmValuesInputOf,
  helmValuesYaml,
  INSTALL_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  type CollectorGroup,
  type CreateQuickDeployLinkResponse,
  type EnrollmentTokenListed,
  type HelmInstallFacts,
  type OrganizationSettings,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import * as download from "~/lib/download.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  agentHelmFacts,
  anyStateHolds,
  attributesHolding,
  clusterGroup,
  CLUSTER_GROUP_ID,
  collectorGroup,
  DEFAULT_GROUP_ID,
  DEFAULT_TOKEN_ID,
  expectNoAttributeHolds,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  helmInstallFacts,
  helmQuickDeployLink,
  kubernetesAnnotations,
  listedToken,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  quickDeployLinkCreated,
  QUICK_DEPLOY_SECRET,
  QUICK_DEPLOY_URL,
  SECOND_GATEWAY_GROUP_ID,
} from "~/test/fleets.js";
import { INSTALL_NEEDS_LIVE_VERSION, INSTALL_NEEDS_VERSION } from "./GroupsTable.js";
import {
  HELM_BUILD_FAILED_MESSAGE,
  HELM_DOWNLOAD_STARTED_MESSAGE,
  HELM_INSTALL_DESCRIPTION,
  HELM_INSTALL_DESCRIPTION_LINKS_OFF,
  HELM_INSTALL_TITLE,
  HELM_NO_GROUP_WORDS,
  HELM_QUICK_DEPLOY_WARNING,
  HELM_QUICK_DEPLOY_WORDS,
  HELM_RENAMED_FILE_WORDS,
  helmCommandIntro,
  HelmInstallDialog,
  helmValuesWarning,
  PUBLIC_INSTALL_LINKS_OFF_WORDS,
} from "./HelmInstallDialog.js";
import { QUICK_DEPLOY_TITLE } from "./QuickDeployScreen.js";

/*
 * The Helm install dialog (D17d-2 decisions 9, 12, 19 and 21; Preflight
 * rulings 23 to 27 and 33): the Agent, the Cluster and the gateways
 * offered in one Group select (an unassigned gateway listed disabled), the
 * release named by role and the install command for it; no link at the
 * opening (only Quick Deploy's click makes one), and Download values.yaml.
 */

// Standard base64, as the opamp-server seals a bearer (the values file's backstop refuses any other).
const BEARER = "helmBearerCanary7f3a9b";
const NAMESPACE = "observability";
const AGENT = collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() });
const GATEWAYS = gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: NAMESPACE, replicas: 3 }) });

const defaultToken = (overrides: Partial<EnrollmentTokenListed> = {}) => listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", ...overrides });
const revealed = { token: { id: DEFAULT_TOKEN_ID, kind: "default" as const, bearer: BEARER, expiresAt: null } };

/** The gateways group's Helm facts: its release its name, three replicas, one variable. */
const gatewayFacts = (helm: Partial<HelmInstallFacts["helm"]> = {}) => helmInstallFacts({}, { namespace: NAMESPACE, replicas: 3, ...helm });

interface Api {
  groups: CollectorGroup[];
  settings: () => OrganizationSettings | Promise<OrganizationSettings>;
  facts: (groupId: string) => HelmInstallFacts | Promise<HelmInstallFacts>;
  tokens: EnrollmentTokenListed[];
  reveal: () => Promise<typeof revealed>;
  create: () => Promise<CreateQuickDeployLinkResponse>;
}
let api: Api;

function serve() {
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => ({ groups: api.groups }));
  const getOrganizationSettings = vi.spyOn(apiClient, "getOrganizationSettings").mockImplementation(async () => api.settings());
  const getHelmInstallFacts = vi.spyOn(apiClient, "getHelmInstallFacts").mockImplementation(async (_o, _f, groupId) => api.facts(groupId));
  const getInstallFacts = vi.spyOn(apiClient, "getInstallFacts");
  const getEnrollmentTokens = vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation(async () => ({ tokens: api.tokens }));
  const revealEnrollmentToken = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(() => api.reveal());
  const createQuickDeployLink = vi.spyOn(apiClient, "createQuickDeployLink").mockImplementation(() => api.create());
  const downloadBlob = vi.spyOn(download, "downloadBlob").mockImplementation(() => undefined);
  const downloadTextFile = vi.spyOn(download, "downloadTextFile");
  return {
    getCollectorGroups,
    getOrganizationSettings,
    getHelmInstallFacts,
    getInstallFacts,
    getEnrollmentTokens,
    revealEnrollmentToken,
    createQuickDeployLink,
    downloadBlob,
    downloadTextFile,
  };
}

/** A promise answered by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A blob's text, as a browser saves it. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const onInstallStarted = vi.fn();
const onFleetChanged = vi.fn();
const onGroupsChanged = vi.fn();

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** The dialog behind an opener, in the current organization (as the route gives it); opened. */
async function renderDialog({ groupId = null as string | null, open = true } = {}) {
  function Harness() {
    const [isOpen, setOpen] = useState(false);
    const organizationId = useCurrentUser()?.organization.id ?? "";
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open install
        </button>
        <HelmInstallDialog
          open={isOpen}
          onOpenChange={setOpen}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          groupId={groupId}
          onInstallStarted={onInstallStarted}
          onFleetChanged={onFleetChanged}
          onGroupsChanged={onGroupsChanged}
        />
        <Where />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Harness }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  if (open) await user.click(screen.getByRole("button", { name: "open install" }));
  return user;
}

const dialog = () => screen.getByRole("dialog");
const groupSelect = () => screen.getByRole("combobox", { name: "Group" });
const downloadButton = () => within(dialog()).getByRole("button", { name: "Download values.yaml" });
const quickDeployButton = () => within(dialog()).queryByRole("button", { name: "Quick Deploy" });

/** The chosen group's facts shown (its release in the list). */
async function loaded(release = "telflo-node") {
  await within(dialog()).findByText(release, { selector: "dd" });
}

async function chooseGroup(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(groupSelect());
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${name}`) }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  for (const each of [onInstallStarted, onFleetChanged, onGroupsChanged]) each.mockClear();
  api = {
    groups: [AGENT, clusterGroup(), GATEWAYS],
    settings: () => ({ publicInstallLinks: true }),
    facts: (groupId) => (groupId === GATEWAYS_GROUP_ID ? gatewayFacts() : agentHelmFacts()),
    tokens: [defaultToken(), listedToken()],
    reveal: async () => revealed,
    create: async () =>
      quickDeployLinkCreated(helmQuickDeployLink({ choices: { kind: "helm", role: "gateway", release: "gateways", namespace: NAMESPACE, envNames: ["NGINX_ENV"] } })),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HelmInstallDialog's reads and Group select (Preflight rulings 25 and 26)", () => {
  it("reads the groups, the settings and the tokens together, then the first installable group's Helm facts; its title fixed, the release and namespace shown", async () => {
    const groups = held<{ groups: CollectorGroup[] }>();
    const calls = serve();
    calls.getCollectorGroups.mockImplementation(() => groups.promise);
    await renderDialog();
    expect(screen.getByRole("dialog", { name: HELM_INSTALL_TITLE })).toBeInTheDocument();
    expect(dialog()).toHaveAccessibleDescription(HELM_INSTALL_DESCRIPTION);
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading…");
    expect(calls.getOrganizationSettings).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(calls.getHelmInstallFacts).not.toHaveBeenCalled();

    await act(async () => groups.resolve({ groups: api.groups }));
    await loaded();
    // From the header: the first group with a Helm install, the Agent.
    expect(groupSelect()).toHaveTextContent(/^Agent$/);
    expect(calls.getHelmInstallFacts).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls.getInstallFacts).not.toHaveBeenCalled();
    const list = within(dialog()).getByText("telflo-node").closest("dl")!;
    expect(list).toHaveClass("ph-no-capture");
    expect(list).toHaveTextContent("Releasetelflo-nodeNamespacetelflo-collectors");
    expect(list).not.toHaveTextContent("Address");
    // No reveal and no link at the opening.
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.createQuickDeployLink).not.toHaveBeenCalled();
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Cancel", "Download values.yaml", "Quick Deploy", "Close"]);
  });

  it("lists the Agent, the Cluster, then the gateways, each without a Helm install disabled with its reason", async () => {
    api.groups = [
      collectorGroup(),
      gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha", assignedVersion: null, annotations: kubernetesAnnotations() }),
      gatewaysGroup({ id: "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", name: "broken", annotations: { telflo: { kubernetes: "not settings" } } }),
      GATEWAYS,
    ];
    serve();
    const user = await renderDialog();
    await loaded("gateways");
    // From the header, the first installable row: the gateways (the Agent unassigned, the Cluster not created yet).
    expect(groupSelect()).toHaveTextContent(/^gateways$/);
    await user.click(groupSelect());
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      `Agent${INSTALL_NEEDS_VERSION}`,
      `Cluster${INSTALL_NEEDS_VERSION}`,
      `alpha${INSTALL_NEEDS_LIVE_VERSION}`,
      `broken${COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE}`,
      "gateways",
    ]);
    expect(options.map((option) => option.getAttribute("aria-disabled"))).toEqual(["true", "true", "true", "true", null]);
  });

  it("opens on the row's group; a group change reads that group's facts afresh, the variables typed and the earlier answer dropped", async () => {
    const late = held<HelmInstallFacts>();
    const calls = serve();
    api.facts = (groupId) => (groupId === GATEWAYS_GROUP_ID ? gatewayFacts() : late.promise);
    const user = await renderDialog({ groupId: DEFAULT_GROUP_ID });
    expect(groupSelect()).toHaveTextContent(/^Agent$/);
    // The Agent's facts still under way: the gateways chosen.
    await chooseGroup(user, "gateways");
    await loaded("gateways");
    const list = within(dialog()).getByText("gateways", { selector: "dd" }).closest("dl")!;
    expect(list).toHaveTextContent(`Namespace${NAMESPACE}`);
    expect(list).toHaveTextContent(`Addresshttp://gateways.${NAMESPACE}.svc.cluster.local:4318gateways.${NAMESPACE}.svc.cluster.local:4317`);
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "NGINX_ENV" }), "typed");
    // The Agent's late answer is dropped.
    await act(async () => late.resolve(agentHelmFacts()));
    expect(within(dialog()).queryByText("telflo-node")).toBeNull();

    api.facts = () => agentHelmFacts();
    await chooseGroup(user, "Agent");
    await loaded();
    expect(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" })).not.toBeChecked();
    expect(calls.getHelmInstallFacts.mock.calls.map((call) => call[2])).toEqual([DEFAULT_GROUP_ID, GATEWAYS_GROUP_ID, DEFAULT_GROUP_ID]);
  });

  it("with no group to install: Pick a group, the footer disabled, and the Groups tab link, which closes", async () => {
    api.groups = [collectorGroup()];
    const calls = serve();
    const user = await renderDialog();
    expect(await within(dialog()).findByText(/^Assign a published version to a group first/)).toHaveTextContent(`${HELM_NO_GROUP_WORDS} on the Groups tab.`);
    expect(groupSelect()).toHaveTextContent("Pick a group");
    expect(downloadButton()).toBeDisabled();
    expect(quickDeployButton()).toBeDisabled();
    expect(calls.getHelmInstallFacts).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("link", { name: "Groups tab" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("/?tab=groups");
  });

  it("opened on a row whose group has no Helm install (since the row was drawn): its reason and the Groups tab link, nothing read for it", async () => {
    api.groups = [AGENT, clusterGroup(), gatewaysGroup({ assignedPublishedVersionId: null, assignedVersion: null, annotations: kubernetesAnnotations() })];
    const calls = serve();
    const user = await renderDialog({ groupId: GATEWAYS_GROUP_ID });
    expect(await within(dialog()).findByText(INSTALL_NEEDS_VERSION)).toBeInTheDocument();
    expect(groupSelect()).toHaveTextContent(/^gateways$/);
    expect(dialog()).toHaveTextContent(`${INSTALL_NEEDS_VERSION}Fix it on the Groups tab, then install.`);
    expect(calls.getHelmInstallFacts).not.toHaveBeenCalled();
    expect(downloadButton()).toBeDisabled();
    await user.click(within(dialog()).getByRole("link", { name: "Groups tab" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("/?tab=groups");
  });

  it("toasts Group not found and closes when the row's group is gone at the opening; the groups read again", async () => {
    const error = vi.spyOn(toast, "error");
    serve();
    await renderDialog({ groupId: CLUSTER_GROUP_ID.replace("7182", "0000") });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith("Group not found");
    expect(onGroupsChanged).toHaveBeenCalledTimes(1);
  });

  it("drops the opening's answers once the organization changes", async () => {
    const groups = held<{ groups: CollectorGroup[] }>();
    const calls = serve();
    calls.getCollectorGroups.mockImplementation(() => groups.promise);
    await renderDialog();
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () => groups.resolve({ groups: api.groups }));
    expect(calls.getHelmInstallFacts).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading…");
  });

  it("closes, and the route reads the fleet again, on a facts read finding the fleet gone", async () => {
    const calls = serve();
    calls.getHelmInstallFacts.mockRejectedValue(new ApiError("fleet_not_found", "Fleet not found.", { status: 404 }));
    await renderDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });
});

describe("HelmInstallDialog's refusals (decision 19; Preflight ruling 25)", () => {
  it.each([
    ["collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE],
    ["collector_group_assignment_deleted", COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE],
    ["collector_group_settings_unreadable", COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE],
  ])("%s: its words and a Groups tab link (no inner Assign), Download and Quick Deploy disabled", async (code, message) => {
    serve();
    api.facts = () => {
      throw new ApiError(code, message, { status: 409 });
    };
    await renderDialog();
    expect(await within(dialog()).findByText(message)).toBeInTheDocument();
    expect(within(dialog()).getByRole("link", { name: "Groups tab" })).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "Assign" })).toBeNull();
    expect(downloadButton()).toBeDisabled();
    expect(quickDeployButton()).toBeDisabled();
  });

  it.each([
    ["fleet_archived", "This fleet is archived.", true],
    ["fleet_type_not_installable", FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE, false],
  ])("%s: its words alone, the fleet read again when archived", async (code, message, archived) => {
    serve();
    api.facts = () => {
      throw new ApiError(code, message, { status: 409 });
    };
    await renderDialog();
    expect(await within(dialog()).findByText(message)).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(onFleetChanged).toHaveBeenCalledTimes(archived ? 1 : 0);
  });

  it("install_unavailable: its words with Try again, which reads the facts again", async () => {
    const calls = serve();
    calls.getHelmInstallFacts.mockRejectedValueOnce(new ApiError("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 }));
    const user = await renderDialog();
    expect(await within(dialog()).findByText(INSTALL_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    await loaded();
    expect(calls.getHelmInstallFacts).toHaveBeenCalledTimes(2);
  });

  it("no valid default token at the opening: Download and Quick Deploy disabled, the words under the footer naming them", async () => {
    api.tokens = [defaultToken({ revokedAt: "2026-10-13T09:00:00.000Z" }), listedToken()];
    serve();
    await renderDialog();
    await loaded();
    expect(downloadButton()).toBeDisabled();
    expect(quickDeployButton()).toBeDisabled();
    const words = within(dialog()).getByRole("alert");
    expect(words).toHaveTextContent("The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.");
    expect(downloadButton().getAttribute("aria-describedby")).toBe(words.parentElement!.id);
  });
});

describe("HelmInstallDialog's Download values.yaml (decision 19; Preflight rulings 24 and 25)", () => {
  it("reveals the default token with the facts read again, saves values.yaml as the contracts render it from those fresh facts, then the quoted install command; the bearer nowhere in the document", async () => {
    const calls = serve();
    const user = await renderDialog({ groupId: GATEWAYS_GROUP_ID });
    await loaded("gateways");
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "NGINX_ENV" }), "  it's $(echo EXPANDED) \"q\"  ");
    // A namespace saved meanwhile: the fresh facts are the file's and the command's.
    const fresh = gatewayFacts({ namespace: "observability-2" });
    api.facts = () => fresh;
    const success = vi.spyOn(toast, "success");
    await user.click(downloadButton());

    const box = await within(dialog()).findByRole("button", { name: "Copy install command" });
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(2);
    expect(calls.getHelmInstallFacts).toHaveBeenCalledTimes(2);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_TOKEN_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls.downloadBlob).toHaveBeenCalledTimes(1);
    expect(calls.downloadTextFile).not.toHaveBeenCalled();
    const [blob, fileName] = calls.downloadBlob.mock.calls[0]!;
    // Named per release and per download (Rulings 36 and 37): another group's file, or an older one, is never read for this one.
    expect(fileName).toMatch(/^gateways-values-[0-9a-f]{8}\.yaml$/);
    expect(blob.type).toBe("text/yaml");
    expect(await blobText(blob)).toBe(helmValuesYaml(helmValuesInputOf(fresh, BEARER, [{ name: "NGINX_ENV", value: "it's $(echo EXPANDED) \"q\"" }])));
    expect(success).toHaveBeenCalledWith(HELM_DOWNLOAD_STARTED_MESSAGE);
    expect(onInstallStarted).toHaveBeenCalledTimes(1);

    // The command screen: no secret in the command, the file's warning, the focus on its copy button.
    expect(screen.getByRole("dialog", { name: HELM_INSTALL_TITLE })).toHaveTextContent(
      `${fileName} is saved. Run this in a shell with access to your cluster:`,
    );
    expect(helmCommandIntro(fileName)).toBe(`${fileName} is saved. Run this in a shell with access to your cluster:`);
    expect(dialog()).toHaveTextContent(HELM_RENAMED_FILE_WORDS);
    expect(HELM_RENAMED_FILE_WORDS).toBe("If your browser saved it under another name (for example with a number added), use that name after -f.");
    const command = helmInstallCommand({
      release: "gateways",
      namespace: "observability-2",
      chartReference: DEFAULT_HELM_CHART_REFERENCE,
      chartVersion: DEFAULT_HELM_CHART_VERSION,
      valuesFile: fileName,
    });
    expect(box.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe(command);
    expect(command).toContain("-n 'observability-2' --create-namespace");
    expect(command).toContain(`-f '${fileName}'`);
    expect(dialog()).toHaveTextContent(helmValuesWarning(fileName));
    await waitFor(() => expect(document.activeElement).toBe(box));
    // The bearer and the file are the chain's locals: never in the document, in text or an attribute.
    expect(document.body.innerHTML).not.toContain(BEARER);

    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(BEARER);
  });

  it("names each download's file its own (Ruling 37), each command naming its own file: two downloads of one group never share one", async () => {
    const random = vi.spyOn(crypto, "getRandomValues");
    for (const bytes of [
      [0x0a, 0x1b, 0x2c, 0x3d],
      [0xf0, 0xe1, 0xd2, 0xc3],
    ]) {
      random.mockImplementationOnce(<T extends ArrayBufferView>(array: T): T => {
        (array as unknown as Uint8Array).set(bytes);
        return array;
      });
    }
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(downloadButton());
    const firstCopy = await within(dialog()).findByRole("button", { name: "Copy install command" });
    const first = firstCopy.closest(".ph-no-capture")!.querySelector("code")!.textContent;
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    await user.click(downloadButton());
    const secondCopy = await within(dialog()).findByRole("button", { name: "Copy install command" });
    const second = secondCopy.closest(".ph-no-capture")!.querySelector("code")!.textContent;
    expect(calls.downloadBlob.mock.calls.map((call) => call[1])).toEqual(["telflo-node-values-0a1b2c3d.yaml", "telflo-node-values-f0e1d2c3.yaml"]);
    expect(first).toContain("-f 'telflo-node-values-0a1b2c3d.yaml'");
    expect(second).toContain("-f 'telflo-node-values-f0e1d2c3.yaml'");
    expect(dialog()).toHaveTextContent("telflo-node-values-f0e1d2c3.yaml is saved.");
  });

  it("checks a ticked variable first: with no value, its problem shows and nothing is read again, revealed or saved", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "NGINX_ENV" }), "   ");
    await user.click(downloadButton());
    expect(await within(dialog()).findByText("Type a value or untick it.")).toBeInTheDocument();
    await user.click(quickDeployButton()!);
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(calls.getHelmInstallFacts).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.createQuickDeployLink).not.toHaveBeenCalled();
    expect(calls.downloadBlob).not.toHaveBeenCalled();
  });

  // D18 decision 23: the platform's chart quotes collectorEnv's keys, so a YAML 1.1 word is a variable like any other.
  it("offers a YAML word's variable like any other: ticked and typed, its value in the file under its quoted name", async () => {
    const facts = { ...agentHelmFacts(), envVarNames: ["NGINX_ENV", "on"] };
    api.facts = () => facts;
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    const box = within(dialog()).getByRole("checkbox", { name: "Include on" });
    expect(box).toBeEnabled();
    expect(box.getAttribute("aria-describedby")).toBeNull();
    await user.click(box);
    await user.type(within(dialog()).getByRole("textbox", { name: "on" }), "typed-word-value");
    await user.click(downloadButton());
    await within(dialog()).findByRole("button", { name: "Copy install command" });
    const text = await blobText(calls.downloadBlob.mock.calls[0]![0]);
    expect(text).toBe(helmValuesYaml(helmValuesInputOf(facts, BEARER, [{ name: "on", value: "typed-word-value" }])));
    expect(text.split("\n")).toContain('  "on": "typed-word-value"');
  });

  it('shows "Failed to build values.yaml" when the builder refuses (never its message), and saves nothing', async () => {
    api.reveal = async () => ({ token: { ...revealed.token, bearer: "not base64!" } });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(downloadButton());
    expect(await within(dialog()).findByText(HELM_BUILD_FAILED_MESSAGE)).toBeInTheDocument();
    expect(dialog()).not.toHaveTextContent("fails its rule");
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("not base64!");
  });

  it("finds the default token revoked at the download: the no-default-token words, nothing saved", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.tokens = [defaultToken({ revokedAt: "2026-10-13T09:00:00.000Z" })];
    await user.click(downloadButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The fleet's default token is revoked.");
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(downloadButton()).toBeDisabled();
  });

  it("tells a group unassigned since the opening by the facts read again: its words and the Groups tab link, nothing revealed", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.facts = () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    await user.click(downloadButton());
    expect(await within(dialog()).findByText(COLLECTOR_GROUP_UNASSIGNED_MESSAGE)).toBeInTheDocument();
    expect(within(dialog()).getByRole("link", { name: "Groups tab" })).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.downloadBlob).not.toHaveBeenCalled();
  });

  it("drops a download answered after the close: nothing saved, no install started", async () => {
    const reveal = held<typeof revealed>();
    api.reveal = () => reveal.promise;
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(downloadButton());
    expect(within(dialog()).getByRole("button", { name: "Preparing…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => reveal.resolve(revealed));
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
  });
});

describe("HelmInstallDialog's Quick Deploy (decision 21; Preflight rulings 27 and 33)", () => {
  it("makes a Helm values link in one click: the create's body, then the curl line and the install in one box, shown once, no reveal; the command leaves on close", async () => {
    const calls = serve();
    const user = await renderDialog({ groupId: GATEWAYS_GROUP_ID });
    await loaded("gateways");
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "NGINX_ENV" }), " value ");
    await user.click(quickDeployButton()!);

    const copy = await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(calls.createQuickDeployLink).toHaveBeenCalledWith(
      GROUP_ID,
      FLEET_ID,
      GATEWAYS_GROUP_ID,
      { kind: "helm", env: [{ name: "NGINX_ENV", value: "value" }] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: QUICK_DEPLOY_TITLE })).toHaveTextContent(HELM_QUICK_DEPLOY_WORDS);
    const command = helmQuickDeployCommand(QUICK_DEPLOY_URL, {
      release: "gateways",
      namespace: NAMESPACE,
      chartReference: DEFAULT_HELM_CHART_REFERENCE,
      chartVersion: DEFAULT_HELM_CHART_VERSION,
    });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe(command);
    expect(command).toContain("-K - -o 'gateways-values.yaml' )");
    expect(dialog()).toHaveTextContent(HELM_QUICK_DEPLOY_WARNING);
    expect(within(dialog()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    expect(expectTextOnlyInsideNoCapture(QUICK_DEPLOY_SECRET)).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(copy));
    expect(onInstallStarted).toHaveBeenCalledTimes(1);
    expect(anyStateHolds(QUICK_DEPLOY_SECRET)).toBe(true);

    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    // The closed session (still mounted, its dialog rendering nothing) holds the command no more (Ruling 40).
    expect(anyStateHolds(QUICK_DEPLOY_SECRET)).toBe(false);
    // Opened again: the form, no link made.
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded("gateways");
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expect(calls.createQuickDeployLink).toHaveBeenCalledTimes(1);
  });

  it("names the release and namespace the link stored (its reply's choices), never the opening's facts, in the command", async () => {
    // The group's namespace saved meanwhile: the link's download installs what the link stored.
    api.create = async () =>
      quickDeployLinkCreated(helmQuickDeployLink({ choices: { kind: "helm", role: "gateway", release: "gateways", namespace: "stored-namespace", envNames: [] } }));
    serve();
    const user = await renderDialog({ groupId: GATEWAYS_GROUP_ID });
    await loaded("gateways");
    await user.click(quickDeployButton()!);
    const copy = await within(dialog()).findByRole("button", { name: "Copy command" });
    const command = copy.closest(".ph-no-capture")!.querySelector("code")!.textContent;
    expect(command).toBe(
      helmQuickDeployCommand(QUICK_DEPLOY_URL, {
        release: "gateways",
        namespace: "stored-namespace",
        chartReference: DEFAULT_HELM_CHART_REFERENCE,
        chartVersion: DEFAULT_HELM_CHART_VERSION,
      }),
    );
    expect(command).not.toContain(NAMESPACE);
  });

  it("with public install links off: no Quick Deploy, the words; Download values.yaml still works", async () => {
    api.settings = () => ({ publicInstallLinks: false });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    expect(quickDeployButton()).toBeNull();
    expect(dialog()).toHaveTextContent(PUBLIC_INSTALL_LINKS_OFF_WORDS);
    // Its description offers no Quick Deploy either (Ruling 40).
    expect(dialog()).toHaveAccessibleDescription(HELM_INSTALL_DESCRIPTION_LINKS_OFF);
    expect(HELM_INSTALL_DESCRIPTION_LINKS_OFF).toBe("Choose a group, then download its values.yaml and run helm upgrade --install against your cluster.");
    await user.click(downloadButton());
    await within(dialog()).findByRole("button", { name: "Copy install command" });
    expect(calls.downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("counts a failed settings read as on", async () => {
    api.settings = () => {
      throw new ApiError("fleets_unavailable", "unavailable", { status: 503 });
    };
    serve();
    await renderDialog();
    await loaded();
    expect(quickDeployButton()).toBeEnabled();
    expect(dialog()).not.toHaveTextContent(PUBLIC_INSTALL_LINKS_OFF_WORDS);
  });

  it("hides Quick Deploy at once, with the words, on a create answered public_install_links_disabled", async () => {
    api.create = async () => {
      throw new ApiError("public_install_links_disabled", QUICK_DEPLOY_LINK_ERROR_MESSAGES.public_install_links_disabled, { status: 409 });
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(quickDeployButton()!);
    await waitFor(() => expect(quickDeployButton()).toBeNull());
    expect(dialog()).toHaveTextContent(PUBLIC_INSTALL_LINKS_OFF_WORDS);
    expect(downloadButton()).toBeEnabled();
  });

  it("shows the no-default-token words on a create answered enrollment_token_default_missing, a 400's detail under its variable, the cap's words inline", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "NGINX_ENV" }), "v");

    calls.createQuickDeployLink.mockRejectedValueOnce(
      new ApiError("invalid_request", "Invalid request", { status: 400, details: [{ path: ["env", 0, "name"], message: "Not a variable of this group." }] }),
    );
    await user.click(quickDeployButton()!);
    expect(await within(dialog()).findByText("Not a variable of this group.")).toBeInTheDocument();

    calls.createQuickDeployLink.mockRejectedValueOnce(
      new ApiError("quick_deploy_link_limit_reached", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached, { status: 409 }),
    );
    await user.click(quickDeployButton()!);
    expect(await within(dialog()).findByText(QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached)).toBeInTheDocument();

    calls.createQuickDeployLink.mockRejectedValueOnce(
      new ApiError("enrollment_token_default_missing", QUICK_DEPLOY_LINK_ERROR_MESSAGES.enrollment_token_default_missing, { status: 409 }),
    );
    await user.click(quickDeployButton()!);
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The fleet's default token is revoked.");
    expect(quickDeployButton()).toBeDisabled();
    expect(onInstallStarted).not.toHaveBeenCalled();
  });
});

describe("HelmInstallDialog's privacy (decisions 9 and 29; Preflight ruling 19)", () => {
  it("holds no gateway name, namespace, variable name or value, bearer or link secret in an attribute, through the select, the download and Quick Deploy; each shown inside ph-no-capture", async () => {
    const gateway = "canary-gateway-5e1f";
    const namespace = "canary-namespace-7a2b";
    const variable = "CANARY_VARIABLE_9C3D";
    const value = "canary-value-1d4e";
    api.groups = [AGENT, clusterGroup(), gatewaysGroup({ name: gateway, annotations: kubernetesAnnotations({ namespace }) })];
    api.facts = (groupId) =>
      groupId === GATEWAYS_GROUP_ID ? helmInstallFacts({ envVarNames: [variable] }, { release: gateway, namespace }) : agentHelmFacts();
    api.create = async () => quickDeployLinkCreated(helmQuickDeployLink({ choices: { kind: "helm", role: "gateway", release: gateway, namespace, envNames: [variable] } }));
    const calls = serve();
    const user = await renderDialog({ groupId: GATEWAYS_GROUP_ID });
    await loaded(gateway);
    await user.click(within(dialog()).getByRole("checkbox", { name: `Include ${variable}` }));
    await user.type(within(dialog()).getByRole("textbox", { name: variable }), value);
    for (const text of [gateway, namespace, variable]) expectNoAttributeHolds(text);
    expect(expectTextOnlyInsideNoCapture(namespace)).toBeGreaterThan(0);
    expect(expectTextOnlyInsideNoCapture(variable)).toBeGreaterThan(0);
    // The typed value: only the input's own value holds it.
    expect([...document.querySelectorAll("*")].flatMap((element) => [...element.attributes].filter((each) => each.value.includes(value)).map((each) => `${element.tagName} ${each.name}`))).toEqual(["INPUT value"]);

    await user.click(groupSelect());
    await screen.findAllByRole("option");
    for (const text of [gateway, namespace, variable]) expectNoAttributeHolds(text);
    await user.keyboard("{Escape}");

    await user.click(downloadButton());
    await within(dialog()).findByRole("button", { name: "Copy install command" });
    for (const text of [gateway, namespace, variable, value, BEARER]) expectNoAttributeHolds(text);
    expect(expectTextOnlyInsideNoCapture(namespace)).toBe(1);
    // The gateway's name (the release, and the file named after it): the command, and the file's name in the intro and the
    // warning, each inside ph-no-capture (Ruling 40).
    expect(expectTextOnlyInsideNoCapture(gateway)).toBe(3);
    expect(document.body.innerHTML).not.toContain(BEARER);
    expect(document.body.innerHTML).not.toContain(value);
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded(gateway);
    await user.click(quickDeployButton()!);
    await within(dialog()).findByRole("button", { name: "Copy command" });
    for (const text of [gateway, namespace, variable, value, BEARER, QUICK_DEPLOY_SECRET]) expectNoAttributeHolds(text);
    expect(expectTextOnlyInsideNoCapture(QUICK_DEPLOY_SECRET)).toBe(1);
    expect(expectTextOnlyInsideNoCapture(namespace)).toBe(1);
    expect(expectTextOnlyInsideNoCapture(gateway)).toBe(1);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
  });

  // D18 decision 37, Preflight rulings 16 and 23: a YAML-word variable is configuration text like any other. Its name (a
  // short word, "ON", is inside "JSON" and can't be a canary) is shown inside ph-no-capture; the canary is its typed value.
  it("with a YAML-word variable (ON) ticked and a canary value typed: the value only in its input inside ph-no-capture, in no other attribute, through the download and Quick Deploy", async () => {
    const value = "canary-yaml-word-value-6b3e";
    const facts = { ...agentHelmFacts(), envVarNames: ["NGINX_ENV", "ON"] };
    api.facts = () => facts;
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    const box = within(dialog()).getByRole("checkbox", { name: "Include ON" });
    expect(box).toBeEnabled();
    for (const name of within(dialog()).getAllByText("ON", { exact: true })) expect(name.closest(".ph-no-capture")).not.toBeNull();
    await user.click(box);
    const input = within(dialog()).getByRole("textbox", { name: "ON" });
    await user.type(input, value);
    expect(input.closest(".ph-no-capture")).not.toBeNull();
    // Only the input's own value (React writes it for a controlled input) holds it: no title, aria-*, data-* or other.
    expect(attributesHolding(value)).toEqual(["INPUT value"]);
    expect(document.body.textContent).not.toContain(value);

    await user.click(downloadButton());
    await within(dialog()).findByRole("button", { name: "Copy install command" });
    const text = await blobText(calls.downloadBlob.mock.calls[0]![0]);
    expect(text.split("\n")).toContain(`  "ON": "${value}"`);
    expectNoAttributeHolds(value);
    expect(document.body.innerHTML).not.toContain(value);
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    await user.click(within(dialog()).getByRole("checkbox", { name: "Include ON" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "ON" }), value);
    expect(attributesHolding(value)).toEqual(["INPUT value"]);
    await user.click(quickDeployButton()!);
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(calls.createQuickDeployLink).toHaveBeenCalledWith(
      GROUP_ID,
      FLEET_ID,
      DEFAULT_GROUP_ID,
      { kind: "helm", env: [{ name: "ON", value }] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expectNoAttributeHolds(value);
    expect(document.body.innerHTML).not.toContain(value);
  });
});
