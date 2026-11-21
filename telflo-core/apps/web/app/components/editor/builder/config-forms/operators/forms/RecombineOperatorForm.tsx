import { ConfigField } from "../../ConfigField.js";
import { DurationField, EscapedTextField, NumberField, SelectField, TextField, useForm } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The recombine operator's form, over the card's scope. Ids are the card's
 * (`op-<index>-recombine-…`).
 *
 * - First Entry Pattern and Last Entry Pattern exclude each other: the
 *   collector takes exactly one (`transformer/recombine/config.go:73-79`), so
 *   typing in one removes the other in the same change, with no alert, as
 *   filelog's multiline patterns do (`TextField`'s `excludes`). Cleared, a
 *   pattern removes its key.
 * - Combine Field shows no default: the collector requires it
 *   (`config.go:97-99`), and the seed writes `body` (`operator-catalog.ts`);
 *   `body` is written, not only shown.
 * - Combine With is escape-aware (`EscapedTextField`): a newline shows as
 *   `\n`, a tab as `\t`, a backslash as `\\`, and typing `\n` writes a
 *   newline, which the text edits double-quote (`"\n"`). The two characters
 *   `\` and `n` (`'\n'`, a literal backslash-n to the collector) are never
 *   written; such a text shows `\\n`, and blurring it writes nothing. Unset
 *   shows the collector's newline (`config.go:24, 43`) as the placeholder `\n`
 *   and "Default \n", not as the value. `combine_with: ""` joins entries with
 *   nothing between them (`recombine.md:16, 45`; the container parser's own
 *   recombine does, `parser/container/config.go:127`), so it shows empty, with
 *   no placeholder or default, and the hint "Empty: entries are joined
 *   directly." under the field (in a `space-y-1.5` block, the grid cell);
 *   clearing it still removes the key.
 * - Max Batch Size takes 0, the collector's "unlimited" (`recombine.md`;
 *   no `min={1}`), and shows "Default 1000" (`config.go:40`).
 * - Max Log Size's default is the collector's 0, no limit (`config.go:63`;
 *   `recombine.md`): placeholder and hint "Default 0 (unlimited)"
 *   (not 1048576). A size with a unit (`1MiB`, a `helper.ByteSize`) is
 *   written as typed (`NumberField`; never `parseInt`'s 1 for
 *   `1MiB`).
 * - Overwrite With's default is the collector's `oldest` (`config.go:44,
 *   101-109`): unset shows "Oldest entry" as its placeholder and "Default
 *   oldest" (not Newest entry).
 *
 * Force Flush Period shows the collector's 5s (`config.go:45`) as its
 * placeholder, and "Default 5s"; Source Identifier shows the collector's
 * `attributes["log.file.path"]` (`config.go:46`;
 * `fileconsumer/attrs/attrs.go:15`) as its placeholders and "Default
 * attributes["log.file.path"]". Cleared, each removes its key.
 */

const SOURCE_DEFAULT = 'attributes["log.file.path"]';
/** The collector's default separator, a newline, as Combine With shows it. */
const NEWLINE_SHOWN = "\\n";

/** Under a Combine With that is `""`. */
export const EMPTY_JOIN_HINT = "Empty: entries are joined directly.";

export function RecombineOperatorForm() {
  const form = useForm();
  const opId = useOperatorId();
  const combineWith = form.read(["combine_with"]);
  const emptyJoin = combineWith.kind === "scalar" && combineWith.value === "";
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          Combine multiple log entries into a single entry. Useful for multiline logs like stack traces or multi-line JSON.
        </p>
      </div>

      <TextField
        path={["is_first_entry"]}
        id={opId("recombine-first")}
        label="First Entry Pattern"
        description="Expression that matches the start of a new log entry."
        placeholder="body matches '^\\d{4}-\\d{2}-\\d{2}'"
        className="font-mono text-xs"
        excludes={["is_last_entry"]}
      />

      <div className="text-center text-xs text-muted-foreground">OR</div>

      <TextField
        path={["is_last_entry"]}
        id={opId("recombine-last")}
        label="Last Entry Pattern"
        description="Expression that matches the end of a log entry."
        placeholder="body matches '\\}$'"
        className="font-mono text-xs"
        excludes={["is_first_entry"]}
      />

      <div className="grid grid-cols-2 gap-4">
        <ConfigField label="Combine Field" description="Field to combine." htmlFor={opId("recombine-field")}>
          <FieldSelector path={["combine_field"]} id={opId("recombine-field")} />
        </ConfigField>

        <div className="space-y-1.5">
          <EscapedTextField
            path={["combine_with"]}
            id={opId("recombine-with")}
            label="Combine With"
            description="Separator between entries."
            {...(emptyJoin ? {} : { defaultValue: NEWLINE_SHOWN })}
            className="font-mono text-xs w-20"
          />
          {emptyJoin && <p className="text-[11px] leading-4 text-muted-foreground">{EMPTY_JOIN_HINT}</p>}
        </div>
      </div>

      <ConfigField
        label="Source Identifier"
        description="Field to identify log source (for interleaved logs)."
        defaultValue={SOURCE_DEFAULT}
        htmlFor={opId("recombine-source")}
      >
        <FieldSelector path={["source_identifier"]} id={opId("recombine-source")} defaultValue={SOURCE_DEFAULT} />
      </ConfigField>

      <div className="grid grid-cols-2 gap-4">
        <NumberField
          path={["max_batch_size"]}
          id={opId("recombine-batch")}
          label="Max Batch Size"
          description="Max entries to combine."
          defaultValue="1000"
        />

        <NumberField
          path={["max_log_size"]}
          id={opId("recombine-size")}
          label="Max Log Size"
          description="Max combined size (bytes)."
          defaultValue="0 (unlimited)"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <DurationField
          path={["force_flush_period"]}
          id={opId("recombine-flush")}
          label="Force Flush Period"
          description="Emit partial entry after this duration."
          defaultValue="5s"
        />

        <SelectField
          path={["overwrite_with"]}
          id={opId("recombine-overwrite")}
          label="Overwrite With"
          description="Which entry's fields to keep."
          defaultValue="oldest"
          options={[
            { value: "newest", label: "Newest entry" },
            { value: "oldest", label: "Oldest entry" },
          ]}
        />
      </div>
    </div>
  );
}
