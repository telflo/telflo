/**
 * The editor page, `/editor/{id}/{versionId}` and `/editor/{id}`, under the
 * signed-in layout as the app routes it.
 *
 * Monaco is stubbed, as in YamlEditor's test: the stub renders the text as
 * text, as Monaco does, records the command Monaco registers for Cmd/Ctrl+S,
 * and `typeInMonaco` stands for typing. The browser tests cover the real
 * Monaco.
 */

import { StrictMode, useEffect } from "react";
import type { EditorProps } from "@monaco-editor/react";
import type {
  Configuration,
  ConfigurationVersion,
  ConfigurationVersionResponse,
  ConfigurationWithVersionResponse,
  CurrentUserResponse,
} from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Link, useLocation, useNavigate, useRevalidator, type NavigateFunction } from "react-router";
import { toast } from "sonner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const fake = vi.hoisted(() => ({
  props: null as EditorProps | null,
  commands: [] as (() => void)[],
  mounted: false,
}));

const monaco = {
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  MarkerSeverity: { Error: 8 },
  editor: {
    defineTheme: () => undefined,
    onDidChangeMarkers: () => ({ dispose: () => undefined }),
    getModelMarkers: () => [],
  },
};

/** Monaco's model: the text it holds, which a store-set text is written into as an edit (YamlEditor). */
const monacoModel = {
  uri: "inmemory://model/1",
  value: "",
  // The tab size goes on the model (YamlEditor; D21 Preflight ruling 30).
  updateOptions: () => undefined,
  getValue: () => monacoModel.value,
  getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  pushStackElement: () => undefined,
  // A load under the mounted editor sets the text afresh (YamlEditor; D10 Ruling 22), firing the change event.
  setValue: (value: string) => {
    monacoModel.value = value;
    fake.props?.onChange?.(monacoModel.value, undefined as never);
  },
};

const monacoEditor = {
  getModel: () => monacoModel,
  addCommand: (_keybinding: number, handler: () => void) => {
    fake.commands.push(handler);
    return null;
  },
  // An edit fires Monaco's change event, as the real one does.
  executeEdits: (_source: string, edits: { text: string }[]) => {
    monacoModel.value = edits[0]!.text;
    fake.props?.onChange?.(monacoModel.value, undefined as never);
    return true;
  },
  saveViewState: () => null,
  restoreViewState: () => undefined,
  // The editor preferences let go of the editor when it is disposed (use-editor-preferences.ts).
  onDidDispose: () => ({ dispose: () => undefined }),
};

vi.mock("@monaco-editor/react", () => ({
  default: function MonacoStub(props: EditorProps) {
    fake.props = props;
    useEffect(() => {
      monacoModel.value = props.value ?? "";
      props.beforeMount?.(monaco as never);
      props.onMount?.(monacoEditor as never, monaco as never);
      fake.mounted = true;
      return () => {
        fake.mounted = false;
        fake.commands = [];
      };
      // Once, as Monaco mounts once.
    }, []);
    return <div data-testid="monaco-stub">{props.value}</div>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));
// The tour's own tests drive driver.js; here, only when the page starts and stops it.
const tour = vi.hoisted(() => ({ completed: false, starts: 0, stops: 0 }));
vi.mock("~/components/editor/builder/tour/start-editor-tour.js", () => ({
  isTourCompleted: () => tour.completed,
  startEditorTour: () => {
    tour.starts++;
    return () => {
      tour.stops++;
    };
  },
}));
vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import { SAAS_SITE, underSite } from "~/test/site.js";
import EditorRoute, { meta } from "./editor.js";
import * as editorLayout from "~/components/editor/EditorLayout.js";
import { UnsavedChangesDialog } from "~/components/editor/UnsavedChangesDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { ApiError } from "~/lib/api-client.js";
import { layoutSignature } from "~/lib/graph/canvas-operations.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { parse } from "~/lib/graph/parse.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { selectIsDirty, selectIsVersionPublished, summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { CATALOGUE } from "~/test/collector-distributions.js";
import {
  GROUP_ID,
  MEMBER_EMAIL,
  MINE,
  PERSONAL_ID,
  PUBLISHED_FIELDS,
  THEIRS,
  answerFor,
  signedInMember,
  versionFixture,
  versionSummaryOf,
} from "~/test/configurations.js";
import { installReactFlowMocks } from "~/test/react-flow-jsdom.js";

const YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const EDITED = `${YAML}# edited\n`;

const VERSION = versionFixture({ yamlContent: YAML });

/**
 * The graph a save sends: the one on the canvas, as stored (D9a decision 6).
 * Typing leaves it as it was loaded: the text's graph, laid out, since the
 * version stores none.
 */
const LOADED_GRAPH = (() => {
  const parsed = parse(YAML);
  if (!parsed.ok) throw new Error("The fixture's YAML doesn't read.");
  return toStored(parsed.graph);
})();

const THEIR_VERSION: ConfigurationVersion = {
  ...VERSION,
  id: "0199c000-0000-7000-8000-000000000002",
  configurationId: THEIRS.id,
  yamlContent: "exporters: {}\n",
};

const initialEditorState = useEditorStore.getState();

/** Where the page went, for the list's address. */
function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/** The page's router's navigate, for a navigation no click makes (Back, a programmatic one). */
let navigateInPage: NavigateFunction | null = null;

/**
 * The page, with two controls of the test's own: one revalidates the layout
 * (a switch or a removal elsewhere is seen that way), the other opens
 * another configuration without leaving the route. The address is shown,
 * for the replace.
 */
function EditorWithControls() {
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    navigateInPage = navigate;
  }, [navigate]);
  return (
    <>
      <button type="button" onClick={() => void revalidate()}>
        Revalidate
      </button>
      <Link to={`/editor/${THEIRS.id}`}>Open another</Link>
      <p data-testid="address">{pathname}</p>
      <EditorRoute />
    </>
  );
}

/**
 * The page under the signed-in layout, at the version's address by default
 * (D10 Preflight ruling 4: `/editor/{id}`'s replace is another navigation,
 * which the layout's loader would count). The layout's loader answers each
 * load with the next of `answers`, the last repeating.
 */
function renderPage(
  answers: CurrentUserResponse[] = [signedInMember()],
  {
    path = `/editor/${MINE.id}/${VERSION.id}`,
    strict = false,
    before,
  }: { path?: string; strict?: boolean; /** An entry in the history before the page, for Back. */ before?: string } = {},
) {
  const pending = [...answers];
  const layoutLoader = vi.fn(
    (): AppLayoutData => ({ status: "signed_in", currentUser: (pending.length > 1 ? pending.shift() : pending[0])! }),
  );
  const Stub = createRoutesStub(underSite(SAAS_SITE, [
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: layoutLoader,
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        { path: "/editor/:configurationId/:versionId?", Component: EditorWithControls },
        { path: "/app", Component: Landed },
      ],
    },
    { path: "/login", Component: Landed },
  ]));
  const stub = <Stub initialEntries={before === undefined ? [path] : [before, path]} initialIndex={before === undefined ? 0 : 1} />;
  const { unmount } = render(strict ? <StrictMode>{stub}</StrictMode> : stub);
  return { layoutLoader, user: userEvent.setup(), unmount };
}

type Getter = (organizationId: string, configurationId: string) => ConfigurationWithVersionResponse | Promise<ConfigurationWithVersionResponse>;

/**
 * The API's configuration, answered by `answer`; MINE and its version by
 * default. Both reads answer it, `/editor/{id}`'s and
 * `/editor/{id}/{versionId}`'s, and the spy returned records each as
 * (organizationId, configurationId); the version's own tests spy on each.
 */
function serveConfiguration(answer: Getter = () => answerFor(MINE, VERSION)) {
  const reads = vi.fn(async (organizationId: string, configurationId: string) => answer(organizationId, configurationId));
  vi.spyOn(apiClient, "getConfiguration").mockImplementation(reads);
  vi.spyOn(apiClient, "getConfigurationVersion").mockImplementation((organizationId, configurationId) =>
    reads(organizationId, configurationId),
  );
  return reads;
}

/** A request the test answers when it chooses. */
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Waits for the page to show the configuration, and for the stubbed Monaco to mount. */
async function loaded(name = MINE.name) {
  const heading = await screen.findByRole("heading", { level: 1, name });
  await screen.findByTestId("monaco-stub");
  await waitFor(() => expect(fake.mounted).toBe(true));
  return heading;
}

/** Typing in Monaco: its model holds the new text, and its onChange says so. */
function typeInMonaco(text: string) {
  act(() => {
    monacoModel.value = text;
    fake.props!.onChange?.(text, undefined as never);
  });
}

/** A save's answer: the version with the text that was sent. */
function saving(implementation?: (yamlContent: string) => Promise<ConfigurationVersionResponse>) {
  return vi
    .spyOn(apiClient, "saveConfigurationVersion")
    .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent }) =>
      implementation
        ? implementation(yamlContent)
        : { version: { ...VERSION, yamlContent, updatedAt: "2026-09-28T12:00:00.000Z" } },
    );
}

