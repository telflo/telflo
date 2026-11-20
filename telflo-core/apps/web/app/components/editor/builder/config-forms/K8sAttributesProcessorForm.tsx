import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { ConfigSection } from "./ConfigSection.js";
import {
  BareSelectField,
  BareTextField,
  CheckboxField,
  CheckboxSetField,
  DurationField,
  FormScope,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { K8S_ATTRIBUTES_DEFAULT_METADATA } from "./k8s-defaults.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Kubernetes attributes processor's form, over the form's fields: each
 * field writes its own key. Collector paths are
 * `processor/k8sattributesprocessor/` at contrib v0.162.0.
 *
 * - The pod association rules, the custom labels and the custom annotations
 *   are sortable lists of cards written by item: each card's fields write
 *   under `pod_association.<i>` (a rule's sources under `sources.<j>`, a
 *   sortable list of their own), `extract.labels.<i>` or
 *   `extract.annotations.<i>` (`FormScope`), so keys the form doesn't show
 *   stay. Dragging a card moves the item's own lines, its comments with it
 *   (`form.move`); the cards are keyed by keys of their own, so a card's state
 *   (a field's typing) follows it (`useCardKeys`; a rule's sources too); a
 *   rule is never rebuilt as `{sources}` on a change.
 * - "Extract OpenTelemetry Annotations" writes only
 *   `extract.otel_annotations`, never
 *   `extract: {metadata: [], otel_annotations: …}` when `extract` is unset:
 *   an empty list replaces the collector's default metadata
 *   (`factory.go:45-51`).
 * - "Derive Deployment Name from ReplicaSet" isn't shown:
 *   `deployment_name_from_replicaset` isn't a key (`config.go:22-60`; the
 *   collector derives the name anyway) and the collector refuses it. A key
 *   already in the text is left alone.
 * - Add Rule never appends a second `{sources: [{from: connection}]}`, which
 *   the collector refuses ("duplicate pod association", `config.go:74-85`).
 *   It seeds the first of `connection`, `resource_attribute` `k8s.pod.ip` and
 *   `resource_attribute` `k8s.pod.uid` that isn't already a rule, compared by
 *   the collector's key (each source's `from/name`, sorted and joined,
 *   `config.go:152-164`); with all three there it is disabled, with "Every
 *   suggested rule is already here. Add others in the YAML."
 * - Standard Attributes is a checkbox list written by item: unset shows none
 *   ticked, with the collector's default in the hint
 *   (`K8S_ATTRIBUTES_DEFAULT_METADATA`, v0.162.0), and the first tick writes
 *   that item alone. An item outside the 13 (the collector takes 31,
 *   `config.go:106-125`) shows after them, ticked, as text. Ids are
 *   `metadata-<index>`, never the attribute name.
 * - Add Source appends `{from: connection}` while a rule has fewer than
 *   4 sources (`config.go:76-77`); a source's From writes `from` alone; Add
 *   Label and Add Annotation append `{tag_name: "", key: "", from: pod}` (the
 *   collector takes empty ones, `options.go:258-286`); the Key/Regex switch
 *   moves the value between `key` and `key_regex` (renamed in place, so it
 *   keeps its quoting and comment; where the other key is there, both set,
 *   which the collector refuses, `config.go:88-90`, or a null, it takes the
 *   value and the first is removed, in one write). The switch is disabled
 *   while either key holds a value the key field can't show, which it would
 *   otherwise overwrite.
 * - Unset shows the collector's default: Authentication Type `serviceAccount`
 *   (`factory.go:47`), Wait Timeout `10s` (`factory.go:52`), a label's From
 *   `pod` (the placeholder; `options.go:263-265`). A From or source outside
 *   the select's options shows as an extra option (`replicaset` and
 *   `cronjob`, which aren't offered).
 *
 * Ids are fixed per field or by index (`assoc-0`, `assoc-0-src-1`,
 * `label-0`, `annotation-0`, `metadata-3`), never a value.
 */

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None" },
] as const;

const STANDARD_METADATA_OPTIONS = [
  "k8s.namespace.name",
  "k8s.pod.name",
  "k8s.pod.uid",
  "k8s.pod.start_time",
  "k8s.deployment.name",
  "k8s.replicaset.name",
  "k8s.statefulset.name",
  "k8s.daemonset.name",
  "k8s.cronjob.name",
  "k8s.job.name",
  "k8s.node.name",
  "k8s.container.name",
  "k8s.cluster.uid",
].map((option) => ({ value: option, label: option }));

