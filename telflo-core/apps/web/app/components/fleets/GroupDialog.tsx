import { useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  annotationsWithDockerMounts,
  COLLECTOR_GROUP_NAME_MAXIMUM_LENGTH,
  CollectorGroupNameSchema,
  dockerMountsOf,
  FLEETS_UNAVAILABLE_MESSAGE,
  type CollectorGroup,
  type CreateCollectorGroupRequest,
  type DockerMount,
  type UpdateCollectorGroupRequest,
  type VariablesUndefinedDetails,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, createCollectorGroup, getCollectorGroups, isSessionEnded, updateCollectorGroup } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import {
  FLEET_READ_TIMEOUT_MS,
  FLEET_WRITE_TIMEOUT_MS,
  fieldProblemsOf,
  fleetFieldProblemsOf,
  fleetRefusalMessage,
  isFleetGone,
  isUnknownOutcome,
} from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { NO_VARIABLE_GROUP_WORDS, isVariableGroupGone, variablesUndefinedOf } from "~/lib/variable-group-display.js";
import { DELETED_VERSION_WORDS } from "./CollectorDetailsDialog.js";
import {
  ConfigurationVersionPicker,
  useConfigurationPickerKept,
  useConfigurationVersions,
  usePublishedConfigurations,
} from "./CollectorPinPicker.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { isUnassigned, NOTHING_ASSIGNED_WORDS } from "./GroupsTable.js";
import {
  hasMountProblems,
  mountDetailKey,
  mountProblemKey,
  mountProblemsOf,
  MountsEditor,
  mountsOf,
  newMountRow,
  NO_MOUNT_PROBLEMS,
  sameMounts,
  type MountField,
  type MountProblems,
  type MountRow,
} from "./MountsEditor.js";
import {
  UndefinedNamesRefused,
  useOfferedVariableGroups,
  useVersionReferences,
  VariableGroupSelect,
  VariablesUsed,
} from "./VariableGroupChoice.js";

