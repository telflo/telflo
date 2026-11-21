import Editor, { type Monaco } from "@monaco-editor/react";
import { AlertCircle, Check, Copy, Download, Undo2 } from "lucide-react";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ValidationStatus } from "~/components/editor/ValidationStatus.js";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { downloadTextFile } from "~/lib/download.js";
import type { EditorPosition } from "~/lib/editor/component-position.js";
import { schemaPathFor } from "~/lib/editor/collector-schema.js";
import { initMonaco, setMonacoSchema } from "~/lib/editor/monaco-setup.js";
import { defineTelfloThemes } from "~/lib/editor/monaco-themes.js";
import { useEditorPreferences } from "~/lib/editor/use-editor-preferences.js";
import { useAriaContainer } from "~/lib/editor/use-aria-container.js";
import { readText } from "~/lib/graph/parse.js";
import {
  selectCollectorValidation,
  selectIsVersionPublished,
  useEditorStore,
  type CollectorValidationOutcome,
} from "~/lib/stores/editor-store.js";

/** How long after the last keystroke the typed text is read, for Apply's gate (as the Configuration tab's box waits). */
export const TYPED_TEXT_READ_DELAY_MS = 300;

/** The titles for manual edit mode's two buttons. */
export const UNDO_ALL_TITLE = "Undo all changes and exit manual mode";
export const APPLY_TOOLTIP = "Apply Changes and Exit Manual Mode";
/** Apply's tooltips while the collector validator decides. */
export const APPLY_VALIDATING_TOOLTIP = "Validating...";
export const APPLY_ERRORS_TOOLTIP = "Validation Errors Exist";
export const APPLY_UNCHECKED_TOOLTIP = "Validation unavailable — applying unchecked YAML";

/**
 * Apply's validation gate, for the outcome of exactly the text on screen:
 * allowed when valid, unavailable or retired (both unchecked), and when
 * idle (nothing to check: empty text or text that doesn't parse, where the
 * parse gate decides alone); refused while it is being checked and while
 * the collector reports errors. The tooltip, first match wins.
 */
export function applyValidationGate(validation: CollectorValidationOutcome): { allowed: boolean; tooltip: string } {
  switch (validation.status) {
    case "validating":
      return { allowed: false, tooltip: APPLY_VALIDATING_TOOLTIP };
    case "invalid":
      return { allowed: false, tooltip: APPLY_ERRORS_TOOLTIP };
    case "unavailable":
    case "retired":
      return { allowed: true, tooltip: APPLY_UNCHECKED_TOOLTIP };
    case "valid":
    case "idle":
      return { allowed: true, tooltip: APPLY_TOOLTIP };
  }
}

