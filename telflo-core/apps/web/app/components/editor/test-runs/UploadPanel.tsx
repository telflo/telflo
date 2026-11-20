import { TEST_FILE_DESCRIPTION_MAXIMUM_LENGTH, TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH } from "@telflo/contracts";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { failureMessage, TEST_FILE_ACCEPT, uploadRefusal } from "~/lib/test-runs/messages.js";

interface UploadPanelProps {
  organizationId: string;
  /** Whether the dialog shows this panel: it starts empty each time it does. */
  active: boolean;
  onDone: () => void;
  onCancel: () => void;
}

/** `name` cut to the display name's bound, never mid-way through a surrogate pair. */
function asDisplayName(name: string): string {
  if (name.length <= TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH) return name;
  const cut = name.slice(0, TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Upload a test file to My Files.
 * - the file is checked as it is picked: one of the six extensions, up to
 *   10 MiB (`uploadRefusal`), said under the field, with OK held;
 * - a refusal shows the API's words (413, 415, 429), else
 *   "Failed to upload file" (`failureMessage`);
 * - the chosen file's name shows as text, not as a read-only input's value
 *   (an attribute); the name field starts from it, cut to the
 *   display name's 200 characters;
 * - kept mounted through the dialog's slides, and emptied each time it is
 *   shown (reset on `active`);
 * - the hidden file input is blocked from replay (`ph-no-capture`): replay
 *   records a file input's value, which holds the file's name, even with
 *   every input masked.
 */
export function UploadPanel({ organizationId, active, onDone, onCancel }: UploadPanelProps) {
  const uploadFile = useTestingStore((state) => state.uploadFile);
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Empty each time the dialog shows it (reset on `active`).
  useEffect(() => {
    if (!active) return;
    setFile(null);
    setRefusal(null);
    setName("");
    setDescription("");
    setSubmitting(false);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }, [active]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    setRefusal(picked === null ? null : uploadRefusal(picked));
    if (picked && !name.trim()) setName(asDisplayName(picked.name));
  };

  const canSubmit = file !== null && refusal === null && name.trim().length > 0 && !submitting;

  const handleOk = async () => {
    if (!canSubmit || file === null) return;
    setSubmitting(true);
    try {
      await uploadFile(organizationId, { displayName: name.trim(), description: description.trim(), file });
      toast.success("File uploaded");
      onDone();
    } catch (error) {
      const message = failureMessage(error, "Failed to upload file");
      if (message !== null) toast.error(message);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-3">
        <h3 className="text-sm font-semibold">Upload Test File</h3>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="upload-file-name">
            Name
          </label>
          <input
            id="upload-file-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            maxLength={TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH}
            placeholder="Display name"
            className="w-full min-w-0 px-3 py-1.5 text-[13px] rounded-md border border-input bg-transparent"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="upload-file-description">
            Description
          </label>
          <textarea
            id="upload-file-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
            placeholder="Optional"
            rows={2}
            maxLength={TEST_FILE_DESCRIPTION_MAXIMUM_LENGTH}
            className="w-full min-w-0 px-3 py-1.5 text-[13px] rounded-md border border-input bg-transparent resize-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">File</span>
          <div className="flex gap-2">
            {/* The name as text, which replay masks; an input's value is an attribute. */}
            <div className="flex-1 min-w-0 truncate px-3 py-1.5 font-mono text-xs rounded-md border border-input bg-muted/40 text-muted-foreground cursor-default">
              {file?.name ?? "No file selected"}
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              title="Choose file"
              aria-label="Choose file"
              className="px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
          {/* Blocked from replay (`ph-no-capture`): rrweb records a file
              input's value, "C:\fakepath\<the file's name>", as it changes,
              whatever maskAllInputs says. */}
          <input
            ref={fileInputRef}
            type="file"
            accept={TEST_FILE_ACCEPT}
            onChange={handleFileChange}
            disabled={submitting}
            tabIndex={-1}
            aria-hidden="true"
            className="hidden ph-no-capture"
          />
          {refusal !== null && <p className="text-[11px] text-fail">{refusal}</p>}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <button
          onClick={onCancel}
          disabled={submitting}
          className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleOk()}
          disabled={!canSubmit}
          className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
        >
          {submitting ? "Uploading…" : "OK"}
        </button>
      </div>
    </div>
  );
}
