import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  CreateOrganizationVariableRequestSchema,
  UpdateOrganizationVariableRequestSchema,
  VARIABLE_DESCRIPTION_MAXIMUM_LENGTH,
  VARIABLE_NAME_MAXIMUM_LENGTH,
  VARIABLE_VALUE_MAXIMUM_LENGTH,
  type OrganizationVariable,
  type UpdateOrganizationVariableRequest,
  type VariableInUseDetails,
} from "@telflo/contracts";
import { DialogErrorAlert } from "~/components/fleets/DialogErrorAlert.js";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import { abortAfter } from "~/lib/abort-after.js";
import { createOrganizationVariable, getVariableDrafts, updateOrganizationVariable } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { randomUuid } from "~/lib/ids.js";
import {
  SAVE_VARIABLE_FAILED_MESSAGE,
  VARIABLE_ADDED_MESSAGE,
  VARIABLE_SAVED_MESSAGE,
  VARIABLES_READ_TIMEOUT_MS,
  VARIABLES_WRITE_TIMEOUT_MS,
  descriptionOf,
  hasVariableCode,
  variableFieldProblemsOf,
  variableInUseDetailsOf,
  variableRefusalMessage,
  type VariableField,
} from "~/lib/variables.js";
import { DraftsWarning, type DraftsRead } from "./DraftsWarning.js";
import { VariableInUseList } from "./InUseLists.js";
import { handleSharedWriteFailure } from "./write-failures.js";

/*
 * A variable's create and edit, with one name and a description. In detail:
 * - the fields are Name (upper case as typed, `^[A-Z][A-Z0-9_]*$`), Value
 *   (one line, kept as typed, never trimmed; empty allowed) and Description
 *   (optional); the contract's checks run before anything is sent, with the
 *   contract's words beside the field, and a 400's problems land there too;
 * - the titles and toasts are fixed words ("Add variable", "Edit variable";
 *   "Variable added", "Variable saved"), never a name, a value or a
 *   description;
 * - a create carries this opening's own id, so a retry after an unknown
 *   outcome is safe; an edit sends only the fields that changed, and Save
 *   waits for a change;
 * - a rename (the name changed) warns, without refusing, about the drafts
 *   that reference the variable's name now (read as the dialog opens):
 *   "Drafts using OTLP_EP: edge-config"; a rename refused while a used
 *   published version references the name (409 `variable_in_use`) lists
 *   those uses, at most 100, then "… and N more published versions";
 * - `variable_name_taken` is said under Name; any other refusal of the
 *   variables' in the dialog; an unknown outcome as `write-failures.ts`
 *   says.
 * Privacy: every field, the reference preview, the drafts warning and the
 * in-use list sit inside `ph-no-capture` (replay records nothing of
 * them); a controlled input's own `value` is the one attribute holding
 * what is typed; no placeholder, label, title or aria attribute holds a
 * name, a value or a description. The baseline is the variable as the
 * dialog opened: a reload behind it changes nothing.
 */

export interface VariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  /** The variable to edit; null for a new one. */
  variable: OrganizationVariable | null;
  /** After a save, a variable found gone, or an unknown outcome: the page reads its list again. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing typed, refused or read in an earlier one carries over. */
export function VariableDialog(props: VariableDialogProps) {
  const opening = useOpeningKey(props.open);
  return <VariableDialogSession key={opening} {...props} />;
}

type Problems = Partial<Record<VariableField, string>>;

/** The contract's words for each field a request's check refused, the first per field. */
function problemsOfIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Problems {
  const problems: Problems = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if ((field === "name" || field === "value" || field === "description") && problems[field] === undefined) {
      problems[field] = issue.message;
    }
  }
  return problems;
}