async function acceptTerms(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Updated Terms of Service" });
  await user.click(within(dialog).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
  await user.click(within(dialog).getByRole("button", { name: "Accept" }));
}

describe("the editor page (/editor/{id}/{versionId})", () => {
  /** The selection's write (D10 decision 9), answered at once unless a test says otherwise. */
  let selectConfigurationVersion: MockInstance<typeof apiClient.selectConfigurationVersion>;
  /** The collector catalogue's read (D13a decision 8), answered at once. */
  let readCatalogue: MockInstance<typeof apiClient.getCollectorDistributions>;
  /**
   * The collector validator's check (D13b decision 13), answered valid at
   * once for the pin it was sent (as the API answers; Ruling 58) unless a
   * test says otherwise.
   */
  let validateVersion: MockInstance<typeof apiClient.validateVersion>;

  beforeEach(() => {
    vi.restoreAllMocks();
    // The Testing tab, kept mounted, reads the version's runs (D14a Task 10): none here.
    vi.spyOn(apiClient, "getTestRuns").mockResolvedValue({ runs: [] });
    // The builder's fields read the organization's variables' names once, for their $ picker (D20 Task 13): none here.
    forgetOrgVariableNames();
    vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([]);
    selectConfigurationVersion = vi.spyOn(apiClient, "selectConfigurationVersion").mockResolvedValue(undefined);
    resetCollectorCatalogue();
    readCatalogue = vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
    validateVersion = vi
      .spyOn(apiClient, "validateVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, request) => ({
        status: "valid",
        collectorVersion: request.collectorVersion ?? VERSION.collectorVersion,
        errors: [],
        requirements: [],
      }));
    useUserStore.getState().clear();
    useEditorStore.setState(initialEditorState, true);
    // D8's tests work in the YAML tab, which Configuration now precedes: the
    // panel remembers the tab, as a person's would (Preflight ruling 7). The
    // builder's own tests ("the builder", below) open on Configuration.
    useEditorStore.setState({ activeTab: "yaml" });
    fake.props = null;
    fake.commands = [];
    fake.mounted = false;
    Object.assign(tour, { completed: false, starts: 0, stops: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is /editor/:configurationId/:versionId? under the signed-in layout, one route", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const editors = layout?.children?.filter((route) => route.file === "routes/editor.tsx");
    expect(editors?.map((route) => route.path)).toEqual(["editor/:configurationId/:versionId?"]);
  });

  it("titles the page", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([
      { title: "Edit Configuration - Telflo" },
      { name: "description", content: "Visual editor for OpenTelemetry Collector configurations" },
    ]);
  });

  describe("loading", () => {
    it("shows the loading state, then the name, the YAML in its tab and the canvas", async () => {
      const answer = deferred<ConfigurationWithVersionResponse>();
      const getConfiguration = serveConfiguration(() => answer.promise);
      renderPage();

      expect(await screen.findByText("Loading configuration…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(getConfiguration).toHaveBeenCalledWith(PERSONAL_ID, MINE.id);

      await act(async () => answer.resolve(answerFor(MINE, VERSION)));

      await loaded();
      expect(screen.queryByText("Loading configuration…")).toBeNull();
      expect(screen.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
      expect(document.querySelector('[data-tour-step="canvas"] .react-flow')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.queryByText("Unsaved")).toBeNull();
      // The wrapper around the YAML tab, so Monaco fills it.
      expect(screen.getByTestId("monaco-stub").closest(".flex-1.min-h-0.overflow-hidden")).not.toBeNull();
      const state = useEditorStore.getState();
      expect(state.configuration).toEqual(MINE);
      expect(state.version).toEqual(VERSION);
      expect(state.organizationId).toBe(PERSONAL_ID);
      expect(getConfiguration).toHaveBeenCalledTimes(1);
    });

    it("reads the collector catalogue once for the page, and the toolbar shows the distribution, locked, and the version's pin (D13a decision 8)", async () => {
      serveConfiguration();
      renderPage();

      await loaded();
      expect(await screen.findByRole("combobox", { name: /collector version/i })).toHaveTextContent(/^v0\.162\.0$/);
      expect(screen.getByLabelText("Distribution: Otel Contrib (locked at creation)")).toBeInTheDocument();
      expect(readCatalogue).toHaveBeenCalledOnce();
    });

    it("checks the opened version's text at once with the collector validator, and the YAML tab's bar shows the answer (D13b decision 13)", async () => {
      serveConfiguration();
      renderPage();

      await loaded();
      await waitFor(() => expect(validateVersion).toHaveBeenCalledOnce());
      // With the pin on screen, always (Ruling 57).
      expect(validateVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yaml: YAML,
        collectorVersion: VERSION.collectorVersion,
      }, { signal: expect.any(AbortSignal) });
      expect(await screen.findByText(`config valid · v${VERSION.collectorVersion}`)).toBeInTheDocument();
    });

    it('shows "Configuration not found" for a 404, with no toast, and "Back to configurations" goes to /app', async () => {
      serveConfiguration(() => {
        throw new ApiError("configuration_not_found", "Configuration not found");
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();

      expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(error).not.toHaveBeenCalled();
      const back = screen.getByRole("link", { name: "Back to configurations" });
      expect(back).toHaveAttribute("href", "/app");

      await user.click(back);
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    });

    it.each([
      ["not a UUID", "not-a-uuid"],
      ["a path segment", ".."],
      ["a UUID without its hyphens", "0199a0000000700080000000000000001"],
      ["a UUID in braces", `{${MINE.id}}`],
    ])('shows "Configuration not found" for an id that is %s, and sends nothing (Preflight ruling 17)', async (_why, id) => {
      const getConfiguration = serveConfiguration();
      renderPage([signedInMember()], { path: `/editor/${encodeURIComponent(id)}` });

      expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to configurations" })).toHaveAttribute("href", "/app");
      expect(getConfiguration).not.toHaveBeenCalled();
    });

    it("asks for an uppercase UUID, which is canonical, and keeps it as typed when it names the version (D10 Preflight ruling 5)", async () => {
      const getConfiguration = serveConfiguration();
      renderPage([signedInMember()], { path: `/editor/${MINE.id.toUpperCase()}` });

      await loaded();
      expect(getConfiguration).toHaveBeenCalledWith(PERSONAL_ID, MINE.id.toUpperCase());
      await waitFor(() =>
        expect(screen.getByTestId("address")).toHaveTextContent(`/editor/${MINE.id.toUpperCase()}/${VERSION.id}`),
      );
      await loaded();
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(useEditorStore.getState().loadCount).toBe(1);
    });

    it("toasts nothing when the load finds the session over (401 unauthenticated), and says so in the page (D12 Ruling 39)", async () => {
      serveConfiguration(() => {
        throw new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
      });
      const error = vi.spyOn(toast, "error");
      renderPage();

      expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByText("Failed to load configuration")).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();
    });

    it("toasts the failure message when the load fails, says so in the page, and Try again loads again", async () => {
      let fail = true;
      const getConfiguration = serveConfiguration(() => {
        if (fail) throw new ApiError("internal_error", "Something went wrong. Please try again.");
        return answerFor(MINE, VERSION);
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();

      const tryAgain = await screen.findByRole("button", { name: "Try again" });
      expect(screen.getByText("Failed to load configuration")).toBeInTheDocument();
      expect(screen.queryByText("Configuration not found")).toBeNull();
      expect(screen.getByRole("link", { name: "Back to configurations" })).toBeInTheDocument();
      expect(error).toHaveBeenCalledWith("Failed to load configuration");
      expect(error).toHaveBeenCalledTimes(1);

      fail = false;
      await user.click(tryAgain);

      await loaded();
      expect(getConfiguration).toHaveBeenCalledTimes(2);
    });

    it("ignores an older response that arrives late", async () => {
      const personal = deferred<ConfigurationWithVersionResponse>();
      const group = deferred<ConfigurationWithVersionResponse>();
      const getConfiguration = serveConfiguration((organizationId) =>
        organizationId === PERSONAL_ID ? personal.promise : group.promise,
      );
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await waitFor(() => expect(getConfiguration).toHaveBeenCalledWith(PERSONAL_ID, MINE.id));

      // The organization changes while the first load is under way.
      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(getConfiguration).toHaveBeenLastCalledWith(GROUP_ID, MINE.id));
      await act(async () => group.resolve(answerFor({ ...MINE, name: "The group's answer" }, VERSION)));
      await act(async () =>
        personal.resolve(answerFor({ ...MINE, name: "The late answer" }, { ...VERSION, yamlContent: "late: true\n" })),
      );

      await loaded("The group's answer");
      expect(screen.queryByText("The late answer")).toBeNull();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
      expect(useEditorStore.getState().organizationId).toBe(GROUP_ID);
    });

    it("shows only the latest load's answer under StrictMode's double effects", async () => {
      const firstRun = deferred<ConfigurationWithVersionResponse>();
      let calls = 0;
      const getConfiguration = serveConfiguration(() => {
        calls += 1;
        return calls === 1 ? firstRun.promise : answerFor(MINE, VERSION);
      });
      renderPage([signedInMember()], { strict: true });

      await loaded();
      expect(getConfiguration.mock.calls.length).toBeGreaterThanOrEqual(2);
      await act(async () => firstRun.resolve(answerFor({ ...MINE, name: "Overtaken" }, VERSION)));

      expect(screen.queryByText("Overtaken")).toBeNull();
      expect(screen.getByRole("heading", { level: 1, name: MINE.name })).toBeInTheDocument();
    });

    it("opens another configuration in its place, forgetting the first, and ignores the first's late answer", async () => {
      const mine = deferred<ConfigurationWithVersionResponse>();
      serveConfiguration((_organizationId, configurationId) =>
        configurationId === MINE.id ? mine.promise : answerFor(THEIRS, THEIR_VERSION),
      );
      const { user } = renderPage();
      await screen.findByText("Loading configuration…");

      await user.click(screen.getByRole("link", { name: "Open another" }));
      await loaded(THEIRS.name);
      await act(async () => mine.resolve(answerFor(MINE, VERSION)));

      expect(screen.getByRole("heading", { level: 1, name: THEIRS.name })).toBeInTheDocument();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(THEIR_VERSION.yamlContent);
      expect(useEditorStore.getState().configuration).toEqual(THEIRS);
    });

    it("resets the store when another configuration opens, once its unsaved text is discarded, and when the page is left", async () => {
      const theirs = deferred<ConfigurationWithVersionResponse>();
      serveConfiguration((_organizationId, configurationId) =>
        configurationId === MINE.id ? answerFor(MINE, VERSION) : theirs.promise,
      );
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      // Another configuration is another path: the guard holds it (decision 15).
      await user.click(screen.getByRole("link", { name: "Open another" }));
      const held = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });
      await user.click(within(held).getByRole("button", { name: "Discard Changes" }));
      expect(await screen.findByText("Loading configuration…")).toBeInTheDocument();
      expect(useEditorStore.getState().configuration).toBeNull();
      expect(useEditorStore.getState().text).toBe("");
      await act(async () => theirs.resolve(answerFor(THEIRS, THEIR_VERSION)));
      await loaded(THEIRS.name);
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      const state = useEditorStore.getState();
      expect(state.configuration).toBeNull();
      expect(state.version).toBeNull();
      expect(state.organizationId).toBeNull();
      expect(state.text).toBe("");
    });
  });

  describe("the organization (Preflight ruling 4)", () => {
    it("loads again when the active organization changes while the editor is clean", async () => {
      const group = deferred<ConfigurationWithVersionResponse>();
      const getConfiguration = serveConfiguration((organizationId) =>
        organizationId === PERSONAL_ID ? answerFor(MINE, VERSION) : group.promise,
      );
      const { user, layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();

      // A switch in another tab, seen when the layout revalidates.
      await user.click(screen.getByRole("button", { name: "Revalidate" }));

      await waitFor(() => expect(getConfiguration).toHaveBeenLastCalledWith(GROUP_ID, MINE.id));
      // The page asked the layout once more before reloading, and the
      // answer still said the group.
      expect(layoutLoader).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Loading configuration…")).toBeInTheDocument();

      await act(async () => group.reject(new ApiError("configuration_not_found", "Configuration not found")));
      expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
      expect(useEditorStore.getState().configuration).toBeNull();
    });

    it("the reload in the new organization, of the same text and pin, is checked at once: never stuck at validating (Ruling 57)", async () => {
      serveConfiguration(() => answerFor(MINE, VERSION));
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();
      expect(await screen.findByText(`config valid · v${VERSION.collectorVersion}`)).toBeInTheDocument();
      const { loadCount } = useEditorStore.getState();

      await user.click(screen.getByRole("button", { name: "Revalidate" }));

      await waitFor(() => expect(useEditorStore.getState().loadCount).toBe(loadCount + 1));
      expect(useEditorStore.getState().organizationId).toBe(GROUP_ID);
      await loaded();
      await waitFor(() => expect(validateVersion).toHaveBeenCalledTimes(2));
      expect(validateVersion).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, VERSION.id, {
        yaml: YAML,
        collectorVersion: VERSION.collectorVersion,
      }, { signal: expect.any(AbortSignal) });
      expect(await screen.findByText(`config valid · v${VERSION.collectorVersion}`)).toBeInTheDocument();
      expect(screen.queryByText("validating config…")).toBeNull();
    });

    it("never loads over unsaved text when the active organization changes, and saves still name the organization it was loaded in", async () => {
      const getConfiguration = serveConfiguration();
      const saveConfigurationVersion = saving(async () => {
        throw new ApiError("organization_not_found", "Organization not found");
      });
      const { user, layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(layoutLoader).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));

      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(useEditorStore.getState().organizationId).toBe(PERSONAL_ID);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(saveConfigurationVersion).toHaveBeenCalledTimes(1));
      expect(saveConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yamlContent: EDITED,
        ...LOADED_GRAPH,
      });
    });

    it("loads again in the new organization once the editor is clean, when it changed while the editor was dirty", async () => {
      const group = deferred<ConfigurationWithVersionResponse>();
      const getConfiguration = serveConfiguration((organizationId) =>
        organizationId === PERSONAL_ID ? answerFor(MINE, VERSION) : group.promise,
      );
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();
      typeInMonaco(EDITED);

      // A switch in another tab while dirty: nothing loads over the text.
      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));
      expect(getConfiguration).toHaveBeenCalledTimes(1);

      // Typed back to the saved text: clean, so the page may load again, and
      // does, for the organization the session now works in.
      typeInMonaco(YAML);

      await waitFor(() => expect(getConfiguration).toHaveBeenLastCalledWith(GROUP_ID, MINE.id));
      expect(getConfiguration).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Loading configuration…")).toBeInTheDocument();
      await act(async () => group.reject(new ApiError("configuration_not_found", "Configuration not found")));
      expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
      expect(useEditorStore.getState().organizationId).toBeNull();
    });

    it("keeps an organization change seen while dirty from loading after the switch back, while still dirty", async () => {
      const getConfiguration = serveConfiguration();
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID), signedInMember(PERSONAL_ID)]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));
      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(PERSONAL_ID));
      // Back where it was loaded: clean again, nothing to load.
      typeInMonaco(YAML);
      typeInMonaco(EDITED);

      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(useEditorStore.getState().organizationId).toBe(PERSONAL_ID);
    });

    it("keeps the text through the revalidation after a save refused with organization_not_found", async () => {
      const getConfiguration = serveConfiguration();
      saving(async () => {
        throw new ApiError("organization_not_found", "Organization not found");
      });
      const error = vi.spyOn(toast, "error");
      const { user, layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          "This configuration belongs to another organization than the one you're working in. Copy your changes, or switch back to it in another tab.",
        ),
      );
      await waitFor(() => expect(layoutLoader).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("checks the session's organization before reloading, and keeps the editor after a save succeeds in a tab whose /me is stale", async () => {
      // The configuration is only in the personal organization; the group
      // refuses it as another organization's.
      const getConfiguration = serveConfiguration((organizationId) => {
        if (organizationId === GROUP_ID) throw new ApiError("organization_not_found", "Organization not found");
        return answerFor(MINE, VERSION);
      });
      let switchedBack = false;
      saving(async (yamlContent) => {
        if (!switchedBack) throw new ApiError("organization_not_found", "Organization not found");
        return { version: { ...VERSION, yamlContent, updatedAt: "2026-09-28T12:00:00.000Z" } };
      });
      const success = vi.spyOn(toast, "success");
      // Loaded in the personal organization; the refused save's revalidation
      // finds the group (switched to in another tab); after that, the other
      // tab switched back, which this tab isn't told.
      const { user, layoutLoader } = renderPage([
        signedInMember(PERSONAL_ID),
        signedInMember(GROUP_ID),
        signedInMember(PERSONAL_ID),
      ]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      const monacoBefore = screen.getByTestId("monaco-stub");

      switchedBack = true;
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(success).toHaveBeenCalledWith("Saved configuration"));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(PERSONAL_ID));
      await loaded();
      await act(async () => {});

      // One revalidation, which says the session is back where the
      // configuration was loaded: nothing reloads, and the editor stays.
      expect(layoutLoader).toHaveBeenCalledTimes(3);
      expect(getConfiguration.mock.calls.map(([organizationId]) => organizationId)).toEqual([PERSONAL_ID]);
      expect(useEditorStore.getState().loadCount).toBe(1);
      expect(screen.getByTestId("monaco-stub")).toBe(monacoBefore);
      expect(monacoBefore.isConnected).toBe(true);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(useEditorStore.getState().organizationId).toBe(PERSONAL_ID);
    });

    it("never reloads over text typed while it checks the session's organization, and checks again once clean", async () => {
      const group = deferred<ConfigurationWithVersionResponse>();
      const getConfiguration = serveConfiguration((organizationId) =>
        organizationId === PERSONAL_ID ? answerFor(MINE, VERSION) : group.promise,
      );
      const { user, layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();
      // The switch's revalidation answers at once; the check that follows
      // answers when the test says.
      const check = deferred<AppLayoutData>();
      layoutLoader
        .mockImplementationOnce(() => ({ status: "signed_in", currentUser: signedInMember(GROUP_ID) }))
        .mockImplementationOnce((() => check.promise) as never);

      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(layoutLoader).toHaveBeenCalledTimes(3));
      expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
      typeInMonaco(EDITED);
      await act(async () => check.resolve({ status: "signed_in", currentUser: signedInMember(GROUP_ID) }));

      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();

      // Clean again: the page asks once more, and the answer still says the group.
      typeInMonaco(YAML);
      await waitFor(() => expect(getConfiguration).toHaveBeenLastCalledWith(GROUP_ID, MINE.id));
      expect(layoutLoader).toHaveBeenCalledTimes(4);
      expect(getConfiguration).toHaveBeenCalledTimes(2);
      await act(async () => group.resolve(answerFor(MINE, VERSION)));
      await loaded();
      expect(useEditorStore.getState().organizationId).toBe(GROUP_ID);
      expect(layoutLoader).toHaveBeenCalledTimes(4);
    });

    it("on a 404 organization_not_found while loading, revalidates the layout and loads in the session's organization, with no toast", async () => {
      const getConfiguration = serveConfiguration((organizationId) => {
        if (organizationId === PERSONAL_ID) throw new ApiError("organization_not_found", "Organization not found");
        return answerFor(MINE, VERSION);
      });
      const error = vi.spyOn(toast, "error");
      const { layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);

      await loaded();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(getConfiguration).toHaveBeenLastCalledWith(GROUP_ID, MINE.id);
      expect(useEditorStore.getState().organizationId).toBe(GROUP_ID);
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("the terms", () => {
    it("loads nothing while the terms need accepting, and loads once they are accepted", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      const getConfiguration = serveConfiguration();
      const { user } = renderPage([signedInMember(PERSONAL_ID, true), signedInMember(PERSONAL_ID, false)]);

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(screen.getByText("Loading configuration…")).toBeInTheDocument();
      expect(getConfiguration).not.toHaveBeenCalled();

      await acceptTerms(user);

      await loaded();
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("on a 403 terms_acceptance_required while loading, revalidates, waits for the dialog, and loads after Accept, with no toast", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      let termsAccepted = false;
      const getConfiguration = serveConfiguration(() => {
        if (!termsAccepted) throw new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");
        return answerFor(MINE, VERSION);
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage([
        signedInMember(PERSONAL_ID, false),
        signedInMember(PERSONAL_ID, true),
        signedInMember(PERSONAL_ID, false),
      ]);

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Loading configuration…")).toBeInTheDocument();

      termsAccepted = true;
      await acceptTerms(user);

      await loaded();
      expect(getConfiguration).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
    });

    it("keeps the text when the terms are accepted after a save refused for them (Preflight ruling 4)", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      const getConfiguration = serveConfiguration();
      let termsAccepted = false;
      const saveConfigurationVersion = saving(async (yamlContent) => {
        if (!termsAccepted) throw new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");
        return { version: { ...VERSION, yamlContent } };
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage([
        signedInMember(PERSONAL_ID, false),
        signedInMember(PERSONAL_ID, true),
        signedInMember(PERSONAL_ID, false),
      ]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      termsAccepted = true;
      await acceptTerms(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();

      // And the save goes through now.
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
      expect(saveConfigurationVersion).toHaveBeenCalledTimes(2);
    });
  });

  describe("saving", () => {
    it("disables Save while clean, and enables it after typing", async () => {
      serveConfiguration();
      renderPage();
      await loaded();

      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      typeInMonaco(EDITED);

      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    });

    it("sends the text, clears Unsaved and toasts", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
      expect(saveConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yamlContent: EDITED,
        ...LOADED_GRAPH,
      });
      expect(success).toHaveBeenCalledWith("Saved configuration");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
    });

    it("leaves the editor dirty when typing continues during the save, and sends once for two quick saves", async () => {
      serveConfiguration();
      const answer = deferred<ConfigurationVersionResponse>();
      const saveConfigurationVersion = saving(() => answer.promise);
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
      typeInMonaco(`${EDITED}# more\n`);
      await act(async () => answer.resolve({ version: { ...VERSION, yamlContent: EDITED } }));

      expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it.each([
      ["404 configuration_not_found", new ApiError("configuration_not_found", "Configuration not found"), "This configuration was deleted. Copy your changes before leaving."],
      [
        "404 organization_not_found",
        new ApiError("organization_not_found", "Organization not found"),
        "This configuration belongs to another organization than the one you're working in. Copy your changes, or switch back to it in another tab.",
      ],
      ["500", new ApiError("internal_error", "Something went wrong. Please try again."), "Failed to save configuration. Please try again."],
      ["413", new ApiError("payload_too_large", "The request body is too large."), "Failed to save configuration. Please try again."],
    ])("toasts its own message for a %s, and keeps the text and the badge", async (_status, failure, message) => {
      serveConfiguration();
      saving(async () => {
        throw failure;
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(error).toHaveBeenCalledWith(message));
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("refuses text over the limit without a request", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await loaded();
      typeInMonaco("#".repeat(262_145));

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(error).toHaveBeenCalledWith("This configuration is too large to save (the limit is 256 KiB).");
      expect(saveConfigurationVersion).not.toHaveBeenCalled();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    });

    it("refuses text holding U+0000 without a request, keeping it (D8 decision 5)", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await loaded();
      typeInMonaco(`${YAML}\u0000`);

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(error).toHaveBeenCalledWith(
        "This configuration contains a character that can't be saved. Remove it and try again.",
      );
      expect(saveConfigurationVersion).not.toHaveBeenCalled();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(useEditorStore.getState().text).toBe(`${YAML}\u0000`);
    });

    it("saves from Monaco's own Cmd/Ctrl+S command", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      renderPage();
      await loaded();
      typeInMonaco(EDITED);

      expect(fake.commands).toHaveLength(1);
      await act(async () => fake.commands[0]!());

      expect(saveConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yamlContent: EDITED,
        ...LOADED_GRAPH,
      });
      await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    });

    it.each([
      ["Cmd+S", { key: "s", metaKey: true }],
      ["Ctrl+S", { key: "s", ctrlKey: true }],
      ["Cmd+Shift+S", { key: "S", metaKey: true, shiftKey: true }],
    ])("saves on %s outside Monaco, and prevents the browser's save dialog", async (_keys, keys) => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      renderPage();
      await loaded();
      typeInMonaco(EDITED);

      let notPrevented = true;
      await act(async () => {
        notPrevented = fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), keys);
      });

      expect(notPrevented).toBe(false);
      expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    });

    it("prevents Cmd/Ctrl+S while clean, and sends nothing; a plain S is left alone", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      renderPage();
      await loaded();

      expect(fireEvent.keyDown(window, { key: "s", metaKey: true })).toBe(false);
      expect(fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(window, { key: "s" })).toBe(true);

      expect(saveConfigurationVersion).not.toHaveBeenCalled();
    });

    it("prevents Cmd/Ctrl+S while the configuration is loading, and after the page is left it doesn't listen", async () => {
      const answer = deferred<ConfigurationWithVersionResponse>();
      serveConfiguration(() => answer.promise);
      const { user } = renderPage();
      await screen.findByText("Loading configuration…");

      expect(fireEvent.keyDown(window, { key: "s", metaKey: true })).toBe(false);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      await screen.findByText("landed on /app");
      expect(fireEvent.keyDown(window, { key: "s", metaKey: true })).toBe(true);
    });
  });

  describe("the unsaved-changes guard (decision 15)", () => {
    async function held() {
      return screen.findByRole("alertdialog", { name: "Unsaved Changes" });
    }

    /** A `beforeunload` as the browser sends it; true when the page asked to stay. */
    function unloading(): { prevented: boolean; returnValue: unknown } {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return { prevented: event.defaultPrevented, returnValue: event.returnValue };
    }

    it("holds a sidebar link while dirty with the Unsaved Changes dialog; Cancel stays with the text", async () => {
      serveConfiguration();
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      const dialog = await held();
      expect(dialog).toHaveAccessibleDescription("You have unsaved changes that will be lost. What would you like to do?");

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.queryByText("landed on /app")).toBeNull();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    });

    it("renders the dialog through the layout's dialogs slot (D8 decision 8)", async () => {
      const layout = vi.spyOn(editorLayout, "EditorLayout");
      serveConfiguration();
      renderPage();
      await loaded();

      const { dialogs } = layout.mock.lastCall![0];
      expect(dialogs).toMatchObject({ type: UnsavedChangesDialog, props: { open: false } });
    });

    it("never holds a sidebar link while clean", async () => {
      serveConfiguration();
      const { user } = renderPage();
      await loaded();

      await user.click(screen.getByRole("link", { name: "Configurations" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("Save & Continue saves the text and leaves, forgetting the configuration", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      await user.click(within(await held()).getByRole("button", { name: "Save & Continue" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(saveConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yamlContent: EDITED,
        ...LOADED_GRAPH,
      });
      expect(success).toHaveBeenCalledWith("Saved configuration");
      expect(useEditorStore.getState().configuration).toBeNull();
    });

    it.each([
      [
        "the API refuses it (deleted)",
        EDITED,
        async () => {
          throw new ApiError("configuration_not_found", "Configuration not found");
        },
        "This configuration was deleted. Copy your changes before leaving.",
        1,
      ],
      [
        "the API fails",
        EDITED,
        async () => {
          throw new ApiError("internal_error", "Something went wrong. Please try again.");
        },
        "Failed to save configuration. Please try again.",
        1,
      ],
      ["it is over the limit", "#".repeat(262_145), undefined, "This configuration is too large to save (the limit is 256 KiB).", 0],
      [
        "it holds a character that can't be saved",
        `${YAML}# \u0000\n`,
        undefined,
        "This configuration contains a character that can't be saved. Remove it and try again.",
        0,
      ],
    ])(
      "Save & Continue stays with the text when %s, with the save's own message alone",
      async (_why, text, answer, message, requests) => {
        serveConfiguration();
        const saveConfigurationVersion = saving(answer);
        const error = vi.spyOn(toast, "error");
        const { user } = renderPage();
        await loaded();
        typeInMonaco(text);

        await user.click(screen.getByRole("link", { name: "Configurations" }));
        await user.click(within(await held()).getByRole("button", { name: "Save & Continue" }));

        await waitFor(() => expect(error).toHaveBeenCalledWith(message));
        // No "Failed to save. Please try again." after it: one message (D8 decision 15).
        await act(async () => {});
        expect(error.mock.calls.map(([called]) => called)).toEqual([message]);
        expect(saveConfigurationVersion).toHaveBeenCalledTimes(requests);
        expect(await held()).toBeInTheDocument();
        expect(screen.queryByText("landed on /app")).toBeNull();
        expect(useEditorStore.getState().text).toBe(text);
      },
    );

    it("Save & Continue says \"Failed to save. Please try again.\" when the save is refused for the terms, whose dialog opens", async () => {
      serveConfiguration();
      saving(async () => {
        throw new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage([signedInMember(PERSONAL_ID, false), signedInMember(PERSONAL_ID, true)]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      await user.click(within(await held()).getByRole("button", { name: "Save & Continue" }));

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(error.mock.calls.map(([called]) => called)).toEqual(["Failed to save. Please try again."]);
      expect(screen.queryByText("landed on /app")).toBeNull();
      expect(useEditorStore.getState().text).toBe(EDITED);
    });

    it("Discard Changes leaves with nothing saved, and the next page sees a clean editor", async () => {
      serveConfiguration();
      const saveConfigurationVersion = saving();
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      await user.click(within(await held()).getByRole("button", { name: "Discard Changes" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(saveConfigurationVersion).not.toHaveBeenCalled();
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
      expect(useEditorStore.getState().configuration).toBeNull();
    });

    it("asks before the tab closes or reloads only while dirty, and not once the page is left", async () => {
      serveConfiguration();
      saving();
      const { user } = renderPage();
      await loaded();

      expect(unloading().prevented).toBe(false);

      typeInMonaco(EDITED);
      const whileDirty = unloading();
      expect(whileDirty.prevented).toBe(true);
      expect(whileDirty.returnValue).toBe(false);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
      expect(unloading().prevented).toBe(false);

      typeInMonaco(`${EDITED}# again\n`);
      expect(unloading().prevented).toBe(true);
      await user.click(screen.getByRole("link", { name: "Configurations" }));
      await user.click(within(await held()).getByRole("button", { name: "Discard Changes" }));
      await screen.findByText("landed on /app");
      expect(unloading().prevented).toBe(false);
    });

    it("lets the terms dialog's Cancel sign out while dirty, and goes to /login (Preflight ruling 18)", async () => {
      serveConfiguration();
      saving(async () => {
        throw new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");
      });
      const deleteSession = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
      const { user } = renderPage([signedInMember(PERSONAL_ID, false), signedInMember(PERSONAL_ID, true)]);
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));
      const terms = await screen.findByRole("dialog", { name: "Updated Terms of Service" });
      await user.click(within(terms).getByRole("button", { name: "Cancel" }));

      expect(await screen.findByText("landed on /login")).toBeInTheDocument();
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog", { name: "Unsaved Changes" })).toBeNull();
      expect(useEditorStore.getState().configuration).toBeNull();
      expect(unloading().prevented).toBe(false);
    });
  });

  describe("the tour (D9a decision 14)", () => {
    it("starts only once the configuration has loaded", async () => {
      const answer = deferred<ConfigurationWithVersionResponse>();
      serveConfiguration(() => answer.promise);
      renderPage();

      expect(await screen.findByText("Loading configuration…")).toBeInTheDocument();
      expect(tour.starts).toBe(0);

      await act(async () => answer.resolve(answerFor(MINE, VERSION)));
      await loaded();
      expect(tour.starts).toBe(1);
    });

    it("starts once: not again for another configuration opened on the page", async () => {
      serveConfiguration((_organizationId, configurationId) =>
        configurationId === THEIRS.id
          ? answerFor(THEIRS, THEIR_VERSION)
          : answerFor(MINE, VERSION),
      );
      const { user } = renderPage([signedInMember()], { strict: true });
      await loaded();
      expect(tour.starts).toBe(1);

      await user.click(screen.getByRole("link", { name: "Open another" }));
      await loaded(THEIRS.name);
      expect(tour.starts).toBe(1);
      expect(tour.stops).toBe(0);
    });

    it("doesn't start when it has been completed", async () => {
      tour.completed = true;
      serveConfiguration();
      renderPage();
      await loaded();

      expect(tour.starts).toBe(0);
    });

    it("doesn't start when the configuration can't be shown", async () => {
      serveConfiguration(() => {
        throw new ApiError("configuration_not_found", "Configuration not found");
      });
      renderPage();

      expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
      expect(tour.starts).toBe(0);
    });

    it("is stopped when the page goes", async () => {
      serveConfiguration();
      const { unmount } = renderPage();
      await loaded();
      expect(tour.stops).toBe(0);

      unmount();
      expect(tour.stops).toBe(1);
    });
  });

  describe("the builder (D9a)", () => {
    const STARTER = corpusText("starter.yaml");

    // React Flow's jsdom mocks for this block alone (Preflight ruling 17).
    let restoreReactFlow: () => void;
    beforeAll(() => {
      restoreReactFlow = installReactFlowMocks();
    });
    afterAll(() => restoreReactFlow());

    beforeEach(() => {
      // A first visit: the panel opens on its first tab.
      useEditorStore.setState({ activeTab: null });
      window.localStorage.clear();
    });

    /** Lets React Flow measure the nodes (the mock observer reports after each commit) and draw the edges. */
    async function settle() {
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    }

    async function openStarter() {
      serveConfiguration(() => answerFor(MINE, { ...VERSION, yamlContent: STARTER }));
      const view = renderPage();
      await screen.findByRole("heading", { level: 1, name: MINE.name });
      await settle();
      return view;
    }

    function canvasColumn(): HTMLElement {
      return document.querySelector<HTMLElement>('[data-tour-step="canvas"]')!;
    }

    function groupElement(label: string): HTMLElement {
      const group = useEditorStore
        .getState()
        .graph.nodes.find((node) => node.type === "pipelineGroup" && node.data.label === label);
      const element = group && document.querySelector<HTMLElement>(`.react-flow__node[data-id="${group.id}"]`);
      if (!element) throw new Error(`the ${label} group isn't drawn`);
      return element;
    }

    it("opens on Configuration, then YAML, then Testing; the toolbox, the canvas with its actions, and the panel, in that order", async () => {
      await openStarter();

      const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Configuration", "YAML", "Testing"]);
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
      expect(tabs[0]).toBeEnabled();
      expect(screen.getByText("No node selected")).toBeInTheDocument();
      // Monaco mounts when its tab opens.
      expect(screen.queryByTestId("monaco-stub")).toBeNull();

      const toolbox = document.querySelector('[data-tour-step="toolbox"]');
      expect(toolbox).not.toBeNull();
      expect(canvasColumn().previousElementSibling).toBe(toolbox);
      expect(canvasColumn().nextElementSibling).toBe(document.querySelector('[data-tour-step="editor-right-panel"]'));
      expect(within(canvasColumn()).getByRole("button", { name: "Add pipeline" })).toBeInTheDocument();
      expect(canvasColumn().querySelector(".react-flow")).not.toBeNull();
      expect(useEditorStore.getState().panelWidth).toBe(400);
    });

    it("draws the starter's three pipelines on the canvas", async () => {
      await openStarter();

      const groups = canvasColumn().querySelectorAll(".react-flow__node-pipelineGroup");
      expect(groups).toHaveLength(3);
      expect(within(groupElement("traces")).getByText("Traces")).toBeInTheDocument();
      expect(within(groupElement("metrics")).getByText("Metrics")).toBeInTheDocument();
      expect(within(groupElement("logs")).getByText("Logs")).toBeInTheDocument();
      // Each holds the starter's receiver, processor and exporter.
      for (const label of ["traces", "metrics", "logs"]) {
        const groupId = groupElement(label).getAttribute("data-id");
        const children = useEditorStore.getState().graph.nodes.filter((node) => node.parentId === groupId);
        expect(children.map((node) => node.type).sort()).toEqual(["exporter", "processor", "receiver"]);
      }
    });

    it("selecting a node or a pipeline group switches to the Configuration tab", async () => {
      const { user } = await openStarter();
      const [receiver] = useEditorStore.getState().graph.nodes.filter((node) => node.type === "receiver");

      await user.click(screen.getByRole("tab", { name: "YAML" }));
      await loaded();
      act(() => useEditorStore.getState().selectNode(receiver!.id));

      expect(screen.getByRole("tab", { name: "Configuration" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByText("No node selected")).toBeNull();
      expect(screen.queryByTestId("monaco-stub")).toBeNull();

      await user.click(screen.getByRole("tab", { name: "YAML" }));
      const traces = useEditorStore
        .getState()
        .graph.nodes.find((node) => node.type === "pipelineGroup" && node.data.label === "traces");
      act(() => useEditorStore.getState().selectNode(traces!.id));

      expect(screen.getByRole("tab", { name: "Configuration" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("button", { name: "Delete pipeline" })).toBeInTheDocument();
    });

    it("a change to the selected node doesn't pull the panel back from the YAML tab", async () => {
      const { user } = await openStarter();
      const traces = useEditorStore
        .getState()
        .graph.nodes.find((node) => node.type === "pipelineGroup" && node.data.label === "traces")!;
      act(() => useEditorStore.getState().selectNode(traces.id));
      await user.click(screen.getByRole("tab", { name: "YAML" }));
      await loaded();

      const selectedBefore = useEditorStore.getState().selectedNode;
      const pipeline = useEditorStore.getState().graph.pipelines.find((p) => p.name === "traces")!;
      act(() => {
        expect(useEditorStore.getState().setPipelineColor(pipeline.id, "#10b981")).toBe(true);
      });

      // The selected group's object was replaced; the selection wasn't.
      expect(useEditorStore.getState().selectedNode).not.toBe(selectedBefore);
      expect(useEditorStore.getState().selectedNode?.id).toBe(traces.id);

      expect(screen.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
    });

    it("Cmd/Ctrl+S saves an edit a Configuration field still holds, though the key isn't the field's (held edits, D9b)", async () => {
      const saveConfigurationVersion = saving();
      await openStarter();
      const batch = useEditorStore.getState().graph.nodes.find((node) => node.data.componentSubType === "batch")!;
      act(() => useEditorStore.getState().selectNode(batch.id));
      // Batch has a form: its box is in the collapsed "Advanced: Instance & YAML" (D9b decision 6).
      fireEvent.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));

      fireEvent.change(screen.getByRole("textbox", { name: "Raw YAML" }), { target: { value: "timeout: 2s\n" } });
      // Held: the box writes after its pause, and the store doesn't have it yet.
      expect(useEditorStore.getState().text).toBe(STARTER);
      fireEvent.keyDown(window, { key: "s", metaKey: true });

      await waitFor(() => expect(saveConfigurationVersion).toHaveBeenCalledTimes(1));
      const sent = saveConfigurationVersion.mock.calls[0]![3].yamlContent;
      expect(sent).toContain("  batch:\n    timeout: 2s\n");
      expect(sent).not.toContain("send_batch_size");
      await waitFor(() => expect(selectIsDirty(useEditorStore.getState())).toBe(false));
    });

    it.each([
      {
        way: "a link clicked without blurring the box (the review's reproducer)",
        leave: () => fireEvent.click(screen.getByRole("link", { name: "Open another" })),
      },
      { way: "Back (the router going -1, a pop)", leave: () => act(() => void navigateInPage!(-1)) },
      { way: "a programmatic navigate", leave: () => act(() => void navigateInPage!(`/editor/${THEIRS.id}`)) },
    ])(
      "writes a Raw YAML edit the box holds before $way to another configuration is judged, which holds it; the next configuration never gets it (ruling 36)",
      async ({ leave }) => {
        const theirs = deferred<ConfigurationWithVersionResponse>();
        serveConfiguration((_organizationId, configurationId) =>
          configurationId === MINE.id
            ? answerFor(MINE, { ...VERSION, yamlContent: STARTER })
            : theirs.promise,
        );
        const { user } = renderPage(undefined, { before: `/editor/${THEIRS.id}` });
        await screen.findByRole("heading", { level: 1, name: MINE.name });
        await settle();
        const batch = useEditorStore.getState().graph.nodes.find((node) => node.data.componentSubType === "batch")!;
        act(() => useEditorStore.getState().selectNode(batch.id));
        fireEvent.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));

        const box = screen.getByRole("textbox", { name: "Raw YAML" });
        box.focus();
        fireEvent.change(box, { target: { value: "timeout: 9s # held\n" } });
        // Held: the store doesn't have it, and reads clean.
        expect(useEditorStore.getState().text).toBe(STARTER);
        expect(selectIsDirty(useEditorStore.getState())).toBe(false);

        leave();

        const dialog = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });
        // Written into the configuration open when the navigation began.
        expect(useEditorStore.getState().configuration?.id).toBe(MINE.id);
        expect(useEditorStore.getState().text).toContain("  batch:\n    timeout: 9s # held\n");

        await user.click(within(dialog).getByRole("button", { name: "Discard Changes" }));
        // The next configuration, whose nodes get the same ids as this one's.
        await act(async () => theirs.resolve(answerFor(THEIRS, { ...THEIR_VERSION, yamlContent: STARTER })));
        await screen.findByRole("heading", { level: 1, name: THEIRS.name });
        await settle();

        expect(useEditorStore.getState().configuration?.id).toBe(THEIRS.id);
        expect(useEditorStore.getState().text).toBe(STARTER);
        expect(selectIsDirty(useEditorStore.getState())).toBe(false);
      },
    );

    describe("the Configuration tab kept mounted (Ruling 86)", () => {
      const FILELOG_TEXT = [
        "receivers:",
        "  filelog:",
        "    include: [/srv/zq-mark/*.log]",
        "    operators:",
        "      - type: json_parser",
        "      - type: move",
        "        from: attributes.a",
        "        to: attributes.b",
        "exporters:",
        "  debug: {}",
        "service:",
        "  pipelines:",
        "    logs:",
        "      receivers: [filelog]",
        "      exporters: [debug]",
        "",
      ].join("\n");

      async function openFilelog() {
        serveConfiguration(() => answerFor(MINE, { ...VERSION, yamlContent: FILELOG_TEXT }));
        const view = renderPage();
        await screen.findByRole("heading", { level: 1, name: MINE.name });
        await settle();
        const filelog = useEditorStore.getState().graph.nodes.find((node) => node.data.componentSubType === "filelog")!;
        act(() => useEditorStore.getState().selectNode(filelog.id));
        expect(screen.getByRole("tab", { name: "Configuration" })).toHaveAttribute("aria-selected", "true");
        return view;
      }

      /** The Configuration tab's panel: the element the tab list shows and hides. */
      function configurationPanel(): HTMLElement {
        return document.querySelector<HTMLElement>("[data-own-keys]")!.closest<HTMLElement>('[role="tabpanel"]')!;
      }

      it("keeps an opened section, a collapsed operator card and a held row across Configuration → YAML → Configuration, the same elements", async () => {
        const { user } = await openFilelog();
        await user.click(screen.getByRole("button", { name: /^Metadata/ }));
        const removes = screen.queryAllByRole("button", { name: "Remove" });
        await user.click(screen.getAllByRole("button", { name: "Add Attribute" })[0]!);
        // The held row, by its Remove: empty, it isn't written (D9b decision 9).
        const withHeld = screen.getAllByRole("button", { name: "Remove" });
        expect(withHeld).toHaveLength(removes.length + 1);
        await user.click(screen.getByRole("button", { name: /^Operators/ }));
        await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[0]!);
        expect(screen.getAllByRole("button", { name: "Expand operator" })).toHaveLength(1);
        expect(useEditorStore.getState().text).toBe(FILELOG_TEXT);
        const panel = configurationPanel();
        const scroller = panel.querySelector<HTMLElement>(".overflow-y-auto")!;

        await user.click(screen.getByRole("tab", { name: "YAML" }));
        await loaded();

        // Hidden, not gone: out of the accessibility tree, the same element.
        expect(panel).toHaveAttribute("hidden");
        expect(panel).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Metadata/ })).toBeNull();
        expect(useEditorStore.getState().text).toBe(FILELOG_TEXT);

        await user.click(screen.getByRole("tab", { name: "Configuration" }));

        expect(configurationPanel()).toBe(panel);
        expect(panel).not.toHaveAttribute("hidden");
        // The scrolling column is the same element, so its scroll position is the browser's to keep.
        expect(panel.querySelector(".overflow-y-auto")).toBe(scroller);
        expect(screen.getByRole("button", { name: /^Metadata/ })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("button", { name: /^Operators/ })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByRole("button", { name: "Expand operator" })).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: "Collapse operator" })).toHaveLength(1);
        const removesAfter = screen.getAllByRole("button", { name: "Remove" });
        expect(removesAfter).toHaveLength(withHeld.length);
        withHeld.forEach((button, index) => expect(removesAfter[index]).toBe(button));
        // Monaco unmounts with its tab, as before.
        expect(screen.queryByTestId("monaco-stub")).toBeNull();
      });

      it("an edit a field still holds is written before the YAML tab shows, and the YAML tab's text has it", async () => {
        await openFilelog();
        const pollInterval = document.getElementById("poll-interval") as HTMLInputElement;
        pollInterval.focus();
        fireEvent.change(pollInterval, { target: { value: "2s" } });
        // Held: written after the typing's pause.
        expect(useEditorStore.getState().text).toBe(FILELOG_TEXT);

        // Radix switches tabs on mousedown; the field keeps focus, so no blur writes it.
        fireEvent.mouseDown(screen.getByRole("tab", { name: "YAML" }));
        await loaded();

        expect(document.activeElement).toBe(pollInterval);
        expect(useEditorStore.getState().text).toContain("    poll_interval: 2s\n");
        expect(screen.getByTestId("monaco-stub").textContent).toContain("    poll_interval: 2s\n");
      });

      it("a programmatic switch to the YAML tab (the tour's) writes an edit a field still holds first (Ruling 89)", async () => {
        await openFilelog();
        const pollInterval = document.getElementById("poll-interval") as HTMLInputElement;
        pollInterval.focus();
        fireEvent.change(pollInterval, { target: { value: "4s" } });
        expect(useEditorStore.getState().text).toBe(FILELOG_TEXT);

        act(() => useEditorStore.getState().setActiveTab("yaml"));
        await loaded();

        expect(useEditorStore.getState().text).toContain("    poll_interval: 4s\n");
        expect(screen.getByTestId("monaco-stub").textContent).toContain("    poll_interval: 4s\n");
        // Nothing is left to write after the pause, into manual edit mode or anywhere.
        const entries = useEditorStore.getState().history.past.length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
        });
        expect(useEditorStore.getState().history.past.length).toBe(entries);
      });

      it("puts no config value in an attribute while hidden (decision 10)", async () => {
        const { user } = await openFilelog();
        await user.click(screen.getByRole("tab", { name: "YAML" }));
        await loaded();
        const panel = configurationPanel();
        for (const element of [panel, ...panel.querySelectorAll("*")]) {
          for (const attribute of element.attributes) {
            if (element.tagName === "INPUT" && attribute.name === "value") continue;
            expect(`${element.tagName} ${attribute.name}="${attribute.value}"`).not.toContain("zq-mark");
          }
        }
      });
    });

    it("typing in the YAML tab disables Configuration and locks the canvas; Apply unlocks both, staying on YAML", async () => {
      const { user } = await openStarter();
      await user.click(screen.getByRole("tab", { name: "YAML" }));
      await loaded();

      typeInMonaco(`${STARTER}# typed\n`);

      expect(screen.getByRole("tab", { name: "Configuration" })).toBeDisabled();
      expect(screen.getByText("In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.")).toBeInTheDocument();
      expect(within(canvasColumn()).getByRole("button", { name: "Add pipeline" })).toBeDisabled();
      // Apply waits for the collector validator's answer for the typed text, 2 s after the typing (D13b decision 2).
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(await screen.findByText("Yaml is Valid")).toBeInTheDocument();
      expect(validateVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, VERSION.id, {
        yaml: `${STARTER}# typed\n`,
        collectorVersion: VERSION.collectorVersion,
      }, { signal: expect.any(AbortSignal) });

      await user.click(screen.getByRole("button", { name: "Apply" }));

      expect(useEditorStore.getState().isYamlEditing).toBe(false);
      expect(screen.getByRole("tab", { name: "Configuration" })).toBeEnabled();
      expect(screen.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByText("In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.")).toBeNull();
    });

    describe("the Testing tab (D14a decision 21)", () => {
      it("is disabled with Configuration in manual edit mode, and enabled with it after Apply; its content kept mounted, hidden", async () => {
        const { user } = await openStarter();
        const testing = screen.getByRole("tab", { name: "Testing" });
        expect(testing).toBeEnabled();
        // Kept mounted while another tab shows (D8's keepMounted): its Play is
        // there, hidden from the accessibility tree.
        expect(screen.getByRole("button", { name: "Configure and run", hidden: true })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Configure and run" })).toBeNull();

        await user.click(testing);
        expect(screen.getByRole("button", { name: "Configure and run" })).toBeEnabled();
        await user.click(screen.getByRole("tab", { name: "YAML" }));
        await loaded();
        typeInMonaco(`${STARTER}# typed\n`);

        expect(screen.getByRole("tab", { name: "Configuration" })).toBeDisabled();
        expect(screen.getByRole("tab", { name: "Testing" })).toBeDisabled();
        expect(await screen.findByText("Yaml is Valid")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Apply" }));

        expect(screen.getByRole("tab", { name: "Configuration" })).toBeEnabled();
        expect(screen.getByRole("tab", { name: "Testing" })).toBeEnabled();
      });

      it("is disabled with Configuration while the canvas can't show the text, and the panel falls back from it", async () => {
        useEditorStore.setState({ activeTab: "testing" });
        serveConfiguration(() => answerFor(MINE, { ...VERSION, yamlContent: "receivers: [a]\n" }));
        renderPage();
        await loaded();

        expect(screen.getByRole("tab", { name: "Configuration" })).toBeDisabled();
        expect(screen.getByRole("tab", { name: "Testing" })).toBeDisabled();
        expect(screen.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
      });

      it("shows in the collapsed rail as a button named Testing, disabled with Configuration", async () => {
        await openStarter();
        act(() => useEditorStore.getState().setPanelCollapsed(true));

        expect(screen.getByRole("button", { name: "Testing" })).toBeEnabled();
        act(() => useEditorStore.getState().setText(`${STARTER}# typed\n`));
        expect(screen.getByRole("button", { name: "Testing" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Configuration" })).toBeDisabled();
      });
    });

    it("text the canvas can't show opens on the YAML tab, with Configuration disabled and the reason on the canvas", async () => {
      serveConfiguration(() => answerFor(MINE, { ...VERSION, yamlContent: "receivers: [a]\n" }));
      renderPage();
      await loaded();

      expect(screen.getByRole("tab", { name: "Configuration" })).toBeDisabled();
      expect(screen.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("The canvas can't show this YAML until it reads as a configuration.")).toBeInTheDocument();
      expect(screen.getByText("Line 1, column 12: receivers must be a mapping.")).toBeInTheDocument();
    });

    it("saves the text with the canvas's graph after a canvas change", async () => {
      const save = saving();
      await openStarter();
      act(() => {
        expect(useEditorStore.getState().addPipeline("logs/extra")).not.toBeNull();
      });
      const { text, graph } = useEditorStore.getState();

      await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(save.mock.calls[0]?.[3]).toEqual({ yamlContent: text, ...toStored(graph) });
      expect(text).toContain("logs/extra");
    });
  });

  describe("the version in the address (D10 decision 9)", () => {
    const VERSION_2 = versionFixture({
      id: "0199c000-0000-7000-8000-000000000012",
      versionNumber: 2,
      label: "Add tail sampling",
      yamlContent: "exporters:\n  debug: {}\n",
      updatedAt: "2026-05-01T12:00:00.000Z",
    });
    const VERSION_3 = versionFixture({
      id: "0199c000-0000-7000-8000-000000000013",
      versionNumber: 3,
      yamlContent: "processors:\n  batch: {}\n",
    });
    const LISTED = [versionSummaryOf(VERSION_2), versionSummaryOf(VERSION)];
    const versionsPath = (versionId: string) => `/editor/${MINE.id}/${versionId}`;

    /**
     * Each read on its own spy: `/editor/{id}`'s answers MINE's selected
     * version (VERSION); a version's read answers the version asked for, by
     * `answers` when given.
     */
    function serveVersions(answers: Partial<Record<string, () => Promise<ConfigurationWithVersionResponse>>> = {}) {
      const byId = new Map([VERSION, VERSION_2, VERSION_3].map((version) => [version.id, version]));
      const getConfiguration = vi
        .spyOn(apiClient, "getConfiguration")
        .mockImplementation(async () => answerFor(MINE, VERSION, LISTED));
      const getConfigurationVersion = vi
        .spyOn(apiClient, "getConfigurationVersion")
        .mockImplementation(async (_organizationId, _configurationId, versionId) => {
          const answer = answers[versionId.toLowerCase()];
          if (answer) return answer();
          const version = byId.get(versionId.toLowerCase());
          if (!version) throw new ApiError("configuration_version_not_found", "Configuration version not found");
          return answerFor(MINE, version, LISTED);
        });
      return { getConfiguration, getConfigurationVersion };
    }

    function address(): string {
      return screen.getByTestId("address").textContent ?? "";
    }

    /**
     * Every "Loading configuration…" the page shows from now on: the text of
     * each node added and each text changed, as the DOM records them, so a
     * flash removed before the observer's callback is still seen (D10 Ruling 24).
     */
    function watchForLoading(): { seen: () => boolean; stop: () => void } {
      let seen = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const texts =
            record.type === "characterData"
              ? [record.target.textContent]
              : [...record.addedNodes].map((node) => node.textContent);
          if (texts.some((text) => text?.includes("Loading configuration…"))) seen = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return { seen: () => seen, stop: () => observer.disconnect() };
    }

    /**
     * `/editor/{id}`, its configuration answered once the layout's next
     * load (the replace's revalidation) is set to answer when the test says.
     */
    async function openWithReplaceHeld(options: { before?: string } = {}) {
      const reads = serveVersions();
      const answer = deferred<ConfigurationWithVersionResponse>();
      reads.getConfiguration.mockImplementation(() => answer.promise);
      const view = renderPage([signedInMember()], { path: `/editor/${MINE.id}`, ...options });
      await waitFor(() => expect(reads.getConfiguration).toHaveBeenCalledTimes(1));
      expect(view.layoutLoader).toHaveBeenCalledTimes(1);
      const replaced = deferred<AppLayoutData>();
      view.layoutLoader.mockImplementationOnce((() => replaced.promise) as never);
      await act(async () => answer.resolve(answerFor(MINE, VERSION, LISTED)));
      await loaded();
      // The replace waits on the layout's loader: the address names no version yet.
      expect(view.layoutLoader).toHaveBeenCalledTimes(2);
      expect(address()).toBe(`/editor/${MINE.id}`);
      const releaseReplace = () => act(async () => replaced.resolve({ status: "signed_in", currentUser: signedInMember() }));
      return { ...reads, ...view, releaseReplace };
    }

    it("/editor/{id} loads, then replaces the address with the version's: one request, no flash, the selection recorded once", async () => {
      const { getConfiguration, getConfigurationVersion, releaseReplace } = await openWithReplaceHeld({ before: "/app" });
      const monaco = screen.getByTestId("monaco-stub");
      expect(getConfiguration).toHaveBeenCalledWith(PERSONAL_ID, MINE.id);
      expect(useEditorStore.getState().versions).toEqual(LISTED);
      const loading = watchForLoading();

      await releaseReplace();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));
      await act(async () => {});
      loading.stop();

      expect([...getConfiguration.mock.calls, ...getConfigurationVersion.mock.calls]).toHaveLength(1);
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(getConfigurationVersion).not.toHaveBeenCalled();
      expect(loading.seen()).toBe(false);
      expect(screen.getByTestId("monaco-stub")).toBe(monaco);
      expect(useEditorStore.getState().loadCount).toBe(1);
      expect(selectConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(selectConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION.id });
      // Replaced, not pushed: Back leaves the editor.
      act(() => void navigateInPage!(-1));
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    });

    it("/editor/{id}: text typed while the replace waits is kept, and nothing is fetched again", async () => {
      const { getConfiguration, getConfigurationVersion, releaseReplace } = await openWithReplaceHeld();

      typeInMonaco(EDITED);
      await act(async () => {});
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      await releaseReplace();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));

      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(getConfigurationVersion).not.toHaveBeenCalled();
    });

    it("/editor/{id}/{versionId} loads that version, and records it as the selection", async () => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      renderPage([signedInMember()], { path: versionsPath(VERSION_2.id) });

      await loaded();
      expect(getConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION_2.id);
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(getConfiguration).not.toHaveBeenCalled();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_2.yamlContent);
      expect(useEditorStore.getState().version).toEqual(VERSION_2);
      expect(useEditorStore.getState().versions).toEqual(LISTED);
      expect(address()).toBe(versionsPath(VERSION_2.id));
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(1));
      expect(selectConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION_2.id });
    });

    it("an upper-case version id is the API's version: loaded, and not fetched again", async () => {
      const { getConfigurationVersion } = serveVersions();
      renderPage([signedInMember()], { path: `/editor/${MINE.id.toUpperCase()}/${VERSION_2.id.toUpperCase()}` });

      await loaded();
      await act(async () => {});
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(getConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id.toUpperCase(), VERSION_2.id.toUpperCase());
      expect(useEditorStore.getState().loadCount).toBe(1);
      expect(selectConfigurationVersion).toHaveBeenCalledTimes(1);
    });

    it("records each settled version once under StrictMode's double effects (Preflight ruling 17)", async () => {
      serveVersions();
      renderPage([signedInMember()], { strict: true });

      await loaded();
      await act(async () => {});
      expect(selectConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(selectConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION.id });
    });

    it("a switch abandoned before its answer, back to the version recorded, records nothing again (Preflight ruling 17)", async () => {
      const second = deferred<ConfigurationWithVersionResponse>();
      const { getConfigurationVersion } = serveVersions({ [VERSION_2.id]: () => second.promise });
      renderPage();
      await loaded();
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(1));

      act(() => void navigateInPage!(versionsPath(VERSION_2.id), { replace: true }));
      await screen.findByText("Loading configuration…");
      act(() => void navigateInPage!(versionsPath(VERSION.id), { replace: true }));
      await waitFor(() => expect(getConfigurationVersion).toHaveBeenCalledTimes(3));
      await loaded();
      await act(async () => second.resolve(answerFor(MINE, VERSION_2, LISTED)));

      expect(useEditorStore.getState().version).toEqual(VERSION);
      expect(selectConfigurationVersion.mock.calls.map(([, , { versionId }]) => versionId)).toEqual([VERSION.id]);
    });

    it("switching the version on a clean editor loads the other: undo history cleared, manual edit mode off, selection cleared, the canvas afresh, the panel kept", async () => {
      const second = deferred<ConfigurationWithVersionResponse>();
      const { getConfiguration, getConfigurationVersion } = serveVersions({ [VERSION_2.id]: () => second.promise });
      saving();
      const { user } = renderPage();
      await loaded();

      // An undo entry, saved, so the editor is clean with history to lose.
      act(() => {
        expect(useEditorStore.getState().addPipeline("logs/extra")).not.toBeNull();
      });
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(selectIsDirty(useEditorStore.getState())).toBe(false));
      const saved = useEditorStore.getState().text;
      // A node selected, then manual edit mode, typed back to the saved text: still clean.
      const [receiver] = useEditorStore.getState().graph.nodes.filter((node) => node.type === "receiver");
      act(() => useEditorStore.getState().selectNode(receiver!.id));
      await user.click(screen.getByRole("tab", { name: "YAML" }));
      await loaded();
      typeInMonaco(`${saved}# typed\n`);
      typeInMonaco(saved);
      act(() => useEditorStore.getState().setPanelWidth(480));
      const before = useEditorStore.getState();
      expect(before.history.past.length).toBeGreaterThan(0);
      expect(before.isYamlEditing).toBe(true);
      expect(before.selectedNode).not.toBeNull();
      expect(selectIsDirty(before)).toBe(false);

      // The picker's switch replaces the address (Task 4); a clean editor isn't held.
      act(() => void navigateInPage!(versionsPath(VERSION_2.id), { replace: true }));

      // While it loads, the version before is gone, and nothing of it is editable.
      expect(await screen.findByText("Loading configuration…")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(useEditorStore.getState()).toMatchObject({
        version: null,
        history: { past: [], future: [] },
        isYamlEditing: false,
        selectedNode: null,
      });
      await act(async () => second.resolve(answerFor(MINE, VERSION_2, LISTED)));
      await loaded();

      const state = useEditorStore.getState();
      expect(state.version).toEqual(VERSION_2);
      expect(state.history).toEqual({ past: [], future: [] });
      expect(state.isYamlEditing).toBe(false);
      expect(state.selectedNode).toBeNull();
      expect(state.selectedNodes).toEqual([]);
      expect(state.canvasKey).toBe(before.canvasKey + 1);
      expect(state).toMatchObject({ activeTab: "yaml", panelWidth: 480 });
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_2.yamlContent);
      expect(getConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, VERSION_2.id);
      expect(getConfiguration).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION_2.id }),
      );
      expect(selectConfigurationVersion).toHaveBeenCalledTimes(2);
    });

    it("holds a switch while dirty with the Unsaved Changes dialog; Discard Changes loads the other version", async () => {
      const { getConfigurationVersion } = serveVersions();
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      act(() => void navigateInPage!(versionsPath(VERSION_2.id), { replace: true }));
      const held = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });
      expect(address()).toBe(versionsPath(VERSION.id));
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);

      await user.click(within(held).getByRole("button", { name: "Discard Changes" }));
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION_2.id)));
      await loaded();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_2.yamlContent);
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
    });

    it("ignores a late answer for a previous version: the latest load wins", async () => {
      const second = deferred<ConfigurationWithVersionResponse>();
      serveVersions({ [VERSION_2.id]: () => second.promise });
      renderPage();
      await loaded();

      act(() => void navigateInPage!(versionsPath(VERSION_2.id), { replace: true }));
      await screen.findByText("Loading configuration…");
      act(() => void navigateInPage!(versionsPath(VERSION_3.id), { replace: true }));
      await waitFor(() => expect(useEditorStore.getState().version).toEqual(VERSION_3));
      await act(async () => second.resolve(answerFor(MINE, VERSION_2, LISTED)));
      await loaded();

      expect(useEditorStore.getState().version).toEqual(VERSION_3);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_3.yamlContent);
      expect(address()).toBe(versionsPath(VERSION_3.id));
      expect(selectConfigurationVersion.mock.calls.map(([, , { versionId }]) => versionId)).toEqual([VERSION.id, VERSION_3.id]);
    });

    it("after a create, the address going to the created version fetches nothing, and the created version's selection is recorded after the push", async () => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      const { layoutLoader } = renderPage();
      await loaded();
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      const pushed = deferred<AppLayoutData>();
      layoutLoader.mockImplementationOnce((() => pushed.promise) as never);
      const loading = watchForLoading();

      // The create hook's order (Task 4): adopt, then push.
      act(() => {
        useEditorStore.getState().adoptCreatedVersion(VERSION_3);
        void navigateInPage!(versionsPath(VERSION_3.id));
      });
      await act(async () => {});
      // The created version shows at once, under the source's address until the push lands.
      expect(address()).toBe(versionsPath(VERSION.id));
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_3.yamlContent);
      expect(selectConfigurationVersion).toHaveBeenCalledTimes(1);

      await act(async () => pushed.resolve({ status: "signed_in", currentUser: signedInMember() }));
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION_3.id)));
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(2));
      loading.stop();

      expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION_3.id });
      expect(loading.seen()).toBe(false);
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(getConfiguration).not.toHaveBeenCalled();
      expect(useEditorStore.getState().version).toEqual(VERSION_3);
      // Pushed: Back returns to the source, which is fetched.
      act(() => void navigateInPage!(-1));
      await waitFor(() => expect(getConfigurationVersion).toHaveBeenCalledTimes(2));
      await loaded();
      expect(useEditorStore.getState().version).toEqual(VERSION);
    });

    it("a create while dirty, with the layout's loader deferred, never calls getConfigurationVersion (Preflight ruling 4)", async () => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      const { layoutLoader } = renderPage();
      await loaded();
      typeInMonaco(EDITED);
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      const pushed = deferred<AppLayoutData>();
      layoutLoader.mockImplementationOnce((() => pushed.promise) as never);
      const created = { ...VERSION_3, yamlContent: EDITED };
      const loading = watchForLoading();

      act(() => {
        useEditorStore.getState().adoptCreatedVersion(created);
        void navigateInPage!(versionsPath(created.id));
      });
      // Clean now, with the source still in the address: `isDirty` changed, and the load ran again.
      await act(async () => {});
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
      expect(address()).toBe(versionsPath(VERSION.id));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      // Typing in the created version before the push lands fetches nothing either.
      typeInMonaco(`${EDITED}# more\n`);
      typeInMonaco(EDITED);
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);

      await act(async () => pushed.resolve({ status: "signed_in", currentUser: signedInMember() }));
      await waitFor(() => expect(address()).toBe(versionsPath(created.id)));
      await act(async () => {});
      loading.stop();

      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(getConfiguration).not.toHaveBeenCalled();
      expect(loading.seen()).toBe(false);
      expect(useEditorStore.getState().version).toEqual(created);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: created.id });
    });

    it("a create's push abandoned for the source's address loads the source, never leaving the created version under it (D10 Ruling 21)", async () => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      const { layoutLoader } = renderPage();
      await loaded();
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(1));
      const pushed = deferred<AppLayoutData>();
      layoutLoader.mockImplementationOnce((() => pushed.promise) as never);

      act(() => {
        useEditorStore.getState().adoptCreatedVersion(VERSION_3);
        void navigateInPage!(versionsPath(VERSION_3.id));
      });
      await act(async () => {});
      expect(address()).toBe(versionsPath(VERSION.id));
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_3.yamlContent);

      // The picker's choice of the source before the push lands: a replace,
      // another history entry at the same address, which abandons the push.
      act(() => void navigateInPage!(versionsPath(VERSION.id), { replace: true }));
      await act(async () => pushed.resolve({ status: "signed_in", currentUser: signedInMember() }));
      await waitFor(() => expect(getConfigurationVersion).toHaveBeenCalledTimes(2));
      await loaded();
      await act(async () => {});

      expect(getConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, VERSION.id);
      expect(getConfiguration).not.toHaveBeenCalled();
      expect(address()).toBe(versionsPath(VERSION.id));
      expect(useEditorStore.getState().version).toEqual(VERSION);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
      // The selection ends on the source: the created version was never settled on.
      expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION.id });
      // Not stuck: the created version opens at its own address.
      act(() => void navigateInPage!(versionsPath(VERSION_3.id), { replace: true }));
      await waitFor(() => expect(useEditorStore.getState().version).toEqual(VERSION_3));
      await loaded();
      expect(getConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, VERSION_3.id);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(VERSION_3.yamlContent);
    });

    describe("the picker's choice of the source while a create's push waits, with text typed in the created version (D10 Ruling 27)", () => {
      const TYPED = `${VERSION_3.yamlContent}# typed in the created version\n`;

      /**
       * A create adopted (the hook's order: adopt, then push), its push
       * waiting on the layout's loader, text typed in the created version,
       * then the picker's choice of the source: the address the page is still
       * on, which the page would fetch the source for (D10 Ruling 21).
       */
      async function chooseTheSourceWhileDirty() {
        const reads = serveVersions();
        const view = renderPage();
        await loaded();
        await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(1));
        const pushed = deferred<AppLayoutData>();
        view.layoutLoader.mockImplementationOnce((() => pushed.promise) as never);
        act(() => {
          useEditorStore.getState().adoptCreatedVersion(VERSION_3);
          void navigateInPage!(versionsPath(VERSION_3.id));
        });
        await act(async () => {});
        typeInMonaco(TYPED);
        expect(selectIsDirty(useEditorStore.getState())).toBe(true);
        expect(address()).toBe(versionsPath(VERSION.id));

        act(() => void navigateInPage!(versionsPath(VERSION.id), { replace: true }));
        const held = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });
        const releasePush = () => act(async () => pushed.resolve({ status: "signed_in", currentUser: signedInMember() }));
        return { ...reads, ...view, held, releasePush };
      }

      it('holds it with "Unsaved Changes"; Cancel keeps the typed text, fetches nothing, and the push still lands', async () => {
        const { getConfiguration, getConfigurationVersion, held, user, releasePush } = await chooseTheSourceWhileDirty();
        expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
        expect(useEditorStore.getState().version?.id).toBe(VERSION_3.id);
        expect(screen.getByTestId("monaco-stub").textContent).toBe(TYPED);

        await user.click(within(held).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await act(async () => {});
        expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
        expect(useEditorStore.getState().text).toBe(TYPED);

        await releasePush();
        await waitFor(() => expect(address()).toBe(versionsPath(VERSION_3.id)));
        await act(async () => {});
        expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
        expect(getConfiguration).not.toHaveBeenCalled();
        expect(useEditorStore.getState().version?.id).toBe(VERSION_3.id);
        expect(useEditorStore.getState().text).toBe(TYPED);
        expect(screen.getByTestId("monaco-stub").textContent).toBe(TYPED);
        expect(selectIsDirty(useEditorStore.getState())).toBe(true);
      });

      it("the push landing while it is held closes the dialog (the router resets a held navigation when another lands), keeping the typed text and fetching nothing", async () => {
        const { getConfigurationVersion, releasePush } = await chooseTheSourceWhileDirty();

        await releasePush();
        await waitFor(() => expect(address()).toBe(versionsPath(VERSION_3.id)));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await act(async () => {});
        expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
        expect(useEditorStore.getState().version?.id).toBe(VERSION_3.id);
        expect(useEditorStore.getState().text).toBe(TYPED);
      });

      it("Discard Changes loads the source", async () => {
        const { getConfigurationVersion, held, user, releasePush } = await chooseTheSourceWhileDirty();

        await user.click(within(held).getByRole("button", { name: "Discard Changes" }));
        await waitFor(() => expect(getConfigurationVersion).toHaveBeenCalledTimes(2));
        await releasePush();
        await waitFor(() => expect(useEditorStore.getState().version).toEqual(VERSION));
        await loaded();
        await act(async () => {});

        expect(getConfigurationVersion).toHaveBeenCalledTimes(2);
        expect(getConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, VERSION.id);
        expect(address()).toBe(versionsPath(VERSION.id));
        expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
        expect(selectIsDirty(useEditorStore.getState())).toBe(false);
        expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: VERSION.id });
      });
    });

    it("an organization change on a clean editor after a create's push landed reloads the created version's address, not the source (D10 Ruling 21)", async () => {
      const { getConfigurationVersion } = serveVersions();
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await loaded();

      act(() => {
        useEditorStore.getState().adoptCreatedVersion(VERSION_3);
        void navigateInPage!(versionsPath(VERSION_3.id));
      });
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION_3.id)));
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(2));
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(getConfigurationVersion).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useEditorStore.getState().organizationId).toBe(GROUP_ID));
      await loaded();

      expect(getConfigurationVersion).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, VERSION_3.id);
      expect(useEditorStore.getState().version).toEqual(VERSION_3);
      expect(address()).toBe(versionsPath(VERSION_3.id));
    });

    it("Create New Version from the picker at an upper-case address, while dirty: the created version opens at its address as typed, nothing fetched (Task 4)", async () => {
      const upper = MINE.id.toUpperCase();
      const { getConfigurationVersion } = serveVersions();
      const created = { ...VERSION_3, yamlContent: EDITED, label: "From the picker" };
      const createConfigurationVersion = vi
        .spyOn(apiClient, "createConfigurationVersion")
        .mockResolvedValue({ version: created });
      const { user } = renderPage([signedInMember()], { path: `/editor/${upper}/${VERSION.id}` });
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("combobox", { name: /^Version:/ }));
      await user.click(await screen.findByRole("button", { name: "Create New Version" }));
      const dialog = await screen.findByRole("dialog", { name: "Copy Version" });
      await user.type(within(dialog).getByRole("textbox", { name: "Version name (optional)" }), "From the picker{Enter}");

      await waitFor(() => expect(address()).toBe(`/editor/${upper}/${created.id}`));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => {});
      expect(createConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, expect.objectContaining({
        sourceVersionId: VERSION.id,
        label: "From the picker",
        yamlContent: EDITED,
      }));
      expect(getConfigurationVersion).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(useEditorStore.getState().version).toEqual(created);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(screen.getByRole("combobox", { name: /^Version:/ })).toHaveTextContent("v3: From the picker");
      await waitFor(() =>
        expect(selectConfigurationVersion).toHaveBeenLastCalledWith(PERSONAL_ID, MINE.id, { versionId: created.id }),
      );
    });

    it.each([
      ["not a UUID", "not-a-version"],
      ["a path segment", ".."],
      ["a UUID without its hyphens", "0199c0000000700080000000000000001"],
    ])('a version id that is %s shows "Version not found" and sends nothing', async (_why, id) => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      renderPage([signedInMember()], { path: `/editor/${MINE.id}/${encodeURIComponent(id)}` });

      expect(await screen.findByText("Version not found")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open the latest version" })).toHaveAttribute("href", `/editor/${MINE.id}`);
      expect(screen.getByRole("link", { name: "Back to configurations" })).toHaveAttribute("href", "/app");
      expect(getConfiguration).not.toHaveBeenCalled();
      expect(getConfigurationVersion).not.toHaveBeenCalled();
      expect(selectConfigurationVersion).not.toHaveBeenCalled();
    });

    it('a 404 configuration_version_not_found shows "Version not found" with no toast; "Open the latest version" opens the selection at its address', async () => {
      const missing = "0199c000-0000-7000-8000-0000000000ff";
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage([signedInMember()], { path: versionsPath(missing) });

      expect(await screen.findByText("Version not found")).toBeInTheDocument();
      expect(getConfigurationVersion).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, missing);
      expect(error).not.toHaveBeenCalled();
      expect(screen.queryByText("Configuration not found")).toBeNull();
      expect(useEditorStore.getState().configuration).toBeNull();
      expect(selectConfigurationVersion).not.toHaveBeenCalled();
      const latest = screen.getByRole("link", { name: "Open the latest version" });
      expect(latest).toHaveAttribute("href", `/editor/${MINE.id}`);

      await user.click(latest);
      await loaded();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));
      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(useEditorStore.getState().version).toEqual(VERSION);
    });

    it("a version switched to that isn't found replaces the one open with \"Version not found\"", async () => {
      serveVersions();
      renderPage();
      await loaded();

      act(() => void navigateInPage!(versionsPath("0199c000-0000-7000-8000-0000000000ff"), { replace: true }));

      expect(await screen.findByText("Version not found")).toBeInTheDocument();
      expect(useEditorStore.getState().version).toBeNull();
      expect(screen.queryByTestId("monaco-stub")).toBeNull();
    });

    it.each([
      ["a server error", new ApiError("internal_error", "Something went wrong. Please try again.")],
      ["organization_not_found", new ApiError("organization_not_found", "Organization not found")],
      ["terms_acceptance_required", new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.")],
    ])("a selection write failing with %s changes nothing on screen and toasts nothing", async (_why, failure) => {
      serveVersions();
      selectConfigurationVersion.mockRejectedValue(failure);
      const error = vi.spyOn(toast, "error");
      const { layoutLoader } = renderPage();

      await loaded();
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledTimes(1));
      await act(async () => {});

      expect(error).not.toHaveBeenCalled();
      expect(layoutLoader).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(YAML);
      expect(useEditorStore.getState().loadCount).toBe(1);
    });

    it("/editor/{id}: a 404 organization_not_found revalidates and loads in the session's organization, then replaces the address", async () => {
      const getConfiguration = vi.spyOn(apiClient, "getConfiguration").mockImplementation(async (organizationId) => {
        if (organizationId === PERSONAL_ID) throw new ApiError("organization_not_found", "Organization not found");
        return answerFor(MINE, VERSION);
      });
      const getConfigurationVersion = vi.spyOn(apiClient, "getConfigurationVersion");
      renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)], { path: `/editor/${MINE.id}` });

      await loaded();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));
      expect(getConfiguration.mock.calls.map(([organizationId]) => organizationId)).toEqual([PERSONAL_ID, GROUP_ID]);
      expect(getConfigurationVersion).not.toHaveBeenCalled();
      expect(useEditorStore.getState().organizationId).toBe(GROUP_ID);
      await waitFor(() => expect(selectConfigurationVersion).toHaveBeenCalledWith(GROUP_ID, MINE.id, { versionId: VERSION.id }));
    });

    it("/editor/{id}: loads nothing while the terms need accepting, then loads and replaces the address", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      const { getConfiguration } = serveVersions();
      const { user } = renderPage([signedInMember(PERSONAL_ID, true), signedInMember(PERSONAL_ID, false)], {
        path: `/editor/${MINE.id}`,
      });

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(getConfiguration).not.toHaveBeenCalled();
      await acceptTerms(user);

      await loaded();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));
      expect(getConfiguration).toHaveBeenCalledTimes(1);
    });

    it("/editor/{id}: never reloads over unsaved text when the organization changes after the replace", async () => {
      const { getConfiguration, getConfigurationVersion } = serveVersions();
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)], {
        path: `/editor/${MINE.id}`,
      });
      await loaded();
      await waitFor(() => expect(address()).toBe(versionsPath(VERSION.id)));
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Revalidate" }));
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(GROUP_ID));

      expect(getConfiguration).toHaveBeenCalledTimes(1);
      expect(getConfigurationVersion).not.toHaveBeenCalled();
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(useEditorStore.getState().organizationId).toBe(PERSONAL_ID);
    });
  });

  it("puts no name, YAML or email in any attribute, loaded, dirty, renaming, or after a toast (ADR 0024)", async () => {
    const name = "Marker name 4c1f";
    const yaml = "marker-yaml-9e2d:\n  secret: s3cr3t-8a7b\n";
    const configuration: Configuration = { ...MINE, name, createdBy: { userId: MINE.createdBy!.userId, email: MEMBER_EMAIL } };
    serveConfiguration(() => answerFor(configuration, { ...VERSION, yamlContent: yaml }));
    saving();
    const { user } = renderPage();
    await loaded(name);
    const privateValues = [name, "marker-yaml-9e2d", "s3cr3t-8a7b", MEMBER_EMAIL];

    /**
     * Every attribute in the document, portals included. The rename field's
     * own `value` holds the name while it is open, as any input's does:
     * replay masks every input (`maskAllInputs`), and autocapture sends no
     * attribute in the signed-in app.
     */
    function assertNoAttributeCarries() {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (element.tagName === "INPUT" && attribute.name === "value") continue;
          for (const value of privateValues) {
            expect(`${element.tagName} ${attribute.name}="${attribute.value}"`).not.toContain(value);
          }
        }
      }
    }

    assertNoAttributeCarries();
    // The member's email is in the sidebar's account menu, as text.
    await user.click(screen.getByTitle("Switch organization"));
    expect(await screen.findByText(MEMBER_EMAIL)).toBeInTheDocument();
    assertNoAttributeCarries();
    await user.keyboard("{Escape}");
    typeInMonaco(`${yaml}# marker-yaml-9e2d again\n`);
    assertNoAttributeCarries();
    await user.click(screen.getByRole("button", { name: "Rename configuration" }));
    expect(screen.getByRole("textbox")).toHaveValue(name);
    assertNoAttributeCarries();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    assertNoAttributeCarries();
  });

  describe("a published version (D11b decision 4; Preflight rulings 11 and 12)", () => {
    const STARTER = corpusText("starter.yaml");
    const BANNER = "Version 1 is published and can't be changed.";
    const PUBLISHED_VERSION = { ...VERSION, yamlContent: STARTER, ...PUBLISHED_FIELDS };

    let restoreReactFlow: () => void;
    beforeAll(() => {
      restoreReactFlow = installReactFlowMocks();
    });
    afterAll(() => restoreReactFlow());

    beforeEach(() => {
      useEditorStore.setState({ activeTab: null });
      window.localStorage.clear();
    });

    async function settle() {
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    }

    const monacoOptions = () => fake.props?.options as { readOnly?: boolean; wordBasedSuggestions?: string };

    it("opens read-only: the banner above the canvas, the Configuration tab open with a node's form disabled, Monaco read-only, Save and Publish off", async () => {
      serveConfiguration(() => answerFor(MINE, PUBLISHED_VERSION));
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 1, name: MINE.name });
      await settle();

      const banner = screen.getByText(BANNER);
      const canvasColumn = document.querySelector<HTMLElement>('[data-tour-step="canvas"]')!;
      // First in the canvas column, above the canvas, not over it.
      expect(canvasColumn.firstElementChild).toContainElement(banner);
      expect(canvasColumn.firstElementChild!.nextElementSibling!.querySelector(".react-flow")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Create a new version from it" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

      const configurationTab = screen.getByRole("tab", { name: "Configuration" });
      expect(configurationTab).toBeEnabled();
      const batch = useEditorStore.getState().graph.nodes.find((n) => n.data.componentSubType === "batch")!;
      fireEvent.click(document.querySelector(`.react-flow__node[data-id="${batch.id}"]`)!);
      await settle();
      expect(configurationTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("textbox", { name: "Timeout" })).toBeDisabled();
      expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveValue("10s");

      await user.click(screen.getByRole("tab", { name: "YAML" }));
      await screen.findByTestId("monaco-stub");
      expect(monacoOptions().readOnly).toBe(true);
      expect(monacoOptions().wordBasedSuggestions).toBe("off");
      expect(screen.getByTestId("monaco-stub").closest(".ph-no-capture")).not.toBeNull();
    });

    it("never asks before leaving: a published version is never dirty", async () => {
      serveConfiguration(() => answerFor(MINE, PUBLISHED_VERSION));
      const { user } = renderPage();
      await screen.findByText(BANNER);

      await user.click(screen.getByRole("link", { name: "Configurations" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("publishing from the page locks it in place, with no reload", async () => {
      const reads = serveConfiguration(() => answerFor(MINE, { ...VERSION, yamlContent: STARTER }));
      vi.spyOn(apiClient, "publishConfigurationVersion").mockResolvedValue({
        version: { ...summaryOf(VERSION), ...PUBLISHED_FIELDS },
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 1, name: MINE.name });
      await settle();
      const { canvasKey, loadCount } = useEditorStore.getState();
      expect(screen.queryByText(BANNER)).toBeNull();

      await user.click(screen.getByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog", { name: "Publish Configuration" });
      await user.click(within(dialog).getByRole("button", { name: "Publish" }));

      expect(await screen.findByText(BANNER)).toBeInTheDocument();
      expect(reads).toHaveBeenCalledOnce();
      expect(useEditorStore.getState()).toMatchObject({ canvasKey, loadCount });
      expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    });

    it("a teammate's save since the tab loaded: Publish is refused as changed, and the version opens again with the newer text, nothing published (Ruling 30)", async () => {
      const NEWER = { ...VERSION, yamlContent: `${STARTER}# a teammate's save\n`, updatedAt: "2026-10-04T12:30:00.000Z" };
      let teammateSaved = false;
      const reads = serveConfiguration(() => answerFor(MINE, teammateSaved ? NEWER : { ...VERSION, yamlContent: STARTER }));
      const publish = vi.spyOn(apiClient, "publishConfigurationVersion").mockImplementation(async () => {
        teammateSaved = true;
        throw new ApiError("configuration_version_changed", "This version changed while it was being published. Try again.");
      });
      const error = vi.spyOn(toast, "error");
      useEditorStore.setState({ activeTab: "yaml" });
      const { user } = renderPage();
      await loaded();
      const { loadCount } = useEditorStore.getState();

      await user.click(screen.getByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog", { name: "Publish Configuration" });
      await user.click(within(dialog).getByRole("button", { name: "Publish" }));

      await waitFor(() => expect(screen.getByTestId("monaco-stub").textContent).toBe(NEWER.yamlContent));
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(PERSONAL_ID, MINE.id, VERSION.id, { expectedUpdatedAt: VERSION.updatedAt });
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("This version changed while it was being published. Try again.");
      expect(reads).toHaveBeenCalledTimes(2);
      const state = useEditorStore.getState();
      // The same version, opened again: its newer text, clean, still a draft.
      expect(state.loadCount).toBe(loadCount + 1);
      expect(state.version).toEqual(NEWER);
      expect(state).toMatchObject({ text: NEWER.yamlContent, savedText: NEWER.yamlContent, isPublishing: false });
      expect(selectIsDirty(state)).toBe(false);
      expect(selectIsVersionPublished(state)).toBe(false);
      expect(screen.queryByText(BANNER)).toBeNull();
      expect(screen.getByTestId("address")).toHaveTextContent(`/editor/${MINE.id}/${VERSION.id}`);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    });

    it("a Publish refused as changed whose re-read holds the same text and pin is checked again at once: never stuck at validating (Ruling 57)", async () => {
      // A teammate's save that changed only the layout: the same text, a newer updatedAt.
      const SAME_TEXT = { ...VERSION, yamlContent: STARTER, updatedAt: "2026-10-04T12:30:00.000Z" };
      let teammateSaved = false;
      serveConfiguration(() => answerFor(MINE, teammateSaved ? SAME_TEXT : { ...VERSION, yamlContent: STARTER }));
      vi.spyOn(apiClient, "publishConfigurationVersion").mockImplementation(async () => {
        teammateSaved = true;
        throw new ApiError("configuration_version_changed", "This version changed while it was being published. Try again.");
      });
      useEditorStore.setState({ activeTab: "yaml" });
      const { user } = renderPage();
      await loaded();
      expect(await screen.findByText(`config valid · v${VERSION.collectorVersion}`)).toBeInTheDocument();
      const { loadCount } = useEditorStore.getState();

      await user.click(screen.getByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog", { name: "Publish Configuration" });
      await user.click(within(dialog).getByRole("button", { name: "Publish" }));

      await waitFor(() => expect(useEditorStore.getState().loadCount).toBe(loadCount + 1));
      expect(useEditorStore.getState().version).toEqual(SAME_TEXT);
      await waitFor(() => expect(validateVersion).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(`config valid · v${VERSION.collectorVersion}`)).toBeInTheDocument();
      expect(screen.queryByText("validating config…")).toBeNull();
    });

    it.each([
      ["outside Monaco", () => fireEvent.keyDown(window, { key: "s", metaKey: true })],
      ["in Monaco's own command", () => fake.commands[0]!()],
    ])("Cmd/Ctrl+S on a published version %s says it is published and sends nothing (Ruling 31)", async (_where, press) => {
      serveConfiguration(() => answerFor(MINE, PUBLISHED_VERSION));
      const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
      const error = vi.spyOn(toast, "error");
      useEditorStore.setState({ activeTab: "yaml" });
      renderPage();
      await loaded();
      expect(fake.commands).toHaveLength(1);

      await act(async () => {
        press();
      });

      await waitFor(() => expect(error).toHaveBeenCalledWith(BANNER));
      expect(error).toHaveBeenCalledOnce();
      expect(saveConfigurationVersion).not.toHaveBeenCalled();
    });

    it("a stale tab locked in manual edit mode can Undo All, leaving the mode: the Configuration tab opens and a node can be inspected, still read-only (Ruling 31)", async () => {
      let publishedElsewhere = false;
      serveConfiguration(() => answerFor(MINE, publishedElsewhere ? PUBLISHED_VERSION : { ...VERSION, yamlContent: STARTER }));
      vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(async () => {
        publishedElsewhere = true;
        throw new ApiError("configuration_version_published", "This version is published and can't be changed.");
      });
      useEditorStore.setState({ activeTab: "yaml" });
      const { user } = renderPage();
      await loaded();
      await settle();
      typeInMonaco(`${STARTER}# typed\n`);
      expect(screen.getByRole("tab", { name: "Configuration" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText(BANNER)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Undo All" }));

      expect(useEditorStore.getState()).toMatchObject({ text: STARTER, isYamlEditing: false });
      expect(screen.getByTestId("monaco-stub").textContent).toBe(STARTER);
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(monacoOptions().readOnly).toBe(true);
      const configurationTab = screen.getByRole("tab", { name: "Configuration" });
      expect(configurationTab).toBeEnabled();
      await settle();
      const batch = useEditorStore.getState().graph.nodes.find((n) => n.data.componentSubType === "batch")!;
      fireEvent.click(document.querySelector(`.react-flow__node[data-id="${batch.id}"]`)!);
      await settle();
      expect(configurationTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("textbox", { name: "Timeout" })).toBeDisabled();
      expect(screen.getByText(BANNER)).toBeInTheDocument();
    });

    it("a canvas change made before the typing and never saved: Undo All on the locked tab puts back what was published, Unsaved goes, and leaving asks nothing (Ruling 34)", async () => {
      let publishedElsewhere = false;
      serveConfiguration(() => answerFor(MINE, publishedElsewhere ? PUBLISHED_VERSION : { ...VERSION, yamlContent: STARTER }));
      vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(async () => {
        publishedElsewhere = true;
        throw new ApiError("configuration_version_published", "This version is published and can't be changed.");
      });
      useEditorStore.setState({ activeTab: "yaml" });
      const { user } = renderPage();
      await loaded();
      await settle();
      const published = useEditorStore.getState().savedGraph;
      const batch = useEditorStore.getState().graph.nodes.find((n) => n.data.componentSubType === "batch")!;
      act(() => {
        expect(useEditorStore.getState().deleteNodes([batch.id])).toBe(true);
      });
      const canvasEdited = useEditorStore.getState().text;
      expect(canvasEdited).not.toBe(STARTER);
      typeInMonaco(`${canvasEdited}# typed\n`);
      expect(useEditorStore.getState().isYamlEditing).toBe(true);

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText(BANNER)).toBeInTheDocument();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Undo All" }));

      const state = useEditorStore.getState();
      expect(state).toMatchObject({ text: STARTER, savedText: STARTER, isYamlEditing: false });
      // The published graph and layout (React Flow's measurements aside).
      expect(layoutSignature(state.graph)).toBe(layoutSignature(published));
      expect(state.graph.nodes.map((n) => n.id)).toEqual(published.nodes.map((n) => n.id));
      expect(selectIsDirty(state)).toBe(false);
      expect(selectIsVersionPublished(state)).toBe(true);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(STARTER);
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(screen.getByText(BANNER)).toBeInTheDocument();

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog", { name: "Unsaved Changes" })).toBeNull();
    });

    it("a stale tab: a save refused as published locks the editor with the typed text; leaving still asks, and Save & Continue stays", async () => {
      let publishedElsewhere = false;
      serveConfiguration(() =>
        answerFor(MINE, publishedElsewhere ? { ...VERSION, ...PUBLISHED_FIELDS } : VERSION),
      );
      vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(async () => {
        publishedElsewhere = true;
        throw new ApiError("configuration_version_published", "This version is published and can't be changed.");
      });
      const error = vi.spyOn(toast, "error");
      useEditorStore.setState({ activeTab: "yaml" });
      const { user } = renderPage();
      await loaded();
      typeInMonaco(EDITED);

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText(BANNER)).toBeInTheDocument();
      expect(error).toHaveBeenCalledWith(BANNER);
      expect(selectIsVersionPublished(useEditorStore.getState())).toBe(true);
      expect(screen.getByTestId("monaco-stub").textContent).toBe(EDITED);
      expect(monacoOptions().readOnly).toBe(true);
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

      await user.click(screen.getByRole("link", { name: "Configurations" }));
      const held = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });
      await user.click(within(held).getByRole("button", { name: "Save & Continue" }));
      await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
      expect(error).toHaveBeenLastCalledWith(BANNER);
      expect(screen.queryByText("landed on /app")).toBeNull();
      expect(useEditorStore.getState().text).toBe(EDITED);

      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard Changes" }));
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    });

    describe("a teammate published content this tab never loaded (Ruling 35)", () => {
      const TEAMMATE_TEXT = STARTER.replace("timeout: '10s'", "timeout: '3s'");
      const TEAMMATE_PUBLISHED = {
        ...VERSION,
        ...PUBLISHED_FIELDS,
        yamlContent: TEAMMATE_TEXT,
        updatedAt: "2026-10-04T11:30:00.000Z",
      };
      const TYPED = `${STARTER}# typed before the teammate published\n`;
      const batchTimeout = () =>
        useEditorStore.getState().graph.nodes.find((n) => n.data.componentSubType === "batch")!.data.config;

      /** The page with the starter loaded; the API answers the teammate's published version once `published()` is called. */
      function serveTeammatePublish() {
        let publishedElsewhere = false;
        const reads = serveConfiguration(() =>
          answerFor(MINE, publishedElsewhere ? TEAMMATE_PUBLISHED : { ...VERSION, yamlContent: STARTER }),
        );
        const refuse = async (): Promise<never> => {
          publishedElsewhere = true;
          throw new ApiError("configuration_version_published", "This version is published and can't be changed.");
        };
        return { reads, refuse };
      }

      it("a clean tab's Publish refused as already published shows what was published: clean, locked, no reload", async () => {
        expect(TEAMMATE_TEXT).not.toBe(STARTER);
        const { reads, refuse } = serveTeammatePublish();
        vi.spyOn(apiClient, "publishConfigurationVersion").mockImplementation(refuse);
        useEditorStore.setState({ activeTab: "yaml" });
        const { user } = renderPage();
        await loaded();
        await settle();
        const { canvasKey, loadCount } = useEditorStore.getState();

        await user.click(screen.getByRole("button", { name: "Publish" }));
        const dialog = await screen.findByRole("dialog", { name: "Publish Configuration" });
        await user.click(within(dialog).getByRole("button", { name: "Publish" }));

        expect(await screen.findByText(BANNER)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId("monaco-stub").textContent).toBe(TEAMMATE_TEXT));
        expect(reads).toHaveBeenCalledTimes(2);
        const state = useEditorStore.getState();
        expect(state).toMatchObject({ text: TEAMMATE_TEXT, savedText: TEAMMATE_TEXT, canvasKey, loadCount });
        expect(batchTimeout()).toMatchObject({ timeout: "3s" });
        expect(selectIsDirty(state)).toBe(false);
        expect(selectIsVersionPublished(state)).toBe(true);
        expect(screen.queryByText("Unsaved")).toBeNull();
        expect(monacoOptions().readOnly).toBe(true);

        await user.click(screen.getByRole("link", { name: "Configurations" }));
        expect(await screen.findByText("landed on /app")).toBeInTheDocument();
        expect(screen.queryByRole("alertdialog", { name: "Unsaved Changes" })).toBeNull();
      });

      it("a stale tab's save refused as published keeps the typed text, dirty; Undo All then puts back what was published, and leaving asks nothing", async () => {
        const { refuse } = serveTeammatePublish();
        vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(refuse);
        useEditorStore.setState({ activeTab: "yaml" });
        const { user } = renderPage();
        await loaded();
        await settle();
        typeInMonaco(TYPED);

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText(BANNER)).toBeInTheDocument();
        await waitFor(() => expect(useEditorStore.getState().savedText).toBe(TEAMMATE_TEXT));
        expect(useEditorStore.getState()).toMatchObject({ text: TYPED, isYamlEditing: true });
        expect(screen.getByTestId("monaco-stub").textContent).toBe(TYPED);
        expect(screen.getByText("Unsaved")).toBeInTheDocument();
        expect(selectIsDirty(useEditorStore.getState())).toBe(true);

        await user.click(screen.getByRole("button", { name: "Undo All" }));

        const state = useEditorStore.getState();
        expect(state).toMatchObject({ text: TEAMMATE_TEXT, savedText: TEAMMATE_TEXT, isYamlEditing: false });
        expect(batchTimeout()).toMatchObject({ timeout: "3s" });
        expect(selectIsDirty(state)).toBe(false);
        expect(selectIsVersionPublished(state)).toBe(true);
        expect(screen.getByTestId("monaco-stub").textContent).toBe(TEAMMATE_TEXT);
        expect(screen.queryByText("Unsaved")).toBeNull();

        await user.click(screen.getByRole("link", { name: "Configurations" }));
        expect(await screen.findByText("landed on /app")).toBeInTheDocument();
        expect(screen.queryByRole("alertdialog", { name: "Unsaved Changes" })).toBeNull();
      });

      it("after a stale tab's save refused as published, the banner's create carries the typed text into the new version", async () => {
        const { refuse } = serveTeammatePublish();
        vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(refuse);
        const created = versionFixture({ id: "0199c000-0000-7000-8000-000000000014", versionNumber: 2, yamlContent: TYPED });
        const create = vi.spyOn(apiClient, "createConfigurationVersion").mockResolvedValue({ version: created });
        useEditorStore.setState({ activeTab: "yaml" });
        const { user } = renderPage();
        await loaded();
        await settle();
        typeInMonaco(TYPED);
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(BANNER)).toBeInTheDocument();
        await waitFor(() => expect(useEditorStore.getState().savedText).toBe(TEAMMATE_TEXT));

        await user.click(screen.getByRole("button", { name: "Create a new version from it" }));

        await waitFor(() => expect(screen.getByTestId("address")).toHaveTextContent(`/editor/${MINE.id}/${created.id}`));
        expect(create).toHaveBeenCalledOnce();
        expect(create.mock.calls[0]![2]).toMatchObject({ sourceVersionId: VERSION.id, yamlContent: TYPED });
        await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
        expect(useEditorStore.getState()).toMatchObject({ version: created, text: TYPED, savedText: TYPED });
        expect(screen.queryByText("Unsaved")).toBeNull();
      });
    });
  });
});
