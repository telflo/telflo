import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  COLLECTOR_NAME_MAXIMUM_LENGTH,
  CollectorNameSchema,
  FLEETS_UNAVAILABLE_MESSAGE,
  type Collector,
  type CollectorGroup,
  type CollectorPinRequest,
  type FleetType,
  type UpdateCollectorRequest,
  type VariablesUndefinedDetails,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, getCollectorGroups, isSessionEnded, updateCollector } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import {
  FLEET_READ_TIMEOUT_MS,
  FLEET_WRITE_TIMEOUT_MS,
  fleetFieldProblemsOf,
  fleetRefusalMessage,
  isFleetGone,
  isUnknownOutcome,
} from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { groupLabel, groupsInFleetOrder } from "~/lib/kubernetes-groups.js";
import { followGroupWords, UNNAMED_VARIABLE_GROUP, isVariableGroupGone, variablesUndefinedOf } from "~/lib/variable-group-display.js";
import { COLLECTOR_NOT_FOUND_MESSAGE, DELETED_VERSION_WORDS } from "./CollectorDetailsDialog.js";
import {
  ConfigurationVersionPicker,
  useConfigurationPickerKept,
  useConfigurationVersions,
  usePublishedConfigurations,
} from "./CollectorPinPicker.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import {
  UndefinedNamesRefused,
  useOfferedVariableGroups,
  useVersionReferences,
  VariableGroupSelect,
  VariablesUsed,
} from "./VariableGroupChoice.js";

/*
 * "Edit collector": a `max-w-md` dialog with a `<form>`, the title, "OK"
 * disabled until something changes and "Saving…", with the pin picker
 * (`CollectorPinPicker.tsx`).
 *
 * - The description names the move and the published version; "UID:".
 * - Name (prefilled, at most 200 characters, trimmed before it is sent and
 *   checked against `CollectorNameSchema`, whose words show under the
 *   field with nothing sent; a whitespace-only change is none), **Group**
 *   (the move; a Select of the fleet's groups, their ids its values) and
 *   **Pin**: "Follow the group", "A published version" (the Configuration
 *   and Version Selects), and, for a pin whose version the platform no
 *   longer holds, "A deleted configuration's version": preselected and
 *   never sent unless changed (it can't be sent back).
 * - **Variable group**, a Select: "Follow group (eu-edge)" first (the chosen
 *   group's variable group's name, "Follow group (Organization values)" for
 *   none), then the organization's variable groups, read at the opening
 *   (`VariableGroupChoice`); the collector's pinned one preselected.
 *   Independent of the pin (either, both or neither).
 * - **One `PATCH`** with only what changed (the name, `groupId`, the pin by
 *   its `kind` and `versionId`, or `null` to unpin, `pinnedVariableGroupId`
 *   or `null` to follow the group's): rename, move and pin
 *   land together or not at all.
 * - **The baseline**: the collector as the dialog opened, its pin and
 *   pinned variable group included, a snapshot, never the live prop: a
 *   field is sent only when it differs from the snapshot, and a parent's
 *   reload while it is open moves nothing.
 * - **"Follow the group" is never refused**. When the tab holds no groups (its
 *   read failed), or none that is the collector's (a group made since the
 *   tab's last groups read, the collector refreshed by the details, or a
 *   tab's answer since the opening that dropped it), the dialog reads them
 *   itself for its Group Select, once an opening, whenever that is (10 s
 *   guard; a read without the collector's group counts as failed):
 *   "Loading groups…", then on a failure "The groups couldn't be read."
 *   with "Try again"; while it has none the Group can't change, and no
 *   hint and no "(group default)" marker show. A Group chosen that the
 *   groups shown no longer hold reads "A group no longer listed", never a
 *   blank trigger or an empty name.
 * - A hint says what saving does to what the collector runs.
 * - **"Variables used"** (the group dialogs' part, `VariableGroupChoice`'s
 *   `VariablesUsed`): for "A published version", the chosen version's
 *   organization variables no variable defines, before Save, with "Saving
 *   is refused until they are defined on the Variables page." when the save
 *   would pin it (else "Define them on the Variables page.", the pin as it
 *   opened isn't sent again).
 * - Refusals inline (`DialogErrorAlert`): a taken name, or a 400 naming
 *   `name`, under the Name; `configuration_version_not_published`,
 *   `configuration_version_not_found`, `collector_group_not_found`, a 429 and
 *   the fleet refusals in the alert (`variable_group_not_found`'s words;
 *   `variables_undefined`'s with its names, at most 100, then "… and N
 *   more"), else "Failed to update collector". `collector_not_found` toasts
 *   "Collector not found", closes and reloads; `fleet_not_found` toasts the
 *   API's words (`fleetRefusalMessage`), closes and reloads (the grid then
 *   shows "Fleet not found"). An unknown outcome (`isUnknownOutcome`: a 5xx,
 *   no connection, a reply that doesn't parse, the 30 s hang guard) shows the
 *   503's words and keeps the dialog open: a retry is safe, a `PATCH` sets
 *   values; the dialog closed after one reloads. The organization's or the
 *   terms' refusal closes and revalidates the layout; a session ended is
 *   silent.
 * - Success toasts "Collector updated", closes, and reloads
 *   the grid's page and the fleet (`onChanged`).
 * - While saving: Cancel disabled, no X, Escape and outside clicks do
 *   nothing; every field disabled; a double Enter sends once.
 * - Each opening is a new session (`useOpeningKey`); an answer after the
 *   dialog unmounted, or for an organization no longer active, does
 *   nothing (`useStillCurrent`).
 *
 * On a Kubernetes-supervisor fleet the Group select and the hints name the
 * Agent and the Cluster by their roles (`groupLabel`: "It is sent Agent's
 * published version on its next poll."), listed Agent, Cluster, then the
 * gateways; and a muted canary note under the Pin select, which it describes
 * (`aria-describedby`): a pin lasts only as long as the pod.
 *
 * Privacy: names are text in the masked shell. The Name input's `value`
 * attribute holds the name (React writes a controlled input's): the named
 * exception, masked by replay's `maskAllInputs` (the picker has no search
 * box). Every Select's item values are ids or the fixed choices below, never
 * a name.
 */