function VariableDialogSession({ open, onOpenChange, organizationId, variable, onChanged, onCloseAutoFocus }: VariableDialogProps) {
  const nameId = useId();
  const valueId = useId();
  const descriptionId = useId();
  // The baseline, as the dialog opened.
  const [original] = useState(variable);
  const [createId] = useState(randomUuid);
  const [name, setName] = useState(original?.name ?? "");
  const [value, setValue] = useState(original?.value ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [inUse, setInUse] = useState<VariableInUseDetails | null>(null);
  const [drafts, setDrafts] = useState<DraftsRead>({ state: "reading" });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const openingRead = useOpeningReads(open, VARIABLES_READ_TIMEOUT_MS);

  // An edit reads, once as it opens, the drafts that reference the name it opened with.
  useEffect(() => {
    if (original === null) return;
    void openingRead((signal) => getVariableDrafts(organizationId, original.id, { signal })).then((answer) => {
      if (answer === null) return;
      setDrafts(answer.ok ? { state: "read", configurations: answer.value } : { state: "failed" });
    });
  }, [openingRead, organizationId, original]);

  const renamed = original !== null && name !== original.name;

  /** The edit's changed fields; empty when nothing changed. */
  const changes = (): UpdateOrganizationVariableRequest => {
    if (original === null) return {};
    const next: UpdateOrganizationVariableRequest = {};
    if (name !== original.name) next.name = name;
    if (value !== original.value) next.value = value;
    const typedDescription = descriptionOf(description);
    if (typedDescription !== original.description) next.description = typedDescription;
    return next;
  };
  const unchanged = original !== null && Object.keys(changes()).length === 0;

  const close = () => {
    if (!savingRef.current) onOpenChange(false);
  };

  const clearProblem = (field: VariableField) => {
    setProblems(({ [field]: _cleared, ...rest }) => rest);
  };

  const failed = (failure: unknown) => {
    const handled = handleSharedWriteFailure(
      failure,
      { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
      [{ code: "variable_not_found", message: "Variable not found" }],
    );
    if (handled) return;
    const details = variableInUseDetailsOf(failure);
    if (details !== null) {
      setInUse(details);
      setError(variableRefusalMessage(failure, SAVE_VARIABLE_FAILED_MESSAGE));
      return;
    }
    if (hasVariableCode(failure, "variable_name_taken")) {
      setProblems({ name: failure.message });
      return;
    }
    const fieldProblems = variableFieldProblemsOf(failure);
    if (Object.keys(fieldProblems).length > 0) {
      setProblems(fieldProblems);
      return;
    }
    setError(variableRefusalMessage(failure, SAVE_VARIABLE_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    setError(null);
    setInUse(null);
    let send: (signal: AbortSignal) => Promise<unknown>;
    if (original === null) {
      const request = { id: createId, name, value, description: descriptionOf(description) };
      const checked = CreateOrganizationVariableRequestSchema.safeParse(request);
      if (!checked.success) {
        setProblems(problemsOfIssues(checked.error.issues));
        return;
      }
      send = (signal) => createOrganizationVariable(organizationId, checked.data, { signal });
    } else {
      const request = changes();
      if (Object.keys(request).length === 0) return;
      const checked = UpdateOrganizationVariableRequestSchema.safeParse(request);
      if (!checked.success) {
        setProblems(problemsOfIssues(checked.error.issues));
        return;
      }
      send = (signal) => updateOrganizationVariable(organizationId, original.id, checked.data, { signal });
    }
    setProblems({});
    savingRef.current = true;
    setSaving(true);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    try {
      await send(guard.signal);
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (isStillCurrent(sentIn)) failed(failure);
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(original === null ? VARIABLE_ADDED_MESSAGE : VARIABLE_SAVED_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

  const fieldProblem = (field: VariableField, id: string) =>
    problems[field] === undefined ? null : (
      <p id={`${id}-problem`} className="text-xs text-fail" role="alert">
        {problems[field]}
      </p>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] max-w-md overflow-y-auto"
        hideCloseButton={saving}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>{original === null ? "Add variable" : "Edit variable"}</DialogTitle>
            <DialogDescription>
              A text value shared across your organization&apos;s configurations, filled in where they reference it.
              Not for secrets.
            </DialogDescription>
          </DialogHeader>

          <div className="ph-no-capture grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => {
                  // Upper case as typed: a controlled value that differs from
                  // what was typed moves the cursor to the end when a
                  // lower-case letter is typed mid-name.
                  setName(event.target.value.toUpperCase());
                  clearProblem("name");
                  setError(null);
                }}
                className="font-mono"
                maxLength={VARIABLE_NAME_MAXIMUM_LENGTH}
                autoFocus
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problems.name !== undefined || undefined}
                aria-describedby={problems.name !== undefined ? `${nameId}-problem` : undefined}
              />
              {fieldProblem("name", nameId)}
              <p className="text-xs text-muted-foreground">
                Use in configurations as <span className="font-mono">{`\${org:${name || "NAME"}}`}</span>
              </p>
              {renamed && <DraftsWarning name={original.name} drafts={drafts} />}
            </div>

            <div className="grid gap-2">
              <Label htmlFor={valueId}>Value</Label>
              <Input
                id={valueId}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  clearProblem("value");
                  setError(null);
                }}
                className="font-mono"
                maxLength={VARIABLE_VALUE_MAXIMUM_LENGTH * 2}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problems.value !== undefined || undefined}
                aria-describedby={problems.value !== undefined ? `${valueId}-problem` : undefined}
              />
              {fieldProblem("value", valueId)}
            </div>

            <div className="grid gap-2">
              <Label htmlFor={descriptionId}>Description (optional)</Label>
              <Textarea
                id={descriptionId}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  clearProblem("description");
                  setError(null);
                }}
                rows={2}
                maxLength={VARIABLE_DESCRIPTION_MAXIMUM_LENGTH * 2}
                disabled={saving}
                aria-invalid={problems.description !== undefined || undefined}
                aria-describedby={problems.description !== undefined ? `${descriptionId}-problem` : undefined}
              />
              {fieldProblem("description", descriptionId)}
            </div>

            {inUse !== null && <VariableInUseList details={inUse} />}
          </div>

          <DialogErrorAlert error={error} />

          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || unchanged}>
              {saving ? "Saving..." : original === null ? "Add variable" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