/**
 * The YAML tab, where the text is the content.
 *
 * The collector's schema: the pin on screen (`collectorVersion`, an
 * unsaved pick included) picks it, through `schemaPathFor` and
 * `setMonacoSchema`, and a pin change switches it with the editor mounted.
 * An offered version gets completion, hover and the schema's markers; a
 * null or retired pin, or a distribution without schemas, gets YAML's
 * syntax markers only. The schema's markers are Warnings (yellow), which
 * nothing here counts: the alert and Apply's gate count only Error
 * markers, YAML's syntax errors and duplicate keys, and the collector
 * validator stays the authority on whether a text runs.
 *
 * Manual edit mode: typing in Monaco is the store's `setText`, which enters
 * the mode; while in it the header shows "Undo All" and "Apply". Apply is
 * disabled while Monaco marks an error or the typed text can't be read as a
 * configuration (read 300 ms after typing pauses, since the store's
 * `graphStatus` describes the text from before the typing); why is said in
 * the alert, as text, since the reason can quote the text (never in an
 * attribute). It is also disabled while the collector validator checks the
 * text on screen, and while it reports errors for it
 * (`applyValidationGate`), with its tooltips.
 *
 * Under the editor, inside its replay-blocked container, the validator's
 * status bar (`ValidationStatus`); a row that names a component puts Monaco's
 * cursor on its key, scrolled to the middle, and focuses Monaco.
 *
 * A text the store sets (a canvas or Configuration tab change, undo, Apply,
 * Undo All) is written into Monaco here, as the store sets it, and never
 * reaches `setText`: Monaco's undo group is closed before and after it
 * (`pushStackElement`), so it is its own undo step in Monaco, and the cursor
 * and scroll are put back. `@monaco-editor/react`'s own value sync then
 * finds nothing to do. A load under the mounted editor (a created version
 * adopted) sets Monaco's text afresh, which clears Monaco's own undo history
 * as the store's is cleared, the cursor and scroll kept.
 *
 * Monaco is reached only through initMonaco(), a dynamic import, so a server
 * render shows "Loading editor…" and never imports monaco-editor; the
 * `Editor` mounts only after it resolved, since a mount before
 * `loader.config` fetches Monaco from a CDN. If it rejects, the tab says
 * "The editor couldn't load." with "Try again"; the text stays in the store.
 * No `path` or `defaultPath`: Monaco writes the model's URI into a
 * `data-uri` attribute, and attributes aren't masked in replay.
 *
 * Replay: Monaco writes what it shows into attributes replay can't mask (a
 * suggestion row's `aria-label` is what it offers, "otlp, Text"), so the
 * editor is blocked from replay: its container has posthog-js's replay
 * block class, `ph-no-capture` (its default `blockClass`, which
 * `initOptions` leaves alone), and replay records only a placeholder for
 * it. Monaco's overflow widgets (completion's rows and details, hover,
 * quick fixes, find) render inside the editor's own element, and its
 * screen-reader live region, which Monaco otherwise appends to `<body>`,
 * is put inside the container too (`ariaContainerElement`). Completion
 * offers only the schema's keys and descriptions; word-based suggestions
 * are off, so the configuration's words aren't offered at all.
 *
 * A published version is read-only: Monaco takes `readOnly` from the store's
 * `selectIsVersionPublished`, so nothing can be typed (Copy and Download still
 * work), and manual edit mode's Apply doesn't show, which the store refuses
 * too: text a stale tab typed before the version was published stays on
 * screen. Undo All still shows: it only puts back the text from before the
 * typing, on screen, so that tab can leave the mode and inspect the canvas.
 * The replay rules above hold for it as for any.
 *
 * Cmd/Ctrl+S inside Monaco saves through `onSave`, the page's save; the page
 * handles it outside Monaco. Monaco stops the key's propagation once its
 * command runs, so a listener on `window` never sees it and nothing saves
 * twice.
 */
