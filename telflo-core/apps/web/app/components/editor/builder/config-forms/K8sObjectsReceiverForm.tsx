import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxSetField,
  DESCRIBED_BOX,
  DurationField,
  FormScope,
  MultiValueField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Kubernetes objects receiver's form, over the form's fields. The objects
 * are a sortable list of cards; each card's fields write their own key under
 * `objects.<index>` (`FormScope`), so keys the form doesn't show
 * (`exclude_namespaces`, `initial_delay`) stay.
 *
 * - Dragging a card (pointer or keyboard) moves the object's own lines, its
 *   comments with it (`form.move`). A card's expanded state, and everything
 *   else the card holds (a held namespace row), follows the card: cards are
 *   keyed by a key of their own, moved with them (never staying with the
 *   position), and matched to their objects again after an undo, a redo or
 *   a YAML edit (`useCardKeys`). Cards start collapsed; ids are by index
 *   (`obj-0-name`, sortable `obj-0`), never a value.
 * - Include Initial State is the receiver's top-level
 *   `include_initial_state` (`receiver/k8sobjectsreceiver/config.go:66`);
 *   `K8sObjectsConfig` has no such key (`config.go:43-57`), so a per-object
 *   box would write one the collector refuses. It is one box, at the top of
 *   Watch Options. The collector refuses it while any object pulls
 *   (`config.go:125-127`), and an object with no `mode`, or `mode: ""`,
 *   pulls (`config.go:91-92`), so while one does the box can't be ticked,
 *   with the hint "Can't be used while an object pulls."; a text with it
 *   ticked and an object pulling shows it ticked, and it can be unticked.
 *   An object switched to, or added in, pull mode removes a top-level
 *   `include_initial_state: true` in the same change, with a toast; an
 *   object switched to watch loses its `initial_delay` (refused in watch
 *   mode, `config.go:113-115`), with its toast. Each is one change, one
 *   undo entry.
 * - Add Object appends `{name: pods, mode: pull, interval: 60m}`; switching to
 *   pull clears `exclude_watch_type` and `resource_version`, and writes
 *   `interval: 60m` when the object has none (a person's own interval is
 *   kept); switching to watch removes `interval`. Neither writes `interval`
 *   while a top-level `interval` is set: the object inherits it
 *   (`config.go:101-107`), and a `60m` would override it.
 * - Clearing `exclude_watch_type`, which the collector refuses in pull
 *   mode (`config.go:109-111`), says so in the toast "Removed the
 *   watch-only settings: pull mode can't use them." A `resource_version`
 *   isn't refused in pull mode (`config.go:121-123` refuses it only beside
 *   `storage`); the pull observer lists that exact version on every pull
 *   (`internal/k8sinventory/pull/observer.go:74-76`), and the README calls
 *   it watch-only (`README.md:68`). It is cleared silently.
 * - Add Namespace holds an empty row until something is typed in it
 *   (never writing `""`, every namespace). A card's namespaces reorder by
 *   drag.
 * - A resource name outside the 16 (a CRD, which the collector resolves by
 *   discovery) shows as an extra option, as written, never a blank select.
 *   Unset shows the collector's default: Authentication Type
 *   `serviceAccount`, Error Mode `propagate` (`factory.go:30-39`),
 *   Collection Mode `pull` (`config.go:26, 91-92`), and Pull Interval the
 *   top-level `interval` when set (in the hint only: it is the text's, so
 *   never a placeholder), else `60m` (`config.go:101-107`,
 *   `defaultPullInterval`). A card's header shows its mode as `pull` while
 *   unset.
 *
 * The adjustment notices are toasts; the standing hint "Can't be used while an
 * object pulls." stays.
 */

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None" },
] as const;

const ERROR_MODES = [
  { value: "propagate", label: "Propagate (fail on error)" },
  { value: "ignore", label: "Ignore (log and continue)" },
  { value: "silent", label: "Silent (suppress errors)" },
] as const;

const K8S_RESOURCE_TYPES = [
  "pods",
  "events",
  "nodes",
  "deployments",
  "services",
  "configmaps",
  "secrets",
  "daemonsets",
  "replicasets",
  "statefulsets",
  "jobs",
  "cronjobs",
  "namespaces",
  "persistentvolumes",
  "persistentvolumeclaims",
  "ingresses",
].map((type) => ({ value: type, label: type }));

