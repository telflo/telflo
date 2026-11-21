import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  FormProvider,
  formSource,
  MultiValueField,
  RadioField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { OperatorPipeline } from "./operators/OperatorPipeline.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { KeyValueMapField, type KeyValueNouns } from "./shared/KeyValueMapField.js";
import { StanzaRetrySection } from "./shared/StanzaRetrySection.js";
import { Button } from "~/components/ui/button.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import type { ValuesResult } from "~/lib/stores/editor-store.js";

/*
 * The journald receiver's form, over the form's fields: each field writes its
 * own key. Collector claims cite contrib v0.162.0
 * (`pkg/stanza/operator/input/journald/` unless named).
 *
 * - Add unit, Add identifier and Add file append seeds (`ssh`, `sudo`,
 *   `/var/log/journal/system.journal`), and removing a list's last row removes
 *   its key (`StringListField`). The boxes write `true` or remove their key
 *   (`CheckboxField`'s `uncheckedRemoves`). Start At is native radios
 *   (`RadioField`), End checked while unset (`config_all.go:19-24`).
 * - Add match holds a new match, `_SYSTEMD_UNIT` with no value, until a
 *   value is typed in it: never `_SYSTEMD_UNIT: ""` at once, which
 *   journalctl reads as "an empty unit" (`config_linux.go:155-192` passes
 *   `_SYSTEMD_UNIT=`). The held match is a card like the others, reading a
 *   source of its own (the fields it holds); the first value typed writes
 *   the match, as the list's last item, and the card becomes that item's in
 *   place (the same card key, so the input keeps focus and caret). Its
 *   field names can be renamed and fields added before then; only fields
 *   with a value are written, and Remove match drops it. It is a held row:
 *   dropped when the list's length changes, the form goes or a
 *   configuration loads.
 * - Each match's fields are a `KeyValueMapField` (`"rows"`,
 *   `holdUntilValue`): Add field holds a row until both its name and its
 *   value are typed (never a `""` key; a name alone would write `_UID: ""`,
 *   which matches entries whose field is empty), a field is renamed in place
 *   on blur or Enter, and a name another field of the match has is refused
 *   under the row with "A field with this name already exists." (never
 *   merging the two). Removing a match's last field leaves `{}`. A name the
 *   collector refuses (`^[_A-Z]+$`, `config_linux.go:155-165`) is written as
 *   typed, for the config validation to report. The rows keep their classes
 *   (`flex gap-2` rows, icon-sized remove buttons, a small Add field).
 * - Copy: the Linux-only alert says journalctl Path must be absolute with
 *   root_path (`config_linux.go:65-68` refuses a relative one); Files says
 *   it's ignored while Directory is set (`config_linux.go:127-134` passes
 *   `--directory` alone).
 * - Retry on Failure is the stanza receivers' section (`StanzaRetrySection`):
 *   off while unset, its intervals' defaults as placeholders (never as
 *   values), no `multiplier`.
 * - Unset shows the collector's default (`config_all.go:19-24`):
 *   Priority info and journalctl Path journalctl as placeholders and hints.
 *   Clearing a field removes its key.
 * - The Operators section is the operator framework over `operators`, from
 *   journal.
 *
 * Ids are fixed (`priority`, `dmesg`, …; the radios `start_at-<index>`, the
 * datalist `priority-options`); match cards and rows are keyed by card key
 * and index; no value reaches an attribute.
 */

/** The Linux-only alert's last sentence. */
export const JOURNALCTL_ABSOLUTE = "and give journalctl Path as an absolute path.";
/** Files' hint. */
export const FILES_HINT = "Read specific journal files instead of a directory. Ignored while Directory is set.";

/** A match's rows' words. */
export const MATCH_NOUNS: KeyValueNouns = {
  key: "_SYSTEMD_UNIT",
  value: "ssh.service",
  addLabel: "Add field",
  removeLabel: "Remove field",
  exists: "A field with this name already exists.",
};

/** The field a held match starts with (Add match). */
const HELD_MATCH_FIELD = "_SYSTEMD_UNIT";