/*
 * The group dialog: one Dialog for create, edit and assign, with its
 * titles' forms, its Name placeholder, "Create", "Assign" or "Save", and
 * outside clicks and Escape blocked while saving; the pin picker
 * (`ConfigurationVersionPicker`) picks the version. Its details:
 *
 * - The titles "New group", `Edit {name}` and `Assign a published version to
 *   {name}` (an unassigned group's); the descriptions say what pinned
 *   collectors do; the Name's two hints are dropped (a group can be renamed:
 *   collectors join by id).
 * - **Name**: prefilled when editing, at most 80 characters, trimmed before
 *   it is sent and checked against `CollectorGroupNameSchema`, whose words
 *   show under the field with nothing sent; a taken name
 *   (`collector_group_name_taken`) or a 400 naming `name` shows there too.
 *   The Default group's Name is read-only, with "The Default group can't be
 *   renamed.", and never sent.
 * - **Published version** (the picker: published configurations with "Load
 *   more" and no search box, then the chosen configuration's published
 *   versions, newest first, a configuration chosen selecting its newest; the
 *   current assignment's configuration always offered; no "(group default)"
 *   marker). Create requires one: it shows the picker alone, with no choice and
 *   no "Nothing assigned", and no visible "Published version" heading: a group
 *   whose `aria-label` is the fixed words "Published version". An unassigned
 *   group's Assign shows the picker alone too, nothing picked ("Nothing
 *   assigned" only releases an assigned group). An assigned group's Edit keeps
 *   its visible "Published version" label and chooses "A published version"
 *   (the picker) or "Nothing assigned" (its hint says it releases the version),
 *   and "A deleted configuration's version" only for such an assignment,
 *   preselected and never sent unless changed. No starter configuration.
 * - **Variable group**: a Select of the organization's variable groups, read at
 *   the opening (`VariableGroupChoice`: the list a snapshot), "None
 *   (organization values)" first and the default; the group's own preselected.
 *   `variableGroupId` is sent only when the choice differs from the group's as
 *   it opened (null for None; a create sends it only for a variable group
 *   chosen), and a change alone enables the save. The Select's trigger and list
 *   sit inside `ph-no-capture` (a variable group's name is configuration text).
 * - **Variables used**: for the version chosen (the assignment it opens with
 *   included), its text read through `getConfigurationVersion(…, signal)` under
 *   the opening's reads (a new choice aborts the previous read, whose late
 *   answer is dropped), its names extracted with the web's `References`, and
 *   those no organization variable has listed before Save, inside
 *   `ph-no-capture`. A 422 `variables_undefined` shows the API's words and its
 *   names (at most 100, then "… and N more" from `totalNames`); a 404
 *   `variable_group_not_found` its words.
 * - **Mounts** (`MountsEditor.tsx`): a disclosure "Mounts (for the container
 *   install)", a plain button with `aria-expanded` and `aria-controls` (the
 *   panel stays in the document, `hidden` while closed), closed by default and
 *   open when the group has mounts (or ones Telflo can't read), for create and
 *   edit, Default's included. The rows start as
 *   `dockerMountsOf(group.annotations)`; a "telflo" annotation Telflo can't
 *   read shows no rows and says a mount added here replaces it (a rename alone
 *   leaves it). `annotations` is sent only when the mounts (paths trimmed)
 *   differ from the group's: `annotationsWithDockerMounts` keeps every other
 *   key, removes "telflo" with no mounts and sends null when nothing is left; a
 *   create sends it only with mounts. Before an edit's mounts write the group
 *   is read again under the write's hang guard and the mounts merged into its
 *   fresh annotations; when its mounts changed since the opening (a member
 *   saved one meanwhile) the save is refused, "This group's mounts changed
 *   since you opened it: close and reopen to see them.", nothing sent, so a
 *   mount saved elsewhere is never silently dropped, and the tab reads its
 *   groups again at once (`onChanged`); a name or version save alone reads
 *   nothing. The contracts' rules are checked at submit, each field's message
 *   under it (a 400's `annotations.telflo.dockerMounts.{n}` details too), with
 *   nothing sent, and the disclosure opened.
 * - A hint says what saving does: a version is sent to the group's unpinned
 *   collectors on their next poll (only for a version the save would send:
 *   none for the assignment a group opens with); "Nothing assigned" releases
 *   the version. The Published version select (create and an unassigned
 *   group's Assign: the picker's group) is described by it.
 * - The submit is disabled without a trimmed name; on create, until a
 *   complete version is picked; when editing, while "A published version"
 *   has a configuration chosen but no version, and until something changes
 *   ("A published version" with nothing picked on an unassigned group is no
 *   change, so a rename alone saves). One `POST` (always `{name,
 *   assignedVersionId}`, and `annotations` with mounts) or one `PATCH` with
 *   only what changed (`{name}`, `{assignedVersionId}`,
 *   `{assignedVersionId: null}`, `{annotations}`, or several).
 * - Refusals inline (`DialogErrorAlert`): `configuration_version_not_published`,
 *   `configuration_version_not_found`, `collector_group_is_default`, a 429
 *   with its words; otherwise "Failed to save group".
 *   `collector_group_not_found` toasts "Group not found", closes and
 *   reloads; `fleet_not_found` toasts the API's words, closes and reloads
 *   (the page then shows "Fleet not found"). An unknown outcome
 *   (`isUnknownOutcome`, the 30 s hang guard included) shows the 503's words
 *   ("…reload before trying again") and keeps the dialog open: a `PATCH` is
 *   safe to retry, and a create's retry answering a taken name for the group
 *   the first try made is what the words' advice covers; closing after one
 *   reloads the tab. The organization's or the terms' refusal closes and
 *   revalidates the layout; a session ended is silent.
 * - The session's baseline (the rows, the title, what the request and the
 *   mounts-changed check compare against) is the group as it opened, a
 *   snapshot, never the live prop.
 * - Success toasts "Group created" or "Group updated", closes, and reloads
 *   the tab and the fleet.
 * - While saving: Cancel disabled, no X, Escape and outside clicks do
 *   nothing, every field disabled; a double Enter sends once. Each opening
 *   is a new session (`useOpeningKey`); an answer after the dialog unmounted
 *   or for an organization no longer active does nothing.
 *
 * Privacy: group and configuration names and version labels are text in
 * the masked shell. The Name input's `value` (React writes a controlled
 * input's) is the named exception, masked by replay's `maskAllInputs`
 * (the picker has no search box); every Select's item values are ids or
 * the fixed choices below.
 */

export const SAVE_GROUP_FAILED_MESSAGE = "Failed to save group";
export const GROUP_NOT_FOUND_MESSAGE = "Group not found";

