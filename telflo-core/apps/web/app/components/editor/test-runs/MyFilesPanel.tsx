import { HelpCircle, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.js";
import type { TestFile } from "@telflo/contracts";
import { useLockedAction } from "~/lib/playground/context.js";
import { useTestingStore, type SelectedTestFile } from "~/lib/stores/testing-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/** Another organization's list shows as none: one array, so the store's selector answers the same each time. */
const NO_FILES: TestFile[] = [];

interface MyFilesPanelProps {
  organizationId: string;
  onDone: () => void;
  onCancel: () => void;
  onSelectFile: (file: SelectedTestFile) => void;
  onRequestUpload: () => void;
}

/**
 * The person's own test files in this organization (D14a decision 7). The
 * run dialog reads them afresh each time it opens (the store's `loadFiles`).
 * Highlight a row and OK selects it; the trash button deletes a file at once,
 * and a deleted file leaves the dialog's selection too.
 *
 * Differences (the Parity Notes): no file name reaches an attribute (ADR
 * 0024). The delete and details buttons are named by hidden text, through
 * `aria-labelledby` (as D12's visibility switch is), never `Delete <name>`
 * in an `aria-label`; their titles stay the fixed "Delete" and "Show
 * details". A session that ended toasts nothing. In the
 * playground (D31-1 decisions 12 and 24), Upload and a file's delete open the
 * sign-up prompt at their buttons (`useLockedAction`), never reaching
 * signed-in routes.
 */
export function MyFilesPanel({ organizationId, onDone, onCancel, onSelectFile, onRequestUpload }: MyFilesPanelProps) {
  const files = useTestingStore((state) => (state.filesOrganizationId === organizationId ? state.files : NO_FILES));
  const filesLoading = useTestingStore((state) => state.filesLoading);
  const filesLoaded = useTestingStore((state) => state.filesOrganizationId === organizationId && state.filesLoaded);
  const deleteFile = useTestingStore((state) => state.deleteFile);
  const locked = useLockedAction();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const idPrefix = useId();

  const handleDelete = async (id: string, displayName: string) => {
    setDeletingId(id);
    try {
      await deleteFile(organizationId, id);
      setHighlightedId((current) => (current === id ? null : current));
      toast.success(`Deleted ${displayName}`, { className: "ph-no-capture" });
    } catch (error) {
      if (failureMessage(error, "") !== null) toast.error(`Failed to delete ${displayName}`, { className: "ph-no-capture" });
    } finally {
      setDeletingId((current) => (current === id ? null : current));
    }
  };

  const handleOk = () => {
    const file = files.find((listed) => listed.id === highlightedId);
    if (file === undefined) return;
    onSelectFile({ id: file.id, displayName: file.displayName });
    onDone();
  };

  const isLoading = filesLoading && !filesLoaded;
  const highlightedListed = files.some((file) => file.id === highlightedId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-2 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-6" role="status" aria-label="Loading files">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-muted-foreground/25 border-t-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">You have no saved files. Upload a file to select it.</p>
        ) : (
          <div className="rounded-md border border-border bg-card max-h-56 overflow-y-auto">
            <div className="sticky top-0 z-10 grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 bg-muted/90 backdrop-blur-sm border-b border-border font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              <span className="w-6" aria-hidden />
              <span>Name</span>
              <span className="w-6" aria-hidden />
            </div>
            <ul className="divide-y divide-border">
              {files.map((file) => {
                const isSelected = highlightedId === file.id;
                const isDeleting = deletingId === file.id;
                const deleteLabelId = `${idPrefix}-delete-${file.id}`;
                const detailsLabelId = `${idPrefix}-details-${file.id}`;
                return (
                  <li
                    key={file.id}
                    className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 transition-colors border-l-2 ${
                      isSelected ? "bg-accent border-l-brand" : "border-l-transparent hover:bg-accent/50"
                    }`}
                  >
                    {/* The name in text, which replay masks, never in an attribute (ADR 0024). */}
                    <span id={deleteLabelId} className="sr-only">
                      Delete {file.displayName}
                    </span>
                    <span id={detailsLabelId} className="sr-only">
                      Show details for {file.displayName}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => (locked ? locked("delete a test file", event.currentTarget) : void handleDelete(file.id, file.displayName))}
                      disabled={isDeleting}
                      aria-labelledby={deleteLabelId}
                      title="Delete"
                      className="p-1 text-muted-foreground hover:text-fail rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <div
                      className="flex items-center gap-2 min-w-0 py-2 cursor-pointer"
                      onClick={() => setHighlightedId(file.id)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setHighlightedId(file.id);
                        }
                      }}
                    >
                      <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{file.displayName}</span>
                    </div>
                    <Popover>
                      <PopoverTrigger
                        aria-labelledby={detailsLabelId}
                        title="Show details"
                        className="p-1 text-muted-foreground hover:text-brand rounded"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </PopoverTrigger>
                      <PopoverContent align="end" side="left" collisionPadding={8} className="max-w-sm p-3">
                        <p className="text-[13px] font-semibold text-foreground mb-1 break-words">{file.displayName}</p>
                        <p className="text-[13px] text-muted-foreground whitespace-pre-wrap">
                          {file.description.trim() ? file.description : "No description."}
                        </p>
                      </PopoverContent>
                    </Popover>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      <div className="flex justify-between items-center gap-2 pt-4">
        <button
          onClick={locked ? (event) => locked("upload a test file", event.currentTarget) : onRequestUpload}
          disabled={isLoading}
          className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Upload
        </button>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleOk}
            disabled={!highlightedListed}
            className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
