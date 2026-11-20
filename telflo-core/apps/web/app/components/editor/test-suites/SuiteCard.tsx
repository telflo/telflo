import type { TestDefinition, TestSuite } from "@telflo/contracts";
import { ChevronDown, FastForward, Loader2, Pencil, Play, Plus, StepForward, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLockedAction } from "~/lib/playground/context.js";
import { isAlreadyGone, useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { selectIsPlayHeld, useTestingStore, type PlayAllMode, type RunTarget } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { HELD_TITLE } from "~/lib/test-runs/messages.js";
import { CreateTestConfigurationDialog } from "./CreateTestConfigurationDialog.js";
import { DeleteDefinitionDialog } from "./DeleteConfirmations.js";
import { useDialogShowing } from "./use-dialog-showing.js";

interface SuiteCardProps {
  target: RunTarget;
  suite: TestSuite;
  /** Edit suite, with the button pressed: the focus goes back to it as the dialog closes. */
  onEdit: (suite: TestSuite, opener: HTMLElement) => void;
  /** Delete suite, with the button pressed: the focus goes back to it when the confirmation closes without a delete. */
  onDelete: (suite: TestSuite, opener: HTMLElement) => void;
  /** A definition's Run test (Play one), with the button pressed: the focus goes back to it when nothing is queued. */
  onPlayOne: (suite: TestSuite, definition: TestDefinition, opener: HTMLElement) => void;
  /** Play all, in parallel or serially, with the button pressed, as `onPlayOne`. */
  onPlayAll: (suite: TestSuite, mode: PlayAllMode, opener: HTMLElement) => void;
  /** Called as the definition dialog or a definition's delete confirmation shows (`useDialogShowing`). */
  onDialogShown?: (() => () => void) | undefined;
}

const ICON_BUTTON =
  "inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors";

const PLAY_BUTTON = `${ICON_BUTTON} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`;

/**
 * One suite: its card, buttons, words and empty state. The header expands it to
 * its definitions, each with Run test and Delete, and "Add test
 * configuration" under them.
 *
 * - the definitions are read each time the card expands; a failed
 *   read shows inline with Retry ("Failed to load test configurations", or the
 *   API's words);
 * - a definition's delete is confirmed;
 * - Play all in parallel, Play all serially and each Run test are held,
 *   titled "Another run is in progress", by the one hold over every Play
 *   (the person's own run on the version, a Play all under way, a single
 *   run starting);
 * - in the playground, the Play alls, Edit suite, Delete suite, a
 *   definition's Run test and delete, and Add test configuration open the
 *   sign-up prompt at their buttons (`useLockedAction`); expanding a
 *   suite reads its sample definitions;
 * - names and descriptions are text under the app's `ph-mask`, never an
 *   attribute; the buttons' labels are fixed words, each described by its
 *   suite's or definition's name, by reference to that text
 *   (`aria-describedby`);
 * - closing the definition dialog gives the focus back to "Add test
 *   configuration", and a definition deleted gives it to the next row's first
 *   button, else the previous row's, else "Add test configuration"; closed
 *   without a delete (Cancel, Escape), the confirmation gives it back to the
 *   row's Delete (it has no Radix trigger, so Radix's own return would leave
 *   it on the page's body).
 */
export function SuiteCard({ target, suite, onEdit, onDelete, onPlayOne, onPlayAll, onDialogShown }: SuiteCardProps) {
  const locked = useLockedAction();
  const [expanded, setExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TestDefinition | null>(null);
  const idPrefix = useId();
  const suiteNameId = `${idPrefix}-name`;
  const addRef = useRef<HTMLButtonElement>(null);
  const definitionsRef = useRef<HTMLUListElement>(null);
  /** The place in the list of the definition just deleted: the focus goes to the row now there, as the confirmation closes. */
  const deletedAt = useRef<number | null>(null);
  /** The Delete that opened the confirmation: the focus goes back to it when the confirmation closes without a delete. */
  const deleteOpener = useRef<HTMLElement | null>(null);
  const definitions = useTestSuitesStore((state) => state.definitionsBySuite[suite.id]);
  const loading = useTestSuitesStore((state) => state.definitionsLoadingBySuite[suite.id] ?? false);
  const error = useTestSuitesStore((state) => state.definitionsErrorBySuite[suite.id] ?? null);
  const userId = useUserStore((state) => state.current?.user.id ?? null);
  const held = useTestingStore((state) => selectIsPlayHeld(state, userId, target.versionId));
  useDialogShowing(addOpen, onDialogShown);
  useDialogShowing(pendingDelete !== null, onDialogShown);

  const readDefinitions = () => {
    // A failure is the store's `definitionsErrorBySuite`, shown below.
    useTestSuitesStore
      .getState()
      .loadDefinitions(target, suite.id)
      .catch(() => undefined);
  };

  /**
   * After a delete: the row now at its place (its first button that can be
   * pressed), else the one before, else Add test configuration. Closed
   * without one (Cancel, Escape): back to the Delete that opened it, while it
   * is there.
   */
  const focusAfterDelete = (event: Event) => {
    const index = deletedAt.current;
    const opener = deleteOpener.current;
    deletedAt.current = null;
    deleteOpener.current = null;
    if (index === null) {
      if (opener === null || !opener.isConnected) return;
      event.preventDefault();
      opener.focus();
      return;
    }
    event.preventDefault();
    const rows = [...(definitionsRef.current?.children ?? [])];
    const row = rows[index] ?? rows[index - 1];
    (row?.querySelector<HTMLElement>("button:not([disabled])") ?? addRef.current)?.focus();
  };

  const deleteDefinition = async (definition: TestDefinition) => {
    const index = (definitions ?? []).findIndex((listed) => listed.id === definition.id);
    try {
      await useTestSuitesStore.getState().deleteDefinition(target, suite.id, definition.id);
      deletedAt.current = index;
    } catch (error) {
      // Already gone: it has left the list all the same.
      if (isAlreadyGone(error)) deletedAt.current = index;
      throw error;
    }
  };

  // Read afresh each time the card expands.
  useEffect(() => {
    // Only on expanding: the target and the suite are the card's for its life.
    if (expanded) readDefinitions();
  }, [expanded]);

  return (
    <li className="rounded-md border border-border bg-card overflow-hidden">
      {/* The expand target and the buttons are siblings: interactive elements can't nest in a <button>. */}
      <div className="flex items-center gap-3 pr-3 hover:bg-accent/50 transition-colors">
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          className="flex-1 min-w-0 grid grid-cols-[auto_1fr] items-center gap-3 pl-3 py-2 text-left focus-visible:outline-none focus-visible:bg-accent/50 transition-colors"
        >
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
          <div className="flex flex-col min-w-0">
            <span id={suiteNameId} className="text-[13px] font-medium text-foreground truncate">
              {suite.name}
            </span>
            {suite.description && <span className="text-xs text-muted-foreground truncate">{suite.description}</span>}
          </div>
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(event) =>
              locked ? locked("run a test suite against your config", event.currentTarget) : onPlayAll(suite, "parallel", event.currentTarget)
            }
            disabled={held}
            aria-label="Play all tests in parallel"
            aria-describedby={suiteNameId}
            title={held ? HELD_TITLE : "Play all in parallel"}
            className={PLAY_BUTTON}
          >
            <FastForward className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) =>
              locked ? locked("run a test suite against your config", event.currentTarget) : onPlayAll(suite, "serial", event.currentTarget)
            }
            disabled={held}
            aria-label="Play all tests serially"
            aria-describedby={suiteNameId}
            title={held ? HELD_TITLE : "Play all serially"}
            className={PLAY_BUTTON}
          >
            <StepForward className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => (locked ? locked("edit a test suite", event.currentTarget) : onEdit(suite, event.currentTarget))}
            aria-label="Edit suite"
            aria-describedby={suiteNameId}
            title="Edit suite"
            className={ICON_BUTTON}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => (locked ? locked("delete a test suite", event.currentTarget) : onDelete(suite, event.currentTarget))}
            aria-label="Delete suite"
            aria-describedby={suiteNameId}
            title="Delete suite"
            className={`${ICON_BUTTON} hover:bg-fail-soft hover:text-fail`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          {loading && definitions === undefined && error === null ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground" role="status" aria-label="Loading test configurations">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : (
            <>
              {error !== null && (
                <div className="flex items-center justify-between gap-2 px-3 py-3 text-xs">
                  <span className="text-fail">{error}</span>
                  <button
                    type="button"
                    onClick={readDefinitions}
                    disabled={loading}
                    className="h-7 px-2 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              )}
              {definitions !== undefined &&
                (definitions.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">No test configurations yet.</div>
                ) : (
                  <ul ref={definitionsRef} className="divide-y divide-border">
                    {definitions.map((definition) => (
                      <li key={definition.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2">
                        <div className="flex flex-col min-w-0">
                          <span id={`${idPrefix}-definition-${definition.id}`} className="text-[13px] text-foreground truncate">
                            {definition.name}
                          </span>
                          {definition.description && (
                            <span className="text-[11px] text-muted-foreground truncate">{definition.description}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={(event) =>
                              locked ? locked("run a test against your config", event.currentTarget) : onPlayOne(suite, definition, event.currentTarget)
                            }
                            disabled={held}
                            aria-label="Run test"
                            aria-describedby={`${idPrefix}-definition-${definition.id}`}
                            title={held ? HELD_TITLE : "Run test"}
                            className={PLAY_BUTTON}
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              if (locked) {
                                locked("delete a test configuration", event.currentTarget);
                                return;
                              }
                              deleteOpener.current = event.currentTarget;
                              setPendingDelete(definition);
                            }}
                            aria-label="Delete test configuration"
                            aria-describedby={`${idPrefix}-definition-${definition.id}`}
                            title="Delete test configuration"
                            className={`${ICON_BUTTON} hover:bg-fail-soft hover:text-fail`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ))}
              <button
                ref={addRef}
                type="button"
                onClick={(event) => (locked ? locked("add a test configuration", event.currentTarget) : setAddOpen(true))}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-brand border-t border-dashed border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add test configuration
              </button>
            </>
          )}
        </div>
      )}

      <CreateTestConfigurationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        target={target}
        suiteId={suite.id}
        onCloseAutoFocus={(event) => {
          // Back to "Add test configuration".
          if (addRef.current === null) return;
          event.preventDefault();
          addRef.current.focus();
        }}
      />

      <DeleteDefinitionDialog
        definition={pendingDelete}
        onConfirm={deleteDefinition}
        onClose={() => setPendingDelete(null)}
        onCloseAutoFocus={focusAfterDelete}
      />
    </li>
  );
}
