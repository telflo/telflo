import type { ValidationPipeline, ValidationRule } from "@telflo/contracts";
import { AlertTriangle, CheckSquare, ChevronDown, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import type { RunTarget } from "~/lib/stores/testing-store.js";
import { isAlreadyGone, isRuleWriteInFlight, useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { useDialogShowing } from "../test-suites/use-dialog-showing.js";
import { DeleteValidationRuleDialog } from "./DeleteConfirmations.js";
import { RegexLibraryPickerDialog } from "./RegexLibraryPickerDialog.js";
import { RuleEditorDialog } from "./RuleEditorDialog.js";
import { ruleDisplayName, ruleNameOrSummary, ruleTypeLabel, summarizeRule } from "./validation-display.js";

interface ValidationPipelineCardProps {
  target: RunTarget;
  validationPipeline: ValidationPipeline;
  /** Delete validation pipeline, with the button pressed: the focus goes back to it when the confirmation closes without a delete. */
  onDelete: (validationPipeline: ValidationPipeline, opener: HTMLElement) => void;
  /** Called as the rule editor, the regex library picker or a rule's delete confirmation shows (`useDialogShowing`): a Play doesn't switch subtabs under it. */
  onDialogShown?: (() => () => void) | undefined;
  /** Where the focus goes when the card itself is gone as a dialog of its closes (its pipeline dropped, "not found"): the panel's "+ Pipeline". */
  focusFallback?: (() => HTMLElement | null) | undefined;
}

/** A held rule's Edit's and Delete's look (as SuiteCard's held Play's). */
const HELD =
  "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground";

/** A held rule's Edit's and Delete's title, as a held Play's ("Another run is in progress"). */
const RULE_WRITE_HELD_TITLE = "A change to this rule is in progress";

const ICON_BUTTON =
  "inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors";

/**
 * One validation pipeline: its card, buttons, words and empty state. The
 * header expands it to its rules, each with Edit and Delete, and "Add
 * Validation Rule" and "Add from regex library" (the picker,
 * `RegexLibraryPickerDialog`) under them. A card whose pipeline isn't in the
 * editor's text ("pipeline not found in current YAML") stays fully editable:
 * runs only pick its rules up once the pipeline is there again.
 *
 * - the stale warning compares the pipeline's name with the editor's graph's
 *   pipelines, its current text's, as the runs test the text on screen;
 * - the rules are read each time the card mounts; a failed read shows inline
 *   with Retry ("Failed to load validation rules", or the API's words);
 * - the expand button and the buttons are siblings: Delete is never inside
 *   the expand button;
 * - each row's Edit and Delete are named by hidden text inside the panel's
 *   `ph-no-capture` block, "Edit rule 2: SSN guard" (the row's place, and the
 *   rule's name, else its summary; `aria-labelledby`); Delete validation
 *   pipeline is described by the pipeline's name (`aria-describedby`);
 * - a rule's delete is confirmed;
 * - closing the rule editor gives the focus back to its opener (Edit, Add
 *   Validation Rule), and closing the picker to "Add from regex library"; a
 *   rule deleted gives it to the next row's Edit, else the previous row's,
 *   else Add Validation Rule; a confirmation closed without a delete gives it
 *   back to the row's Delete; with neither there (the rules read again), the
 *   card's header; with the card itself gone (its pipeline "not found", even
 *   under a rule's confirmation), the panel's "+ Pipeline";
 * - a rule's Edit and Delete are held while a change or delete of it is under
 *   way (the store's `ruleWritesInFlight`), even once its editor
 *   was closed: reopened mid-save it would show the old text, and a plain
 *   Save would put it back. Held is `aria-disabled` (a click does nothing),
 *   titled "A change to this rule is in progress", and still focusable: the
 *   editor closed mid-save gives the focus back to its Edit, which a
 *   `disabled` button would drop to the page's body;
 * - the picker counts in the card's dialogs a Play doesn't switch subtabs
 *   under (`onDialogShown`), as the rule editor does;
 * - in the playground, the pipeline's delete, a rule's Edit and delete, Add
 *   Validation Rule and Add from regex library open the sign-up prompt at
 *   their buttons (`useLockedAction`): no rule is saved and the regex
 *   library is never read; expanding the card reads its sample rules.
 */
export function ValidationPipelineCard({ target, validationPipeline, onDelete, onDialogShown, focusFallback }: ValidationPipelineCardProps) {
  const locked = useLockedAction();
  const [expanded, setExpanded] = useState(false);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ValidationRule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ValidationRule | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const idPrefix = useId();
  const pipelineNameId = `${idPrefix}-pipeline`;
  const addRef = useRef<HTMLButtonElement>(null);
  const addFromLibraryRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const rulesRef = useRef<HTMLUListElement>(null);
  /** The button that opened the rule editor: the focus goes back to it as the editor closes. */
  const editorOpener = useRef<HTMLElement | null>(null);
  /** The place in the list of the rule just deleted: the focus goes to the row now there, as the confirmation closes. */
  const deletedAt = useRef<number | null>(null);
  /** The Delete that opened the confirmation: the focus goes back to it when the confirmation closes without a delete. */
  const deleteOpener = useRef<HTMLElement | null>(null);
  const rules = useValidationPipelinesStore((state) => state.rulesByPipeline[validationPipeline.id]);
  const loading = useValidationPipelinesStore((state) => state.rulesLoadingByPipeline[validationPipeline.id] ?? false);
  const error = useValidationPipelinesStore((state) => state.rulesErrorByPipeline[validationPipeline.id] ?? null);
  const ruleWrites = useValidationPipelinesStore((state) => state.ruleWritesInFlight);
  // A validation pipeline whose YAML pipeline left the editor's text (renamed
  // or deleted). Still fully editable and deletable, never hidden or removed;
  // runs won't pick its rules up until the name matches again.
  const stale = useEditorStore((state) => !state.graph.pipelines.some((pipeline) => pipeline.name === validationPipeline.pipeline));
  useDialogShowing(ruleDialogOpen, onDialogShown);
  useDialogShowing(pendingDelete !== null, onDialogShown);
  useDialogShowing(pickerOpen, onDialogShown);

  const readRules = () => {
    // A failure is the store's `rulesErrorByPipeline`, shown below.
    useValidationPipelinesStore
      .getState()
      .loadRules(target, validationPipeline.id)
      .catch(() => undefined);
  };

  // Read afresh each time the card mounts (the subtab shows, or the pipeline is created).
  useEffect(() => {
    // Only on mounting: the target and the pipeline are the card's for its life.
    readRules();
  }, []);

  const openAddRule = (opener: HTMLElement) => {
    editorOpener.current = opener;
    setEditingRule(null);
    setRuleDialogOpen(true);
  };

  const openEditRule = (rule: ValidationRule, opener: HTMLElement) => {
    editorOpener.current = opener;
    setEditingRule(rule);
    setRuleDialogOpen(true);
  };

  /**
   * With the dialog's own target gone: Add Validation Rule; else, not there
   * (the rules being read again, after a failed first read), the card's
   * header; else, the card gone (its pipeline "not found"), the
   * panel's fallback.
   */
  const nearestFallback = (): HTMLElement | null => {
    const add = addRef.current;
    const header = headerRef.current;
    if (add?.isConnected) return add;
    if (header?.isConnected) return header;
    return focusFallback?.() ?? null;
  };

  /** Back to the editor's opener, while it is there; else `nearestFallback`. */
  const focusEditorOpener = (event: Event) => {
    const opener = editorOpener.current;
    editorOpener.current = null;
    const back = opener !== null && opener.isConnected ? opener : nearestFallback();
    if (back === null) return;
    event.preventDefault();
    back.focus();
  };

  /** Back to "Add from regex library", while it is there; else `nearestFallback`. */
  const focusPickerOpener = (event: Event) => {
    const opener = addFromLibraryRef.current;
    const back = opener !== null && opener.isConnected ? opener : nearestFallback();
    if (back === null) return;
    event.preventDefault();
    back.focus();
  };

  /**
   * After a delete: the row now at its place (its Edit), else the one
   * before, else `nearestFallback`. Closed without one (Cancel, Escape, the
   * card gone under it): back to the Delete that opened it, while it is
   * there, else `nearestFallback`.
   */
  const focusAfterDelete = (event: Event) => {
    const index = deletedAt.current;
    const opener = deleteOpener.current;
    deletedAt.current = null;
    deleteOpener.current = null;
    let next: HTMLElement | null;
    if (index === null) {
      next = opener !== null && opener.isConnected ? opener : nearestFallback();
    } else {
      const rows = [...(rulesRef.current?.children ?? [])];
      const row = rows[index] ?? rows[index - 1];
      next = row?.querySelector<HTMLElement>("button") ?? nearestFallback();
    }
    if (next === null) return;
    event.preventDefault();
    next.focus();
  };

  const deleteRule = async (rule: ValidationRule) => {
    const index = (rules ?? []).findIndex((listed) => listed.id === rule.id);
    try {
      await useValidationPipelinesStore.getState().deleteRule(target, validationPipeline.id, rule.id);
      deletedAt.current = index;
    } catch (error) {
      // Already gone: it has left the list all the same.
      if (isAlreadyGone(error)) deletedAt.current = index;
      throw error;
    }
  };

  return (
    <li className="rounded-md border border-border bg-card overflow-hidden">
      {/* The expand target and the button are siblings: interactive elements can't nest in a <button>. */}
      <div className="flex items-center gap-3 pr-3 hover:bg-accent/50 transition-colors">
        <button
          ref={headerRef}
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          className="flex-1 min-w-0 grid grid-cols-[auto_1fr] items-center gap-3 pl-3 py-2 text-left focus-visible:outline-none focus-visible:bg-accent/50 transition-colors"
        >
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
          <div className="flex items-center gap-1.5 min-w-0">
            <span id={pipelineNameId} className="min-w-0 font-mono text-xs font-medium text-foreground truncate">
              {validationPipeline.pipeline}
            </span>
            {stale && (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-xs text-warn"
                title="This pipeline is not defined in the current YAML — rules here won't run until it is."
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="min-w-0 truncate">pipeline not found in current YAML</span>
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(event) => (locked ? locked("delete a validation pipeline", event.currentTarget) : onDelete(validationPipeline, event.currentTarget))}
            aria-label="Delete validation pipeline"
            aria-describedby={pipelineNameId}
            title="Delete validation pipeline"
            className={`${ICON_BUTTON} hover:bg-fail-soft hover:text-fail`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          {loading && rules === undefined && error === null ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground" role="status" aria-label="Loading validation rules">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : (
            <>
              {error !== null && (
                <div className="flex items-center justify-between gap-2 px-3 py-3 text-xs">
                  <span role="alert" className="text-fail">
                    {error}
                  </span>
                  <button
                    type="button"
                    onClick={readRules}
                    disabled={loading}
                    className="h-7 px-2 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              )}
              {rules !== undefined &&
                (rules.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">No validation rules yet.</div>
                ) : (
                  <ul ref={rulesRef} className="divide-y divide-border">
                    {rules.map((rule, index) => {
                      const rowId = `${idPrefix}-rule-${rule.id}`;
                      const named = ruleNameOrSummary(rule);
                      // A change or delete of it under way: held until the API answers.
                      const held = isRuleWriteInFlight(ruleWrites, target, rule.id);
                      return (
                        <li key={rule.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2">
                          <span
                            className="min-w-0 text-[13px] text-foreground truncate"
                            title={`${ruleTypeLabel(rule.kind, rule.target)}: ${summarizeRule(rule)}`}
                          >
                            {ruleDisplayName(rule)}
                          </span>
                          {/* The buttons' names: hidden text inside the panel's ph-no-capture block, never an attribute. */}
                          <span id={`${rowId}-edit`} className="sr-only">
                            Edit rule {index + 1}: {named}
                          </span>
                          <span id={`${rowId}-delete`} className="sr-only">
                            Delete rule {index + 1}: {named}
                          </span>
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={(event) => {
                                if (locked) locked("edit a validation rule", event.currentTarget);
                                else if (!held) openEditRule(rule, event.currentTarget);
                              }}
                              aria-disabled={held || undefined}
                              aria-labelledby={`${rowId}-edit`}
                              title={held ? RULE_WRITE_HELD_TITLE : "Edit rule"}
                              className={`${ICON_BUTTON} ${HELD}`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                if (locked) {
                                  locked("delete a validation rule", event.currentTarget);
                                  return;
                                }
                                if (held) return;
                                deleteOpener.current = event.currentTarget;
                                setPendingDelete(rule);
                              }}
                              aria-disabled={held || undefined}
                              aria-labelledby={`${rowId}-delete`}
                              title={held ? RULE_WRITE_HELD_TITLE : "Delete rule"}
                              className={`${ICON_BUTTON} hover:bg-fail-soft hover:text-fail ${HELD}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ))}
              <div className="flex border-t border-dashed border-border">
                <button
                  ref={addRef}
                  type="button"
                  onClick={(event) => (locked ? locked("add a validation rule", event.currentTarget) : openAddRule(event.currentTarget))}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-brand hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Validation Rule
                </button>
                <button
                  ref={addFromLibraryRef}
                  type="button"
                  onClick={(event) => (locked ? locked("add rules from the regex library", event.currentTarget) : setPickerOpen(true))}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-brand border-l border-dashed border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  Add from regex library
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <RuleEditorDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        target={target}
        validationPipeline={validationPipeline}
        rule={editingRule}
        onCloseAutoFocus={focusEditorOpener}
      />

      <RegexLibraryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        target={target}
        validationPipeline={validationPipeline}
        onCloseAutoFocus={focusPickerOpener}
      />

      <DeleteValidationRuleDialog
        rule={pendingDelete}
        onConfirm={deleteRule}
        onClose={() => setPendingDelete(null)}
        onCloseAutoFocus={focusAfterDelete}
      />
    </li>
  );
}
