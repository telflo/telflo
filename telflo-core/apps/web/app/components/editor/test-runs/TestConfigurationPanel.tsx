import {
  TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_DEFINITION_NAME_MAXIMUM_LENGTH,
  TEST_RUN_DURATION_MAXIMUM_SECONDS,
  TEST_RUN_DURATION_MINIMUM_SECONDS,
} from "@telflo/contracts";
import { ClipboardPaste, FileText, LayoutTemplate } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { ApiError } from "~/lib/api-client.js";
import { isRunDuration, useTestingStore, type SelectedTestInput } from "~/lib/stores/testing-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { MyFilesPanel } from "./MyFilesPanel.js";
import { PasteSamplePanel } from "./PasteSamplePanel.js";
import { TemplatesPanel } from "./TemplatesPanel.js";
import { UploadPanel } from "./UploadPanel.js";

/*
 * The test configuration panel, shared by the run dialog (RunTestDialog.tsx)
 * and the definition dialog (test-suites/CreateTestConfigurationDialog.tsx),
 * so its fixes hold in both.
 */

/**
 * The input the panel has chosen: one of the person's files, by its id and
 * the name it showed, or a template, by its id and its name.
 */
export type { SelectedTestInput };

/** Whether a submission failed because the template picked has been deleted since (the API's 404). */
export function isTemplateGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === "test_template_not_found";
}

/** What the panel submits: the input, a pipeline by its name in the text, the duration, and the name fields' values (trimmed; `''` when not shown). */
export interface TestConfigurationValues {
  input: SelectedTestInput;
  pipelineName: string;
  durationSeconds: number;
  name: string;
  description: string;
}

type WizardStep = "main" | "my-files" | "templates" | "paste" | "upload";

interface TestConfigurationPanelProps {
  /** The duration it opens with: the remembered one. */
  initialDurationSeconds: number;
  /** The input it opens with: the run dialog's remembered file or template; none for a definition. */
  initialInput: SelectedTestInput | null;
  /** The pipeline it opens with, by name: the remembered one, else (or when the text no longer has it) the first. */
  initialPipelineName: string | null;
  /** Name and Description fields above the rest, the name required once trimmed (a definition's). */
  showNameFields?: boolean;
  /** The submit button's words, and its words while submitting: "Run" and "Starting…" unless given. */
  submitLabel?: string;
  submittingLabel?: string;
  /** Submits; a rejection is toasted (the API's words, else "Submission failed") and the panel stays. */
  onSubmit: (values: TestConfigurationValues) => Promise<void>;
  onCancel: () => void;
}

/** A slot the panel has slid away from: out of the tab order and the accessibility tree while hidden. */
function hiddenSlot(hidden: boolean) {
  return hidden ? { inert: true, "aria-hidden": true } : {};
}

/** The controls a slide may focus, in document order (the hidden file input and tabIndex -1 elements aren't). */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Focuses `slot`'s first control, else `slot` itself: the dialog's slides
 * call it. Without scrolling: the slot is still off to the side while the
 * track's transform slides it in, and Firefox and WebKit would scroll the
 * clipping box to show it, leaving the slid-in panel part hidden.
 */
export function focusIntoSlot(slot: HTMLElement): void {
  (slot.querySelector<HTMLElement>(FOCUSABLE) ?? slot).focus({ preventScroll: true });
}

/** Which of the three slots shows `step`: the main view, the sub-panel, or the upload panel. */
function slotOf(step: WizardStep): 0 | 1 | 2 {
  return step === "main" ? 0 : step === "upload" ? 2 : 1;
}

