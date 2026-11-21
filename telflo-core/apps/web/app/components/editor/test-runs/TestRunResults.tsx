import type {
  TestRunCompatibilityIssue,
  TestRunDetail,
  TestRunFile,
  TestRunMutation,
  TestRunStatus,
  TestRunSummary,
  ValidationPipeline,
} from "@telflo/contracts";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Clock,
  Download,
  FileCode,
  Info,
  Loader2,
  ShieldAlert,
  ShieldX,
  Terminal,
  Timer,
  Wand2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { downloadBlob } from "~/lib/download.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { abortAfter, isRunActive, RUNS_REQUEST_TIMEOUT_MS, useTestingStore, type RunTarget } from "~/lib/stores/testing-store.js";
import { sameTarget } from "~/lib/stores/validation-pipelines-store.js";
import type { RuleCandidate } from "~/lib/test-runs/diff-rule-detection.js";
import { decodeFileText } from "~/lib/test-runs/json-format.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { readsFor } from "~/lib/workspace-reads.js";
import { recordContextForSignal } from "../validation-pipelines/rule-builder-shapes.js";
import { RuleEditorDialog, type RulePrefill } from "../validation-pipelines/RuleEditorDialog.js";
import { CompareViewerDialog } from "./CompareViewerDialog.js";
import { FileViewerDialog } from "./FileViewerDialog.js";
import { statusLabel } from "./run-status.js";
import { ValidationResults } from "./ValidationResults.js";

interface StatusSpec {
  icon: typeof Check;
  className: string;
  spin?: boolean;
}

/** The status header circles, in the platform's tokens, "Validation Failed" included. */
const HEADER_BY_STATUS: Record<TestRunStatus, StatusSpec> = {
  queued: { icon: Clock, className: "bg-muted text-muted-foreground" },
  running: { icon: Loader2, className: "bg-brand-soft text-brand", spin: true },
  failed: { icon: XCircle, className: "bg-fail-soft text-fail" },
  validation_failed: { icon: ShieldX, className: "bg-warn-soft text-warn" },
  succeeded: { icon: Check, className: "bg-ok-soft text-ok" },
};

