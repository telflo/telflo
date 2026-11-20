import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  DOCKER_MOUNT_PATH_MAXIMUM_LENGTH,
  KUBERNETES_AGENT_LOG_PATH,
  KUBERNETES_HOST_PATH_TYPES,
  KUBERNETES_VOLUMES_MAXIMUM,
  KUBERNETES_VOLUMES_MAXIMUM_MESSAGE,
  type KubernetesHostPathType,
  type KubernetesRole,
  type KubernetesVolume,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { isRiskyHostPath, pathAsRead, volumeRecipesFor, type KubernetesVolumeRecipe } from "~/lib/kubernetes-groups.js";
import type { MountProblems } from "./MountsEditor.js";

/*
 * A Kubernetes group's hostPath volumes on `MountsEditor`'s patterns, for
 * the Kubernetes group dialog, each volume a hostPath mount of the group's
 * Helm release. Its details:
 *
 * - Rows of plain fields, not collapsible sections, each a fieldset "Volume
 *   {n}": Host path, Mount path, Type (Directory, DirectoryOrCreate, File or
 *   Socket; Directory for a new volume), Read-only (ticked for a new
 *   volume), and "Remove volume {n}", named by the row's number (never by
 *   the volume's paths, and no `title`). No host path mirrored into the
 *   mount path (as `MountsEditor`'s).
 * - The recipes (`volumeRecipesFor`) as one-click buttons under the rows,
 *   inside a disclosure "Common Volume Paths" (GroupDialog's Mounts pattern,
 *   a plain button with `aria-expanded` and `aria-controls`, the panel
 *   `hidden` while closed; closed at each opening of the dialog, which mounts
 *   the editor afresh), each adding a row (the path at the same path, its
 *   type, read-only), not a datalist on the Host path: without its harness
 *   example (`/var/log/starfeuds`), and without `/var/log/pods` on the Agent,
 *   which the platform's chart (its volumes named by the path's slug) mounts
 *   there itself. A recipe already mounted (a row's mount path as read,
 *   `pathAsRead`: `/var/log/` is `/var/log`), or a full list, disables it.
 * - On the Agent only, a muted line under the label, always shown: its chart
 *   mounts the node's `/var/log/pods` itself, which no row lists, so the
 *   refusal of a volume there has its reason in view. Fixed words, outside
 *   `ph-no-capture`.
 * - Two warnings, never blocks: a sensitive host path (`isRiskyHostPath`) and
 *   a read-write mount, under the row.
 * - The rules and their words are the contracts' (`KubernetesVolumesSchema`
 *   within `KubernetesAnnotationsSchema`, and the whole annotations'),
 *   checked when the dialog submits, each field's message under it
 *   (`problems`, keyed "{index}.{field}"), the list's own (at most 32, the
 *   annotations' bytes) under the rows; a 400's details map to them.
 * - Privacy: a volume's paths are configuration text. The rows, and the
 *   risky-path warning that repeats a host path, sit inside `ph-no-capture`;
 *   a path is never in an attribute but an input's `value` (React writes a
 *   controlled input's), inside it: the ids are `useId`'s and the row's
 *   index, the Remove button is named by its index, the placeholder is
 *   fixed, and the Type select's values are the four fixed types.
 */

/** A volume as the editor holds it: its paths as typed. */
export interface VolumeRow {
  hostPath: string;
  hostPathType: KubernetesHostPathType;
  mountPath: string;
  readOnly: boolean;
}

export type VolumeField = keyof VolumeRow;

export const VOLUMES_LABEL = "Volumes";

/** The warnings (B's item 17): a sensitive host path, around the path, and a read-write mount. */
export const RISKY_PATH_AFTER = " is a sensitive host path: mounting it can give the collector broad access to the node. Only proceed if you mean to.";
export const READ_WRITE_WARNING = "Read-write host mount: the collector can change files on the node. Prefer read-only for log collection.";

/** The Agent's hint: the node's pod logs its chart always mounts itself (fixed words). */
export const AGENT_LOG_MOUNT_HINT = `The Agent always mounts the node's ${KUBERNETES_AGENT_LOG_PATH} read-only at ${KUBERNETES_AGENT_LOG_PATH}, for pod logs: no volume needed for them.`;

/** The recipes' disclosure, and their group's name (fixed words). */
export const VOLUME_RECIPES_LABEL = "Common Volume Paths";

export const VOLUME_HOST_PATH_PLACEHOLDER = "/var/log/app";

