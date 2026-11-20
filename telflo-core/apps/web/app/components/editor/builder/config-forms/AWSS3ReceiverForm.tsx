import { Plus, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  FormProvider,
  formSource,
  FormScope,
  NumberField,
  readLatest,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { ItemScope, useHeldItem, type HeldItem } from "./shared/held-item.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The AWS S3 receiver's form, over the form's fields: each field writes its
 * own key, the downloader's under `s3downloader`. Collector claims are contrib
 * v0.162.0's `receiver/awss3receiver` (type `aws_s3`, `deprecated_type:
 * awss3`, `metadata.yaml:2-3`: both spellings get this form).
 *
 * The Ingest Mode: the collector takes exactly one of a time range
 * (`starttime`, `endtime`) or an `sqs` block, and refuses neither and both
 * (`config.go:92-151`). The mode shown is the text's (`sqs` present: SQS; a
 * null `sqs` is none to the collector, `config.go:101`).
 * - Choosing SQS writes the palette's own seed,
 *   `{queue_url: "${env:AWS_SQS_QUEUE_URL}", region: <the downloader's
 *   region, or us-east-1>}` (an empty `queue_url` is refused,
 *   `config.go:135-137`), and removes `starttime` and `endtime` in the same
 *   change, with `SQS_TOAST` when either was there.
 * - Choosing Time range holds the choice in the form, writing nothing, until
 *   a time is typed (empty times with `sqs` removed would be neither mode,
 *   which is refused, `config.go:99-105`); that write removes `sqs` in the
 *   same change, with `TIME_RANGE_TOAST`. A text already holding a time
 *   takes the choice at once. The held choice goes when `sqs`, `starttime`
 *   or `endtime` change by a write it didn't make (an undo, the YAML box),
 *   on a load or another node, and with the form; an edit to the form's
 *   other fields keeps it.
 *
 * - Add Encoding holds a row (`useHeldItem`) until an extension is typed (an
 *   empty extension id is refused, Core
 *   `component/identifiable.go:131-141`); a suffix typed first waits in it,
 *   and is written only when typed. An empty suffix matches every object
 *   (`receiver.go:312-317`): `SUFFIX_HINT`. A field cleared removes its key;
 *   an item left with no keys is removed, and the last item takes
 *   `encodings`. Rows are keyed by their items; an item that isn't a
 *   mapping, or whose extension or suffix isn't a one-line scalar, is a
 *   read-only row with `UNSHOWABLE_VALUE_MESSAGE` (its Remove works).
 * - Expect Telemetry Type in File Prefix's ticking removes the key (the
 *   default is true, `config.go:85`), unticking writes `false`
 *   (`checkedRemoves`); the lifecycle and path-style boxes write `true` or
 *   nothing (`uncheckedRemoves`); OpAMP Progress Notifications sits in a
 *   pruning scope on `notifications` (the block goes when emptied).
 * - Partition Timezone's placeholder is `Local`, the default, not `UTC`.
 * - Bucket, SQS Queue URL and SQS Region cleared remove their keys (`""` is
 *   refused either way).
 *
 * Ids are fixed, the encoding rows' labels by index; the mode's option
 * values are fixed tokens.
 */

/** The SQS switch's toast. */
export const SQS_TOAST = "Removed starttime and endtime: they can't be used with SQS.";
/** The time range's first write's toast. */
export const TIME_RANGE_TOAST = "Removed the sqs block: it can't be used with a time range.";
/** Under the Encodings. */
export const SUFFIX_HINT = "An empty suffix matches every object.";

/** The palette's queue reference (`palette.ts`'s S3 receiver seed). */
export const SQS_QUEUE_URL_SEED = "${env:AWS_SQS_QUEUE_URL}";

type IngestMode = "sqs" | "time_range";

const DOWNLOADER: ValuePath = ["s3downloader"];
const at = (key: string): ValuePath => [...DOWNLOADER, key];
const SQS: ValuePath = ["sqs"];
const TIMES: readonly ValuePath[] = [["starttime"], ["endtime"]];
/** The keys the ingest mode is read from: a held Time range belongs to them as they were. */
const MODE_KEYS: readonly ValuePath[] = [SQS, ...TIMES];

/** A held Time range: what the mode's keys held when it was chosen, the load and the node. */
interface HeldTimeRange {
  keys: string;
  load: number;
  nodeId: string | undefined;
}

/** The mode's keys as `read` gives them, compared as one string. */
function modeKeys(read: (path: ValuePath) => ValueView): string {
  return JSON.stringify(MODE_KEYS.map((path) => read(path)));
}

/** Whether `held` still holds over the form as it is now. */
function stillHeld(held: HeldTimeRange, form: FormSource, load: number): boolean {
  return held.load === load && held.nodeId === form.nodeId && held.keys === modeKeys(form.read);
}

/** A one-line scalar as written, `""` unset, or null when it can't be shown. */
function lineOf(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  const shown = view.source ?? String(view.value);
  return /[\r\n]/.test(shown) ? null : shown;
}

/** A value set: not unset or `""`. */
function isSet(view: ValueView): boolean {
  return view.kind !== "absent" && !(view.kind === "scalar" && view.value === "");
}

/** A time, blank unless it has characters other than spaces. */
function isBlank(view: ValueView): boolean {
  const shown = lineOf(view);
  return shown === null ? false : shown.trim() === "";
}

/**
 * The time fields' source: a time written while the text has `sqs` (the
 * held Time range) removes `sqs` in the same change, with its toast.
 */
function TimeRangeScope({ children }: { children: ReactNode }) {
  const form = useForm();
  const { note } = useAdjustments();
  const noteRef = useRef(note);
  noteRef.current = note;
  const scoped = formSource(
    form.read,
    (changes) => {
      const sets = changes.some((change) => "value" in change || "plain" in change);
      if (!sets || form.read(SQS).kind === "absent") return form.apply(changes);
      const result = form.apply([...changes, { path: SQS, remove: true }]);
      noteRef.current([{ message: TIME_RANGE_TOAST, adjusted: [SQS] }], result);
      return result;
    },
    form.disabled,
  );
  return <FormProvider form={scoped}>{children}</FormProvider>;
}

export function AWSS3ReceiverForm() {
  const form = useForm();
  const { note } = useAdjustments();
  const load = useEditorStore((state) => state.loadCount);
  // Time range chosen over `sqs`: held while the mode's keys, the load and the node are as they were then.
  const [held, setHeld] = useState<HeldTimeRange | null>(null);
  const holding = held !== null && stillHeld(held, form, load);
  if (held !== null && !holding) setHeld(null);

  const sqsInText = form.read(SQS).kind !== "absent";
  const mode: IngestMode = sqsInText && !holding ? "sqs" : "time_range";

  const setMode = (next: IngestMode) => {
    if (next === mode) return;
    if (next === "sqs") {
      // The text has sqs still: the held choice goes.
      if (sqsInText) {
        setHeld(null);
        return;
      }
      const region = form.read(at("region"));
      const changes: ValueChange[] = [
        {
          path: SQS,
          value: {
            queue_url: SQS_QUEUE_URL_SEED,
            region: region.kind === "scalar" && typeof region.value === "string" && region.value !== "" ? region.value : "us-east-1",
          },
        },
      ];
      const timed = TIMES.filter((path) => form.read(path).kind !== "absent");
      for (const path of timed) changes.push({ path, remove: true });
      const result = form.apply(changes);
      if (timed.length > 0) note([{ message: SQS_TOAST, adjusted: [...timed] }], result);
      return;
    }
    // A time in the text already: the time range is configured, so sqs goes now.
    if (TIMES.some((path) => form.read(path).kind !== "absent")) {
      const result = form.apply([{ path: SQS, remove: true }]);
      note([{ message: TIME_RANGE_TOAST, adjusted: [SQS] }], result);
      return;
    }
    // Held until a time is typed: what fields still hold is written first, so the choice belongs to the text then.
    flushHeldEdits();
    setHeld({ keys: modeKeys((path) => readLatest(form, path)), load: useEditorStore.getState().loadCount, nodeId: form.nodeId });
  };

  const missingTimeRange = mode === "time_range" && (isBlank(form.read(["starttime"])) || isBlank(form.read(["endtime"])));

  const layoutCount = [
    isSet(form.read(at("s3_partition_format"))),
    isSet(form.read(at("s3_partition_timezone"))),
    isSet(form.read(at("file_prefix"))),
    form.read(at("file_prefix_include_telemetry_type")).value === false,
  ].filter(Boolean).length;
  const encodingCount = listLength(form.read(["encodings"]));
  const lifecycleCount = [at("tag_object_after_ingestion"), at("skip_ingesting_tagged_objects")].filter((path) =>
    isTruthy(form.read(path)),
  ).length;

  return (
    <div className="space-y-4">
      <TextField
        path={at("region")}
        id="awss3r-region"
        label="Region"
        defaultValue="us-east-1"
        description="AWS region of the bucket."
      />

      <TextField path={at("s3_bucket")} id="awss3r-bucket" label="Bucket" required placeholder="e.g. ${env:AWS_S3_BUCKET}" />

      <TextField
        path={at("s3_prefix")}
        id="awss3r-prefix"
        label="Prefix"
        description="Key prefix to read under (the folder the exporter wrote into)."
        placeholder="e.g. telemetry"
      />

      <ConfigField
        label="Ingest Mode"
        htmlFor="awss3r-mode"
        description="Continuous ingest from bucket notifications, or a one-shot replay of a time range. The collector rejects both at once."
      >
        <Select value={mode} onValueChange={(value) => setMode(value as IngestMode)} disabled={form.disabled}>
          <SelectTrigger id="awss3r-mode">
            <SelectValue placeholder="Select mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sqs">SQS notifications (continuous)</SelectItem>
            <SelectItem value="time_range">Time range (one-shot replay)</SelectItem>
          </SelectContent>
        </Select>
      </ConfigField>

      {mode === "time_range" && (
        <>
          <TimeRangeScope>
            <div className="grid grid-cols-2 gap-2">
              <TextField
                path={["starttime"]}
                id="awss3r-starttime"
                label="Start Time"
                required
                description="RFC3339, YYYY-MM-DD HH:MM, or YYYY-MM-DD (00:00)."
                placeholder="2024-01-01 01:00"
                className="font-mono text-xs"
              />
              <TextField
                path={["endtime"]}
                id="awss3r-endtime"
                label="End Time"
                required
                placeholder="2024-01-02"
                className="font-mono text-xs"
              />
            </div>
          </TimeRangeScope>
          {missingTimeRange && (
            <InlineAlert variant="warn" title="Both times are required">
              Time-range mode needs a start and an end time; the receiver walks the partitioned keys between them and then stops.
            </InlineAlert>
          )}
        </>
      )}

      {mode === "sqs" && (
        <FormScope path={SQS}>
          <TextField
            path={["queue_url"]}
            id="awss3r-queue-url"
            label="SQS Queue URL"
            required
            description="Queue that receives the bucket's s3:ObjectCreated event notifications."
            placeholder="https://sqs.us-east-1.amazonaws.com/123456789012/otel-s3-events"
            className="font-mono text-xs"
          />
          <div className="grid grid-cols-2 gap-2">
            <TextField path={["region"]} id="awss3r-sqs-region" label="SQS Region" required placeholder="us-east-1" />
            <TextField
              path={["endpoint"]}
              id="awss3r-sqs-endpoint"
              label="SQS Endpoint"
              description="Override for local testing."
              placeholder="http://localstack:4566"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              path={["wait_time_seconds"]}
              id="awss3r-sqs-wait"
              label="Long-Poll Wait"
              defaultValue="20"
              description="Seconds, 0 to 20."
            />
            <NumberField
              path={["max_number_of_messages"]}
              id="awss3r-sqs-max"
              label="Messages Per Poll"
              defaultValue="10"
              description="1 to 10."
            />
          </div>
        </FormScope>
      )}

      <InlineAlert variant="info" title="Credentials">
        Taken from the AWS SDK default chain (env vars, instance or task role, IRSA, shared config). Never part of this
        configuration.
      </InlineAlert>

      <ConfigSection title="Object Layout" count={layoutCount}>
        <TextField
          path={at("s3_partition_format")}
          id="awss3r-partition-format"
          label="Partition Format"
          defaultValue="year=%Y/month=%m/day=%d/hour=%H/minute=%M"
          description="strftime layout of the time-based key segment. Must match what the writer used."
          className="font-mono text-xs"
        />

        <TextField
          path={at("s3_partition_timezone")}
          id="awss3r-partition-tz"
          label="Partition Timezone"
          defaultValue="Local"
          description="IANA zone the partition was written in, e.g. UTC."
        />

        <TextField
          path={at("file_prefix")}
          id="awss3r-file-prefix"
          label="File Prefix"
          description="Object file-name prefix the writer used."
          placeholder="e.g. otel-"
        />

        <CheckboxField
          path={at("file_prefix_include_telemetry_type")}
          id="awss3r-include-type"
          label="Expect Telemetry Type in File Prefix"
          description={
            <>
              Look for <span className="font-mono">traces_</span>, <span className="font-mono">metrics_</span>,{" "}
              <span className="font-mono">logs_</span> in the key (the AWS S3 exporter writes these). Turn off for objects written
              by other tools.
            </>
          }
          defaultChecked={true}
          checkedRemoves
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Encodings" count={encodingCount}>
        <p className="text-[11px] leading-4 text-muted-foreground">
          OTLP JSON (<span className="font-mono">.json</span>) and OTLP Protobuf (<span className="font-mono">.binpb</span>) are
          decoded out of the box. Map other key suffixes to encoding extensions here.
        </p>
        <p className="text-[11px] leading-4 text-muted-foreground">{SUFFIX_HINT}</p>

        <EncodingsField />
      </ConfigSection>

      <ConfigSection title="Object Lifecycle" count={lifecycleCount}>
        <CheckboxField
          path={at("tag_object_after_ingestion")}
          id="awss3r-tag-after"
          label="Tag Objects After Ingestion"
          description={
            <>
              Best-effort <span className="font-mono">otel-collector:status=ingested</span> tag for lifecycle rules. Needs{" "}
              <span className="font-mono">s3:PutObjectTagging</span>; collector v0.150 or newer.
            </>
          }
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-sm"
        />

        <CheckboxField
          path={at("skip_ingesting_tagged_objects")}
          id="awss3r-skip-tagged"
          label="Skip Already-Tagged Objects"
          description={
            <>
              Use the tag as a checkpoint so restarts do not re-ingest. Needs{" "}
              <span className="font-mono">s3:GetObjectTagging</span>; collector v0.151 or newer.
            </>
          }
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Connection">
        <TextField
          path={at("endpoint")}
          id="awss3r-endpoint"
          label="Endpoint"
          description="S3 endpoint override for MinIO, LocalStack, or VPC endpoints."
          placeholder="e.g. http://minio:9000"
        />

        <TextField
          path={at("endpoint_partition_id")}
          id="awss3r-partition-id"
          label="Endpoint Partition"
          defaultValue="aws"
          description="AWS partition id used with a custom endpoint (aws, aws-cn, aws-us-gov)."
        />

        <CheckboxField
          path={at("s3_force_path_style")}
          id="awss3r-force-path-style"
          label="Force Path-Style Addressing"
          description="Use bucket-in-path URLs. Needed by most S3-compatible stores."
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-sm"
        />

        <FormScope path={["notifications"]} prune>
          <TextField
            path={["opampextension"]}
            id="awss3r-opamp"
            label="OpAMP Progress Notifications"
            description="Id of an opamp extension that receives time-range ingest status (ingesting / failed / completed) as custom messages."
            placeholder="opamp"
          />
        </FormScope>
      </ConfigSection>
    </div>
  );
}

// ── Encodings ──

const ENCODINGS: ValuePath = ["encodings"];

/** The held encoding's key order: extension, then suffix. */
const ENCODING_SEED = { extension: undefined, suffix: undefined };

const hasExtension = (item: unknown) =>
  item !== null &&
  typeof item === "object" &&
  typeof (item as { extension?: unknown }).extension === "string" &&
  (item as { extension: string }).extension !== "";

/** A Radix popover's portalled wrapper (the `$` picker), as `DimensionListField` finds one. */
const POPPER_WRAPPER = "[data-radix-popper-content-wrapper]";

/** `encodings[]{extension, suffix}` (`config.go:58-64`): a row per item, a held row for Add Encoding. */
function EncodingsField() {
  const form = useForm();
  const view = form.read(ENCODINGS);
  const items = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(items);
  const held = useHeldItem(ENCODINGS, { cards, ready: hasExtension });

  if (view.kind !== "list" && view.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }

  // The last item takes `encodings` with it.
  const removeItem = (index: number) => {
    const result = items.length === 1 ? form.remove(ENCODINGS) : form.remove([...ENCODINGS, index]);
    if (result === "written") cards.remove(index);
  };

  const rows = cards.keys.map((key, index) => <EncodingRow key={key} index={index} onRemove={() => removeItem(index)} />);
  if (held.held) {
    rows.push(
      <EncodingRow
        key={cards.next}
        index={items.length}
        held={held}
        onRemove={held.drop}
        onLeave={() => {
          if (held.empty()) held.drop();
        }}
      />,
    );
  }

  return (
    <>
      {rows}
      <Button type="button" variant="outline" size="sm" onClick={() => held.hold()} className="w-full" disabled={form.disabled}>
        <Plus className="h-4 w-4 mr-2" />
        Add Encoding
      </Button>
    </>
  );
}

function EncodingRow({
  index,
  held,
  onRemove,
  onLeave,
}: {
  index: number;
  held?: HeldItem;
  onRemove: () => void;
  onLeave?: () => void;
}) {
  return (
    <ItemScope listPath={ENCODINGS} index={index} held={held} seed={ENCODING_SEED}>
      <EncodingFields index={index} held={held !== undefined} onRemove={onRemove} {...(onLeave ? { onLeave } : {})} />
    </ItemScope>
  );
}

function EncodingFields({ index, held, onRemove, onLeave }: { index: number; held: boolean; onRemove: () => void; onLeave?: () => void }) {
  const form = useForm();
  const formRef = useRef(form);
  formRef.current = form;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const item = form.read([]);
  const extension = lineOf(form.read(["extension"]));
  const suffix = lineOf(form.read(["suffix"]));
  const showable = (item.kind === "map" || item.kind === "absent") && extension !== null && suffix !== null;

  /** A field cleared removes its key; an item left with none is removed (never `{}`). The held row's waits. */
  const write = (key: "extension" | "suffix") => (typed: string) => {
    const current = formRef.current;
    if (typed !== "") {
      current.set([key], typed);
      return;
    }
    const value = current.read([]);
    const others = value.kind === "map" ? Object.keys(value.value).filter((other) => other !== key) : [];
    if (held || others.length > 0) current.remove([key]);
    else onRemoveRef.current();
  };
  const extensionText = useHeldText(showable ? (extension ?? "") : "", write("extension"));
  const suffixText = useHeldText(showable ? (suffix ?? "") : "", write("suffix"));
  const readOnly = form.disabled || !showable;

  return (
    <>
      <div
        className="grid grid-cols-[1fr_1fr_auto] gap-2"
        onBlur={(e) => {
          // After the field's own blur wrote what it held; focus moving within the row, or into its `$` picker, keeps it.
          const to = e.relatedTarget;
          if (!onLeave || (to instanceof Node && e.currentTarget.contains(to))) return;
          if (to instanceof Element && to.closest(POPPER_WRAPPER) !== null) return;
          onLeave();
        }}
      >
        <VaultAwareInput
          aria-label={`Encoding ${index + 1} extension`}
          value={extensionText.value}
          onChange={(e) => extensionText.change(e.target.value)}
          onBlur={extensionText.flush}
          onKeyDown={(e) => extensionText.handleKeyDown(e)}
          placeholder="text_encoding"
          className="font-mono text-xs"
          disabled={readOnly}
        />
        <VaultAwareInput
          aria-label={`Encoding ${index + 1} suffix`}
          value={suffixText.value}
          onChange={(e) => suffixText.change(e.target.value)}
          onBlur={suffixText.flush}
          onKeyDown={(e) => suffixText.handleKeyDown(e)}
          placeholder=".txt"
          className="font-mono text-xs"
          disabled={readOnly}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Remove encoding"
          onClick={() => {
            // What a row still holds belongs to its index, which the removal shifts: written first.
            flushHeldEdits();
            onRemoveRef.current();
          }}
          className="shrink-0"
          disabled={form.disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}