const MODES = [
  { value: "pull", label: "Pull" },
  { value: "watch", label: "Watch" },
] as const;

const WATCH_EVENT_TYPES = ["ADDED", "MODIFIED", "DELETED", "BOOKMARK", "ERROR"].map((type) => ({ value: type, label: type }));

/** The collector's mode for an object with none (`config.go:26, 91-92`). */
const DEFAULT_MODE = "pull";

/** The pull interval, written by Add Object and the switch to pull. */
const PULL_INTERVAL = "60m";

export const REMOVED_INITIAL_STATE = "Removed include_initial_state: it can't be used with pull mode.";
export const REMOVED_INITIAL_DELAY = "Removed initial_delay: it can't be used with watch mode.";
export const INITIAL_STATE_PULL_HINT = "Can't be used while an object pulls.";
export const REMOVED_WATCH_SETTINGS = "Removed the watch-only settings: pull mode can't use them.";

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/** An object's mode as the collector reads it: its own, or pull while unset or empty; null if it can't be told. */
function modeOf(form: FormSource, index: number): string | null {
  if (form.read(["objects", index]).kind !== "map") return null;
  const mode = form.read(["objects", index, "mode"]);
  // config.go:91-92: an empty mode (unset or `""`) is pull.
  if (mode.kind === "absent" || (mode.kind === "scalar" && mode.value === "")) return DEFAULT_MODE;
  return mode.kind === "scalar" ? textOf(mode) : null;
}

/** Whether the top-level `include_initial_state` is `true`, which a pulling object makes the collector refuse. */
function initialStateOn(form: FormSource): boolean {
  const view = form.read(["include_initial_state"]);
  return view.kind === "scalar" && view.value === true;
}