export const CREATE_DESCRIPTION =
  "A group gives its collectors one published version. Collectors that aren't pinned are sent it on their next poll.";
export const EDIT_DESCRIPTION =
  "Rename the group, change its published version, its variable group or its mounts. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.";
export const DEFAULT_DESCRIPTION =
  "Change the group's published version, its variable group or its mounts. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.";
export const DEFAULT_NAME_HINT = "The Default group can't be renamed.";
/** A mounts save refused because the group's mounts were changed elsewhere since the dialog opened. */
export const MOUNTS_CHANGED_MESSAGE = "This group's mounts changed since you opened it: close and reopen to see them.";

/** The hints: what saving does to the group's collectors. */
export const HINT_VERSION = "The group's collectors that aren't pinned are sent this version on their next poll; pinned ones keep their pin.";
/** "Nothing assigned", offered only to release an assigned group's version. */
export const HINT_NOTHING =
  "Releases the published version (e.g. to delete its configuration). Collectors keep running what they have; new installs need a published version.";

/** The mounts' disclosure. */
export const MOUNTS_DISCLOSURE = "Mounts (for the container install)";

/** The Variable group Select's fixed choice: no variable group. Its item value, never an id. */
export const NO_VARIABLE_GROUP_CHOICE = "none";

/** The Variable group Select's label. */
export const VARIABLE_GROUP_LABEL = "Variable group";

/** The Published version Select's fixed choices: its item values. */
export type AssignmentChoice = "version" | "nothing" | "orphan";

export const ASSIGNMENT_CHOICE_LABELS: Record<AssignmentChoice, string> = {
  version: "A published version",
  nothing: NOTHING_ASSIGNED_WORDS,
  orphan: DELETED_VERSION_WORDS,
};

function isAssignmentChoice(value: string): value is AssignmentChoice {
  return value === "version" || value === "nothing" || value === "orphan";
}

/** The choice a dialog opens on: create and an unassigned group's Assign (which offer no other) on "A published version", nothing picked. */
export function choiceOf(group: CollectorGroup | null): AssignmentChoice {
  if (group === null || isUnassigned(group)) return "version";
  return group.assignedVersion === null ? "orphan" : "version";
}

/** The title. */
export function groupDialogTitle(group: CollectorGroup | null): string {
  if (group === null) return "New group";
  return isUnassigned(group) ? `Assign a published version to ${group.name}` : `Edit ${group.name}`;
}

/**
 * What the submit sends, or why it is disabled: the name is trimmed; a name
 * the contract refuses is checked at submit, not here. A create always sends
 * a version: it has no choice, so `choice` is not read for it. `mounts`
 * (their paths trimmed) are sent as `annotations` only when they differ from
 * the group's (none for a create), merged into the annotations it was read
 * with; their rules are checked at submit. `variableGroupId` (null for none)
 * is sent only when it differs from the group's (a create: only one chosen);
 * it defaults to the group's, no change.
 */
export function requestOf(
  group: CollectorGroup | null,
  name: string,
  choice: AssignmentChoice,
  configurationId: string | null,
  versionId: string | null,
  mounts: readonly DockerMount[] = [],
  variableGroupId: string | null = group?.variableGroupId ?? null,
):
  | { kind: "disabled" }
  | { kind: "create"; body: CreateCollectorGroupRequest }
  | { kind: "update"; body: UpdateCollectorGroupRequest } {
  const trimmed = name.trim();
  if (group === null) {
    if (trimmed === "" || versionId === null) return { kind: "disabled" };
    const created: CreateCollectorGroupRequest = { name: trimmed, assignedVersionId: versionId };
    if (mounts.length > 0) created.annotations = annotationsWithDockerMounts(null, mounts);
    if (variableGroupId !== null) created.variableGroupId = variableGroupId;
    return { kind: "create", body: created };
  }
  const body: UpdateCollectorGroupRequest = {};
  if (!group.isDefault && trimmed !== group.name) {
    if (trimmed === "") return { kind: "disabled" };
    body.name = trimmed;
  }
  if (choice === "version") {
    if (versionId === null) {
      // A configuration chosen, its version not yet: incomplete. Nothing picked on an unassigned group: no change.
      if (configurationId !== null) return { kind: "disabled" };
    } else if (versionId !== group.assignedVersion?.versionId) {
      body.assignedVersionId = versionId;
    }
  } else if (choice === "nothing" && !isUnassigned(group)) {
    body.assignedVersionId = null;
  }
  if (!sameMounts(mounts, dockerMountsOf(group.annotations).mounts)) {
    body.annotations = annotationsWithDockerMounts(group.annotations, mounts);
  }
  if (variableGroupId !== group.variableGroupId) body.variableGroupId = variableGroupId;
  if (Object.keys(body).length === 0) return { kind: "disabled" };
  return { kind: "update", body };
}

export interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group to edit or assign; null to create one. */
  group: CollectorGroup | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After a save, a 404 for the group or the fleet, or closing after an unknown outcome: the tab reloads, and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * A 400's problems with the mounts (`fieldProblemsOf`, `mountDetailKey`):
 * each row's field's, and the list's ("annotations"); null for none.
 */
function mountProblemsOfDetails(failure: unknown): MountProblems | null {
  const found = fieldProblemsOf(failure, mountDetailKey);
  const fields: Record<string, string> = {};
  let list: string | null = null;
  for (const [key, message] of Object.entries(found)) {
    if (message === undefined) continue;
    if (key === "annotations") list = message;
    else fields[key] = message;
  }
  return list === null && Object.keys(fields).length === 0 ? null : { fields, list };
}

/**
 * A mounts save's stops before its write: the group's mounts changed since the opening, the new annotations break a
 * rule once merged into the fresh ones, the group gone from the fresh read, or that read failed.
 */
type FreshReadStop =
  | { kind: "mountsChanged" }
  | { kind: "mountProblems"; problems: MountProblems }
  | { kind: "groupGone" }
  | { kind: "readFailed"; error: unknown };

class FreshReadStopped {
  constructor(readonly stop: FreshReadStop) {}
}

/** Whether two annotations hold the same mounts as the dialog shows them: the same rows, or both unreadable. */
function sameShownMounts(a: CollectorGroup["annotations"], b: CollectorGroup["annotations"]): boolean {
  const first = dockerMountsOf(a);
  const second = dockerMountsOf(b);
  return first.readable === second.readable && sameMounts(first.mounts, second.mounts);
}

/** Each opening is a new session: the fields hold the group afresh, with no earlier refusal. */
export function GroupDialog(props: GroupDialogProps) {
  const opening = useOpeningKey(props.open);
  return <GroupSession key={opening} {...props} />;
}