const START_AT = [
  { value: "end", label: "End" },
  { value: "beginning", label: "Beginning" },
] as const;

/** journalctl's priorities (the datalist). */
const PRIORITIES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"] as const;

/** The journald boxes: a `space-y-1.5` block, `cursor-pointer text-sm` labels, the hint unindented. */
const BOX = {
  className: "space-y-1.5",
  labelClassName: "cursor-pointer text-sm",
  hintClassName: "text-[11px] leading-4 text-muted-foreground",
  defaultChecked: false,
  uncheckedRemoves: true,
} as const;

const ABSENT: ValueView = { kind: "absent", value: undefined };

export function JournaldReceiverForm() {
  const form = useForm();
  const filteringCount =
    listLength(form.read(["units"])) +
    listLength(form.read(["identifiers"])) +
    listLength(form.read(["matches"])) +
    (isTruthy(form.read(["grep"])) ? 1 : 0) +
    (isTruthy(form.read(["dmesg"])) ? 1 : 0);

  return (
    <div className="space-y-4">
      <InlineAlert variant="info" title="Linux only">
        The receiver shells out to <span className="font-mono">journalctl</span>, so the collector needs that binary and
        read access to the journal. In a container, mount <span className="font-mono">/var/log/journal</span> and{" "}
        <span className="font-mono">/run/log/journal</span> and point <span className="font-mono">root_path</span> at the
        host mount, {JOURNALCTL_ABSOLUTE}
      </InlineAlert>

      <RadioField
        path={["start_at"]}
        id="start_at"
        label="Start At"
        defaultValue="end"
        description="Where to begin on first start. 'beginning' replays the whole journal."
        options={START_AT}
      />

      <TextField
        path={["priority"]}
        id="priority"
        label="Priority"
        defaultValue="info"
        description="Keep entries at this level or more severe. Accepts a range like info..err."
        datalist={PRIORITIES}
      />

      <ConfigSection title="Filtering" count={filteringCount}>
        <JournaldList
          path={["units"]}
          label="Units"
          description="systemd units to read. Empty reads every unit."
          placeholder="e.g. ssh"
          addLabel="Add unit"
          sampleValue="ssh"
        />

        <JournaldList
          path={["identifiers"]}
          label="Identifiers"
          description="Filter on SYSLOG_IDENTIFIER."
          placeholder="e.g. sudo"
          addLabel="Add identifier"
          sampleValue="sudo"
        />

        <ConfigField
          label="Matches"
          description="Journal-field filters. Fields within a match are ANDed; separate matches are ORed."
        >
          <Matches />
        </ConfigField>

        <TextField
          path={["grep"]}
          id="grep"
          label="Grep"
          description="Regex matched against the MESSAGE field."
          placeholder="e.g. (failed|denied)"
        />

        <CheckboxField
          path={["dmesg"]}
          id="dmesg"
          label="Kernel Messages Only"
          description={
            <>
              Equivalent to <span className="font-mono">journalctl --dmesg</span>.
            </>
          }
          {...BOX}
        />
      </ConfigSection>

      <ConfigSection title="Journal Source">
        <TextField
          path={["directory"]}
          id="directory"
          label="Directory"
          description="Journal directory, relative to Root Path. Leave empty to let journalctl pick /run and /var."
          placeholder="e.g. /var/log/journal"
        />

        <JournaldList
          path={["files"]}
          label="Files"
          description={FILES_HINT}
          placeholder="e.g. /var/log/journal/.../system.journal"
          addLabel="Add file"
          sampleValue="/var/log/journal/system.journal"
        />

        <TextField
          path={["root_path"]}
          id="root_path"
          label="Root Path"
          description="Chroot the journal read - set this to the host mount when the collector runs in a container."
          placeholder="e.g. /host"
        />

        <TextField
          path={["namespace"]}
          id="namespace"
          label="Namespace"
          description="Read a specific systemd journal namespace."
          placeholder="e.g. my-namespace"
        />

        <TextField
          path={["journalctl_path"]}
          id="journalctl_path"
          label="journalctl Path"
          defaultValue="journalctl"
          description="Absolute path when the binary is not on PATH."
        />

        <CheckboxField
          path={["merge"]}
          id="merge"
          label="Merge Journals"
          description="Read from every available journal, including remote and user ones."
          {...BOX}
        />
      </ConfigSection>

      <ConfigSection title="Operators" count={listLength(form.read(["operators"]))}>
        <OperatorPipeline path={["operators"]} source="journal" />
      </ConfigSection>

      <ConfigSection title="Record Shaping">
        <CheckboxField
          path={["all"]}
          id="all"
          label="Include All Entries"
          description="Keep very long and unprintable entries that journalctl elides by default."
          {...BOX}
        />

        <CheckboxField
          path={["convert_message_bytes"]}
          id="convert_message_bytes"
          label="Convert Message Bytes"
          description="Decode a byte-array MESSAGE into a string instead of leaving it as numbers."
          {...BOX}
        />
      </ConfigSection>

      <ConfigSection title="Storage">
        <TextField
          path={["storage"]}
          id="storage"
          label="Storage Extension ID"
          description="Extension that persists the journal cursor across restarts, e.g. file_storage."
          placeholder="e.g. file_storage"
        />
      </ConfigSection>

      <ConfigSection title="Retry on Failure">
        <StanzaRetrySection path={["retry_on_failure"]} />
      </ConfigSection>
    </div>
  );
}

