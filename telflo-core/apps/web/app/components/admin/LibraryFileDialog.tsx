import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  LIBRARY_FILE_DESCRIPTION_MAXIMUM_LENGTH,
  LIBRARY_FILE_FILE_NAME_MAXIMUM_LENGTH,
  LIBRARY_FILE_MAXIMUM_BYTES,
  LIBRARY_FILE_NAME_MAXIMUM_LENGTH,
  libraryFileFileNameProblem,
  type LibraryFile,
  type UpdateLibraryFileRequest,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import type { LibraryFileUpload } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * A library file's dialog (D23-2 decision 53): a library file's name,
 * description and (when new) file; its placeholders, limits, messages (each
 * shown on Create or Save, all at once) and buttons; not closable while it
 * saves. Per decision 6's fix 1 and the test templates' dialog's (D14b):
 * - the file is checked as it is picked: up to 10 MiB ("File must be 10 MB
 *   or smaller."), and a name the members' curl can write in their working
 *   directory (`libraryFileFileNameProblem`, decision 43), and Create holds
 *   while it is refused;
 * - a refusal shows the API's words (its 413 included), else
 *   "Failed to create library file" / "Failed to update library file"
 *   (`failureMessage`); a 403 `product_admin_required` goes to `/app`
 *   (`onProductAdminLost`);
 * - an edit sends only the fields it changed, and nothing when none changed
 *   (the API asks for at least one); a description left empty is `''`, not
 *   null; nothing is logged;
 * - the chosen file's name shows as text, not as a read-only input's value
 *   (an attribute), and with the hidden file input it is blocked from replay
 *   (`ph-no-capture`): replay records a file input's value,
 *   "C:\fakepath\<the file's name>", whatever maskAllInputs says (D14b
 *   Preflight ruling 19; D23-2 decision 53). The Name and Description
 *   values sit under maskAllInputs.
 */

/** The browser's own refusal of a file over 10 MiB (decision 53), before anything is sent. */
export const LIBRARY_FILE_TOO_LARGE_MESSAGE = "File must be 10 MB or smaller.";

/**
 * Why a file's own name can't be a library file's, in fixed words, by the
 * contract's reason (decision 43): the members' pasted curl writes `-o
 * '<name>'` in their working directory.
 */
const FILE_NAME_REFUSALS: Record<string, string> = {
  length: `File name must be 1 to ${LIBRARY_FILE_FILE_NAME_MAXIMUM_LENGTH} characters.`,
  "control or formatting character": "File name can't contain control or formatting characters.",
  slash: 'File name can\'t contain "/" or "\\".',
  dot: 'File name can\'t be "." or "..".',
  "leading dash": 'File name can\'t start with "-".',
  unstorable: "File name contains a character that can't be stored.",
};

/** Any other reason the contract may give, in fixed words. */
const FILE_NAME_REFUSED = "This file's name can't be used. Rename it and choose it again.";

/** Why `file` can't be uploaded, or null when it can: its name, then its size. */
export function libraryFileRefusal(file: File): string | null {
  const problem = libraryFileFileNameProblem(file.name);
  if (problem !== undefined) return FILE_NAME_REFUSALS[problem] ?? FILE_NAME_REFUSED;
  if (file.size > LIBRARY_FILE_MAXIMUM_BYTES) return LIBRARY_FILE_TOO_LARGE_MESSAGE;
  return null;
}

interface LibraryFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file being edited (the page's snapshot at opening), or null for a new one. */
  libraryFile: LibraryFile | null;
  /** Creates it; throws the API's refusal. */
  onCreate: (upload: LibraryFileUpload) => Promise<void>;
  /** Sends an edit's changes; throws the API's refusal. */
  onUpdate: (fileId: string, changes: UpdateLibraryFileRequest) => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): back to its opener unless prevented. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** The fields an edit changed, and only those. */
function changesOf(libraryFile: LibraryFile, fields: { name: string; description: string }): UpdateLibraryFileRequest {
  const changes: UpdateLibraryFileRequest = {};
  if (fields.name !== libraryFile.name) changes.name = fields.name;
  if (fields.description !== libraryFile.description) changes.description = fields.description;
  return changes;
}

export function LibraryFileDialog({
  open,
  onOpenChange,
  libraryFile,
  onCreate,
  onUpdate,
  onProductAdminLost,
  onCloseAutoFocus,
}: LibraryFileDialogProps) {
  const isEdit = libraryFile !== null;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileRefusal, setFileRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [fileError, setFileError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-seed from the row being edited: the dialog is reused across rows.
  useEffect(() => {
    if (!open) return;
    setName(libraryFile?.name ?? "");
    setDescription(libraryFile?.description ?? "");
    setFile(null);
    setFileRefusal(null);
    setNameError(false);
    setFileError(false);
    setSubmitting(false);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }, [open, libraryFile]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    setFileRefusal(picked === null ? null : libraryFileRefusal(picked));
    if (picked !== null) setFileError(false);
  };

  const handleOk = async () => {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    const nameValid = trimmedName.length > 0;
    const fileValid = isEdit || file !== null;

    setNameError(!nameValid);
    setFileError(!fileValid);

    if (!nameValid || !fileValid) return;
    // A file the API would refuse: its words are already under the field.
    if (!isEdit && fileRefusal !== null) return;

    let changes: UpdateLibraryFileRequest | null = null;
    if (libraryFile !== null) {
      changes = changesOf(libraryFile, { name: trimmedName, description: trimmedDescription });
      // Nothing changed: nothing to send. The API refuses an empty change
      // (`{}`, 400); an unchanged field it would take, answering the row as
      // it is, so sending nothing saves a request and an audit-free no-op.
      if (changes.name === undefined && changes.description === undefined) {
        onOpenChange(false);
        return;
      }
    }

    setSubmitting(true);
    try {
      if (libraryFile !== null && changes !== null) {
        await onUpdate(libraryFile.id, changes);
      } else if (file !== null) {
        await onCreate({ name: trimmedName, description: trimmedDescription, file });
      }
      onOpenChange(false);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        onProductAdminLost();
        return;
      }
      const message = failureMessage(error, isEdit ? "Failed to update library file" : "Failed to create library file");
      if (message !== null) toast.error(message);
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Library File" : "New Library File"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="library-file-name" className="mb-2 block">
              Name
            </Label>
            <Input
              id="library-file-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(false);
              }}
              placeholder="e.g., Getting started guide"
              autoFocus
              maxLength={LIBRARY_FILE_NAME_MAXIMUM_LENGTH}
              disabled={submitting}
            />
            {nameError && (
              <p className="text-xs text-fail" role="alert">
                Please enter a name.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="library-file-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="library-file-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional — describe what this file contains"
              rows={3}
              maxLength={LIBRARY_FILE_DESCRIPTION_MAXIMUM_LENGTH}
              disabled={submitting}
            />
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <span className="mb-2 block text-[13px] font-medium leading-none">File</span>
              <div className="flex gap-2">
                {/* The name as text, never an input's value, and blocked from replay (decision 53). */}
                <div className="ph-no-capture flex h-8 flex-1 min-w-0 items-center truncate rounded-md border border-input bg-muted px-3 text-[13px] text-muted-foreground cursor-default">
                  {file?.name ?? "No file selected"}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                  title="Choose file"
                  aria-label="Choose file"
                  className="h-8 px-2.5 rounded-md border border-input hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
              {/* Blocked from replay (`ph-no-capture`): rrweb records a file
                  input's value, "C:\fakepath\<the file's name>", as it
                  changes, whatever maskAllInputs says (D14a's finding). */}
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileChange}
                disabled={submitting}
                tabIndex={-1}
                aria-hidden="true"
                className="hidden ph-no-capture"
              />
              {fileError && (
                <p className="text-xs text-fail" role="alert">
                  Please choose a file.
                </p>
              )}
              {fileRefusal !== null && (
                <p className="text-xs text-fail" role="alert">
                  {fileRefusal}
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleOk()} disabled={submitting}>
            {submitting ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