/** A new volume's row: empty paths, a directory, read-only. */
export function newVolumeRow(): VolumeRow {
  return { hostPath: "", hostPathType: "Directory", mountPath: "", readOnly: true };
}

/** A recipe's row: its path at the same path in the collector, its type, read-only. */
export function volumeRowOf(recipe: KubernetesVolumeRecipe): VolumeRow {
  return { hostPath: recipe.path, hostPathType: recipe.hostPathType, mountPath: recipe.path, readOnly: recipe.readOnly };
}

/** A field's key in `problems`: "{index}.{field}". */
export function volumeProblemKey(index: number, field: VolumeField): string {
  return `${index}.${field}`;
}

/** The rows as they are sent: each path trimmed. */
export function volumesOf(rows: readonly VolumeRow[]): KubernetesVolume[] {
  return rows.map((row) => ({ hostPath: row.hostPath.trim(), hostPathType: row.hostPathType, mountPath: row.mountPath.trim(), readOnly: row.readOnly }));
}

function isHostPathType(value: string): value is KubernetesHostPathType {
  return (KUBERNETES_HOST_PATH_TYPES as readonly string[]).includes(value);
}

export interface VolumesEditorProps {
  rows: readonly VolumeRow[];
  onEdit: (index: number, field: VolumeField, value: string | boolean) => void;
  /** A new row: an empty one ("Add volume") or a recipe's. */
  onAdd: (row: VolumeRow) => void;
  onRemove: (index: number) => void;
  problems: MountProblems;
  /** The group's role: the Agent's recipes leave out the path its chart mounts itself, and its hint says so. */
  role: KubernetesRole;
  disabled?: boolean;
}

