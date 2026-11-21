import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Code, FlaskConical, Settings } from "lucide-react";
import type { Configuration, ConfigurationVersion } from "@telflo/contracts";
import type { Route } from "./+types/playground.editor";
import { EditorLayout, type EditorPanelTab } from "~/components/editor/EditorLayout.js";
import { EditorUnavailable } from "~/components/editor/EditorUnavailable.js";
import { YamlEditor } from "~/components/editor/YamlEditor.js";
import { Canvas } from "~/components/editor/builder/Canvas.js";
import { CanvasActions } from "~/components/editor/builder/CanvasActions.js";
import { CollapsibleToolbox } from "~/components/editor/builder/CollapsibleToolbox.js";
import { ConfigurationPanel } from "~/components/editor/builder/ConfigurationPanel.js";
import { TestingTab } from "~/components/editor/test-runs/TestingTab.js";
import { PlaygroundLinkScope } from "~/components/playground/PlaygroundLinkScope.js";
import { BACK_TO_PLAYGROUND, PlaygroundEditorSurface } from "~/components/playground/PlaygroundPhonePage.js";
import { PlaygroundToolbar } from "~/components/playground/PlaygroundToolbar.js";
import { consumePlaygroundTourStage, startPlaygroundEditorTour, stopPlaygroundTour } from "~/components/playground/playground-tour.js";
import { isSaveShortcut } from "~/lib/editor/unsaved-guard.js";
import { ANONYMOUS_VALIDATION, useCollectorValidation } from "~/lib/editor/use-collector-validation.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";
import { useSignUpPath } from "~/lib/use-site.js";
import { sampleConfiguration } from "~/lib/playground/sample/configurations.js";
import { NEW_CONFIGURATION_PIN, SAMPLE_DISTRIBUTION, SAMPLE_VISITOR } from "~/lib/playground/sample/types.js";
import { UNTITLED_CONFIGURATION_NAME, useStagePlaygroundSave } from "~/lib/playground/save.js";
import { PLAYGROUND_SURFACE_CLASS } from "~/lib/playground/surface.js";
import { selectIsCanvasLocked, useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";

/*
 * `/playground/editor/:configurationId?`: the playground editor, full screen,
 * outside the shell, in its own provider and the editors' surface (masked as
 * the signed-in shell; a phone page below `md`, so Monaco never mounts and
 * nothing is validated on a phone).
 *
 * It composes the signed-in editor's pieces, as routes/editor.tsx does:
 * the toolbox, the canvas with its actions, and the panel's Configuration,
 * YAML and Testing tabs (each disabled as the signed-in editor's), under
 * the playground's toolbar (PlaygroundToolbar: the name as text, the fixed
 * collector picker, the shared edit actions, Save, Publish locked). Over
 * the canvas, a pill: "Edit freely — Save to keep your
 * changes." (a blank configuration's "Build and validate freely — Save to
 * keep your work.") with "Create a free account".
 *
 * The editor store loads with no API: a sample configuration's draft
 * (`sampleConfiguration`, under `SAMPLE_ORGANIZATION_ID`, so every reused
 * reader answers from the sample: the Testing tab's runs, rules and suites),
 * or, with no id, a blank new configuration of the page's own on
 * NEW_CONFIGURATION_PIN ("New configuration" on the list). An id the sample
 * doesn't hold shows the editor's own "Configuration not found"
 * (`EditorUnavailable`), its "Back to configurations" going to the
 * playground's list. Leaving the page forgets what was open (the editor
 * store and the Testing tab's stores), so nothing of the sample reaches a
 * signed-in editor afterwards.
 *
 * The open text is checked by the anonymous validate (`ANONYMOUS_VALIDATION`:
 * 1.5 s after an opening or a change, with "Checking paused" counting down a
 * 429). No navigation or unload guard (the banner and the pill say nothing
 * here saves). Cmd/Ctrl+S, here or inside Monaco, runs the playground's Save
 * (`useStagePlaygroundSave`): the edit is staged in this browser and "Sign in
 * to save" opens. The playground tour's editor stage runs here when the list
 * hands it over, on the toolbox's, the canvas's and the panel's anchors
 * (`data-tour-step`); the editor's own tour never runs on this page.
 *
 * No attribute carries the name or the text: they are text, which replay
 * masks; the text is inside `ph-no-capture` (YamlEditor).
 */

export const handle = PLAYGROUND_HANDLE;

/** The playground editor is the playground's, behind its switch: a 404 with TELFLO_PLAYGROUND off. */
export function loader() {
  notFoundUnless(siteSettings().playground);
  return null;
}

/**
 * One canonical for the blank editor and every sample's: `/playground/editor`,
 * so the samples aren't indexed as pages of their own.
 */
export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.editor, "/playground/editor");
}

/** A blank configuration's fixed ids: the page's own, never a sample's (its Testing tab's lists are empty). */
export const BLANK_CONFIGURATION_ID = "11111111-0000-4000-8000-0000000000b1";
export const BLANK_VERSION_ID = "33333333-0000-4000-8000-0000000000b1";

/** The pill over the canvas. */
export const SAMPLE_PILL_TEXT = "Edit freely — Save to keep your changes.";
export const BLANK_PILL_TEXT = "Build and validate freely — Save to keep your work.";