const SOURCE_FROM = [
  { value: "connection", label: "Connection IP" },
  { value: "resource_attribute", label: "Resource Attribute" },
] as const;

const EXTRACT_FROM = [
  { value: "pod", label: "Pod" },
  { value: "namespace", label: "Namespace" },
  { value: "deployment", label: "Deployment" },
  { value: "statefulset", label: "StatefulSet" },
  { value: "daemonset", label: "DaemonSet" },
  { value: "job", label: "Job" },
  { value: "node", label: "Node" },
] as const;

/** The most sources a rule takes (`config.go:76-77`, `kube.PodIdentifierMaxLength`). */
const MAX_SOURCES = 4;

export const ALL_RULES_PRESENT = "Every suggested rule is already here. Add others in the YAML.";

/** The rules Add Rule seeds, in order: connection, then the pod IP and UID resource attributes. */
export const SUGGESTED_RULES: readonly { sources: readonly { from: string; name?: string }[] }[] = [
  { sources: [{ from: "connection" }] },
  { sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] },
  { sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] },
];

/** The collector's key for a rule's sources: each `from/name`, sorted, joined (`config.go:152-164`). */
export function ruleKey(sources: readonly { from: string; name?: string }[]): string {
  return sources
    .map((source) => `${source.from}/${source.name ?? ""}`)
    .sort()
    .join(",");
}

/** A string or scalar's text as the collector would read it, "" when unset; null for anything else. */
function stringOf(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  return view.kind === "scalar" ? String(view.value) : null;
}

/** Whether a one-line field shows `view` (unset, or a scalar on one line), as `BareTextField` does. */
function shownAsText(view: ValueView): boolean {
  if (view.kind === "absent") return true;
  return view.kind === "scalar" && !/[\r\n]/.test(view.source ?? String(view.value));
}

/** The keys of the rules in the text the collector would read; a rule it can't read is skipped. */
function ruleKeys(form: FormSource, count: number): Set<string> {
  const keys = new Set<string>();
  for (let index = 0; index < count; index++) {
    const sources = form.read(["pod_association", index, "sources"]);
    if (sources.kind !== "list" && sources.kind !== "absent") continue;
    const read = (sources.kind === "list" ? sources.value : []).map((_s, j) => {
      const from = stringOf(form.read(["pod_association", index, "sources", j, "from"]));
      const name = stringOf(form.read(["pod_association", index, "sources", j, "name"]));
      return from === null || name === null ? null : { from, name };
    });
    if (read.every((source) => source !== null)) keys.add(ruleKey(read));
  }
  return keys;
}

