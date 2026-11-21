import { useId, useRef, useState, type FormEvent } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  CreateVariableGroupRequestSchema,
  UpdateVariableGroupRequestSchema,
  VARIABLE_DESCRIPTION_MAXIMUM_LENGTH,
  VARIABLE_GROUP_NAME_MAXIMUM_LENGTH,
  type UpdateVariableGroupRequest,
  type VariableGroup,
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
import { createVariableGroup, updateVariableGroup } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { randomUuid } from "~/lib/ids.js";
import { noteVariableGroupName } from "~/lib/variable-group-display.js";
import {
  SAVE_VARIABLE_GROUP_FAILED_MESSAGE,
  VARIABLE_GROUP_ADDED_MESSAGE,
  VARIABLE_GROUP_NOT_FOUND_MESSAGE,
  VARIABLE_GROUP_SAVED_MESSAGE,
  VARIABLES_WRITE_TIMEOUT_MS,
  descriptionOf,
  hasVariableCode,
  strippedName,
  variableFieldProblemsOf,
  variableRefusalMessage,
} from "~/lib/variables.js";
import { handleSharedWriteFailure } from "./write-failures.js";

/*
 * A variable group's create, rename and description: add and rename in one,
 * with a description. A group starts with no override. The titles and toasts
 * are fixed words ("Add variable group", "Edit variable group"; "Variable
 * group added", "Variable group saved"), never the name. The fields sit inside
 * `ph-no-capture`; the Name's own `value` is the one attribute holding it. A
 * create carries this opening's id (a retry is safe); an edit sends only what
 * changed, and Save waits for a change. `variable_group_name_taken` is said
 * under Name; the rest as `write-failures.ts` says. The baseline is the group
 * as the dialog opened. A save's group goes into the fleet screens' shared
 * names at once.
 */

export interface VariableGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** The group to edit; null for a new one. */
  variableGroup: VariableGroup | null;
  onChanged: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function VariableGroupDialog(props: VariableGroupDialogProps) {
  const opening = useOpeningKey(props.open);
  return <VariableGroupSession key={opening} {...props} />;
}

type Problems = { name?: string; description?: string };

function problemsOfIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Problems {
  const problems: Problems = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if ((field === "name" || field === "description") && problems[field] === undefined) problems[field] = issue.message;
  }
  return problems;
}

function VariableGroupSession({ open, onOpenChange, organizationId, variableGroup, onChanged, onCloseAutoFocus }: VariableGroupDialogProps) {
  const nameId = useId();
  const descriptionId = useId();
  const [original] = useState(variableGroup);
  const [createId] = useState(randomUuid);
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);

  const changes = (): UpdateVariableGroupRequest => {
    if (original === null) return {};
    const next: UpdateVariableGroupRequest = {};
    const typedName = strippedName(name);
    if (typedName !== original.name) next.name = typedName;
    const typedDescription = descriptionOf(description);
    if (typedDescription !== original.description) next.description = typedDescription;
    return next;
  };
  const unchanged = original !== null && Object.keys(changes()).length === 0;

  const close = () => {
    if (!savingRef.current) onOpenChange(false);
  };

  const failed = (failure: unknown) => {
    const handled = handleSharedWriteFailure(
      failure,
      { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
      [{ code: "variable_group_not_found", message: VARIABLE_GROUP_NOT_FOUND_MESSAGE }],
    );
    if (handled) return;
    if (hasVariableCode(failure, "variable_group_name_taken")) {
      setProblems({ name: failure.message });
      return;
    }
    const fieldProblems = variableFieldProblemsOf(failure);
    const shown: Problems = {};
    if (fieldProblems.name !== undefined) shown.name = fieldProblems.name;
    if (fieldProblems.description !== undefined) shown.description = fieldProblems.description;
    if (Object.keys(shown).length > 0) {
      setProblems(shown);
      return;
    }
    setError(variableRefusalMessage(failure, SAVE_VARIABLE_GROUP_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    setError(null);
    let send: (signal: AbortSignal) => Promise<VariableGroup>;
    if (original === null) {
      const checked = CreateVariableGroupRequestSchema.safeParse({
        id: createId,
        name: strippedName(name),
        description: descriptionOf(description),
      });
      if (!checked.success) {
        setProblems(problemsOfIssues(checked.error.issues));
        return;
      }
      send = (signal) => createVariableGroup(organizationId, checked.data, { signal });
    } else {
      const request = changes();
      if (Object.keys(request).length === 0) return;
      const checked = UpdateVariableGroupRequestSchema.safeParse(request);
      if (!checked.success) {
        setProblems(problemsOfIssues(checked.error.issues));
        return;
      }
      send = (signal) => updateVariableGroup(organizationId, original.id, checked.data, { signal });
    }
    setProblems({});
    savingRef.current = true;
    setSaving(true);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    let saved: VariableGroup;
    try {
      saved = await send(guard.signal);
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
    // The fleet screens' shared names follow the save.
    noteVariableGroupName(sentIn, saved.id, saved.name);
    toast.success(original === null ? VARIABLE_GROUP_ADDED_MESSAGE : VARIABLE_GROUP_SAVED_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

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
            <DialogTitle>{original === null ? "Add variable group" : "Edit variable group"}</DialogTitle>
            <DialogDescription>
              A variable group overrides some of the organization&apos;s values for the collector groups and collectors
              that use it.
            </DialogDescription>
          </DialogHeader>
          <div className="ph-no-capture grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblems(({ name: _cleared, ...rest }) => rest);
                  setError(null);
                }}
                maxLength={VARIABLE_GROUP_NAME_MAXIMUM_LENGTH * 2}
                autoFocus
                disabled={saving}
                autoComplete="off"
                aria-invalid={problems.name !== undefined || undefined}
                aria-describedby={problems.name !== undefined ? `${nameId}-problem` : undefined}
              />
              {problems.name !== undefined && (
                <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                  {problems.name}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={descriptionId}>Description (optional)</Label>
              <Textarea
                id={descriptionId}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setProblems(({ description: _cleared, ...rest }) => rest);
                  setError(null);
                }}
                rows={2}
                maxLength={VARIABLE_DESCRIPTION_MAXIMUM_LENGTH * 2}
                disabled={saving}
                aria-invalid={problems.description !== undefined || undefined}
                aria-describedby={problems.description !== undefined ? `${descriptionId}-problem` : undefined}
              />
              {problems.description !== undefined && (
                <p id={`${descriptionId}-problem`} className="text-xs text-fail" role="alert">
                  {problems.description}
                </p>
              )}
            </div>
          </div>
          <DialogErrorAlert error={error} />
          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || unchanged}>
              {saving ? "Saving..." : original === null ? "Add variable group" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
