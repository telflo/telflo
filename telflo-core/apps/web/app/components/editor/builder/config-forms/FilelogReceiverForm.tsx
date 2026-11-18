import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormProvider,
  formSource,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
} from "./form-context.js";
import { OperatorPipeline } from "./operators/OperatorPipeline.js";
import { useAdjustments, type Adjustments } from "./shared/AdjustmentAlert.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { KeyValueMapField, type KeyValueNouns } from "./shared/KeyValueMapField.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import type { ValuesResult } from "~/lib/stores/editor-store.js";

/*
 * The filelog receiver's form (ADR 0018), over the form's fields (D9c
 * decision 2, D9b's contract): each field writes its own key. Collector
 * claims cite contrib v0.162.0 (`pkg/stanza/fileconsumer/` unless named).
 *
 * - Kept (Parity Notes): Add Path and Add Exclusion append seeds,
 *   `/var/log/*.log` and `/var/log/excluded/*.log` (`MultiValueField`'s
 *   `addValue`); removing the last row removes the key. Clearing a row
 *   writes `""`. Include is required (`matcher/matcher.go:63-65`): the
 *   asterisk is hand-made.
 * - Kept: the multiline box is on while a `multiline` block is there;
 *   ticking it writes `{line_start_pattern: ""}` (the collector splits on
 *   newlines while both patterns are empty, `split/split.go:57-59`), and
 *   unticking removes the block. Typing one pattern removes the other in
 *   the same change (`TextField`'s `excludes`; the collector refuses both,
 *   `split.go:77`), and a pattern is disabled while the other is set and it
 *   isn't (with both in the text, both stay editable, so either can be
 *   kept; the seed's empty start pattern disables nothing). Cleared, a
 *   pattern removes its key. The box's state is read from the text, so a
 *   YAML edit adding or removing the block shows.
 * - Fixed (D9c decisions 3 and 9): Resource and Log Attributes are
 *   `KeyValueMapField`s (`"rows"`): Add holds a row until its key is typed
 *   (never writing `"": ""`), a key is renamed in place on blur or Enter,
 *   and a key another row has is refused under the row with "An attribute
 *   with this key already exists." (never collapsing the two). Both are
 *   read from the text, never from refs taken once, so the next attribute
 *   edit never writes a stale map back over a YAML edit.
 * - Fixed (D9c decision 7): the collector refuses Delete file after reading
 *   with `start_at: end` (`config.go:246-253`), and a multiline pattern with
 *   the `nop` encoding (`split/split.go:47-55`). Ticking Delete file after
 *   reading sets Start Position to Beginning when it isn't, choosing End
 *   unticks Delete file after reading (writes `false`, as unticking does),
 *   choosing "No validation (raw bytes)" removes the multiline block when it
 *   holds a pattern (an empty one splits nothing; Ruling 76), and ticking
 *   the multiline box or typing a pattern while the encoding is raw bytes
 *   removes the encoding (UTF-8, the collector's default; Ruling 75), each
 *   in the same change (one undo entry), with a toast saying what changed
 *   (D9d decision 7: D9c's inline alerts became toasts).
 * - The "Deletes source files" alert is a hint under Delete file after
 *   reading, always shown (D9d decision 7, `DELETE_HINT`).
 * - Copy (D9c decision 4): ASCII is "ASCII (read as UTF-8)": the collector
 *   decodes `ascii` as UTF-8 (`internal/coreinternal/textutils/encoding.go:23-24`).
 * - Unset shows the collector's default (D9b decision 3; `config.go:60-78`,
 *   `reader/factory.go:30-31`, `scanner/scanner.go:15`): Start Position
 *   End, Encoding UTF-8, Compression None, File name ticked
 *   (`IncludeFileName: true`), the rest unticked, as placeholders and
 *   "Default" hints, never as values. Clearing a field removes its key;
 *   None removes `compression`, whose unset shows the placeholder "None"
 *   (the collector's `""`, README), with no "Default" hint.
 *   The numbers are D9b's number fields: `0` can be written and shows, and
 *   no `NaN`.
 * - The Operators section is the operator framework (Task 5) over
 *   `operators`, from file (decision 8).
 *
 * Ids are fixed (`start-at`, `attr-file-name`, …); map rows
 * are keyed by their items, not by index (D9c Ruling 68); no value reaches
 * an attribute (decision 10).
 */

/** Toasted once ticking Delete file after reading set Start Position (decision 7). */
export const START_AT_SET = "Start Position set to Beginning: deleting files needs it.";
/** Toasted once choosing End unticked Delete file after reading (decision 7). */
export const DELETE_UNTICKED = "Unticked Delete file after reading: it needs Start Position: Beginning.";
/** Toasted once choosing raw bytes removed the multiline block (decision 7). */
export const MULTILINE_REMOVED = "Removed the multiline patterns: raw bytes can't be split by pattern.";
/** Toasted once ticking the multiline box or typing a pattern removed the raw-bytes encoding (decision 7; Ruling 75). */
export const ENCODING_RESET = "Encoding set to UTF-8: raw bytes can't be split by pattern.";