export function K8sAttributesProcessorForm() {
  const form = useForm();
  const waitView = form.read(["wait_for_metadata"]);
  const waiting = waitView.kind === "scalar" && waitView.value === true;
  const filterCount = (isTruthy(form.read(["filter", "namespace"])) ? 1 : 0) + (isTruthy(form.read(["filter", "node_from_env_var"])) ? 1 : 0);
  const extractionCount =
    listLength(form.read(["extract", "metadata"])) +
    listLength(form.read(["extract", "labels"])) +
    listLength(form.read(["extract", "annotations"]));

  return (
    <div className="space-y-4">
      <SelectField
        path={["auth_type"]}
        id="auth-type"
        label="Authentication Type"
        defaultValue="serviceAccount"
        description="How to authenticate with the Kubernetes API."
        options={AUTH_TYPES}
      />

      <CheckboxField
        path={["passthrough"]}
        id="passthrough"
        label="Passthrough Mode"
        defaultChecked={false}
        description="Attach only the pod IP and leave metadata lookup to a downstream collector."
      />

      <CheckboxField
        path={["wait_for_metadata"]}
        id="wait-for-metadata"
        label="Wait for Metadata"
        defaultChecked={false}
        description="Delay processor readiness until metadata sync completes."
      />

      {waiting && <DurationField path={["wait_for_metadata_timeout"]} id="wait-timeout" label="Wait Timeout" defaultValue="10s" />}

      <ConfigSection title="Filtering" count={filterCount}>
        <TextField
          path={["filter", "namespace"]}
          id="namespace-filter"
          label="Namespace"
          description="Only process pods from this namespace; empty means all."
          placeholder="e.g. default"
        />

        <TextField
          path={["filter", "node_from_env_var"]}
          id="node-filter"
          label="Node"
          description="Environment variable that holds the node name."
          placeholder="e.g. K8S_NODE_NAME"
        />
      </ConfigSection>

      <PodAssociation />

      <ConfigSection title="Metadata Extraction" count={extractionCount}>
        <CheckboxSetField
          path={["extract", "metadata"]}
          id="metadata"
          label="Standard Attributes"
          items={STANDARD_METADATA_OPTIONS}
          defaultHint={K8S_ATTRIBUTES_DEFAULT_METADATA.join(", ")}
          className="border border-border rounded-md p-2.5 space-y-1.5 bg-muted/50"
          labelClassName="text-xs font-mono cursor-pointer"
        />

        <CheckboxField
          path={["extract", "otel_annotations"]}
          id="otel-annotations"
          label="Extract OpenTelemetry Annotations"
          defaultChecked={false}
          description={
            <>
              Maps <span className="font-mono">resource.opentelemetry.io/*</span> pod annotations to resource attributes.
            </>
          }
        />

        <ExtractList kind={LABELS} />
        <ExtractList kind={ANNOTATIONS} />
      </ConfigSection>
    </div>
  );
}

/** The Pod Association section: the rules, each with its sources, and Add Rule. */
function PodAssociation() {
  const form = useForm();
  const view = form.read(["pod_association"]);
  const count = view.kind === "list" ? view.value.length : 0;
  const showable = view.kind === "list" || view.kind === "absent";
  const cards = useCardKeys(view.kind === "list" ? view.value : []);
  const present = ruleKeys(form, count);
  const seed = SUGGESTED_RULES.find((rule) => !present.has(ruleKey(rule.sources)));

  const addRule = () => {
    if (seed === undefined) return;
    if (form.set(["pod_association", count], seed) === "written") cards.add();
  };
  const removeRule = (index: number) => {
    if (form.remove(["pod_association", index]) === "written") cards.remove(index);
  };
  const moveRule = (from: number, to: number) => {
    if (form.move(["pod_association"], from, to) === "written") cards.move(from, to);
  };

  return (
    <ConfigSection title="Pod Association" count={count}>
      <InlineAlert variant="info" title="First match wins">
        Rules run in order until one associates the telemetry with a pod.
      </InlineAlert>

      {!showable ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <SortableList list="assoc" items={cards.keys} onReorder={moveRule} listClassName="space-y-2" contextId="k8s-pod-associations">
          {(key, assocIndex, id) => (
            <SortableItem key={key} id={id} disabled={form.disabled}>
              {({ isDragging, dragHandleProps }) => (
                <div className={`border border-border rounded-md p-2.5 space-y-2 bg-muted/50 ${isDragging ? "shadow-lg ring-2 ring-ring" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <SortableHandle {...dragHandleProps} disabled={form.disabled} />
                      <span className="text-sm font-medium">Rule {assocIndex + 1}</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove rule"
                      onClick={() => removeRule(assocIndex)}
                      disabled={form.disabled}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <FormScope path={["pod_association", assocIndex]}>
                    <RuleSources assocIndex={assocIndex} />
                  </FormScope>
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
        onClick={addRule}
        className="w-full"
        disabled={form.disabled || !showable || seed === undefined}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Rule
      </Button>
      {showable && seed === undefined && <p className="text-[11px] leading-4 text-muted-foreground">{ALL_RULES_PRESENT}</p>}
    </ConfigSection>
  );
}

/** A rule's sources, under `pod_association.<assocIndex>`: a sortable list, and Add Source. */
function RuleSources({ assocIndex }: { assocIndex: number }) {
  const form = useForm();
  const rule = form.read([]);
  const view = form.read(["sources"]);
  // Each source's row is keyed by a key of its own, which follows its source
  // through a move, an undo or the YAML box, so a held edit in its fields is
  // written to its own source.
  const cards = useCardKeys(view.kind === "list" ? view.value : []);
  if ((rule.kind !== "map" && rule.kind !== "absent") || (view.kind !== "list" && view.kind !== "absent")) {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  const count = view.kind === "list" ? view.value.length : 0;
  const addSource = () => {
    if (form.set(["sources", count], { from: "connection" }) === "written") cards.add();
  };
  const removeSource = (index: number) => {
    if (form.remove(["sources", index]) === "written") cards.remove(index);
  };
  const moveSource = (from: number, to: number) => {
    if (form.move(["sources"], from, to) === "written") cards.move(from, to);
  };

  return (
    <>
      <SortableList
        list={`assoc-${assocIndex}-src`}
        items={cards.keys}
        onReorder={moveSource}
        listClassName="space-y-2"
        contextId={`k8s-assoc-${assocIndex}-sources`}
      >
        {(key, sourceIndex, id) => (
          // Keyed by its own key, not its id: a source's row stays its own when the rule moves (the id names the rule's index).
          <SortableItem key={key} id={id} disabled={form.disabled}>
            {({ isDragging, dragHandleProps }) => (
              <div
                className={`space-y-2 pl-3 border-l-2 border-border ${isDragging ? "shadow-lg ring-2 ring-ring rounded-md bg-background" : ""}`}
              >
                <FormScope path={["sources", sourceIndex]}>
                  <SourceFields
                    handle={<SortableHandle {...dragHandleProps} disabled={form.disabled} />}
                    removable={count > 1}
                    onRemove={() => removeSource(sourceIndex)}
                  />
                </FormScope>
              </div>
            )}
          </SortableItem>
        )}
      </SortableList>

      {count < MAX_SOURCES && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addSource}
          className="w-full"
          disabled={form.disabled}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Source
        </Button>
      )}
    </>
  );
}

/** A source's row, under `pod_association.<i>.sources.<j>`. */
function SourceFields({ handle, removable, onRemove }: { handle: ReactNode; removable: boolean; onRemove: () => void }) {
  const form = useForm();
  const from = form.read(["from"]);
  const isResourceAttribute = from.kind === "scalar" && from.value === "resource_attribute";
  return (
    <>
      <div className="flex items-center gap-2">
        {handle}
        {form.read([]).kind === "map" ? (
          <BareSelectField path={["from"]} options={SOURCE_FROM} className="h-8 text-xs" />
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        )}
        {removable && (
          <Button type="button" variant="ghost" size="sm" aria-label="Remove source" onClick={onRemove} disabled={form.disabled}>
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {isResourceAttribute && (
        <div className="ml-6">
          <BareTextField path={["name"]} className="h-8 text-xs" ariaLabel="Resource attribute key" placeholder="e.g. k8s.pod.ip" />
        </div>
      )}
    </>
  );
}

/** The two extract lists' nouns: the labels and annotations cards differ only in these. */
interface ExtractKind {
  path: ValuePath;
  title: string;
  /** The sortable list's fixed name and its dnd context's fixed id. */
  list: string;
  contextId: string;
  tagPlaceholder: string;
  keyLabel: string;
  keyPlaceholder: string;
  regexPlaceholder: string;
  removeLabel: string;
  addLabel: string;
}

const LABELS: ExtractKind = {
  path: ["extract", "labels"],
  title: "Custom Labels",
  list: "label",
  contextId: "k8s-custom-labels",
  tagPlaceholder: "e.g. app.component",
  keyLabel: "Label key",
  keyPlaceholder: "e.g. app.kubernetes.io/component",
  regexPlaceholder: "e.g. app.kubernetes.io/(.*)",
  removeLabel: "Remove label",
  addLabel: "Add Label",
};

const ANNOTATIONS: ExtractKind = {
  path: ["extract", "annotations"],
  title: "Custom Annotations",
  list: "annotation",
  contextId: "k8s-custom-annotations",
  tagPlaceholder: "e.g. app.workload",
  keyLabel: "Annotation key",
  keyPlaceholder: "e.g. prometheus.io/scrape",
  regexPlaceholder: "e.g. prometheus.io/(.*)",
  removeLabel: "Remove annotation",
  addLabel: "Add Annotation",
};

/** Custom Labels or Custom Annotations: a sortable list of cards, and its Add button. */
function ExtractList({ kind }: { kind: ExtractKind }) {
  const form = useForm();
  const view = form.read(kind.path);
  const count = view.kind === "list" ? view.value.length : 0;
  const showable = view.kind === "list" || view.kind === "absent";
  const cards = useCardKeys(view.kind === "list" ? view.value : []);

  const add = () => {
    if (form.set([...kind.path, count], { tag_name: "", key: "", from: "pod" }) === "written") cards.add();
  };
  const remove = (index: number) => {
    if (form.remove([...kind.path, index]) === "written") cards.remove(index);
  };
  const move = (from: number, to: number) => {
    if (form.move(kind.path, from, to) === "written") cards.move(from, to);
  };

  return (
    <div className="space-y-2">
      <Label className="text-[13px] font-medium text-foreground">{kind.title}</Label>
      {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      {count > 0 && (
        <SortableList list={kind.list} items={cards.keys} onReorder={move} listClassName="space-y-2" contextId={kind.contextId}>
          {(key, index, id) => (
            <SortableItem key={key} id={id} disabled={form.disabled}>
              {({ isDragging, dragHandleProps }) => (
                <div className={`border border-border rounded-md p-2.5 space-y-2 bg-muted/50 ${isDragging ? "shadow-lg ring-2 ring-ring" : ""}`}>
                  <FormScope path={[...kind.path, index]}>
                    <ExtractFields
                      kind={kind}
                      handle={<SortableHandle {...dragHandleProps} disabled={form.disabled} />}
                      onRemove={() => remove(index)}
                    />
                  </FormScope>
                </div>
              )}
            </SortableItem>
          )}
        </SortableList>
      )}
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={add} disabled={form.disabled || !showable}>
        <Plus className="h-4 w-4 mr-2" />
        {kind.addLabel}
      </Button>
    </div>
  );
}

/** A label's or an annotation's card, under `extract.labels.<i>` or `extract.annotations.<i>`. */
function ExtractFields({ kind, handle, onRemove }: { kind: ExtractKind; handle: ReactNode; onRemove: () => void }) {
  const form = useForm();
  const removeButton = (
    <Button type="button" variant="ghost" size="sm" aria-label={kind.removeLabel} onClick={onRemove} disabled={form.disabled}>
      <Trash2 className="h-4 w-4" />
    </Button>
  );
  if (form.read([]).kind !== "map") {
    return (
      <div className="flex items-center gap-2">
        {handle}
        <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        {removeButton}
      </div>
    );
  }
  // Regex mode: `key_regex` is there, empty or not.
  const isRegexMode = form.read(["key_regex"]).kind !== "absent";
  // The switch moves one key's value to the other, so it waits while either holds one the key field can't show.
  const switchable = shownAsText(form.read(["key"])) && shownAsText(form.read(["key_regex"]));

  /** The Key/Regex switch: the value moves to the other key, in place where it can. */
  const switchKeyMode = (toRegex: boolean) => {
    const [source, target] = toRegex ? ["key", "key_regex"] : ["key_regex", "key"];
    const moving = form.read([source]);
    // A target written as a null reads as unset but is there: a rename would clash, so it is set.
    const item = form.read([]).value as Record<string, unknown>;
    if (moving.kind === "absent") {
      form.set([target], "");
    } else if (!Object.hasOwn(item, target)) {
      form.rename([source], target);
    } else {
      form.apply([
        { path: [target], value: moving.kind === "scalar" ? String(moving.value) : "" },
        { path: [source], remove: true },
      ]);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {handle}
        <BareTextField
          path={["tag_name"]}
          className="h-8 text-xs min-w-0 flex-1"
          ariaLabel="Tag name"
          placeholder={isRegexMode ? "e.g. $$1" : kind.tagPlaceholder}
        />
        {removeButton}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={isRegexMode ? "regex" : "key"}
          onValueChange={(value) => {
            if (switchable && (value === "regex") !== isRegexMode) switchKeyMode(value === "regex");
          }}
          disabled={form.disabled || !switchable}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="key">Key</SelectItem>
            <SelectItem value="regex">Regex</SelectItem>
          </SelectContent>
        </Select>
        <BareSelectField path={["from"]} options={EXTRACT_FROM} placeholder="Pod" className="h-8 text-xs" />
      </div>
      <BareTextField
        key={isRegexMode ? "regex" : "key"}
        path={[isRegexMode ? "key_regex" : "key"]}
        className="h-8 text-xs w-full"
        ariaLabel={isRegexMode ? "Key regex" : kind.keyLabel}
        placeholder={isRegexMode ? kind.regexPlaceholder : kind.keyPlaceholder}
      />
      {isRegexMode && (
        <p className="text-[11px] leading-4 text-muted-foreground">Capture groups are referenced as $$1, $$2 in the tag name.</p>
      )}
    </>
  );
}