/**
 * The test configuration panel: a three-slot sliding wizard, the
 * main view (the pipeline, the duration, where the file comes from), a
 * sub-panel (My Files, Templates or Paste) and the upload panel, reached
 * from My Files.
 *
 * Differences:
 * - a template picked and deleted before the submit gets the API's words,
 *   leaves the selection, and the templates are read again, as a file deleted
 *   does; the templates step reads them afresh each time it shows
 *   (TemplatesPanel);
 * - it writes no choice to the store: what it opens with comes in its props,
 *   and what it chose goes out through `onSubmit`, so the definition dialog
 *   leaves the run dialog's remembered file and pipeline as they were, never
 *   writing its choice into the shared selection on a submit;
 * - the name fields' ids, as every id here, come from `useId`, never fixed
 *   (`test-config-name`); they take no more than the API keeps
 *   (`maxLength`);
 * - the pipelines are the canvas's (`graph.pipelines`), chosen by name, the
 *   last one run first, else the first;
 * - My Files are read each time the dialog opens, and a file deleted (here,
 *   or by another tab before a read) leaves the selection;
 * - the duration must be a whole number of seconds, 1-60: 1.5 is never cut
 *   to 1 and run;
 * - a slot slid out of view is inert and hidden from assistive technology,
 *   never reachable by Tab; and a slide moves the focus into the slot slid
 *   in, to its first control, else to the slot itself, never left on the
 *   button that slid, now hidden (the browser would drop it to `<body>`);
 *   the focus never scrolls the track's clipping box, and the box clips
 *   (`overflow: clip`), so it is no scroll container and a control reached
 *   by Tab mid-slide can't scroll it either;
 * - the upload panel stays mounted through its slides to and from My Files,
 *   and starts empty each time it is shown;
 * - the pipeline's and the file's names show as text only: the select's
 *   values are the pipelines' opaque ids.
 */
