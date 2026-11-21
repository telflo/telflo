import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_TEMPLATE_NAME_MAXIMUM_LENGTH,
  TEST_TEMPLATE_RECEIVER_TYPES,
  type TestRunSignal,
  type TestTemplate,
  type TestTemplateReceiverType,
  type UpdateTestTemplateRequest,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import type { TestTemplateUpload } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { failureMessage, TEST_FILE_ACCEPT, uploadRefusal } from "~/lib/test-runs/messages.js";
import { receiverTypeLabel, signalLabel, TEMPLATE_SIGNALS_IN_ORDER } from "~/lib/test-templates/labels.js";

/*
 * A test template's dialog: a template's name, receiver type, signal type,
 * description and (when new) file; its placeholders, limits, messages (each
 * shown on Create or Save, all at once) and buttons; not closable while it
 * saves:
 * - the receiver types are the API's list (TEST_TEMPLATE_RECEIVER_TYPES, the
 *   palette's 18 receivers) by their palette labels; a template whose stored
 *   type the list lacks keeps it, shown as it is;
 * - the file is checked as it is picked: one of the six extensions, up to
 *   10 MiB, in the API's 415 and 413 words (`uploadRefusal`, as
 *   UploadPanel's), and Create holds while it is refused;
 * - a refusal shows the API's words (a 413 or 415 included), else
 *   "Failed to create template" / "Failed to update template"
 *   (`failureMessage`), so the 10 MB refusal is never hidden;
 *   a 403 `product_admin_required` (the flag cleared since the page
 *   opened) goes to `/app` (`onProductAdminLost`), as the flows page's;
 * - an edit sends only the fields it changed, as the flows page's: a stored
 *   receiver type the list lacks isn't sent back for the API to refuse; a
 *   description left empty is `''`, not null;
 * - the chosen file's name shows as text, not as a read-only input's value
 *   (an attribute), and with the hidden file input it is blocked from
 *   replay (`ph-no-capture`): replay records a file input's value,
 *   "C:\fakepath\<the file's name>", whatever maskAllInputs says. The Name
 *   and Description values sit under maskAllInputs.
 */

interface TestTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The template being edited, or null for a new one. */
  template: TestTemplate | null;
  /** Creates it; throws the API's refusal. */
  onCreate: (upload: TestTemplateUpload) => Promise<void>;
  /** Sends an edit's changes; throws the API's refusal. */
  onUpdate: (templateId: string, changes: UpdateTestTemplateRequest) => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): back to its opener unless prevented. */
  onCloseAutoFocus?: (event: Event) => void;
}

function isOfferedReceiverType(value: string): value is TestTemplateReceiverType {
  return (TEST_TEMPLATE_RECEIVER_TYPES as readonly string[]).includes(value);
}

/** The fields an edit changed, and only those. */
function changesOf(
  template: TestTemplate,
  fields: { name: string; description: string; receiverType: string; signal: TestRunSignal },
): UpdateTestTemplateRequest {
  const changes: UpdateTestTemplateRequest = {};
  if (fields.name !== template.name) changes.name = fields.name;
  if (fields.description !== template.description) changes.description = fields.description;
  if (fields.receiverType !== template.receiverType && isOfferedReceiverType(fields.receiverType)) {
    changes.receiverType = fields.receiverType;
  }
  if (fields.signal !== template.signal) changes.signal = fields.signal;
  return changes;
}

