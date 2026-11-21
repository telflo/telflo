import { Activity, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { isMap, isScalar, isSeq } from "yaml";

import { ConfigSection } from "./config-forms/ConfigSection.js";
import {
  BareTextField,
  FormProvider,
  FormScope,
  formSource,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  useTelemetryDraft,
  type FormSource,
  type SelectOption,
} from "./config-forms/form-context.js";
import { InlineAlert } from "./config-forms/InlineAlert.js";
import { renamedIndex, useCardKeys } from "./config-forms/shared/card-keys.js";
import { ListTextField } from "./config-forms/shared/ListTextField.js";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { OWN_HISTORY_PROPS } from "~/hooks/useUndoRedo.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ParsedText } from "~/lib/graph/parse.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import { nodeAt, readValue, type ValueView } from "~/lib/graph/value-view.js";
import { selectIsEditingLocked, TELEMETRY_BASE, useEditorStore, type EditorState } from "~/lib/stores/editor-store.js";

/*
 * The Self-monitoring dialog, over the dialog's draft (`useTelemetryDraft`):
 * the fields read `service.telemetry` from the text as it was when the
 * dialog opened, and write key-path changes into the draft. Apply sends
 * those changes to the store's `setTelemetryValues`, which writes them by
 * key path under `service.telemetry`, as one entry, "Edit self-monitoring".
 *
 * How it writes (by key path):
 * - a reader or an OTLP processor turned on appends its item; turned off,
 *   that one item's lines are removed (the list's key with its last item);
 * - Output Paths and Propagators, comma-separated, are
 *   written by item: a changed item set, new ones appended, gone ones removed
 *   from the end; emptied, the key goes;
 * - a resource attribute's key is renamed in place on blur or Enter; a key
 *   another attribute has is refused with `ATTRIBUTE_EXISTS_MESSAGE` under
 *   the row, as text, and the row shows its key again (as Headers'); the
 *   rows are keyed by their attributes, a renamed one keeping its row
 *   wherever it lands (an integer-like key goes first), so a × pressed as a
 *   rename is written removes its own attribute; "unset" writes `null`,
 *   unchecking writes `""` and the row stays; the remove button removes the
 *   attribute's lines (the mapping with its last);
 * - "Convert to Prometheus reader" appends a Prometheus reader from the
 *   address when there is none, and removes `metrics.address`;
 * - a field cleared removes its key, and a mapping the dialog added (not in
 *   the text when it opened: `metrics`, `logs`, `traces`, `resource`) goes
 *   with the key that emptied it; one the text has, an explicit null
 *   included, stays;
 * - at Apply, a resource attribute row whose key is still empty is dropped,
 *   so `""` is never written as a key (never `"": value`), through the
 *   removal above: `resource` goes with it only when the dialog added it.
 *
 * The whole of `service.telemetry` is never replaced or pruned of empty
 * values (a console reader's `{}` stays); unset-then-uncheck keeps the
 * attribute; the draft isn't re-seeded from the store while open; and Apply
 * with no change takes no entry and leaves the editor clean. Apply writes
 * only the draft's differences, never a key the dialog doesn't show; a draft
 * reading as the text (or, over a text without telemetry, as an empty
 * mapping) closes the dialog with no toast and no entry. Remove Section
 * removes `service.telemetry`'s lines (a `service` left empty is
 * `service: {}`), as one entry, "Edit self-monitoring"; it is enabled
 * whenever the key is in the text, an explicit null included.
 *
 * Apply replays the draft's changes, so it writes only while the text is still
 * the one the draft was taken from. When the text changed while the dialog was
 * open (an undo, a load), Apply writes nothing, keeps the dialog open with
 * `TEXT_CHANGED_MESSAGE`, and takes the draft again from the text. The
 * dialog's undo and redo shortcuts are its own (`OWN_HISTORY_PROPS`): they
 * never reach the editor's. A write the store refuses (its toast says why)
 * keeps the dialog open with the draft; only a write closes it with
 * "Self-monitoring updated". Remove Section likewise closes only when it
 * removed. Apply writes what the fields still hold into the draft first, and
 * reads the draft's changes after that (as for saves: a click may not blur the
 * field); one refused there (a clashing key, its message under the row) keeps
 * the dialog open, writing nothing. The dialog closes at once: there is no
 * close animation (ui/dialog's `animate-out` classes have no CSS). The body
 * stays mounted with the draft until Radix unmounts it, so an animation added
 * later wouldn't blank it, and the draft is taken again when it opens.
 *
 * A `service.telemetry` that isn't a mapping shows the fields read-only, with
 * a hint; Apply is disabled; Remove Section works. The dialog's content is
 * `OWN_HISTORY_PROPS`: Delete, Backspace and Cmd/Ctrl+D there are the
 * controls' own, never the canvas's, and so are undo and redo. Field ids are
 * fixed, rows indexed; no value reaches an attribute. No field sits inside a
 * `<form>`.
 */

/** Above the footer when Apply found the text changed since the draft was taken. */
export const TEXT_CHANGED_MESSAGE = "The configuration changed while this dialog was open. Review the settings and apply again.";

/** Under a resource attribute's row whose new key another attribute has. */
export const ATTRIBUTE_EXISTS_MESSAGE = "An attribute with this key already exists.";

interface SelfMonitoringDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const options = (values: readonly string[]): SelectOption[] => values.map((value) => ({ value, label: value }));

const LEVELS = options(["none", "basic", "normal", "detailed"]);
const LOG_LEVELS = options(["debug", "info", "warn", "error"]);
const OTLP_PROTOCOLS = options(["grpc", "http/protobuf"]);
const TEMPORALITIES = options(["cumulative", "delta", "lowmemory"]);
const ENCODINGS = options(["console", "json"]);

/** The items the toggles append. */
const PROMETHEUS_READER = { pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } };
const OTLP_READER = { periodic: { exporter: { otlp: { protocol: "http/protobuf", endpoint: "https://backend:4318" } } } };
const OTLP_PROCESSOR = { batch: { exporter: { otlp: { protocol: "http/protobuf", endpoint: "https://backend:4318" } } } };