function GroupSession({ open, onOpenChange, group: liveGroup, organizationId, fleetId, onChanged, onCloseAutoFocus }: GroupDialogProps) {
  // The session's baseline is the group as it opened, never the live prop: a parent reading its groups again while
  // the dialog is open (the refusal's own `onChanged`, a poll) must not move what the rows, the request and the
  // mounts-changed check compare against, or a second save would drop another member's mounts.
  const [group] = useState(liveGroup);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const nameId = useId();
  const choiceId = useId();
  const mountsId = useId();
  const variableGroupSelectId = useId();

  const assigned = group?.assignedVersion ?? null;
  const [name, setName] = useState(group?.name ?? "");
  const [choice, setChoice] = useState<AssignmentChoice>(choiceOf(group));
  const [configurationId, setConfigurationId] = useState<string | null>(assigned?.configurationId ?? null);
  const [versionId, setVersionId] = useState<string | null>(assigned?.versionId ?? null);
  // A configuration chosen selects its newest version once its versions are read.
  const [pickNewest, setPickNewest] = useState(false);

  const [saving, setSaving] = useState(false);
  // Reentry guard: a double Enter lands before the state re-renders.
  const savingRef = useRef(false);
  // An answer left the save unknown: closing reloads the tab.
  const outcomeUnknownRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The mounts: the group's as it opened, the disclosure open when it has any.
  const [mountRows, setMountRows] = useState<MountRow[]>(() => dockerMountsOf(group?.annotations).mounts.map((mount) => ({ ...mount })));
  const [mountsOpen, setMountsOpen] = useState(() => {
    const stored = dockerMountsOf(group?.annotations);
    return stored.mounts.length > 0 || !stored.readable;
  });
  const [mountProblems, setMountProblems] = useState<MountProblems>(NO_MOUNT_PROBLEMS);
  const unreadableMounts = !dockerMountsOf(group?.annotations).readable;
  const mounts = mountsOf(mountRows);

  const configurations = usePublishedConfigurations(open, read, organizationId);
  const versions = useConfigurationVersions(read, organizationId, configurationId);
  // The picker's configurations chosen, kept while the choice switches away and back.
  const pickerKept = useConfigurationPickerKept();

  // The variable group: the group's as it opened, else None; the list read at the opening.
  const offeredVariableGroups = useOfferedVariableGroups(open, read, organizationId);
  const [variableGroupChoice, setVariableGroupChoice] = useState<string>(group?.variableGroupId ?? NO_VARIABLE_GROUP_CHOICE);
  const chosenVariableGroupId = variableGroupChoice === NO_VARIABLE_GROUP_CHOICE ? null : variableGroupChoice;
  // "Variables used": the version chosen (none for "Nothing assigned" or a deleted configuration's version).
  const references = useVersionReferences(
    read,
    organizationId,
    choice === "version" ? configurationId : null,
    choice === "version" ? versionId : null,
  );
  // A 422 variables_undefined's names, shown under its words.
  const [undefinedRefused, setUndefinedRefused] = useState<VariablesUndefinedDetails | null>(null);

  // Only a read picks: after a failed read, "Try again"'s answer still preselects the newest.
  if (pickNewest && versions.configurationId === configurationId && versions.status === "read") {
    setPickNewest(false);
    setVersionId(versions.versions[0]?.id ?? null);
  }

  const request = requestOf(group, name, choice, configurationId, versionId, mounts, chosenVariableGroupId);
  const canSubmit = !saving && request.kind !== "disabled";
  const isDefault = group?.isDefault === true;
  // Create and an unassigned group's Assign: the picker alone, no choice offered.
  const pickerAlone = group === null || isUnassigned(group);

  // The version hint only for a version the save would send (an assigned group's Edit opens with none).
  const sendsVersion = choice === "version" && versionId !== null && (group === null || versionId !== group.assignedVersion?.versionId);
  const hint = choice === "nothing" ? HINT_NOTHING : sendsVersion ? HINT_VERSION : null;

  const close = () => {
    if (savingRef.current) return;
    onOpenChange(false);
    // The group may have changed (or been made): the tab reads its groups again.
    if (outcomeUnknownRef.current) onChanged();
  };

  const groupGone = () => {
    toast.error(GROUP_NOT_FOUND_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

  /** A mounts save stopped before its write: nothing was written. */
  const stopped = ({ stop }: FreshReadStopped) => {
    switch (stop.kind) {
      case "mountsChanged":
        setError(MOUNTS_CHANGED_MESSAGE);
        // The tab (and the fleet) read again now, so a reopening shows the mounts as they are.
        onChanged();
        return;
      case "mountProblems":
        setMountProblems(stop.problems);
        setMountsOpen(true);
        return;
      case "groupGone":
        groupGone();
        return;
      case "readFailed": {
        const failure = stop.error;
        // The organization's, the terms', the session's, the group's or the fleet's: as the write's.
        if (
          isOrganizationGone(failure) ||
          isTermsAcceptanceRequired(failure) ||
          isSessionEnded(failure) ||
          isFleetGone(failure) ||
          (failure instanceof ApiError && failure.code === "collector_group_not_found")
        ) {
          refused(failure);
          return;
        }
        // Only a read failed: nothing was written, so no unknown outcome.
        setError(fleetRefusalMessage(failure, SAVE_GROUP_FAILED_MESSAGE));
        return;
      }
    }
  };

  /**
   * A mounts change's annotations: the group read again under the write's hang guard, the mounts merged into its
   * fresh annotations (another member's keys kept), checked again whole; stopped (FreshReadStopped) when the fresh
   * mounts differ from those the dialog opened with, so a mount saved elsewhere meanwhile is never dropped.
   */
  const freshAnnotations = async (sentIn: string, opened: CollectorGroup, signal: AbortSignal) => {
    let groups: CollectorGroup[];
    try {
      ({ groups } = await getCollectorGroups(sentIn, fleetId, { signal }));
    } catch (failure) {
      throw new FreshReadStopped({ kind: "readFailed", error: failure });
    }
    const fresh = groups.find((each) => each.id === opened.id);
    if (fresh === undefined) throw new FreshReadStopped({ kind: "groupGone" });
    if (!sameShownMounts(fresh.annotations, opened.annotations)) throw new FreshReadStopped({ kind: "mountsChanged" });
    const annotations = annotationsWithDockerMounts(fresh.annotations, mounts);
    const problems = mountProblemsOf(mounts, annotations);
    if (hasMountProblems(problems)) throw new FreshReadStopped({ kind: "mountProblems", problems });
    return annotations;
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (failure instanceof ApiError && failure.code === "collector_group_not_found") {
      groupGone();
      return;
    }
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, SAVE_GROUP_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      outcomeUnknownRef.current = true;
      setError(FLEETS_UNAVAILABLE_MESSAGE);
      return;
    }
    if (failure instanceof ApiError && failure.code === "collector_group_name_taken") {
      setProblem(failure.message);
      return;
    }
    const { name: nameProblem } = fleetFieldProblemsOf(failure);
    const mountsRefused = mountProblemsOfDetails(failure);
    if (nameProblem !== undefined || mountsRefused !== null) {
      if (nameProblem !== undefined) setProblem(nameProblem);
      if (mountsRefused !== null) {
        setMountProblems(mountsRefused);
        setMountsOpen(true);
      }
      return;
    }
    // A variable group deleted meanwhile: its words, and the list read again (the choice then reads "no longer listed").
    if (isVariableGroupGone(failure)) offeredVariableGroups.retry();
    setUndefinedRefused(variablesUndefinedOf(failure));
    setError(fleetRefusalMessage(failure, SAVE_GROUP_FAILED_MESSAGE));
  };

  const editMount = (index: number, field: MountField, value: string | boolean) => {
    setMountRows((rows) => rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
    // The field's message goes, and the list's (a count or the bytes the edit may have changed).
    setMountProblems((previous) => {
      const key = mountProblemKey(index, field);
      if (previous.fields[key] === undefined && previous.list === null) return previous;
      const { [key]: _edited, ...fields } = previous.fields;
      return { fields, list: null };
    });
    setError(null);
  };
  const addMount = () => {
    setMountRows((rows) => [...rows, newMountRow()]);
    setMountProblems((previous) => (previous.list === null ? previous : { ...previous, list: null }));
    setError(null);
  };
  // A removal renumbers the rows after it: every message goes.
  const removeMount = (index: number) => {
    setMountRows((rows) => rows.filter((_row, at) => at !== index));
    setMountProblems(NO_MOUNT_PROBLEMS);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || request.kind === "disabled") return;
    const sentName = request.body.name;
    let nameProblem: string | null = null;
    if (sentName !== undefined) {
      const checked = CollectorGroupNameSchema.safeParse(sentName);
      if (!checked.success) nameProblem = checked.error.issues[0]?.message ?? SAVE_GROUP_FAILED_MESSAGE;
    }
    // The mounts' rules, and the whole annotations', only for annotations the request sends.
    const sentAnnotations = request.body.annotations;
    const mountsChecked = sentAnnotations === undefined ? NO_MOUNT_PROBLEMS : mountProblemsOf(mounts, sentAnnotations);
    if (nameProblem !== null || hasMountProblems(mountsChecked)) {
      setError(null);
      if (nameProblem !== null) setProblem(nameProblem);
      setMountProblems(mountsChecked);
      if (hasMountProblems(mountsChecked)) setMountsOpen(true);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setUndefinedRefused(null);
    setProblem(null);
    setMountProblems(NO_MOUNT_PROBLEMS);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      if (request.kind === "create") {
        await createCollectorGroup(sentIn, fleetId, request.body, { signal: guard.signal });
      } else if (group !== null) {
        // A mounts change merges into the group's fresh annotations; a name or version alone reads nothing.
        const body =
          request.body.annotations === undefined
            ? request.body
            : { ...request.body, annotations: await freshAnnotations(sentIn, group, guard.signal) };
        await updateCollectorGroup(sentIn, fleetId, group.id, body, { signal: guard.signal });
      }
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (!isStillCurrent(sentIn)) return;
      if (failure instanceof FreshReadStopped) stopped(failure);
      else refused(failure);
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(request.kind === "create" ? "Group created" : "Group updated");
    onOpenChange(false);
    onChanged();
  };

  const picker = (
    <ConfigurationVersionPicker
      configurations={configurations}
      versions={versions}
      configurationId={configurationId}
      versionId={versionId}
      pinned={assigned}
      groupDefault={null}
      onConfiguration={(value) => {
        setConfigurationId(value);
        setVersionId(null);
        setPickNewest(true);
        setError(null);
        setUndefinedRefused(null);
      }}
      onVersion={(value) => {
        setVersionId(value);
        setError(null);
        setUndefinedRefused(null);
      }}
      disabled={saving}
      kept={pickerKept}
    />
  );
  const hintLine = hint !== null && (
    <p id={`${choiceId}-hint`} className="text-xs text-muted-foreground">
      {hint}
    </p>
  );

  const submitWords = group === null ? "Create" : isUnassigned(group) ? "Assign" : "Save";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
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
            <DialogTitle>{groupDialogTitle(group)}</DialogTitle>
            <DialogDescription>
              {group === null ? CREATE_DESCRIPTION : isDefault ? DEFAULT_DESCRIPTION : EDIT_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>

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
                placeholder="e.g. web-hosts"
                maxLength={COLLECTOR_GROUP_NAME_MAXIMUM_LENGTH}
                readOnly={isDefault}
                autoFocus={!isDefault}
                disabled={saving}
                autoComplete="off"
                aria-invalid={problem !== null || undefined}
                aria-describedby={problem !== null ? `${nameId}-problem` : isDefault ? `${nameId}-hint` : undefined}
              />
              {isDefault && (
                <p id={`${nameId}-hint`} className="text-xs text-muted-foreground">
                  {DEFAULT_NAME_HINT}
                </p>
              )}
              {problem !== null && (
                <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                  {problem}
                </p>
              )}
            </div>

            {pickerAlone ? (
              // Create and an unassigned group's Assign: the picker alone, with no visible heading, a group
              // named (fixed words) and described as the edit's select is.
              <div
                role="group"
                aria-label="Published version"
                aria-describedby={hint !== null ? `${choiceId}-hint` : undefined}
                className="grid gap-2"
              >
                {picker}
                {hintLine}
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor={choiceId}>Published version</Label>
                <Select
                  value={choice}
                  onValueChange={(value) => {
                    if (!isAssignmentChoice(value) || value === choice) return;
                    setChoice(value);
                    setError(null);
                  }}
                  disabled={saving}
                >
                  <SelectTrigger id={choiceId} aria-describedby={hint !== null ? `${choiceId}-hint` : undefined}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="version">{ASSIGNMENT_CHOICE_LABELS.version}</SelectItem>
                    <SelectItem value="nothing">{ASSIGNMENT_CHOICE_LABELS.nothing}</SelectItem>
                    {choiceOf(group) === "orphan" && <SelectItem value="orphan">{ASSIGNMENT_CHOICE_LABELS.orphan}</SelectItem>}
                  </SelectContent>
                </Select>
                {choice === "version" && picker}
                {hintLine}
              </div>
            )}

            <VariablesUsed references={references} assigns={sendsVersion} disabled={saving} />

            <VariableGroupSelect
              id={variableGroupSelectId}
              label={VARIABLE_GROUP_LABEL}
              offered={offeredVariableGroups}
              value={variableGroupChoice}
              fixed={[{ value: NO_VARIABLE_GROUP_CHOICE, label: NO_VARIABLE_GROUP_WORDS }]}
              onChange={(value) => {
                setVariableGroupChoice(value);
                setError(null);
                setUndefinedRefused(null);
              }}
              disabled={saving}
            />

            <div className="grid gap-2">
              <button
                type="button"
                aria-expanded={mountsOpen}
                aria-controls={`${mountsId}-panel`}
                onClick={() => setMountsOpen((open) => !open)}
                disabled={saving}
                className="flex items-center gap-1.5 justify-self-start rounded-sm text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mountsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                )}
                {MOUNTS_DISCLOSURE}
              </button>
              <div id={`${mountsId}-panel`} hidden={!mountsOpen}>
                <MountsEditor
                  rows={mountRows}
                  onEdit={editMount}
                  onAdd={addMount}
                  onRemove={removeMount}
                  problems={mountProblems}
                  unreadable={unreadableMounts}
                  disabled={saving}
                />
              </div>
            </div>

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
                submitWords
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
