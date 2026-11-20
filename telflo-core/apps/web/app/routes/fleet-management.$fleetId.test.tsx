import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEETS_UNAVAILABLE_MESSAGE, type CurrentUserResponse, type FleetDetail } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import FleetRoute, { meta, parseTab } from "./fleet-management.$fleetId.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import * as download from "~/lib/download.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember, THEIRS } from "~/test/configurations.js";
import {
  attributesHolding,
  clusterGroup,
  collector,
  collectorGroup,
  collectorsPage,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DEFAULT_GROUP_ID,
  DEFAULT_TOKEN_ID,
  EMPTY_SUMMARY,
  expectNoAttributeHolds,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  helmInstallFacts,
  installFacts,
  kubernetesAnnotations,
  fleet,
  fleetDetail,
  listedToken,
  manyCollectors,
  populatedSummary,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  quickDeployLinksPage,
  tokenEventsPage,
  VERSION_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { Toaster } from "~/components/ui/sonner.js";
import { SUSPENDED_BANNER, TOKEN_BANNER_LABEL } from "~/components/fleets/TokenBanner.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

/*
 * A fleet's page: its header, its tabs in `?tab=`, "Fleet not found", the poll
 * the header follows, and the rename, archive and delete dialogs opened from
 * it; a server fleet's stats strip and Collectors tab, whose own tests are
 * CollectorsTab's and StatsStrip's. Every server fleet's page mounts the tab,
 * so each test's fleet has no collectors unless it says otherwise.
 */

/** Where the page is: its path and query, and a Back (the browser's). */
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
    </>
  );
}

/** A fleet's page under the signed-in layout, as the app routes it, at `path`; the list's route says where a delete went. */
function renderPage(path = `/fleet-management/${FLEET_ID}`, currentUser: CurrentUserResponse = signedInMember(GROUP_ID), entries: string[] = []) {
  const layoutLoader = vi.fn((): AppLayoutData => ({ status: "signed_in", currentUser }));
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: layoutLoader,
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        {
          path: "/fleet-management",
          Component: () => (
            <>
              <p>landed on the list</p>
              <Where />
            </>
          ),
        },
        {
          path: "/fleet-management/:fleetId",
          Component: () => (
            <>
              <FleetRoute />
              <Where />
            </>
          ),
        },
      ],
    },
  ]);
  render(<Stub initialEntries={[...entries, path]} />);
  return { layoutLoader, user: userEvent.setup() };
}

type Reader = (organizationId: string, fleetId: string) => FleetDetail | Promise<FleetDetail>;

/** The API's read of one fleet, answered by `answer`. */
function serveFleet(answer: Reader) {
  return vi.spyOn(apiClient, "getFleet").mockImplementation(async (organizationId, fleetId) => answer(organizationId, fleetId));
}

const where = () => screen.getByTestId("where").textContent;
const GONE = () => new ApiError("fleet_not_found", "Fleet not found", { status: 404 });
const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });

async function heading(label = "edge-prod") {
  return screen.findByRole("heading", { level: 1, name: label });
}

