import { useCallback, useEffect, useRef, useState } from "react";
import { Code, Settings } from "lucide-react";
import type { Configuration, ConfigurationVersion } from "@telflo/contracts";
import type { Route } from "./+types/public-editor";
import { EditorLayout, type EditorPanelTab } from "~/components/editor/EditorLayout.js";
import { YamlEditor } from "~/components/editor/YamlEditor.js";
import { Canvas } from "~/components/editor/builder/Canvas.js";
import { CanvasActions } from "~/components/editor/builder/CanvasActions.js";
import { CollapsibleToolbox } from "~/components/editor/builder/CollapsibleToolbox.js";
import { ConfigurationPanel } from "~/components/editor/builder/ConfigurationPanel.js";
import { startEditorTour } from "~/components/editor/builder/tour/start-editor-tour.js";
import { BACK_TO_SIGN_IN, PlaygroundEditorSurface } from "~/components/playground/PlaygroundPhonePage.js";
import { PublicEditorToolbar } from "~/components/playground/PublicEditorToolbar.js";
import { PublicEditorWelcomeDialog, type PublicEditorStart } from "~/components/playground/PublicEditorWelcomeDialog.js";
import { useConsentPending } from "~/lib/use-consent-pending.js";
import { isSaveShortcut } from "~/lib/editor/unsaved-guard.js";
import { ANONYMOUS_VALIDATION, useCollectorValidation } from "~/lib/editor/use-collector-validation.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, PUBLIC_EDITOR_DESCRIPTION, playgroundMeta } from "~/lib/playground/meta.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";
import { NEW_CONFIGURATION_PIN, SAMPLE_DISTRIBUTION, SAMPLE_VISITOR } from "~/lib/playground/sample/types.js";
import { UNTITLED_CONFIGURATION_NAME, useStagePlaygroundSave } from "~/lib/playground/save.js";
import { PLAYGROUND_SURFACE_CLASS } from "~/lib/playground/surface.js";
import { selectIsCanvasLocked, useEditorStore } from "~/lib/stores/editor-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";

/*
 * `/public-editor`: the blank anonymous editor, full screen, in the
 * playground's provider and the editors' surface (masked as the signed-in
 * shell; the phone page below `md`, its link to sign-in, so Monaco never
 * mounts and nothing is validated on a phone). No playground sidebar or
 * banner.
 *
 * It composes the signed-in editor's pieces, as the playground editor
 * does, WITHOUT the Testing tab: the toolbox, the canvas with its
 * actions, the panel's Configuration and YAML tabs, under the public
 * editor's toolbar (PublicEditorToolbar: the Telflo mark, the name as
 * text, the fixed collector picker, the shared edit actions, Save,
 * Publish locked). No pill over the canvas (only the playground editor
 * has one).
 *
 * The editor store loads with no API, under `SAMPLE_ORGANIZATION_ID` (so a
 * reader the seam missed answers from the sample, never the API), a
 * configuration and draft of the page's own (fixed ids, never a sample's or
 * the playground's blank one), Contrib on NEW_CONFIGURATION_PIN: blank
 * first; the Welcome dialog (until its flag says done) offers Start from
 * Scratch, the same blank, or Use a Template, an example
 * (`PUBLIC_EDITOR_EXAMPLE_YAML`, its exporter's host rewritten to
 * `acme.example`), and the editor tour unless "Skip tour" is ticked
 * (`startEditorTour({ versionHistory: false })`: there is no version
 * picker; leaving the page stops it). Nothing it shows is stored: the
 * example is the bundle's, the edit lives in the store until Save.
 *
 * The open text is checked by the anonymous validate (`ANONYMOUS_VALIDATION`).
 * No navigation or unload guard. Save and Cmd/Ctrl+S, here or inside Monaco,
 * run the playground's Save (`useStagePlaygroundSave`): staged in this
 * browser, then "Sign in to save" (or, signed in, `/app`). Leaving the page
 * forgets what was open (the editor store).
 *
 * No attribute carries the name or the text: they are text, which replay
 * masks; the text is inside `ph-no-capture` (YamlEditor).
 */

export const handle = PLAYGROUND_HANDLE;

/** The public editor is the playground's, behind its switch: a 404 with TELFLO_PLAYGROUND off. */
export function loader() {
  notFoundUnless(siteSettings().playground);
  return null;
}

export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.publicEditor, "/public-editor", PUBLIC_EDITOR_DESCRIPTION);
}

/** The public editor's configuration and draft: fixed ids of its own. */
export const PUBLIC_EDITOR_CONFIGURATION_ID = "11111111-0000-4000-8000-0000000000e1";
export const PUBLIC_EDITOR_VERSION_ID = "33333333-0000-4000-8000-0000000000e1";

