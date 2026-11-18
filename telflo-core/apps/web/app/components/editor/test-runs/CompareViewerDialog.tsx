import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import type { TestRunSignal } from "@telflo/contracts";
import { Loader2 } from "lucide-react";
import type { editor } from "monaco-editor";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { defineTelfloThemes } from "~/lib/editor/monaco-themes.js";
import { useAriaContainer } from "~/lib/editor/use-aria-container.js";
import { useEditorPreferences } from "~/lib/editor/use-editor-preferences.js";
import { detectRuleCandidates, documentsOf, outputDocumentsOf, type RuleCandidate, type RuleCandidateKind } from "~/lib/test-runs/diff-rule-detection.js";
import { parseJsonText, prettyPrintParsed } from "~/lib/test-runs/json-format.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { MonacoGate } from "./MonacoGate.js";

/** The chips' words for each change. */
const CANDIDATE_LABELS: Record<RuleCandidateKind, string> = {
  added: "attribute added",
  removed: "attribute removed",
  changed: "attribute changed",
};

/** How many chips show. */
export const CANDIDATES_SHOWN = 5;

/** What the footer says instead of chips when a file was cut at 10 MiB (Preflight ruling 8). */
export function truncationLine(outputTruncated: boolean, decodedInputTruncated: boolean): string | null {
  if (outputTruncated && decodedInputTruncated) return "Input and output were cut at 10 MiB, so no rules are suggested.";
  if (outputTruncated) return "Output was cut at 10 MiB, so no rules are suggested.";
  if (decodedInputTruncated) return "Input was cut at 10 MiB, so no rules are suggested.";
  return null;
}

interface CompareViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The OTLP the tester sent into the pipeline (the run's decoded input), as text. Must keep its identity per run. */
  loadInputText: () => Promise<string>;
  /** The OTLP captured at the exporter (the run's output), as text. Must keep its identity per run. */
  loadOutputText: () => Promise<string>;
  /** The run's signal: whose records the detection reads. */
  signal: TestRunSignal;
  /** Whether the run's stored output was cut at 10 MiB (its last records missing): no chips, and the footer says so. */
  outputTruncated: boolean;
  /** Whether the run's decoded input was cut at 10 MiB: no chips, and the footer says so. */
  decodedInputTruncated: boolean;
  /** A chip pressed, with its place among the chips: its rule to create (the host finds the run's validation pipeline). */
  onCreateRule?: ((candidate: RuleCandidate, index: number) => void) | undefined;
  /** The place of the chip whose validation pipeline is being looked up, null for none: every chip is held while one is, that one busy. */
  busyCandidate?: number | null | undefined;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): the host's; Radix's own goes nowhere (no Radix trigger). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * Monaco's DiffEditor, releasing its two models in the order Monaco asks.
 * `@monaco-editor/react` (4.7.0) disposes the models before the diff editor
 * when it unmounts, and Monaco (0.5x) reports that as an uncaught error,
 * "TextModel got disposed before DiffEditorWidget model got reset", each
 * time Compare closes (D14a Task 11's browser tests). So the library keeps
 * them (`keepCurrent…Model`), and this resets the diff editor's model first,
 * then disposes the two it held. React runs a removed tree's effect
 * clean-ups parent first, so this runs before the library disposes the
 * editor. `onMounted` gets the diff editor once it mounts.
 */
function ReleasingDiffEditor({
  onMounted,
  ...props
}: Omit<DiffEditorProps, "onMount" | "keepCurrentOriginalModel" | "keepCurrentModifiedModel"> & {
  onMounted: (diffEditor: editor.IStandaloneDiffEditor) => void;
}) {
  const mounted = useRef<{ diffEditor: editor.IStandaloneDiffEditor; models: editor.IDiffEditorModel | null } | null>(null);

  useEffect(
    () => () => {
      const current = mounted.current;
      mounted.current = null;
      if (current === null) return;
      current.diffEditor.setModel(null);
      current.models?.original.dispose();
      current.models?.modified.dispose();
    },
    [],
  );

  return (
    <DiffEditor
      {...props}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(diffEditor) => {
        mounted.current = { diffEditor, models: diffEditor.getModel() };
        onMounted(diffEditor);
      }}
    />
  );
}

