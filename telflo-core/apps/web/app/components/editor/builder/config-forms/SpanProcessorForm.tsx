import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, FormScope, TextField, UNSET_OPTION, UNSHOWABLE_VALUE_MESSAGE, useForm, WRITTEN_OPTION } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { StringListField } from "./shared/StringListField.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The span processor's form, over the form's fields: each field writes its own
 * key. Collector claims are contrib v0.162.0's `processor/spanprocessor` and
 * `internal/filter`.
 *
 * - Removing the last Attribute Key removes `name.from_attributes`; removing
 *   the last Regex Rule removes `name.to_attributes`, its two boxes with it.
 *   The boxes write `true` or remove their key. Separator cleared removes
 *   its key.
 * - Choosing Ok or Unset while the text has a description removes
 *   `status.description` in the same change, with the toast "Removed the
 *   error description: it's only used with Error." (the collector refuses
 *   a description with any other code, `factory.go:35, 70-72`). "Leave
 *   status unchanged" removes `status` (no toast: nothing else changes).
 *   The select has the fixed id `span-status-code` so its label names it;
 *   its unset option is valued `__unset__`, and a code outside the three
 *   shows as written.
 * - As in hostmetrics' filters, a filter side's first Service or Span Name
 *   is written with `match_type: strict`, or the match chosen before it
 *   (the collector refuses a side's names with no `match_type`,
 *   "unrecognized match_type", `filterset/config.go:38-48`); a match chosen
 *   on a side with no names is held by the form until the first one (a side
 *   with nothing to match is refused, `filterconfig/config.go:162-165`).
 *   Beside names with no `match_type` the select is blank (the collector
 *   has no default).
 * - So a person's own config isn't lost, removing a side's last name removes
 *   that list's key, and the whole side only when nothing but `match_type` is
 *   left in it, so its other keys (`span_kinds`, `attributes`, `resources`,
 *   `libraries`, `regexp`) stay.
 * - The empty-processor warning (`factory.go:60-64` refuses a span processor
 *   with no rename, extraction or status) and the footer.
 *
 * Ids are fixed; no value reaches an attribute.
 */

export const REMOVED_DESCRIPTION = "Removed the error description: it's only used with Error.";

export const EMPTY_SPAN_WARNING =
  "Configure at least a rename, an extraction rule, or a status override — an empty span processor fails collector validation.";

const STATUS_CODES = ["Ok", "Error", "Unset"] as const;

const MATCH_TYPES = [
  { value: "strict", label: "Strict - Exact match" },
  { value: "regexp", label: "Regexp - Pattern match" },
] as const;

type Side = "include" | "exclude";

/** A scalar's characters as written, `""` while unset, null when it isn't a scalar. */
function scalarOf(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  return view.source ?? String(view.value);
}

/** The count of a side's services and span names. */
function filterEntries(form: ReturnType<typeof useForm>, side: Side): number {
  return listLength(form.read([side, "services"])) + listLength(form.read([side, "span_names"]));
}

export function SpanProcessorForm() {
  const form = useForm();
  const fromAttributes = listLength(form.read(["name", "from_attributes"]));
  const rules = listLength(form.read(["name", "to_attributes", "rules"]));
  const hasNameAction = fromAttributes > 0 || rules > 0;
  const hasStatusAction = isTruthy(form.read(["status", "code"]));
  const filterCount = filterEntries(form, "include") + filterEntries(form, "exclude");

  return (
    <div className="space-y-4">
      {!hasNameAction && !hasStatusAction && <InlineAlert variant="warn">{EMPTY_SPAN_WARNING}</InlineAlert>}

      <ConfigSection title="Rename From Attributes" defaultOpen={fromAttributes > 0} count={fromAttributes}>
        <StringListField
          path={["name", "from_attributes"]}
          label="Attribute Keys"
          description="Values are joined in order into the new span name. Spans missing any key are left untouched."
          placeholder="e.g. db.svc"
          emptyRemovesKey
        />

        <TextField
          path={["name", "separator"]}
          id="span-separator"
          label="Separator"
          description="Joins the attribute values; empty concatenates directly."
          placeholder="e.g. ::"
        />
      </ConfigSection>

      <ConfigSection title="Extract Attributes From Name" defaultOpen={rules > 0} count={rules}>
        <StringListField
          path={["name", "to_attributes", "rules"]}
          label="Regex Rules"
          description="Applied in order. Each named capture group becomes a span attribute, and its match is replaced by the group name placeholder (e.g. /api/{documentId}/update)."
          placeholder={"e.g. ^\\/api\\/v1\\/document\\/(?P<documentId>.*)\\/update$"}
          // The last rule takes `to_attributes` with it.
          onEmptied={() => [{ path: ["name", "to_attributes"], remove: true }]}
        />

        {rules > 0 && (
          <>
            <CheckboxField
              path={["name", "to_attributes", "break_after_match"]}
              id="span-break-after-match"
              label="Stop processing rules after the first match"
              defaultChecked={false}
              uncheckedRemoves
              labelClassName="text-xs text-muted-foreground"
            />

            <CheckboxField
              path={["name", "to_attributes", "keep_original_name"]}
              id="span-keep-original-name"
              label="Keep the original span name (only extract attributes)"
              defaultChecked={false}
              uncheckedRemoves
              labelClassName="text-xs text-muted-foreground"
            />
          </>
        )}
      </ConfigSection>

      <ConfigSection title="Status Override">
        <StatusCode />
      </ConfigSection>

      <ConfigSection title="Filtering" count={filterCount}>
        <SpanFilterSection side="include" title="Include" description="Only process matching spans." />

        <SpanFilterSection side="exclude" title="Exclude" description="Skip matching spans. Applied after include." />

        <p className="text-[11px] leading-4 text-muted-foreground">Span kind and attribute filters are available in the YAML editor.</p>
      </ConfigSection>
    </div>
  );
}

