import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormScope,
  NumberField,
  RadioField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { ItemScope } from "./shared/held-item.js";
import { NumberListField } from "./shared/ListTextField.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import { plainNumber, type ValueChange, type ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The StatsD receiver's form (ADR 0018), over the form's fields
 * (D9d decision 2, D9b's contract): each field writes its own key.
 * Collector claims are contrib v0.162.0's `receiver/statsdreceiver`.
 *
 * - Transport is native radios (`RadioField`), with the
 *   collector's full set (decision 6; `internal/transport/transport.go:17-
 *   25`): udp, udp4, udp6, tcp, tcp4, tcp6 and unixgram, not just
 *   UDP, TCP and Unix Socket. Unset shows udp, the collector's default
 *   (`factory.go:40-43`).
 * - Changed (D9c netflow's rule): a transport switch sets the endpoint to
 *   the transport's default (`localhost:8125`, or
 *   `/var/run/statsd-receiver.sock` for a Unix socket) only while the
 *   endpoint is unset or one of those; an endpoint of the person's own is
 *   kept.
 * - Fixed (decision 2): Unix Socket writes `socket_permissions` plain,
 *   `0622`, and only when the text has none, never the string
 *   `"0622"`, which the collector refuses: the field is an `os.FileMode`
 *   (`config.go:34`) and confmap has no string-to-number hook. Plain
 *   `0622` is octal to the collector's YAML reader (mode 0o622, the
 *   default, `factory.go:24`). Socket Permissions is a number field: what
 *   is typed is written plain when it reads as a number (`0644`). While
 *   the text holds a quoted number, a hint says so and retyping the same
 *   characters writes them plain (`NumberField`'s `writeSame`; D9c Ruling
 *   47's precedent).
 * - Changed (decision 7): Observer Type switched away from histogram
 *   removes the mapping's `histogram` block, and away from summary its
 *   `summary` block, in the same change, with a toast: the collector
 *   refuses either beside another observer (`config.go:90-105`).
 * - Changed (D9b decision 3): unset shows the collector's defaults as
 *   placeholders and "Default" hints: Endpoint localhost:8125
 *   (`factory.go:21`), Aggregation Interval 60s (`:22`), Socket
 *   Permissions 0622 (`:24`), Max Size 160 (`internal/parser/
 *   statsd_parser.go:254-256` with go-expohisto's default),
 *   Percentiles 0, 10, 50, 90, 95, 100
 *   (`internal/parser/metric_translator.go:20`). Cleared fields remove
 *   their keys (never `null`); the `histogram` and
 *   `summary` blocks go with their last key (a pruning scope).
 * - Percentiles are a `NumberListField` joined `", "` (Preflight ruling
 *   20): typing is held and written by item, each as typed (never
 *   filtered per keystroke, writing `5` on the way to `50`).
 * - The mappings are sortable cards (`useCardKeys`, `form.move`): a card's
 *   expanded state follows its mapping, not the index;
 *   the first starts expanded. Add Mapping appends
 *   the seed; on an unset list it writes that one mapping, which
 *   replaces the collector's three defaults (decision 5), and the empty
 *   state names them (`factory.go:27`). Removing the last leaves `[]`,
 *   which maps nothing (`internal/parser/statsd_parser.go:
 *   206-239`), with its own empty state.
 *
 * Ids are fixed (`endpoint`, `statsd_type_0`, …; the
 * radios `transport-<index>`); no value reaches an attribute (decision 13).
 */

/** Decision 7's toasts (the plan's copy). */
export const REMOVED_HISTOGRAM = "Removed the histogram settings: they need observer type histogram.";
export const REMOVED_SUMMARY = "Removed the summary percentiles: they need observer type summary.";

/** An unset mapping list (decision 5): the collector's three defaults (`factory.go:27`). */
export const NO_MAPPINGS = "None set: the collector maps timer, histogram and distribution to gauge.";
/** An empty list (`[]`), which maps nothing. */
export const EMPTY_MAPPINGS = "No mappings configured";

/** Under Socket Permissions while the text holds a quoted number (D9c Ruling 47's precedent). */
export const SOCKET_PERMISSIONS_STRING_HINT = "Written as a string; the collector needs a plain octal number. Retype it to unquote it.";

/** The default endpoint for each kind of transport. */
const NET_ENDPOINT = "localhost:8125";
const SOCKET_ENDPOINT = "/var/run/statsd-receiver.sock";
const UNIXGRAM = "unixgram";

const TRANSPORTS = [
  { value: "udp", label: "UDP" },
  { value: "udp4", label: "UDP (IPv4)" },
  { value: "udp6", label: "UDP (IPv6)" },
  { value: "tcp", label: "TCP" },
  { value: "tcp4", label: "TCP (IPv4)" },
  { value: "tcp6", label: "TCP (IPv6)" },
  { value: UNIXGRAM, label: "Unix Socket" },
] as const;

const STATSD_TYPES = [
  { value: "timing", label: "timing" },
  { value: "timer", label: "timer" },
  { value: "histogram", label: "histogram" },
  { value: "distribution", label: "distribution" },
] as const;

const OBSERVER_TYPES = [
  { value: "gauge", label: "gauge" },
  { value: "summary", label: "summary" },
  { value: "histogram", label: "histogram" },
] as const;

const MAPPINGS: ValuePath = ["timer_histogram_mapping"];

/** Add Mapping's seed. */
const MAPPING_SEED = { statsd_type: "histogram", observer_type: "histogram", histogram: { max_size: 100 } };

/** The described box rows. */
const DESCRIBED_ROW = {
  rowClassName: "flex items-start gap-2.5",
  describedClassName: "grid flex-1 gap-1 leading-none",
  labelClassName: "cursor-pointer text-sm font-medium",
  descriptionClassName: "text-xs text-muted-foreground",
} as const;

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

export function StatsdReceiverForm() {
  const form = useForm();
  const transport = textOf(form.read(["transport"]));
  const isUnixSocket = transport === UNIXGRAM;
  const permissions = form.read(["socket_permissions"]);
  // A quoted number ("0622"): the collector refuses it; the same characters retyped are written plain.
  const quotedNumber = permissions.kind === "scalar" && typeof permissions.value === "string" && plainNumber(permissions.value) !== undefined;

  const switchTransport = (next: string) => {
    const changes: ValueChange[] = [{ path: ["transport"], value: next }];
    const endpoint = form.read(["endpoint"]);
    const written = textOf(endpoint);
    const isDefault = endpoint.kind === "absent" || (endpoint.kind === "scalar" && (written === NET_ENDPOINT || written === SOCKET_ENDPOINT));
    const target = next === UNIXGRAM ? SOCKET_ENDPOINT : NET_ENDPOINT;
    if (isDefault && written !== target) changes.push({ path: ["endpoint"], value: target });
    // Plain, as the collector reads an os.FileMode (config.go:34); only when the text has none.
    if (next === UNIXGRAM && permissions.kind === "absent") changes.push({ path: ["socket_permissions"], plain: "0622" });
    form.apply(changes);
  };

  return (
    <div className="space-y-4">
      <RadioField
        path={["transport"]}
        id="transport"
        label="Transport"
        defaultValue="udp"
        description="UDP is the standard StatsD transport."
        options={TRANSPORTS}
        onSelect={switchTransport}
        className="flex flex-wrap gap-x-4 gap-y-2"
      />

      <TextField
        path={["endpoint"]}
        id="endpoint"
        label={isUnixSocket ? "Socket Path" : "Endpoint"}
        {...(isUnixSocket ? {} : { defaultValue: NET_ENDPOINT, description: "host:port to listen on." })}
        placeholder={isUnixSocket ? "e.g. /var/run/statsd-receiver.sock" : NET_ENDPOINT}
      />

      {isUnixSocket && (
        <div className="space-y-1.5">
          <NumberField
            path={["socket_permissions"]}
            id="socket_permissions"
            label="Socket Permissions"
            defaultValue="0622"
            description="Octal file mode."
            writeSame={quotedNumber}
          />
          {quotedNumber && <p className="text-[11px] leading-4 text-muted-foreground">{SOCKET_PERMISSIONS_STRING_HINT}</p>}
        </div>
      )}

      <InlineAlert variant="info" title="Agent deployment">
        Aggregation is per-instance; run one receiver as an agent, not several behind a load balancer.
      </InlineAlert>

      <ConfigSection title="Aggregation">
        <DurationField
          path={["aggregation_interval"]}
          id="aggregation_interval"
          label="Aggregation Interval"
          defaultValue="60s"
          description="Window for aggregating metrics before flushing downstream."
        />

        <CheckboxField
          path={["enable_ip_only_aggregation"]}
          id="enable_ip_only_aggregation"
          label="IP-Only Aggregation"
          description="Group by client IP instead of IP and port, so ephemeral ports don't split series."
          defaultChecked={false}
          {...DESCRIBED_ROW}
        />
      </ConfigSection>

      <ConfigSection title="Metric Processing">
        <CheckboxField
          path={["enable_metric_type"]}
          id="enable_metric_type"
          label="Metric Type Label"
          description="Emit the StatsD type (gauge, counter, timer) as a label."
          defaultChecked={false}
          {...DESCRIBED_ROW}
        />

        <CheckboxField
          path={["is_monotonic_counter"]}
          id="is_monotonic_counter"
          label="Monotonic Counters"
          description="Emit counters as monotonic sums instead of non-monotonic deltas."
          defaultChecked={false}
          {...DESCRIBED_ROW}
        />

        <CheckboxField
          path={["enable_simple_tags"]}
          id="enable_simple_tags"
          label="Simple Tags"
          description="Parse valueless DogStatsD tags like #mykey."
          defaultChecked={false}
          {...DESCRIBED_ROW}
        />
      </ConfigSection>

      <TimerMappings />
    </div>
  );
}

/** The Timer Mapping section: the mappings as sortable cards. */
function TimerMappings() {
  const form = useForm();
  const view = form.read(MAPPINGS);
  const mappings = view.kind === "list" ? view.value : [];
  const count = mappings.length;
  const showable = view.kind === "list" || view.kind === "absent";
  const cards = useCardKeys(mappings);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set([0]));

  const toggle = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addMapping = () => {
    const result = view.kind === "list" ? form.set([...MAPPINGS, count], MAPPING_SEED) : form.set(MAPPINGS, [MAPPING_SEED]);
    if (result !== "written") return;
    setExpanded(new Set([...expanded, cards.next]));
    cards.add();
  };

  const removeMapping = (index: number) => {
    if (form.remove([...MAPPINGS, index]) === "written") cards.remove(index);
  };

  const moveMapping = (from: number, to: number) => {
    if (form.move(MAPPINGS, from, to) === "written") cards.move(from, to);
  };

  return (
    <ConfigSection title="Timer Mapping" count={count}>
      <p className="text-xs text-muted-foreground">
        Map StatsD timers and histograms to OTel types: histogram for buckets, summary for percentiles, gauge for min/max/avg.
      </p>

      {view.kind === "absent" && <p className="text-[11px] leading-4 text-muted-foreground">{NO_MAPPINGS}</p>}
      {view.kind === "list" && count === 0 && <p className="text-[11px] leading-4 text-muted-foreground">{EMPTY_MAPPINGS}</p>}

      {!showable ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <SortableList list="mapping" items={cards.keys} onReorder={moveMapping} listClassName="space-y-2" contextId="statsd-timer-mappings">
          {(key, index, id) => (
            <SortableItem key={key} id={id} disabled={form.disabled}>
              {({ isDragging, dragHandleProps }) => (
                <div className={`border border-border rounded-md overflow-hidden ${isDragging ? "shadow-lg ring-2 ring-ring" : ""}`}>
                  <ItemScope listPath={MAPPINGS} index={index}>
                    <MappingCard
                      index={index}
                      expanded={expanded.has(key)}
                      onToggle={() => toggle(key)}
                      onRemove={() => removeMapping(index)}
                      handle={<SortableHandle {...dragHandleProps} disabled={form.disabled} />}
                    />
                  </ItemScope>
                </div>
              )}
            </SortableItem>
          )}
        </SortableList>
      )}

      <Button variant="outline" size="sm" onClick={addMapping} className="w-full" type="button" disabled={form.disabled || !showable}>
        <Plus className="h-4 w-4 mr-2" />
        Add Mapping
      </Button>
    </ConfigSection>
  );
}

/** A mapping's card, under its item (`timer_histogram_mapping.<index>`). */
function MappingCard({
  index,
  expanded,
  onToggle,
  onRemove,
  handle,
}: {
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  handle: ReactNode;
}) {
  const form = useForm();
  const adjustments = useAdjustments();
  const showable = form.read([]).kind === "map";
  const statsdType = textOf(form.read(["statsd_type"]));
  const observerType = textOf(form.read(["observer_type"]));

  // config.go:90-105: histogram settings need observer histogram, percentiles observer summary.
  const setObserver = (next: string) => {
    const changes: ValueChange[] = [{ path: ["observer_type"], value: next }];
    const messages: string[] = [];
    if (next !== "histogram" && form.read(["histogram"]).kind !== "absent") {
      changes.push({ path: ["histogram"], remove: true });
      messages.push(REMOVED_HISTOGRAM);
    }
    if (next !== "summary" && form.read(["summary"]).kind !== "absent") {
      changes.push({ path: ["summary"], remove: true });
      messages.push(REMOVED_SUMMARY);
    }
    const result = form.apply(changes);
    if (messages.length > 0) adjustments.note(messages, result);
  };

  return (
    <>
      <div className="flex items-center justify-between p-2.5 bg-muted/50">
        <div className="flex items-center gap-2">
          {handle}
          <button
            type="button"
            className="flex items-center gap-2 hover:bg-accent px-2 py-1 rounded"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className="font-medium text-sm">
              {statsdType === "" && observerType === "" ? `Mapping ${index + 1}` : `${statsdType} → ${observerType}`}
            </span>
          </button>
        </div>
        <Button
          type="button"
          onClick={onRemove}
          size="sm"
          variant="ghost"
          aria-label="Remove mapping"
          className="text-fail hover:text-fail hover:bg-fail-soft"
          disabled={form.disabled}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {expanded && (
        <div className="p-2.5 space-y-2">
          {!showable ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <SelectField path={["statsd_type"]} id={`statsd_type_${index}`} label="StatsD Type" options={STATSD_TYPES} />
                <SelectField
                  path={["observer_type"]}
                  id={`observer_type_${index}`}
                  label="Observer Type"
                  options={OBSERVER_TYPES}
                  onSelect={setObserver}
                />
              </div>

              {observerType === "histogram" && (
                <FormScope path={["histogram"]} prune>
                  <NumberField
                    path={["max_size"]}
                    id={`max_size_${index}`}
                    label="Max Size"
                    defaultValue="160"
                    description="Bucket limit for the exponential histogram."
                  />
                </FormScope>
              )}

              {observerType === "summary" && (
                <FormScope path={["summary"]} prune>
                  <NumberListField
                    path={["percentiles"]}
                    id={`percentiles_${index}`}
                    join=", "
                    label="Percentiles"
                    defaultValue="0, 10, 50, 90, 95, 100"
                    description="Comma-separated percentiles, 0–100."
                  />
                </FormScope>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