describe("a fleet's page (/fleet-management/{fleetId})", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    serveNoVariables();
    vi.spyOn(apiClient, "getCollectors").mockResolvedValue(collectorsPage([]));
    vi.spyOn(apiClient, "getCollectorGroups").mockResolvedValue({ groups: [collectorGroup()] });
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }), listedToken()] });
    vi.spyOn(apiClient, "getEnrollmentTokenEvents").mockResolvedValue(tokenEventsPage([]));
    vi.spyOn(apiClient, "getQuickDeployLinks").mockResolvedValue(quickDeployLinksPage([]));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  it("is /fleet-management/:fleetId under the signed-in layout, one route for every type of fleet", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    expect(layout?.children?.find((route) => route.path === "fleet-management/:fleetId")?.file).toBe(
      "routes/fleet-management.$fleetId.tsx",
    );
  });

  it("has a fixed title, never the fleet's label", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([{ title: "Fleet - Telflo" }]);
  });

  it.each([
    ["server", "active", "Supervisor", "Active", "Archive"],
    ["server", "archived", "Supervisor", "Archived", "Unarchive"],
    ["kubernetes-supervisor", "active", "K8s Supervisor", "Active", "Archive"],
    ["kubernetes-supervisor", "archived", "K8s Supervisor", "Archived", "Unarchive"],
  ] as const)("shows a %s fleet that is %s: the back link, the label, its type, badge, Created and actions", async (type, status, typeWords, badge, statusAction) => {
    const getFleet = serveFleet(() => fleetDetail({ type, status }));
    renderPage();

    expect(await heading()).toBeInTheDocument();
    expect(getFleet).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("link", { name: "Fleets" })).toHaveAttribute("href", "/fleet-management");
    expect(screen.getByText(typeWords)).toBeInTheDocument();
    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();
    for (const action of ["Rename", statusAction, "Delete"]) {
      expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    }
  });

  describe("its tabs, in ?tab=", () => {
    it.each([
      ["no tab", "", "Collectors", "Install your first collector"],
      ["?tab=collectors", "?tab=collectors", "Collectors", "Install your first collector"],
      ["?tab=groups", "?tab=groups", "Groups", "Nothing assigned"],
      ["?tab=tokens", "?tab=tokens", "Tokens", "Fleet tokens"],
    ])("opens %s on %s: a server fleet's collectors (an empty fleet's install state), its groups (Default's Nothing assigned), its tokens (Fleet tokens)", async (_why, query, tab, shown) => {
      const getCollectors = vi.mocked(apiClient.getCollectors);
      const getEnrollmentTokens = vi.mocked(apiClient.getEnrollmentTokens);
      serveFleet(() => fleetDetail());
      renderPage(`/fleet-management/${FLEET_ID}${query}`);
      await heading();

      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      expect(screen.getAllByRole("tab").map((each) => each.textContent)).toEqual(["Collectors", "Groups", "Tokens"]);
      expect(await within(screen.getByRole("tabpanel")).findByText(shown)).toBeInTheDocument();
      expect(where()).toBe(`/fleet-management/${FLEET_ID}${query}`);
      // The tab's reads run only while it is chosen (Radix Tabs unmounts the others).
      if (tab === "Collectors") expect(getCollectors).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything(), expect.anything());
      else expect(getCollectors).not.toHaveBeenCalled();
      if (tab === "Tokens") {
        expect(getEnrollmentTokens).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
        expect(apiClient.getEnrollmentTokenEvents).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
        expect(apiClient.getQuickDeployLinks).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
      } else {
        expect(getEnrollmentTokens).not.toHaveBeenCalled();
        expect(apiClient.getEnrollmentTokenEvents).not.toHaveBeenCalled();
        expect(apiClient.getQuickDeployLinks).not.toHaveBeenCalled();
      }
    });

    // A Kubernetes-supervisor fleet's tabs are its own, never "Not available yet.".
    it.each([
      ["no tab", "", "Collectors"],
      ["?tab=groups", "?tab=groups", "Groups"],
      ["?tab=tokens", "?tab=tokens", "Tokens"],
    ])("opens a Kubernetes-supervisor fleet's %s with the stats strip, its own reads, and its Helm install", async (_why, query, tab) => {
      vi.mocked(apiClient.getCollectors).mockResolvedValue(collectorsPage([collector({ name: "agent-pod" })]));
      vi.mocked(apiClient.getCollectorGroups).mockResolvedValue({ groups: [collectorGroup(), gatewaysGroup()] });
      serveFleet(() => fleetDetail({ type: "kubernetes-supervisor", summary: populatedSummary(Date.now()) }));
      renderPage(`/fleet-management/${FLEET_ID}${query}`);
      await heading();

      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      expect(screen.getAllByRole("tab").map((each) => each.textContent)).toEqual(["Collectors", "Groups", "Tokens"]);
      const panel = screen.getByRole("tabpanel");
      expect(screen.getByText("Version drift")).toBeInTheDocument();
      expect(screen.getByText("Token expires")).toBeInTheDocument();
      if (tab === "Collectors") {
        // The grid's one Group column: the Default group's collector is the Agent's, its badge alone.
        expect(await within(panel).findByRole("button", { name: "agent-pod" })).toBeInTheDocument();
        expect(within(panel).queryByRole("columnheader", { name: "Role" })).toBeNull();
        const groupColumn = within(panel).getAllByRole("columnheader").findIndex((header) => header.textContent === "Group");
        expect(within(panel).getAllByRole("row")[1]!.querySelectorAll("td")[groupColumn]).toHaveTextContent(/^Agent$/);
        expect(apiClient.getCollectors).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything(), expect.anything());
      } else {
        expect(apiClient.getCollectors).not.toHaveBeenCalled();
      }
      if (tab === "Groups") {
        // Its own Groups tab: the Agent, the Cluster before its group exists, then the gateways (one Group column).
        await waitFor(() =>
          expect(
            within(panel)
              .getAllByRole("row")
              .slice(1)
              .map((row) => row.querySelector("td")?.textContent),
          ).toEqual(["Agent", "Cluster", "Gateway gateways"]),
        );
        expect(within(panel).getByRole("button", { name: "Add gateway" })).toBeInTheDocument();
        expect(within(panel).getByRole("button", { name: "Delete gateways" })).toBeInTheDocument();
        expect(panel).not.toHaveTextContent("Default");
        expect(apiClient.getCollectorGroups).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
      }
      if (tab === "Tokens") {
        expect(await within(panel).findByText("Fleet tokens")).toBeInTheDocument();
        expect(apiClient.getEnrollmentTokens).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
        expect(apiClient.getEnrollmentTokenEvents).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
        // Install links shown on a Kubernetes fleet too, in its words.
        expect(apiClient.getQuickDeployLinks).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
        expect(await within(panel).findByRole("heading", { name: "Install links" })).toBeInTheDocument();
        expect(panel).toHaveTextContent("Links appear here when you make a Quick Deploy command in the Helm install dialog.");
      } else {
        expect(apiClient.getEnrollmentTokens).not.toHaveBeenCalled();
      }
      expect(screen.queryByText("Not available yet.")).toBeNull();
      // An active Kubernetes fleet installs with Helm; with collectors, Setup guide reopens its checklist.
      expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
      expect(screen.getByRole("button", { name: "Install with Helm" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Setup guide" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Fleet setup" })).toBeNull();
      expect(screen.queryByText("Install your first collector")).toBeNull();
    });

    it("opens a server fleet's Groups tab with its groups by name, a group named cluster among them (no Kubernetes rows)", async () => {
      vi.mocked(apiClient.getCollectorGroups).mockResolvedValue({ groups: [collectorGroup(), clusterGroup()] });
      serveFleet(() => fleetDetail());
      renderPage(`/fleet-management/${FLEET_ID}?tab=groups`);
      await heading();
      const panel = screen.getByRole("tabpanel");
      expect(await within(panel).findByText("cluster")).toBeInTheDocument();
      expect(within(panel).getAllByText("Default").length).toBeGreaterThan(0);
      expect(within(panel).queryByText("Agent")).toBeNull();
      expect(within(panel).getByRole("button", { name: "New group" })).toBeInTheDocument();
    });

    it("links the strip's Token tile to the Tokens tab: a new entry, the tab chosen and its tokens read", async () => {
      serveFleet(() => fleetDetail({ summary: populatedSummary(Date.now()) }));
      const { user } = renderPage();
      await heading();
      const strip = screen.getByText("Version drift").closest("div.grid") as HTMLElement;
      const tile = within(strip).getByRole("link", { name: /d left Rotating → \(open the Tokens tab\)$/ });
      expect(tile).toHaveAttribute("href", `/fleet-management/${FLEET_ID}?tab=tokens`);

      await user.click(tile);
      await waitFor(() => expect(where()).toBe(`/fleet-management/${FLEET_ID}?tab=tokens`));
      expect(screen.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");
      expect(await within(screen.getByRole("tabpanel")).findByText("Fleet tokens")).toBeInTheDocument();
      expect(apiClient.getEnrollmentTokens).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
      // A new entry: Back returns to the page as it opened.
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(where()).toBe(`/fleet-management/${FLEET_ID}`));
    });

    it("shows a server fleet's stats strip between the header and the tabs, on every tab", async () => {
      serveFleet(() => fleetDetail({ summary: populatedSummary(Date.now()) }));
      const { user } = renderPage();
      const title = await heading();

      const strip = screen.getByText("Version drift").closest("div.grid") as HTMLElement;
      expect(within(strip).getAllByText(/^(Collectors|Online|Version drift|Token expires)$/).map((each) => each.textContent)).toEqual([
        "Collectors",
        "Online",
        "Version drift",
        "Token expires",
      ]);
      const tabs = screen.getByRole("tablist");
      expect(title.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(strip.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await user.click(screen.getByRole("tab", { name: "Tokens" }));
      await waitFor(() => expect(where()).toBe(`/fleet-management/${FLEET_ID}?tab=tokens`));
      expect(screen.getByText("Version drift")).toBeInTheDocument();
    });

    // Choosing a tab navigates, which commits after the layout's revalidation: each check after one waits for it.
    const selected = (name: string) => expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    const at = (query: string) => expect(where()).toBe(`/fleet-management/${FLEET_ID}${query}`);

    it("sets ?tab= for Groups and Tokens and deletes it for Collectors, each a new entry Back returns from", async () => {
      serveFleet(() => fleetDetail());
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("tab", { name: "Groups" }));
      await waitFor(() => {
        at("?tab=groups");
        selected("Groups");
      });
      await user.click(screen.getByRole("tab", { name: "Tokens" }));
      await waitFor(() => {
        at("?tab=tokens");
        selected("Tokens");
      });
      await user.click(screen.getByRole("tab", { name: "Collectors" }));
      await waitFor(() => {
        at("");
        selected("Collectors");
      });

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => {
        at("?tab=tokens");
        selected("Tokens");
      });
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => {
        at("?tab=groups");
        selected("Groups");
      });
    });

    it("navigates once per click (one layout revalidation, one entry): Back returns to the tab before", async () => {
      serveFleet(() => fleetDetail());
      const { user, layoutLoader } = renderPage();
      await heading();
      const loads = layoutLoader.mock.calls.length;

      await user.click(screen.getByRole("tab", { name: "Groups" }));
      await waitFor(() => {
        at("?tab=groups");
        selected("Groups");
      });
      expect(layoutLoader).toHaveBeenCalledTimes(loads + 1);

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => {
        at("");
        selected("Collectors");
      });
    });

    it("moves the focus with the arrow keys without choosing; Enter and Space choose, one entry each", async () => {
      serveFleet(() => fleetDetail());
      const { user } = renderPage();
      await heading();

      act(() => screen.getByRole("tab", { name: "Collectors" }).focus());
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: "Groups" })).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: "Tokens" })).toHaveFocus();
      await user.keyboard("{Enter}");
      await waitFor(() => {
        at("?tab=tokens");
        selected("Tokens");
      });
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("tab", { name: "Groups" })).toHaveFocus();
      await user.keyboard(" ");
      await waitFor(() => {
        at("?tab=groups");
        selected("Groups");
      });

      // Only the chosen tabs made entries: Tokens, then the page as it opened.
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => {
        at("?tab=tokens");
        selected("Tokens");
      });
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => {
        at("");
        selected("Collectors");
      });
    });

    it("drops an unknown ?tab= once, replacing the entry, and shows Collectors; the page's other params stay", async () => {
      const getFleet = serveFleet(() => fleetDetail());
      const { user } = renderPage(`/fleet-management/${FLEET_ID}?tab=settings&from=list`, signedInMember(GROUP_ID), ["/fleet-management"]);
      await heading();

      await waitFor(() => expect(where()).toBe(`/fleet-management/${FLEET_ID}?from=list`));
      expect(screen.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");
      // Replaced, not pushed: Back leaves the page.
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(await screen.findByText("landed on the list")).toBeInTheDocument();
      expect(getFleet).toHaveBeenCalledTimes(1);
    });

    it("reads Groups and Tokens as themselves and anything else as Collectors", () => {
      expect(parseTab(null)).toBe("collectors");
      expect(parseTab("groups")).toBe("groups");
      expect(parseTab("tokens")).toBe("tokens");
      expect(parseTab("collectors")).toBe("collectors");
      expect(parseTab("Tokens")).toBe("collectors");
      expect(parseTab("")).toBe("collectors");
    });
  });

  describe('"Fleet not found"', () => {
    it("for a fleet the API answers 404, with the back link", async () => {
      serveFleet(() => {
        throw GONE();
      });
      renderPage();

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      expect(screen.getByText("It may have been deleted, or you may not have access.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fleets" })).toHaveAttribute("href", "/fleet-management");
      expect(screen.queryByRole("tab")).toBeNull();
    });

    it.each(["not-a-uuid", "..", "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8", `${FLEET_ID}x`])(
      "for an id that isn't a UUID (%s), with no request",
      async (id) => {
        const getFleet = serveFleet(() => fleetDetail());
        renderPage(`/fleet-management/${encodeURIComponent(id)}`);

        expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
        expect(getFleet).not.toHaveBeenCalled();
      },
    );

    it("for a fleet deleted while the page is open: a poll's 404", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      let deleted = false;
      const getFleet = serveFleet(() => {
        if (deleted) throw GONE();
        return fleetDetail();
      });
      renderPage();
      expect(await heading()).toBeInTheDocument();

      deleted = true;
      await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      expect(getFleet).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("heading", { level: 1, name: "edge-prod" })).toBeNull();
    });
  });

  it("shows a failed first read with Try again, which reads again", async () => {
    let failing = true;
    serveFleet(() => {
      if (failing) throw UNAVAILABLE();
      return fleetDetail();
    });
    const { user } = renderPage();

    expect(await screen.findByText("Failed to load fleet")).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await heading()).toBeInTheDocument();
  });

  it("follows its poll: a rename and an archive made elsewhere show within one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    let changed = false;
    serveFleet(() => (changed ? fleetDetail({ label: "edge-renamed", status: "archived" }) : fleetDetail()));
    renderPage();
    expect(await heading()).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();

    changed = true;
    await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));

    expect(await heading("edge-renamed")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
  });

  it("renames from the header, trimmed, then reads the fleet again", async () => {
    let label = "edge-prod";
    const getFleet = serveFleet(() => fleetDetail({ label }));
    const update = vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
      label = request.label!;
      return fleet({ label });
    });
    const { user } = renderPage();
    await heading();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, " edge-renamed ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await heading("edge-renamed")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { label: "edge-renamed" }, expect.anything());
    expect(getFleet).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("archives and unarchives from the header, the badge following each read after", async () => {
    let status: "active" | "archived" = "active";
    const getFleet = serveFleet(() => fleetDetail({ status }));
    const update = vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
      status = request.status!;
      return fleet({ status });
    });
    const { user } = renderPage();
    await heading();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Archive fleet" })).getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Archived")).toBeInTheDocument();
    expect(update).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { status: "archived" }, expect.anything());
    expect(getFleet).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Unarchive fleet" })).getByRole("button", { name: "Unarchive" }));
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(update).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { status: "active" }, expect.anything());
    expect(getFleet).toHaveBeenCalledTimes(3);
  });

  // The header's dialogs have no Radix trigger.
  describe("the focus as a header's dialog closes", () => {
    const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));

    it.each([
      ["Rename", "dialog", "Escape"],
      ["Rename", "dialog", "Cancel"],
      ["Archive", "alertdialog", "Escape"],
      ["Archive", "alertdialog", "Cancel"],
      ["Delete", "alertdialog", "Escape"],
      ["Delete", "alertdialog", "Cancel"],
    ] as const)("returns to %s after its %s closes by %s", async (name, role, how) => {
      serveFleet(() => fleetDetail());
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name }));
      const dialog = await screen.findByRole(role);
      if (how === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
      await focusIsOn(() => screen.getByRole("button", { name }));
    });

    it("returns to Rename after a rename, and to the status button after an archive, now Unarchive", async () => {
      let label = "edge-prod";
      let status: "active" | "archived" = "active";
      serveFleet(() => fleetDetail({ label, status }));
      vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
        label = request.label ?? label;
        status = request.status ?? status;
        return fleet({ label, status });
      });
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name: "Rename" }));
      const name = await screen.findByLabelText("Name");
      await user.clear(name);
      await user.type(name, "edge-renamed");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await heading("edge-renamed");
      await focusIsOn(() => screen.getByRole("button", { name: "Rename" }));

      await user.click(screen.getByRole("button", { name: "Archive" }));
      await user.click(within(await screen.findByRole("alertdialog", { name: "Archive fleet" })).getByRole("button", { name: "Archive" }));
      expect(await screen.findByText("Archived")).toBeInTheDocument();
      await focusIsOn(() => screen.getByRole("button", { name: "Unarchive" }));
    });
  });

  // The follow-up: the page swapped to "Fleet not found" takes the focus
  // with its content; it goes to the back link "Fleets", never left on the
  // page, and never moved from where the person has put it.
  describe('the focus as the page turns to "Fleet not found"', () => {
    const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
    const backLink = () => screen.getByRole("link", { name: "Fleets" });

    it("goes to the back link after a rename finds the fleet gone (its 404, then the read's)", async () => {
      let gone = false;
      serveFleet(() => {
        if (gone) throw GONE();
        return fleetDetail();
      });
      vi.spyOn(apiClient, "updateFleet").mockImplementation(async () => {
        gone = true;
        throw GONE();
      });
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name: "Rename" }));
      const name = await screen.findByLabelText("Name");
      await user.type(name, "-x");
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await focusIsOn(backLink);
    });

    it("goes to the back link after a delete's unknown outcome, the fleet gone by the read again", async () => {
      let finished = false;
      serveFleet(() => {
        if (finished) throw GONE();
        return fleetDetail();
      });
      vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
        finished = true;
        throw UNAVAILABLE();
      });
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await focusIsOn(backLink);
    });

    it("goes to the back link when the Collectors tab finds the fleet gone (onFleetGone)", async () => {
      let gone = false;
      serveFleet(() => {
        if (gone) throw GONE();
        return fleetDetail();
      });
      vi.spyOn(apiClient, "getCollectors").mockImplementation(async () => {
        if (gone) throw GONE();
        return collectorsPage(manyCollectors(2));
      });
      const { user } = renderPage();
      await heading();
      await screen.findByRole("button", { name: "collector-001" });
      gone = true;

      await user.click(screen.getByRole("button", { name: "Refresh collectors" }));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await focusIsOn(backLink);
    });

    // The Groups and Tokens tabs' onFleetGone is the route's read again too.
    it.each([
      ["Groups", "groups", "getCollectorGroups", "Assign Default", "Refresh groups"],
      ["Tokens", "tokens", "getEnrollmentTokens", "Reveal the default token", "Refresh tokens"],
    ] as const)("goes to the back link when the %s tab finds the fleet gone (onFleetGone)", async (_tab, query, read, shown, refresh) => {
      let gone = false;
      serveFleet(() => {
        if (gone) throw GONE();
        return fleetDetail();
      });
      const answer = read === "getCollectorGroups" ? { groups: [collectorGroup()] } : { tokens: [listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }), listedToken()] };
      vi.spyOn(apiClient, read).mockImplementation((async () => {
        if (gone) throw GONE();
        return answer;
      }) as never);
      const { user } = renderPage(`/fleet-management/${FLEET_ID}?tab=${query}`);
      await heading();
      await screen.findByRole("button", { name: shown });
      gone = true;

      await user.click(screen.getByRole("button", { name: refresh }));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await focusIsOn(backLink);
    });

    it("goes to the back link when the read answers after the rename's close gave the focus back to Rename", async () => {
      let held: Promise<FleetDetail> | null = null;
      let release!: () => void;
      serveFleet(() => held ?? fleetDetail());
      vi.spyOn(apiClient, "updateFleet").mockImplementation(async () => {
        held = new Promise<FleetDetail>((_resolve, reject) => (release = () => reject(GONE())));
        throw GONE();
      });
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name: "Rename" }));
      await user.type(await screen.findByLabelText("Name"), "-x");
      await user.click(screen.getByRole("button", { name: "Save" }));
      // Closed, the read held: back on Rename, the header still shown.
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await focusIsOn(() => screen.getByRole("button", { name: "Rename" }));

      await act(async () => release());
      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await focusIsOn(backLink);
    });

    // Only a page shown, then gone, gives the focus away (`wasShown`); a direct load never moves it.
    it('leaves the focus on the body when a direct load answers "Fleet not found"', async () => {
      serveFleet(() => {
        throw GONE();
      });
      renderPage();

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await act(async () => undefined);
      expect(backLink()).toBeInTheDocument();
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves the focus where the person put it meanwhile, outside the page", async () => {
      let held: Promise<FleetDetail> | null = null;
      let release!: () => void;
      serveFleet(() => held ?? fleetDetail());
      vi.spyOn(apiClient, "updateFleet").mockImplementation(async () => {
        held = new Promise<FleetDetail>((_resolve, reject) => (release = () => reject(GONE())));
        throw GONE();
      });
      const { user } = renderPage();
      await heading();

      await user.click(screen.getByRole("button", { name: "Rename" }));
      await user.type(await screen.findByLabelText("Name"), "-x");
      await user.click(screen.getByRole("button", { name: "Save" }));
      // Closed, the read held: back on Rename; the person moves on.
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await focusIsOn(() => screen.getByRole("button", { name: "Rename" }));
      act(() => screen.getByRole("button", { name: "Back" }).focus());

      await act(async () => release());
      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      await act(async () => undefined);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
    });
  });

  it("deletes from the header and goes to the list, replacing the entry: Back doesn't return to the deleted fleet", async () => {
    let deleted = false;
    serveFleet(() => {
      if (deleted) throw GONE();
      return fleetDetail();
    });
    const deleteFleet = vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
      deleted = true;
    });
    const success = vi.spyOn(toast, "success");
    const { user } = renderPage(`/fleet-management/${FLEET_ID}`, signedInMember(GROUP_ID), ["/fleet-management?from=start"]);
    await heading();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

    expect(await screen.findByText("landed on the list")).toBeInTheDocument();
    expect(where()).toBe("/fleet-management");
    expect(deleteFleet).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
    expect(success).toHaveBeenCalledWith("Deleted fleet edge-prod");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(where()).toBe("/fleet-management?from=start"));
    expect(screen.queryByRole("heading", { name: "Fleet not found" })).toBeNull();
  });

  it("counts a delete's 404 as deleted: toasts the API's message and goes to the list", async () => {
    serveFleet(() => fleetDetail());
    vi.spyOn(apiClient, "deleteFleet").mockRejectedValue(GONE());
    const error = vi.spyOn(toast, "error");
    const { user } = renderPage();
    await heading();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

    expect(await screen.findByText("landed on the list")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Fleet not found");
  });

  it("on a delete's 503, toasts it, closes and reads the fleet again: \"Fleet not found\" once the delete finished", async () => {
    let finished = false;
    const getFleet = serveFleet(() => {
      if (finished) throw GONE();
      return fleetDetail();
    });
    vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
      // The opamp-server finishes after the API's 25 s.
      finished = true;
      throw UNAVAILABLE();
    });
    const error = vi.spyOn(toast, "error");
    const { user } = renderPage();
    await heading();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

    expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
    expect(getFleet).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("landed on the list")).toBeNull();
  });

  it("holds the label in no attribute with the dialogs closed; with Rename open, only the Name's value", async () => {
    const canary = "canary-label-41d9";
    serveFleet(() => fleetDetail({ label: canary, summary: populatedSummary(Date.now()) }));
    const { user } = renderPage();
    expect(await heading(canary)).toBeInTheDocument();
    expect(document.body.textContent).toContain(canary);
    expectNoAttributeHolds(canary);

    // Archive and Delete name it as text only.
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("alertdialog", { name: "Archive fleet" });
    expectNoAttributeHolds(canary);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog", { name: "Delete fleet" });
    expectNoAttributeHolds(canary);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // The open rename dialog's Name holds it in its value attribute (React writes a controlled input's), and nothing else does.
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const name = await screen.findByLabelText("Name");
    expect(attributesHolding(canary)).toEqual(["INPUT value"]);
    expect(name).toHaveAttribute("value", canary);
  });

  // The label canary with an archived fleet's Unarchive open, and after the
  // delete's toast (the root's Toaster, mounted beside the page), on the list
  // the delete goes to.
  it("holds the label in no attribute with Unarchive open, nor in the delete's toast", async () => {
    const canary = "canary-label-c05e";
    let deleted = false;
    serveFleet(() => {
      if (deleted) throw GONE();
      return fleetDetail({ label: canary, status: "archived" });
    });
    vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
      deleted = true;
    });
    render(<Toaster theme="dark" />);
    const { user } = renderPage();
    expect(await heading(canary)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(await screen.findByRole("alertdialog", { name: "Unarchive fleet" })).toHaveTextContent(`Unarchive ${canary}?`);
    expectNoAttributeHolds(canary);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete fleet" }));
    expect(await screen.findByText("landed on the list")).toBeInTheDocument();
    expect(await screen.findByText(`Deleted fleet ${canary}`)).toBeInTheDocument();
    expectNoAttributeHolds(canary);
  });

  // The tab's onFleetChanged and onFleetGone are the route's read.reload, so
  // the strip and the total follow a collector's write at once, not at the
  // next poll.
  describe("the fleet read again after the Collectors tab's writes", () => {
    /** The fleet's API: its collectors, and the summary counting them. */
    function serveCollectorsAndFleet(count: number) {
      let rows = manyCollectors(count);
      const getFleet = serveFleet(() => fleetDetail({ summary: { ...fleetDetail().summary, collectors: rows.length } }));
      vi.spyOn(apiClient, "getCollectors").mockImplementation(async () => collectorsPage(rows));
      const deleteCollector = vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
        rows = rows.filter((row) => row.id !== collectorId);
        return undefined;
      });
      return { getFleet, deleteCollector, deleteElsewhere: (name: string) => (rows = rows.filter((row) => row.name !== name)) };
    }

    /** The strip's Collectors tile's value. */
    const collectorsTile = () => within(screen.getByText("Version drift").closest("div.grid") as HTMLElement).getByText("Collectors").nextElementSibling;

    it("reads the fleet again after a collector's delete: the strip and the pager's total follow", async () => {
      const { getFleet, deleteCollector } = serveCollectorsAndFleet(3);
      const { user } = renderPage();
      await heading();
      expect(await screen.findByText("Showing 1–3 of 3")).toBeInTheDocument();
      expect(collectorsTile()).toHaveTextContent(/^3$/);
      const reads = getFleet.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Delete collector-002" }));
      await user.click(within(await screen.findByRole("alertdialog", { name: "Delete collector record" })).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(getFleet).toHaveBeenCalledTimes(reads + 1));
      expect(deleteCollector).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("Showing 1–2 of 2")).toBeInTheDocument();
      expect(collectorsTile()).toHaveTextContent(/^2$/);
    });

    it("reads the fleet again when the details find their collector gone: the strip and the pager's total follow", async () => {
      const { getFleet, deleteElsewhere } = serveCollectorsAndFleet(3);
      vi.spyOn(apiClient, "getCollector").mockRejectedValue(new ApiError("collector_not_found", "Collector not found.", { status: 404 }));
      vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] });
      vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null });
      const { user } = renderPage();
      await heading();
      expect(await screen.findByText("Showing 1–3 of 3")).toBeInTheDocument();
      const reads = getFleet.mock.calls.length;
      // Deleted elsewhere after the page was read.
      deleteElsewhere("collector-002");

      await user.click(screen.getByRole("button", { name: "collector-002" }));

      await waitFor(() => expect(getFleet).toHaveBeenCalledTimes(reads + 1));
      expect(await screen.findByText("Showing 1–2 of 2")).toBeInTheDocument();
      expect(collectorsTile()).toHaveTextContent(/^2$/);
    });

    it('reads the fleet again when a collectors read finds the fleet gone: "Fleet not found"', async () => {
      let gone = false;
      const getFleet = serveFleet(() => {
        if (gone) throw GONE();
        return fleetDetail();
      });
      vi.spyOn(apiClient, "getCollectors").mockImplementation(async () => {
        if (gone) throw GONE();
        return collectorsPage(manyCollectors(2));
      });
      const { user } = renderPage();
      await heading();
      await screen.findByRole("button", { name: "collector-001" });
      const reads = getFleet.mock.calls.length;
      gone = true;

      await user.click(screen.getByRole("button", { name: "Refresh collectors" }));

      expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
      expect(getFleet).toHaveBeenCalledTimes(reads + 1);
    });
  });

  // The Groups and Tokens tabs' onFleetChanged is the route's read.reload, so
  // the strip and the banner follow a write at once, not at the next poll.
  describe("the fleet read again after the Groups and Tokens tabs' writes", () => {
    const strip = () => screen.getByText("Version drift").closest("div.grid") as HTMLElement;
    const banner = () => screen.queryByRole("region", { name: TOKEN_BANNER_LABEL });

    it("reads the fleet again after the only rotate token's revoke: the strip says Suspended and the banner shows", async () => {
      let revoked = false;
      const getFleet = serveFleet(() =>
        fleetDetail({ summary: { ...fleetDetail().summary, rotateToken: revoked ? null : { expiresAt: null, graceEndsAt: null, validCount: 1 } } }),
      );
      let tokens = [listedToken(), listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" })];
      vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation(async () => ({ tokens }));
      const revoke = vi.spyOn(apiClient, "revokeEnrollmentToken").mockImplementation(async (_organizationId, _fleetId, tokenId) => {
        tokens = tokens.map((token) => (token.id === tokenId ? { ...token, revokedAt: new Date().toISOString() } : token));
        revoked = true;
        const { activeCollectors: _active, ...token } = tokens.find((each) => each.id === tokenId)!;
        return { token };
      });
      const { user } = renderPage(`/fleet-management/${FLEET_ID}?tab=tokens`);
      await heading();
      const revokeButton = await screen.findByRole("button", { name: /^Revoke the rotate token created / });
      expect(within(strip()).getByRole("link", { name: "Never (open the Tokens tab)" })).toBeInTheDocument();
      // No banner: nothing of it rendered, hidden or not.
      expect(banner()).toBeNull();
      expect(screen.queryByRole("region", { name: TOKEN_BANNER_LABEL, hidden: true })).toBeNull();
      const reads = getFleet.mock.calls.length;

      await user.click(revokeButton);
      await user.click(within(await screen.findByRole("alertdialog", { name: "Revoke this token?" })).getByRole("button", { name: "Revoke token" }));

      await waitFor(() => expect(getFleet).toHaveBeenCalledTimes(reads + 1));
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(await within(strip()).findByRole("link", { name: "Suspended (open the Tokens tab)" })).toBeInTheDocument();
      await waitFor(() => expect(banner()).toHaveTextContent(SUSPENDED_BANNER));
    });

    it("reads the fleet again after a group's create", async () => {
      const getFleet = serveFleet(() => fleetDetail());
      const checkout = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };
      vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [checkout], nextCursor: null });
      vi.spyOn(apiClient, "getConfigurationVersions").mockResolvedValue({ versions: [configurationVersionListItem()] });
      let groups = [collectorGroup()];
      vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => ({ groups }));
      const create = vi.spyOn(apiClient, "createCollectorGroup").mockImplementation(async (_organizationId, _fleetId, request) => {
        const made = collectorGroup({
          id: "70718293-a4b5-46c7-9d8e-9fa0b1c2d3e4",
          name: request.name,
          isDefault: false,
          assignedPublishedVersionId: PUBLISHED_VERSION_ID,
          assignedVersion: publishedVersion(),
        });
        groups = [...groups, made];
        return made;
      });
      const { user } = renderPage(`/fleet-management/${FLEET_ID}?tab=groups`);
      await heading();
      await user.click(await screen.findByRole("button", { name: "New group" }));
      const dialog = await screen.findByRole("dialog", { name: "New group" });
      await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "db-hosts");
      // A new group requires a published version: a configuration picked selects its newest.
      await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
      await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
      await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v4"));
      const reads = getFleet.mock.calls.length;

      await user.click(within(dialog).getByRole("button", { name: "Create" }));

      await waitFor(() => expect(getFleet).toHaveBeenCalledTimes(reads + 1));
      expect(create).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { name: "db-hosts", assignedVersionId: VERSION_ID }, expect.anything());
      expect(await screen.findByRole("button", { name: "Edit db-hosts" })).toBeInTheDocument();
    });
  });

  // A to B and back to A: in B the fleet isn't found and the page unmounts
  // the dialogs, which would close them anyway; back in A the page shows
  // them again, so only the switch's reset keeps the dialog asked for in A
  // before the switch from reopening.
  it("closes an open dialog when the active organization changes, reads the fleet in the new one, and doesn't reopen it on the way back", async () => {
    const getFleet = serveFleet((organizationId) => {
      if (organizationId === PERSONAL_ID) throw GONE();
      return fleetDetail();
    });
    let currentUser = signedInMember(GROUP_ID);
    const layoutLoader = vi.fn((): AppLayoutData => ({ status: "signed_in", currentUser }));
    const Stub = createRoutesStub([
      {
        id: "routes/app-layout",
        Component: AppLayoutRoute as unknown as React.ComponentType,
        loader: layoutLoader,
        shouldRevalidate,
        HydrateFallback: () => null,
        children: [
          {
            path: "/fleet-management/:fleetId",
            Component: function WithRevalidate() {
              const { revalidate } = useRevalidator();
              return (
                <>
                  <FleetRoute />
                  <button type="button" onClick={() => void revalidate()}>
                    Revalidate
                  </button>
                </>
              );
            },
          },
        ],
      },
    ]);
    render(<Stub initialEntries={[`/fleet-management/${FLEET_ID}`]} />);
    const user = userEvent.setup();
    await heading();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete fleet" })).toBeInTheDocument();

    // A switch elsewhere, seen when the layout revalidates (behind the dialog).
    currentUser = signedInMember(PERSONAL_ID);
    fireEvent.click(screen.getByRole("button", { name: "Revalidate", hidden: true }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
    expect(getFleet).toHaveBeenLastCalledWith(PERSONAL_ID, FLEET_ID, expect.anything());

    // And back: the fleet again, with no dialog (found hidden too, so a reopened modal fails on the dialog, not on the heading it hides).
    currentUser = signedInMember(GROUP_ID);
    fireEvent.click(screen.getByRole("button", { name: "Revalidate" }));
    expect(await screen.findByRole("heading", { level: 1, name: "edge-prod", hidden: true })).toBeInTheDocument();
    expect(getFleet).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, expect.anything());
    expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull();
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "edge-prod" })).toBeInTheDocument();
  });
});