/**
 * "Detected {n} candidate rule(s):" and up to five chips, each a rule to
 * create (its words, its five, its title); "Showing 5 of {n}." past
 * five; the truncation sentence instead when a file was cut; nothing when
 * there is nothing to offer. The two lines are polite status regions
 * mounted empty with the footer as Compare opens and filled once its files
 * show (`loaded`), so a screen reader hears them: a region inserted with
 * its text may go unannounced (Ruling 32). The chips are a group labelled
 * by the "Detected" line; every chip is held (`aria-disabled`) while one's
 * lookup runs, that one busy. A chip's key wraps, whole, however long (never
 * cut: no title can carry it); the chips' group is at most 10rem tall and
 * scrolls, so long keys never squeeze the diff editor (Ruling 34). The
 * keys are text inside Compare's `ph-no-capture`; the only title is the
 * fixed "Create an OTTL rule
 * asserting this change" (Preflight ruling 17).
 */
function RuleCandidatesFooter({
  loaded,
  candidates,
  truncated,
  busyCandidate,
  onCreateRule,
}: {
  loaded: boolean;
  candidates: readonly RuleCandidate[];
  truncated: string | null;
  busyCandidate: number | null;
  onCreateRule: ((candidate: RuleCandidate, index: number) => void) | undefined;
}) {
  const detectedId = useId();
  /** The chips offered: none until the files show, nor for a file cut at 10 MiB. */
  const offered = loaded && truncated === null ? candidates : [];
  const held = busyCandidate !== null;
  return (
    <div className="mr-auto flex flex-wrap items-center gap-2">
      <span id={detectedId} role="status" className="text-xs text-muted-foreground">
        {loaded && truncated !== null
          ? truncated
          : offered.length > 0 && (
              <>
                Detected <span className="font-mono tabular-nums">{offered.length}</span> candidate rule
                {offered.length === 1 ? "" : "s"}:
              </>
            )}
      </span>
      {offered.length > 0 && (
        // At most 10rem tall, scrolling within: five long keys (up to 8 KiB each) wrap whole without squeezing the diff
        // editor (Ruling 34's m2); the padding keeps a chip's focus ring inside the scrolled box.
        <div
          role="group"
          aria-labelledby={detectedId}
          className="flex flex-wrap items-center gap-2 max-h-40 overflow-y-auto p-0.5"
        >
          {offered.slice(0, CANDIDATES_SHOWN).map((candidate, index) => (
            <Button
              key={index}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (!held) onCreateRule?.(candidate, index);
              }}
              title="Create an OTTL rule asserting this change"
              // Held, never disabled: the focus stays on the chip pressed (as D15a Rulings 57 and 58).
              aria-disabled={held || undefined}
              aria-busy={busyCandidate === index || undefined}
              // As tall as its key needs: a long key wraps rather than being cut (Ruling 32).
              className="h-auto min-h-7 max-w-full py-1 whitespace-normal aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
            >
              {busyCandidate === index && <Loader2 className="animate-spin" aria-hidden />}
              <span className="min-w-0 text-left whitespace-pre-wrap break-all">
                + {CANDIDATE_LABELS[candidate.kind]}: {candidate.key}
              </span>
            </Button>
          ))}
        </div>
      )}
      <span role="status" className="text-xs text-muted-foreground">
        {offered.length > CANDIDATES_SHOWN && (
          <>
            Showing {CANDIDATES_SHOWN} of {offered.length}.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The OTLP sent in beside the OTLP that came out, in Monaco's side-by-side
 * DiffEditor (D14a decision 22), with its rule footer: the record attributes
 * the run's pipeline added, removed or changed (`detectRuleCandidates`, D15b
 * decisions 3 and 4), each a chip creating the OTTL rule that asserts it
 * (`onCreateRule`: the host finds the run's validation pipeline and opens the
 * rule editor, D15b decisions 5 and 6). Differences:
 * - the person's theme, font size, line numbers and tab size, as every
 *   Monaco here (`useEditorPreferences`; D21 decisions 27 and 28), the tab
 *   size on both models; no minimap, which Monaco's diff editor never shows
 *   (D21 Preflight ruling 32); the
 *   themes defined before mount (Preflight ruling 14), JSON's tokens only,
 *   mounted once initMonaco() has resolved (MonacoGate), its models
 *   released after it (ReleasingDiffEditor);
 * - replay (ADR 0024): the whole dialog is `ph-no-capture`, with the
 *   DiffEditor's screen-reader live region in the shell's one replay-blocked
 *   host (`useAriaContainer`, Ruling 48): without one Monaco puts the region
 *   on `<body>` (proved by the preflight);
 *   no model paths;
 * - a failure shows the API's words, else "Failed to load files";
 * - each file is parsed once as the dialog opens (`parseJsonText`), and both
 *   pretty-printed and read for the chips from that one parse, the chips
 *   kept in state (Preflight ruling 8), not parsed and detected again on
 *   every render;
 * - the output's `{"records": […]}` (several batches) and an array or
 *   NDJSON input are read document by document, not each as one document
 *   (which would give no chip);
 * - a run whose output or decoded input was cut at 10 MiB offers no chips
 *   and says so, politely: "Output was cut at 10 MiB, so no rules are
 *   suggested." (or "Input …", "Input and output were …"; Preflight ruling
 *   8), never nothing for an unparseable file;
 * - past five chips, "Showing 5 of {n}.", never the rest hidden without a
 *   word;
 * - the footer's lines are polite status regions, mounted empty as Compare
 *   opens and filled once its files show (Ruling 32);
 * - a chip's key wraps, whole, however long, the chips scrolling within a
 *   group at most 10rem tall, so the diff editor keeps most of the dialog
 *   (Ruling 34), never whole on one line, a long one running past the
 *   footer;
 * - the chips are a group labelled by the "Detected …" line; while a chip's lookup runs every chip is held
 *   (`aria-disabled`) and that one is busy (`aria-busy`, a spinner), so a
 *   second click looks nothing up (never twice, opening two editors);
 * - the detection walks the run's signal's records (`signal`), and the
 *   chips' keys are text inside the dialog's `ph-no-capture`, the chips'
 *   only title the fixed "Create an OTTL rule asserting this change".
 */
