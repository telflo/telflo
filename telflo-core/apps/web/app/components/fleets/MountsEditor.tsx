import { useEffect, useId, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  CollectorGroupAnnotationsSchema,
  DOCKER_MOUNT_PATH_MAXIMUM_LENGTH,
  DOCKER_MOUNTS_MAXIMUM,
  DockerMountsSchema,
  TELFLO_ANNOTATIONS_KEY,
  type DockerMount,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";

/*
 * A server group's mounts (D17c-1 decisions 31 and 32; Preflight rulings 15
 * and 30; ADR 0018) for the group dialog, each mount a `-v` line of the
 * group's container install command. Per the D17c-1 Parity Notes:
 *
 * - Rows of plain fields, not collapsible sections: Host path (placeholder
 *   /var/log/nginx), Container path, Read-only (a labelled Checkbox, ticked
 *   for a new mount), and "Remove mount {n}", named by the row's number,
 *   never the mount's paths. No `hostPathType` (`docker run -v` has none), no
 *   suggestions list, no host path mirrored into the container path, no
 *   read-write or risky-path warnings.
 * - The rules and their words are the contracts' (`DockerMountsSchema`,
 *   `CollectorGroupAnnotationsSchema`): checked when the dialog submits,
 *   each field's message under it (`problems`, keyed "{index}.{field}"),
 *   the list's own (at most 32, the annotations' bytes) under the rows.
 * - Privacy (decision 48): mount paths are configuration text. The rows sit
 *   inside `ph-no-capture`; a path is never in an attribute but an input's
 *   `value` (React writes a controlled input's), inside it: the ids are
 *   `useId`'s and the row's index, the Remove button is named by its index,
 *   and the placeholder is fixed.
 */

/** A mount as the editor holds it: its paths as typed. */
export interface MountRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export type MountField = keyof MountRow;

/** The hint under the rows (decision 32). */
export const MOUNTS_HINT_BEFORE = "Each mount is a ";
export const MOUNTS_HINT_AFTER = " line in this group's container install command. Linux installs read the host's files directly.";
export const MOUNTS_HINT = `${MOUNTS_HINT_BEFORE}-v${MOUNTS_HINT_AFTER}`;

/** What a group whose "telflo" annotation Telflo can't read shows (Preflight ruling 30). */
export const MOUNTS_UNREADABLE = "This group's mounts were saved in a form Telflo can't read. Adding a mount here replaces them.";

export const HOST_PATH_PLACEHOLDER = "/var/log/nginx";

/** Why "Add mount" is disabled at the bound (Ruling 61's nit): shown beside it, and describing it. */
export const MOUNTS_FULL = `A group holds at most ${DOCKER_MOUNTS_MAXIMUM} mounts.`;

/** A new mount's row: empty paths, read-only. */
export function newMountRow(): MountRow {
  return { hostPath: "", containerPath: "", readOnly: true };
}

/** A field's key in `problems`: "{index}.{field}". */
export function mountProblemKey(index: number, field: MountField): string {
  return `${index}.${field}`;
}

/** The rows as they are sent: each path trimmed. */
export function mountsOf(rows: readonly MountRow[]): DockerMount[] {
  return rows.map((row) => ({ hostPath: row.hostPath.trim(), containerPath: row.containerPath.trim(), readOnly: row.readOnly }));
}

/** Whether two lists hold the same mounts in the same order. */
export function sameMounts(a: readonly DockerMount[], b: readonly DockerMount[]): boolean {
  return (
    a.length === b.length &&
    a.every((mount, index) => {
      const other = b[index]!;
      return mount.hostPath === other.hostPath && mount.containerPath === other.containerPath && mount.readOnly === other.readOnly;
    })
  );
}

/** What the editor shows for the mounts a write would send: each field's problem by its key, and the list's own. */
export interface MountProblems {
  fields: Readonly<Record<string, string>>;
  list: string | null;
}

export const NO_MOUNT_PROBLEMS: MountProblems = { fields: {}, list: null };

/** Whether `problems` holds any. */
export function hasMountProblems(problems: MountProblems): boolean {
  return problems.list !== null || Object.keys(problems.fields).length > 0;
}

/**
 * The problems of `mounts` written as `annotations` (the whole object the
 * write would send, `annotationsWithDockerMounts`'s; null for none), in the
 * contracts' words: the mounts' rules first (`DockerMountsSchema`: each
 * path, a container path twice, at most 32), then the whole object's
 * (`CollectorGroupAnnotationsSchema`: its depth and bytes, which another
 * client's keys count toward). The first problem on a field is kept.
 */
export function mountProblemsOf(mounts: readonly DockerMount[], annotations: Record<string, unknown> | null): MountProblems {
  const fields: Record<string, string> = {};
  let list: string | null = null;
  const add = (path: readonly PropertyKey[], message: string) => {
    const [index, field] = path;
    if (typeof index === "number" && (field === "hostPath" || field === "containerPath" || field === "readOnly")) {
      const key = mountProblemKey(index, field);
      fields[key] ??= message;
    } else {
      list ??= message;
    }
  };
  const checked = DockerMountsSchema.safeParse(mounts);
  if (!checked.success) {
    for (const issue of checked.error.issues) add(issue.path, issue.message);
    return { fields, list };
  }
  if (annotations !== null) {
    const whole = CollectorGroupAnnotationsSchema.safeParse(annotations);
    if (!whole.success) {
      for (const issue of whole.error.issues) {
        // A mount's own problem sits under telflo.dockerMounts; any other is the list's.
        const [key, mountsKey, ...rest] = issue.path;
        add(key === TELFLO_ANNOTATIONS_KEY && mountsKey === "dockerMounts" ? rest : [], issue.message);
      }
    }
  }
  return { fields, list };
}

/**
 * A 400's detail path (`fieldProblemsOf`'s) as the editor's key:
 * "annotations.telflo.dockerMounts.{n}.{field}" a row's field, any other
 * path under "annotations" the list's ("annotations"); undefined for the
 * rest.
 */
export function mountDetailKey(path: string): string | undefined {
  const mount = /^annotations\.telflo\.dockerMounts\.(\d+)\.(hostPath|containerPath|readOnly)$/.exec(path);
  if (mount !== null) return `${mount[1]}.${mount[2]}`;
  return path === "annotations" || path.startsWith("annotations.") ? "annotations" : undefined;
}

export interface MountsEditorProps {
  rows: readonly MountRow[];
  onEdit: (index: number, field: MountField, value: string | boolean) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  problems: MountProblems;
  /** The group's "telflo" annotation is one Telflo can't read: no rows were read, and a write replaces it. */
  unreadable: boolean;
  disabled?: boolean;
}

export function MountsEditor({ rows, onEdit, onAdd, onRemove, problems, unreadable, disabled = false }: MountsEditorProps) {
  const idPrefix = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const full = rows.length >= DOCKER_MOUNTS_MAXIMUM;
  // Where the focus goes once the rows have rendered: a new row's Host path, or "Add mount" after a removal.
  const [focusTo, setFocusTo] = useState<"add" | number | null>(null);
  useEffect(() => {
    if (focusTo === null) return;
    setFocusTo(null);
    const to = focusTo === "add" ? addButton.current : document.getElementById(`${idPrefix}-mount-${focusTo}-host`);
    to?.focus();
  }, [focusTo, idPrefix]);

  return (
    <div className="grid gap-2">
      {unreadable && <p className="text-xs text-warn">{MOUNTS_UNREADABLE}</p>}
      <div className="ph-no-capture grid gap-2">
        {rows.map((row, index) => {
          const rowId = `${idPrefix}-mount-${index}`;
          const number = index + 1;
          const problemOf = (field: MountField) => problems.fields[mountProblemKey(index, field)];
          const hostProblem = problemOf("hostPath");
          const containerProblem = problemOf("containerPath");
          const readOnlyProblem = problemOf("readOnly");
          return (
            <fieldset key={index} className="grid gap-2 rounded-md border border-border p-2">
              <legend className="sr-only">Mount {number}</legend>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label htmlFor={`${rowId}-host`} className="text-xs text-muted-foreground">
                    Host path
                  </Label>
                  <Input
                    id={`${rowId}-host`}
                    value={row.hostPath}
                    onChange={(event) => onEdit(index, "hostPath", event.target.value)}
                    placeholder={HOST_PATH_PLACEHOLDER}
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
                  <Label htmlFor={`${rowId}-container`} className="text-xs text-muted-foreground">
                    Container path
                  </Label>
                  <Input
                    id={`${rowId}-container`}
                    value={row.containerPath}
                    onChange={(event) => onEdit(index, "containerPath", event.target.value)}
                    maxLength={DOCKER_MOUNT_PATH_MAXIMUM_LENGTH}
                    className="h-8 font-mono text-xs"
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={containerProblem !== undefined || undefined}
                    aria-describedby={containerProblem !== undefined ? `${rowId}-container-problem` : undefined}
                  />
                  {containerProblem !== undefined && (
                    <p id={`${rowId}-container-problem`} className="text-xs text-fail">
                      {containerProblem}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-7 w-7 text-fail hover:text-fail"
                  aria-label={`Remove mount ${number}`}
                  onClick={() => {
                    onRemove(index);
                    setFocusTo("add");
                  }}
                  disabled={disabled}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
              {readOnlyProblem !== undefined && (
                <p id={`${rowId}-read-only-problem`} className="text-xs text-fail">
                  {readOnlyProblem}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
      {problems.list !== null && <p className="text-xs text-fail">{problems.list}</p>}
      <p className="text-xs text-muted-foreground">
        {MOUNTS_HINT_BEFORE}
        <code className="font-mono">-v</code>
        {MOUNTS_HINT_AFTER}
      </p>
      <div className="flex items-center gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onAdd();
            setFocusTo(rows.length);
          }}
          disabled={disabled || full}
          aria-describedby={full ? `${idPrefix}-mounts-full` : undefined}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add mount
        </Button>
        {full && (
          <p id={`${idPrefix}-mounts-full`} className="text-xs text-muted-foreground">
            {MOUNTS_FULL}
          </p>
        )}
      </div>
    </div>
  );
}
