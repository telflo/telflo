import { createRoutesStub, useLocation } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import routes from "~/routes.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import { SAMPLE_CONFIGURATION_IDS } from "~/lib/playground/sample/index.js";
import { PLAYGROUND_TITLES } from "~/lib/playground/meta.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { metaArgs } from "~/test/meta.js";
import PlaygroundLayout, { meta as layoutMeta } from "./playground.js";
import PlaygroundConfigurations, { DELETE_LOCKED_ACTION, meta as configurationsMeta } from "./playground._index.js";
import { meta as editorMeta } from "./playground.editor.js";
import PlaygroundFleet, { meta as fleetMeta } from "./playground.fleet-management.$fleetId.js";
import { loader as k8sRedirect } from "./playground.fleet-management.k8s.$fleetId.js";
import { loader as serverRedirect } from "./playground.fleet-management.server.$fleetId.js";
import PlaygroundFleets, { meta as fleetsMeta } from "./playground.fleet-management.js";
import PlaygroundFlow, { meta as flowMeta } from "./playground.flows.$slug.js";
import PlaygroundFlows, { meta as flowsMeta } from "./playground.flows.js";
import { meta as publicEditorMeta } from "./public-editor.js";

/*
 * The playground's routes (D31-1 decisions 8, 17, 25 and 32; Preflight ruling
 * 15): registered outside the signed-in layout, each with its own fixed title
 * and canonical; the configurations page on the sample, read through the
 * seam, never the API; the per-kind fleet paths redirecting to the one fleet
 * page. The other pages are tested in their own files, inside the shell, with
 * their reads stubbed (a render here would send the flows page's open read
 * from jsdom).
 */

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPlayground(path = "/playground") {
  const Stub = createRoutesStub([
    {
      path: "/playground",
      Component: PlaygroundLayout,
      children: [
        { index: true, Component: PlaygroundConfigurations },
        { path: "flows", Component: PlaygroundFlows },
        { path: "flows/:slug", Component: PlaygroundFlow },
        { path: "fleet-management", Component: PlaygroundFleets },
        { path: "fleet-management/:fleetId", Component: PlaygroundFleet },
      ],
    },
    { path: "/playground/editor/:configurationId?", Component: Where },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

const NAMES = [
  "K8s Production Gateway",
  "Host Metrics — Linux Fleet",
  "Tail Sampling — Traces",
  "Frontend RUM Logs",
  "Span Metrics — RED",
  "K8s Node Agent",
  "PII Masking — Redaction",
  "Cost Filters — OTTL",
  "Backend Migration — Dual Ship",
  "edge-import-pilot (imported)",
];

const cardNames = () => screen.queryAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  useUserStore.getState().clear();
  document.body.className = "";
});

describe("the routes (decision 25)", () => {
  /** The route config's entries with their paths, nested ones under their parent's. */
  function paths(entries: ReadonlyArray<{ path?: string; index?: boolean; file: string; children?: unknown }>, parent = ""): Array<[string, string]> {
    return entries.flatMap((entry) => {
      const path = entry.index ? parent : [parent, entry.path].filter(Boolean).join("/");
      const self: Array<[string, string]> = [[path, entry.file]];
      return [...self, ...paths((entry.children ?? []) as typeof entries, path)];
    });
  }

  it("registers the playground's pages, its editor and the public editor outside the signed-in layout", () => {
    const topLevel = paths(routes.filter((entry) => entry.file !== "routes/app-layout.tsx"));
    expect(topLevel).toEqual(
      expect.arrayContaining([
        ["playground", "routes/playground.tsx"],
        ["playground", "routes/playground._index.tsx"],
        ["playground/flows", "routes/playground.flows.tsx"],
        ["playground/flows/:slug", "routes/playground.flows.$slug.tsx"],
        ["playground/fleet-management", "routes/playground.fleet-management.tsx"],
        ["playground/fleet-management/server/:fleetId", "routes/playground.fleet-management.server.$fleetId.tsx"],
        ["playground/fleet-management/k8s/:fleetId", "routes/playground.fleet-management.k8s.$fleetId.tsx"],
        ["playground/fleet-management/:fleetId", "routes/playground.fleet-management.$fleetId.tsx"],
        ["playground/editor/:configurationId?", "routes/playground.editor.tsx"],
        ["public-editor", "routes/public-editor.tsx"],
      ]),
    );
    const signedIn = paths(routes.filter((entry) => entry.file === "routes/app-layout.tsx"));
    expect(signedIn.some(([path]) => path.startsWith("playground") || path.startsWith("public-editor"))).toBe(false);
  });

  it.each([
    ["server", serverRedirect],
    ["k8s", k8sRedirect],
  ])("redirects the %s fleet path to the one fleet page", (_kind, loader) => {
    let thrown: unknown;
    try {
      loader({ params: { fleetId: "0199a000-0000-7000-8000-000000000001" } } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe("/playground/fleet-management/0199a000-0000-7000-8000-000000000001");
  });
});

describe("the head (decision 17)", () => {
  const BASE = "https://telflo.example";
  it.each([
    ["the layout", () => layoutMeta(metaArgs<typeof layoutMeta>(BASE)), PLAYGROUND_TITLES.configurations, "/playground"],
    ["the configurations", () => configurationsMeta(metaArgs<typeof configurationsMeta>(BASE)), PLAYGROUND_TITLES.configurations, "/playground"],
    ["the flows", () => flowsMeta(metaArgs<typeof flowsMeta>(BASE)), PLAYGROUND_TITLES.flows, "/playground/flows"],
    [
      "a flow",
      () => flowMeta({ ...metaArgs<typeof flowMeta>(BASE), params: { slug: "log-volume-cost-control" } } as never),
      PLAYGROUND_TITLES.flow,
      "/playground/flows/log-volume-cost-control",
    ],
    ["the fleets", () => fleetsMeta(metaArgs<typeof fleetsMeta>(BASE)), PLAYGROUND_TITLES.fleets, "/playground/fleet-management"],
    [
      "a fleet",
      () => fleetMeta({ ...metaArgs<typeof fleetMeta>(BASE), params: { fleetId: "abc" } } as never),
      PLAYGROUND_TITLES.fleet,
      "/playground/fleet-management/abc",
    ],
    ["the editor", () => editorMeta(metaArgs<typeof editorMeta>(BASE)), PLAYGROUND_TITLES.editor, "/playground/editor"],
    // A sample's editor has the blank editor's canonical (Ruling 304).
    [
      "a sample's editor",
      () => editorMeta({ ...metaArgs<typeof editorMeta>(BASE), params: { configurationId: SAMPLE_CONFIGURATION_IDS.cost } } as never),
      PLAYGROUND_TITLES.editor,
      "/playground/editor",
    ],
    ["the public editor", () => publicEditorMeta(metaArgs<typeof publicEditorMeta>(BASE)), PLAYGROUND_TITLES.publicEditor, "/public-editor"],
  ])("%s: its own fixed title and canonical", (_page, meta, title, path) => {
    const tags = meta();
    expect(tags).toContainEqual({ title });
    expect(tags).toContainEqual({ property: "og:title", content: title });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: `${BASE}${path}` });
    expect(tags).toContainEqual({ property: "og:url", content: `${BASE}${path}` });
  });

  it("names each page's fixed title", () => {
    expect(PLAYGROUND_TITLES.configurations).toBe("Playground - Telflo");
    expect(PLAYGROUND_TITLES.editor).toBe("Playground Editor - Telflo");
    expect(PLAYGROUND_TITLES.publicEditor).toBe("Public Editor - Telflo");
  });

  it("has no canonical without the public URL", () => {
    expect(configurationsMeta(metaArgs<typeof configurationsMeta>(null)).some((tag) => "rel" in tag)).toBe(false);
  });
});

describe("the configurations page (decision 32)", () => {
  it("lists the sample's ten through the seam, never the API, with their count", async () => {
    const spies = spyOnTheClient();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    expect([...cardNames()].sort()).toEqual([...NAMES].sort());
    const header = screen.getByRole("heading", { level: 1, name: "Configurations" }).parentElement!;
    expect(within(header).getByText("10")).toBeInTheDocument();
    // The distribution tags name the build-time catalogue's label.
    expect(screen.getAllByTitle(/^Built for OpenTelemetry Collector Contrib/).length).toBe(10);
    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });

  it("lists the sample even for a signed-in visitor", async () => {
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
  });

  it("searches in the browser, inside ph-no-capture, the address unchanged", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    const search = screen.getByRole("searchbox", { name: "Search configurations" });
    expect(search.closest(".ph-no-capture")).not.toBeNull();
    await user.type(search, "ottl");
    expect(cardNames()).toEqual(["Cost Filters — OTTL"]);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "nothing like this");
    expect(screen.getByText("Nothing matches your search or filter.")).toBeInTheDocument();
  });

  it("filters Mine and Published in the browser", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    await user.click(screen.getByRole("combobox", { name: "Filter" }));
    await user.click(await screen.findByRole("option", { name: "Mine" }));
    expect(cardNames()).toHaveLength(8);
    expect(cardNames()).not.toContain("Frontend RUM Logs");
    expect(cardNames()).not.toContain("PII Masking — Redaction");
    await user.click(screen.getByRole("combobox", { name: "Filter" }));
    await user.click(await screen.findByRole("option", { name: "Published" }));
    expect(cardNames()).toHaveLength(8);
    expect(cardNames()).not.toContain("Tail Sampling — Traces");
    expect(cardNames()).not.toContain("Backend Migration — Dual Ship");
  });

  it("switches to the table", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    await user.click(screen.getByTitle("List view"));
    expect(screen.getAllByRole("row")).toHaveLength(11);
  });

  it("opens New configuration in the blank playground editor", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await user.click(screen.getByRole("button", { name: "New configuration" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/playground\/editor$/);
  });

  it("opens a card in the playground editor on it", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    await user.click(screen.getByRole("heading", { level: 3, name: "Cost Filters — OTTL" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(`/playground/editor/${SAMPLE_CONFIGURATION_IDS.cost}`);
  });

  it("locks Delete: the sign-up prompt, with its words", async () => {
    const user = userEvent.setup();
    renderPlayground();
    await waitFor(() => expect(cardNames()).toHaveLength(10));
    await user.click(screen.getAllByTitle("Delete")[0]!);
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(DELETE_LOCKED_ACTION))).toBeInTheDocument();
    // Nothing was deleted (the page behind the dialog is hidden from the accessibility tree).
    expect(document.querySelectorAll("h3")).toHaveLength(10);
  });
});