/**
 * The hint under Delete file after reading, always shown (D9d decision 7):
 * the gate is at stage beta, on by default, at v0.162.0
 * (`pkg/stanza/fileconsumer/internal/metadata/generated_feature_gates.go`).
 */
export const DELETE_HINT = "Deletes each file once it's read. Needs the filelog.allowFileDeletion feature gate (on by default).";

/** Whether the encoding is raw bytes, as the collector looks it up (lower-cased, `textutils/encoding.go:28-31`). */
function isNop(view: ValueView): boolean {
  return view.kind === "scalar" && typeof view.value === "string" && view.value.toLowerCase() === "nop";
}

/** Resource and Log Attributes: their rows' words (decision 9). */
export const ATTRIBUTE_NOUNS: KeyValueNouns = {
  key: "key",
  value: "value",
  addLabel: "Add Attribute",
  removeLabel: "Remove",
  exists: "An attribute with this key already exists.",
};

const START_POSITIONS = [
  { value: "beginning", label: "Beginning" },
  { value: "end", label: "End" },
] as const;

const ENCODINGS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
  { value: "ascii", label: "ASCII (read as UTF-8)" },
  { value: "big5", label: "Big5" },
  { value: "nop", label: "No validation (raw bytes)" },
] as const;

const COMPRESSIONS = [
  { value: "none", label: "None" },
  { value: "gzip", label: "Gzip" },
  { value: "auto", label: "Auto-detect" },
] as const;

/** The file-attribute boxes: labels, ids and defaults (`IncludeFileName` true, `config.go:73-75`). */
const FILE_ATTRIBUTES = [
  ["include_file_name", "attr-file-name", "File name", true],
  ["include_file_path", "attr-file-path", "File path", false],
  ["include_file_name_resolved", "attr-name-resolved", "Resolved name (symlink)", false],
  ["include_file_path_resolved", "attr-path-resolved", "Resolved path (symlink)", false],
  ["include_file_owner_name", "attr-owner", "File owner (Unix)", false],
  ["include_file_owner_group_name", "attr-group", "Owner group (Unix)", false],
  ["include_file_record_number", "attr-record-num", "Record number", false],
  ["include_file_record_offset", "attr-record-offset", "Record offset", false],
] as const;

/** The path rows: `font-mono text-xs` inputs. */
const PATH_INPUT = "flex-1 font-mono text-xs";

/** A mapping's key count. */
function keyCount(view: ValueView): number {
  return view.kind === "map" ? Object.keys(view.value).length : 0;
}

