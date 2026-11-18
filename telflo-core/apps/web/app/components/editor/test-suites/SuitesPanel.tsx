import type { TestDefinition, TestSuite } from "@telflo/contracts";
import { FlaskConical, Loader2, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { isAlreadyGone, useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import type { PlayAllMode, RunTarget } from "~/lib/stores/testing-store.js";
import { DeleteSuiteDialog } from "./DeleteConfirmations.js";
import { SuiteCard } from "./SuiteCard.js";
import { SuiteEditorDialog } from "./SuiteEditorDialog.js";
import { useDialogShowing } from "./use-dialog-showing.js";

/** Another version's suites show as none: one array, so the selector answers the same each time. */
const NO_SUITES: TestSuite[] = [];

interface SuitesPanelProps {
  /** A definition's Run test (Play one), with the button pressed: the Testing tab queues it, asking the fixture-shape question first. */
  onPlayOne: (suite: TestSuite, definition: TestDefinition, opener: HTMLElement) => void;
  /** A card's Play all, in parallel or serially, with the button pressed. */
  onPlayAll: (suite: TestSuite, mode: PlayAllMode, opener: HTMLElement) => void;
  /** Called as one of the subtab's dialogs shows; what it returns, as that dialog closes (`useDialogShowing`, D14b Ruling 50). */
  onDialogShown?: () => () => void;
}

/**
 * The Testing tab's Suites subtab (D14b decisions 1, 2, 5, 8 and 9;
 * Preflight rulings 18 and 19): its help, words, empty states and
 * confirmation. The version open in the editor's suites,
 * each a SuiteCard; + creates one (SuiteEditorDialog). Suites can be
 * created, renamed, described and deleted on any version, published or not
 * (decision 5), by anyone who can see them (decision 8).
 *
 * Differences (the Parity Notes):
 * - the suites are read each time the subtab shows and when the version
 *   changes (Preflight ruling 18), not once a version; a failed read shows
 *   inline with Retry ("Failed to load test suites", or the API's words for
 *   a refusal), not a toast with no read again;
 * - Play one and the Play alls are the Testing tab's (`onPlayOne`,
 *   `onPlayAll`), held as every Play is (SuiteCard);
 * - in the playground (D31-1 decisions 24 and 31), every action that would
 *   change or run something is locked at its button (`useLockedAction`):
 *   Add suite opens the sign-up prompt, as SuiteCard's buttons do; the
 *   suites and their definitions read from the sample;
 * - closing the suite dialog gives the focus back to its opener (Add suite,
 *   Edit suite), and a suite deleted gives it to the next card's header, else
 *   the previous one's, else Add suite (D14b Ruling 38), and a confirmation
 *   closed without a delete (Cancel, Escape) gives it back to the card's
 *   Delete suite (D14b Ruling 51), not to the page;
 * - while any of its dialogs shows, the tab knows (`onDialogShown`), and a
 *   Play doesn't switch to Tests, which would unmount the dialog and lose
 *   what was typed in it (D14b Ruling 50);
 * - nothing here sends an analytics event, and no name reaches an attribute
 *   (Preflight ruling 19).
 */
export function SuitesPanel({ onPlayOne, onPlayAll, onDialogShown }: SuitesPanelProps) {
  const locked = useLockedAction();
  const organizationId = useEditorStore((state) => state.organizationId);
  const configurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const versionId = useEditorStore((state) => state.version?.id ?? null);
  const target = useMemo<RunTarget | null>(
    () =>
      organizationId === null || configurationId === null || versionId === null
        ? null
        : { organizationId, configurationId, versionId },
    [organizationId, configurationId, versionId],
  );
  const isTarget = (held: RunTarget | null) =>
    target !== null &&
    held !== null &&
    held.organizationId === target.organizationId &&
    held.configurationId === target.configurationId &&
    held.versionId === target.versionId;
  const suites = useTestSuitesStore((state) => (isTarget(state.target) ? state.suites : NO_SUITES));
  const loading = useTestSuitesStore((state) => isTarget(state.target) && state.suitesLoading);
  const loaded = useTestSuitesStore((state) => isTarget(state.target) && state.suitesLoaded);
  const error = useTestSuitesStore((state) => (isTarget(state.target) ? state.suitesError : null));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSuite, setEditingSuite] = useState<TestSuite | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TestSuite | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The button that opened the suite dialog: the focus goes back to it as the dialog closes. */
  const editorOpener = useRef<HTMLElement | null>(null);
  /** The place in the list of the suite just deleted: the focus goes to the card now there, as the confirmation closes. */
  const deletedAt = useRef<number | null>(null);
  /** The Delete suite that opened the confirmation: the focus goes back to it when the confirmation closes without a delete. */
  const deleteOpener = useRef<HTMLElement | null>(null);
  useDialogShowing(dialogOpen, onDialogShown);
  useDialogShowing(pendingDelete !== null, onDialogShown);

  // Read afresh each time the subtab shows (it mounts) and when the version changes.
  useEffect(() => {
    if (target !== null) void useTestSuitesStore.getState().loadSuites(target);
  }, [target]);

  if (target === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <FlaskConical className="w-5 h-5 text-muted-foreground mx-auto" />
          <p className="text-[13px] text-muted-foreground">Load a configuration version to manage suites.</p>
        </div>
      </div>
    );
  }

  const openCreate = () => {
    editorOpener.current = addRef.current;
    setEditingSuite(null);
    setDialogOpen(true);
  };

  const openEdit = (suite: TestSuite, opener: HTMLElement) => {
    editorOpener.current = opener;
    setEditingSuite(suite);
    setDialogOpen(true);
  };

  /** Back to the dialog's opener, while it is there. */
  const focusOpener = (event: Event) => {
    const opener = editorOpener.current;
    if (opener === null || !opener.isConnected) return;
    event.preventDefault();
    opener.focus();
  };

  const openDelete = (suite: TestSuite, opener: HTMLElement) => {
    deleteOpener.current = opener;
    setPendingDelete(suite);
  };

  /**
   * After a delete: the card now at its place, else the one before, else Add
   * suite. Closed without one (Cancel, Escape): back to the Delete suite that
   * opened it, while it is there (Ruling 51: the confirmation has no Radix
   * trigger, so Radix's own return would leave it on the page's body).
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
    const headers = [...(listRef.current?.querySelectorAll<HTMLElement>("button[aria-expanded]") ?? [])];
    (headers[index] ?? headers[index - 1] ?? addRef.current)?.focus();
  };

  const deleteSuite = async (suite: TestSuite) => {
    const index = suites.findIndex((listed) => listed.id === suite.id);
    try {
      await useTestSuitesStore.getState().deleteSuite(target, suite.id);
      deletedAt.current = index;
    } catch (error) {
      // Already gone: it has left the list all the same.
      if (isAlreadyGone(error)) deletedAt.current = index;
      throw error;
    }
  };

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <HelpPopover label="What is this panel?" title="Suites">
          <p>Suites are named groups of reusable test configurations scoped to the current configuration version.</p>
          <p>
            Use <span className="font-medium">+</span> to create a suite, then expand it and click{" "}
            <span className="font-medium">+ Add test configuration</span> to define individual tests inside.
          </p>
          <p>All runs appear in the Tests tab.</p>
        </HelpPopover>
        <button
          ref={addRef}
          type="button"
          onClick={locked ? (event) => locked("create a test suite", event.currentTarget) : openCreate}
          aria-label="Add suite"
          title="Add suite"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error !== null && (
          <div className="flex items-center justify-between gap-2 pb-2 text-[13px]">
            <span className="text-fail">{error}</span>
            <button
              type="button"
              onClick={() => void useTestSuitesStore.getState().loadSuites(target)}
              disabled={loading}
              className="h-7 px-2 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}
        {loading && !loaded ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground" role="status" aria-label="Loading test suites">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : !loaded ? null : suites.length === 0 ? (
          <div className="text-center py-6 text-[13px] text-muted-foreground">No suites yet. Click + to create one.</div>
        ) : (
          <ul ref={listRef} className="flex flex-col gap-2">
            {suites.map((suite) => (
              <SuiteCard
                key={suite.id}
                target={target}
                suite={suite}
                onEdit={openEdit}
                onDelete={openDelete}
                onPlayOne={onPlayOne}
                onPlayAll={onPlayAll}
                onDialogShown={onDialogShown}
              />
            ))}
          </ul>
        )}
      </div>

      <SuiteEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
        suite={editingSuite}
        onCloseAutoFocus={focusOpener}
      />

      <DeleteSuiteDialog
        suite={pendingDelete}
        onConfirm={deleteSuite}
        onClose={() => setPendingDelete(null)}
        onCloseAutoFocus={focusAfterDelete}
      />
    </div>
  );
}