/**
 * A `StringListField` (units, identifiers, files): editable rows, Add
 * appending the sample value, the last row's removal removing the key, each
 * remove button labeled `Remove <label> entry` (the fixed label).
 */
function JournaldList({
  path,
  label,
  description,
  placeholder,
  addLabel,
  sampleValue,
}: {
  path: ValuePath;
  label: string;
  description: string;
  placeholder: string;
  addLabel: string;
  sampleValue: string;
}) {
  return (
    <ConfigField label={label} description={description}>
      <MultiValueField
        path={path}
        placeholder={placeholder}
        addButtonText={addLabel}
        addValue={sampleValue}
        removeLabel={`Remove ${label} entry`}
        vaultAware
        emptyRemovesKey
        inputClassName="flex-1 font-mono text-xs"
        addButtonClassName=""
        addIconClassName="mr-1 h-3 w-3"
      />
    </ConfigField>
  );
}

/** A held match's fields, in order, before its first value is typed. */
type HeldFields = readonly (readonly [string, string])[];

/**
 * The matches (`[]map[string]string`): a card per match, the held match's
 * card after them, and Add match. `matches` that isn't a list is read-only
 * with `UNSHOWABLE_VALUE_MESSAGE`.
 */
function Matches() {
  const form = useForm();
  const view = form.read(["matches"]);
  const showable = view.kind === "list" || view.kind === "absent";
  const items = view.kind === "list" ? view.value : [];
  const count = items.length;
  const cards = useCardKeys(items);
  const [held, setHeld] = useState<HeldFields | null>(null);
  // The held match belongs to the list as it was when Add made it: a change of length drops it.
  const [seenCount, setSeenCount] = useState(count);
  if (seenCount !== count) {
    setSeenCount(count);
    setHeld(null);
  }

  const removeMatch = (index: number) => {
    // The last match takes the key with it.
    const result = count === 1 ? form.remove(["matches"]) : form.remove(["matches", index]);
    if (result === "written") cards.remove(index);
  };

  if (!showable) return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;

  const matchCards = cards.keys.map((key, index) => <MatchCard key={key} index={index} onRemove={() => removeMatch(index)} />);
  // The held match's card is the list's last, keyed by the key its match will get: once written, it is that match's card.
  if (held !== null) {
    matchCards.push(
      <MatchCard
        key={cards.next}
        index={count}
        held={{ fields: held, onChange: setHeld, onWritten: cards.add }}
        onRemove={() => setHeld(null)}
      />,
    );
  }

  return (
    <div className="space-y-3">
      {matchCards}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          // What a field still holds is written first; a new held match then shows (one at a time).
          flushHeldEdits();
          setHeld((current) => current ?? [[HELD_MATCH_FIELD, ""]]);
        }}
        disabled={form.disabled}
      >
        <Plus className="mr-1 h-3 w-3" />
        Add match
      </Button>
    </div>
  );
}