export function FilelogReceiverForm() {
  const form = useForm();
  const adjustments = useAdjustments();
  /** The empty state: no list, or an empty one (a value the rows can't show has the hint instead). */
  const noItems = (view: ValueView) => view.kind === "absent" || (view.kind === "list" && view.value.length === 0);
  const operatorCount = listLength(form.read(["operators"]));
  const metadataCount = keyCount(form.read(["resource"])) + keyCount(form.read(["attributes"]));
  const deleting = form.read(["delete_after_read"]).value === true;

  /** decision 7: End can't be used with Delete file after reading (`config.go:250-252`). */
  const chooseStartAt = (value: string) => {
    const changes: ValueChange[] = [{ path: ["start_at"], value }];
    const unticks = value === "end" && deleting;
    if (unticks) changes.push({ path: ["delete_after_read"], value: false });
    const result = form.apply(changes);
    if (unticks) adjustments.note([DELETE_UNTICKED], result);
  };

  /** decision 7: deleting files needs Start Position: Beginning (`config.go:246-253`). */
  const toggleDelete = (on: boolean) => {
    const startAt = form.read(["start_at"]);
    const sets = on && !(startAt.kind === "scalar" && startAt.value === "beginning");
    const changes: ValueChange[] = [{ path: ["delete_after_read"], value: on }];
    if (sets) changes.push({ path: ["start_at"], value: "beginning" });
    const result = form.apply(changes);
    if (sets) adjustments.note([START_AT_SET], result);
  };

  /** decision 7: raw bytes can't be split by a pattern (`split/split.go:47-55`); an empty pattern splits nothing (Ruling 76). */
  const chooseEncoding = (value: string) => {
    const changes: ValueChange[] = [{ path: ["encoding"], value }];
    const removes =
      value === "nop" &&
      (isTruthy(form.read(["multiline", "line_start_pattern"])) || isTruthy(form.read(["multiline", "line_end_pattern"])));
    if (removes) changes.push({ path: ["multiline"], remove: true });
    const result = form.apply(changes);
    if (removes) adjustments.note([MULTILINE_REMOVED], result);
  };

  return (
    <div className="space-y-4">
      {/* Include Paths */}
      <div className="space-y-2">
        <Label className="text-[13px] font-medium text-foreground">
          Include Paths
          <span aria-hidden className="ml-0.5 text-fail">
            *
          </span>
        </Label>

        {noItems(form.read(["include"])) && (
          <p className="text-[11px] leading-4 text-muted-foreground">No include paths configured</p>
        )}

        <MultiValueField
          path={["include"]}
          placeholder="e.g. /var/log/*.log"
          addButtonText="Add Path"
          addValue="/var/log/*.log"
          helpText="Glob patterns of files to tail."
          vaultAware
          emptyRemovesKey
          inputClassName={PATH_INPUT}
          addIconClassName="w-4 h-4 mr-1"
        />
      </div>

      {/* Exclude Paths */}
      <div className="space-y-2">
        <Label className="text-[13px] font-medium text-foreground">Exclude Paths</Label>

        {noItems(form.read(["exclude"])) && (
          <p className="text-[11px] leading-4 text-muted-foreground">No exclusions configured</p>
        )}

        <MultiValueField
          path={["exclude"]}
          placeholder="e.g. /var/log/debug*.log"
          addButtonText="Add Exclusion"
          addValue="/var/log/excluded/*.log"
          vaultAware
          emptyRemovesKey
          inputClassName={PATH_INPUT}
          addIconClassName="w-4 h-4 mr-1"
        />
      </div>

      <SelectField
        path={["start_at"]}
        id="start-at"
        label="Start Position"
        defaultValue="end"
        description="End reads only new lines; beginning reads whole files."
        options={START_POSITIONS}
        onSelect={chooseStartAt}
      />

      <SelectField path={["encoding"]} id="encoding" label="Encoding" defaultValue="utf-8" options={ENCODINGS} onSelect={chooseEncoding} />

      <div className="grid grid-cols-2 gap-2">
        <DurationField path={["poll_interval"]} id="poll-interval" label="Poll Interval" defaultValue="200ms" />

        <NumberField path={["max_concurrent_files"]} id="max-concurrent" label="Max Concurrent Files" defaultValue="1024" />
      </div>

      <DurationField
        path={["exclude_older_than"]}
        id="exclude-older"
        label="Exclude Older Than"
        description="Ignore files last modified longer ago than this."
        placeholder="e.g. 24h"
      />

      <ConfigSection title="Operators" count={operatorCount}>
        <OperatorPipeline path={["operators"]} source="file" />
      </ConfigSection>

      <ConfigSection title="Multiline Parsing">
        <MultilineSection adjustments={adjustments} />
      </ConfigSection>

      <ConfigSection title="Performance & Limits">
        <div className="grid grid-cols-2 gap-2">
          <TextField path={["max_log_size"]} id="max-log-size" label="Max Log Size" defaultValue="1MiB" />

          <TextField
            path={["fingerprint_size"]}
            id="fingerprint-size"
            label="Fingerprint Size"
            defaultValue="1kb"
            description="Bytes used to identify each file."
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <DurationField
            path={["force_flush_period"]}
            id="flush-period"
            label="Force Flush Period"
            defaultValue="500ms"
            description="Emit partial logs after this long without new data."
          />

          <NumberField
            path={["max_batches"]}
            id="max-batches"
            label="Max Batches"
            defaultValue="0 (unlimited)"
            description="Batches emitted per poll cycle."
            placeholder="0"
          />
        </div>

        <TextField path={["initial_buffer_size"]} id="buffer-size" label="Initial Buffer Size" defaultValue="16KiB" />

        <CheckboxField
          path={["preserve_leading_whitespaces"]}
          id="preserve-leading"
          label="Preserve leading whitespaces"
          defaultChecked={false}
          labelClassName="text-sm"
        />

        <CheckboxField
          path={["preserve_trailing_whitespaces"]}
          id="preserve-trailing"
          label="Preserve trailing whitespaces"
          defaultChecked={false}
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Storage & File Handling">
        <TextField
          path={["storage"]}
          id="storage"
          label="Storage Extension ID"
          description="Extension that persists read offsets across restarts."
          placeholder="e.g. file_storage"
        />

        <SelectField
          path={["compression"]}
          id="compression"
          label="Compression"
          placeholder="None"
          options={COMPRESSIONS}
          onSelect={(value) => {
            if (value !== "none") form.set(["compression"], value);
            else if (form.read(["compression"]).kind !== "absent") form.remove(["compression"]);
          }}
        />

        <CheckboxField
          path={["delete_after_read"]}
          id="delete-after-read"
          label="Delete file after reading"
          defaultChecked={false}
          labelClassName="text-sm"
          description={DELETE_HINT}
          onToggle={toggleDelete}
        />

        <CheckboxField
          path={["acquire_fs_lock"]}
          id="fs-lock"
          label="Acquire filesystem lock (Unix only)"
          defaultChecked={false}
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Metadata" count={metadataCount}>
        {/* File Attributes */}
        <div className="space-y-2">
          <div className="space-y-0.5">
            <Label className="text-[13px] font-medium text-foreground">File Attributes</Label>
            <p className="text-[11px] leading-4 text-muted-foreground">Attach file metadata to each log record.</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {FILE_ATTRIBUTES.map(([key, id, label, defaultChecked]) => (
              <CheckboxField
                key={key}
                path={[key]}
                id={id}
                label={label}
                defaultChecked={defaultChecked}
                labelClassName="text-sm"
              />
            ))}
          </div>
        </div>

        {/* Resource Attributes */}
        <KeyValueMapField
          path={["resource"]}
          layout="rows"
          nouns={ATTRIBUTE_NOUNS}
          title="Resource Attributes"
          emptyText="No resource attributes configured"
        />

        {/* Log Attributes */}
        <KeyValueMapField
          path={["attributes"]}
          layout="rows"
          nouns={ATTRIBUTE_NOUNS}
          title="Log Attributes"
          emptyText="No log attributes configured"
        />
      </ConfigSection>
    </div>
  );
}