export function K8sObjectsReceiverForm() {
  const form = useForm();
  const adjustments = useAdjustments();
  const objectsView = form.read(["objects"]);
  const count = objectsView.kind === "list" ? objectsView.value.length : 0;
  const cards = useCardKeys(objectsView.kind === "list" ? objectsView.value : []);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const modes = Array.from({ length: count }, (_m, index) => modeOf(form, index));
  const anyPull = modes.includes(DEFAULT_MODE);
  const watchObjects = modes.flatMap((mode, index) => (mode === "watch" ? [index] : []));
  const objectsShowable = objectsView.kind === "list" || objectsView.kind === "absent";

  // config.go:101-107: an object with no interval inherits the top-level one.
  const inheritsInterval = form.read(["interval"]).kind !== "absent";

  const addObject = () => {
    const removesInitialState = initialStateOn(form);
    const seed = inheritsInterval ? { name: "pods", mode: "pull" } : { name: "pods", mode: "pull", interval: PULL_INTERVAL };
    const changes: ValueChange[] = [{ path: ["objects", count], value: seed }];
    if (removesInitialState) changes.push({ path: ["include_initial_state"], remove: true });
    const result = form.apply(changes);
    if (result === "written") cards.add();
    if (removesInitialState) adjustments.note([REMOVED_INITIAL_STATE], result);
  };

  const removeObject = (index: number) => {
    if (form.remove(["objects", index]) === "written") cards.remove(index);
  };

  const moveObject = (from: number, to: number) => {
    if (form.move(["objects"], from, to) === "written") cards.move(from, to);
  };

  /** The mode switch, with its adjustments, as one change. */
  const switchMode = (index: number, next: string) => {
    const has = (key: string) => form.read(["objects", index, key]).kind !== "absent";
    const item = (key: string) => ["objects", index, key];
    const changes: ValueChange[] = [{ path: item("mode"), value: next }];
    const messages: string[] = [];
    if (next === "watch") {
      if (has("interval")) changes.push({ path: item("interval"), remove: true });
      if (has("initial_delay")) {
        changes.push({ path: item("initial_delay"), remove: true });
        messages.push(REMOVED_INITIAL_DELAY);
      }
    } else {
      if (has("exclude_watch_type")) {
        changes.push({ path: item("exclude_watch_type"), remove: true });
        messages.push(REMOVED_WATCH_SETTINGS);
      }
      if (has("resource_version")) changes.push({ path: item("resource_version"), remove: true });
      if (!has("interval") && !inheritsInterval) changes.push({ path: item("interval"), value: PULL_INTERVAL });
      if (initialStateOn(form)) {
        changes.push({ path: ["include_initial_state"], remove: true });
        messages.push(REMOVED_INITIAL_STATE);
      }
    }
    const result = form.apply(changes);
    if (messages.length > 0) adjustments.note(messages, result);
  };

  const toggleExpanded = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  // The top-level interval is the text's: it shows in the hint, as text, never in the placeholder.
  const topInterval = form.read(["interval"]);
  const pullDefault = topInterval.kind === "scalar" ? { defaultValue: textOf(topInterval), placeholder: "" } : { defaultValue: PULL_INTERVAL };

  return (
    <div className="space-y-4">
      <SelectField
        path={["auth_type"]}
        id="auth-type"
        label="Authentication Type"
        defaultValue="serviceAccount"
        options={AUTH_TYPES}
      />

      <SelectField
        path={["error_mode"]}
        id="error-mode"
        label="Error Mode"
        defaultValue="propagate"
        description="How to handle missing or inaccessible resources."
        options={ERROR_MODES}
      />

      <ConfigSection title="Objects" defaultOpen count={count}>
        <p className="text-xs text-muted-foreground">At least one object is required.</p>

        {!objectsShowable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <SortableList list="obj" items={cards.keys} onReorder={moveObject} listClassName="space-y-3" contextId="k8s-objects">
            {(key, index, id) => (
              <SortableItem key={key} id={id} disabled={form.disabled}>
                {({ isDragging, dragHandleProps }) => (
                  <div className={`border border-border rounded-md p-2.5 space-y-2 ${isDragging ? "shadow-lg ring-2 ring-ring" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <SortableHandle {...dragHandleProps} disabled={form.disabled} />
                        <button
                          type="button"
                          onClick={() => toggleExpanded(key)}
                          className="flex items-center gap-2 text-sm font-medium hover:text-brand"
                        >
                          {expanded.has(key) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          {`Object #${index + 1}: ${textOf(form.read(["objects", index, "name"]))} (${modes[index] ?? ""})`}
                        </button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove object"
                        onClick={() => removeObject(index)}
                        disabled={form.disabled}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {expanded.has(key) && (
                      <FormScope path={["objects", index]}>
                        <ObjectFields
                          index={index}
                          mode={modes[index] ?? null}
                          pullDefault={pullDefault}
                          onSwitchMode={(next) => switchMode(index, next)}
                        />
                      </FormScope>
                    )}
                  </div>
                )}
              </SortableItem>
            )}
          </SortableList>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={addObject}
          disabled={form.disabled || !objectsShowable}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Object
        </Button>
      </ConfigSection>

      <ConfigSection title="Watch Options" count={watchObjects.length}>
        <IncludeInitialState canTick={objectsShowable && !anyPull} anyPull={anyPull} />

        {watchObjects.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No objects in watch mode. Set an object's Collection Mode to Watch in the Objects section.
          </p>
        )}

        {watchObjects.map((index) => (
          <div key={index} className="border border-border rounded-md p-2.5 space-y-2">
            <h4 className="text-sm font-medium">
              Object #{index + 1}: {textOf(form.read(["objects", index, "name"]))}
            </h4>
            <FormScope path={["objects", index]}>
              <CheckboxSetField
                path={["exclude_watch_type"]}
                id={`obj-${index}-exclude`}
                label="Exclude Watch Event Types"
                items={WATCH_EVENT_TYPES}
              />
              <TextField
                path={["resource_version"]}
                id={`obj-${index}-resource-version`}
                label="Resource Version"
                description="Start watching from this resource version."
                placeholder="e.g. 12345"
              />
            </FormScope>
          </div>
        ))}
      </ConfigSection>

      <ConfigSection title="Deployment & RBAC">
        <TextField
          path={["k8s_leader_elector"]}
          id="leader-elector"
          label="Leader Elector Extension"
          description="Only the elected replica collects."
          placeholder="e.g. k8s_leader_elector"
        />

        <InlineAlert variant="warn" title="Single instance">
          Deploy one replica to avoid duplicate collection, or configure leader election.
        </InlineAlert>

        <InlineAlert variant="info" title="RBAC permissions">
          Needs a ClusterRole with the <span className="font-mono">get</span>, <span className="font-mono">list</span>,
          and <span className="font-mono">watch</span> verbs for each configured resource type.
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}

/**
 * The receiver's top-level `include_initial_state`: ticking it is disabled
 * while an object pulls; ticked, it can always be unticked (written `false`).
 */
function IncludeInitialState({ canTick, anyPull }: { canTick: boolean; anyPull: boolean }) {
  const form = useForm();
  const view = form.read(["include_initial_state"]);
  const checked = view.kind === "absent" ? false : view.kind === "scalar" && typeof view.value === "boolean" ? view.value : null;
  return (
    <div className="space-y-1">
      <div className="flex items-start space-x-3">
        <Checkbox
          id="include-initial-state"
          className={DESCRIBED_BOX}
          checked={checked ?? false}
          onCheckedChange={(next) => {
            if (checked === null || (next === true) === checked) return;
            form.set(["include_initial_state"], next === true);
          }}
          disabled={form.disabled || checked === null || (!checked && !canTick)}
        />
        <div className="grid gap-1.5 leading-none">
          <Label htmlFor="include-initial-state" className="text-sm font-medium cursor-pointer">
            Include Initial State
          </Label>
          <p className="text-[11px] text-muted-foreground">Send a snapshot before streaming watch events.</p>
          {anyPull && <p className="text-[11px] text-muted-foreground">{INITIAL_STATE_PULL_HINT}</p>}
          {checked === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
        </div>
      </div>
    </div>
  );
}

/** An object card's fields, under `objects.<index>`. */
function ObjectFields({
  index,
  mode,
  pullDefault,
  onSwitchMode,
}: {
  index: number;
  /** The object's mode as the collector reads it (pull while unset); null if it can't be told. */
  mode: string | null;
  /** The Pull Interval's default: the top-level interval (shown in the hint only), else 60m. */
  pullDefault: { defaultValue: string; placeholder?: string };
  onSwitchMode: (next: string) => void;
}) {
  const form = useForm();
  if (form.read([]).kind !== "map") {
    return (
      <div className="space-y-2 pt-2 border-t">
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2 pt-2 border-t">
      <div className="grid grid-cols-2 gap-2">
        <SelectField path={["name"]} id={`obj-${index}-name`} label="Resource Type" options={K8S_RESOURCE_TYPES} />
        <SelectField
          path={["mode"]}
          id={`obj-${index}-mode`}
          label="Collection Mode"
          defaultValue={DEFAULT_MODE}
          options={MODES}
          onSelect={onSwitchMode}
        />
      </div>

      {mode === "pull" && (
        <DurationField path={["interval"]} id={`obj-${index}-interval`} label="Pull Interval" {...pullDefault} />
      )}

      <ConfigField label="Namespaces" description="All namespaces when empty.">
        <MultiValueField
          path={["namespaces"]}
          placeholder="e.g. default"
          addButtonText="Add Namespace"
          removeLabel="Remove namespace"
          holdEmpty
          vaultAware
          sortable={{ list: "ns", contextId: `k8s-obj-${index}-namespaces` }}
        />
      </ConfigField>

      <TextField
        path={["label_selector"]}
        id={`obj-${index}-label-selector`}
        label="Label Selector"
        description="Only collect objects matching these labels."
        placeholder="e.g. environment=production"
      />

      <TextField
        path={["field_selector"]}
        id={`obj-${index}-field-selector`}
        label="Field Selector"
        description="Only collect objects matching these fields."
        placeholder="e.g. status.phase=Running"
      />

      <TextField
        path={["group"]}
        id={`obj-${index}-group`}
        label="API Group"
        description="Set when the resource exists in multiple API groups."
        placeholder="e.g. events.k8s.io"
      />

      {mode === "watch" && (
        <p className="text-[11px] text-muted-foreground">Watch options for this object are in the Watch Options section below.</p>
      )}
    </div>
  );
}