export function TestConfigurationPanel({
  initialDurationSeconds,
  initialInput,
  initialPipelineName,
  showNameFields = false,
  submitLabel = "Run",
  submittingLabel = "Starting…",
  onSubmit,
  onCancel,
}: TestConfigurationPanelProps) {
  const organizationId = useEditorStore((state) => state.organizationId);
  const locked = useLockedAction();
  const pipelines = useEditorStore((state) => state.graph.pipelines);
  const loadFiles = useTestingStore((state) => state.loadFiles);
  const files = useTestingStore((state) => state.files);
  const filesListed = useTestingStore(
    (state) => state.filesLoaded && !state.filesLoading && state.filesOrganizationId === organizationId,
  );
  const templates = useTestingStore((state) => state.templates);
  const templatesListed = useTestingStore((state) => state.templatesLoaded && !state.templatesLoading);
  const labelId = useId();

  const [step, setStep] = useState<WizardStep>("main");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [input, setInput] = useState<SelectedTestInput | null>(initialInput);
  const [pipelineName, setPipelineName] = useState<string | null>(() =>
    pipelines.some((pipeline) => pipeline.name === initialPipelineName) ? initialPipelineName : (pipelines[0]?.name ?? null),
  );
  const [durationText, setDurationText] = useState(String(initialDurationSeconds));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const slots = useRef<(HTMLDivElement | null)[]>([null, null, null]);
  const slid = useRef(false);

  // A slide moves the focus into the slot slid in: its first control, else
  // the slot itself. Not as the dialog opens: Radix focuses it.
  useEffect(() => {
    if (!slid.current) {
      slid.current = true;
      return;
    }
    const slot = slots.current[slotOf(step)];
    if (slot !== null && slot !== undefined) focusIntoSlot(slot);
  }, [step]);

  // My Files, read afresh each time the dialog opens (not once a session).
  useEffect(() => {
    if (organizationId === null) return;
    loadFiles(organizationId).catch((error: unknown) => {
      if (failureMessage(error, "") !== null) toast.error("Failed to load test input files");
    });
  }, [organizationId, loadFiles]);

  // A file deleted, here or by another tab before the read, leaves the
  // selection; so does a template a fresh read no longer lists.
  useEffect(() => {
    if (input?.kind === "file" && filesListed && !files.some((listed) => listed.id === input.id)) setInput(null);
    if (input?.kind === "template" && templatesListed && !templates.some((listed) => listed.id === input.id)) setInput(null);
  }, [input, files, filesListed, templates, templatesListed]);

  const goToMain = () => setStep("main");
  const goToMyFiles = () => setStep("my-files");

  const durationSeconds = durationText.trim() === "" ? Number.NaN : Number(durationText);
  const durationValid = isRunDuration(durationSeconds);
  const selectedPipeline = pipelines.find((pipeline) => pipeline.name === pipelineName) ?? null;
  const canSubmit =
    input !== null && selectedPipeline !== null && (!showNameFields || name.trim().length > 0) && durationValid && !isSubmitting;
  /** The chosen input's name as its list shows it now (a fresh read may differ), else as it was chosen. */
  const inputName =
    input === null
      ? null
      : input.kind === "file"
        ? (files.find((listed) => listed.id === input.id)?.displayName ?? input.displayName)
        : (templates.find((listed) => listed.id === input.id)?.name ?? input.name);

  const handleSubmit = async () => {
    if (!canSubmit || input === null || selectedPipeline === null) return;
    setIsSubmitting(true);
    try {
      await onSubmit({
        input,
        pipelineName: selectedPipeline.name,
        durationSeconds,
        name: showNameFields ? name.trim() : "",
        description: showNameFields ? description.trim() : "",
      });
    } catch (error) {
      const message = failureMessage(error, "Submission failed");
      if (message !== null) toast.error(message);
      // The template was deleted since it was picked: it leaves the selection, and the list is read again.
      if (input.kind === "template" && isTemplateGone(error)) {
        setInput(null);
        useTestingStore
          .getState()
          .loadTemplates(organizationId)
          .catch(() => undefined);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderSubPanel = () => {
    if (organizationId === null) return null;
    switch (step) {
      case "my-files":
      case "upload":
        return (
          <MyFilesPanel
            organizationId={organizationId}
            onDone={goToMain}
            onCancel={goToMain}
            onSelectFile={(selected) => setInput({ kind: "file", ...selected })}
            onRequestUpload={() => setStep("upload")}
          />
        );
      case "templates":
        return (
          <TemplatesPanel
            onDone={goToMain}
            onCancel={goToMain}
            onSelectTemplate={(selected) => setInput({ kind: "template", ...selected })}
          />
        );
      case "paste":
        return (
          <PasteSamplePanel
            organizationId={organizationId}
            signalType={selectedPipeline?.signalType ?? null}
            pipelineName={selectedPipeline?.name ?? null}
            onDone={(saved) => {
              setInput({ kind: "file", id: saved.id, displayName: saved.displayName });
              goToMain();
            }}
            onCancel={goToMain}
          />
        );
      default:
        return null;
    }
  };

  const translateClass = step === "main" ? "translate-x-0" : step === "upload" ? "-translate-x-2/3" : "-translate-x-1/3";

  const optionBtnClass =
    "w-full px-3 py-2 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground text-left";

  return (
    // The track moves by its transform, never by scrolling: a browser that
    // scrolls this clipping box to show a control focused by Tab while a
    // slide is still under way (WebKit and Firefox did, in browser tests)
    // would leave the slot slid in part hidden. So the box clips
    // (`overflow: clip`) rather than hides: it is no scroll container, and
    // nothing can scroll it, in any of the three browsers. Not being one, its
    // minimum width as the dialog's grid item would be its content's, and the
    // paste editor (automaticLayout) and the box would widen each other
    // without end: `min-w-0` keeps it the dialog's width.
    <div className="overflow-clip min-w-0 h-[26rem]" data-run-dialog-track="">
      <div className={`flex w-[300%] h-full transition-transform duration-300 ${translateClass}`}>
        {/* The main view */}
        <div
          ref={(element) => {
            slots.current[0] = element;
          }}
          tabIndex={-1}
          data-run-dialog-slot=""
          className="w-1/3 shrink-0 pr-2 flex flex-col h-full outline-none"
          {...hiddenSlot(step !== "main")}
        >
          <div className="flex-1 flex flex-col gap-2 min-h-0 overflow-y-auto">
            {showNameFields && (
              <>
                <div className="flex flex-col gap-1 pb-1">
                  <Label htmlFor={`${labelId}-name`} className="text-xs font-medium text-muted-foreground">
                    Name
                  </Label>
                  <Input
                    id={`${labelId}-name`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={TEST_DEFINITION_NAME_MAXIMUM_LENGTH}
                    placeholder="Logs only"
                  />
                </div>
                <div className="flex flex-col gap-1 pb-2">
                  <Label htmlFor={`${labelId}-description`} className="text-xs font-medium text-muted-foreground">
                    Description
                  </Label>
                  <Textarea
                    id={`${labelId}-description`}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH}
                    placeholder="Optional — what this test verifies"
                    rows={2}
                  />
                </div>
                <hr className="my-1 border-border" />
              </>
            )}

            <div className="flex flex-col gap-1 pb-2">
              <label id={`${labelId}-pipeline`} className="text-xs font-medium text-muted-foreground">
                Test Pipeline
              </label>
              <Select
                value={selectedPipeline?.id ?? ""}
                onValueChange={(id) => setPipelineName(pipelines.find((pipeline) => pipeline.id === id)?.name ?? null)}
                disabled={pipelines.length === 0}
              >
                <SelectTrigger aria-labelledby={`${labelId}-pipeline`}>
                  <SelectValue placeholder="No pipelines" />
                </SelectTrigger>
                <SelectContent>
                  {pipelines.map((pipeline) => (
                    <SelectItem key={pipeline.id} value={pipeline.id}>
                      {pipeline.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 pb-2">
              <Label htmlFor={`${labelId}-duration`} className="text-xs font-medium text-muted-foreground">
                Run duration (seconds)
              </Label>
              <Input
                id={`${labelId}-duration`}
                type="number"
                inputMode="numeric"
                min={TEST_RUN_DURATION_MINIMUM_SECONDS}
                max={TEST_RUN_DURATION_MAXIMUM_SECONDS}
                value={durationText}
                onChange={(event) => setDurationText(event.target.value)}
                aria-invalid={!durationValid}
                aria-describedby={durationValid ? `${labelId}-duration-help` : `${labelId}-duration-error ${labelId}-duration-help`}
                // A typed value: replay never records the field.
                className="font-mono ph-no-capture"
              />
              <p id={`${labelId}-duration-help`} className="text-[11px] text-muted-foreground">
                How long the collector keeps running after the fixture is delivered. Bump this for pipelines with
                `batch.timeout` or `tail_sampling.decision_wait` longer than 5s. Range {TEST_RUN_DURATION_MINIMUM_SECONDS}–
                {TEST_RUN_DURATION_MAXIMUM_SECONDS}.
              </p>
              {!durationValid && (
                <p id={`${labelId}-duration-error`} className="text-[11px] text-fail">
                  Must be an integer between {TEST_RUN_DURATION_MINIMUM_SECONDS} and {TEST_RUN_DURATION_MAXIMUM_SECONDS}.
                </p>
              )}
            </div>

            <hr className="my-1 border-border" />

            <span className="text-xs font-medium text-muted-foreground pb-1">Choose Test File</span>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("my-files")}
                className={`${optionBtnClass} flex-1 flex items-center justify-between gap-2`}
              >
                <span>My Files</span>
                <FileText className="w-4 h-4 shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => setStep("templates")}
                className={`${optionBtnClass} flex-1 flex items-center justify-between gap-2`}
              >
                <span>Templates</span>
                <LayoutTemplate className="w-4 h-4 shrink-0" />
              </button>
              <button
                type="button"
                // A pasted sample is saved as a file: locked in the playground.
                onClick={(event) => (locked ? locked("save a pasted sample", event.currentTarget) : setStep("paste"))}
                className={`${optionBtnClass} flex-1 flex items-center justify-between gap-2`}
              >
                <span>Paste Text</span>
                <ClipboardPaste className="w-4 h-4 shrink-0" />
              </button>
            </div>

            <p className="text-[13px] text-muted-foreground mt-4">
              Selected File: <span className="font-mono text-xs">{inputName ?? "None"}</span>
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
            >
              {isSubmitting ? submittingLabel : submitLabel}
            </button>
          </div>
        </div>

        {/* The sub-panel: My Files, Templates or Paste */}
        <div
          ref={(element) => {
            slots.current[1] = element;
          }}
          tabIndex={-1}
          data-run-dialog-slot=""
          className="w-1/3 shrink-0 px-2 outline-none"
          {...hiddenSlot(step === "main" || step === "upload")}
        >
          {renderSubPanel()}
        </div>

        {/* The upload panel, reached from My Files */}
        <div
          ref={(element) => {
            slots.current[2] = element;
          }}
          tabIndex={-1}
          data-run-dialog-slot=""
          className="w-1/3 shrink-0 pl-2 outline-none"
          {...hiddenSlot(step !== "upload")}
        >
          {/* Mounted while My Files or the upload panel shows, so it stays through either slide between them. */}
          {organizationId !== null && (step === "my-files" || step === "upload") && (
            <UploadPanel organizationId={organizationId} active={step === "upload"} onDone={goToMyFiles} onCancel={goToMyFiles} />
          )}
        </div>
      </div>
    </div>
  );
}