/**
 * Multiline Parsing: the box is on while a `multiline` block is there
 * (read from the text); a
 * `multiline` that isn't a mapping is read-only with decision 3's hint.
 */
function MultilineSection({ adjustments }: { adjustments: Adjustments }) {
  const form = useForm();
  /** decision 7 (Ruling 75): a pattern can't be used with raw bytes (`split/split.go:47-55`): the encoding goes with it. */
  const withEncodingReset = (changes: ValueChange[]): ValuesResult => {
    const resets = isNop(form.read(["encoding"]));
    const result = form.apply(resets ? [...changes, { path: ["encoding"], remove: true }] : changes);
    if (resets) adjustments.note([ENCODING_RESET], result);
    return result;
  };
  // The patterns write through the block's scope; a pattern typed while the encoding is raw bytes also removes it.
  // (Built each render: the fields write through the source they last rendered with.)
  const scoped = formSource(
    (inner) => form.read(["multiline", ...inner]),
    (changes) => {
      const mapped = changes.map((change) => ({ ...change, path: ["multiline", ...change.path] }));
      const pattern = changes.some(
        (change) =>
          "value" in change && (change.path[0] === "line_start_pattern" || change.path[0] === "line_end_pattern") && change.value !== "",
      );
      return pattern ? withEncodingReset(mapped) : form.apply(mapped);
    },
    form.disabled,
  );
  const view = form.read(["multiline"]);
  const state = view.kind === "absent" ? "off" : view.kind === "map" ? "on" : "unshowable";
  // Truthiness: the seed's empty start pattern disables nothing.
  const start = isTruthy(form.read(["multiline", "line_start_pattern"]));
  const end = isTruthy(form.read(["multiline", "line_end_pattern"]));

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Checkbox
            id="multiline-enable"
            checked={state === "on"}
            onCheckedChange={(checked) => {
              if ((checked === true) === (state === "on")) return;
              if (checked === true) withEncodingReset([{ path: ["multiline"], value: { line_start_pattern: "" } }]);
              else form.remove(["multiline"]);
            }}
            disabled={form.disabled || state === "unshowable"}
          />
          <Label htmlFor="multiline-enable" className="text-sm font-medium">
            Enable multiline parsing
          </Label>
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">Join lines into one entry by pattern.</p>
        {state === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </div>

      {state === "on" && (
        <FormProvider form={scoped}>
          <TextField
            path={["line_start_pattern"]}
            id="line-start"
            label="Line Start Pattern"
            description="Regex matching the first line of each entry."
            placeholder="e.g. ^\d{4}-\d{2}-\d{2}"
            className="font-mono text-xs"
            excludes={["line_end_pattern"]}
            disabled={end && !start}
          />

          <div className="text-center text-xs text-muted-foreground">OR</div>

          <TextField
            path={["line_end_pattern"]}
            id="line-end"
            label="Line End Pattern"
            description="Regex matching the last line of each entry."
            placeholder="e.g. \\n$"
            className="font-mono text-xs"
            excludes={["line_start_pattern"]}
            disabled={start && !end}
          />

          <CheckboxField
            path={["omit_pattern"]}
            id="omit-pattern"
            label="Omit pattern from log entry"
            defaultChecked={false}
            labelClassName="text-sm"
          />
        </FormProvider>
      )}
    </>
  );
}