// The page owns the install dialog, "install started" and the setup guide.
describe("installing from a fleet's page", () => {
  const OTHER_FLEET_ID = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8f";
  const BEARER = "bearer-route-canary-11aa";
  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
  /** The header's Install collector: the first in the page (the empty tab's comes after). */
  const headerInstall = () => screen.getAllByRole("button", { name: "Install collector" })[0]!;
  const checklist = () => screen.queryByRole("region", { name: "Fleet setup" });

  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    serveNoVariables();
    vi.spyOn(apiClient, "getCollectors").mockResolvedValue(collectorsPage([]));
    vi.spyOn(apiClient, "getCollectorGroups").mockResolvedValue({
      groups: [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gatewaysGroup()],
    });
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }), listedToken()] });
    vi.spyOn(apiClient, "getEnrollmentTokenEvents").mockResolvedValue(tokenEventsPage([]));
    vi.spyOn(apiClient, "getQuickDeployLinks").mockResolvedValue(quickDeployLinksPage([]));
    vi.spyOn(apiClient, "getInstallFacts").mockImplementation(async (_o, _f, groupId) => installFacts({ groupId }));
    vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: true });
    vi.spyOn(apiClient, "revealEnrollmentToken").mockResolvedValue({
      token: { id: DEFAULT_TOKEN_ID, kind: "default", bearer: BEARER, expiresAt: null },
    });
  });

  /** The page, with a clipboard that keeps what is written. */
  async function renderInstallPage(...args: Parameters<typeof renderPage>) {
    const page = renderPage(...args);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    await screen.findByRole("heading", { level: 1 });
    return page;
  }

  it("offers Install collector in an active server fleet's header, opening the dialog for the Default group; its close gives the focus back", async () => {
    serveFleet(() => fleetDetail());
    const { user } = await renderInstallPage();
    // The empty tab's button comes with the collectors' read, after the heading.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Install collector" })).toHaveLength(2));
    await user.click(headerInstall());
    expect(await screen.findByRole("dialog", { name: "Install collectors: Default" })).toBeInTheDocument();
    await waitFor(() => expect(apiClient.getInstallFacts).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, DEFAULT_GROUP_ID, expect.anything()));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(headerInstall);
  });

  it("shows the setup checklist between the strip and the tabs while the active fleet has no collectors, and none once it has", async () => {
    serveFleet(() => fleetDetail());
    await renderInstallPage();
    const card = checklist()!;
    expect(within(card).getByText("Set up this fleet")).toBeInTheDocument();
    const strip = screen.getByText("Version drift").closest("div.grid") as HTMLElement;
    expect(strip.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(screen.getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setup guide" })).toBeNull();
    // The Default group has a published version: step 1 done.
    await waitFor(() => expect(within(card).getByText("Assign a published version").closest("li")).toHaveTextContent("Done:"));
  });

  it("offers Setup guide once the fleet has collectors: it shows a checklist with Hide setup guide, which hides it and focuses Setup guide", async () => {
    serveFleet(() => fleetDetail({ summary: { ...EMPTY_SUMMARY, collectors: 3 } }));
    const { user } = await renderInstallPage();
    expect(checklist()).toBeNull();
    const toggle = screen.getByRole("button", { name: "Setup guide" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(within(checklist()!).queryByText("Disappears once your first collector connects")).toBeNull();
    await user.click(within(checklist()!).getByRole("button", { name: "Hide setup guide" }));
    expect(checklist()).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.activeElement).toBe(toggle);
    await user.click(toggle);
    await user.click(toggle);
    expect(checklist()).toBeNull();
  });

  it("turns install started on a reveal from the empty tab: the waiting state and the checklist's listening, kept after the close, the focus back on the tab's button", async () => {
    serveFleet(() => fleetDetail());
    const { user } = await renderInstallPage();
    const tabInstall = await within(screen.getByRole("tabpanel")).findByRole("button", { name: "Install collector" });
    await user.click(tabInstall);
    // Opening is no install.
    expect(await screen.findByRole("dialog", { name: "Install collectors: Default" })).toBeInTheDocument();
    expect(screen.getByText("Install your first collector")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Reveal & copy command" }));
    await screen.findByRole("button", { name: "Copy command" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(within(screen.getByRole("tabpanel")).getByText("Waiting for your first collector to connect")).toBeInTheDocument();
    expect(within(checklist()!).getByText("Listening for the first check-in…")).toBeInTheDocument();
    expect(within(checklist()!).queryByRole("button", { name: "Install" })).toBeNull();
    await focusIsOn(() => within(screen.getByRole("tabpanel")).getByRole("button", { name: "Install collector" }));
    expect(document.body.textContent).not.toContain(BEARER);
  });

  it("opens the dialog from the checklist's Install, and from a group's row for its group, the focus back on each", async () => {
    serveFleet(() => fleetDetail());
    const { user } = await renderInstallPage(`/fleet-management/${FLEET_ID}?tab=groups`);
    await user.click(within(checklist()!).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("dialog", { name: "Install collectors: Default" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => within(checklist()!).getByRole("button", { name: "Install" }));

    const row = await screen.findByRole("button", { name: "Install into gateways" });
    await user.click(row);
    expect(await screen.findByRole("dialog", { name: "Install collectors: gateways" })).toBeInTheDocument();
    await waitFor(() => expect(apiClient.getInstallFacts).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.anything()));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => screen.getByRole("button", { name: "Install into gateways" }));
  });

  // A Kubernetes-supervisor fleet's install is its Helm install, offered while it is active.
  it.each([
    ["an archived server fleet", fleetDetail({ status: "archived" })],
    ["an archived Kubernetes-supervisor fleet", fleetDetail({ type: "kubernetes-supervisor", status: "archived" })],
  ])("offers no install on %s: no Install collector or Install with Helm, no checklist, no Setup guide", async (_which, shown) => {
    serveFleet(() => shown);
    await renderInstallPage();
    expect(await within(screen.getByRole("tabpanel")).findByText("This fleet is archived: unarchive it to install collectors.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install with Helm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Setup guide" })).toBeNull();
    expect(checklist()).toBeNull();
  });

  it("starts afresh for another fleet: install started and the setup guide are the visit's, per fleet", async () => {
    serveFleet((_organizationId, fleetId) => fleetDetail({ id: fleetId }));
    const { user } = await renderInstallPage(`/fleet-management/${FLEET_ID}`, signedInMember(GROUP_ID), [`/fleet-management/${OTHER_FLEET_ID}`]);
    await user.click(headerInstall());
    await user.click(await screen.findByRole("button", { name: "Reveal & copy command" }));
    await screen.findByRole("button", { name: "Copy command" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(screen.getByRole("tabpanel")).getByText("Waiting for your first collector to connect")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(where()).toBe(`/fleet-management/${OTHER_FLEET_ID}`));
    expect(await within(screen.getByRole("tabpanel")).findByText("Install your first collector")).toBeInTheDocument();
    expect(within(checklist()!).queryByText("Listening for the first check-in…")).toBeNull();
  });

  it("closes the install dialog when the active organization changes", async () => {
    serveFleet(() => fleetDetail());
    const { user } = await renderInstallPage();
    await user.click(headerInstall());
    await screen.findByRole("dialog", { name: "Install collectors: Default" });
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the install dialog when the fleet turns out archived meanwhile: the dialog's refusal reads the fleet again, its entry points gone", async () => {
    let reads = 0;
    serveFleet(() => fleetDetail({ status: reads++ === 0 ? "active" : "archived" }));
    vi.mocked(apiClient.getInstallFacts).mockRejectedValue(new ApiError("fleet_archived", "The fleet is archived.", { status: 409 }));
    const { user } = await renderInstallPage();
    await user.click(headerInstall());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    expect(checklist()).toBeNull();
  });

  it("holds the fleet's label and the groups' names in no attribute with the install dialog and the checklist shown", async () => {
    const label = "canary-fleet-label-4b1c";
    serveFleet(() => fleetDetail({ label }));
    vi.mocked(apiClient.getCollectorGroups).mockResolvedValue({ groups: [collectorGroup({ name: "canary-default-9e9e" })] });
    const { user } = await renderInstallPage();
    await user.click(headerInstall());
    expect(await screen.findByRole("dialog", { name: "Install collectors: canary-default-9e9e" })).toBeInTheDocument();
    await screen.findByRole("button", { name: "Reveal & copy command" });
    expectNoAttributeHolds(label);
    expectNoAttributeHolds("canary-default-9e9e");
  });
});

// A Kubernetes-supervisor fleet's Helm install from its page.
describe("installing a Kubernetes-supervisor fleet's groups with Helm", () => {
  const BEARER = "helmRouteBearerCanary22bb";
  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
  const headerInstall = () => screen.getAllByRole("button", { name: "Install with Helm" })[0]!;
  const checklist = () => screen.queryByRole("region", { name: "Fleet setup" });
  const kubernetesFleet = (overrides: Partial<FleetDetail> = {}) => fleetDetail({ type: "kubernetes-supervisor", ...overrides });
  const gateways = gatewaysGroup({ annotations: kubernetesAnnotations() });

  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    serveNoVariables();
    vi.spyOn(apiClient, "getCollectors").mockResolvedValue(collectorsPage([]));
    // The Agent with nothing assigned, the Cluster not created yet, the gateways assigned.
    vi.spyOn(apiClient, "getCollectorGroups").mockResolvedValue({ groups: [collectorGroup(), gateways] });
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }), listedToken()] });
    vi.spyOn(apiClient, "getEnrollmentTokenEvents").mockResolvedValue(tokenEventsPage([]));
    vi.spyOn(apiClient, "getQuickDeployLinks").mockResolvedValue(quickDeployLinksPage([]));
    vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: true });
    vi.spyOn(apiClient, "getInstallFacts");
    vi.spyOn(apiClient, "getHelmInstallFacts").mockImplementation(async (_o, _f, groupId) => helmInstallFacts({ groupId }));
    vi.spyOn(apiClient, "revealEnrollmentToken").mockResolvedValue({
      token: { id: DEFAULT_TOKEN_ID, kind: "default", bearer: BEARER, expiresAt: null },
    });
    vi.spyOn(download, "downloadBlob").mockImplementation(() => undefined);
  });

  async function renderInstallPage(...args: Parameters<typeof renderPage>) {
    const page = renderPage(...args);
    await screen.findByRole("heading", { level: 1 });
    return page;
  }

  it("offers Install with Helm in the header and the empty Collectors tab, opening the Helm dialog on the first group with an install; its close gives the focus back", async () => {
    serveFleet(() => kubernetesFleet());
    const { user } = await renderInstallPage();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Install with Helm" })).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    await user.click(headerInstall());
    expect(await screen.findByRole("dialog", { name: "Install with Helm" })).toBeInTheDocument();
    await waitFor(() => expect(apiClient.getHelmInstallFacts).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.anything()));
    expect(apiClient.getInstallFacts).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(headerInstall);

    const tabInstall = within(screen.getByRole("tabpanel")).getByRole("button", { name: "Install with Helm" });
    await user.click(tabInstall);
    expect(await screen.findByRole("dialog", { name: "Install with Helm" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => within(screen.getByRole("tabpanel")).getByRole("button", { name: "Install with Helm" }));
  });

  it("shows the Kubernetes checklist while it has no collectors: Assign chooses the Groups tab; a download from its Install turns install started on", async () => {
    serveFleet(() => kubernetesFleet());
    const { user } = await renderInstallPage();
    const card = checklist()!;
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Assign published versions to your groups",
      "Install a group with Helm",
      "First collector connects",
    ]);
    // The gateways have a published version: step 1 done.
    await waitFor(() => expect(within(card).getByText("Assign published versions to your groups").closest("li")).toHaveTextContent("Done:"));

    await user.click(within(card).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("dialog", { name: "Install with Helm" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Download values.yaml" }));
    await screen.findByRole("button", { name: "Copy install command" });
    expect(download.downloadBlob).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(checklist()!).getByText("Listening for the first check-in…")).toBeInTheDocument();
    expect(within(checklist()!).getByText("Waiting for the first pod to check in. This page checks automatically every 15 seconds.")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(BEARER);
  });

  it("chooses the Groups tab from the checklist's Assign while no group has a published version", async () => {
    vi.mocked(apiClient.getCollectorGroups).mockResolvedValue({ groups: [collectorGroup()] });
    serveFleet(() => kubernetesFleet());
    const { user } = await renderInstallPage();
    await user.click(await within(checklist()!).findByRole("button", { name: "Assign" }));
    await waitFor(() => expect(where()).toBe(`/fleet-management/${FLEET_ID}?tab=groups`));
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the Helm dialog from a group's row (its Install before Assign or Edit) for its group, the focus back on it; a row with nothing assigned disabled", async () => {
    serveFleet(() => kubernetesFleet());
    const { user } = await renderInstallPage(`/fleet-management/${FLEET_ID}?tab=groups`);
    const row = await screen.findByRole("button", { name: "Install gateways" });
    const actions = row.parentElement!;
    expect([...actions.querySelectorAll("button")].map((each) => each.textContent).filter((text) => text !== "")).toEqual(["Install", "Edit", "Delete"]);
    expect(screen.getByRole("button", { name: "Install Agent" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Install Cluster" })).toHaveAttribute("aria-disabled", "true");
    await user.click(row);
    expect(await screen.findByRole("dialog", { name: "Install with Helm" })).toBeInTheDocument();
    await waitFor(() => expect(apiClient.getHelmInstallFacts).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.anything()));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => screen.getByRole("button", { name: "Install gateways" }));
  });

  it("holds no gateway name or namespace in an attribute with the Helm dialog and the checklist shown", async () => {
    const gateway = "canary-route-gateway-3c1d";
    const namespace = "canary-route-namespace-8e2f";
    vi.mocked(apiClient.getCollectorGroups).mockResolvedValue({
      groups: [collectorGroup(), gatewaysGroup({ name: gateway, annotations: kubernetesAnnotations({ namespace }) })],
    });
    vi.mocked(apiClient.getHelmInstallFacts).mockResolvedValue(helmInstallFacts({}, { release: gateway, namespace }));
    serveFleet(() => kubernetesFleet());
    const { user } = await renderInstallPage(`/fleet-management/${FLEET_ID}?tab=groups`);
    await user.click(await screen.findByRole("button", { name: `Install ${gateway}` }));
    await screen.findByRole("dialog", { name: "Install with Helm" });
    await screen.findByText(namespace, { selector: "dd" });
    expectNoAttributeHolds(gateway);
    expectNoAttributeHolds(namespace);
  });
});