/** Status Code and, under Error, its description. */
function StatusCode() {
  const form = useForm();
  const { note } = useAdjustments();
  const status = form.read(["status"]);
  const code = status.kind === "map" || status.kind === "absent" ? scalarOf(form.read(["status", "code"])) : null;
  const extra = code !== null && code !== "" && !(STATUS_CODES as readonly string[]).includes(code);
  const selected = code === null ? "" : code === "" ? UNSET_OPTION : extra ? WRITTEN_OPTION : code;

  const choose = (value: string) => {
    if (value === selected) return;
    if (value === UNSET_OPTION) {
      form.remove(["status"]);
      return;
    }
    const changes: ValueChange[] = [{ path: ["status", "code"], value }];
    // factory.go:35, 70-72: a description with any code but Error is refused.
    const describes = value !== "Error" && form.read(["status", "description"]).kind !== "absent";
    if (describes) changes.push({ path: ["status", "description"], remove: true });
    const result = form.apply(changes);
    if (describes) note([REMOVED_DESCRIPTION], result);
  };

  return (
    <>
      <ConfigField
        label="Status Code"
        htmlFor="span-status-code"
        description="Sets the status on every span this processor sees (after include/exclude filtering)."
      >
        <Select value={selected} onValueChange={choose} disabled={form.disabled || code === null}>
          <SelectTrigger id="span-status-code">
            <SelectValue placeholder="Leave status unchanged" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET_OPTION}>
              <span className="text-muted-foreground">Leave status unchanged</span>
            </SelectItem>
            {STATUS_CODES.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
            {extra && <SelectItem value={WRITTEN_OPTION}>{code}</SelectItem>}
          </SelectContent>
        </Select>
        {code === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      {code === "Error" && (
        <TextField
          path={["status", "description"]}
          id="span-status-description"
          label="Error Description"
          description="Human-readable message stored with the Error status."
          placeholder="e.g. some error description"
        />
      )}
    </>
  );
}

/** One filter side (include/exclude scoped to services and span names), its fields under the side's block. */
function SpanFilterSection({ side, title, description }: { side: Side; title: string; description: string }) {
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
      </div>

      <FormScope path={[side]}>
        <SpanFilterFields side={side} />
      </FormScope>
    </div>
  );
}

const LISTS = ["services", "span_names"] as const;

function SpanFilterFields({ side }: { side: Side }) {
  const form = useForm();
  const block = form.read([]);
  const hasItems = LISTS.some((list) => listLength(form.read([list])) > 0);
  /** The match chosen while the side has no names: the form's, until its first one. */
  const [heldMatch, setHeldMatch] = useState<string | null>(null);
  // Once the side has names, however they came, the text says the match.
  if (hasItems && heldMatch !== null) setHeldMatch(null);

  if (block.kind !== "map" && block.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }

  const written = scalarOf(form.read(["match_type"]));
  const firstMatch = heldMatch ?? "strict";
  // Beside names, an unset match is blank (refused, filterset/config.go:38-48); with none, the match the first name gets.
  const shown = written === null ? null : written !== "" ? written : hasItems ? "" : firstMatch;
  const extra = shown !== null && shown !== "" && !MATCH_TYPES.some((option) => option.value === shown);
  const selected = extra ? WRITTEN_OPTION : (shown ?? "");

  const chooseMatch = (value: string) => {
    if (value === selected) return;
    // filterconfig/config.go:162-165: a side with only a match type is refused, so it waits for the first name.
    if (written === "" && !hasItems) setHeldMatch(value);
    else form.set(["match_type"], value);
  };

  /** With a side's first name: its match type, while it has none. */
  const withMatch = (): ValueChange[] => (form.read(["match_type"]).kind === "absent" ? [{ path: ["match_type"], value: firstMatch }] : []);
  /** The last name of `list` removes the list, and the side when nothing but its match type is left in it. */
  const emptied = (list: (typeof LISTS)[number]) => (): ValueChange[] => {
    const current = form.read([]);
    const rest = current.kind === "map" ? Object.keys(current.value).filter((key) => key !== list && key !== "match_type") : [];
    return rest.length === 0 ? [{ path: [], remove: true }] : [{ path: [list], remove: true }];
  };

  return (
    <>
      <ConfigField label="Match Type" htmlFor={`${side}-match-type`}>
        <Select value={selected} onValueChange={chooseMatch} disabled={form.disabled || shown === null}>
          <SelectTrigger id={`${side}-match-type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MATCH_TYPES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            {extra && <SelectItem value={WRITTEN_OPTION}>{shown}</SelectItem>}
          </SelectContent>
        </Select>
        {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      <StringListField path={["services"]} label="Service Names" placeholder="e.g. frontend" alsoOnAppend={withMatch} onEmptied={emptied("services")} />

      <StringListField
        path={["span_names"]}
        label="Span Names"
        placeholder="e.g. http.request"
        alsoOnAppend={withMatch}
        onEmptied={emptied("span_names")}
      />
    </>
  );
}