export function YamlEditor({ onSave }: { onSave: () => void }) {
  const text = useEditorStore((state) => state.text);
  const setText = useEditorStore((state) => state.setText);
  const isYamlEditing = useEditorStore((state) => state.isYamlEditing);
  const readOnly = useEditorStore(selectIsVersionPublished);
  /** The person's theme and editor preferences; the tab size goes on the model. */
  const preferences = useEditorPreferences();
  /** The pin's collector schema, or null for syntax only. */
  const schemaPath = useEditorStore((state) =>
    schemaPathFor(state.configuration?.collectorDistribution ?? null, state.collectorVersion),
  );
  const [yamlError, setYamlError] = useState<string | null>(null);
  /** Where Monaco's screen-reader live region goes: the shell's one replay-blocked host (useAriaContainer). */
  const { ariaHost } = useAriaContainer();
  /** Why the typed text can't be applied, as last read; null when it reads, or outside manual edit mode. */
  const [unreadableReason, setUnreadableReason] = useState<string | null>(null);
  const markerDisposableRef = useRef<IDisposable | null>(null);
  /** The mounted Monaco, for the status bar's rows that jump; null until it mounts. */
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const validation = useEditorStore(selectCollectorValidation);
  const storeSubscriptionRef = useRef<(() => void) | null>(null);
  /** True while a text the store set is being written into Monaco, whose change events then aren't typing. */
  const writingStoreText = useRef(false);
  // Monaco's command is registered once, on mount; it calls the latest onSave.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // The pin's schema, switched with the editor mounted. Before the effect
  // below, so a first mount's schema is fetched alongside Monaco (which
  // never waits for it).
  useEffect(() => {
    setMonacoSchema(schemaPath);
  }, [schemaPath]);

  // Initialize Monaco and monaco-yaml before the editor loads. If that
  // fails (a chunk that didn't arrive, say), the tab says so and offers to
  // try again: initMonaco() forgets a failure, and the text is the store's,
  // untouched, so nothing is lost and Copy and Download still work.
  const [monacoStatus, setMonacoStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [monacoAttempt, setMonacoAttempt] = useState(0);
  useEffect(() => {
    initMonaco().then(
      () => setMonacoStatus("ready"),
      () => setMonacoStatus("failed"),
    );
  }, [monacoAttempt]);

  const retryMonaco = () => {
    setMonacoStatus("loading");
    setMonacoAttempt((attempt) => attempt + 1);
  };

  // Apply's gate: the typed text, read once typing pauses. Out of manual
  // edit mode there is nothing to apply, and nothing to say.
  useEffect(() => {
    if (!isYamlEditing) {
      setUnreadableReason(null);
      return;
    }
    const timer = setTimeout(() => {
      const read = readText(text);
      setUnreadableReason(read.ok ? null : read.reason);
    }, TYPED_TEXT_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, isYamlEditing]);

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined || writingStoreText.current) return;
    setText(value);
  };

  const handleEditorMount = (editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    preferences.attach(editor);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());

    // A text the store sets, written as its own Monaco undo step, the view
    // kept. Typing's own text is already Monaco's, so it finds nothing to
    // write.
    storeSubscriptionRef.current?.();
    storeSubscriptionRef.current = useEditorStore.subscribe((state, previous) => {
      if (state.loadCount !== previous.loadCount) {
        // A version opened under the mounted editor (a create's adoption):
        // its text, with Monaco's own undo history gone too, as the
        // store's is (`setValue` clears it). Written even when the text is
        // the same, which is the adoption's usual case; the view is kept.
        const model = editor.getModel();
        if (!model) return;
        const viewState = editor.saveViewState();
        writingStoreText.current = true;
        try {
          model.setValue(state.text);
        } finally {
          writingStoreText.current = false;
        }
        if (viewState) editor.restoreViewState(viewState);
        return;
      }
      if (state.text === previous.text) return;
      const model = editor.getModel();
      if (!model || state.text === model.getValue()) return;
      const viewState = editor.saveViewState();
      writingStoreText.current = true;
      try {
        model.pushStackElement();
        editor.executeEdits("telflo-store", [
          { range: model.getFullModelRange(), text: state.text, forceMoveMarkers: true },
        ]);
        model.pushStackElement();
      } finally {
        writingStoreText.current = false;
      }
      if (viewState) editor.restoreViewState(viewState);
    });

    // Listen to marker changes from monaco-yaml. Only Errors count: YAML's
    // syntax errors and duplicate keys. The schema's findings are Warnings,
    // which never reach the alert or Apply's gate.
    markerDisposableRef.current = monaco.editor.onDidChangeMarkers(() => {
      const model = editor.getModel();
      if (!model) return;

      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      const errorMarkers = markers.filter(
        (m: MonacoEditor.IMarker) => m.severity === monaco.MarkerSeverity.Error,
      );

      if (errorMarkers.length > 0) {
        setYamlError(`${errorMarkers.length} validation error${errorMarkers.length > 1 ? "s" : ""}`);
      } else {
        setYamlError(null);
      }
    });
  };

  // Clean up the marker listener and the store's subscription on unmount
  useEffect(() => {
    return () => {
      markerDisposableRef.current?.dispose();
      storeSubscriptionRef.current?.();
      editorRef.current = null;
    };
  }, []);

  const handleApply = () => {
    const result = useEditorStore.getState().apply();
    if (!result.ok) setUnreadableReason(result.reason);
  };

  const handleUndoAll = () => {
    useEditorStore.getState().undoAll();
  };

  const gate = applyValidationGate(validation);
  const isApplyDisabled = yamlError !== null || unreadableReason !== null || !gate.allowed;

  const jumpTo = (position: EditorPosition) => {
    const editor = editorRef.current;
    if (editor === null) return;
    editor.setPosition(position);
    editor.revealLineInCenter(position.lineNumber);
    editor.focus();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(useEditorStore.getState().text);
      toast.success("Configuration copied to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleDownload = () => {
    downloadTextFile(useEditorStore.getState().text, "config.yaml", "text/yaml");
    toast.success("Configuration downloaded");
  };

  return (
    // `nokey`: React Flow's key handlers stand aside inside it. Chromium's
    // Monaco types through an EditContext element, not a textarea, which
    // React Flow doesn't take for a field: it took Space for its pan key and
    // prevented it, so spaces typed in Monaco were lost.
    <div className="h-full flex flex-col nokey">
      {/* Editor Header */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-border bg-muted/40">
        <span className="tf-label">YAML</span>
        <div className="flex items-center gap-1">
          {isYamlEditing && (
            <Button
              onClick={handleUndoAll}
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1"
              title={UNDO_ALL_TITLE}
            >
              <Undo2 className="w-4 h-4" />
              <span className="text-xs">Undo All</span>
            </Button>
          )}
          {isYamlEditing && !readOnly && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      onClick={handleApply}
                      disabled={isApplyDisabled}
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 gap-1"
                    >
                      <Check className="w-4 h-4" />
                      <span className="text-xs">Apply</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{gate.tooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            onClick={handleCopy}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Copy YAML to clipboard"
            title="Copy YAML to clipboard"
          >
            <Copy className="w-4 h-4" />
          </Button>
          <Button
            onClick={handleDownload}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Download YAML configuration"
            title="Download YAML configuration"
          >
            <Download className="w-4 h-4" />
          </Button>
        </div>
      </div>
      {(yamlError !== null || unreadableReason !== null) && (
        <Alert variant="destructive" className="m-2 mb-0">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-semibold">YAML Validation Error</span>
            {yamlError !== null && <span className="text-sm font-mono whitespace-pre-wrap">{yamlError}</span>}
            {unreadableReason !== null && (
              <span className="text-sm font-mono whitespace-pre-wrap">{unreadableReason}</span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {/* `ph-no-capture`: replay blocks the editor and its status bar (see above). */}
      <div className="flex-1 min-h-0 flex flex-col ph-no-capture">
        <div className="flex-1 min-h-0">
          {monacoStatus === "ready" ? (
            <Editor
              height="100%"
              defaultLanguage="yaml"
              value={text}
              onChange={handleEditorChange}
              beforeMount={defineTelfloThemes}
              onMount={handleEditorMount}
              theme={preferences.theme}
              options={{
                ...preferences.options,
                fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                fontLigatures: false,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordBasedSuggestions: "off",
                readOnly,
                ...(ariaHost === null ? {} : { ariaContainerElement: ariaHost }),
                scrollbar: {
                  vertical: "visible",
                  horizontal: "visible",
                },
              }}
            />
          ) : monacoStatus === "failed" ? (
            <div className="flex flex-col items-center justify-center gap-2.5 h-full text-[13px] text-muted-foreground">
              <p>The editor couldn't load.</p>
              <Button variant="outline" onClick={retryMonaco}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">
              Loading editor…
            </div>
          )}
        </div>
        <ValidationStatus onJump={jumpTo} />
      </div>
    </div>
  );
}