export const UPDATE_COLLECTOR_FAILED_MESSAGE = "Failed to update collector";

/** The groups the dialog read itself couldn't be read. */
export const GROUPS_UNREADABLE_WORDS = "The groups couldn't be read.";

/** The Group chosen, once the groups shown no longer hold it (a tab's answer since): never an empty name or a blank trigger. */
export const GROUP_NOT_LISTED_WORDS = "A group no longer listed";

/** The hints: what saving leads to. */
export const HINT_NEW_PIN = "It is sent this configuration on its next poll.";
export const HINT_PIN_STILL_DECIDES = "Its pin still decides what it runs.";
export function hintGroupVersion(groupName: string): string {
  return `It is sent ${groupName}'s published version on its next poll.`;
}
export function hintGroupNothing(groupName: string): string {
  return `${groupName} has no published version: it shows Nothing assigned and keeps running what it has.`;
}

/** The pin's canary note on a Kubernetes fleet, bulk pin's too. */
export const KUBERNETES_PIN_NOTE = "A rescheduled pod is a new collector: it follows its group again.";

/** The Variable group Select's fixed choice: follow the group's (its item value, never an id). */
export const FOLLOW_GROUP_CHOICE = "follow";

/** The Pin Select's fixed choices: its item values. */
type PinChoice = "follow" | "version" | "orphan";

/** The Pin Select's words, bulk pin's too. */
export const PIN_CHOICE_LABELS: Record<PinChoice, string> = {
  follow: "Follow the group",
  version: "A published version",
  orphan: DELETED_VERSION_WORDS,
};

function isPinChoice(value: string): value is PinChoice {
  return value === "follow" || value === "version" || value === "orphan";
}

/** The Pin a collector opens with. */
function choiceOf(pin: Collector["pin"]): PinChoice {
  if (pin === null) return "follow";
  return pin.versionId === null || pin.version === null ? "orphan" : "version";
}

/** The groups the dialog shows: the tab's, or its own read's ("idle" until it starts: shown as loading). */
type GroupsRead = { state: "read"; groups: CollectorGroup[] } | { state: "idle" } | { state: "loading" } | { state: "failed" };

export interface EditCollectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The collector to edit; null renders nothing to send. */
  collector: Collector | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The tab's groups; null when the tab holds none (the dialog then reads them itself). */
  groups: CollectorGroup[] | null;
  /** The fleet's type: a Kubernetes fleet's groups are named by role, and its Pin has the canary note. */
  fleetType?: FleetType;
  /** After an update, a 404 for the collector or the fleet, or closing after an unknown outcome: the grid reloads its page and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: the fields hold the collector afresh, with no earlier refusal. */