export function CompareViewerDialog({
  open,
  onOpenChange,
  loadInputText,
  loadOutputText,
  signal,
  outputTruncated,
  decodedInputTruncated,
  onCreateRule,
  busyCandidate = null,
  onCloseAutoFocus,
}: CompareViewerDialogProps) {
  const preferences = useEditorPreferences();
  const { ariaHost } = useAriaContainer();
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  /** The rules offered: detected once per opening, from the files as they were parsed then (never per render). */
  const [candidates, setCandidates] = useState<readonly RuleCandidate[]>([]);
  /** Whether this opening's files are shown: the footer speaks only then. */
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const truncated = truncationLine(outputTruncated, decodedInputTruncated);

  useEffect(() => {
    setLoaded(false);
    setCandidates([]);
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInputText("");
    setOutputText("");
    Promise.all([loadInputText(), loadOutputText()])
      .then(([input, output]) => {
        if (cancelled) return;
        // Each file parsed once: printed, and read for the chips, from that one parse (Preflight ruling 8).
        const parsedInput = parseJsonText(input);
        const parsedOutput = parseJsonText(output);
        setInputText(prettyPrintParsed(parsedInput, input).display);
        setOutputText(prettyPrintParsed(parsedOutput, output).display);
        // A file cut at 10 MiB offers nothing: its last records are missing, or it doesn't parse.
        if (!outputTruncated && !decodedInputTruncated) {
          setCandidates(detectRuleCandidates(documentsOf(parsedInput), outputDocumentsOf(parsedOutput), signal));
        }
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(failureMessage(caught, "Failed to load files") ?? "Failed to load files");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadInputText, loadOutputText, signal, outputTruncated, decodedInputTruncated]);

  // DiffEditor's options type omits the standalone editors' ariaContainerElement, which it passes on to them.
  const options: editor.IDiffEditorConstructionOptions & { ariaContainerElement?: HTMLElement } = {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    // No minimap: Monaco's diff editor forces it off (Preflight ruling 32).
    fontSize: preferences.options.fontSize,
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontLigatures: false,
    lineNumbers: preferences.options.lineNumbers,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    ignoreTrimWhitespace: false,
    renderValidationDecorations: "off",
    ...(ariaHost === null ? {} : { ariaContainerElement: ariaHost }),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-6xl h-[90vh] flex flex-col ph-no-capture"
        aria-describedby={undefined}
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogHeader>
          <DialogTitle>Compare input ↔ output</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center h-full" role="status" aria-label="Loading files">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : error !== null ? (
            <p className="p-4 text-[13px] text-fail">{error}</p>
          ) : (
            <MonacoGate>
              <ReleasingDiffEditor
                height="100%"
                language="json"
                original={inputText}
                modified={outputText}
                beforeMount={defineTelfloThemes}
                theme={preferences.theme}
                options={options}
                onMounted={preferences.attach}
              />
            </MonacoGate>
          )}
        </div>
        <DialogFooter>
          <RuleCandidatesFooter
            loaded={loaded}
            candidates={candidates}
            truncated={truncated}
            busyCandidate={busyCandidate}
            onCreateRule={onCreateRule}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
