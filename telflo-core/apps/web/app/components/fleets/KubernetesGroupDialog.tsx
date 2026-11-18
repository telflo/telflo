import { useId, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  annotationsWithKubernetes,
  COLLECTOR_GROUP_CLUSTER_NAME,
  COLLECTOR_GROUP_NAMESPACE_MAXIMUM_LENGTH,
  COLLECTOR_GROUP_REPLICAS_MAXIMUM,
  COLLECTOR_GROUP_REPLICAS_MINIMUM,
  CollectorGroupAnnotationsSchema,
  FLEETS_UNAVAILABLE_MESSAGE,
  gatewayNameProblem,
  KUBERNETES_DEFAULT_NAMESPACE,
  KUBERNETES_GATEWAY_NAME_MAXIMUM_LENGTH,
  KubernetesAnnotationsSchema,
  TELFLO_ANNOTATIONS_KEY,
  type CollectorGroup,
  type CreateCollectorGroupRequest,
  type KubernetesAnnotations,
  type KubernetesRole,
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
import { FLEET_READ_TIMEOUT_MS, FLEET_WRITE_TIMEOUT_MS, fieldProblemsOf, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import {
  gatewayAddress,
  helmUninstallOf,
  KUBERNETES_ROLE_LABELS,
  kubernetesSettingsOf,
  releaseNamespaceOf,
  sameKubernetesSettings,
  sameShownKubernetes,
} from "~/lib/kubernetes-groups.js";
import { NO_VARIABLE_GROUP_WORDS, isVariableGroupGone, variablesUndefinedOf } from "~/lib/variable-group-display.js";
import {
  ConfigurationVersionPicker,
  useConfigurationPickerKept,
  useConfigurationVersions,
  usePublishedConfigurations,
} from "./CollectorPinPicker.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { HelmUninstall } from "./HelmUninstall.js";
import {
  ASSIGNMENT_CHOICE_LABELS,
  choiceOf,
  GROUP_NOT_FOUND_MESSAGE,
  HINT_NOTHING,
  HINT_VERSION,
  NO_VARIABLE_GROUP_CHOICE,
  SAVE_GROUP_FAILED_MESSAGE,
  VARIABLE_GROUP_LABEL,
  type AssignmentChoice,
} from "./GroupDialog.js";
import { isUnassigned } from "./GroupsTable.js";
import { hasMountProblems, NO_MOUNT_PROBLEMS, type MountProblems } from "./MountsEditor.js";
import {
  UndefinedNamesRefused,
  useOfferedVariableGroups,
  useVersionReferences,
  VariableGroupSelect,
  VariablesUsed,
} from "./VariableGroupChoice.js";
import { volumeProblemKey, VolumesEditor, volumesOf, type VolumeField, type VolumeRow } from "./VolumesEditor.js";

/*
 * A Kubernetes fleet's group dialog (D17d-1 decisions 6, 17, 18 and 24;
 * Preflight rulings 11–13, 23, 24 and 31–37; ADR 0018): one Dialog for the
 * Agent, the Cluster and the gateway pools, on D17b-2's `GroupDialog` (its
 * published version picker, refusals, hang guard and sessions; `GroupDialog`
 * itself stays the server fleet's). Per the D17d-1 Parity Notes:
 *
 * - **Titles**: "Add gateway"; `Assign a published version to {Agent |
 *   Cluster | the gateway's name}` for a group with nothing assigned (the
 *   Cluster before its group exists among them); `Edit {…}` otherwise.
 * - **Gateway name** (Add gateway only: no Kubernetes group is renamed,
 *   decision 18), prefilled "gateway", trimmed, checked at submit by
 *   `gatewayNameProblem` (a DNS-1035 label of at most 52 characters, no
 *   reserved name: Preflight ruling 12), a taken name the API's words under
 *   it.
 * - **Published version**: `GroupDialog`'s picker and choice (Rulings 34,
 *   35, 36, 72): a create and an unassigned group's Assign show the picker
 *   alone, a version required for both (the Agent's and a gateway's Assign
 *   as the Cluster's: D17d-1 Ruling 53); an assigned group's Edit offers
 *   "Nothing assigned" too, and "A deleted configuration's version" for
 *   such an assignment. No starter.
 * - **Variable group** and **Variables used** (D20 defaults 23; Q83, Q86;
 *   Preflight ruling 32): `GroupDialog`'s, the same Select ("None
 *   (organization values)" first, the list read at the opening), the same
 *   rule for `variableGroupId` (sent only when it differs from the group's
 *   as it opened; a create only for one chosen; a change alone enables the
 *   save), the same check of the version chosen before Save, and a 422's
 *   names under its words.
 * - **Namespace**, prefilled from the group's settings, else
 *   `telflo-collectors`; **Replicas** (a gateway's only), 1 when none
 *   stored; each trimmed, checked at submit by the contracts' rules
 *   (`KubernetesAnnotationsSchema`), each field's message under it.
 * - A gateway's **address** ("Apps send telemetry to:") from its name and
 *   the namespace as typed.
 * - An Edit whose namespace changes from the one installed into warns that a
 *   Helm release already installed keeps running in the old one, in the order
 *   Helm accepts for the row's role (D18 Ruling 27: the Agent and the Cluster
 *   uninstall first, a gateway after; `namespaceChangeWarning`), with the
 *   quoted `helm uninstall` for the old namespace (D17d-2 decision 4, the
 *   owner's Q54; Preflight ruling 31: the release and the opening's
 *   namespace, in a copy box, shown only while the change is unsaved: the old
 *   namespace is kept nowhere after the save). The old namespace is
 *   `releaseNamespaceOf`'s (D17d-2 Ruling 44): the one saved, or, for the
 *   Agent before its first save, the default its Helm facts installed it into
 *   (`telflo-collectors`). No warning where the Helm facts refuse the group
 *   (Ruling 49: settings Telflo can't read, a stored role not the row's, a
 *   gateway whose name isn't one): nothing was installed from them, so there
 *   is no release to name, and the sentence never shows without its command.
 * - **Volumes** (`VolumesEditor`): the group's hostPath volumes, recipes and
 *   warnings; their problems under each row's field.
 * - **The settings** are written under the annotations' `telflo.kubernetes`
 *   (`annotationsWithKubernetes`: every other key kept, a stray
 *   `dockerMounts` dropped), the role always the row's (`collectorGroupRole`'s:
 *   the Agent `node`, the Cluster `cluster`, a gateway `gateway`), sent when
 *   the fields differ from what they showed at the opening: always for a
 *   create, and with any save of a group with none saved (the Agent's first
 *   save) or with ones Telflo can't read ("…Saving here replaces them."),
 *   whose fields start from the defaults. Such a group's stored settings
 *   already differ from what the dialog shows (the defaults stand in), so
 *   its Edit opens with Save enabled and saves the settings shown (Ruling
 *   58); its Assign, while nothing is assigned, still takes a version.
 *   Saved settings the fields can't show as stored (a gateway's without
 *   replicas, a stored role not the row's) open as the fields show them,
 *   unchanged: they enable no save by
 *   themselves, and a version save alone leaves them; the next save that
 *   changes a field writes the row's role and the replicas shown (Ruling 53:
 *   a submit is enabled only by a change from what the dialog showed).
 * - **The Cluster's Assign** before its group exists is one `POST` named
 *   `cluster` with its version and settings (Preflight ruling 31). A `409
 *   collector_group_name_taken` (another member set it up meanwhile, or a
 *   retry after an unknown outcome made it) says "The Cluster was set up
 *   meanwhile: close and reopen to see it.", reads the tab again, and keeps
 *   the submit disabled: never retried as a `PATCH` (D17c-1 Ruling 61's
 *   principle). Add gateway is one `POST` too. Every other save is one
 *   `PATCH` of what changed (`assignedVersionId`, `annotations`), never a
 *   `name`.
 * - **An Edit changing the settings** reads the group again under the
 *   write's hang guard and merges into its fresh annotations; when the
 *   settings changed since the opening (another member saved meanwhile) the
 *   save is refused, "This group's settings changed since you opened it:
 *   close and reopen to see them.", nothing sent, and the tab reads its
 *   groups again (Preflight ruling 32; D17c-1 Rulings 61 and 64). A version
 *   save alone reads nothing.
 * - Refusals as `GroupDialog`'s: inline (`DialogErrorAlert`), "Group not
 *   found" and the fleet's 404 toasted, closed and reloaded, an unknown
 *   outcome's 503 words kept open (closing then reloads), the organization's
 *   or the terms' refusal closing and revalidating, a session ended silent;
 *   a 400's details mapped to the fields (`kubernetesDetailKey`), one at the
 *   settings themselves or their role (no field shows either) the form's
 *   alert (Ruling 53).
 * - The session's baseline (the fields, the title, what the request and the
 *   settings-changed check compare against, the fields' values that a
 *   change is judged against) is the row as it opened, a
 *   snapshot, never the live prop (D17c-1 Ruling 66): a poll or a reload
 *   landing while the dialog is open changes nothing in it.
 *
 * Privacy (D17d-1's paragraph of ADR 0024): a namespace, a gateway's name,
 * a volume's paths and a gateway's address are configuration text. Their
 * fields, the address, the namespace warning and the volumes sit inside
 * `ph-no-capture`; each is in no attribute but its own input's `value`
 * (React writes a controlled input's), inside it; ids are `useId`'s, the
 * placeholders fixed, every Select's values ids or fixed words.
 */

export const ADD_GATEWAY_TITLE = "Add gateway";
export const ADD_GATEWAY_DESCRIPTION =
  "Create a named gateway pool and give it a published version. Its name can't change later: its Helm release is named after it.";
export const EDIT_KUBERNETES_DESCRIPTION =
  "Change the group's published version, variable group, namespace or volumes. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.";
export const EDIT_GATEWAY_DESCRIPTION =
  "Change the group's published version, variable group, namespace, replicas or volumes. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.";

/** A Kubernetes group's settings Telflo can't read (Preflight ruling 32). */
export const KUBERNETES_UNREADABLE = "This group's Kubernetes settings were saved in a form Telflo can't read. Saving here replaces them.";
/** A settings save refused because another member saved the group's settings since the opening (Preflight ruling 32). */
export const SETTINGS_CHANGED_MESSAGE = "This group's settings changed since you opened it: close and reopen to see them.";
/** The Cluster's create answered `collector_group_name_taken` (Preflight ruling 31). */
export const CLUSTER_SET_UP_MEANWHILE = "The Cluster was set up meanwhile: close and reopen to see it.";

export const GATEWAY_NAME_PREFILL = "gateway";
export const GATEWAY_NAME_PLACEHOLDER = "traces-sampling";
export const GATEWAY_ADDRESS_LABEL = "Apps send telemetry to:";

/**
 * An Edit's namespace change (decision 24): the namespace installed into and
 * the new one, by the row's role (D18 Ruling 27). The Agent's and the
 * Cluster's release owns their cluster-scoped ClusterRole and binding, so
 * Helm refuses an install into the new namespace while it exists: uninstall
 * first. The Agent's state is the node's hostPath named by the fullname
 * (neither names the namespace), so its collectors stay the same; the
 * Cluster's is its StatefulSet's volume claim in the old namespace, which the
 * uninstall leaves behind, so it enrolls again. A gateway owns nothing
 * outside its namespace: install into the new one, then uninstall; its new
 * pods enroll as new collectors (D18 Ruling 42: each role's warning says what
 * happens to its collectors).
 */
export function namespaceChangeWarning(role: KubernetesRole, from: string, to: string): string {
  const running = `A Helm release already installed keeps running in ${from}`;
  if (role === "gateway") return `${running}: uninstall it there after installing into ${to}. Its pods come back in ${to} as new collectors (the old ones go offline).`;
  const label = KUBERNETES_ROLE_LABELS[role];
  const state =
    role === "node"
      ? "The Agent's state is kept on each node, outside any namespace, so its collectors stay the same."
      : `The Cluster's state stays on its volume in ${from}, so in ${to} it enrolls again as a new collector (the old one goes offline).`;
  return `${running}: uninstall it there first, then install into ${to}. Helm refuses the new install while that release exists: it owns the ${label}'s cluster-wide role. ${state}`;
}

/** The row the dialog opens for: its role, and its group (null: the Cluster before its group exists, or Add gateway). */
export interface KubernetesGroupTarget {
  role: KubernetesRole;
  group: CollectorGroup | null;
}

/** The dialog's title (decision 24). */
export function kubernetesGroupDialogTitle({ role, group }: KubernetesGroupTarget): string {
  if (role === "gateway" && group === null) return ADD_GATEWAY_TITLE;
  const label = role === "gateway" && group !== null ? group.name : KUBERNETES_ROLE_LABELS[role];
  return group === null || isUnassigned(group) ? `Assign a published version to ${label}` : `Edit ${label}`;
}

/** A replicas field as typed: a whole number, else NaN (the contract's words refuse it at submit). */
export function replicasOf(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** What the settings fields show for a field's problem: each field's, and the volumes' (rows and list). */
export interface SettingsProblems {
  name: string | null;
  namespace: string | null;
  replicas: string | null;
  volumes: MountProblems;
}

export const NO_SETTINGS_PROBLEMS: SettingsProblems = { name: null, namespace: null, replicas: null, volumes: NO_MOUNT_PROBLEMS };

export function hasSettingsProblems(problems: SettingsProblems): boolean {
  return problems.name !== null || problems.namespace !== null || problems.replicas !== null || hasMountProblems(problems.volumes);
}

const VOLUME_FIELDS: readonly string[] = ["hostPath", "hostPathType", "mountPath", "readOnly"] satisfies VolumeField[];

/** Collects problems by the settings' paths (relative to `telflo.kubernetes`), the first on each field kept; any other path is the volumes list's. */
function problemCollector() {
  let namespace: string | null = null;
  let replicas: string | null = null;
  let list: string | null = null;
  const fields: Record<string, string> = {};
  return {
    add(path: readonly PropertyKey[], message: string) {
      const [first, index, field] = path;
      if (path.length === 1 && first === "namespace") namespace ??= message;
      else if (path.length === 1 && first === "replicas") replicas ??= message;
      else if (first === "volumes" && typeof index === "number" && typeof field === "string" && VOLUME_FIELDS.includes(field)) {
        const key = volumeProblemKey(index, field as VolumeField);
        fields[key] ??= message;
      } else list ??= message;
    },
    done(): SettingsProblems {
      return { name: null, namespace, replicas, volumes: { fields, list } };
    },
  };
}

/**
 * The problems of `settings` written as `annotations` (the whole object the
 * write would send, `annotationsWithKubernetes`'s), in the contracts' words:
 * the settings' rules first (`KubernetesAnnotationsSchema`: the namespace,
 * the replicas, each volume, a mount path twice or naming another's volume,
 * the Agent's own log path, at most 32), then the whole object's
 * (`CollectorGroupAnnotationsSchema`: its depth and bytes, which another
 * client's keys count toward), the volumes list's.
 */
export function settingsProblemsOf(settings: KubernetesAnnotations, annotations: Record<string, unknown> | null): SettingsProblems {
  const collected = problemCollector();
  const checked = KubernetesAnnotationsSchema.safeParse(settings);
  if (!checked.success) {
    for (const issue of checked.error.issues) collected.add(issue.path, issue.message);
    return collected.done();
  }
  if (annotations !== null) {
    const whole = CollectorGroupAnnotationsSchema.safeParse(annotations);
    if (!whole.success) {
      for (const issue of whole.error.issues) {
        const [key, kubernetesKey, ...rest] = issue.path;
        collected.add(key === TELFLO_ANNOTATIONS_KEY && kubernetesKey === "kubernetes" ? rest : [], issue.message);
      }
    }
  }
  return collected.done();
}

/** The detail key of a problem no field shows: the settings themselves, or their role (the form's alert). */
export const FORM_DETAIL_KEY = "form";

/**
 * A 400's detail path (`fieldProblemsOf`'s) as the dialog's key: "name";
 * "namespace" and "replicas" under `annotations.telflo.kubernetes`; a
 * volume's field "{n}.{field}"; the settings themselves or their role
 * (`FORM_DETAIL_KEY`: "Kubernetes settings are required.", a role refused);
 * any other path under "annotations" the volumes list's ("annotations");
 * undefined for the rest.
 */
export function kubernetesDetailKey(path: string): string | undefined {
  if (path === "name") return "name";
  if (path === "annotations.telflo.kubernetes" || path === "annotations.telflo.kubernetes.role") return FORM_DETAIL_KEY;
  const volume = /^annotations\.telflo\.kubernetes\.volumes\.(\d+)\.(hostPath|hostPathType|mountPath|readOnly)$/.exec(path);
  if (volume !== null) return `${volume[1]}.${volume[2]}`;
  if (path === "annotations.telflo.kubernetes.namespace") return "namespace";
  if (path === "annotations.telflo.kubernetes.replicas") return "replicas";
  return path === "annotations" || path.startsWith("annotations.") ? "annotations" : undefined;
}

/** A 400's problems with the fields, and the form's (`FORM_DETAIL_KEY`'s), or null for none it names. */
function settingsProblemsOfDetails(failure: unknown): { problems: SettingsProblems; form: string | null } | null {
  const found = fieldProblemsOf(failure, kubernetesDetailKey);
  let named = false;
  const fields: Record<string, string> = {};
  const problems: SettingsProblems = { name: null, namespace: null, replicas: null, volumes: NO_MOUNT_PROBLEMS };
  let list: string | null = null;
  let form: string | null = null;
  for (const [key, message] of Object.entries(found)) {
    if (message === undefined) continue;
    named = true;
    if (key === "name") problems.name = message;
    else if (key === "namespace") problems.namespace = message;
    else if (key === "replicas") problems.replicas = message;
    else if (key === FORM_DETAIL_KEY) form = message;
    else if (key === "annotations") list = message;
    else fields[key] = message;
  }
  return named ? { problems: { ...problems, volumes: { fields, list } }, form } : null;
}

/** A settings save's stops before its write: changed since the opening, a rule broken once merged, the group gone, or the read failed. */
type FreshReadStop =
  | { kind: "settingsChanged" }
  | { kind: "settingsProblems"; problems: SettingsProblems }
  | { kind: "groupGone" }
  | { kind: "readFailed"; error: unknown };

class FreshReadStopped {
  constructor(readonly stop: FreshReadStop) {}
}

function isAssignmentChoice(value: string): value is AssignmentChoice {
  return value === "version" || value === "nothing" || value === "orphan";
}

export interface KubernetesGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row opened (a snapshot is taken at each opening); null renders nothing. */
  target: KubernetesGroupTarget | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After a save, a 404 for the group or the fleet, a refusal that found the groups changed, or closing after an unknown outcome: the tab reloads, and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: the fields hold the row afresh, with no earlier refusal. */
export function KubernetesGroupDialog(props: KubernetesGroupDialogProps) {
  const opening = useOpeningKey(props.open);
  if (props.target === null) return null;
  return <KubernetesGroupSession key={opening} {...props} target={props.target} />;
}

function KubernetesGroupSession({
  open,
  onOpenChange,
  target: liveTarget,
  organizationId,
  fleetId,
  onChanged,
  onCloseAutoFocus,
}: KubernetesGroupDialogProps & { target: KubernetesGroupTarget }) {
  // The session's baseline is the row as it opened, never the live prop (D17c-1 Ruling 66).
  const [target] = useState(liveTarget);
  const { role, group } = target;
  const isAdd = role === "gateway" && group === null;
  const isGateway = role === "gateway";
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const nameId = useId();
  const choiceId = useId();
  const namespaceId = useId();
  const replicasId = useId();
  const variableGroupSelectId = useId();

  const [stored] = useState(() => kubernetesSettingsOf(group));
  // The namespace the group's release was installed into (the Agent's with none saved: the default, Ruling 44) and its
  // release's uninstall there, as the opening found them: the warning's.
  const [installedNamespace] = useState(() => (group === null ? null : releaseNamespaceOf(group)));
  const [savedUninstall] = useState(() => (group === null ? null : helmUninstallOf(group)));
  const saved = stored.kubernetes;
  const assigned = group?.assignedVersion ?? null;
  // The settings fields as they opened: the saved settings, else the defaults (Ruling 53's baseline).
  const [opening] = useState(() => ({
    namespace: saved?.namespace ?? KUBERNETES_DEFAULT_NAMESPACE,
    replicas: String(saved?.replicas ?? COLLECTOR_GROUP_REPLICAS_MINIMUM),
    volumes: (saved?.volumes ?? []).map((volume): VolumeRow => ({ ...volume })),
  }));
  const [name, setName] = useState(GATEWAY_NAME_PREFILL);
  const [namespace, setNamespace] = useState(opening.namespace);
  const [replicas, setReplicas] = useState(opening.replicas);
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>(() => opening.volumes.map((row) => ({ ...row })));
  const [choice, setChoice] = useState<AssignmentChoice>(choiceOf(group));
  const [configurationId, setConfigurationId] = useState<string | null>(assigned?.configurationId ?? null);
  const [versionId, setVersionId] = useState<string | null>(assigned?.versionId ?? null);
  const [pickNewest, setPickNewest] = useState(false);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const outcomeUnknownRef = useRef(false);
  // The Cluster's create found it set up meanwhile: no retry from this session (Preflight ruling 31).
  const [clusterTaken, setClusterTaken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<SettingsProblems>(NO_SETTINGS_PROBLEMS);

  const configurations = usePublishedConfigurations(open, read, organizationId);
  const versions = useConfigurationVersions(read, organizationId, configurationId);
  const pickerKept = useConfigurationPickerKept();
  // The variable group (D20 default 23): the group's as it opened, else None; the list read at the opening.
  const offeredVariableGroups = useOfferedVariableGroups(open, read, organizationId);
  const [variableGroupChoice, setVariableGroupChoice] = useState<string>(group?.variableGroupId ?? NO_VARIABLE_GROUP_CHOICE);
  const chosenVariableGroupId = variableGroupChoice === NO_VARIABLE_GROUP_CHOICE ? null : variableGroupChoice;
  const references = useVersionReferences(
    read,
    organizationId,
    choice === "version" ? configurationId : null,
    choice === "version" ? versionId : null,
  );
  const [undefinedRefused, setUndefinedRefused] = useState<VariablesUndefinedDetails | null>(null);
  if (pickNewest && versions.configurationId === configurationId && versions.status === "read") {
    setPickNewest(false);
    setVersionId(versions.versions[0]?.id ?? null);
  }

  // The settings fields as written (trimmed, the role the row's): the ones they hold, and the ones they opened with.
  const settingsOf = (fields: { namespace: string; replicas: string; volumes: readonly VolumeRow[] }): KubernetesAnnotations => ({
    role,
    namespace: fields.namespace.trim(),
    ...(isGateway ? { replicas: replicasOf(fields.replicas) } : {}),
    volumes: volumesOf(fields.volumes),
  });
  const settings = settingsOf({ namespace, replicas, volumes: volumeRows });
  // Changed only against what the fields showed at the opening (Ruling 53): a gateway saved without replicas, or a
  // stored role not the row's, shows as the fields show it and enables nothing by itself.
  const fieldsChanged = !sameKubernetesSettings(settingsOf(opening), settings);

  const request = ((): { kind: "disabled" } | { kind: "create"; body: CreateCollectorGroupRequest } | { kind: "update"; body: UpdateCollectorGroupRequest } => {
    if (group === null) {
      const sentName = isAdd ? name.trim() : COLLECTOR_GROUP_CLUSTER_NAME;
      if (sentName === "" || versionId === null) return { kind: "disabled" };
      const created: CreateCollectorGroupRequest = { name: sentName, assignedVersionId: versionId, annotations: annotationsWithKubernetes(null, settings) };
      if (chosenVariableGroupId !== null) created.variableGroupId = chosenVariableGroupId;
      return { kind: "create", body: created };
    }
    const body: UpdateCollectorGroupRequest = {};
    if (choice === "version") {
      // An unassigned group's Assign takes a version, as the Cluster's create (Ruling 53).
      if (versionId === null) {
        if (configurationId !== null || isUnassigned(group)) return { kind: "disabled" };
      } else if (versionId !== group.assignedVersion?.versionId) {
        body.assignedVersionId = versionId;
      }
    } else if (choice === "nothing" && !isUnassigned(group)) {
      body.assignedVersionId = null;
    }
    // The settings go with a change of the fields, and from a group whose settings are none or unreadable: the defaults the
    // fields show already differ from what is stored, so saving them is a change (Ruling 58).
    if (fieldsChanged || saved === null) body.annotations = annotationsWithKubernetes(group.annotations, settings);
    if (chosenVariableGroupId !== group.variableGroupId) body.variableGroupId = chosenVariableGroupId;
    return Object.keys(body).length === 0 ? { kind: "disabled" } : { kind: "update", body };
  })();
  const canSubmit = !saving && !clusterTaken && request.kind !== "disabled";
  const pickerAlone = group === null || isUnassigned(group);
  const sendsVersion = choice === "version" && versionId !== null && (group === null || versionId !== group.assignedVersion?.versionId);
  const hint = choice === "nothing" ? HINT_NOTHING : sendsVersion ? HINT_VERSION : null;

  const typedNamespace = namespace.trim();
  // No warning for a group the Helm facts refuse (Ruling 49: no namespace, so no command): the sentence and its
  // `helm uninstall` show together or not at all.
  const namespaceWarning =
    installedNamespace !== null && savedUninstall !== null && typedNamespace !== "" && typedNamespace !== installedNamespace
      ? namespaceChangeWarning(role, installedNamespace, typedNamespace)
      : null;
  const address = isGateway ? gatewayAddress(isAdd ? name : (group?.name ?? ""), namespace) : null;

  const close = () => {
    if (savingRef.current) return;
    onOpenChange(false);
    if (outcomeUnknownRef.current) onChanged();
  };

  const groupGone = () => {
    toast.error(GROUP_NOT_FOUND_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
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
      if (isAdd) {
        setProblems({ ...NO_SETTINGS_PROBLEMS, name: failure.message });
      } else {
        // The Cluster: set up by another member meanwhile, or by this session's earlier try. Never a PATCH.
        setClusterTaken(true);
        setError(CLUSTER_SET_UP_MEANWHILE);
        onChanged();
      }
      return;
    }
    const detailed = settingsProblemsOfDetails(failure);
    if (detailed !== null) {
      setProblems(detailed.problems);
      setError(detailed.form);
      return;
    }
    // A variable group deleted meanwhile: its words, and the list read again (the choice then reads "no longer listed").
    if (isVariableGroupGone(failure)) offeredVariableGroups.retry();
    setUndefinedRefused(variablesUndefinedOf(failure));
    setError(fleetRefusalMessage(failure, SAVE_GROUP_FAILED_MESSAGE));
  };

  const stopped = ({ stop }: FreshReadStopped) => {
    switch (stop.kind) {
      case "settingsChanged":
        setError(SETTINGS_CHANGED_MESSAGE);
        onChanged();
        return;
      case "settingsProblems":
        setProblems(stop.problems);
        return;
      case "groupGone":
        groupGone();
        return;
      case "readFailed": {
        const failure = stop.error;
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
   * A settings change's annotations (Preflight ruling 32): the group read again under the write's hang guard, the
   * settings merged into its fresh annotations, checked again whole; stopped when its settings changed since the opening.
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
    if (!sameShownKubernetes(fresh.annotations, opened.annotations)) throw new FreshReadStopped({ kind: "settingsChanged" });
    const annotations = annotationsWithKubernetes(fresh.annotations, settings);
    const found = settingsProblemsOf(settings, annotations);
    if (hasSettingsProblems(found)) throw new FreshReadStopped({ kind: "settingsProblems", problems: found });
    return annotations;
  };

  const editVolume = (index: number, field: VolumeField, value: string | boolean) => {
    setVolumeRows((rows) => rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
    setProblems((previous) => {
      const key = volumeProblemKey(index, field);
      if (previous.volumes.fields[key] === undefined && previous.volumes.list === null) return previous;
      const { [key]: _edited, ...fields } = previous.volumes.fields;
      return { ...previous, volumes: { fields, list: null } };
    });
    setError(null);
  };
  const addVolume = (row: VolumeRow) => {
    setVolumeRows((rows) => [...rows, row]);
    setProblems((previous) => (previous.volumes.list === null ? previous : { ...previous, volumes: { ...previous.volumes, list: null } }));
    setError(null);
  };
  // A removal renumbers the rows after it: every volume message goes.
  const removeVolume = (index: number) => {
    setVolumeRows((rows) => rows.filter((_row, at) => at !== index));
    setProblems((previous) => ({ ...previous, volumes: NO_MOUNT_PROBLEMS }));
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || clusterTaken || request.kind === "disabled") return;
    // The rules, checked before anything is sent: the gateway's name (Add gateway), and the settings when sent.
    const nameProblem = isAdd ? gatewayNameProblem(name.trim()) : null;
    const sentAnnotations = request.body.annotations;
    const checked = sentAnnotations === undefined ? NO_SETTINGS_PROBLEMS : settingsProblemsOf(settings, sentAnnotations);
    const found: SettingsProblems = { ...checked, name: nameProblem };
    if (hasSettingsProblems(found)) {
      setError(null);
      setProblems(found);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setUndefinedRefused(null);
    setProblems(NO_SETTINGS_PROBLEMS);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      if (request.kind === "create") {
        await createCollectorGroup(sentIn, fleetId, request.body, { signal: guard.signal });
      } else if (group !== null) {
        const body =
          request.body.annotations === undefined ? request.body : { ...request.body, annotations: await freshAnnotations(sentIn, group, guard.signal) };
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
      }}
      onVersion={(value) => {
        setVersionId(value);
        setError(null);
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
  const submitWords = group === null ? (isAdd ? "Create" : "Assign") : isUnassigned(group) ? "Assign" : "Save";
  const description = isAdd ? ADD_GATEWAY_DESCRIPTION : isGateway ? EDIT_GATEWAY_DESCRIPTION : EDIT_KUBERNETES_DESCRIPTION;

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
            <DialogTitle>{kubernetesGroupDialogTitle(target)}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {!stored.readable && <p className="text-xs text-warn">{KUBERNETES_UNREADABLE}</p>}

            {isAdd && (
              <div className="ph-no-capture grid gap-2">
                <Label htmlFor={nameId}>Gateway name</Label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setProblems((previous) => ({ ...previous, name: null }));
                    setError(null);
                  }}
                  placeholder={GATEWAY_NAME_PLACEHOLDER}
                  maxLength={KUBERNETES_GATEWAY_NAME_MAXIMUM_LENGTH}
                  autoFocus
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problems.name !== null || undefined}
                  aria-describedby={problems.name !== null ? `${nameId}-problem` : undefined}
                />
                {problems.name !== null && (
                  <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                    {problems.name}
                  </p>
                )}
              </div>
            )}

            {pickerAlone ? (
              <div role="group" aria-label="Published version" aria-describedby={hint !== null ? `${choiceId}-hint` : undefined} className="grid gap-2">
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
              }}
              disabled={saving}
            />

            <div className="ph-no-capture grid gap-2">
              <Label htmlFor={namespaceId}>Namespace</Label>
              <Input
                id={namespaceId}
                value={namespace}
                onChange={(event) => {
                  setNamespace(event.target.value);
                  setProblems((previous) => ({ ...previous, namespace: null }));
                  setError(null);
                }}
                placeholder={KUBERNETES_DEFAULT_NAMESPACE}
                maxLength={COLLECTOR_GROUP_NAMESPACE_MAXIMUM_LENGTH}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problems.namespace !== null || undefined}
                aria-describedby={
                  [problems.namespace !== null ? `${namespaceId}-problem` : null, namespaceWarning !== null ? `${namespaceId}-warning` : null]
                    .filter((each) => each !== null)
                    .join(" ") || undefined
                }
              />
              {problems.namespace !== null && (
                <p id={`${namespaceId}-problem`} className="text-xs text-fail" role="alert">
                  {problems.namespace}
                </p>
              )}
              {namespaceWarning !== null && (
                <p id={`${namespaceId}-warning`} className="text-xs text-warn">
                  {namespaceWarning}
                </p>
              )}
              {namespaceWarning !== null && savedUninstall !== null && <HelmUninstall commands={[savedUninstall]} />}
            </div>

            {isGateway && (
              <div className="ph-no-capture grid w-40 gap-2">
                <Label htmlFor={replicasId}>Replicas</Label>
                <Input
                  id={replicasId}
                  type="number"
                  inputMode="numeric"
                  min={COLLECTOR_GROUP_REPLICAS_MINIMUM}
                  max={COLLECTOR_GROUP_REPLICAS_MAXIMUM}
                  step={1}
                  value={replicas}
                  onChange={(event) => {
                    setReplicas(event.target.value);
                    setProblems((previous) => ({ ...previous, replicas: null }));
                    setError(null);
                  }}
                  disabled={saving}
                  autoComplete="off"
                  aria-invalid={problems.replicas !== null || undefined}
                  aria-describedby={problems.replicas !== null ? `${replicasId}-problem` : undefined}
                />
                {problems.replicas !== null && (
                  <p id={`${replicasId}-problem`} className="text-xs text-fail" role="alert">
                    {problems.replicas}
                  </p>
                )}
              </div>
            )}

            {address !== null && (
              <div className="ph-no-capture grid gap-1 rounded-md bg-muted p-3 text-xs">
                <span className="text-muted-foreground">{GATEWAY_ADDRESS_LABEL}</span>
                <code className="break-all font-mono">{address.http}</code>
                <code className="break-all font-mono">{address.grpc}</code>
              </div>
            )}

            <VolumesEditor rows={volumeRows} onEdit={editVolume} onAdd={addVolume} onRemove={removeVolume} problems={problems.volumes} role={role} disabled={saving} />

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