/** "Use a Template"'s name. */
export const PUBLIC_EDITOR_EXAMPLE_NAME = "Example Pipeline";

/**
 * "Use a Template"'s configuration: an OTLP receiver, a batch processor and
 * an OTLP exporter on the three signals, with the health_check, pprof and
 * zpages extensions. Its exporter's host, `otelcol`, is
 * `otelcol.acme.example` here (the sample's domain, RFC 2606); the receivers'
 * and extensions' listen addresses are kept.
 */
export const PUBLIC_EDITOR_EXAMPLE_YAML = `# Learn more about the OpenTelemetry Collector via
# https://opentelemetry.io/docs/collector/
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 10s
    send_batch_size: 1024

exporters:
  otlp:
    endpoint: otelcol.acme.example:4317
    tls:
      insecure: true

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777
  zpages:
    endpoint: 0.0.0.0:55679

service:
  extensions: [health_check, pprof, zpages]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
`;

/** The page's configuration and its draft, version 1 on Contrib's newest offered pin: blank, or the example. */
export function publicEditorConfiguration(
  start: PublicEditorStart,
  now: number = Date.now(),
): { configuration: Configuration; version: ConfigurationVersion } {
  const at = new Date(now).toISOString();
  return {
    configuration: {
      id: PUBLIC_EDITOR_CONFIGURATION_ID,
      name: start === "example" ? PUBLIC_EDITOR_EXAMPLE_NAME : UNTITLED_CONFIGURATION_NAME,
      description: "",
      createdAt: at,
      updatedAt: at,
      createdBy: SAMPLE_VISITOR,
      published: false,
      collectorDistribution: SAMPLE_DISTRIBUTION,
    },
    version: {
      id: PUBLIC_EDITOR_VERSION_ID,
      configurationId: PUBLIC_EDITOR_CONFIGURATION_ID,
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
      yamlContent: start === "example" ? PUBLIC_EDITOR_EXAMPLE_YAML : "",
      nodes: [],
      edges: [],
      pipelines: [],
    },
  };
}

function open(start: PublicEditorStart): void {
  useEditorStore.getState().load({ organizationId: SAMPLE_ORGANIZATION_ID, ...publicEditorConfiguration(start) });
}

function PublicEditor() {
  // The Welcome dialog waits while the cookie banner asks.
  const consentPending = useConsentPending();
  const stage = useStagePlaygroundSave();
  const save = useCallback(() => stage(useEditorStore.getState()), [stage]);
  const [opened, setOpened] = useState(false);
  const isCanvasLocked = useEditorStore(selectIsCanvasLocked);
  const selectedNodeId = useEditorStore((state) => state.selectedNode?.id ?? null);
  const stopTour = useRef<(() => void) | null>(null);

  // The anonymous validate checks the open text.
  useCollectorValidation(ANONYMOUS_VALIDATION);

  // Opens the blank configuration with no API; leaving forgets it, and stops a tour under way.
  useEffect(() => {
    open("blank");
    setOpened(true);
    return () => {
      stopTour.current?.();
      stopTour.current = null;
      useEditorStore.getState().reset();
    };
  }, []);

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

  // Selecting a node (or a group) switches to the Configuration tab, as the signed-in editor does.
  useEffect(() => {
    if (selectedNodeId !== null) useEditorStore.getState().setActiveTab("config");
  }, [selectedNodeId]);

  const start = useCallback((choice: PublicEditorStart, takeTour: boolean) => {
    open(choice);
    if (takeTour && stopTour.current === null) stopTour.current = startEditorTour({ versionHistory: false });
  }, []);

  if (!opened) return <div className={`${PLAYGROUND_SURFACE_CLASS} h-screen bg-gray-50 dark:bg-gray-900`} aria-busy="true" />;

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
  ];

  return (
    <div className={`${PLAYGROUND_SURFACE_CLASS} h-screen`}>
      <EditorLayout
        toolbar={<PublicEditorToolbar onSave={save} />}
        toolbox={<CollapsibleToolbox />}
        main={
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Canvas />
            <CanvasActions />
          </div>
        }
        panelTabs={panelTabs}
      />
      <PublicEditorWelcomeDialog onStart={start} consentPending={consentPending} />
    </div>
  );
}

export default function PublicEditorPage() {
  return (
    <PlaygroundProvider>
      <PlaygroundEditorSurface back={BACK_TO_SIGN_IN}>
        <PublicEditor />
      </PlaygroundEditorSurface>
    </PlaygroundProvider>
  );
}
