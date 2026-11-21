import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUserResponse, OrganizationVariable } from "@telflo/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import VariablesLayout from "./variables.js";
import VariablesPage, { meta as variablesMeta } from "./variables._index.js";
import VariableGroupsPage, { meta as groupsMeta } from "./variables.groups.js";
import VariableGroupRoute, { meta as groupMeta } from "./variables.groups.$variableGroupId.js";
import { Toaster } from "~/components/ui/sonner.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { forgetVariableGroupNames, seedVariableGroupNames, variableGroupNamesNow } from "~/lib/variable-group-display.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  VARIABLES_NOTE,
  VARIABLES_SECRETS_WARNING,
  VARIABLES_UNAVAILABLE_MESSAGE,
  VARIABLE_GROUPS_SECRETS_WARNING,
  changedLines,
} from "~/lib/variables.js";
import { VariableInUseList } from "~/components/variables/InUseLists.js";
import { GROUP_ID, signedInMember } from "~/test/configurations.js";
import { attributesHolding, expectNoAttributeHolds } from "~/test/fleets.js";
import {
  CHANGED_AT,
  OTHER_VARIABLE_ID,
  VARIABLE_GROUP_ID,
  VARIABLE_ID,
  groupUse,
  organizationVariable,
  variableGroup,
  variableGroupDetail,
  variableGroupOverride,
  variableInUse,
  versionUse,
} from "~/test/variables.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

/*
 * The Variables pages, under the signed-in layout as the app routes them.
 */

/** Where the page is: the address, its search included, for "the search is never in a URL". */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderAt(path: string, currentUser: CurrentUserResponse = signedInMember(GROUP_ID)) {
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser }),
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        {
          path: "/variables",
          Component: () => (
            <>
              <VariablesLayout />
              <Address />
            </>
          ),
          children: [
            { index: true, Component: VariablesPage },
            { path: "groups", Component: VariableGroupsPage },
            { path: "groups/:variableGroupId", Component: VariableGroupRoute as unknown as React.ComponentType },
          ],
        },
      ],
    },
  ]);
  render(
    <>
      <Stub initialEntries={[path]} />
      <Toaster theme="dark" />
    </>,
  );
  return userEvent.setup();
}

const SECOND = organizationVariable({ id: OTHER_VARIABLE_ID, name: "REGION", value: "eu-west-1", description: null, changedBy: null });

function serveVariables(...answers: OrganizationVariable[][]) {
  const queue = [...answers];
  return vi
    .spyOn(apiClient, "getOrganizationVariables")
    .mockImplementation(async () => (queue.length > 1 ? queue.shift()! : (queue[0] ?? [])));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUserStore.getState().clear();
  forgetOrgVariableNames();
  forgetVariableGroupNames();
});

afterEach(() => {
  cleanup();
  forgetOrgVariableNames();
  forgetVariableGroupNames();
});

describe("the routes", () => {
  it("routes /variables under the signed-in layout: the Variables index, groups, and a group's page by its id", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const variables = layout?.children?.find((route) => route.path === "variables");
    expect(variables?.file).toBe("routes/variables.tsx");
    expect(variables?.children?.map((route) => [route.index ?? false, route.path, route.file])).toEqual([
      [true, undefined, "routes/variables._index.tsx"],
      [false, "groups", "routes/variables.groups.tsx"],
      [false, "groups/:variableGroupId", "routes/variables.groups.$variableGroupId.tsx"],
    ]);
  });

  it("gives every page a fixed title", () => {
    expect(variablesMeta({} as never)).toEqual([{ title: "Variables - Telflo" }]);
    expect(groupsMeta({} as never)).toEqual([{ title: "Variable groups - Telflo" }]);
    expect(groupMeta({} as never)).toEqual([{ title: "Variable group - Telflo" }]);
  });

  it("shows the left nav: links to Variables and Variable groups, each with its icon, marking the one shown", async () => {
    serveVariables([]);
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([]);
    const user = renderAt("/variables");
    const nav = await screen.findByRole("navigation", { name: "Variables pages" });
    expect(nav.previousElementSibling?.textContent).toBe("Variables");
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Variables", "/variables"],
      ["Variable groups", "/variables/groups"],
    ]);
    for (const link of links) expect(link.querySelector("svg")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "Variables" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Variable groups" })).not.toHaveAttribute("aria-current");
    await user.click(within(nav).getByRole("link", { name: "Variable groups" }));
    expect(await screen.findByText("No variable groups yet")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Variable groups" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Variables" })).not.toHaveAttribute("aria-current");
  });

  it('keeps "Variable groups" marked on a group\'s page', async () => {
    vi.spyOn(apiClient, "getVariableGroup").mockResolvedValue(variableGroupDetail());
    serveVariables([organizationVariable()]);
    renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);
    await screen.findByRole("heading", { level: 2, name: "EU production" });
    const nav = screen.getByRole("navigation", { name: "Variables pages" });
    expect(within(nav).getByRole("link", { name: "Variable groups" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Variables" })).not.toHaveAttribute("aria-current");
  });
});