function StatusHeader({ run }: { run: TestRunSummary }) {
  const spec = HEADER_BY_STATUS[run.status];
  const Icon = spec.icon;
  return (
    <div className="flex items-center gap-3">
      <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${spec.className}`}>
        <Icon className={`w-5 h-5 ${spec.spin ? "animate-spin" : ""}`} />
      </span>
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Status</span>
        <span className="text-base font-medium text-foreground">{statusLabel(run)}</span>
      </div>
    </div>
  );
}

interface FileRowProps {
  label: string;
  /** The file's name, shown as text only. */
  fileName: string;
  onOpen: () => void;
  onDownload: () => void;
}

/**
 * A run's file: download, its label, and its name, which opens it. The name
 * is text, never an attribute: the download button is named by
 * hidden text through `aria-labelledby`, never `Download <name>` in
 * `aria-label` or `title`.
 */
function FileRow({ label, fileName, onOpen, onDownload }: FileRowProps) {
  const labelId = useId();
  return (
    <div className="grid grid-cols-[auto_auto_1fr] items-baseline gap-2">
      <span id={labelId} className="sr-only">
        Download {fileName}
      </span>
      <button
        type="button"
        onClick={onDownload}
        aria-labelledby={labelId}
        title="Download file"
        className="inline-flex items-center justify-center self-center text-brand hover:text-brand/80 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
      </button>
      <span className="tf-label">{label}:</span>
      <button
        type="button"
        onClick={onOpen}
        title="Open file"
        className="min-w-0 text-xs font-mono text-brand hover:underline hover:text-brand/80 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
      >
        {fileName}
      </button>
    </div>
  );
}

const SEVERITY_STYLES: Record<TestRunMutation["severity"], { label: string; badge: string; icon: typeof Info }> = {
  info: { label: "Info", badge: "border-brand/25 bg-brand-soft text-brand", icon: Info },
  caution: { label: "Caution", badge: "border-warn/25 bg-warn-soft text-warn", icon: ShieldAlert },
  warn: { label: "Warning", badge: "border-fail/25 bg-fail-soft text-fail", icon: ShieldAlert },
};

const HELP_TRIGGER_CLASS =
  "inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors";

const LINK_CLASS =
  "inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:underline hover:text-brand/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded";

/** The "Sandbox mutations" dialog. Its messages and details may name the text's components: `ph-no-capture`. */
export function MutationsDialog({
  mutations,
  open,
  onOpenChange,
}: {
  mutations: TestRunMutation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col ph-no-capture" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Sandbox mutations</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          The test runner rewrites your YAML before execution so the sandbox can run safely. Each entry below explains a
          change made to the configuration that was actually executed.
        </p>
        <div className="flex-1 min-h-0 overflow-auto">
          {mutations.length === 0 ? (
            <p className="text-[13px] text-muted-foreground italic">No mutations were applied.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {mutations.map((mutation, index) => {
                const style = SEVERITY_STYLES[mutation.severity];
                const Icon = style.icon;
                return (
                  <li key={`${mutation.id}-${index}`} className="rounded-md border border-border bg-muted/40 p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-[0.07em] ${style.badge}`}
                      >
                        <Icon className="w-3 h-3" />
                        {style.label}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground">{mutation.id}</span>
                    </div>
                    <p className="text-[13px] text-foreground whitespace-pre-wrap break-words">{mutation.message}</p>
                    {Object.keys(mutation.details).length > 0 && (
                      <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-words rounded border border-border bg-card p-2">
                        {JSON.stringify(mutation.details, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function readNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A C-003 advisory's recommended duration, as an actionable callout: the
 * value to type into "Run duration" next time (nothing is applied or re-run
 * on its own).
 */
function RecommendedDurationCallout({ issue, runDurationSeconds }: { issue: TestRunCompatibilityIssue; runDurationSeconds: number }) {
  const recommended = readNumber(issue.details, "recommended_duration_seconds");
  if (recommended === null) return null;
  const coversWindow = issue.details.recommended_covers_window;
  return (
    <div className="flex items-start gap-2 rounded border border-warn/25 bg-warn-soft px-2.5 py-2">
      <Timer className="w-4 h-4 mt-0.5 shrink-0 text-warn" />
      <div className="text-xs text-foreground">
        This run used a <span className="font-mono font-medium">{runDurationSeconds}s</span> window.{" "}
        {coversWindow === false ? (
          <>
            Even the maximum <span className="font-mono font-medium">{recommended}s</span> run won't fully cover this
            pipeline's decision window — lower the window to test it faithfully.
          </>
        ) : (
          <>
            Re-run with the <span className="font-medium">Run duration</span> set to at least{" "}
            <span className="font-mono font-medium">{recommended}s</span> for a faithful result.
          </>
        )}
      </div>
    </div>
  );
}

function CompatibilitySection({ issues, runDurationSeconds }: { issues: TestRunCompatibilityIssue[]; runDurationSeconds: number }) {
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="tf-label">Compatibility</div>
      <ul className="flex flex-col gap-2">
        {issues.map((issue, index) => {
          const isRefusal = issue.severity === "refuse";
          return (
            <li key={`${issue.id}-${index}`} className="rounded-md border border-border bg-muted/40 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${isRefusal ? "text-fail" : "text-warn"}`} />
                <span
                  className={`inline-flex items-center rounded-[4px] border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-[0.07em] ${
                    isRefusal ? "border-fail/25 bg-fail-soft text-fail" : "border-warn/25 bg-warn-soft text-warn"
                  }`}
                >
                  {isRefusal ? "Refused" : "Advisory"}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {issue.id} · {issue.component}
                </span>
              </div>
              <p className="text-[13px] text-foreground whitespace-pre-wrap break-words">{issue.message}</p>
              {issue.id === "C-003" && <RecommendedDurationCallout issue={issue} runDurationSeconds={runDurationSeconds} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A failed run's message (the tester's or the dispatcher's words for the person). */
function ErrorSection({ message }: { message: string | null }) {
  const text = message !== null && message.trim().length > 0 ? message : "(no error message captured)";
  return (
    <div>
      <div className="tf-label mb-2">Error</div>
      <pre className="h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs font-mono text-fail whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

/** A labeled link with its help, the results rows. */
function LinkRow({
  icon: Icon,
  label,
  title,
  onClick,
  helpLabel,
  helpTitle,
  help,
  disabled = false,
  buttonRef,
}: {
  icon: typeof FileCode;
  label: string;
  title: string;
  onClick: () => void;
  helpLabel: string;
  helpTitle: string;
  help: string;
  disabled?: boolean;
  /** The link's button (Compare's: the focus comes back to it as the rule editor closes). */
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`${LINK_CLASS} disabled:text-muted-foreground/60 disabled:no-underline disabled:cursor-not-allowed`}
      >
        <Icon className="w-3.5 h-3.5" />
        {label}
      </button>
      <HelpPopover label={helpLabel} title={helpTitle} triggerClassName={HELP_TRIGGER_CLASS} align="end">
        <p className="whitespace-pre-wrap">{help}</p>
      </HelpPopover>
    </div>
  );
}

type Viewer = "yaml" | "mutated-yaml" | "logs" | "input" | "output" | "compare" | "mutations" | null;

/** The name a run's output downloads as. */
export const OUTPUT_FILE_NAME = "test-output.json";

/** The name a run's logs download as. */
export const LOGS_FILE_NAME = "collector-logs.txt";

interface TestRunResultsProps {
  /** The selected run, as the list carries it; null for none. */
  run: TestRunSummary | null;
  /** Where the focus goes as the rule editor closes when the Compare link isn't there to take it: the list's selected row (TestRunsPanel's). */
  focusFallback?: (() => HTMLElement | null) | undefined;
  /** Told whether the rule editor Compare's chip opened shows, each time that changes (false as the results go): the list serves no focus request meanwhile. */
  onRuleEditorShown?: ((shown: boolean) => void) | undefined;
}

/** What a chip found no validation pipeline for says. */
export function noValidationPipelineMessage(pipeline: string): string {
  return `No validation pipeline exists for "${pipeline}" yet. Create one in the Validation tab first.`;
}

/** What a failed lookup says without the API's words. */
export const RESOLVE_PIPELINE_FAILED_MESSAGE = "Failed to resolve validation pipeline";

/**
 * The rule editor Compare's chip opened: the version and validation pipeline
 * it saves to, its prefill, made once per click, and the run whose Compare
 * it came from.
 */
interface RuleDraft {
  target: RunTarget;
  validationPipeline: ValidationPipeline;
  initial: RulePrefill;
  runId: string;
}

/**
 * The selected run's results, with Compare's rule editor (the validation parts
 * are ValidationResults'), and no `output_check` branch. The status, then,
 * once the run has ended and been read in full (once): its compatibility
 * findings, pipeline, the text submitted and the text run, the mutations, the
 * logs, its input and output with their viewers and downloads, Compare, and a
 * failed run's Error or else the Validation grid of the rules it copied when
 * it was queued (none for a run without rules). A run the rule evaluator
 * couldn't check ended Error (`rules_unavailable`): its message under Error,
 * its output, logs and text as any other's.
 *
 * - the files are the run's own (`GET …/test-runs/:runId/files/…`), read as
 *   bytes: a download keeps them exactly (downloadBlob, a detached anchor:
 *   no file name in the page), and a viewer decodes UTF-8 or UTF-16;
 * - the input's name is the run's snapshot, always there;
 * - the output row is "Output File" whether or not the run produced one
 *   ("no output produced");
 * - Compare reads the decoded input the tester sent (an OTLP run's) and the
 *   output; it is enabled only with both;
 * - a failed run's "Error" shows the run's error message, and the
 *   collector's logs stay under "Logs" (stderr isn't shown in both);
 * - the "Original YAML" is the text the run was queued with, organization
 *   variables substituted;
 * - replay: the panel and every dialog are `ph-no-capture`; no
 *   file name, text, log or finding reaches an attribute, and of a rule only
 *   its error does, as the row's tooltip inside the panel's block
 *   (ValidationResults);
 * - Compare's chip finds the run's validation pipeline itself, by the run's
 *   version and pipeline, read from the API whatever the Validation subtab's
 *   store holds (aborted after 10 s), every chip held and the one pressed busy
 *   meanwhile; an answer once Compare has closed, another run shows or the
 *   results have gone (a version or organization left) does nothing. None: the
 *   toast `No validation pipeline exists for "<p>" yet. Create one in the
 *   Validation tab first.`, Compare kept open; a failed lookup toasts the API's
 *   words, else "Failed to resolve validation pipeline"; both blocked from
 *   replay (`ph-no-capture`), as they carry the pipeline's name. Found:
 *   Compare closes (not left open under the editor) and the rule editor opens
 *   on it, prefilled: OTTL condition, the run's signal's record context (logs
 *   → log, traces → span, metrics → datapoint, never a store's leftover), the
 *   chip's Require and Condition, Name and Description empty. Its Save is the
 *   Validation subtab's, through the store's `createRule`; a save toasts "Rule
 *   added to {pipeline}". The editor is held here, beside the results, so a
 *   Play all's answer selecting another run, or another run's selection,
 *   leaves it open; leaving the version closes it. As it closes the focus goes
 *   back to the Compare link while the run is still the one selected and the
 *   link can be pressed, else to the list's selected row; its save's answer
 *   once it has gone (a version or organization left) does nothing
 *   (RuleEditorDialog's session);
 * - Compare closed with Escape or Close gives the focus back to the Compare
 *   link while it can be pressed, else the list's selected row (with no Radix
 *   trigger, Radix's own went to the body).
 * - in the playground, the run's files are the sample's (`readsFor`: its
 *   input and output open, viewed and downloaded, as reads), and Compare
 *   opens the sign-up prompt at its link (`useLockedAction`). Compare's
 *   pipeline lookup reads through `readsFor` too: unreachable there, a
 *   backstop.
 */
export function TestRunResults({ run, focusFallback, onRuleEditorShown }: TestRunResultsProps) {
  const locked = useLockedAction();
  const organizationId = useEditorStore((state) => state.organizationId);
  const shownConfigurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const shownVersionId = useEditorStore((state) => state.version?.id ?? null);
  const detail = useTestingStore((state) => (run === null ? undefined : state.runDetails[run.id]));
  const detailFailed = useTestingStore((state) => run !== null && state.runDetailFailedId === run.id);
  const retryRunDetail = useTestingStore((state) => state.retryRunDetail);
  const [viewer, setViewer] = useState<Viewer>(null);
  /** The place of Compare's chip whose validation pipeline is being looked up; null for none. */
  const [lookingUp, setLookingUp] = useState<number | null>(null);
  /** The rule editor a chip opened, kept beside the results (not in `renderEnded`), and whether it shows. */
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const compareLinkRef = useRef<HTMLButtonElement>(null);
  /** The run selected as of the last render: the editor's focus reads it as it closes. */
  const selectedRunId = useRef<string | null>(null);
  selectedRunId.current = run?.id ?? null;
  /**
   * Counts the lookups' sessions: a new lookup, Compare closing, another
   * run shown, the results unmounting (a version or organization left: the
   * list shows its placeholder). A lookup's answer acts only on its own; one
   * arriving once Compare has closed, another run shows or the results have
   * gone does nothing.
   */
  const lookupSession = useRef(0);
  /** The session of the lookup under way, if any: a second chip press meanwhile looks nothing up. */
  const lookupUnderWay = useRef<number | null>(null);
  /** Compare is closing for the rule editor: its own focus return is skipped, the editor taking the focus. */
  const comparingForEditor = useRef(false);

  /** Ends the lookup under way, if any: its answer will do nothing. */
  const endLookup = () => {
    lookupSession.current += 1;
    lookupUnderWay.current = null;
    setLookingUp(null);
  };

  // A run's files, read once each while it is shown (a viewer and its Download share the read).
  const files = useRef(new Map<string, Promise<Uint8Array>>());
  useEffect(() => {
    files.current.clear();
    setViewer(null);
    endLookup();
  }, [detail?.id]);

  // Gone (a version or organization left): a lookup under way toasts nothing over what shows next.
  useEffect(
    () => () => {
      lookupSession.current += 1;
    },
    [],
  );

  /** The version the editor shows, in its organization; null with none. */
  const shownTarget: RunTarget | null =
    organizationId === null || shownConfigurationId === null || shownVersionId === null
      ? null
      : { organizationId, configurationId: shownConfigurationId, versionId: shownVersionId };

  // Leaving the version closes the rule editor (as the Validation subtab's card editors close): it isn't reopened on
  // coming back.
  useEffect(() => {
    if (ruleDraft !== null && !sameTarget(ruleDraft.target, shownTarget)) setRuleEditorOpen(false);
  }, [organizationId, shownConfigurationId, shownVersionId, ruleDraft]);

  const ruleEditorShown = ruleDraft !== null && ruleEditorOpen && sameTarget(ruleDraft.target, shownTarget);

  // The list's focus requests wait on this: a Play all's, served under the
  // editor, would have Radix pull the focus back into it, selecting the
  // field's text. A child's effect: it runs before the list's in the same
  // commit.
  useEffect(() => {
    onRuleEditorShown?.(ruleEditorShown);
  }, [ruleEditorShown, onRuleEditorShown]);
  useEffect(() => () => onRuleEditorShown?.(false), [onRuleEditorShown]);

  const bytesOf = useCallback(
    (file: TestRunFile): Promise<Uint8Array> => {
      if (detail === undefined || organizationId === null) return Promise.reject(new Error("No test run selected"));
      const key = `${detail.id}:${file}`;
      const cached = files.current.get(key);
      if (cached !== undefined) return cached;
      const read = readsFor(organizationId).getTestRunFile(organizationId, detail.configurationId, detail.versionId, detail.id, file);
      files.current.set(key, read);
      read.catch(() => files.current.delete(key));
      return read;
    },
    [detail, organizationId],
  );

  const loadInputText = useCallback(() => bytesOf("input").then(decodeFileText), [bytesOf]);
  const loadOutputText = useCallback(() => bytesOf("output").then(decodeFileText), [bytesOf]);
  const loadDecodedInputText = useCallback(() => bytesOf("decoded-input").then(decodeFileText), [bytesOf]);
  const loadYamlText = useCallback(async () => detail?.yaml ?? "", [detail]);
  const loadMutatedYamlText = useCallback(async () => detail?.mutatedYaml ?? "", [detail]);
  const loadLogsText = useCallback(async () => {
    const text = detail?.logs?.trim() ?? "";
    return text.length > 0 ? text : "(no logs captured for this run)";
  }, [detail]);

  const download = async (bytes: () => Promise<Uint8Array | string>, fileName: string) => {
    try {
      const body = await bytes();
      // The bytes as they are (a copy over a plain ArrayBuffer, as Blob's type asks).
      downloadBlob(new Blob([typeof body === "string" ? body : new Uint8Array(body)], { type: "application/octet-stream" }), fileName);
    } catch (error) {
      const message = failureMessage(error, "Failed to download file");
      if (message !== null) toast.error(message);
    }
  };
  const downloadInput = () => download(() => bytesOf("input"), detail?.inputName ?? "input-file");
  const downloadOutput = () => download(() => bytesOf("output"), OUTPUT_FILE_NAME);
  const downloadLogs = () => download(loadLogsText, LOGS_FILE_NAME);

  const closeViewer = (open: boolean) => {
    if (!open) setViewer(null);
  };

  /** Compare closed (Escape, Close): a lookup under way does nothing more. */
  const closeCompare = (open: boolean) => {
    if (open) return;
    endLookup();
    setViewer(null);
  };

  /**
   * A chip pressed: the run's validation pipeline, by its version and
   * pipeline, read from the API; found, Compare closes and the editor opens
   * prefilled; none, a toast, Compare kept open.
   */
  const createRuleFrom = async (candidate: RuleCandidate, index: number) => {
    if (detail === undefined || organizationId === null || lookupUnderWay.current !== null) return;
    const ended = detail;
    const at = ++lookupSession.current;
    lookupUnderWay.current = at;
    setLookingUp(index);
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    try {
      const { validationPipelines } = await readsFor(organizationId).getValidationPipelines(organizationId, ended.configurationId, ended.versionId, {
        signal: timeout.signal,
      });
      if (at !== lookupSession.current) return;
      const found = validationPipelines.find((each) => each.pipeline === ended.pipeline);
      if (found === undefined) {
        // The pipeline's name is configuration text: the toast is blocked from replay.
        toast.error(noValidationPipelineMessage(ended.pipeline), { className: "ph-no-capture" });
        return;
      }
      setRuleDraft({
        target: { organizationId, configurationId: ended.configurationId, versionId: ended.versionId },
        validationPipeline: found,
        // The run's signal's record context, never the Validation subtab's store's.
        initial: { context: recordContextForSignal(ended.signal), quantifier: candidate.quantifier, condition: candidate.condition },
        runId: ended.id,
      });
      setRuleEditorOpen(true);
      comparingForEditor.current = true;
      setViewer(null);
    } catch (error) {
      if (at !== lookupSession.current) return;
      const message = failureMessage(error, RESOLVE_PIPELINE_FAILED_MESSAGE);
      if (message !== null) toast.error(message, { className: "ph-no-capture" });
    } finally {
      timeout.clear();
      if (at === lookupSession.current) {
        lookupUnderWay.current = null;
        setLookingUp(null);
      }
    }
  };

  /**
   * Compare closed. For the editor: the focus is left to the editor. Else
   * (Escape, Close): back to the Compare link while it is there and can be
   * pressed; else the list's selected row (`focusFallback`); else nothing.
   * Radix's own would go nowhere: Compare has no Radix trigger to go back to.
   */
  const focusAfterCompare = (event: Event) => {
    if (comparingForEditor.current) {
      comparingForEditor.current = false;
      event.preventDefault();
      return;
    }
    const link = compareLinkRef.current;
    const back = link !== null && link.isConnected && !link.disabled ? link : (focusFallback?.() ?? null);
    if (back === null) return;
    event.preventDefault();
    back.focus();
  };

  /**
   * The editor closed: back to the Compare link while its run is still the
   * one selected and the link is there and can be pressed; else the list's
   * selected row (`focusFallback`); else nothing (the list itself gone).
   */
  const focusAfterEditor = (event: Event) => {
    const link = compareLinkRef.current;
    const back =
      ruleDraft !== null && selectedRunId.current === ruleDraft.runId && link !== null && link.isConnected && !link.disabled
        ? link
        : (focusFallback?.() ?? null);
    if (back === null) return;
    event.preventDefault();
    back.focus();
  };

  const renderEnded = (ended: TestRunDetail) => {
    const outputAvailable = ended.outputSizeBytes !== null;
    const decodedInputAvailable = ended.decodedInputSizeBytes !== null;
    const mutations = ended.mutations ?? [];
    const logs = ended.logs?.trim() ?? "";
    return (
      <>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[auto_1fr] items-baseline gap-2">
            <span className="tf-label">Pipeline:</span>
            <span className="text-xs font-mono text-foreground">{ended.pipeline}</span>
          </div>
          <LinkRow
            icon={FileCode}
            label="Original YAML"
            title="View the YAML you submitted for this run"
            onClick={() => setViewer("yaml")}
            helpLabel="About Original YAML"
            helpTitle="Original YAML"
            help="The YAML configuration you submitted for this test run. This is the unmodified config exactly as it appeared in your editor when the test was triggered, before the sandbox applied any rewrites."
          />
          {ended.mutatedYaml && (
            <LinkRow
              icon={FileCode}
              label="Test YAML"
              title="View the YAML actually executed by the sandbox after mutations"
              onClick={() => setViewer("mutated-yaml")}
              helpLabel="About Test YAML"
              helpTitle="Test YAML"
              help="The YAML actually executed by the sandbox collector after rewrites were applied. Receivers and exporters are swapped for sandbox stand-ins so the test runs in isolation, and other fields (e.g. k8sattributes auth_type) may be rewritten when needed. Compare this with Original YAML to see exactly what was executed."
            />
          )}
          {mutations.length > 0 && (
            <LinkRow
              icon={Wand2}
              label={`Mutations (${mutations.length})`}
              title="View the sandbox mutations applied to your YAML"
              onClick={() => setViewer("mutations")}
              helpLabel="About Mutations"
              helpTitle="Mutations"
              help="Structured advisories describing each rewrite the sandbox applied to your YAML before executing it. Each entry includes a stable ID (e.g. R-001), a severity, and a human-readable explanation. Use this to audit divergence between the YAML you wrote and the YAML the collector actually ran."
            />
          )}
          {logs.length > 0 && (
            <LinkRow
              icon={Terminal}
              label="Logs"
              title="View the collector's stderr log for this run"
              onClick={() => setViewer("logs")}
              helpLabel="About Logs"
              helpTitle="Logs"
              help="The sandbox collector's stderr for this run. It captures startup diagnostics and per-record operator messages (e.g. a filelog operator that failed to parse or flatten a line). Useful when a run produced no output or fewer records than expected — the reason is usually logged here even when the run isn't marked Error."
            />
          )}
          <FileRow label="Input File" fileName={ended.inputName} onOpen={() => setViewer("input")} onDownload={() => void downloadInput()} />
          {outputAvailable ? (
            <FileRow label="Output File" fileName={OUTPUT_FILE_NAME} onOpen={() => setViewer("output")} onDownload={() => void downloadOutput()} />
          ) : (
            <div className="grid grid-cols-[auto_auto_1fr] items-baseline gap-2">
              <span className="w-3.5" aria-hidden />
              <span className="tf-label">Output File:</span>
              <span className="text-[13px] text-muted-foreground italic">no output produced</span>
            </div>
          )}
          <LinkRow
            icon={FileCode}
            label="Compare input ↔ output"
            title={
              outputAvailable && decodedInputAvailable
                ? "Compare parsed OTLP input vs output side-by-side"
                : !outputAvailable
                  ? "No output captured — nothing to compare"
                  : "Compare requires an OTLP input"
            }
            onClick={() => {
              if (locked) {
                locked("compare a run's input and output", compareLinkRef.current);
                return;
              }
              comparingForEditor.current = false;
              setViewer("compare");
            }}
            disabled={!outputAvailable || !decodedInputAvailable}
            buttonRef={compareLinkRef}
            helpLabel="About Compare"
            helpTitle="Compare input ↔ output"
            help="Side-by-side diff of the OTLP fixture sent into the pipeline vs the OTLP captured at the exporter. Available only for runs whose receiver accepts OTLP — for syslog, filelog, and similar non-OTLP receivers there is no pre-processor OTLP form to diff against."
          />
        </div>

        {ended.status === "failed" ? (
          <ErrorSection message={ended.errorMessage} />
        ) : (
          ended.validationResults !== null && (
            <ValidationResults key={ended.id} rules={ended.validationRules} results={ended.validationResults} />
          )
        )}

        <FileViewerDialog open={viewer === "yaml"} onOpenChange={closeViewer} title="Original YAML" loadText={loadYamlText} />
        <FileViewerDialog
          open={viewer === "mutated-yaml"}
          onOpenChange={closeViewer}
          title="Test YAML (after sandbox mutations)"
          loadText={loadMutatedYamlText}
        />
        <MutationsDialog mutations={mutations} open={viewer === "mutations"} onOpenChange={closeViewer} />
        <FileViewerDialog
          open={viewer === "logs"}
          onOpenChange={closeViewer}
          title="Collector logs (stderr)"
          loadText={loadLogsText}
          onDownload={downloadLogs}
        />
        <FileViewerDialog
          open={viewer === "input"}
          onOpenChange={closeViewer}
          title={ended.inputName}
          loadText={loadInputText}
          onDownload={downloadInput}
        />
        <FileViewerDialog
          open={viewer === "output"}
          onOpenChange={closeViewer}
          title="Test output"
          loadText={loadOutputText}
          onDownload={downloadOutput}
        />
        <CompareViewerDialog
          open={viewer === "compare"}
          onOpenChange={closeCompare}
          loadInputText={loadDecodedInputText}
          loadOutputText={loadOutputText}
          signal={ended.signal}
          outputTruncated={ended.outputTruncated === true}
          decodedInputTruncated={ended.decodedInputTruncated === true}
          onCreateRule={(candidate, index) => void createRuleFrom(candidate, index)}
          busyCandidate={lookingUp}
          onCloseAutoFocus={focusAfterCompare}
        />
      </>
    );
  };

  const renderBody = () => {
    if (run === null) {
      return (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <CircleDashed className="w-4 h-4" />
          No test selected
        </div>
      );
    }
    const ended = !isRunActive(run);
    return (
      <div className="flex flex-col gap-5">
        <StatusHeader run={run} />
        {detail !== undefined && (
          <CompatibilitySection issues={detail.compatibility ?? []} runDurationSeconds={detail.durationSeconds} />
        )}
        {ended && detail !== undefined && renderEnded(detail)}
        {ended && detail === undefined && detailFailed && (
          <div className="flex items-center gap-2 text-[13px] text-fail">
            Failed to load test run
            <Button type="button" variant="outline" size="sm" onClick={retryRunDetail}>
              Try again
            </Button>
          </div>
        )}
        {ended && detail === undefined && !detailFailed && (
          <div className="flex items-center" role="status" aria-label="Loading results">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div role="region" aria-label="Test results" className="h-full rounded-md border border-border bg-card p-4 overflow-auto ph-no-capture">
      {renderBody()}
      {/* Beside the results, not in renderEnded, and untouched by a change of run: a Play all's answer leaves it open. */}
      {ruleDraft !== null && (
        <RuleEditorDialog
          open={ruleEditorShown}
          onOpenChange={(open) => {
            if (!open) setRuleEditorOpen(false);
          }}
          target={ruleDraft.target}
          validationPipeline={ruleDraft.validationPipeline}
          rule={null}
          initial={ruleDraft.initial}
          onSaved={() => toast.success(`Rule added to ${ruleDraft.validationPipeline.pipeline}`, { className: "ph-no-capture" })}
          onCloseAutoFocus={focusAfterEditor}
        />
      )}
    </div>
  );
}
