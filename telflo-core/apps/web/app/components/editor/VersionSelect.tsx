import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, Edit, Lock } from "lucide-react";
import type { ConfigurationVersionSummary } from "@telflo/contracts";
import { CreateVersionDialog } from "~/components/editor/CreateVersionDialog.js";
import { RenameVersionDialog } from "~/components/editor/RenameVersionDialog.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectGroup, SelectLabel, SelectTrigger } from "~/components/ui/select.js";
import { PUBLISHED_IMMUTABLE_LABEL } from "~/lib/editor/publishing.js";
import { useCreateVersion } from "~/lib/editor/use-create-version.js";
import { versionLabelText } from "~/lib/editor/version-label.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/** A version's name as shown: its label, or "Version N". */
function shownLabel(version: Pick<ConfigurationVersionSummary, "versionNumber" | "label">): string {
  return versionLabelText(version.versionNumber, version.label);
}

/** The row (a Radix item) holding `element`, or `element` itself when it is one. */
function rowOf(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[role="option"]') ?? null;
}

/** What a row's pencil and a published row's lock carry: Tab reaches either from its row. */
const ROW_CONTROL = "[data-rename-version], [data-version-lock]";

/** A row's pencil, or its lock on a published row. */
function pencilOf(row: Element | null): HTMLElement | null {
  return row?.querySelector<HTMLElement>(ROW_CONTROL) ?? null;
}

/*
 * The version picker (ADR 0018; D10 decision 10), in the
 * toolbar's actions: "Version:", then a Radix Select of the configuration's
 * versions, highest number first, from the editor's store. Differences, all
 * in the D10 Parity Notes:
 * - each row shows, under the label, `v{n}`, the creator's email ("—"
 *   without one) and the last saved date (`toLocaleDateString`, as D7's
 *   list), separated by " · ", each truncating; the list is 20 rem wide so
 *   that line fits (not `v{n}` alone, 14 rem wide);
 * - choosing a row navigates to its address, replacing the history entry;
 *   while the editor is dirty D8's one navigation guard holds it and asks
 *   (the picker has no copy of the dialog of its own);
 * - "Create New Version" is disabled while a save or a create is under way
 *   (so a double click can't make two versions); the
 *   create is `useCreateVersion`, from the open version with its unsaved
 *   changes;
 * - every draft row has the pencil, "Rename version", described by its row's
 *   text through `aria-describedby` (opaque ids; D10 Ruling 33), so a
 *   screen reader says which version it renames. A published row has
 *   a lock in its place (D11b decisions 4 and 13): fixed text,
 *   "Published versions are immutable", as its `aria-label` and its tooltip
 *   (`title`, the toolbar's pattern), described by its row's text the same
 *   way; and the row's second line ends with "Published", as text. The lock
 *   takes the focus where the pencil would (not `aria-hidden` or
 *   unreachable), so a keyboard reaches what it says;
 * - the trigger is named by "Version:" and the text it shows, through
 *   `aria-labelledby` (opaque ids), not an `aria-label`. "Version:" shows
 *   on wide screens only (Tailwind's `2xl`), and the trigger narrows below
 *   them from 14 rem to 10 rem, its label truncating, so the toolbar fits
 *   beside the sidebar (D13a Ruling 42); "Version:" stays its name, read
 *   at every width (`sr-only`);
 * - the pencils and "Create New Version" are reachable by keyboard (D10
 *   Ruling 28; Radix's list swallows Tab otherwise). Tab goes
 *   from the focused row to its pencil, then to "Create New Version";
 *   Shift+Tab goes back. Enter or Space on a pencil is the button's click,
 *   which opens the rename dialog without choosing its row (Radix's row
 *   takes only keys aimed at itself); Enter on "Create New Version" opens
 *   the create dialog. The arrow keys from a pencil or from "Create New
 *   Version" move between the rows as from the pencil's row (Radix's own
 *   would start from the top), and Escape closes the list as before.
 * The rows are built from the Radix primitive, with the
 * pencil a sibling of the item's text (inside it, its clicks would choose
 * the row), stopping its pointer events, and opening its dialog only after
 * the Select has closed, whose pointer lock on the page would otherwise
 * outlast it. "Create New Version" opens its dialog the same way. "After"
 * is once the list has gone, when the Select returns focus to its trigger
 * (`onCloseAutoFocus`), not a timer: the list's closing animation can
 * outlast a timer, and its focus return would then take the focus from the
 * dialog's field, so what is typed next would reach the trigger (found by
 * the browser tests, D10 Task 5). The lock does nothing on Enter or Space.
 * When a dialog closes (Cancel, Escape, or
 * done), the focus goes back to the trigger (D10's final review): Radix's
 * dialog would return it to a dialog trigger of its own, which these
 * dialogs, opened from the list, don't have, and so leave it on the page's
 * body.
 *
 * Privacy (ADR 0024; decision 10): labels and emails are text only. No
 * attribute carries them: not `title`, not `aria-label`, not an option's
 * value, which are the versions' opaque ids. Addresses keep the
 * configuration's id exactly as the address spells it (another spelling
 * would be another configuration to the page; D10 Preflight ruling 5).
 */