/** The blank new configuration and its draft, version 1 on the newest offered pin, with empty text (three empty pipelines). */
function blankConfiguration(now: number = Date.now()): { configuration: Configuration; version: ConfigurationVersion } {
  const at = new Date(now).toISOString();
  return {
    configuration: {
      id: BLANK_CONFIGURATION_ID,
      name: UNTITLED_CONFIGURATION_NAME,
      description: "",
      createdAt: at,
      updatedAt: at,
      createdBy: SAMPLE_VISITOR,
      published: false,
      collectorDistribution: SAMPLE_DISTRIBUTION,
    },
    version: {
      id: BLANK_VERSION_ID,
      configurationId: BLANK_CONFIGURATION_ID,
      versionNumber: 1,
      label: null,
      createdBy: SAMPLE_VISITOR,
      createdAt: at,
      updatedAt: at,
      publishedAt: null,
      publishedBy: null,
      collectorVersion: NEW_CONFIGURATION_PIN,
      collectorVersionDeprecated: false,
      collectorVersionDeprecatedNote: null,
      yamlContent: "",
      nodes: [],
      edges: [],
      pipelines: [],
    },
  };
}

/** Forgets the open configuration and the Testing tab's memory: nothing of the sample outlives the page. */
function forgetEditor(): void {
  useEditorStore.getState().reset();
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  useValidationPipelinesStore.getState().reset();
}

/** The page's own "not found": the editor's, its way back (`/app`) landing on the playground's list (the link scope). */
function PlaygroundEditorUnavailable() {
  return (
    <PlaygroundLinkScope className={PLAYGROUND_SURFACE_CLASS}>
      <EditorUnavailable reason="not_found" />
    </PlaygroundLinkScope>
  );
}

/** The pill over the canvas: nothing here saves, Save keeps it, and the way to an account. */
function CanvasPill({ blank }: { blank: boolean }) {
  const signUp = useSignUpPath();
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 w-max max-w-[calc(100%-320px)] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-2 overflow-hidden rounded-md border border-border bg-card/95 px-3 py-1.5">
        <span className="hidden min-w-0 truncate whitespace-nowrap text-xs text-muted-foreground @min-[640px]:inline">
          {blank ? BLANK_PILL_TEXT : SAMPLE_PILL_TEXT}
        </span>
        <Link to={signUp} className="shrink-0 whitespace-nowrap text-xs font-medium text-brand hover:underline">
          {signUp === "/register" ? "Create a free account" : "Sign in"}
        </Link>
      </div>
    </div>
  );
}

function PlaygroundEditor() {
  const { configurationId } = useParams();
  const blank = configurationId === undefined;
  const stage = useStagePlaygroundSave();
  const save = useCallback(() => stage(useEditorStore.getState()), [stage]);
  /** Which address the store holds: a load is synchronous, so only an unknown id is ever without one. */
  const [opened, setOpened] = useState<{ address: string; found: boolean } | null>(null);
  const address = configurationId ?? "";
  const isCanvasLocked = useEditorStore(selectIsCanvasLocked);
  const selectedNodeId = useEditorStore((state) => state.selectedNode?.id ?? null);

  // The anonymous validate checks the open text.
  useCollectorValidation(ANONYMOUS_VALIDATION);

  // Opens the sample (or the blank configuration) with no API, forgetting
  // first whatever the stores held (a signed-in editor's Testing tab);
  // leaving, or opening another, forgets it again.
  useEffect(() => {
    forgetEditor();
    const sample = blank ? blankConfiguration() : sampleConfiguration(address);
    if (sample === undefined) {
      setOpened({ address, found: false });
      return forgetEditor;
    }
    useEditorStore.getState().load({ organizationId: SAMPLE_ORGANIZATION_ID, ...sample });
    setOpened({ address, found: true });
    return forgetEditor;
  }, [address, blank]);

  // Cmd/Ctrl+S anywhere on the page runs the playground's Save, never the
  // browser's save dialog; inside Monaco its own command does (YamlEditor).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      save();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [save]);

  // The playground tour's editor stage, once the sample is open, when the
  // list handed it over; leaving the page takes it down.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const isOpen = opened !== null && opened.address === address && opened.found;
  useEffect(() => {
    if (!isOpen) return;
    if (consumePlaygroundTourStage("editor")) startPlaygroundEditorTour((to) => void navigateRef.current(to));
    return stopPlaygroundTour;
  }, [isOpen]);

  // Selecting a node (or a group) switches to the Configuration tab, as the signed-in editor does.
  useEffect(() => {
    if (selectedNodeId !== null) useEditorStore.getState().setActiveTab("config");
  }, [selectedNodeId]);

  if (opened !== null && opened.address === address && !opened.found) return <PlaygroundEditorUnavailable />;
  if (opened?.address !== address) {
    return <div className={`${PLAYGROUND_SURFACE_CLASS} h-screen bg-gray-50 dark:bg-gray-900`} aria-busy="true" />;
  }

  const panelTabs: EditorPanelTab[] = [
    { id: "config", label: "Configuration", icon: Settings, content: <ConfigurationPanel />, disabled: isCanvasLocked, keepMounted: true },
    {
      id: "yaml",
      label: "YAML",
      icon: Code,
      content: (
        <div className="flex-1 min-h-0 overflow-hidden">
          <YamlEditor onSave={save} />
        </div>
      ),
    },
    { id: "testing", label: "Testing", icon: FlaskConical, content: <TestingTab />, disabled: isCanvasLocked, keepMounted: true },
  ];

  return (
    <PlaygroundLinkScope className={`${PLAYGROUND_SURFACE_CLASS} h-screen`}>
      <EditorLayout
        toolbar={<PlaygroundToolbar onSave={save} />}
        toolbox={<CollapsibleToolbox />}
        main={
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Canvas />
            <CanvasActions />
            <CanvasPill blank={blank} />
          </div>
        }
        panelTabs={panelTabs}
      />
    </PlaygroundLinkScope>
  );
}

export default function PlaygroundEditorPage() {
  return (
    <PlaygroundProvider>
      <PlaygroundEditorSurface back={BACK_TO_PLAYGROUND}>
        <PlaygroundEditor />
      </PlaygroundEditorSurface>
    </PlaygroundProvider>
  );
}