export function TestTemplateDialog({
  open,
  onOpenChange,
  template,
  onCreate,
  onUpdate,
  onProductAdminLost,
  onCloseAutoFocus,
}: TestTemplateDialogProps) {
  const isEdit = template !== null;

  const [name, setName] = useState("");
  const [receiverType, setReceiverType] = useState("");
  const [signal, setSignal] = useState<TestRunSignal | "">("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileRefusal, setFileRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [receiverTypeError, setReceiverTypeError] = useState(false);
  const [signalError, setSignalError] = useState(false);
  const [fileError, setFileError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-seed from the row being edited: the dialog is reused across rows.
  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setReceiverType(template?.receiverType ?? "");
    setSignal(template?.signal ?? "");
    setDescription(template?.description ?? "");
    setFile(null);
    setFileRefusal(null);
    setNameError(false);
    setReceiverTypeError(false);
    setSignalError(false);
    setFileError(false);
    setSubmitting(false);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }, [open, template]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    setFileRefusal(picked === null ? null : uploadRefusal(picked));
    if (picked !== null) setFileError(false);
  };

  const handleOk = async () => {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    const nameValid = trimmedName.length > 0;
    const receiverValid = receiverType.length > 0;
    const signalValid = signal !== "";
    const fileValid = isEdit || file !== null;

    setNameError(!nameValid);
    setReceiverTypeError(!receiverValid);
    setSignalError(!signalValid);
    setFileError(!fileValid);

    if (!nameValid || !receiverValid || !signal || !fileValid) return;
    // A file the API would refuse: its words are already under the field.
    if (!isEdit && fileRefusal !== null) return;

    setSubmitting(true);
    try {
      if (template !== null) {
        await onUpdate(
          template.id,
          changesOf(template, { name: trimmedName, description: trimmedDescription, receiverType, signal }),
        );
      } else if (file !== null) {
        await onCreate({ name: trimmedName, description: trimmedDescription, receiverType, signal, file });
      }
      onOpenChange(false);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        onProductAdminLost();
        return;
      }
      const message = failureMessage(error, isEdit ? "Failed to update template" : "Failed to create template");
      if (message !== null) toast.error(message);
      setSubmitting(false);
    }
  };

  // A stored type the list lacks stays selectable, shown as it is.
  const receiverTypes: readonly string[] =
    receiverType !== "" && !isOfferedReceiverType(receiverType)
      ? [...TEST_TEMPLATE_RECEIVER_TYPES, receiverType]
      : TEST_TEMPLATE_RECEIVER_TYPES;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Test Template" : "New Test Template"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="test-template-name" className="mb-2 block">
              Name
            </Label>
            <Input
              id="test-template-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(false);
              }}
              placeholder="e.g., OTLP trace sample"
              autoFocus
              maxLength={TEST_TEMPLATE_NAME_MAXIMUM_LENGTH}
              disabled={submitting}
            />
            {nameError && (
              <p className="text-xs text-fail" role="alert">
                Please enter a name.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-template-receiver" className="mb-2 block">
              Receiver type
            </Label>
            <Select
              value={receiverType}
              onValueChange={(value) => {
                setReceiverType(value);
                if (receiverTypeError) setReceiverTypeError(false);
              }}
              disabled={submitting}
            >
              <SelectTrigger id="test-template-receiver">
                <SelectValue placeholder="Select receiver type…" />
              </SelectTrigger>
              <SelectContent>
                {receiverTypes.map((value) => (
                  <SelectItem key={value} value={value}>
                    {receiverTypeLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {receiverTypeError && (
              <p className="text-xs text-fail" role="alert">
                Please select a receiver type.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-template-signal" className="mb-2 block">
              Signal type
            </Label>
            <Select
              value={signal}
              onValueChange={(value) => {
                setSignal(value as TestRunSignal);
                if (signalError) setSignalError(false);
              }}
              disabled={submitting}
            >
              <SelectTrigger id="test-template-signal">
                <SelectValue placeholder="Select signal type…" />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_SIGNALS_IN_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>
                    {signalLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {signalError && (
              <p className="text-xs text-fail" role="alert">
                Please select a signal type.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-template-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="test-template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional — describe what this template contains"
              rows={3}
              maxLength={TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH}
              disabled={submitting}
            />
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <span className="mb-2 block text-sm font-medium leading-none">File</span>
              <div className="flex gap-2">
                {/* The name as text, never an input's value, and blocked from replay. */}
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
                  changes, whatever maskAllInputs says. */}
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