export function VersionSelect() {
  const navigate = useNavigate();
  const { configurationId: addressedConfigurationId } = useParams();
  const configurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const version = useEditorStore((state) => state.version);
  const versions = useEditorStore((state) => state.versions);
  const isSaving = useEditorStore((state) => state.isSaving);
  // The store's, the only record of a create under way (D10 Ruling 45).
  const isCreating = useEditorStore((state) => state.isCreatingVersion);
  const { createVersion } = useCreateVersion();
  const [selectOpen, setSelectOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConfigurationVersionSummary | null>(null);
  const labelId = useId();
  const shownId = useId();
  /** Each row's text's id is this and the row's index: opaque, never the label (Ruling 33). */
  const rowTextId = useId();
  const createRef = useRef<HTMLButtonElement>(null);
  /** The pencil last focused, which Shift+Tab from "Create New Version" returns to. */
  const lastPencil = useRef<HTMLElement | null>(null);

  const choose = (versionId: string) => {
    if (version === null || versionId === version.id) return;
    void navigate(`/editor/${addressedConfigurationId ?? configurationId}/${versionId}`, { replace: true });
  };

  const triggerRef = useRef<HTMLButtonElement>(null);
  /** A dialog to open once the list has gone (`afterClosing`). */
  const openAfterClosing = useRef<(() => void) | null>(null);

  // Once the Select has closed: its pointer lock on the page, and its focus
  // return to the trigger, would outlast a dialog opened at once.
  const afterClosing = (open: () => void) => {
    openAfterClosing.current = open;
    setSelectOpen(false);
  };

  // The list has gone, and Radix is about to return the focus to the
  // trigger: with a dialog to open, the trigger takes the focus now, then
  // the dialog opens and its field takes it, with nothing left to take it
  // back.
  const handleCloseAutoFocus = (event: Event) => {
    const open = openAfterClosing.current;
    if (open === null) return;
    openAfterClosing.current = null;
    event.preventDefault();
    triggerRef.current?.focus({ preventScroll: true });
    open();
  };

  // A dialog has closed: the focus goes back to the trigger, where it was
  // when the dialog opened, not to the body.
  const returnFocusToTrigger = (event: Event) => {
    event.preventDefault();
    triggerRef.current?.focus({ preventScroll: true });
  };

  /*
   * Tab and Shift+Tab, and the arrow keys away from a row, before Radix's
   * own handler (which runs only when this one hasn't prevented the key's
   * default): Radix prevents Tab in its list, so nothing but the rows could
   * be reached by keyboard (D10 Ruling 28).
   */
  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isPencil = target.matches(ROW_CONTROL);
    const create = createRef.current;
    const isCreate = create !== null && target === create;
    if (event.key === "Tab") {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      let next: HTMLElement | null = null;
      if (!event.shiftKey) {
        if (isPencil) next = create !== null && !create.disabled ? create : null;
        else if (!isCreate) next = pencilOf(rowOf(target));
      } else if (isPencil) {
        next = rowOf(target);
      } else if (isCreate) {
        next = lastPencil.current?.isConnected
          ? lastPencil.current
          : pencilOf(event.currentTarget.querySelector('[role="option"][data-state="checked"]'));
      }
      next?.focus();
      return;
    }
    if ((isPencil || isCreate) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not([data-disabled])')];
      const from = isPencil ? rows.indexOf(rowOf(target)!) : rows.length;
      rows[event.key === "ArrowDown" ? from + 1 : from - 1]?.focus();
    }
  };

  return (
    <>
      <div className="flex items-center gap-1.5" data-tour-step="version-select">
        {/* Shown on wide screens only, still the trigger's name at every width (D13a Ruling 42). */}
        <span id={labelId} className="sr-only text-xs text-muted-foreground whitespace-nowrap 2xl:not-sr-only">
          Version:
        </span>
        <Select value={version?.id ?? ""} open={selectOpen} onOpenChange={setSelectOpen} onValueChange={choose}>
          <SelectTrigger
            ref={triggerRef}
            className="h-7 w-40 text-xs 2xl:w-56"
            aria-labelledby={`${labelId} ${shownId}`}
            disabled={version === null}
          >
            <span id={shownId} className="flex min-w-0 items-center">
              {version !== null && (
                <>
                  <span className="shrink-0 font-mono">v{version.versionNumber}: </span>
                  <span className="min-w-0 truncate">{shownLabel(version)}</span>
                </>
              )}
            </span>
          </SelectTrigger>
          <SelectContent className="w-80" onKeyDown={handleListKeyDown} onCloseAutoFocus={handleCloseAutoFocus}>
            <SelectGroup>
              <SelectLabel className="text-xs">Versions</SelectLabel>
              {versions.map((summary, index) => (
                <SelectPrimitive.Item
                  key={summary.id}
                  value={summary.id}
                  className="relative flex w-full cursor-default select-none items-start gap-1.5 rounded-sm py-1.5 pl-2 pr-8 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  {summary.publishedAt !== null ? (
                    // The lock in the pencil's place: the rows stay aligned.
                    <span
                      role="img"
                      tabIndex={-1}
                      aria-label={PUBLISHED_IMMUTABLE_LABEL}
                      title={PUBLISHED_IMMUTABLE_LABEL}
                      aria-describedby={`${rowTextId}-${index}-label ${rowTextId}-${index}-detail`}
                      data-version-lock=""
                      className="mt-px shrink-0 rounded p-0.5 text-muted-foreground/50 outline-none focus-visible:bg-accent focus-visible:text-foreground"
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onFocus={(e) => {
                        lastPencil.current = e.currentTarget;
                      }}
                    >
                      <Lock className="h-3 w-3" aria-hidden="true" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label="Rename version"
                      aria-describedby={`${rowTextId}-${index}-label ${rowTextId}-${index}-detail`}
                      data-rename-version=""
                      className="mt-px shrink-0 rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onFocus={(e) => {
                        lastPencil.current = e.currentTarget;
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        afterClosing(() => setRenameTarget(summary));
                      }}
                    >
                      <Edit className="h-3 w-3" />
                    </button>
                  )}
                  <SelectPrimitive.ItemText asChild>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span id={`${rowTextId}-${index}-label`} className="truncate">
                        {shownLabel(summary)}
                      </span>
                      <span
                        id={`${rowTextId}-${index}-detail`}
                        className="flex min-w-0 items-center text-[10px] text-muted-foreground"
                      >
                        <span className="shrink-0 font-mono">v{summary.versionNumber}</span>
                        <span className="shrink-0 whitespace-pre"> · </span>
                        <span className="min-w-0 truncate">{summary.createdBy?.email ?? "—"}</span>
                        <span className="shrink-0 whitespace-pre"> · </span>
                        <span className="min-w-0 truncate">{new Date(summary.updatedAt).toLocaleDateString()}</span>
                        {summary.publishedAt !== null && (
                          <>
                            <span className="shrink-0 whitespace-pre"> · </span>
                            <span className="shrink-0 font-medium text-brand">Published</span>
                          </>
                        )}
                      </span>
                    </span>
                  </SelectPrimitive.ItemText>
                  <span className="absolute right-2 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center">
                    <SelectPrimitive.ItemIndicator>
                      <Check className="h-4 w-4" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                </SelectPrimitive.Item>
              ))}
            </SelectGroup>
            <div className="p-2 border-t border-border">
              <Button
                ref={createRef}
                variant="default"
                size="sm"
                className="w-full text-xs h-7"
                disabled={isSaving || isCreating}
                onClick={() => afterClosing(() => setCreateOpen(true))}
              >
                Create New Version
              </Button>
            </div>
          </SelectContent>
        </Select>
      </div>

      <CreateVersionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={createVersion}
        creating={isCreating}
        saving={isSaving}
        onCloseAutoFocus={returnFocusToTrigger}
      />
      <RenameVersionDialog
        version={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onCloseAutoFocus={returnFocusToTrigger}
      />
    </>
  );
}
