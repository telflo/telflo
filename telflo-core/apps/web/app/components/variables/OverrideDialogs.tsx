import { useId, useRef, useState, type FormEvent } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { VARIABLE_VALUE_MAXIMUM_LENGTH, VariableGroupOverrideRequestSchema } from "@telflo/contracts";
import { DialogErrorAlert } from "~/components/fleets/DialogErrorAlert.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
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
import { abortAfter } from "~/lib/abort-after.js";
import { resetVariableGroupOverride, setVariableGroupOverride } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import {
  OVERRIDE_RESET_MESSAGE,
  OVERRIDE_SAVED_MESSAGE,
  RESET_OVERRIDE_FAILED_MESSAGE,
  SAVE_OVERRIDE_FAILED_MESSAGE,
  VARIABLE_GROUP_NOT_FOUND_MESSAGE,
  VARIABLES_WRITE_TIMEOUT_MS,
  variableFieldProblemsOf,
  variableRefusalMessage,
  type VariableGroupRow,
} from "~/lib/variables.js";
import { handleSharedWriteFailure, type GoneCode } from "./write-failures.js";

/*
 * A variable group's page's two writes per row (D20 default 22; Q82, Q100):
 * Override, a dialog with the variable's value in this group (a new
 * override, or a replace; an empty value is a value, Q90, and Reset is its
 * own action), and Reset, a confirmation, after which the variable takes the
 * organization's value in the group again. Titles and toasts are fixed
 * ("Override value", "Reset override"; "Override saved", "Override reset");
 * the variable's name and values sit inside `ph-no-capture`, the Value's own
 * `value` the one attribute holding what is typed. The row is the one the
 * dialog opened on (D17c-1 Ruling 66). A group or variable found gone toasts
 * its fixed words, closes and reloads the page; the rest as
 * `write-failures.ts` says.
 */

const GONE: readonly GoneCode[] = [
  { code: "variable_group_not_found", message: VARIABLE_GROUP_NOT_FOUND_MESSAGE },
  { code: "variable_not_found", message: "Variable not found" },
];

export interface OverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  variableGroupId: string;
  row: VariableGroupRow | null;
  onChanged: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function OverrideDialog(props: OverrideDialogProps) {
  const opening = useOpeningKey(props.open);
  return <OverrideSession key={opening} {...props} />;
}

function OverrideSession({ open, onOpenChange, organizationId, variableGroupId, row: live, onChanged, onCloseAutoFocus }: OverrideDialogProps) {
  const valueId = useId();
  const [row] = useState(live);
  const [value, setValue] = useState(row?.value ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);

  const close = () => {
    if (!savingRef.current) onOpenChange(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (row === null || savingRef.current) return;
    setError(null);
    const checked = VariableGroupOverrideRequestSchema.safeParse({ value });
    if (!checked.success) {
      setProblem(checked.error.issues[0]?.message ?? SAVE_OVERRIDE_FAILED_MESSAGE);
      return;
    }
    setProblem(null);
    savingRef.current = true;
    setSaving(true);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    try {
      await setVariableGroupOverride(sentIn, variableGroupId, row.variable.id, checked.data.value, { signal: guard.signal });
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (!isStillCurrent(sentIn)) return;
      const handled = handleSharedWriteFailure(
        failure,
        { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
        GONE,
      );
      if (handled) return;
      const fieldProblem = variableFieldProblemsOf(failure).value;
      if (fieldProblem !== undefined) setProblem(fieldProblem);
      else setError(variableRefusalMessage(failure, SAVE_OVERRIDE_FAILED_MESSAGE));
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(OVERRIDE_SAVED_MESSAGE);
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
            <DialogTitle>Override value</DialogTitle>
            <DialogDescription>
              Collector groups and collectors that use this variable group get this value instead of the
              organization&apos;s.
            </DialogDescription>
          </DialogHeader>
          {row !== null && (
            <div className="ph-no-capture grid gap-4 py-4">
              <p className="break-all font-mono text-[13px] text-foreground">{`\${org:${row.variable.name}}`}</p>
              <p className="text-xs text-muted-foreground">
                Organization value: <span className="break-all font-mono text-foreground">{row.variable.value}</span>
              </p>
              <div className="grid gap-2">
                <Label htmlFor={valueId}>Value in this group</Label>
                <Input
                  id={valueId}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setProblem(null);
                    setError(null);
                  }}
                  className="font-mono"
                  maxLength={VARIABLE_VALUE_MAXIMUM_LENGTH * 2}
                  autoFocus
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problem !== null || undefined}
                  aria-describedby={problem !== null ? `${valueId}-problem` : undefined}
                />
                {problem !== null && (
                  <p id={`${valueId}-problem`} className="text-xs text-fail" role="alert">
                    {problem}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogErrorAlert error={error} />
          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type ResetOverrideDialogProps = OverrideDialogProps;

export function ResetOverrideDialog(props: ResetOverrideDialogProps) {
  const opening = useOpeningKey(props.open);
  return <ResetSession key={opening} {...props} />;
}

function ResetSession({ open, onOpenChange, organizationId, variableGroupId, row: live, onChanged, onCloseAutoFocus }: ResetOverrideDialogProps) {
  const [row] = useState(live);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const resettingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);

  const close = () => {
    if (!resettingRef.current) onOpenChange(false);
  };

  const handleReset = async () => {
    if (row === null || resettingRef.current) return;
    resettingRef.current = true;
    setResetting(true);
    setError(null);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    try {
      await resetVariableGroupOverride(sentIn, variableGroupId, row.variable.id, { signal: guard.signal });
    } catch (failure) {
      resettingRef.current = false;
      setResetting(false);
      if (!isStillCurrent(sentIn)) return;
      const handled = handleSharedWriteFailure(
        failure,
        { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
        GONE,
      );
      if (!handled) setError(variableRefusalMessage(failure, RESET_OVERRIDE_FAILED_MESSAGE));
      return;
    } finally {
      guard.clear();
    }
    resettingRef.current = false;
    setResetting(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(OVERRIDE_RESET_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (resetting) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Reset override</AlertDialogTitle>
          <AlertDialogDescription>The variable takes the organization&apos;s value in this group again.</AlertDialogDescription>
        </AlertDialogHeader>
        {row !== null && (
          <div className="ph-no-capture">
            <p className="break-all font-mono text-[13px] text-foreground">{`\${org:${row.variable.name}}`}</p>
          </div>
        )}
        <DialogErrorAlert error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleReset();
            }}
            disabled={resetting}
          >
            {resetting ? "Resetting..." : "Reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