export function EditCollectorDialog(props: EditCollectorDialogProps) {
  const opening = useOpeningKey(props.open);
  return <EditCollectorSession key={opening} {...props} />;
}

function EditCollectorSession({
  open,
  onOpenChange,
  collector: liveCollector,
  organizationId,
  fleetId,
  groups: tabGroups,
  fleetType = "server",
  onChanged,
  onCloseAutoFocus,
}: EditCollectorDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const nameId = useId();
  const groupId = useId();
  const pinId = useId();
  const variableGroupSelectId = useId();
  // The session's baseline is the collector as it opened, never the live prop:
  // a grid's reload while the dialog is open must not move what a field is
  // compared against.
  const [collector] = useState(liveCollector);

  const pin = collector?.pin ?? null;
  const [name, setName] = useState(collector?.name ?? "");
  const [chosenGroupId, setChosenGroupId] = useState(collector?.groupId ?? "");
  const [choice, setChoice] = useState<PinChoice>(choiceOf(pin));
  const pinnedVersion = pin?.kind === "version" && pin.versionId !== null ? pin.version : null;
  const [configurationId, setConfigurationId] = useState<string | null>(pinnedVersion?.configurationId ?? null);
  const [versionId, setVersionId] = useState<string | null>(
    pin?.kind === "version" && pinnedVersion !== null ? pin.versionId : null,
  );
  // A configuration chosen selects its newest version once its versions are read.
  const [pickNewest, setPickNewest] = useState(false);

  const [saving, setSaving] = useState(false);
  // Reentry guard: a double Enter lands before the state re-renders.
  const savingRef = useRef(false);
  // An answer left the update unknown: closing reloads the grid.
  const outcomeUnknownRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The groups: the tab's when they hold the collector's, else the dialog's own read.
  const collectorGroupId = collector?.groupId ?? null;
  const tabHoldsGroup = tabGroups !== null && tabGroups.some((group) => group.id === collectorGroupId);
  const [ownGroups, setOwnGroups] = useState<GroupsRead>({ state: "idle" });
  const readGroups = useCallback(() => {
    setOwnGroups({ state: "loading" });
    void read((signal) => getCollectorGroups(organizationId, fleetId, { signal })).then((answer) => {
      if (answer === null) return;
      if (answer.ok) {
        // A read without the collector's group can't name it: as unreadable, never an empty name.
        const { groups: fleetGroups } = answer.value;
        const holdsGroup = fleetGroups.some((group) => group.id === collectorGroupId);
        setOwnGroups(holdsGroup ? { state: "read", groups: fleetGroups } : { state: "failed" });
        return;
      }
      const failure = answer.error;
      if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
        onOpenChange(false);
        void revalidate();
        return;
      }
      setOwnGroups({ state: "failed" });
    });
  }, [read, organizationId, fleetId, collectorGroupId, onOpenChange, revalidate]);
  useEffect(() => {
    // One read per opening (none has started while "idle"), whenever the tab's groups don't hold the collector's: at
    // opening, or once a tab's answer since has dropped it. StrictMode's second run starts it again (the closure's
    // state is still "idle"); the first run's read, aborted, is dropped (`useOpeningReads`).
    if (open && !tabHoldsGroup && ownGroups.state === "idle") readGroups();
  }, [open, tabHoldsGroup]);
  const groupsRead: GroupsRead = tabHoldsGroup && tabGroups !== null ? { state: "read", groups: tabGroups } : ownGroups;
  const groups = groupsRead.state === "read" ? groupsRead.groups : null;
  const chosenGroup = groups?.find((group) => group.id === chosenGroupId) ?? null;

  const configurations = usePublishedConfigurations(open, read, organizationId);
  const versions = useConfigurationVersions(read, organizationId, configurationId);
  // The picker's configurations chosen, kept while the Pin choice switches away and back.
  const pickerKept = useConfigurationPickerKept();

  // The pinned variable group: the collector's as it opened, else "Follow group (…)".
  const offeredVariableGroups = useOfferedVariableGroups(open, read, organizationId);
  const pinnedVariableGroupId = collector?.pinnedVariableGroupId ?? null;
  const [variableGroupChoice, setVariableGroupChoice] = useState<string>(pinnedVariableGroupId ?? FOLLOW_GROUP_CHOICE);
  const chosenVariableGroupId = variableGroupChoice === FOLLOW_GROUP_CHOICE ? null : variableGroupChoice;
  const [undefinedRefused, setUndefinedRefused] = useState<VariablesUndefinedDetails | null>(null);
  // "Variables used" (the group dialogs' part): the published version the Pin chooses, before Save.
  const references = useVersionReferences(
    read,
    organizationId,
    choice === "version" ? configurationId : null,
    choice === "version" ? versionId : null,
  );

  // Only a read picks: after a failed read, "Try again"'s answer still preselects the newest.
  if (pickNewest && versions.configurationId === configurationId && versions.status === "read") {
    setPickNewest(false);
    setVersionId(versions.versions[0]?.id ?? null);
  }

  if (collector === null) {
    return <Dialog open={open} onOpenChange={onOpenChange} />;
  }

  const kubernetes = fleetType === "kubernetes-supervisor";
  const trimmed = name.trim();
  const nameChanged = trimmed !== collector.name;
  const groupChanged = chosenGroupId !== collector.groupId;
  const pinChange = ((): { complete: boolean; request: CollectorPinRequest | undefined } => {
    switch (choice) {
      case "follow":
        return { complete: true, request: pin === null ? undefined : null };
      case "version":
        if (versionId === null) return { complete: false, request: undefined };
        return {
          complete: true,
          request: pin?.kind === "version" && pin.versionId === versionId ? undefined : { kind: "version", versionId },
        };
      case "orphan":
        return { complete: true, request: undefined };
    }
  })();
  const pinChanged = pinChange.request !== undefined;
  const variableGroupChanged = chosenVariableGroupId !== collector.pinnedVariableGroupId;
  const canSubmit = !saving && trimmed !== "" && pinChange.complete && (nameChanged || groupChanged || pinChanged || variableGroupChanged);

  // "Follow group (eu-edge)": the chosen group's variable group, by the list read at the opening; unknown without the group.
  const followWords = (() => {
    if (chosenGroup === null) return followGroupWords(undefined);
    if (chosenGroup.variableGroupId === null) return followGroupWords(null);
    const named = offeredVariableGroups.groups.find((each) => each.id === chosenGroup.variableGroupId);
    return followGroupWords(named?.name ?? UNNAMED_VARIABLE_GROUP);
  })();

  // The hint: none without groups, none for a rename alone.
  const hint = ((): string | null => {
    if (groups === null || chosenGroup === null) return null;
    if (pinChanged && pinChange.request !== null) return HINT_NEW_PIN;
    const followsAfter = pinChanged ? pinChange.request === null : pin === null;
    if (followsAfter && (pinChanged || groupChanged)) {
      const label = groupLabel(chosenGroup, fleetType);
      return chosenGroup.assignedPublishedVersionId !== null ? hintGroupVersion(label) : hintGroupNothing(label);
    }
    if (groupChanged) return HINT_PIN_STILL_DECIDES;
    return null;
  })();

  const close = () => {
    if (savingRef.current) return;
    onOpenChange(false);
    // The collector may have changed: the grid reads its page again.
    if (outcomeUnknownRef.current) onChanged();
  };

  const chooseGroup = (value: string) => {
    setChosenGroupId(value);
    setError(null);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (failure instanceof ApiError && failure.code === "collector_not_found") {
      toast.error(COLLECTOR_NOT_FOUND_MESSAGE);
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, UPDATE_COLLECTOR_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      outcomeUnknownRef.current = true;
      setError(FLEETS_UNAVAILABLE_MESSAGE);
      return;
    }
    if (failure instanceof ApiError && failure.code === "collector_name_taken") {
      setProblem(failure.message);
      return;
    }
    const { name: nameProblem } = fleetFieldProblemsOf(failure);
    if (nameProblem !== undefined) {
      setProblem(nameProblem);
      return;
    }
    // A variable group deleted meanwhile: its words, and the list read again (the choice then reads "no longer listed").
    if (isVariableGroupGone(failure)) offeredVariableGroups.retry();
    setUndefinedRefused(variablesUndefinedOf(failure));
    setError(fleetRefusalMessage(failure, UPDATE_COLLECTOR_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || !canSubmit) return;
    const request: UpdateCollectorRequest = {};
    if (nameChanged) {
      const checked = CollectorNameSchema.safeParse(trimmed);
      if (!checked.success) {
        setError(null);
        setProblem(checked.error.issues[0]?.message ?? UPDATE_COLLECTOR_FAILED_MESSAGE);
        return;
      }
      request.name = trimmed;
    }
    if (groupChanged) request.groupId = chosenGroupId;
    if (pinChanged) request.pin = pinChange.request;
    if (variableGroupChanged) request.pinnedVariableGroupId = chosenVariableGroupId;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setUndefinedRefused(null);
    setProblem(null);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await updateCollector(sentIn, fleetId, collector.id, request, { signal: guard.signal });
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success("Collector updated");
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
            <DialogTitle>Edit collector</DialogTitle>
            <DialogDescription>
              Rename this collector, move it to another group, or pin it to a published version or a variable group. Names
              must be unique within your organization; “Follow the group” clears its pin.
            </DialogDescription>
          </DialogHeader>

          <div className="pt-2 text-xs text-muted-foreground">
            UID: <span className="font-mono text-foreground">{collector.instanceUid}</span>
          </div>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                  setError(null);
                }}
                maxLength={COLLECTOR_NAME_MAXIMUM_LENGTH}
                autoFocus
                disabled={saving}
                autoComplete="off"
                aria-invalid={problem !== null || undefined}
                aria-describedby={problem !== null ? `${nameId}-problem` : undefined}
              />
              {problem !== null && (
                <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                  {problem}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              {groups === null ? (
                <>
                  <Label>Group</Label>
                  {groupsRead.state === "failed" ? (
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] text-fail">{GROUPS_UNREADABLE_WORDS}</p>
                      <Button type="button" variant="outline" size="sm" onClick={readGroups} disabled={saving}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <p role="status" className="text-[13px] text-muted-foreground">
                      Loading groups…
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Label htmlFor={groupId}>Group</Label>
                  <Select
                    value={chosenGroupId}
                    onValueChange={(value) => {
                      if (value && value !== chosenGroupId) chooseGroup(value);
                    }}
                    disabled={saving}
                  >
                    <SelectTrigger id={groupId}>
                      <SelectValue placeholder="Pick a group" />
                    </SelectTrigger>
                    <SelectContent>
                      {chosenGroup === null && chosenGroupId !== "" && (
                        // The Group chosen, no longer listed: the trigger names it neutrally, never blank.
                        <SelectItem value={chosenGroupId} disabled>
                          {GROUP_NOT_LISTED_WORDS}
                        </SelectItem>
                      )}
                      {groupsInFleetOrder(groups, fleetType).map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {groupLabel(group, fleetType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor={pinId}>Pin</Label>
              <Select
                value={choice}
                onValueChange={(value) => {
                  if (!isPinChoice(value) || value === choice) return;
                  setChoice(value);
                  setError(null);
                }}
                disabled={saving}
              >
                <SelectTrigger id={pinId} aria-describedby={kubernetes ? `${pinId}-note` : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="follow">
                    {PIN_CHOICE_LABELS.follow}
                  </SelectItem>
                  <SelectItem value="version">{PIN_CHOICE_LABELS.version}</SelectItem>
                  {choiceOf(pin) === "orphan" && <SelectItem value="orphan">{PIN_CHOICE_LABELS.orphan}</SelectItem>}
                </SelectContent>
              </Select>
              {kubernetes && (
                <p id={`${pinId}-note`} className="text-xs text-muted-foreground">
                  {KUBERNETES_PIN_NOTE}
                </p>
              )}
              {choice === "version" && (
                <ConfigurationVersionPicker
                  configurations={configurations}
                  versions={versions}
                  configurationId={configurationId}
                  versionId={versionId}
                  pinned={pinnedVersion}
                  groupDefault={chosenGroup?.assignedVersion ?? null}
                  onConfiguration={(value) => {
                    setConfigurationId(value);
                    setVersionId(null);
                    setPickNewest(true);
                    setError(null);
                  }}
                  onVersion={(value) => {
                    setVersionId(value);
                    setError(null);
                  }}
                  disabled={saving}
                  kept={pickerKept}
                />
              )}
              {hint !== null && <p className="text-xs text-warn">{hint}</p>}
            </div>

            {/* Saving is refused only when the save pins the version (a pin as it opened isn't sent again). */}
            <VariablesUsed references={references} assigns={pinChanged && pinChange.request !== null} disabled={saving} />

            <VariableGroupSelect
              id={variableGroupSelectId}
              label="Variable group"
              offered={offeredVariableGroups}
              value={variableGroupChoice}
              fixed={[{ value: FOLLOW_GROUP_CHOICE, label: followWords }]}
              onChange={(value) => {
                setVariableGroupChoice(value);
                setError(null);
              }}
              disabled={saving}
            />

            <DialogErrorAlert error={error} />
            <UndefinedNamesRefused details={error === null ? null : undefinedRefused} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "OK"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
