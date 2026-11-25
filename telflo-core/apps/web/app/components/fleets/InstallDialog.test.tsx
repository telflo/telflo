import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  collectorVersionNotOfferedMessage,
  FLEETS_UNAVAILABLE_MESSAGE,
  INSTALL_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  QUICK_DEPLOY_MASKED_SECRET,
  type CollectorGroup,
  type Configuration,
  type CreateQuickDeployLinkRequestInput,
  type CreateQuickDeployLinkResponse,
  type EnrollmentTokenListed,
  type InstallBundleRequestInput,
  type InstallFacts,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import * as download from "~/lib/download.js";
import { formatDateTime } from "~/lib/format.js";
import { MASKED_TOKEN, quickDeployCommands, quickDeployPreview } from "~/lib/install.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GROUP_ID, PERSONAL_ID, signedInMember, THEIRS } from "~/test/configurations.js";
import {
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DATA_MOUNT,
  DEFAULT_GROUP_ID,
  DEFAULT_TOKEN_ID,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  installFacts,
  listedToken,
  mountsAnnotations,
  NGINX_MOUNT,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  quickDeployLink,
  quickDeployLinkCreated,
  QUICK_DEPLOY_SECRET,
  QUICK_DEPLOY_URL,
  serveNoVariables,
} from "~/test/fleets.js";
import {
  COPIED_MESSAGE,
  COPY_FAILED_MESSAGE,
  DOWNLOAD_NEEDS_UNTICK_WORDS,
  DOWNLOAD_STARTED_MESSAGE,
  INSTALL_LOAD_FAILED_MESSAGE,
  INSTALL_METHOD_LABELS,
  InstallDialog,
  LINUX_TOKEN_WARNING,
  QUICK_DEPLOY_COPIED_MESSAGE,
  QUICK_DEPLOY_COPY_FAILED_MESSAGE,
  QUICK_DEPLOY_FAILED_MESSAGE,
} from "./InstallDialog.js";
import { MOUNTS_CHANGED_MESSAGE } from "./GroupDialog.js";
import { CONTAINER_WARNING, MOUNTS_UNREADABLE_WORDS } from "./InstallContainerSection.js";
import { LINUX_WARNING, SYSTEMD_HINT, SYSTEMD_LABEL } from "./InstallLinuxSection.js";
import {
  QUICK_DEPLOY_FOREGROUND_WORDS,
  QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS,
  QUICK_DEPLOY_SYSTEMD_WORDS,
  QUICK_DEPLOY_TITLE,
  QUICK_DEPLOY_WARNING,
  quickDeployExpiryWords,
} from "./QuickDeployScreen.js";
import { REVEAL_FAILED_MESSAGE } from "./RevealTokenDialog.js";
import { PUBLIC_INSTALL_LINKS_OFF_WORDS } from "./install-opening.js";

/*
 * The install dialog: the container method by default with a lone Close; the
 * scoped title and description; the env vars opt-in, a typed value
 * quote-escaped into the bundle's request and the command; the masked
 * preview with no reveal on opening; one reveal per click, the command
 * copied with its bearer; the token step after a download, its copy holding
 * the bearer; a failed reveal shown inline; a reveal still shown when the
 * copy fails. The systemd and Quick Deploy cases follow (below: the box
 * ticked on a server method, absent for the container, Download disabled
 * until unticked; the masked command; the unmasked copy; the systemd
 * command; the group's id sent).
 */

// Standard base64, as the opamp-server seals a bearer (the Quick Deploy command refuses any other).
const BEARER = "bearerCanary5d0c1e";
const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };

const defaultToken = (overrides: Partial<EnrollmentTokenListed> = {}) => listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", ...overrides });
const revealed = { token: { id: DEFAULT_TOKEN_ID, kind: "default" as const, bearer: BEARER, expiresAt: null } };

interface Api {
  groups: CollectorGroup[];
  /** The organization's settings: public install links on unless a test turns them off. */
  settings: () => { publicInstallLinks: boolean } | Promise<{ publicInstallLinks: boolean }>;
  facts: () => InstallFacts | Promise<InstallFacts>;
  tokens: EnrollmentTokenListed[];
  reveal: () => Promise<typeof revealed>;
  bundle: () => Promise<{ fileName: string; archive: Uint8Array }>;
  create: () => Promise<CreateQuickDeployLinkResponse>;
}
let api: Api;