/** The held match's fields and what its card reports. */
interface Held {
  fields: HeldFields;
  onChange: (fields: HeldFields | null) => void;
  /** Its match was written: the card takes the key the written item gets. */
  onWritten: () => void;
}

/**
 * A match's card: a header ("Match n", its remove button) over
 * the match's fields. One component whether the match is held or in the
 * text, so a held match's card, once written, is the same card (its input
 * keeps focus and caret): only its source changes.
 */
function MatchCard({ index, held, onRemove }: { index: number; held?: Held; onRemove: () => void }) {
  const form = useForm();
  const source = useMatchSource(form, index, held);
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Match {index + 1}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={`Remove match ${index + 1}`}
          onClick={onRemove}
          disabled={form.disabled}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <FormProvider form={source}>
        <KeyValueMapField
          path={[]}
          layout="rows"
          nouns={MATCH_NOUNS}
          emptyRemovesKey={false}
          rowClassName="flex gap-2"
          removeSize="icon"
          removeClassName="shrink-0"
          addButtonClassName=""
          holdUntilValue
        />
      </FormProvider>
    </div>
  );
}

/**
 * A match's source: in the text, its fields read and write under
 * `matches.<index>` (as `FormScope` does); held, its own fields.
 */
function useMatchSource(form: FormSource, index: number, held: Held | undefined): FormSource {
  return useMemo(
    () =>
      held === undefined
        ? formSource(
            (inner) => form.read(["matches", index, ...inner]),
            (changes) => form.apply(changes.map((change) => ({ ...change, path: ["matches", index, ...change.path] }))),
            form.disabled,
          )
        : heldMatchSource(form, index, held),
    [form, index, held],
  );
}

/**
 * The held match's source: its fields are the card's own until a value is
 * typed; that value writes the match, with its fields, as the list's
 * `index`th item. A name is renamed in the card; removing its last field
 * drops the held match.
 */
function heldMatchSource(form: FormSource, index: number, { fields, onChange, onWritten }: Held): FormSource {
  const read = (path: ValuePath): ValueView => {
    if (path.length === 0) return { kind: "map", value: Object.fromEntries(fields) };
    const found = path.length === 1 ? fields.find(([name]) => name === path[0]) : undefined;
    return found ? { kind: "scalar", value: found[1] } : ABSENT;
  };
  const apply = (changes: readonly ValueChange[]): ValuesResult => {
    let next: HeldFields | null = fields;
    for (const change of changes) {
      const [name] = change.path;
      if (next === null || change.path.length > 1 || (change.path.length === 1 && typeof name !== "string")) return "refused";
      if ("remove" in change) {
        next = change.path.length === 0 ? null : next.filter(([field]) => field !== name);
        if (next?.length === 0) next = null;
      } else if ("renameTo" in change) {
        const renamed = change.renameTo;
        next = next.map(([field, value]): readonly [string, string] => (field === name ? [renamed, value] : [field, value]));
      } else if ("value" in change && typeof name === "string") {
        const value = String(change.value);
        next = next.some(([field]) => field === name)
          ? next.map(([field, current]): readonly [string, string] => (field === name ? [field, value] : [field, current]))
          : [...next, [name, value]];
      } else {
        return "refused";
      }
    }
    // A value typed: the match is written with the fields that have one (a
    // field is held until its name and value are typed; `_UID: ""` would match
    // an empty field). One left without a value isn't written.
    const typed = next?.filter(([, value]) => value !== "") ?? [];
    if (typed.length > 0) {
      const result = form.set(["matches", index], Object.fromEntries(typed));
      if (result === "written") onWritten();
      return result;
    }
    onChange(next);
    return "written";
  };
  return formSource(read, apply, form.disabled);
}