export function VolumesEditor({ rows, onEdit, onAdd, onRemove, problems, role, disabled = false }: VolumesEditorProps) {
  const idPrefix = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const full = rows.length >= KUBERNETES_VOLUMES_MAXIMUM;
  const recipes = volumeRecipesFor(role);
  const [recipesOpen, setRecipesOpen] = useState(false);
  // Where the focus goes once the rows have rendered: a new row's Host path, or "Add volume" after a removal.
  const [focusTo, setFocusTo] = useState<"add" | number | null>(null);
  useEffect(() => {
    if (focusTo === null) return;
    setFocusTo(null);
    const to = focusTo === "add" ? addButton.current : document.getElementById(`${idPrefix}-volume-${focusTo}-host`);
    to?.focus();
  }, [focusTo, idPrefix]);

  const add = (row: VolumeRow) => {
    onAdd(row);
    setFocusTo(rows.length);
  };

  return (
    <div
      role="group"
      aria-labelledby={`${idPrefix}-label`}
      aria-describedby={role === "node" ? `${idPrefix}-agent-logs` : undefined}
      className="grid gap-2"
    >
      <p id={`${idPrefix}-label`} className="text-sm font-medium leading-none">
        {VOLUMES_LABEL}
      </p>
      {role === "node" && (
        <p id={`${idPrefix}-agent-logs`} className="text-xs text-muted-foreground">
          {AGENT_LOG_MOUNT_HINT}
        </p>
      )}
      <div className="ph-no-capture grid gap-2">
        {rows.map((row, index) => {
          const rowId = `${idPrefix}-volume-${index}`;
          const number = index + 1;
          const problemOf = (field: VolumeField) => problems.fields[volumeProblemKey(index, field)];
          const hostProblem = problemOf("hostPath");
          const mountProblem = problemOf("mountPath");
          const typeProblem = problemOf("hostPathType");
          const readOnlyProblem = problemOf("readOnly");
          const hostPath = row.hostPath.trim();
          return (
            <fieldset key={index} className="grid gap-2 rounded-md border border-border p-2">
              <legend className="sr-only">Volume {number}</legend>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label htmlFor={`${rowId}-host`} className="text-xs text-muted-foreground">
                    Host path
                  </Label>
                  <Input
                    id={`${rowId}-host`}
                    value={row.hostPath}
                    onChange={(event) => onEdit(index, "hostPath", event.target.value)}
                    placeholder={VOLUME_HOST_PATH_PLACEHOLDER}
                    maxLength={DOCKER_MOUNT_PATH_MAXIMUM_LENGTH}
                    className="h-8 font-mono text-xs"
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={hostProblem !== undefined || undefined}
                    aria-describedby={hostProblem !== undefined ? `${rowId}-host-problem` : undefined}
                  />
                  {hostProblem !== undefined && (
                    <p id={`${rowId}-host-problem`} className="text-xs text-fail">
                      {hostProblem}
                    </p>
                  )}
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${rowId}-mount`} className="text-xs text-muted-foreground">
                    Mount path
                  </Label>
                  <Input
                    id={`${rowId}-mount`}
                    value={row.mountPath}
                    onChange={(event) => onEdit(index, "mountPath", event.target.value)}
                    maxLength={DOCKER_MOUNT_PATH_MAXIMUM_LENGTH}
                    className="h-8 font-mono text-xs"
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={mountProblem !== undefined || undefined}
                    aria-describedby={mountProblem !== undefined ? `${rowId}-mount-problem` : undefined}
                  />
                  {mountProblem !== undefined && (
                    <p id={`${rowId}-mount-problem`} className="text-xs text-fail">
                      {mountProblem}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-end gap-4">
                <div className="grid gap-1">
                  <Label htmlFor={`${rowId}-type`} className="text-xs text-muted-foreground">
                    Type
                  </Label>
                  <Select
                    value={row.hostPathType}
                    onValueChange={(value) => {
                      if (isHostPathType(value) && value !== row.hostPathType) onEdit(index, "hostPathType", value);
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      id={`${rowId}-type`}
                      className="h-8 w-48 text-xs"
                      aria-invalid={typeProblem !== undefined || undefined}
                      aria-describedby={typeProblem !== undefined ? `${rowId}-type-problem` : undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KUBERNETES_HOST_PATH_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex h-8 items-center gap-2">
                  <Checkbox
                    id={`${rowId}-read-only`}
                    checked={row.readOnly}
                    onCheckedChange={(checked) => onEdit(index, "readOnly", checked === true)}
                    disabled={disabled}
                    aria-describedby={readOnlyProblem !== undefined ? `${rowId}-read-only-problem` : undefined}
                  />
                  <Label htmlFor={`${rowId}-read-only`} className="cursor-pointer text-xs font-normal">
                    Read-only
                  </Label>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-7 w-7 text-fail hover:text-fail"
                  aria-label={`Remove volume ${number}`}
                  onClick={() => {
                    onRemove(index);
                    setFocusTo("add");
                  }}
                  disabled={disabled}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
              {typeProblem !== undefined && (
                <p id={`${rowId}-type-problem`} className="text-xs text-fail">
                  {typeProblem}
                </p>
              )}
              {readOnlyProblem !== undefined && (
                <p id={`${rowId}-read-only-problem`} className="text-xs text-fail">
                  {readOnlyProblem}
                </p>
              )}
              {!row.readOnly && (
                <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-2 text-xs text-warn">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{READ_WRITE_WARNING}</span>
                </div>
              )}
              {isRiskyHostPath(hostPath) && (
                <div className="flex items-start gap-2 rounded-md border border-fail/25 bg-fail-soft p-2 text-xs text-fail">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    <code className="font-mono">{hostPath}</code>
                    {RISKY_PATH_AFTER}
                  </span>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
      {problems.list !== null && <p className="text-xs text-fail">{problems.list}</p>}
      <div className="flex items-center gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add(newVolumeRow())}
          disabled={disabled || full}
          aria-describedby={full ? `${idPrefix}-volumes-full` : undefined}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add volume
        </Button>
        {full && (
          <p id={`${idPrefix}-volumes-full`} className="text-xs text-muted-foreground">
            {KUBERNETES_VOLUMES_MAXIMUM_MESSAGE}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <button
          id={`${idPrefix}-recipes`}
          type="button"
          aria-expanded={recipesOpen}
          aria-controls={`${idPrefix}-recipes-panel`}
          onClick={() => setRecipesOpen((open) => !open)}
          disabled={disabled}
          className="flex items-center gap-1.5 justify-self-start rounded-sm text-xs font-medium text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {recipesOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          {VOLUME_RECIPES_LABEL}
        </button>
        <div id={`${idPrefix}-recipes-panel`} role="group" aria-labelledby={`${idPrefix}-recipes`} hidden={!recipesOpen}>
          <div className="flex flex-wrap gap-1.5">
            {recipes.map((recipe) => (
              <Button
                key={recipe.path}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto flex-col items-start gap-0 px-2 py-1 text-left"
                onClick={() => add(volumeRowOf(recipe))}
                disabled={disabled || full || rows.some((row) => pathAsRead(row.mountPath) === recipe.path)}
              >
                <span className="font-mono text-xs">{recipe.path}</span>
                <span className="text-[11px] font-normal text-muted-foreground">{recipe.description}</span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