describe("the Variables page", () => {
  it("says the note under the title, exactly", async () => {
    serveVariables([]);
    renderAt("/variables");
    const title = await screen.findByRole("heading", { level: 1, name: "Variables" });
    expect(title.nextElementSibling?.textContent).toBe(VARIABLES_NOTE);
    expect(VARIABLES_NOTE).toBe("Referenced in configurations as ${org:NAME}.");
    expect(title.nextElementSibling?.querySelector("code")?.textContent).toBe("${org:NAME}");
  });

  it("warns, under the header, that it is not for secrets and that test runs keep the values, exactly", async () => {
    serveVariables([]);
    renderAt("/variables");
    await screen.findByText("No organization variables yet");
    const warning = screen.getByRole("note");
    expect(warning.textContent).toBe(VARIABLES_SECRETS_WARNING);
    expect(VARIABLES_SECRETS_WARNING).toBe(
      "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install. Test runs use these values in place of ${org:NAME}, and each run keeps its Test YAML and the collector's logs, values included, with its results.",
    );
    expect(warning.querySelector("strong")?.textContent).toBe("Not for secrets.");
    expect([...warning.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["${env:NAME}", "${org:NAME}"]);
    // Above the empty state (and the table), below the search and "Add variable".
    expect(warning.compareDocumentPosition(screen.getByText("No organization variables yet")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search variables" }).compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists Name with the description beneath, the Value in full inside ph-no-capture, Changed and the actions", async () => {
    const long = `https://otlp.example:4318/${"a".repeat(300)}`;
    serveVariables([organizationVariable({ value: long }), SECOND]);
    renderAt("/variables");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Value", "Changed", "Actions"]);
    const [, first, second] = within(table).getAllByRole("row");
    expect(within(first!).getByText("OTLP_EP")).toBeInTheDocument();
    expect(within(first!).getByText("The gateway's endpoint")).toBeInTheDocument();
    const value = within(first!).getByText(long);
    expect(value.closest(".ph-no-capture")).not.toBeNull();
    expect(within(first!).getByText("by ana@example.com")).toBeInTheDocument();
    expect(within(first!).getByRole("button", { name: "Edit OTLP_EP" })).toBeInTheDocument();
    expect(within(first!).getByRole("button", { name: "Delete OTLP_EP" })).toBeInTheDocument();
    expect(within(second!).getByText("REGION")).toBeInTheDocument();
    expect(within(second!).queryByText(/^by /)).toBeNull();
  });

  it('shows "No organization variables yet" with "Add variable" for none', async () => {
    serveVariables([]);
    renderAt("/variables");
    expect(await screen.findByText("No organization variables yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add variable" })).toHaveLength(2);
  });

  it('says "Failed to load variables" with "Try again", which reads again', async () => {
    const read = vi
      .spyOn(apiClient, "getOrganizationVariables")
      .mockRejectedValueOnce(new ApiError("variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE, { status: 503 }))
      .mockResolvedValue([organizationVariable()]);
    const user = renderAt("/variables");
    expect(await screen.findByText("Failed to load variables")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("OTLP_EP")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("searches name, description and value in the browser: no read, no address, no storage; the input in ph-no-capture", async () => {
    const read = serveVariables([organizationVariable(), SECOND]);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = renderAt("/variables");
    await screen.findByText("OTLP_EP");
    const search = screen.getByRole("searchbox", { name: "Search variables" });
    expect(search.closest(".ph-no-capture")).not.toBeNull();
    expect(search).toHaveAttribute("placeholder", "Search variables...");

    await user.type(search, "region");
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    expect(screen.getByText("REGION")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "gateway's");
    expect(screen.getByText("OTLP_EP")).toBeInTheDocument();
    expect(screen.queryByText("REGION")).toBeNull();
    await user.clear(search);
    await user.type(search, "EU-WEST");
    expect(screen.getByText("REGION")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zzz-nothing");
    expect(screen.getByText("No variables match your search")).toBeInTheDocument();

    expect(screen.getByTestId("address")).toHaveTextContent(/^\/variables$/);
    expect(window.location.href).not.toContain("zzz-nothing");
    expect(read).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("zzz-nothing");
    expect(attributesHolding("zzz-nothing")).toEqual(["INPUT value"]);
  });

  it('adds a variable: "Add variable", the name upper-cased as typed, the opening\'s id, "Variable added", the list read again', async () => {
    serveVariables([], [organizationVariable()]);
    const create = vi.spyOn(apiClient, "createOrganizationVariable").mockResolvedValue(organizationVariable());
    const user = renderAt("/variables");
    await screen.findByText("No organization variables yet");
    await user.click(screen.getAllByRole("button", { name: "Add variable" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Add variable" });
    await user.type(within(dialog).getByLabelText("Name"), "otlp_ep");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("OTLP_EP");
    expect(within(dialog).getByText("${org:OTLP_EP}")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Value"), "https://otlp.example:4318");
    await user.type(within(dialog).getByLabelText("Description (optional)"), "  The gateway's endpoint ");
    await user.click(within(dialog).getByRole("button", { name: "Add variable" }));

    expect(await screen.findByText("Variable added")).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(
      GROUP_ID,
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "OTLP_EP", value: "https://otlp.example:4318", description: "The gateway's endpoint" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText("OTLP_EP")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("checks the name before sending, and says a taken name under Name", async () => {
    serveVariables([]);
    const create = vi
      .spyOn(apiClient, "createOrganizationVariable")
      .mockRejectedValue(new ApiError("variable_name_taken", "Another of the organization's variables has this name.", { status: 409 }));
    const user = renderAt("/variables");
    await screen.findByText("No organization variables yet");
    await user.click(screen.getAllByRole("button", { name: "Add variable" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Add variable" });
    await user.type(within(dialog).getByLabelText("Name"), "9BAD");
    await user.click(within(dialog).getByRole("button", { name: "Add variable" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Use letters, digits and underscores, starting with a letter.");
    expect(create).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "TAKEN");
    await user.click(within(dialog).getByRole("button", { name: "Add variable" }));
    expect(await within(dialog).findByText("Another of the organization's variables has this name.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add variable" })).toBeInTheDocument();
  });

  it('edits only what changed: "Edit variable", Save waiting for a change, "Variable saved"', async () => {
    serveVariables([organizationVariable()], [organizationVariable({ value: "https://new.example" })]);
    vi.spyOn(apiClient, "getVariableDrafts").mockResolvedValue([]);
    const update = vi.spyOn(apiClient, "updateOrganizationVariable").mockResolvedValue(organizationVariable({ value: "https://new.example" }));
    const user = renderAt("/variables");
    await user.click(await screen.findByRole("button", { name: "Edit OTLP_EP" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit variable" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Value"));
    await user.type(within(dialog).getByLabelText("Value"), "https://new.example");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Variable saved")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(GROUP_ID, VARIABLE_ID, { value: "https://new.example" }, expect.anything());
    expect(await screen.findByText("https://new.example")).toBeInTheDocument();
  });

  it('a rename warns about the drafts, exactly "Drafts using OTLP_EP: edge-config", and a refused rename lists its uses', async () => {
    serveVariables([organizationVariable()]);
    const drafts = vi.spyOn(apiClient, "getVariableDrafts").mockResolvedValue([{ id: "7e000000-0000-4000-8000-000000000009", name: "edge-config" }]);
    vi.spyOn(apiClient, "updateOrganizationVariable").mockRejectedValue(
      new ApiError("variable_in_use", "A published version that a collector group or a collector uses references this variable: assign or pin another version first.", {
        status: 409,
        details: variableInUse([versionUse(3, { groups: [groupUse(1)], pinnedCollectors: 2 })], { totalPublications: 4 }),
      }),
    );
    const user = renderAt("/variables");
    await user.click(await screen.findByRole("button", { name: "Edit OTLP_EP" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit variable" });
    expect(drafts).toHaveBeenCalledWith(GROUP_ID, VARIABLE_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // No warning while the name is the one it opened with.
    expect(within(dialog).queryByText(/^Drafts using/)).toBeNull();
    await user.type(within(dialog).getByLabelText("Name"), "2");
    const warning = await within(dialog).findByText("Drafts using OTLP_EP: edge-config");
    expect(warning.closest(".ph-no-capture")).not.toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("edge-config v3 (gateways in edge-prod, pinned on 2 collectors)")).toBeInTheDocument();
    expect(within(dialog).getByText("… and 3 more published versions")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit variable" })).toBeInTheDocument();
  });

  it("deletes: the drafts warning, a refusal's list in fixed words for names that came back null, then \"Variable deleted\"", async () => {
    serveVariables([organizationVariable()], []);
    vi.spyOn(apiClient, "getVariableDrafts").mockResolvedValue([
      { id: "7e000000-0000-4000-8000-000000000009", name: "edge-config" },
      { id: "7e000000-0000-4000-8000-00000000000a", name: "eu-config" },
    ]);
    const remove = vi
      .spyOn(apiClient, "deleteOrganizationVariable")
      .mockRejectedValueOnce(
        new ApiError("variable_in_use", "A published version that a collector group or a collector uses references this variable: assign or pin another version first.", {
          status: 409,
          details: variableInUse(
            [
              versionUse(1, { configurationId: null, configurationName: null, versionId: null, versionNumber: null, groups: [groupUse(1, { fleetLabel: null, groupName: null })] }),
              versionUse(2, { groups: [groupUse(2), groupUse(3, { groupName: "eu" })] }),
            ],
            { totalPublications: 3 },
          ),
        }),
      )
      .mockResolvedValue(undefined);
    const user = renderAt("/variables");
    await user.click(await screen.findByRole("button", { name: "Delete OTLP_EP" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete variable" });
    expect(await within(dialog).findByText("Drafts using OTLP_EP: edge-config, eu-config")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("a published version of a deleted configuration (a group in another fleet)")).toBeInTheDocument();
    expect(within(dialog).getByText("edge-config v2 (gateways in edge-prod, eu in edge-prod)")).toBeInTheDocument();
    expect(within(dialog).getByText("… and 1 more published version")).toBeInTheDocument();
    expect(within(dialog).getByText("edge-config v2 (gateways in edge-prod, eu in edge-prod)").closest(".ph-no-capture")).not.toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Variable deleted")).toBeInTheDocument();
    expect(await screen.findByText("No organization variables yet")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("an unknown outcome says the 503's words in the dialog, keeps it open, and reads the list again", async () => {
    const read = serveVariables([]);
    vi.spyOn(apiClient, "createOrganizationVariable").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    const user = renderAt("/variables");
    await screen.findByText("No organization variables yet");
    await user.click(screen.getAllByRole("button", { name: "Add variable" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Add variable" });
    await user.type(within(dialog).getByLabelText("Name"), "A");
    await user.click(within(dialog).getByRole("button", { name: "Add variable" }));
    expect(await within(dialog).findByText(VARIABLES_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
});

describe("the Variables page's privacy", () => {
  const NAME = "CANARY_NAME_5E1";
  const VALUE = "value-canary-5e1";
  const DESCRIPTION = "description-canary-5e1";

  it("puts no name, value or description in an attribute or the title, the open inputs' own value aside, and toasts fixed words", async () => {
    const canary = organizationVariable({ name: NAME, value: VALUE, description: DESCRIPTION });
    serveVariables([canary], [canary], []);
    vi.spyOn(apiClient, "getVariableDrafts").mockResolvedValue([{ id: "7e000000-0000-4000-8000-000000000009", name: "edge-config" }]);
    vi.spyOn(apiClient, "updateOrganizationVariable").mockResolvedValue(canary);
    vi.spyOn(apiClient, "deleteOrganizationVariable").mockResolvedValue(undefined);
    const user = renderAt("/variables");
    await screen.findByText(VALUE);
    for (const text of [NAME, VALUE, DESCRIPTION]) expectNoAttributeHolds(text);

    await user.click(screen.getByRole("button", { name: `Edit ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit variable" });
    expect(attributesHolding(NAME)).toEqual(["INPUT value"]);
    expect(attributesHolding(VALUE)).toEqual(["INPUT value"]);
    expect(attributesHolding(DESCRIPTION)).toEqual([]);
    expect(within(dialog).getByLabelText("Value").closest(".ph-no-capture")).not.toBeNull();
    expect(within(dialog).getByLabelText("Name").closest(".ph-no-capture")).not.toBeNull();
    expect(within(dialog).getByLabelText("Description (optional)").closest(".ph-no-capture")).not.toBeNull();
    await user.type(within(dialog).getByLabelText("Value"), "x");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Variable saved")).toBeInTheDocument();
    for (const text of [NAME, VALUE, DESCRIPTION]) expectNoAttributeHolds(text);

    await user.click(screen.getByRole("button", { name: `Delete ${NAME}` }));
    await screen.findByRole("alertdialog", { name: "Delete variable" });
    for (const text of [NAME, VALUE, DESCRIPTION]) expectNoAttributeHolds(text);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Variable deleted")).toBeInTheDocument();

    // Every toast shown is fixed words.
    const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((each) => each.textContent ?? "");
    expect(toasts.length).toBeGreaterThan(0);
    for (const text of toasts) for (const canaryText of [NAME, VALUE, DESCRIPTION]) expect(text).not.toContain(canaryText);
    for (const text of [NAME, VALUE, DESCRIPTION]) {
      expect(document.title).not.toContain(text);
      expect(window.location.href).not.toContain(text);
    }
  });
});

describe("the Variable groups page", () => {
  it("keeps its description, warns under it that secrets stay in environment variables, and says how variable groups work below the list", async () => {
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([variableGroup()]);
    renderAt("/variables/groups");
    const table = await screen.findByRole("table");
    expect(screen.getByText("Overrides of the organization's values, used by collector groups and pinned collectors.")).toBeInTheDocument();
    const warning = screen.getByRole("note");
    expect(warning.textContent).toBe(VARIABLE_GROUPS_SECRETS_WARNING);
    expect(VARIABLE_GROUPS_SECRETS_WARNING).toBe(
      "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install.",
    );
    expect(warning.querySelector("strong")?.textContent).toBe("Not for secrets.");
    expect([...warning.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["${env:NAME}"]);
    expect(warning.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add variable group" })[0]!.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const title = screen.getByText("How variable groups work");
    expect(table.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.nextElementSibling?.textContent).toBe(
      "A variable group overrides some of your organization's values, such as one region's endpoint. A collector group uses one in its Edit dialog, and a single collector can be pinned to its own. Each collector receives every variable from its pinned variable group, else its collector group's, else the organization's. A variable the group doesn't override keeps the organization's value.",
    );
  });

  it("lists Name with the description, Overrides counted, Used by counted, Changed, and links each name to its page by id", async () => {
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([
      variableGroup(),
      variableGroup({ id: "7b000000-0000-4000-8000-000000000002", name: "Spare", description: null, overrideCount: 0, usage: { collectorGroups: 0, pinnedCollectors: 0 } }),
    ]);
    renderAt("/variables/groups");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Overrides", "Used by", "Changed", "Actions"]);
    const [, first, second] = within(table).getAllByRole("row");
    expect(within(first!).getByRole("link", { name: "EU production" })).toHaveAttribute("href", `/variables/groups/${VARIABLE_GROUP_ID}`);
    expect(within(first!).getByText("Europe's collectors")).toBeInTheDocument();
    expect(within(first!).getByText("1")).toBeInTheDocument();
    expect(within(first!).getByText("2 collector groups, 1 pinned collector")).toBeInTheDocument();
    expect(within(second!).getByText("0")).toBeInTheDocument();
    expect(within(second!).getByText("Unused")).toBeInTheDocument();
  });

  it('adds a group ("Add variable group", "Variable group added"), and a refused delete lists the collector groups', async () => {
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValueOnce([]).mockResolvedValue([variableGroup()]);
    const create = vi.spyOn(apiClient, "createVariableGroup").mockResolvedValue(variableGroup());
    vi.spyOn(apiClient, "deleteVariableGroup").mockRejectedValue(
      new ApiError("variable_group_in_use", "A collector group or a collector uses this variable group: choose another for them first.", {
        status: 409,
        details: { collectorGroups: [groupUse(1), groupUse(2, { fleetLabel: null })], totalCollectorGroups: 5, pinnedCollectors: 3 },
      }),
    );
    const user = renderAt("/variables/groups");
    await user.click((await screen.findAllByRole("button", { name: "Add variable group" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Add variable group" });
    await user.type(within(dialog).getByLabelText("Name"), " EU production ");
    await user.click(within(dialog).getByRole("button", { name: "Add variable group" }));
    expect(await screen.findByText("Variable group added")).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(GROUP_ID, { id: expect.any(String), name: "EU production", description: null }, expect.anything());

    await user.click(await screen.findByRole("button", { name: "Delete EU production" }));
    const alert = await screen.findByRole("alertdialog", { name: "Delete variable group" });
    // The group's name is configuration text: shown inside ph-no-capture.
    expect(within(alert).getByText("EU production").closest(".ph-no-capture")).not.toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Delete" }));
    expect(await within(alert).findByText("gateways in edge-prod")).toBeInTheDocument();
    expect(within(alert).getByText("gateways in edge-prod").closest(".ph-no-capture")).not.toBeNull();
    expect(within(alert).getByText("gateways in another fleet")).toBeInTheDocument();
    expect(within(alert).getByText("Pinned on 3 collectors")).toBeInTheDocument();
    expect(within(alert).getByText("… and 3 more collector groups")).toBeInTheDocument();
  });
});

describe("a variable group's page", () => {
  it("lists every organization variable with its value in the group and its source, Override on each and Reset on an override", async () => {
    vi.spyOn(apiClient, "getVariableGroup").mockResolvedValue(variableGroupDetail());
    serveVariables([organizationVariable(), SECOND]);
    renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);
    expect(await screen.findByRole("heading", { level: 2, name: "EU production" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Value", "Source", "Actions"]);
    const [, first, second] = within(table).getAllByRole("row");
    expect(within(first!).getByText("https://eu.otlp.example:4318").closest(".ph-no-capture")).not.toBeNull();
    const source = (row: HTMLElement) => row.querySelectorAll("td")[2]?.firstElementChild?.textContent;
    expect(source(first!)).toBe("Override");
    expect(within(first!).getByRole("button", { name: "Override OTLP_EP" })).toBeInTheDocument();
    expect(within(first!).getByRole("button", { name: "Reset OTLP_EP" })).toBeInTheDocument();
    // An override's "changed {when} by {email}" beneath its source; an organization value's none.
    const changed = changedLines(CHANGED_AT, { userId: "7c000000-0000-4000-8000-000000000001", email: "ana@example.com" });
    expect(within(first!).getByText(`changed ${changed.at} by ana@example.com`)).toBeInTheDocument();
    expectNoAttributeHolds("ana@example.com");
    expect(within(second!).getByText("eu-west-1")).toBeInTheDocument();
    expect(source(second!)).toBe("Organization value");
    expect(within(second!).queryByText(/^changed /)).toBeNull();
    expect(within(second!).getByRole("button", { name: "Override REGION" })).toBeInTheDocument();
    expect(within(second!).queryByRole("button", { name: "Reset REGION" })).toBeNull();
  });

  it('overrides a value (PUT, "Override saved") and resets one (DELETE, "Override reset"), reading the page again after each', async () => {
    const readGroup = vi
      .spyOn(apiClient, "getVariableGroup")
      .mockResolvedValueOnce(variableGroupDetail())
      .mockResolvedValueOnce(variableGroupDetail({ overrideCount: 2 }, [variableGroupOverride(), variableGroupOverride({ variableId: OTHER_VARIABLE_ID, value: "eu-central-1" })]))
      .mockResolvedValue(variableGroupDetail({ overrideCount: 1 }, [variableGroupOverride({ variableId: OTHER_VARIABLE_ID, value: "eu-central-1" })]));
    serveVariables([organizationVariable(), SECOND]);
    const put = vi.spyOn(apiClient, "setVariableGroupOverride").mockResolvedValue(variableGroupOverride({ variableId: OTHER_VARIABLE_ID, value: "eu-central-1" }));
    const reset = vi.spyOn(apiClient, "resetVariableGroupOverride").mockResolvedValue(undefined);
    const user = renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);

    await user.click(await screen.findByRole("button", { name: "Override REGION" }));
    const dialog = await screen.findByRole("dialog", { name: "Override value" });
    const input = within(dialog).getByLabelText("Value in this group");
    expect(input).toHaveValue("eu-west-1");
    expect(input.closest(".ph-no-capture")).not.toBeNull();
    await user.clear(input);
    await user.type(input, "eu-central-1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Override saved")).toBeInTheDocument();
    expect(put).toHaveBeenCalledWith(GROUP_ID, VARIABLE_GROUP_ID, OTHER_VARIABLE_ID, "eu-central-1", expect.anything());
    expect(await screen.findByText("eu-central-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset OTLP_EP" }));
    const alert = await screen.findByRole("alertdialog", { name: "Reset override" });
    // The variable's name is configuration text: its ${org:NAME} inside ph-no-capture.
    expect(within(alert).getByText("${org:OTLP_EP}").closest(".ph-no-capture")).not.toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Reset" }));
    expect(await screen.findByText("Override reset")).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith(GROUP_ID, VARIABLE_GROUP_ID, VARIABLE_ID, expect.anything());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset OTLP_EP" })).toBeNull());
    expect(readGroup).toHaveBeenCalledTimes(3);
    expectNoAttributeHolds("eu-central-1");
  });

  it('says "Variable group not found" for a group gone, and reads nothing for an address that isn\'t an id', async () => {
    const read = vi
      .spyOn(apiClient, "getVariableGroup")
      .mockRejectedValue(new ApiError("variable_group_not_found", "Variable group not found", { status: 404 }));
    serveVariables([]);
    renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);
    expect(await screen.findByText("Variable group not found")).toBeInTheDocument();
    cleanup();
    read.mockClear();
    renderAt("/variables/groups/not-an-id");
    expect(await screen.findByText("Variable group not found")).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the fleet screens' variable group names follow these pages", () => {
  it("the list's answer names the groups for the fleet screens", async () => {
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([variableGroup()]);
    renderAt("/variables/groups");
    expect(await screen.findByRole("link", { name: "EU production" })).toBeInTheDocument();
    expect(variableGroupNamesNow()).toMatchObject({ organizationId: GROUP_ID, status: "ready" });
    expect(variableGroupNamesNow().names.get(VARIABLE_GROUP_ID)).toBe("EU production");
  });

  it("a rename saved on the group's page names it so at once, and a delete forgets it", async () => {
    // The fleet screens read the names before (a collector's row named the group).
    seedVariableGroupNames(GROUP_ID, [variableGroup()]);
    vi.spyOn(apiClient, "getVariableGroup")
      .mockResolvedValueOnce(variableGroupDetail())
      .mockResolvedValue(variableGroupDetail({ name: "EU production 2" }));
    serveVariables([organizationVariable()]);
    const update = vi.spyOn(apiClient, "updateVariableGroup").mockResolvedValue(variableGroup({ name: "EU production 2" }));
    vi.spyOn(apiClient, "deleteVariableGroup").mockResolvedValue(undefined);
    // The list a delete goes back to never answers here: only the dialog can forget the name.
    vi.spyOn(apiClient, "getVariableGroups").mockReturnValue(new Promise(() => undefined));
    const user = renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);
    await screen.findByRole("heading", { level: 2, name: "EU production" });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit variable group" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "EU production 2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Variable group saved")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(GROUP_ID, VARIABLE_GROUP_ID, { name: "EU production 2" }, expect.anything());
    expect(variableGroupNamesNow().names.get(VARIABLE_GROUP_ID)).toBe("EU production 2");

    await screen.findByRole("heading", { level: 2, name: "EU production 2" });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const alert = await screen.findByRole("alertdialog", { name: "Delete variable group" });
    await user.click(within(alert).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Variable group deleted")).toBeInTheDocument();
    expect(variableGroupNamesNow().names.has(VARIABLE_GROUP_ID)).toBe(false);
  });
});

describe("the in-use lists", () => {
  it("says the collector groups a version's list was cut short of, from the exact total", () => {
    const groups = Array.from({ length: 100 }, (_, index) => groupUse(index + 1));
    render(<VariableInUseList details={variableInUse([versionUse(1, { groups })], { totalGroups: 150 })} />);
    expect(screen.getByText("… and 50 more collector groups")).toBeInTheDocument();
    expect(screen.queryByText(/more published version/)).toBeNull();
  });

  it("says only the published versions left out when some are, never also their groups (no use counted twice)", () => {
    // 100 entries: 50 versions of 2 groups listed, out of 60 versions with 120 groups in all.
    const usedBy = Array.from({ length: 50 }, (_, index) =>
      versionUse(index + 1, { groups: [groupUse(2 * index + 1), groupUse(2 * index + 2)] }),
    );
    render(<VariableInUseList details={variableInUse(usedBy, { totalPublications: 60, totalGroups: 120 })} />);
    expect(screen.getByText("… and 10 more published versions")).toBeInTheDocument();
    expect(screen.queryByText(/more collector group/)).toBeNull();
  });

  it("says nothing more when every group is listed", () => {
    render(<VariableInUseList details={variableInUse([versionUse(1, { groups: [groupUse(1)] })])} />);
    expect(screen.queryByText(/… and/)).toBeNull();
  });
});

describe("the Variable groups pages' privacy", () => {
  const NAME = "group-name-canary-3c9";
  const DESCRIPTION = "group-description-canary-3c9";
  const VALUE = "override-value-canary-3c9";
  const ORGANIZATION_VALUE = "organization-value-canary-3c9";

  const canaries = () => [NAME, DESCRIPTION, VALUE, ORGANIZATION_VALUE];
  /** No canary in an attribute but the listed holders, nor in a toast, the title or the address. */
  const expectNowhereButText = (holders: Record<string, string[]> = {}) => {
    for (const text of canaries()) expect(attributesHolding(text), text).toEqual(holders[text] ?? []);
    const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((each) => each.textContent ?? "");
    for (const text of canaries()) {
      for (const shown of toasts) expect(shown).not.toContain(text);
      expect(document.title).not.toContain(text);
      expect(window.location.href).not.toContain(text);
    }
  };

  it("keeps the group's name and description and every value out of attributes, toasts and the title, with each dialog open", async () => {
    const group = { name: NAME, description: DESCRIPTION };
    vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([variableGroup(group)]);
    vi.spyOn(apiClient, "getVariableGroup").mockResolvedValue(variableGroupDetail(group, [variableGroupOverride({ value: VALUE })]));
    serveVariables([organizationVariable({ value: ORGANIZATION_VALUE }), SECOND]);
    vi.spyOn(apiClient, "updateVariableGroup").mockResolvedValue(variableGroup(group));
    vi.spyOn(apiClient, "setVariableGroupOverride").mockResolvedValue(variableGroupOverride({ value: VALUE }));
    vi.spyOn(apiClient, "resetVariableGroupOverride").mockResolvedValue(undefined);
    vi.spyOn(apiClient, "deleteVariableGroup").mockRejectedValue(
      new ApiError("variable_group_in_use", "A collector group or a collector uses this variable group: choose another for them first.", {
        status: 409,
        details: { collectorGroups: [groupUse(1)], totalCollectorGroups: 1, pinnedCollectors: 0 },
      }),
    );
    const user = renderAt("/variables/groups");

    // The list, its Edit and its Delete.
    await screen.findByRole("link", { name: NAME });
    expectNowhereButText();
    await user.click(screen.getByRole("button", { name: `Edit ${NAME}` }));
    const listEdit = await screen.findByRole("dialog", { name: "Edit variable group" });
    expectNowhereButText({ [NAME]: ["INPUT value"] });
    await user.click(within(listEdit).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: `Delete ${NAME}` }));
    const listDelete = await screen.findByRole("alertdialog", { name: "Delete variable group" });
    await user.click(within(listDelete).getByRole("button", { name: "Delete" }));
    expect(await within(listDelete).findByText("gateways in edge-prod")).toBeInTheDocument();
    expectNowhereButText();
    await user.click(within(listDelete).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // The group's page, its Override, Reset, Edit and Delete.
    await user.click(screen.getByRole("link", { name: NAME }));
    expect(await screen.findByRole("heading", { level: 2, name: NAME })).toBeInTheDocument();
    expect(await screen.findByText(VALUE)).toBeInTheDocument();
    expectNowhereButText();

    await user.click(screen.getByRole("button", { name: "Override REGION" }));
    const override = await screen.findByRole("dialog", { name: "Override value" });
    await user.clear(within(override).getByLabelText("Value in this group"));
    await user.type(within(override).getByLabelText("Value in this group"), VALUE);
    expectNowhereButText({ [VALUE]: ["INPUT value"] });
    await user.click(within(override).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Override saved")).toBeInTheDocument();
    expectNowhereButText();

    await user.click(screen.getByRole("button", { name: "Override OTLP_EP" }));
    await screen.findByRole("dialog", { name: "Override value" });
    expectNowhereButText({ [VALUE]: ["INPUT value"] });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Reset OTLP_EP" }));
    const reset = await screen.findByRole("alertdialog", { name: "Reset override" });
    expectNowhereButText();
    await user.click(within(reset).getByRole("button", { name: "Reset" }));
    expect(await screen.findByText("Override reset")).toBeInTheDocument();
    expectNowhereButText();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit variable group" });
    expectNowhereButText({ [NAME]: ["INPUT value"] });
    await user.type(within(edit).getByLabelText("Description (optional)"), "!");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Variable group saved")).toBeInTheDocument();
    expectNowhereButText();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const remove = await screen.findByRole("alertdialog", { name: "Delete variable group" });
    await user.click(within(remove).getByRole("button", { name: "Delete" }));
    expect(await within(remove).findByText("gateways in edge-prod")).toBeInTheDocument();
    expectNowhereButText();
  });
});

describe("a variable group's Edit keeps its opening's baseline", () => {
  it("a 503 whose reload brings a renamed group leaves the dialog's fields, and Save's change check, as they opened", async () => {
    vi.spyOn(apiClient, "getVariableGroup")
      .mockResolvedValueOnce(variableGroupDetail())
      .mockResolvedValue(variableGroupDetail({ name: "Renamed elsewhere", description: "Changed elsewhere" }));
    serveVariables([organizationVariable()]);
    const update = vi
      .spyOn(apiClient, "updateVariableGroup")
      .mockRejectedValue(new ApiError("variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE, { status: 503 }));
    const user = renderAt(`/variables/groups/${VARIABLE_GROUP_ID}`);
    await screen.findByRole("heading", { level: 2, name: "EU production" });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit variable group" });
    const description = within(dialog).getByLabelText("Description (optional)");
    await user.type(description, "!");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(VARIABLES_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    // The page read again behind the dialog, and shows the renamed group.
    // (The dialog hides the page from the accessibility tree: `hidden` finds it there.)
    expect(await screen.findByRole("heading", { level: 2, name: "Renamed elsewhere", hidden: true })).toBeInTheDocument();

    expect(within(dialog).getByLabelText("Name")).toHaveValue("EU production");
    expect(description).toHaveValue("Europe's collectors!");
    // Typed back to the opening's text, nothing changed against the opening: Save waits.
    await user.clear(description);
    await user.type(description, "Europe's collectors");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(GROUP_ID, VARIABLE_GROUP_ID, { description: "Europe's collectors!" }, expect.anything());
  });
});