function serve() {
  serveNoVariables();
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => ({ groups: api.groups }));
  const getInstallFacts = vi.spyOn(apiClient, "getInstallFacts").mockImplementation(async () => api.facts());
  const getOrganizationSettings = vi.spyOn(apiClient, "getOrganizationSettings").mockImplementation(async () => api.settings());
  const getEnrollmentTokens = vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation(async () => ({ tokens: api.tokens }));
  const revealEnrollmentToken = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(() => api.reveal());
  const downloadInstallBundle = vi.spyOn(apiClient, "downloadInstallBundle").mockImplementation(() => api.bundle());
  const createQuickDeployLink = vi.spyOn(apiClient, "createQuickDeployLink").mockImplementation(() => api.create());
  vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [CHECKOUT], nextCursor: null });
  vi.spyOn(apiClient, "getConfigurationVersions").mockResolvedValue({ versions: [configurationVersionListItem()] });
  const updateCollectorGroup = vi.spyOn(apiClient, "updateCollectorGroup").mockImplementation(async (_o, _f, groupId) => {
    api.groups = api.groups.map((group) =>
      group.id === groupId ? { ...group, assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() } : group,
    );
    return api.groups.find((group) => group.id === groupId)!;
  });
  const downloadBlob = vi.spyOn(download, "downloadBlob").mockImplementation(() => undefined);
  return {
    getCollectorGroups,
    getInstallFacts,
    getOrganizationSettings,
    getEnrollmentTokens,
    revealEnrollmentToken,
    downloadInstallBundle,
    createQuickDeployLink,
    updateCollectorGroup,
    downloadBlob,
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

const onInstallStarted = vi.fn();
const onFleetChanged = vi.fn();
const onGroupsChanged = vi.fn();
let writeText: ReturnType<typeof vi.fn>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** The dialog behind an opener, in the current organization (as the route gives it); opened. */
async function renderDialog({ groupId = GATEWAYS_GROUP_ID as string | null, open = true } = {}) {
  function Harness() {
    const [isOpen, setOpen] = useState(false);
    const organizationId = useCurrentUser()?.organization.id ?? "";
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open install
        </button>
        <InstallDialog
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
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  if (open) await user.click(screen.getByRole("button", { name: "open install" }));
  return user;
}

const dialog = () => screen.getByRole("dialog");
const revealButton = () => screen.getByRole("button", { name: "Reveal & copy command" });

async function loaded() {
  return screen.findByRole("button", { name: "Reveal & copy command" });
}

async function chooseMethod(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "Method" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${label.replace(/[()]/g, "\\$&")}`) }));
}

const systemdBox = () => screen.getByRole("checkbox", { name: SYSTEMD_LABEL });

/** "Install as a systemd service" unticked (it is ticked at each opening, and Download disabled while it is). */
async function untickSystemd(user: ReturnType<typeof userEvent.setup>) {
  expect(systemdBox()).toBeChecked();
  await user.click(systemdBox());
  expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
}

/** A browser's ClipboardItem write (Safari's way): it waits for the text, then refuses (NotAllowedError) or keeps it. */
function clipboardItemBrowser(refuse: boolean) {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
  const kept: string[] = [];
  const write = vi.fn(async (items: FakeClipboardItem[]) => {
    let text: string;
    try {
      const blob = await items[0]!.items["text/plain"]!;
      text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
    } catch {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    }
    if (refuse) throw new DOMException("Document is not focused.", "NotAllowedError");
    kept.push(text);
  });
  Object.defineProperty(navigator, "clipboard", { value: { write, writeText: vi.fn() }, configurable: true });
  return { write, kept };
}

/**
 * Radix's Presence keeps the content while an exit animation runs: one emulated through the computed style, for the
 * dialog's content only (a Select's, kept mounted, would hide the rest of the page from the queries).
 */
function emulateExitAnimation() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = real(element, pseudo);
    if (!element.hasAttribute?.("data-state") || element.getAttribute("role") !== "dialog") return style;
    return new Proxy(style, {
      get: (target, key) =>
        key === "animationName" ? (element.getAttribute("data-state") === "closed" ? "exit" : "enter") : (Reflect.get(target, key) as unknown),
    });
  });
}

const originalClipboard = navigator.clipboard;
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

beforeEach(() => {
  vi.restoreAllMocks();
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  for (const each of [onInstallStarted, onFleetChanged, onGroupsChanged]) each.mockClear();
  api = {
    groups: [collectorGroup(), gatewaysGroup()],
    settings: () => ({ publicInstallLinks: true }),
    facts: () => installFacts(),
    tokens: [defaultToken(), listedToken()],
    reveal: async () => revealed,
    bundle: async () => ({ fileName: "telflo-collector-all-in-one-amd64.tar.gz", archive: new Uint8Array([31, 139, 8]) }),
    create: async () => quickDeployLinkCreated(),
  };
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
});

describe("InstallDialog's reads", () => {
  it('reads the groups first ("Install collectors" until then), then the facts and the tokens; titles and describes it by the group and its version', async () => {
    const groups = held<{ groups: CollectorGroup[] }>();
    const calls = serve();
    calls.getCollectorGroups.mockImplementation(() => groups.promise);
    await renderDialog();
    expect(screen.getByRole("dialog", { name: "Install collectors" })).toBeInTheDocument();
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading…");
    expect(calls.getInstallFacts).not.toHaveBeenCalled();

    await act(async () => groups.resolve({ groups: api.groups }));
    expect(await screen.findByRole("dialog", { name: "Install collectors: gateways" })).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("Collectors installed here join gateways and run its published version, checkout-otel @v4.");
    await loaded();
    expect(calls.getInstallFacts).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    // No reveal at the opening.
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
  });

  it("installs into the Default group when opened with none (the header, the empty tab, the checklist)", async () => {
    api.groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gatewaysGroup()];
    const calls = serve();
    await renderDialog({ groupId: null });
    expect(await screen.findByRole("dialog", { name: "Install collectors: Default" })).toBeInTheDocument();
    await loaded();
    expect(calls.getInstallFacts).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_GROUP_ID, expect.anything());
  });

  it("offers the five methods with their descriptions, the container image first and chosen, with a lone Close", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    const method = screen.getByRole("combobox", { name: "Method" });
    expect(method).toHaveTextContent("Container image — pull and run");
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Reveal & copy command", "Close", "Close"]);
    expect(within(dialog()).queryByRole("button", { name: /download/i })).toBeNull();
    await user.click(method);
    const options = await screen.findAllByRole("option");
    expect(options.map((each) => each.textContent)).toEqual(
      Object.values(INSTALL_METHOD_LABELS).map(({ label, description }) => `${label}${description}`),
    );
    expect(Object.values(INSTALL_METHOD_LABELS).map(({ label }) => label)).toEqual([
      "Container image — pull and run",
      "Linux All In One (amd64)",
      "Linux All In One (arm64)",
      "Linux with your own otelcol-contrib (amd64)",
      "Linux with your own otelcol-contrib (arm64)",
    ]);
    for (const { label, description } of Object.values(INSTALL_METHOD_LABELS)) expect(`${label} ${description}`).not.toMatch(/deploy/i);
  });
});

describe("InstallDialog's refusals", () => {
  it("shows an unassigned group's words with Assign, which opens the group dialog; its save reads everything again and installs", async () => {
    api.groups = [collectorGroup()];
    let assigned = false;
    api.facts = () => {
      if (!assigned) throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
      return installFacts({ groupId: DEFAULT_GROUP_ID });
    };
    const calls = serve();
    calls.updateCollectorGroup.mockImplementation(async (_o, _f, groupId) => {
      assigned = true;
      api.groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() })];
      return api.groups.find((group) => group.id === groupId)!;
    });
    const user = await renderDialog({ groupId: null });
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(COLLECTOR_GROUP_UNASSIGNED_MESSAGE);
    expect(screen.getByRole("dialog", { name: "Install collectors: Default" })).toHaveTextContent("Collectors installed here join Default.");
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).toBeNull();

    await user.click(within(dialog()).getByRole("button", { name: "Assign" }));
    const groupDialog = await screen.findByRole("dialog", { name: "Assign a published version to Default" });
    await user.click(within(groupDialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(groupDialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v4"));
    await user.click(within(groupDialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Assign a published version/ })).toBeNull());
    expect(await screen.findByRole("button", { name: "Reveal & copy command" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Install collectors: Default" })).toHaveTextContent("run its published version, checkout-otel @v4.");
    expect(onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(calls.getInstallFacts).toHaveBeenCalledTimes(2);
    // "Assign" is gone with the refusal: the focus goes to the Method select.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Method" })));
  });

  it("returns the focus to Assign when the group dialog closes with nothing saved", async () => {
    api.groups = [collectorGroup()];
    api.facts = () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    serve();
    const user = await renderDialog({ groupId: null });
    const assign = await within(await screen.findByRole("dialog")).findByRole("button", { name: "Assign" });
    await user.click(assign);
    await screen.findByRole("dialog", { name: "Assign a published version to Default" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Assign a published version/ })).toBeNull());
    // The install dialog stays open, the focus back on its Assign.
    expect(screen.getByRole("dialog", { name: "Install collectors: Default" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(assign));
  });

  it.each([
    ["a deleted configuration's version", "collector_group_assignment_deleted", COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE],
    ["a retired collector version", "collector_version_not_offered", collectorVersionNotOfferedMessage("0.150.0")],
  ])("shows %s's words with Assign", async (_why, code, message) => {
    api.facts = () => {
      throw new ApiError(code, message, { status: 409 });
    };
    serve();
    await renderDialog();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(message);
    expect(within(dialog()).getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });

  it.each([
    ["install_unavailable (the templates)", new ApiError("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 }), INSTALL_UNAVAILABLE_MESSAGE],
    ["fleets_unavailable", new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 }), FLEETS_UNAVAILABLE_MESSAGE],
    ["no connection", new ApiError("network_error", "fetch failed"), INSTALL_LOAD_FAILED_MESSAGE],
  ])("shows %s with Try again, which reads again", async (_why, failure, words) => {
    let failed = false;
    api.facts = () => {
      if (failed) return installFacts();
      failed = true;
      throw failure;
    };
    const calls = serve();
    const user = await renderDialog();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    expect(within(dialog()).queryByRole("button", { name: "Assign" })).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    await loaded();
    expect(calls.getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("shows an archived fleet's words with no retry, and has the route read the fleet again", async () => {
    api.facts = () => {
      throw new ApiError("fleet_archived", "The fleet is archived.", { status: 409 });
    };
    serve();
    await renderDialog();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The fleet is archived.");
    expect(within(dialog()).queryByRole("button", { name: /Try again|Assign/ })).toBeNull();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it('toasts "Group not found" and closes for a group gone, and the groups shown elsewhere read again', async () => {
    api.groups = [collectorGroup()];
    const error = vi.spyOn(toast, "error");
    serve();
    await renderDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith("Group not found");
    expect(onGroupsChanged).toHaveBeenCalledTimes(1);
  });

  it("closes for the fleet gone, and the route reads it again", async () => {
    api.facts = () => {
      throw new ApiError("fleet_not_found", "Fleet not found", { status: 404 });
    };
    serve();
    await renderDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it("drops the reads' answers once closed", async () => {
    const facts = held<InstallFacts>();
    api.facts = () => facts.promise;
    serve();
    const user = await renderDialog();
    await waitFor(() => expect(apiClient.getInstallFacts).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => facts.resolve(installFacts()));
    // The next opening reads afresh.
    api.facts = () => installFacts({ imageTag: "ghcr.io/telflo/telflo/collector:0.162.0" });
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    expect(dialog()).toHaveTextContent("ghcr.io/telflo/telflo/collector:0.162.0");
  });
});

describe("InstallDialog's container method", () => {
  it("previews the command with the token masked, the group's mounts listed, inside ph-no-capture, and no reveal yet", async () => {
    api.facts = () => installFacts({ mounts: [NGINX_MOUNT, DATA_MOUNT] });
    serve();
    await renderDialog();
    await loaded();
    const preview = within(dialog()).getByText(/^OPAMP_TOKEN=/);
    expect(preview.textContent).toBe(
      [
        `OPAMP_TOKEN='${MASKED_TOKEN}' \\`,
        "docker run -d --restart unless-stopped --name telflo-collector \\",
        "  -v telflo-opamp:/app/opamp \\",
        "  -v '/var/log/nginx:/var/log/nginx:ro' \\",
        "  -v '/srv/data:/var/lib/otelcol' \\",
        `  -e COLLECTOR_GROUP_ID='${GATEWAYS_GROUP_ID}' \\`,
        "  -e OPAMP_ENDPOINT='wss://opamp.example.com/v1/opamp' \\",
        "  -e OPAMP_ALLOW_INSECURE_CONNECTIONS='false' \\",
        "  -e OPAMP_TOKEN \\",
        "  'ghcr.io/telflo/telflo/collector:0.159.0'",
      ].join("\n"),
    );
    expect(preview.closest(".ph-no-capture")).not.toBeNull();
    const mounts = within(dialog()).getByText("From the group's mounts:").parentElement as HTMLElement;
    expect(mounts).toHaveClass("ph-no-capture");
    expect(mounts).toHaveTextContent("/var/log/nginx → /var/log/nginx (read-only)/srv/data → /var/lib/otelcol");
    expect(mounts).toHaveTextContent("Edit the group's mounts on the Groups tab.");
    expect(dialog()).toHaveTextContent(CONTAINER_WARNING);
    expect(dialog()).not.toHaveTextContent(BEARER);
  });

  it("reveals once per click: the tokens read, the default token's reveal, the command copied with its bearer, shown only inside ph-no-capture", async () => {
    const success = vi.spyOn(toast, "success");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    calls.getEnrollmentTokens.mockClear();
    await user.click(revealButton());

    const box = await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_TOKEN_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied.startsWith(`OPAMP_TOKEN='${BEARER}' \\\n`)).toBe(true);
    expect(copied).toContain("  -e OPAMP_TOKEN \\\n");
    expect(copied).not.toContain(MASKED_TOKEN);
    expect(success).toHaveBeenCalledWith(COPIED_MESSAGE);
    expect(onInstallStarted).toHaveBeenCalledTimes(1);
    // The box holds what was copied; the preview and the reveal are gone.
    expect(box.closest(".ph-no-capture")?.querySelector("code")?.textContent).toBe(copied);
    expect(within(dialog()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    expect(within(dialog()).queryByText(/^OPAMP_TOKEN=.*/)).toBe(box.closest(".ph-no-capture")?.querySelector("code"));
    expectTextOnlyInsideNoCapture(BEARER);
    // No toast held it.
    for (const call of [...success.mock.calls]) expect(JSON.stringify(call)).not.toContain(BEARER);
  });

  it("checks the display name and the ticked values at the click, with nothing sent; the command follows the fields live after the reveal", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    const name = screen.getByRole("textbox", { name: "Collector display name (optional)" });
    expect(name).toHaveAttribute("placeholder", "e.g. prod-collector-east-1");
    expect(dialog()).toHaveTextContent("Shown in Fleet Management. Leave empty for an automatic name.");
    await user.type(name, "it's mine");
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.click(revealButton());
    expect(await within(dialog()).findByText("Use letters, digits, spaces, dots, dashes and underscores.")).toBeInTheDocument();
    expect(within(dialog()).getByText("Type a value or untick it.")).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, "  prod-east-1  ");
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), "sek'ret");
    expect(within(dialog()).queryByText("Type a value or untick it.")).toBeNull();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("  -e OPAMP_SERVER_NAME='prod-east-1' \\\n");
    expect(copied).toContain("\nNGINX_ENV='sek'\\''ret' \\\n");
    expect(copied).toContain("  -e NGINX_ENV \\\n");
    expect(copied.indexOf("OPAMP_TOKEN")).toBeLessThan(copied.indexOf("NGINX_ENV"));

    // Live: untick the variable, its line goes; a bad name hides the box and shows its message.
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    expect(within(dialog()).getByText(/^OPAMP_TOKEN=/).textContent).not.toContain("NGINX_ENV");
    await user.type(name, "'");
    expect(within(dialog()).queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(within(dialog()).getByText("Use letters, digits, spaces, dots, dashes and underscores.")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(BEARER))).toBeNull();
    await user.type(name, "{Backspace}");
    expect(await within(dialog()).findByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
  });

  it("shows the variables opt-in: Include {NAME} unticked, \"set on the host\", a value input once ticked; their help; none when the version reads none", async () => {
    api.facts = () => installFacts({ envVarNames: ["NGINX_ENV", "BACKEND_KEY"] });
    serve();
    const user = await renderDialog();
    await loaded();
    expect(dialog()).toHaveTextContent("Configuration environment variables (optional)");
    expect(dialog()).toHaveTextContent(
      "This group's published version reads these variables with ${env:…}. Tick one to set its value here; unticked variables are left out of the command: set them on the host.",
    );
    expect(screen.getByRole("checkbox", { name: "Include NGINX_ENV" })).not.toBeChecked();
    expect(within(dialog()).getAllByText("set on the host")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "NGINX_ENV" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Include BACKEND_KEY" }));
    const value = screen.getByRole("textbox", { name: "BACKEND_KEY" });
    expect(value).toHaveAttribute("placeholder", "value");
    expect(value.closest(".ph-no-capture")).not.toBeNull();
    await user.type(value, "abc");
    expect(within(dialog()).getByText(/^OPAMP_TOKEN=/).textContent).toContain("\nBACKEND_KEY='abc' \\\n");
  });

  it("shows no variables section when the version reads none", async () => {
    api.facts = () => installFacts({ envVarNames: [] });
    serve();
    await renderDialog();
    await loaded();
    expect(dialog()).not.toHaveTextContent("Configuration environment variables");
  });

  it("drops a reveal answered after the dialog closed: nothing copied, no toast, no install started, no bearer on reopening", async () => {
    const answer = held<typeof revealed>();
    api.reveal = () => answer.promise;
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    expect(await within(dialog()).findByText("Preparing…")).toBeInTheDocument();
    await waitFor(() => expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => answer.resolve(revealed));

    expect(writeText).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(BEARER);
    await user.click(screen.getByRole("button", { name: "open install" }));
    expect(await loaded()).toBeEnabled();
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("drops a reveal answered after the organization changed, the dialog still open", async () => {
    const answer = held<typeof revealed>();
    api.reveal = () => answer.promise;
    const success = vi.spyOn(toast, "success");
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await waitFor(() => expect(apiClient.revealEnrollmentToken).toHaveBeenCalled());
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () => answer.resolve(revealed));
    expect(writeText).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("gives the bearer up as the dialog closes: reopening shows the masked preview and Reveal again", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    await user.click(within(dialog()).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(BEARER);
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    expect(document.body.textContent).not.toContain(BEARER);
    expect(within(dialog()).getByText(/^OPAMP_TOKEN=/).textContent).toContain(MASKED_TOKEN);
  });

  it("disables the display name and the variables while revealing: the command copied is the one shown", async () => {
    const answer = held<typeof revealed>();
    api.reveal = () => answer.promise;
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), "v");
    await user.click(revealButton());
    await within(dialog()).findByText("Preparing…");
    expect(screen.getByRole("textbox", { name: "Collector display name (optional)" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "NGINX_ENV" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Include NGINX_ENV" })).toBeDisabled();
    // The Method too: the reveal is the container's.
    expect(screen.getByRole("combobox", { name: "Method" })).toBeDisabled();
    await act(async () => answer.resolve(revealed));
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(screen.getByRole("textbox", { name: "Collector display name (optional)" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Method" })).toBeEnabled();
    expect(within(dialog()).getByRole("button", { name: "Copy command" }).closest(".ph-no-capture")?.querySelector("code")?.textContent).toBe(
      writeText.mock.calls[0]![0],
    );
  });

  it("puts the focus on Copy command after the reveal (the button pressed is gone)", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    const copy = await within(dialog()).findByRole("button", { name: "Copy command" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
  });

  it("gives the bearer up as the dialog closes, while its content is still mounted for the exit animation", async () => {
    emulateExitAnimation();
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(document.body.textContent).toContain(BEARER);
    await user.keyboard("{Escape}");
    // Closing, still mounted: the bearer already gone from it.
    await waitFor(() => expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull());
    expect(document.body.textContent).not.toContain(BEARER);
  });

  describe("with ClipboardItem (Safari's way: the copy within the click)", () => {
    // The command is still revealed when the clipboard write fails.
    it("tells a refused copy after the reveal by its own state: the command shown, the copy's toast, install started", async () => {
      const error = vi.spyOn(toast, "error");
      serve();
      const user = await renderDialog();
      await loaded();
      const browser = clipboardItemBrowser(true);
      await user.click(revealButton());
      expect(browser.write).toHaveBeenCalledTimes(1);
      await within(dialog()).findByRole("button", { name: "Copy command" });
      await waitFor(() => expect(error).toHaveBeenCalledWith(COPY_FAILED_MESSAGE));
      expect(COPY_FAILED_MESSAGE).toBe("Command revealed, but copying failed: copy it from the box above.");
      expect(onInstallStarted).toHaveBeenCalledTimes(1);
      expect(within(dialog()).queryByRole("alert")).toBeNull();
    });

    it("says nothing when the dialog closed before the text was built, though the browser refuses the write with its own error", async () => {
      const answer = held<typeof revealed>();
      api.reveal = () => answer.promise;
      const error = vi.spyOn(toast, "error");
      const success = vi.spyOn(toast, "success");
      serve();
      const user = await renderDialog();
      await loaded();
      const browser = clipboardItemBrowser(false);
      await user.click(revealButton());
      await waitFor(() => expect(apiClient.revealEnrollmentToken).toHaveBeenCalled());
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => answer.resolve(revealed));
      await waitFor(() => expect(browser.write).toHaveBeenCalledTimes(1));
      await act(async () => undefined);
      expect(browser.kept).toEqual([]);
      expect(error).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(onInstallStarted).not.toHaveBeenCalled();
    });

    it("copies the command with its bearer through ClipboardItem when the browser allows it", async () => {
      serve();
      const user = await renderDialog();
      await loaded();
      const browser = clipboardItemBrowser(false);
      await user.click(revealButton());
      await waitFor(() => expect(browser.kept).toHaveLength(1));
      expect(browser.kept[0]).toContain(`OPAMP_TOKEN='${BEARER}'`);
    });
  });

  it("says the group's mounts can't be read and are left out when the facts say so", async () => {
    api.facts = () => installFacts({ mounts: [], mountsReadable: false });
    serve();
    await renderDialog();
    await loaded();
    expect(MOUNTS_UNREADABLE_WORDS).toBe(
      "This group's mounts are saved in a form Telflo can't read: they're left out of the command. Edit them on the Groups tab.",
    );
    expect(dialog()).toHaveTextContent(MOUNTS_UNREADABLE_WORDS);
    expect(dialog()).not.toHaveTextContent("From the group's mounts:");
    expect(within(dialog()).getByText(/^OPAMP_TOKEN=/).textContent).not.toContain("-v '");
  });

  it("says nothing of unreadable mounts when they were read", async () => {
    serve();
    await renderDialog();
    await loaded();
    expect(dialog()).toHaveTextContent("From the group's mounts:");
    expect(dialog()).not.toHaveTextContent(MOUNTS_UNREADABLE_WORDS);
  });

  it("shows the no-default-token words with a link to the Tokens tab, and no Reveal, when the default token is revoked", async () => {
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken()];
    serve();
    const user = await renderDialog();
    const link = await within(await screen.findByRole("dialog")).findByRole("link", { name: "Tokens tab" });
    expect(dialog()).toHaveTextContent("The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.");
    expect(within(dialog()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    await user.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("/?tab=tokens");
  });

  it("shows the no-default-token words when the reveal finds it revoked meanwhile", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" })];
    await user.click(revealButton());
    expect(await within(dialog()).findByRole("link", { name: "Tokens tab" })).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown outcome (503)", new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 }), FLEETS_UNAVAILABLE_MESSAGE],
    ["a rate limit", new ApiError("rate_limited", "Too many requests. Try again in 30 seconds.", { status: 429 }), "Too many requests. Try again in 30 seconds."],
    ["anything else", new ApiError("invalid_request", "The request was not valid.", { status: 400 }), REVEAL_FAILED_MESSAGE],
  ])("shows %s of the reveal inline, with nothing copied; the button tries again", async (_why, failure, words) => {
    let failed = false;
    api.reveal = async () => {
      if (failed) return revealed;
      failed = true;
      throw failure;
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    expect(writeText).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
  });
});

describe("InstallDialog's reveal reads the facts again", () => {
  it("reads the facts with the tokens at the reveal, and builds the command from them: a mount saved meanwhile is in it", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    expect(calls.getInstallFacts).toHaveBeenCalledTimes(1);
    api.facts = () => installFacts({ mounts: [NGINX_MOUNT, DATA_MOUNT] });
    await user.click(revealButton());
    const box = await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(calls.getInstallFacts).toHaveBeenCalledTimes(2);
    expect(calls.getInstallFacts).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("  -v '/var/log/nginx:/var/log/nginx:ro' \\\n  -v '/srv/data:/var/lib/otelcol' \\\n");
    expect(copied).toContain(`OPAMP_TOKEN='${BEARER}'`);
    expect(box.closest(".ph-no-capture")?.querySelector("code")?.textContent).toBe(copied);
    expect(dialog()).toHaveTextContent("/srv/data → /var/lib/otelcol");
  });

  it("leaves out a ticked variable the fresh facts no longer offer, in the copy as in the box", async () => {
    api.facts = () => installFacts({ envVarNames: ["NGINX_ENV", "SITE_NAME"] });
    serve();
    const user = await renderDialog();
    await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Include SITE_NAME" }));
    await user.type(screen.getByRole("textbox", { name: "SITE_NAME" }), "edge");
    api.facts = () => installFacts({ envVarNames: ["NGINX_ENV"] });
    await user.click(revealButton());
    const box = await within(dialog()).findByRole("button", { name: "Copy command" });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toContain("SITE_NAME");
    expect(box.closest(".ph-no-capture")?.querySelector("code")?.textContent).toBe(copied);
  });

  it("shows an archived fleet's words when the fleet was archived since the opening, reveals nothing, and has the route read the fleet again", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.facts = () => {
      throw new ApiError("fleet_archived", "The fleet is archived.", { status: 409 });
    };
    await user.click(revealButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The fleet is archived.");
    expect(within(dialog()).queryByRole("button", { name: /Reveal & copy command|Try again|Assign/ })).toBeNull();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it('toasts "Group not found" and closes when the group was deleted since the opening, revealing nothing', async () => {
    const error = vi.spyOn(toast, "error");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.facts = () => {
      throw new ApiError("collector_group_not_found", "Group not found", { status: 404 });
    };
    await user.click(revealButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith("Group not found");
    expect(onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows Assign when the group lost its published version since the opening", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.facts = () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    await user.click(revealButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(COLLECTOR_GROUP_UNASSIGNED_MESSAGE);
    expect(within(dialog()).getByRole("button", { name: "Assign" })).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
  });

  it("reveals nothing when the organization changes while the facts and the tokens are read (the guard after them)", async () => {
    const toastError = vi.spyOn(toast, "error");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    const facts = held<InstallFacts>();
    calls.getInstallFacts.mockImplementation(() => facts.promise);
    await user.click(revealButton());
    await waitFor(() => expect(calls.getInstallFacts).toHaveBeenCalledTimes(2));
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () => facts.resolve(installFacts({ mounts: [NGINX_MOUNT, DATA_MOUNT] })));
    // Every promise of the chain settled, a task later.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("shows a facts read's failure at the reveal inline, revealing nothing; the button tries again", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    api.facts = () => {
      throw new ApiError("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 });
    };
    await user.click(revealButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(INSTALL_UNAVAILABLE_MESSAGE);
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    api.facts = () => installFacts();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
  });

  it("takes a revealed bearer out of the box when a later read finds no valid default token, with the no-default-token words", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(document.body.textContent).toContain(BEARER);
    // A download refused for an assignment cleared meanwhile; its Assign's save reads everything again.
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    api.bundle = async () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Assign" }));
    const assign = await screen.findByRole("dialog", { name: "Edit gateways" });
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken()];
    await user.type(within(assign).getByRole("textbox", { name: "Name" }), "-2");
    const reads = calls.getEnrollmentTokens.mock.calls.length;
    await user.click(within(assign).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.getEnrollmentTokens.mock.calls.length).toBeGreaterThan(reads));
    await within(dialog()).findByRole("link", { name: "Tokens tab" });
    expect(document.body.textContent).not.toContain(BEARER);
    await chooseMethod(user, "Container image — pull and run");
    expect(within(dialog()).queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(within(dialog()).getByRole("link", { name: "Tokens tab" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(BEARER);
  });
});

describe("InstallDialog's revealed bearer after a later tokens read", () => {
  const OTHER_DEFAULT_ID = "c0ffee00-0000-4000-8000-0000000000d2";

  /** Reveals, then a download refused for an assignment cleared meanwhile; its Assign's save reads everything again with `tokens`. */
  async function revealThenReload(tokens: EnrollmentTokenListed[]) {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    api.bundle = async () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Assign" }));
    const assign = await screen.findByRole("dialog", { name: "Edit gateways" });
    api.tokens = tokens;
    await user.type(within(assign).getByRole("textbox", { name: "Name" }), "-2");
    const reads = calls.getEnrollmentTokens.mock.calls.length;
    await user.click(within(assign).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.getEnrollmentTokens.mock.calls.length).toBeGreaterThan(reads));
    await within(dialog()).findByRole("button", { name: "Download" });
    await chooseMethod(user, "Container image — pull and run");
    return calls;
  }

  it("takes the bearer out when the default token it was revealed for was revoked and replaced: Reveal again, no words", async () => {
    await revealThenReload([
      defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }),
      listedToken({ id: OTHER_DEFAULT_ID, kind: "default" }),
      listedToken(),
    ]);
    expect(within(dialog()).queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Reveal & copy command" })).toBeInTheDocument();
    expect(within(dialog()).queryByRole("link", { name: "Tokens tab" })).toBeNull();
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("keeps the bearer while the default token it was revealed for is still the valid one", async () => {
    await revealThenReload([defaultToken(), listedToken()]);
    expect(within(dialog()).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expectTextOnlyInsideNoCapture(BEARER);
  });
});

describe("InstallDialog's Assign after a mounts-changed refusal", () => {
  it("keeps the group dialog's baseline at its opening while the install dialog reloads: a second save is refused again, nothing sent", async () => {
    api.groups = [collectorGroup(), gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) })];
    api.facts = () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    const calls = serve();
    const sent: unknown[] = [];
    calls.updateCollectorGroup.mockImplementation(async (_o, _f, groupId, request) => {
      sent.push(request);
      return api.groups.find((group) => group.id === groupId)!;
    });
    const user = await renderDialog();
    await user.click(await within(dialog()).findByRole("button", { name: "Assign" }));
    const groupDialog = () => screen.getByRole("dialog", { name: "Edit gateways" });
    await screen.findByRole("dialog", { name: "Edit gateways" });
    // Another member saves a second mount meanwhile.
    api.groups = [collectorGroup(), gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) })];
    await user.click(within(groupDialog()).getByRole("button", { name: "Add mount" }));
    await user.type(within(groupDialog()).getAllByRole("textbox", { name: "Host path" }).at(-1)!, "/var/log/app");
    await user.type(within(groupDialog()).getAllByRole("textbox", { name: "Container path" }).at(-1)!, "/var/log/app");
    const save = () => within(groupDialog()).getByRole("button", { name: "Save" });
    const readsBefore = calls.getCollectorGroups.mock.calls.length;
    await user.click(save());
    expect(await screen.findByText(MOUNTS_CHANGED_MESSAGE)).toBeInTheDocument();
    // The save's own read, then the install dialog's reload (the refusal's onChanged) with the group as it is now.
    await waitFor(() => expect(calls.getCollectorGroups.mock.calls.length).toBeGreaterThanOrEqual(readsBefore + 2));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // The rows still the opening's, and the save compares against the opening: refused again, never dropping DATA_MOUNT.
    expect(within(groupDialog()).getAllByRole("textbox", { name: "Host path" }).map((each) => (each as HTMLInputElement).value)).toEqual([
      "/var/log/nginx",
      "/var/log/app",
    ]);
    await user.click(save());
    await waitFor(() => expect(calls.getCollectorGroups.mock.calls.length).toBeGreaterThanOrEqual(readsBefore + 3));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByText(MOUNTS_CHANGED_MESSAGE)).toBeInTheDocument();
    expect(sent).toEqual([]);
  });
});

describe("InstallDialog's variables named as Object.prototype's keys", () => {
  const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

  it("offers each unticked, takes it ticked and typed into the command, and logs no error", async () => {
    const consoleError = vi.spyOn(console, "error");
    api.facts = () => installFacts({ envVarNames: NAMES });
    serve();
    const user = await renderDialog();
    await loaded();
    for (const name of NAMES) expect(screen.getByRole("checkbox", { name: `Include ${name}` })).not.toBeChecked();
    expect(within(dialog()).getAllByText("set on the host")).toHaveLength(NAMES.length);
    for (const name of ["constructor", "__proto__", "toString"]) {
      await user.click(screen.getByRole("checkbox", { name: `Include ${name}` }));
      const value = screen.getByRole("textbox", { name });
      expect(value).toHaveValue("");
      expect(value).not.toHaveAttribute("aria-invalid");
      await user.type(value, `${name}-value`);
    }
    const preview = within(dialog()).getByText(/^OPAMP_TOKEN=/).textContent ?? "";
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(preview).toContain(`\n${name}='${name}-value' \\\n`);
      expect(preview).toContain(`  -e ${name} \\\n`);
    }
    expect(preview).not.toContain("hasOwnProperty");

    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    expect(writeText.mock.calls[0]![0]).toContain("\n__proto__='__proto__-value' \\\n");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows a ticked one's own problem only, never an inherited value", async () => {
    api.facts = () => installFacts({ envVarNames: NAMES });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Include constructor" }));
    await user.click(revealButton());
    expect(await screen.findByRole("textbox", { name: "constructor" })).toHaveAccessibleDescription("Type a value or untick it.");
    expect(within(dialog()).getAllByText("Type a value or untick it.")).toHaveLength(1);
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
  });

  it("maps a 400 on such a variable to its row", async () => {
    api.facts = () => installFacts({ envVarNames: ["__proto__", "constructor"] });
    api.bundle = async () => {
      throw new ApiError("invalid_request", "The request was not valid.", {
        status: 400,
        details: [{ path: ["env", 1, "value"], message: "Use no control characters (a line break or a tab, say)." }],
      });
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    for (const name of ["__proto__", "constructor"]) {
      await user.click(screen.getByRole("checkbox", { name: `Include ${name}` }));
      await user.type(screen.getByRole("textbox", { name }), "x");
    }
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("textbox", { name: "constructor" })).toHaveAccessibleDescription(
      "Use no control characters (a line break or a tab, say).",
    );
    expect(screen.getByRole("textbox", { name: "__proto__" })).not.toHaveAttribute("aria-describedby");
  });
});

describe("InstallDialog's Linux methods", () => {
  // The OPAMP_TOKEN export step after a zip download, its copy the unmasked
  // export line.
  it("downloads All In One (amd64): the request, the saved file, the toast, then the token screen with its own Reveal", async () => {
    const success = vi.spyOn(toast, "success");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    const root = screen.getByRole("textbox", { name: "Root path" });
    expect(root).toHaveValue("/etc/otelcol");
    expect(screen.queryByRole("textbox", { name: "Path to otelcol-contrib" })).toBeNull();
    expect(dialog()).toHaveTextContent("Ticked values are written into the bundle's start script: keep the bundle private if they are secrets.");
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Cancel", "Download", "Quick Deploy", "Close"]);
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), " sek'ret ");
    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), "edge 1");
    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("dialog", { name: "Set the token, then run" })).toBeInTheDocument();
    expect(calls.downloadInstallBundle).toHaveBeenCalledWith(
      GROUP_ID,
      FLEET_ID,
      GATEWAYS_GROUP_ID,
      { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [{ name: "NGINX_ENV", value: "sek'ret" }] } satisfies InstallBundleRequestInput,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(calls.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, fileName] = calls.downloadBlob.mock.calls[0]!;
    expect(fileName).toBe("telflo-collector-all-in-one-amd64.tar.gz");
    expect(blob.type).toBe("application/gzip");
    expect(success).toHaveBeenCalledWith(DOWNLOAD_STARTED_MESSAGE);
    expect(onInstallStarted).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();

    const masked = within(dialog()).getByText(/^export OPAMP_TOKEN=/);
    expect(masked.textContent).toBe(
      [
        `export OPAMP_TOKEN='Bearer ${MASKED_TOKEN}'`,
        "sudo mkdir -p '/etc/otelcol'",
        "sudo tar -xzf telflo-collector-all-in-one-amd64.tar.gz -C '/etc/otelcol'",
        "cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='edge 1'",
      ].join("\n"),
    );
    expect(dialog()).toHaveTextContent(
      "The supervisor keeps the token in /etc/otelcol/opamp.env (only root can read it), so later runs need no export. It runs in the foreground; a service that starts on boot comes with Quick Deploy.",
    );
    expect(dialog()).toHaveTextContent(LINUX_TOKEN_WARNING);
    await user.click(within(dialog()).getByRole("button", { name: "Reveal" }));
    const copy = await within(dialog()).findByRole("button", { name: "Copy commands" });
    const box = copy.closest(".ph-no-capture")?.querySelector("code");
    expect(box?.textContent).toContain(`export OPAMP_TOKEN='Bearer ${BEARER}'\nsudo mkdir -p '/etc/otelcol'`);
    expectTextOnlyInsideNoCapture(BEARER);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(box?.textContent);
  });

  it("downloads own-binary (arm64) with the executable path; checks both paths at the click with nothing sent", async () => {
    api.bundle = async () => ({ fileName: "telflo-collector-own-binary-arm64.tar.gz", archive: new Uint8Array([1]) });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux with your own otelcol-contrib (arm64)");
    await untickSystemd(user);
    const root = screen.getByRole("textbox", { name: "Root path" });
    const executable = screen.getByRole("textbox", { name: "Path to otelcol-contrib" });
    expect(executable).toHaveValue("/usr/bin/otelcol-contrib");
    expect(dialog()).toHaveTextContent("The collector's configuration is written to /etc/otelcol/otelcol-config.yaml and the supervisor's state to /etc/otelcol/opamp.");
    await user.clear(root);
    await user.type(root, "opt/otel");
    await user.clear(executable);
    await user.type(executable, "/usr/bin/../otelcol");
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await within(dialog()).findByText("Use an absolute path, starting with /.")).toBeInTheDocument();
    expect(within(dialog()).getByText("Use no . or .. segment.")).toBeInTheDocument();
    expect(calls.downloadInstallBundle).not.toHaveBeenCalled();

    await user.clear(root);
    await user.type(root, "/opt/otel/");
    await user.clear(executable);
    await user.type(executable, "/opt/bin/otelcol-contrib");
    await user.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("dialog", { name: "Set the token, then run" });
    expect(calls.downloadInstallBundle.mock.calls[0]![3]).toEqual({
      method: "own-binary",
      arch: "arm64",
      rootPath: "/opt/otel/",
      executablePath: "/opt/bin/otelcol-contrib",
      env: [],
    });
    expect(calls.downloadBlob.mock.calls[0]![1]).toBe("telflo-collector-own-binary-arm64.tar.gz");
    expect(within(dialog()).getByText(/^export OPAMP_TOKEN=/).textContent).toContain("sudo tar -xzf telflo-collector-own-binary-arm64.tar.gz -C '/opt/otel'");
  });

  it("shows a 400's details under their fields, the variable's under its row", async () => {
    api.bundle = async () => {
      throw new ApiError("invalid_request", "The request was not valid.", {
        status: 400,
        details: [
          { path: ["env", 0, "value"], message: "Use no control characters (a line break or a tab, say)." },
          { path: ["rootPath"], message: "At most 200 characters." },
        ],
      });
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (arm64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), "x");
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("textbox", { name: "NGINX_ENV" })).toHaveAccessibleDescription(
      "Use no control characters (a line break or a tab, say).",
    );
    expect(screen.getByRole("textbox", { name: "Root path" })).toHaveAccessibleDescription(expect.stringContaining("At most 200 characters."));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it.each([
    ["a retired version's binaries for the arch", new ApiError("collector_version_not_offered", "Collector v0.159.0 has no arm64 binaries to install. Choose the other arch, or publish a version that has them.", { status: 409 }), "Collector v0.159.0 has no arm64 binaries to install."],
    ["the templates unreadable", new ApiError("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 }), INSTALL_UNAVAILABLE_MESSAGE],
    ["an unknown outcome", new ApiError("network_error", "fetch failed"), FLEETS_UNAVAILABLE_MESSAGE],
  ])("shows %s inline, keeping the form", async (_why, failure, words) => {
    api.bundle = async () => {
      throw failure;
    };
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (arm64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByRole("textbox", { name: "Root path" })).toBeInTheDocument();
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
  });

  it("drops a download answered after Close: nothing saved, no toast, no token screen", async () => {
    const answer = held<{ fileName: string; archive: Uint8Array }>();
    api.bundle = () => answer.promise;
    const success = vi.spyOn(toast, "success");
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await within(dialog()).findByText("Building…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => answer.resolve({ fileName: "telflo-collector-all-in-one-amd64.tar.gz", archive: new Uint8Array([1]) }));
    expect(calls.downloadBlob).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(onInstallStarted).not.toHaveBeenCalled();
  });

  it("shares the opening's one bearer: revealed for the container, the token screen shows it with no second reveal", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await within(await screen.findByRole("dialog", { name: "Set the token, then run" })).findByRole("button", { name: "Copy commands" })).toBeInTheDocument();
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
  });

  it("puts the focus on the token screen's Reveal after the download, then on Copy commands after its reveal", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("button", { name: "Download" }));
    const screenDialog = await screen.findByRole("dialog", { name: "Set the token, then run" });
    await waitFor(() => expect(document.activeElement).toBe(within(screenDialog).getByRole("button", { name: "Reveal" })));
    await user.click(within(screenDialog).getByRole("button", { name: "Reveal" }));
    const copy = await within(screenDialog).findByRole("button", { name: "Copy commands" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
  });

  it("shows the no-default-token words on the Linux form, under the footer, before the download: Quick Deploy disabled and described by them, Download enabled once unticked", async () => {
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" })];
    const calls = serve();
    const user = await renderDialog();
    await within(await screen.findByRole("dialog")).findByRole("link", { name: "Tokens tab" });
    await chooseMethod(user, "Linux with your own otelcol-contrib (amd64)");
    const link = within(dialog()).getByRole("link", { name: "Tokens tab" });
    const quickDeploy = screen.getByRole("button", { name: "Quick Deploy" });
    expect(quickDeploy).toBeDisabled();
    // The link's own text joined with spaces around it by the accessible-description computation.
    expect(quickDeploy).toHaveAccessibleDescription(/^The fleet's default token is revoked\. Issue a new one on the Tokens tab ?, then install\.$/);
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    await untickSystemd(user);
    expect(quickDeploy).toBeDisabled();
    const download = screen.getByRole("button", { name: "Download" });
    expect(download).toBeEnabled();
    expect(quickDeploy.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(download);
    await screen.findByRole("dialog", { name: "Set the token, then run" });
    expect(calls.downloadInstallBundle).toHaveBeenCalledTimes(1);
  });

  it("shows no such words on the Linux form while a default token is valid", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(within(dialog()).queryByRole("link", { name: "Tokens tab" })).toBeNull();
  });

  it("shows the no-default-token words on the token screen in place of Reveal", async () => {
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" })];
    serve();
    const user = await renderDialog();
    await within(await screen.findByRole("dialog")).findByRole("link", { name: "Tokens tab" });
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    await user.click(screen.getByRole("button", { name: "Download" }));
    const screenDialog = await screen.findByRole("dialog", { name: "Set the token, then run" });
    expect(within(screenDialog).getByRole("link", { name: "Tokens tab" })).toBeInTheDocument();
    expect(within(screenDialog).queryByRole("button", { name: "Reveal" })).toBeNull();
  });

  it("refuses more than 50 ticked variables for a bundle with a message, nothing sent (the facts have no such bound)", async () => {
    const names = Array.from({ length: 51 }, (_each, index) => `VAR_${index}`);
    api.facts = () => installFacts({ envVarNames: names });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await untickSystemd(user);
    // fireEvent, the rows found once: 51 rows typed by userEvent, each found by role, take seconds.
    for (const checkbox of within(dialog()).getAllByRole("checkbox", { name: /^Include / })) fireEvent.click(checkbox);
    for (const input of dialog().querySelectorAll<HTMLInputElement>("input[placeholder='value']")) fireEvent.change(input, { target: { value: "v" } });
    expect(within(dialog()).getAllByRole("checkbox", { checked: true })).toHaveLength(51);
    expect(within(dialog()).getByText("Tick at most 50 variables: a bundle holds no more.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(calls.downloadInstallBundle).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "Include VAR_0" }));
    expect(within(dialog()).queryByText("Tick at most 50 variables: a bundle holds no more.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("dialog", { name: "Set the token, then run" });
    expect(calls.downloadInstallBundle.mock.calls[0]![3].env).toHaveLength(50);
  });
});

describe("InstallDialog's Quick Deploy (", () => {
  const OTHER_DEFAULT_ID = "c0ffee00-0000-4000-8000-0000000000d3";
  const OTHER_BEARER = "otherBearer9f8e7d+/==";
  const LINUX_LABELS = [
    "Linux All In One (amd64)",
    "Linux All In One (arm64)",
    "Linux with your own otelcol-contrib (amd64)",
    "Linux with your own otelcol-contrib (arm64)",
  ];
  const quickDeployButton = () => screen.getByRole("button", { name: "Quick Deploy" });
  const quickScreen = () => screen.getByRole("dialog", { name: QUICK_DEPLOY_TITLE });
  const quickReveal = () => within(quickScreen()).getByRole("button", { name: "Reveal & copy command" });
  const boxText = (copy: HTMLElement) => copy.closest(".ph-no-capture")?.querySelector("code")?.textContent;

  /** Opened on a Linux method (All In One amd64 unless named), the systemd box as it opens: ticked. */
  async function onLinux(label = "Linux All In One (amd64)") {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, label);
    return { calls, user };
  }

  /** Quick Deploy clicked, its screen shown. */
  async function madeLink(user: ReturnType<typeof userEvent.setup>) {
    await user.click(quickDeployButton());
    return screen.findByRole("dialog", { name: QUICK_DEPLOY_TITLE });
  }

  it("offers the systemd box on the Linux methods only, ticked, its hint its description, after the variables and before the warning", async () => {
    serve();
    const user = await renderDialog();
    await loaded();
    expect(screen.queryByRole("checkbox", { name: SYSTEMD_LABEL })).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Quick Deploy" })).toBeNull();
    for (const label of LINUX_LABELS) {
      await chooseMethod(user, label);
      expect(systemdBox()).toBeChecked();
      expect(systemdBox()).toHaveAccessibleDescription(SYSTEMD_HINT);
    }
    expect(SYSTEMD_LABEL).toBe("Install as a systemd service (starts on boot)");
    expect(SYSTEMD_HINT).toBe(
      "Installs telflo-supervisor.service with sudo so the collector restarts after a reboot or a crash. Comes with Quick Deploy: untick it to download the bundle and run it yourself.",
    );
    const following = (first: Node, second: Node) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(following(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }), systemdBox())).toBe(true);
    expect(following(systemdBox(), within(dialog()).getByText(LINUX_WARNING))).toBe(true);
    expect(LINUX_WARNING).toBe(
      "The bundle holds no token: the dialog gives it to you after the download, or inside the Quick Deploy command. Treat it as a secret.",
    );
    await chooseMethod(user, "Container image — pull and run");
    expect(screen.queryByRole("checkbox", { name: SYSTEMD_LABEL })).toBeNull();
  });

  // The systemd service starts with systemd's clean environment: the shell's variables never reach it; a secret goes in a root-only EnvironmentFile.
  it("says, while the box is ticked, that the service doesn't see the shell's variables and how to give it one; unticked or on the container, the earlier words", async () => {
    api.facts = () => installFacts({ envVarNames: ["NGINX_ENV", "BACKEND_KEY"] });
    const SERVICE_HELP =
      "This group's published version reads these variables with ${env:…}. Tick one to set its value here. The systemd service doesn't see variables set in your shell: tick them here, or give them to the service afterwards with sudo systemctl edit telflo-supervisor (an Environment=NAME=value line for a plain value; for a secret, an EnvironmentFile= line naming a file only root can read, since Environment= values are visible to every user on the host), then restart it. Ticked values are written into the bundle's start script (root only): keep the link private if they are secrets.";
    const BUNDLE_HELP =
      "This group's published version reads these variables with ${env:…}. Tick one to set its value here; unticked variables are left out of the bundle: set them on the host. Ticked values are written into the bundle's start script: keep the bundle private if they are secrets.";
    const COMMAND_HELP =
      "This group's published version reads these variables with ${env:…}. Tick one to set its value here; unticked variables are left out of the command: set them on the host.";
    const { user } = await onLinux();
    expect(systemdBox()).toBeChecked();
    expect(dialog()).toHaveTextContent(SERVICE_HELP);
    expect(within(dialog()).getAllByText("set in the service")).toHaveLength(2);
    expect(within(dialog()).queryByText("set on the host")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    expect(screen.getByRole("textbox", { name: "NGINX_ENV" })).toBeInTheDocument();
    expect(within(dialog()).getAllByText("set in the service")).toHaveLength(1);

    await user.click(systemdBox());
    expect(dialog()).toHaveTextContent(BUNDLE_HELP);
    expect(dialog()).not.toHaveTextContent("systemctl edit");
    expect(within(dialog()).getAllByText("set on the host")).toHaveLength(1);
    expect(within(dialog()).queryByText("set in the service")).toBeNull();

    await chooseMethod(user, "Linux with your own otelcol-contrib (amd64)");
    expect(systemdBox()).not.toBeChecked();
    await user.click(systemdBox());
    expect(dialog()).toHaveTextContent(SERVICE_HELP);

    await chooseMethod(user, "Container image — pull and run");
    expect(dialog()).toHaveTextContent(COMMAND_HELP);
    expect(dialog()).not.toHaveTextContent("systemctl edit");
    expect(within(dialog()).getAllByText("set on the host")).toHaveLength(1);
  });

  it("disables Download while the box is ticked, its reason shown and its description; unticked, Download is enabled; the footer Cancel | Download | Quick Deploy", async () => {
    const { user } = await onLinux();
    expect(within(dialog()).getAllByRole("button").map((each) => each.textContent)).toEqual(["Cancel", "Download", "Quick Deploy", "Close"]);
    const download = screen.getByRole("button", { name: "Download" });
    expect(download).toBeDisabled();
    expect(download).toHaveAccessibleDescription(DOWNLOAD_NEEDS_UNTICK_WORDS);
    expect(dialog()).toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);
    expect(DOWNLOAD_NEEDS_UNTICK_WORDS).toBe(
      'The systemd service comes with Quick Deploy. Untick "Install as a systemd service" to download the bundle instead.',
    );
    expect(quickDeployButton()).toBeEnabled();
    await user.click(systemdBox());
    expect(download).toBeEnabled();
    expect(download).not.toHaveAttribute("aria-describedby");
    expect(dialog()).not.toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);
    expect(quickDeployButton()).toBeEnabled();
    await user.click(systemdBox());
    expect(download).toBeDisabled();
  });

  it("names Download's reason by aria-describedby only while the reason is shown: not while the facts load, nor after their refusal", async () => {
    const facts = held<InstallFacts>();
    api.facts = () => facts.promise;
    serve();
    const user = await renderDialog();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading…");
    const download = () => screen.getByRole("button", { name: "Download" });
    expect(download()).toBeDisabled();
    expect(download()).not.toHaveAttribute("aria-describedby");
    expect(dialog()).not.toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);

    await act(async () => facts.reject(new ApiError("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 })));
    expect(await within(dialog()).findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(download()).not.toHaveAttribute("aria-describedby");
    expect(dialog()).not.toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);

    api.facts = () => installFacts();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    await within(dialog()).findByRole("checkbox", { name: SYSTEMD_LABEL });
    expect(download()).toHaveAccessibleDescription(DOWNLOAD_NEEDS_UNTICK_WORDS);
  });

  it.each([
    ["an inline refusal", new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 }), FLEETS_UNAVAILABLE_MESSAGE],
    [
      "the cap's refusal",
      new ApiError("quick_deploy_link_limit_reached", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached, { status: 409 }),
      "Revoke an install link first: a fleet holds at most 100 active links.",
    ],
  ])("toggling the systemd box clears %s of the link's making, as editing a field does", async (_why, failure, words) => {
    api.create = async () => {
      throw failure;
    };
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    await user.click(systemdBox());
    expect(within(dialog()).queryByRole("alert")).toBeNull();
    expect(dialog()).not.toHaveTextContent(words);
  });

  it("ticks the box again at each opening", async () => {
    const { user } = await onLinux();
    await user.click(systemdBox());
    expect(systemdBox()).not.toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(systemdBox()).toBeChecked();
  });

  // The Quick Deploy command holds the bearer's export (masked); the group's
  // id is sent.
  it('"Quick Deploy" makes the link only (the download\'s request plus systemd, never the display name), the fields disabled meanwhile, then the screen: the preview masked, its words, install started, the focus on Reveal & copy command', async () => {
    const create = held<CreateQuickDeployLinkResponse>();
    api.create = () => create.promise;
    const { calls, user } = await onLinux();
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), " sek'ret ");
    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), "  edge 1  ");
    calls.getEnrollmentTokens.mockClear();
    await user.click(quickDeployButton());

    expect(await within(dialog()).findByText("Making link…")).toBeInTheDocument();
    for (const name of ["Root path", "Collector display name (optional)", "NGINX_ENV"]) expect(screen.getByRole("textbox", { name })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Include NGINX_ENV" })).toBeDisabled();
    expect(systemdBox()).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Method" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Making link…" })).toBeDisabled();
    await act(async () => create.resolve(quickDeployLinkCreated()));

    const screenDialog = await screen.findByRole("dialog", { name: QUICK_DEPLOY_TITLE });
    expect(calls.createQuickDeployLink).toHaveBeenCalledTimes(1);
    expect(calls.createQuickDeployLink).toHaveBeenCalledWith(
      GROUP_ID,
      FLEET_ID,
      GATEWAYS_GROUP_ID,
      { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [{ name: "NGINX_ENV", value: "sek'ret" }], systemd: true } satisfies CreateQuickDeployLinkRequestInput,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(calls.createQuickDeployLink.mock.calls[0])).not.toContain("edge 1");
    // The create only: no reveal, no tokens read, no download, nothing copied yet.
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    expect(calls.getEnrollmentTokens).not.toHaveBeenCalled();
    expect(calls.downloadInstallBundle).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onInstallStarted).toHaveBeenCalledTimes(1);

    const preview = screenDialog.querySelector("pre");
    expect(preview?.textContent).toBe(quickDeployPreview({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", displayName: "edge 1", systemd: true }));
    expect(preview?.textContent).toContain(`export OPAMP_TOKEN='Bearer ${MASKED_TOKEN}' &&`);
    expect(preview?.textContent).toContain(`'https://telflo.example.com/api/v1/quick-deploy/${QUICK_DEPLOY_MASKED_SECRET}'`);
    expect(preview?.textContent).toContain('ExecStart=/etc/otelcol/start_supervisor.sh "--OPAMP_SERVER_NAME=edge 1"');
    expect(preview?.closest(".ph-no-capture")).not.toBeNull();
    expect(document.body.textContent).not.toContain(QUICK_DEPLOY_SECRET);
    expect(document.body.textContent).not.toContain(BEARER);

    expect(screenDialog).toHaveTextContent(`${QUICK_DEPLOY_SYSTEMD_WORDS} See its log with sudo journalctl -u telflo-supervisor -f.`);
    expect(QUICK_DEPLOY_SYSTEMD_WORDS).toBe(
      "Run this command on the host: it downloads the bundle, unpacks it and installs the collector as telflo-supervisor.service, started now and on every boot.",
    );
    expect(screenDialog).toHaveTextContent(
      `This command is shown only now. It expires ${formatDateTime("2026-10-18T09:00:00.000Z")}; extend or revoke it under Install links on the Tokens tab.`,
    );
    expect(screenDialog).toHaveTextContent(QUICK_DEPLOY_WARNING);
    expect(QUICK_DEPLOY_WARNING).toBe(
      "The command contains the fleet's default token and a link that downloads this install, with the values you typed, without signing in. Run it in a secure shell; don't paste it into shared logs or chat. If it leaks, revoke the link, and revoke the default token and issue a new one.",
    );
    expect(within(screenDialog).getAllByRole("button").map((each) => each.textContent)).toEqual(["Reveal & copy command", "Done", "Close"]);
    await waitFor(() => expect(document.activeElement).toBe(quickReveal()));
  });

  // The copy is the unmasked Quick Deploy command, with systemd when ticked.
  it('"Reveal & copy command" reveals the link\'s default token once (no tokens read), copies the systemd command, then shows it in a SecretCopyBox; the toast; the focus on Copy command', async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { calls, user } = await onLinux();
    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), "edge 1");
    await madeLink(user);
    calls.getEnrollmentTokens.mockClear();
    await user.click(quickReveal());

    const copy = await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_TOKEN_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls.getEnrollmentTokens).not.toHaveBeenCalled();
    const command = quickDeployCommands({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", bearer: BEARER, displayName: "edge 1", systemd: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(command);
    expect(command).toContain(`export OPAMP_TOKEN='Bearer ${BEARER}' &&`);
    expect(command).toContain(`printf 'url = "%s"\\n' '${QUICK_DEPLOY_URL}' | curl -q -g -fsS --retry 3 --proto '=https' -K -`);
    // The token persists to opamp.env instead of the script running in the
    // foreground.
    expect(command).toContain(`printf "OPAMP_TOKEN='%s'\\n" "$OPAMP_TOKEN" | sudo install -m 600 /dev/stdin '/etc/otelcol/opamp.env' &&`);
    // The subshell's `)` closes the last command's line (in csh and tcsh no line then runs).
    expect(command.split("\n").at(-1)).toBe(
      "sudo systemctl daemon-reload && sudo systemctl enable telflo-supervisor.service && sudo systemctl restart telflo-supervisor.service )",
    );
    expect(boxText(copy)).toBe(command);
    expect(within(quickScreen()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    expect(quickScreen().querySelector("pre")).toBeNull();
    expect(success).toHaveBeenCalledWith(QUICK_DEPLOY_COPIED_MESSAGE);
    expect(QUICK_DEPLOY_COPIED_MESSAGE).toBe("Copied install command");
    expect(error).not.toHaveBeenCalled();
    // Install started once: at the link's making.
    expect(onInstallStarted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(copy));
    expectTextOnlyInsideNoCapture(BEARER);
    expectTextOnlyInsideNoCapture(QUICK_DEPLOY_SECRET);
    for (const call of [...success.mock.calls, ...error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(BEARER);
      expect(JSON.stringify(call)).not.toContain(QUICK_DEPLOY_SECRET);
    }
    await user.click(copy);
    expect(writeText).toHaveBeenLastCalledWith(command);
  });

  it("unticked, makes a foreground link: its words, and the command runs start_supervisor.sh in that shell", async () => {
    api.create = async () =>
      quickDeployLinkCreated({
        choices: { method: "own-binary", arch: "arm64", rootPath: "/etc/otelcol", executablePath: "/usr/bin/otelcol-contrib", systemd: false, envNames: [] },
      });
    const { calls, user } = await onLinux("Linux with your own otelcol-contrib (arm64)");
    await user.click(systemdBox());
    const screenDialog = await madeLink(user);
    expect(calls.createQuickDeployLink.mock.calls[0]![3]).toEqual({
      method: "own-binary",
      arch: "arm64",
      rootPath: "/etc/otelcol",
      executablePath: "/usr/bin/otelcol-contrib",
      env: [],
      systemd: false,
    });
    expect(screenDialog).toHaveTextContent(QUICK_DEPLOY_FOREGROUND_WORDS);
    expect(QUICK_DEPLOY_FOREGROUND_WORDS).toBe(
      "Run this command on the host: it downloads the bundle, unpacks it and starts the collector in the foreground of that shell.",
    );
    expect(screenDialog).not.toHaveTextContent("journalctl");
    expect(screenDialog.querySelector("pre")?.textContent).toBe(quickDeployPreview({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", displayName: "", systemd: false }));
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    const command = writeText.mock.calls[0]![0] as string;
    expect(command).toBe(quickDeployCommands({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", bearer: BEARER, displayName: "", systemd: false }));
    expect(command.split("\n").at(-1)).toBe("cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh )");
    expect(command).not.toContain("systemctl");
  });

  it("takes the root path as checked (its trailing / removed) and the display name trimmed into the command", async () => {
    const { user } = await onLinux();
    const root = screen.getByRole("textbox", { name: "Root path" });
    await user.clear(root);
    await user.type(root, "/opt/telflo/");
    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), "  vm 7  ");
    await madeLink(user);
    expect(apiClient.createQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.objectContaining({ rootPath: "/opt/telflo/" }), expect.anything());
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(writeText.mock.calls[0]![0]).toBe(
      quickDeployCommands({ url: QUICK_DEPLOY_URL, rootPath: "/opt/telflo", bearer: BEARER, displayName: "vm 7", systemd: true }),
    );
  });

  it("installs into the Default group when opened with none", async () => {
    api.groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gatewaysGroup()];
    const calls = serve();
    const user = await renderDialog({ groupId: null });
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await madeLink(user);
    expect(calls.createQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_GROUP_ID, expect.anything(), expect.anything());
  });

  it("reuses the opening's bearer when its token is the link's: no second reveal, the second click still copies", async () => {
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    await chooseMethod(user, "Linux All In One (amd64)");
    await madeLink(user);
    // The masked preview until the second click, though the bearer is at hand.
    expect(within(quickScreen()).queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(quickScreen()).not.toHaveTextContent(BEARER);
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(quickDeployCommands({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", bearer: BEARER, displayName: "", systemd: true }));
  });

  it("reveals the link's own default token when the opening's bearer is another token's", async () => {
    api.create = async () => quickDeployLinkCreated({ defaultTokenId: OTHER_DEFAULT_ID });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    api.reveal = async () => ({ token: { id: OTHER_DEFAULT_ID, kind: "default" as const, bearer: OTHER_BEARER, expiresAt: null } });
    await chooseMethod(user, "Linux All In One (amd64)");
    await madeLink(user);
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(2);
    expect(calls.revealEnrollmentToken).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, OTHER_DEFAULT_ID, expect.anything());
    expect(writeText.mock.calls.at(-1)![0]).toContain(`export OPAMP_TOKEN='Bearer ${OTHER_BEARER}' &&`);
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("checks the fields at the click as the download's, nothing sent", async () => {
    const { calls, user } = await onLinux();
    const root = screen.getByRole("textbox", { name: "Root path" });
    await user.clear(root);
    await user.type(root, "opt/otel");
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.click(quickDeployButton());
    expect(await within(dialog()).findByText("Use an absolute path, starting with /.")).toBeInTheDocument();
    expect(within(dialog()).getByText("Type a value or untick it.")).toBeInTheDocument();
    expect(calls.createQuickDeployLink).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: QUICK_DEPLOY_TITLE })).toBeNull();
  });

  it("drops a link made after the dialog closed: no screen, no install started; reopening shows the form, the box ticked, no secret", async () => {
    const create = held<CreateQuickDeployLinkResponse>();
    api.create = () => create.promise;
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    await within(dialog()).findByText("Making link…");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => create.resolve(quickDeployLinkCreated()));
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    expect(screen.queryByRole("dialog", { name: QUICK_DEPLOY_TITLE })).toBeNull();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(systemdBox()).toBeChecked();
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
  });

  it("drops a link made after the organization changed, the dialog still open", async () => {
    const create = held<CreateQuickDeployLinkResponse>();
    api.create = () => create.promise;
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    await waitFor(() => expect(apiClient.createQuickDeployLink).toHaveBeenCalled());
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () => create.resolve(quickDeployLinkCreated()));
    expect(screen.queryByRole("dialog", { name: QUICK_DEPLOY_TITLE })).toBeNull();
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
  });

  it("drops a reveal answered after the dialog closed: nothing copied, no toast, neither secret left", async () => {
    const answer = held<typeof revealed>();
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { user } = await onLinux();
    await madeLink(user);
    api.reveal = () => answer.promise;
    await user.click(quickReveal());
    expect(await within(quickScreen()).findByText("Preparing…")).toBeInTheDocument();
    await waitFor(() => expect(apiClient.revealEnrollmentToken).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => answer.resolve(revealed));
    expect(writeText).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(BEARER);
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
  });

  it("drops a reveal answered after the organization changed, the dialog still open", async () => {
    const answer = held<typeof revealed>();
    const success = vi.spyOn(toast, "success");
    const { user } = await onLinux();
    await madeLink(user);
    api.reveal = () => answer.promise;
    await user.click(quickReveal());
    await waitFor(() => expect(apiClient.revealEnrollmentToken).toHaveBeenCalledTimes(1));
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () => answer.resolve(revealed));
    expect(writeText).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(BEARER);
  });

  it.each([
    [
      "the cap",
      new ApiError("quick_deploy_link_limit_reached", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached, { status: 409 }),
      "Revoke an install link first: a fleet holds at most 100 active links.",
    ],
    ["a rate limit", new ApiError("rate_limited", "Too many requests. Try again in 30 seconds.", { status: 429 }), "Too many requests. Try again in 30 seconds."],
    [
      "a retired version's binaries for the arch",
      new ApiError("collector_version_not_offered", "Collector v0.159.0 has no amd64 binaries to install.", { status: 409 }),
      "Collector v0.159.0 has no amd64 binaries to install.",
    ],
    ["an unknown outcome", new ApiError("network_error", "fetch failed"), FLEETS_UNAVAILABLE_MESSAGE],
    [
      "a 400 naming no field of the form",
      new ApiError("invalid_request", "The request was not valid.", { status: 400, details: [{ path: ["systemd"], message: "Expected boolean." }] }),
      QUICK_DEPLOY_FAILED_MESSAGE,
    ],
  ])("shows %s of the link's making inline, keeping the form; Quick Deploy tries again", async (_why, failure, words) => {
    let failed = false;
    api.create = async () => {
      if (failed) return quickDeployLinkCreated();
      failed = true;
      throw failure;
    };
    const { calls, user } = await onLinux();
    await user.click(quickDeployButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByRole("textbox", { name: "Root path" })).toBeEnabled();
    expect(onInstallStarted).not.toHaveBeenCalled();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    await madeLink(user);
    expect(calls.createQuickDeployLink).toHaveBeenCalledTimes(2);
  });

  it("shows a 400's details under their fields (the download's mapper), the variable's under its row", async () => {
    api.create = async () => {
      throw new ApiError("invalid_request", "The request was not valid.", {
        status: 400,
        details: [
          { path: ["env", 0, "name"], message: "This version doesn't read this variable." },
          { path: ["rootPath"], message: "At most 200 characters." },
        ],
      });
    };
    const { user } = await onLinux();
    await user.click(screen.getByRole("checkbox", { name: "Include NGINX_ENV" }));
    await user.type(screen.getByRole("textbox", { name: "NGINX_ENV" }), "x");
    await user.click(quickDeployButton());
    expect(await screen.findByRole("textbox", { name: "NGINX_ENV" })).toHaveAccessibleDescription("This version doesn't read this variable.");
    expect(screen.getByRole("textbox", { name: "Root path" })).toHaveAccessibleDescription(expect.stringContaining("At most 200 characters."));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("shows an archived fleet's words when it was archived since the opening, and has the route read the fleet again", async () => {
    api.create = async () => {
      throw new ApiError("fleet_archived", "The fleet is archived.", { status: 409 });
    };
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The fleet is archived.");
    expect(within(dialog()).queryByRole("button", { name: /Try again|Assign/ })).toBeNull();
    expect(quickDeployButton()).toBeDisabled();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it("shows Assign when the group lost its published version since the opening", async () => {
    api.create = async () => {
      throw new ApiError("collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, { status: 409 });
    };
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(COLLECTOR_GROUP_UNASSIGNED_MESSAGE);
    expect(within(dialog()).getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });

  it("closes for the fleet gone, and the route reads it again", async () => {
    api.create = async () => {
      throw new ApiError("fleet_not_found", "Fleet not found", { status: 404 });
    };
    const { user } = await onLinux();
    await user.click(quickDeployButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the no-default-token words and disables Quick Deploy when the create finds no valid default token", async () => {
    api.create = async () => {
      throw new ApiError("enrollment_token_default_missing", QUICK_DEPLOY_LINK_ERROR_MESSAGES.enrollment_token_default_missing, { status: 409 });
    };
    const { calls, user } = await onLinux();
    await user.click(quickDeployButton());
    const link = await within(dialog()).findByRole("link", { name: "Tokens tab" });
    expect(quickDeployButton()).toBeDisabled();
    // The button pressed is disabled: the focus goes to the words' link, as after the reveal's refusal.
    await waitFor(() => expect(document.activeElement).toBe(link));
    expect(within(dialog()).queryByText(QUICK_DEPLOY_FAILED_MESSAGE)).toBeNull();
    expect(calls.revealEnrollmentToken).not.toHaveBeenCalled();
    // Download is kept once unticked.
    await untickSystemd(user);
  });

  it("shows the no-default-token words on the screen when the link's token was revoked meanwhile and no default token is valid, nothing copied, the focus on their Tokens tab link", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken()];
    api.reveal = async () => {
      throw new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 });
    };
    calls.getEnrollmentTokens.mockClear();
    await user.click(quickReveal());
    const link = await within(quickScreen()).findByRole("link", { name: "Tokens tab" });
    expect(within(quickScreen()).getByRole("alert")).toHaveTextContent("The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.");
    expect(within(quickScreen()).queryByText(QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS)).toBeNull();
    expect(within(quickScreen()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    expect(quickScreen().querySelector("pre")).not.toBeNull();
    // The tokens read again, once, to tell the words.
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  // The token race: the link made with A; A revoked and B issued before the reveal.
  it("says the link's token was revoked (make a new link) when another default token is valid, nothing copied, the focus on Done", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.tokens = [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken({ id: OTHER_DEFAULT_ID, kind: "default" }), listedToken()];
    const reveal = held<typeof revealed>();
    api.reveal = () => reveal.promise;
    calls.getEnrollmentTokens.mockClear();
    await user.click(quickReveal());
    expect(await within(quickScreen()).findByRole("button", { name: "Preparing…" })).toBeDisabled();
    await act(async () => reveal.reject(new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 })));
    expect(await within(quickScreen()).findByRole("alert")).toHaveTextContent(/^This link's token was revoked: make a new link\.$/);
    expect(within(quickScreen()).queryByRole("link", { name: "Tokens tab" })).toBeNull();
    expect(within(quickScreen()).queryByText(/Issue a new one/)).toBeNull();
    expect(within(quickScreen()).queryByRole("button", { name: "Reveal & copy command" })).toBeNull();
    expect(within(quickScreen()).queryByRole("button", { name: "Preparing…" })).toBeNull();
    // The link's own token was the one revealed; the tokens read again once; nothing copied, no second reveal (B's).
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_TOKEN_ID, expect.anything());
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const done = within(quickScreen()).getByRole("button", { name: "Done" });
    await waitFor(() => expect(document.activeElement).toBe(done));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says the link's token was revoked when the tokens read again fails (the words true either way)", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.reveal = async () => {
      throw new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 });
    };
    calls.getEnrollmentTokens.mockImplementation(async () => {
      throw new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
    });
    await user.click(quickReveal());
    expect(await within(quickScreen()).findByRole("alert")).toHaveTextContent(/^This link's token was revoked: make a new link\.$/);
    expect(within(quickScreen()).queryByRole("link", { name: "Tokens tab" })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(within(quickScreen()).getByRole("button", { name: "Done" })));
  });

  // The refused reveal's re-read.
  it("keeps the button disabled while the tokens are read again: a click meanwhile sends nothing more", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.reveal = async () => {
      throw new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 });
    };
    const reread = held<{ tokens: EnrollmentTokenListed[] }>();
    calls.getEnrollmentTokens.mockClear();
    calls.getEnrollmentTokens.mockImplementation(() => reread.promise);
    await user.click(quickReveal());
    await waitFor(() => expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1));
    // The re-read held: the reveal is still "Preparing…", disabled, and a click on it sends nothing.
    const pending = within(quickScreen()).getByRole("button", { name: "Preparing…" });
    expect(pending).toBeDisabled();
    await user.click(pending);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    await act(async () =>
      reread.resolve({ tokens: [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken({ id: OTHER_DEFAULT_ID, kind: "default" })] }),
    );
    expect(await within(quickScreen()).findByRole("alert")).toHaveTextContent(/^This link's token was revoked: make a new link\.$/);
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("drops the tokens read again when they answer after Close: no words, toast or copy, and the next opening shows the form", async () => {
    const error = vi.spyOn(toast, "error");
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.reveal = async () => {
      throw new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 });
    };
    const reread = held<{ tokens: EnrollmentTokenListed[] }>();
    calls.getEnrollmentTokens.mockClear();
    calls.getEnrollmentTokens.mockImplementationOnce(() => reread.promise);
    await user.click(quickReveal());
    await waitFor(() => expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => reread.resolve({ tokens: [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" })] }));
    expect(error).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expect(document.body.innerHTML).not.toContain(BEARER);
    await user.click(screen.getByRole("button", { name: "open install" }));
    expect(await screen.findByRole("heading", { name: /^Install collectors/ })).toBeInTheDocument();
    expect(screen.queryByText(QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS)).toBeNull();
    expect(screen.queryByText("The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.")).toBeNull();
  });

  it("drops the tokens read again when they answer after an organization switch (the dialog still open): no words, no Tokens tab link, no copy", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    api.reveal = async () => {
      throw new ApiError("enrollment_token_revoked", "This token is revoked.", { status: 409 });
    };
    const reread = held<{ tokens: EnrollmentTokenListed[] }>();
    calls.getEnrollmentTokens.mockClear();
    calls.getEnrollmentTokens.mockImplementationOnce(() => reread.promise);
    await user.click(quickReveal());
    await waitFor(() => expect(calls.getEnrollmentTokens).toHaveBeenCalledTimes(1));
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await act(async () =>
      reread.resolve({ tokens: [defaultToken({ revokedAt: "2026-10-14T09:00:00.000Z" }), listedToken({ id: OTHER_DEFAULT_ID, kind: "default" })] }),
    );
    expect(screen.queryByText(QUICK_DEPLOY_LINK_TOKEN_REVOKED_WORDS)).toBeNull();
    expect(screen.queryByRole("link", { name: "Tokens tab" })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows a reveal's other failure inline on the screen, nothing copied; the button tries again", async () => {
    const { calls, user } = await onLinux();
    await madeLink(user);
    let failed = false;
    api.reveal = async () => {
      if (failed) return revealed;
      failed = true;
      throw new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
    };
    await user.click(quickReveal());
    expect(await within(quickScreen()).findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(writeText).not.toHaveBeenCalled();
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(calls.revealEnrollmentToken).toHaveBeenCalledTimes(2);
    expect(calls.createQuickDeployLink).toHaveBeenCalledTimes(1);
  });

  it('"Done" closes; reopening shows the form with the box ticked, no link and no bearer', async () => {
    const { user } = await onLinux();
    await madeLink(user);
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    await user.click(within(quickScreen()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(BEARER);
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(systemdBox()).toBeChecked();
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expect(document.body.innerHTML).not.toContain(BEARER);
  });

  it("gives the link and the command up as the dialog closes, while its content is still mounted for the exit animation", async () => {
    emulateExitAnimation();
    const { user } = await onLinux();
    await madeLink(user);
    await user.click(quickReveal());
    await within(quickScreen()).findByRole("button", { name: "Copy command" });
    expect(document.body.textContent).toContain(BEARER);
    expect(document.body.textContent).toContain(QUICK_DEPLOY_SECRET);
    await user.keyboard("{Escape}");
    // Closing, still mounted: both secrets already gone from it.
    const closing = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(document.body.innerHTML).not.toContain(BEARER);
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    // The screen's other parts stay through the animation: its title, words and masked preview, never the form.
    expectClosingQuickDeployScreen(closing);
  });

  it("gives the link up as the dialog closes before the reveal too, while its content is still mounted, the screen kept", async () => {
    emulateExitAnimation();
    const { user } = await onLinux();
    await madeLink(user);
    expect(document.body.innerHTML).toContain(QUICK_DEPLOY_MASKED_SECRET);
    await user.keyboard("{Escape}");
    const closing = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expectClosingQuickDeployScreen(closing);
    // The url has left the state: the kept screen's Reveal has nothing to reveal.
    expect(within(closing).getByRole("button", { name: "Reveal & copy command", hidden: true })).toBeDisabled();
  });

  /** The closing dialog still shows the Quick Deploy screen, its preview masked, and not the Linux form. */
  function expectClosingQuickDeployScreen(closing: HTMLElement) {
    expect(closing).toHaveTextContent(QUICK_DEPLOY_TITLE);
    expect(closing).toHaveTextContent(QUICK_DEPLOY_SYSTEMD_WORDS);
    expect(closing).toHaveTextContent(QUICK_DEPLOY_WARNING);
    expect(closing.querySelector("pre")?.textContent).toBe(
      quickDeployPreview({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", displayName: "", systemd: true }),
    );
    expect(closing.querySelector('[role="combobox"]')).toBeNull();
    expect(closing.querySelector('[role="checkbox"]')).toBeNull();
    expect(closing).not.toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);
  }

  describe("with ClipboardItem (Safari's way: the copy within the click)", () => {
    it("writes within the click, before the reveal answers, and copies the command", async () => {
      const answer = held<typeof revealed>();
      const { user } = await onLinux();
      await madeLink(user);
      const browser = clipboardItemBrowser(false);
      api.reveal = () => answer.promise;
      await user.click(quickReveal());
      expect(browser.write).toHaveBeenCalledTimes(1);
      await act(async () => answer.resolve(revealed));
      await waitFor(() => expect(browser.kept).toHaveLength(1));
      expect(browser.kept[0]).toBe(quickDeployCommands({ url: QUICK_DEPLOY_URL, rootPath: "/etc/otelcol", bearer: BEARER, displayName: "", systemd: true }));
    });

    it('tells a refused copy by its own state: the command shown, "Link made, but copying failed…"', async () => {
      const error = vi.spyOn(toast, "error");
      const success = vi.spyOn(toast, "success");
      const { user } = await onLinux();
      await madeLink(user);
      clipboardItemBrowser(true);
      await user.click(quickReveal());
      const copy = await within(quickScreen()).findByRole("button", { name: "Copy command" });
      await waitFor(() => expect(error).toHaveBeenCalledWith(QUICK_DEPLOY_COPY_FAILED_MESSAGE));
      expect(QUICK_DEPLOY_COPY_FAILED_MESSAGE).toBe("Link made, but copying failed: copy it from the box above.");
      expect(success).not.toHaveBeenCalled();
      expect(boxText(copy)).toContain(`Bearer ${BEARER}`);
      expect(within(quickScreen()).queryByRole("alert")).toBeNull();
    });
  });

  it("words the expiry of a link that never expires", () => {
    expect(quickDeployExpiryWords(null)).toBe("This command is shown only now. It never expires; revoke it under Install links on the Tokens tab.");
    expect(quickDeployExpiryWords(quickDeployLink().expiresAt)).toBe(
      `This command is shown only now. It expires ${formatDateTime("2026-10-18T09:00:00.000Z")}; extend or revoke it under Install links on the Tokens tab.`,
    );
  });
});

// The bearer only inside ph-no-capture; names, paths and values in no attribute but an input's own value inside it.
// The organization's "Public install links" switch.
describe("InstallDialog with public install links off", () => {
  it("reads the settings with the facts and the tokens; while off, no Quick Deploy and no systemd box: the words, and Download offered", async () => {
    api.settings = () => ({ publicInstallLinks: false });
    const calls = serve();
    const user = await renderDialog();
    await loaded();
    expect(calls.getOrganizationSettings).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(within(dialog()).queryByRole("button", { name: "Quick Deploy" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: SYSTEMD_LABEL })).toBeNull();
    expect(dialog()).toHaveTextContent(PUBLIC_INSTALL_LINKS_OFF_WORDS);
    expect(dialog()).not.toHaveTextContent(DOWNLOAD_NEEDS_UNTICK_WORDS);
    const downloadButton = within(dialog()).getByRole("button", { name: "Download" });
    expect(downloadButton).toBeEnabled();
    await user.click(downloadButton);
    expect(await screen.findByRole("dialog", { name: "Set the token, then run" })).toBeInTheDocument();
    expect(calls.downloadInstallBundle).toHaveBeenCalledTimes(1);
    expect(calls.createQuickDeployLink).not.toHaveBeenCalled();
  });

  it("counts a failed settings read as on: Quick Deploy and the systemd box offered", async () => {
    api.settings = () => {
      throw new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    expect(within(dialog()).getByRole("button", { name: "Quick Deploy" })).toBeEnabled();
    expect(systemdBox()).toBeChecked();
  });

  it("turns Quick Deploy and the systemd box off at once on a create answered public_install_links_disabled, Download then offered", async () => {
    api.create = async () => {
      throw new ApiError("public_install_links_disabled", QUICK_DEPLOY_LINK_ERROR_MESSAGES.public_install_links_disabled, { status: 409 });
    };
    serve();
    const user = await renderDialog();
    await loaded();
    await chooseMethod(user, "Linux All In One (amd64)");
    await user.click(within(dialog()).getByRole("button", { name: "Quick Deploy" }));
    await waitFor(() => expect(within(dialog()).queryByRole("button", { name: "Quick Deploy" })).toBeNull());
    expect(dialog()).toHaveTextContent(PUBLIC_INSTALL_LINKS_OFF_WORDS);
    expect(screen.queryByRole("checkbox", { name: SYSTEMD_LABEL })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Download" })).toBeEnabled();
  });
});

describe("InstallDialog's privacy", () => {
  /**
   * `text` shown (some text node holds it) only inside ph-no-capture under
   * `root`; its attributes are `attributesHoldingBeyondInputs`' (a typed
   * value is its input's own `value`).
   */
  function textOnlyInsideNoCapture(text: string, root: Element) {
    let holding = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node.textContent ?? "").includes(text)) continue;
      holding += 1;
      expect(node.parentElement?.closest(".ph-no-capture") ?? null, `a text node holding ${text}`).not.toBeNull();
    }
    const outside = root.cloneNode(true) as Element;
    for (const each of outside.querySelectorAll(".ph-no-capture")) each.remove();
    expect(outside.textContent ?? "", `${text} outside ph-no-capture`).not.toContain(text);
    expect(holding, `text nodes holding ${text}`).toBeGreaterThan(0);
  }

  /** Each attribute holding `text`, but an INPUT's `value` inside ph-no-capture. */
  function attributesHoldingBeyondInputs(text: string): string[] {
    const holders: string[] = [];
    for (const element of [document.documentElement, ...document.documentElement.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        if (!attribute.value.includes(text)) continue;
        if (attribute.name === "value" && element.tagName === "INPUT" && element.closest(".ph-no-capture") !== null) continue;
        holders.push(`${element.tagName} ${attribute.name}`);
      }
    }
    return holders;
  }

  it("holds no group, configuration, variable name or value, display name, path, bearer or link secret in an attribute, and the bearer and the secret only in ph-no-capture, through the download and Quick Deploy", async () => {
    const groupName = "canary-group-1a2b";
    const configurationName = "canary-configuration-3c4d";
    const envName = "CANARY_ENV_5E6F";
    const envValue = "canary-value-7a8b";
    const displayName = "canary-name-9c0d";
    const rootPath = "/canary-root-1e2f";
    const executablePath = "/canary-exe-3a4b/otelcol";
    const hostPath = "/canary-host-5c6d";
    const containerPath = "/canary-container-7e8f";
    api.groups = [collectorGroup(), gatewaysGroup({ name: groupName, assignedVersion: publishedVersion({ configurationName }) })];
    api.facts = () => installFacts({ envVarNames: [envName], mounts: [{ hostPath, containerPath, readOnly: true }] });
    serve();
    const user = await renderDialog();
    await loaded();
    const canaries = [groupName, configurationName, envName, envValue, displayName, rootPath, executablePath, hostPath, containerPath, BEARER, QUICK_DEPLOY_SECRET];
    const check = () => {
      for (const text of canaries) expect(attributesHoldingBeyondInputs(text), text).toEqual([]);
    };
    expect(dialog()).toHaveTextContent(groupName);
    expect(dialog()).toHaveTextContent(configurationName);

    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), displayName);
    await user.click(screen.getByRole("checkbox", { name: `Include ${envName}` }));
    await user.type(screen.getByRole("textbox", { name: envName }), envValue);
    check();
    // The preview holds the name, the value and the paths: inside ph-no-capture.
    for (const text of [envName, envValue, displayName, hostPath, containerPath]) textOnlyInsideNoCapture(text, dialog());

    await user.click(revealButton());
    await within(dialog()).findByRole("button", { name: "Copy command" });
    check();
    expectTextOnlyInsideNoCapture(BEARER);
    for (const text of [envName, envValue, displayName, hostPath, containerPath]) textOnlyInsideNoCapture(text, dialog());

    await chooseMethod(user, "Linux with your own otelcol-contrib (amd64)");
    await untickSystemd(user);
    const root = screen.getByRole("textbox", { name: "Root path" });
    await user.clear(root);
    await user.type(root, rootPath);
    const executable = screen.getByRole("textbox", { name: "Path to otelcol-contrib" });
    await user.clear(executable);
    await user.type(executable, executablePath);
    check();
    // The executable path is its input's value alone; the root path is in the hint too.
    for (const text of [rootPath, envName]) textOnlyInsideNoCapture(text, dialog());

    await user.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("dialog", { name: "Set the token, then run" });
    check();
    expectTextOnlyInsideNoCapture(BEARER);
    textOnlyInsideNoCapture(rootPath, dialog());
    expect(document.title).not.toContain(groupName);

    // Quick Deploy: reopened, the same fields typed, the link made, then revealed.
    api.create = async () =>
      quickDeployLinkCreated({ groupName, choices: { method: "own-binary", arch: "amd64", rootPath, executablePath, systemd: true, envNames: [envName] } });
    await user.click(within(dialog()).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "open install" }));
    await loaded();
    await chooseMethod(user, "Linux with your own otelcol-contrib (amd64)");
    await user.clear(screen.getByRole("textbox", { name: "Root path" }));
    await user.type(screen.getByRole("textbox", { name: "Root path" }), rootPath);
    await user.clear(screen.getByRole("textbox", { name: "Path to otelcol-contrib" }));
    await user.type(screen.getByRole("textbox", { name: "Path to otelcol-contrib" }), executablePath);
    await user.type(screen.getByRole("textbox", { name: "Collector display name (optional)" }), displayName);
    await user.click(screen.getByRole("checkbox", { name: `Include ${envName}` }));
    await user.type(screen.getByRole("textbox", { name: envName }), envValue);
    check();
    await user.click(screen.getByRole("button", { name: "Quick Deploy" }));
    const quick = await screen.findByRole("dialog", { name: "Quick Deploy command ready" });
    check();
    // The preview holds the root path and the display name, inside ph-no-capture; neither secret.
    for (const text of [rootPath, displayName]) textOnlyInsideNoCapture(text, quick);
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expect(document.body.innerHTML).not.toContain(BEARER);

    await user.click(within(quick).getByRole("button", { name: "Reveal & copy command" }));
    await within(quick).findByRole("button", { name: "Copy command" });
    check();
    expectTextOnlyInsideNoCapture(BEARER);
    expectTextOnlyInsideNoCapture(QUICK_DEPLOY_SECRET);
    // Autocapture records a clicked link's href even when masked: neither the link nor the command is ever an href.
    for (const anchor of document.querySelectorAll("a[href]")) {
      expect(anchor.getAttribute("href")).not.toContain(QUICK_DEPLOY_SECRET);
      expect(anchor.getAttribute("href")).not.toContain("/quick-deploy/");
    }
    for (const text of [rootPath, displayName]) textOnlyInsideNoCapture(text, quick);
    expect(document.title).not.toContain(groupName);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(QUICK_DEPLOY_SECRET);
    expect(document.body.innerHTML).not.toContain(BEARER);
  });
});