/**
 * Whether the text has `service.telemetry` with a value other than null,
 * through aliases and merges: what `readValue` reads as not absent, from
 * the node alone, since the canvas action's selector runs on every store
 * update (a node's drag included) and a mapping's `toJS` would copy the
 * whole section each time.
 */
export function telemetryConfigured(document: ParsedText | null): boolean {
  if (document === null) return false;
  const node = nodeAt(document, TELEMETRY_BASE);
  if (isScalar(node)) return node.value !== null && node.value !== undefined;
  return isMap(node) || isSeq(node);
}

/** The store's "configured": the canvas action's dot and `data-configured`. */
export const selectTelemetryConfigured = (state: EditorState): boolean => telemetryConfigured(state.document);

/** Whether the text has a `service.telemetry` key, null included: what Remove Section removes. */
function telemetryPresent(document: ParsedText | null): boolean {
  return document !== null && nodeAt(document, TELEMETRY_BASE) !== undefined;
}

/** What's at `keys` in a value read from the text. */
function dig(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A list's items as read, `[]` when unset, or null when the value isn't a list. */
function itemsOf(view: ValueView): unknown[] | null {
  if (view.kind === "absent") return [];
  return view.kind === "list" ? view.value : null;
}

/** The number of keys or items at `view`, or null for a scalar. */
function sizeOf(view: ValueView): number | null {
  if (view.kind === "map") return Object.keys(view.value).length;
  if (view.kind === "list") return view.value.length;
  return view.kind === "absent" ? 0 : null;
}

export function SelfMonitoringDialog({ open, onOpenChange }: SelfMonitoringDialogProps) {
  const draft = useTelemetryDraft(open);
  const document = useEditorStore((state) => state.document);
  const locked = useEditorStore(selectIsEditingLocked);
  const present = telemetryPresent(document);
  /** Whether Apply found the text changed since the draft was taken; cleared when the dialog opens again. */
  const [textChanged, setTextChanged] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTextChanged(false);
  }

  /** Whether a field's write was refused (a draft that can't take it, a clashing key) since Apply began. */
  const refused = useRef(false);
  const onRefused = () => {
    refused.current = true;
  };

  const telemetry = draft.read([]);
  const unshowable = telemetry.kind === "scalar" || telemetry.kind === "list";

  /*
   * The fields' source: the draft, whose removals take with them each mapping
   * above the removed key that it empties and the text hadn't when the dialog
   * opened. Only mapping keys are climbed (a list item's index isn't the
   * text's once an item before it is removed), and never `service.telemetry`
   * itself. A key the text has is kept, an explicit null (`logs:`) included,
   * with its comment, unless the draft removed it (the last resource
   * attribute's ×) and a later change added it again: that one the dialog
   * added.
   */
  const form = useMemo((): FormSource => {
    const removedInDraft = (path: ValuePath) =>
      draft
        .latest()
        .changes.some((change) => "remove" in change && change.path.length <= path.length && change.path.every((segment, i) => segment === path[i]));
    const removal = (path: ValuePath): ValuePath => {
      let target = path;
      while (target.length > 1) {
        const parent = target.slice(0, -1);
        if (parent.some((segment) => typeof segment === "number")) break;
        const inText =
          document !== null && nodeAt(document, [...TELEMETRY_BASE, ...parent]) !== undefined && !removedInDraft(parent);
        if (inText || sizeOf(draft.read(parent)) !== 1) break;
        target = parent;
      }
      return target;
    };
    return formSource(
      draft.read,
      (changes) => {
        const result = draft.apply(changes.map((change) => ("remove" in change ? { ...change, path: removal(change.path) } : change)));
        if (result === "refused") refused.current = true;
        return result;
      },
      draft.disabled,
    );
  }, [draft, document]);

  const handleApply = () => {
    // What a field still holds is the draft's first: a click on Apply may not blur it.
    refused.current = false;
    flushHeldEdits();
    // One refused (its message or toast says why): the dialog stays open, to fix it or Cancel.
    if (refused.current) return;
    const store = useEditorStore.getState();
    // The draft's changes are replayed on the text: only on the text they were made over.
    if (store.text !== draft.seed) {
      setTextChanged(true);
      draft.retake();
      return;
    }
    dropBlankAttributes(form, store.document);
    const { changes, changed } = draft.latest();
    const inText = store.document !== null ? readValue(store.document, TELEMETRY_BASE, []) : ({ kind: "absent" } as const);
    // Turned on and off again over a text without telemetry: nothing to write.
    const emptied = inText.kind === "absent" && sizeOf(draft.read([])) === 0;
    if (changed && !emptied) {
      // Refused (the store's toast says why): the draft stays, to try again or Cancel.
      if (!store.setTelemetryValues(changes)) return;
      toast.success("Self-monitoring updated");
    }
    onOpenChange(false);
  };

  const handleRemove = () => {
    // Refused (the store's toast says why): the dialog stays open with its draft.
    if (!useEditorStore.getState().removeTelemetry()) return;
    toast.success("Self-monitoring removed");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg" {...OWN_HISTORY_PROPS}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Collector Self-Monitoring
          </DialogTitle>
          <DialogDescription>
            Configure <span className="font-mono text-xs">service::telemetry</span> — the metrics, logs, and traces the
            collector emits about itself. Fields not shown here are preserved as-is.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted as long as Radix keeps the content (no close animation today; a later one wouldn't blank it): the draft is kept until it opens again. */}
        <FormProvider form={form}>
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {unshowable && <p className="mb-3 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
            <LegacyAddressBanner />
            <MetricsSection />
            <LogsSection />
            <TracesSection />
            <ResourceSection onRefused={onRefused} />
          </div>
        </FormProvider>

        {textChanged && <InlineAlert variant="warn">{TEXT_CHANGED_MESSAGE}</InlineAlert>}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={handleRemove}
            disabled={!present || locked}
          >
            Remove Section
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleApply} disabled={draft.disabled}>
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Removes the resource attribute row Add Attribute made whose key is still
 * empty, so Apply never writes `""` as a key, not even `"": value`. It goes
 * through the dialog's removal, so `resource` goes with it only when the
 * dialog added it: a `resource` the text had, null or `{}`, stays. A `""` key
 * the text already had is left alone.
 */
function dropBlankAttributes(form: FormSource, document: ParsedText | null) {
  const resource = form.read(["resource"]);
  if (resource.kind !== "map" || !Object.hasOwn(resource.value, "")) return;
  if (document !== null && nodeAt(document, [...TELEMETRY_BASE, "resource", ""]) !== undefined) return;
  form.remove(["resource", ""]);
}

/** The index of the first item carrying `keys` (-1 when none). */
function indexOf(items: readonly unknown[] | null, ...keys: string[]): number {
  return items === null ? -1 : items.findIndex((item) => Boolean(dig(item, ...keys)));
}

/**
 * Turns a list item on (its item appended) or off (its lines
 * removed; the list's key with its last item).
 */
function toggleItem(form: FormSource, listPath: ValuePath, items: readonly unknown[], index: number, on: boolean, item: unknown) {
  if (on && index < 0) form.set([...listPath, items.length], item);
  else if (!on && index >= 0) form.remove(items.length === 1 ? listPath : [...listPath, index]);
}

/** A checkbox row that turns a list item on or off. */
function ItemToggle({
  id,
  label,
  checked,
  disabled,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onToggle(next === true)} disabled={disabled} />
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Legacy field, ignored by every collector version Telflo supports. */
function LegacyAddressBanner() {
  const form = useForm();
  const address = form.read(["metrics", "address"]);
  if (address.kind !== "scalar" || typeof address.value !== "string" || address.value === "") return null;
  const legacyAddress = address.value;
  const readers = itemsOf(form.read(["metrics", "readers"]));

  const migrateLegacyAddress = () => {
    const changes: ValueChange[] = [];
    if (readers !== null && indexOf(readers, "pull", "exporter", "prometheus") < 0) {
      const [host, portStr] = legacyAddress.split(":");
      const port = Number.parseInt(portStr ?? "", 10);
      changes.push({
        path: ["metrics", "readers", readers.length],
        value: { pull: { exporter: { prometheus: { host: host || "0.0.0.0", port: Number.isFinite(port) ? port : 8888 } } } },
      });
    }
    changes.push({ path: ["metrics", "address"], remove: true });
    form.apply(changes);
  };

  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-2.5 text-xs text-warn">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1.5">
        <p>
          <span className="font-mono">metrics::address</span> (<span className="font-mono">{legacyAddress}</span>) is
          ignored by collector v0.123.0 and later — every version Telflo supports. Use a Prometheus reader instead.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={migrateLegacyAddress}
          disabled={form.disabled || readers === null}
        >
          Convert to Prometheus reader
        </Button>
      </div>
    </div>
  );
}

/** Protocol + endpoint pair shared by the three OTLP push editors, under a FormScope at the `otlp` block. */
function OtlpTargetFields({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <SelectField path={["protocol"]} id={`${idPrefix}-protocol`} label="Protocol" placeholder="http/protobuf" options={OTLP_PROTOCOLS} />
      <TextField
        path={["endpoint"]}
        id={`${idPrefix}-endpoint`}
        label="Endpoint"
        description="Where the collector sends telemetry about itself."
        placeholder="e.g. https://backend:4318"
      />
    </>
  );
}

function MetricsSection() {
  const form = useForm();
  const readersPath: ValuePath = ["metrics", "readers"];
  const readers = itemsOf(form.read(readersPath));
  const promIdx = indexOf(readers, "pull", "exporter", "prometheus");
  const otlpIdx = indexOf(readers, "periodic", "exporter", "otlp");
  const toggleDisabled = form.disabled || readers === null;

  return (
    <ConfigSection title="Metrics" defaultOpen>
      <SelectField
        path={["metrics", "level"]}
        id="sm-metrics-level"
        label="Level"
        defaultValue="normal"
        description="Verbosity of the collector's own metrics; none disables them."
        options={LEVELS}
      />

      <div className="space-y-1">
        <ItemToggle
          id="sm-prom-enabled"
          label="Expose Prometheus Endpoint (pull)"
          checked={promIdx >= 0}
          disabled={toggleDisabled}
          onToggle={(on) => toggleItem(form, readersPath, readers ?? [], promIdx, on, PROMETHEUS_READER)}
        />
        <p className="ml-6 text-[11px] leading-4 text-muted-foreground">
          Serves internal metrics for scraping — the modern replacement for the removed{" "}
          <span className="font-mono">address</span> field.
        </p>
      </div>

      {promIdx >= 0 && (
        <div className="ml-6 space-y-4">
          <FormScope path={[...readersPath, promIdx, "pull", "exporter", "prometheus"]}>
            <TextField path={["host"]} id="sm-prom-host" label="Host" defaultValue="localhost" placeholder="0.0.0.0" />
            <NumberField path={["port"]} id="sm-prom-port" label="Port" defaultValue="8888" placeholder="8888" />
          </FormScope>
        </div>
      )}

      <div className="space-y-1">
        <ItemToggle
          id="sm-otlp-metrics-enabled"
          label="Push Metrics via OTLP (periodic)"
          checked={otlpIdx >= 0}
          disabled={toggleDisabled}
          onToggle={(on) => toggleItem(form, readersPath, readers ?? [], otlpIdx, on, OTLP_READER)}
        />
      </div>

      {otlpIdx >= 0 && (
        <div className="ml-6 space-y-4">
          <FormScope path={[...readersPath, otlpIdx, "periodic"]}>
            <FormScope path={["exporter", "otlp"]}>
              <OtlpTargetFields idPrefix="sm-otlp-metrics" />
            </FormScope>
            <NumberField
              path={["interval"]}
              id="sm-otlp-interval"
              label="Export Interval (ms)"
              defaultValue="60000"
              placeholder="60000"
            />
            <FormScope path={["exporter", "otlp"]}>
              <SelectField
                path={["temporality_preference"]}
                id="sm-otlp-temporality"
                label="Temporality"
                defaultValue="cumulative"
                options={TEMPORALITIES}
              />
            </FormScope>
          </FormScope>
        </div>
      )}
    </ConfigSection>
  );
}

/** The OTLP push of logs or traces: the first `batch` processor carrying `exporter.otlp`. */
function OtlpProcessor({ signal, id, label }: { signal: "logs" | "traces"; id: string; label: string }) {
  const form = useForm();
  const processorsPath: ValuePath = [signal, "processors"];
  const processors = itemsOf(form.read(processorsPath));
  const index = indexOf(processors, "batch", "exporter", "otlp");
  return (
    <>
      <ItemToggle
        id={`${id}-enabled`}
        label={label}
        checked={index >= 0}
        disabled={form.disabled || processors === null}
        onToggle={(on) => toggleItem(form, processorsPath, processors ?? [], index, on, OTLP_PROCESSOR)}
      />
      {index >= 0 && (
        <div className="ml-6 space-y-4">
          <FormScope path={[...processorsPath, index, "batch", "exporter", "otlp"]}>
            <OtlpTargetFields idPrefix={id} />
          </FormScope>
        </div>
      )}
    </>
  );
}

function LogsSection() {
  return (
    <ConfigSection title="Logs">
      <SelectField path={["logs", "level"]} id="sm-logs-level" label="Level" defaultValue="info" options={LOG_LEVELS} />
      <SelectField path={["logs", "encoding"]} id="sm-logs-encoding" label="Encoding" defaultValue="console" options={ENCODINGS} />
      <ListTextField
        path={["logs", "output_paths"]}
        id="sm-logs-output"
        separator=","
        emptyRemovesKey
        label="Output Paths"
        defaultValue="stderr"
        description="Comma-separated file paths or stderr/stdout."
        placeholder="stderr"
      />
      <OtlpProcessor signal="logs" id="sm-logs-otlp" label="Push Logs via OTLP" />
    </ConfigSection>
  );
}

function TracesSection() {
  return (
    <ConfigSection title="Traces">
      <SelectField
        path={["traces", "level"]}
        id="sm-traces-level"
        label="Level"
        defaultValue="basic"
        description="Internal tracing is experimental upstream; none disables it."
        options={LEVELS}
      />
      <ListTextField
        path={["traces", "propagators"]}
        id="sm-traces-propagators"
        separator=","
        emptyRemovesKey
        label="Propagators"
        description="Comma-separated, e.g. tracecontext, b3."
        placeholder="tracecontext"
      />
      <OtlpProcessor signal="traces" id="sm-traces-otlp" label="Push Traces via OTLP" />
    </ConfigSection>
  );
}

// Resource attributes as editable rows. `null` is a meaningful value (it
// strips an auto-generated attribute), so rows keep it distinct from "".
function ResourceSection({ onRefused }: { onRefused: () => void }) {
  const form = useForm();
  const view = form.read(["resource"]);
  const entries = view.kind === "map" ? Object.entries(view.value) : view.kind === "absent" ? [] : null;
  const keys = entries?.map(([key]) => key) ?? [];
  // Rows keyed by their attributes, a rename following its row: a key renamed as the pointer goes down on
  // another row's × (an integer-like key reorders the rows) mustn't hand that × to another attribute.
  const cards = useCardKeys(keys);

  const addResourceEntry = () => {
    // A row with no key yet is kept, not overwritten.
    if (!keys.includes("")) form.set(["resource", ""], "");
  };

  return (
    <ConfigSection title="Resource Attributes">
      <p className="text-[11px] leading-4 text-muted-foreground">
        Override attributes on the collector's own telemetry (e.g.{" "}
        <span className="font-mono">service.name</span>). Check "unset" to strip an auto-generated attribute.
      </p>
      {entries === null ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        entries.map(([key, value], i) => (
          <ResourceRow
            key={cards.keys[i]}
            index={i}
            name={key}
            isNull={value === null}
            taken={(typed) => keys.some((other, j) => j !== i && other === typed)}
            onRemove={() => {
              if (form.remove(entries.length === 1 ? ["resource"] : ["resource", key]) === "written") cards.remove(i);
            }}
            onRenamed={(to) => cards.move(i, renamedIndex(keys, i, to))}
            onRefused={onRefused}
          />
        ))
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={addResourceEntry}
        disabled={form.disabled || entries === null}
      >
        Add Attribute
      </Button>
    </ConfigSection>
  );
}

/** A resource attribute's row: its key renamed in place on blur or Enter, its value written as typed. */
function ResourceRow({
  index,
  name,
  isNull,
  taken,
  onRemove,
  onRenamed,
  onRefused,
}: {
  index: number;
  name: string;
  isNull: boolean;
  /** Whether another attribute has this key. */
  taken: (typed: string) => boolean;
  onRemove: () => void;
  /** The key was renamed: the row's key follows it. */
  onRenamed: (to: string) => void;
  /** A rename refused: Apply, flushing it, stays open. */
  onRefused: () => void;
}) {
  const form = useForm();
  /** The key a rename was refused on: the message shows while the row still has it. */
  const [clashOn, setClashOn] = useState<string | null>(null);
  // An empty key isn't a rename, nor is one another attribute has (the message): the row shows its key again.
  const keyText = useHeldText(
    name,
    (typed) => {
      if (typed === "") return;
      if (taken(typed)) {
        setClashOn(name);
        onRefused();
        return;
      }
      if (form.rename(["resource", name], typed) === "written") onRenamed(typed);
    },
    { pause: false },
  );
  const unsetId = `sm-resource-null-${index}`;

  return (
    <>
      <div className="flex items-center gap-2">
        <VaultAwareInput
          aria-label="Attribute key"
          value={keyText.value}
          onChange={(e) => {
            keyText.change(e.target.value);
            setClashOn(null);
          }}
          onBlur={keyText.flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
            keyText.handleKeyDown(e);
          }}
          placeholder="service.name"
          className="flex-1"
          disabled={form.disabled}
        />
        {isNull ? (
          <VaultAwareInput aria-label="Attribute value" value="" disabled placeholder="unset" className="flex-1" />
        ) : (
          <BareTextField path={["resource", name]} ariaLabel="Attribute value" placeholder="value" className="flex-1" />
        )}
        <div className="flex items-center gap-1">
          <Checkbox
            id={unsetId}
            checked={isNull}
            onCheckedChange={(checked) => form.set(["resource", name], checked === true ? null : "")}
            disabled={form.disabled}
          />
          <Label htmlFor={unsetId} className="text-[11px] text-muted-foreground">
            unset
          </Label>
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRemove} disabled={form.disabled}>
          ×
        </Button>
      </div>
      {clashOn === name && <p className="text-[11px] leading-4 text-fail">{ATTRIBUTE_EXISTS_MESSAGE}</p>}
    </>
  );
}
