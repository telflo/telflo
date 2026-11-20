import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  FormScope,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { StringListField } from "./shared/StringListField.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import { findPattern } from "~/lib/regex-library.js";

/*
 * The attributes processor's form, over the form. Each field writes its own
 * key under `actions.<index>`, `include` or `exclude`.
 *
 * - The actions are collapsible cards (the first open), applied in order and
 *   **not reorderable**. "Add Action" appends
 *   `{key: "", action: "insert", value: ""}` and opens it; the trash button
 *   removes the item's lines.
 * - Changing the action type rebuilds the action keeping only its key (an
 *   action type is a different action), with the seed for the new type
 *   (`value: ""`, `pattern: ""`, `converted_type: string`, nothing for delete
 *   and hash). So do the Value Source and Target Type selects (keeping key and
 *   action; seeds `source_attribute`, `client.address`, the library's "Generic
 *   Prefix"). Written by key: `action` in place, every other key removed by
 *   its lines, the seed's keys set; the key's line and comments stay.
 * - Clearing a card's text writes `""` (a pattern
 *   cleared stays a pattern target).
 * - Filtering: Include and Exclude, each with Match Type and the service,
 *   span and metric name lists (`StringListField`; its remove buttons say
 *   "Remove", never "Remove <value>").
 * - The cache controls sit in Include and Exclude, shown while that
 *   section's match type is `regexp`, and write
 *   `include.regexp.cacheenabled` / `cachemaxnumentries` (and exclude's),
 *   where the collector reads them (`filterset.Config`'s `regexp`, squashed
 *   into `MatchProperties`, contrib v0.162.0), never a top-level
 *   `cacheenabled`, which the collector rejects; one already in a text is
 *   neither shown nor touched.
 * - Defaults (contrib v0.162.0): the cache is off unless `cacheenabled`
 *   (`regexp.Config`, a bool); an unset `cachemaxnumentries` is 0, an
 *   unbounded cache ("Because of legacy behavior, CacheMaxNumEntries == 0
 *   means unbounded cache", `regexpfilterset.go`), so its hint is "Default 0
 *   (no limit)", not
 *   1000. `match_type` has no default (`filterset.Config`; an
 *   empty one is "unrecognized match_type" once a list is set), so the
 *   select shows unset as blank with no "Default strict" hint.
 *
 * Cards are keyed by index and their field ids are indexed (`action-0-key`),
 * never a key or value.
 */

type ActionType = "insert" | "update" | "upsert" | "delete" | "hash" | "extract" | "convert";

const ACTION_TYPE_OPTIONS = [
  { value: "insert", label: "Insert - Add if absent" },
  { value: "update", label: "Update - Modify if present" },
  { value: "upsert", label: "Upsert - Insert or update" },
  { value: "delete", label: "Delete - Remove attribute" },
  { value: "hash", label: "Hash - SHA1 the value" },
  { value: "extract", label: "Extract - Parse with regex" },
  { value: "convert", label: "Convert - Change value type" },
] as const;

const CONVERT_OPTIONS = [
  { value: "int", label: "Integer" },
  { value: "double", label: "Double/Float" },
  { value: "string", label: "String" },
] as const;

const MATCH_TYPE_OPTIONS = [
  { value: "strict", label: "Strict - Exact match" },
  { value: "regexp", label: "Regexp - Pattern match" },
] as const;

/** The action type's seeds: the new type's fields besides `key` and `action`. */
const ACTION_SEEDS: Record<ActionType, Record<string, string>> = {
  insert: { value: "" },
  update: { value: "" },
  upsert: { value: "" },
  delete: {},
  hash: {},
  extract: { pattern: "" },
  convert: { converted_type: "string" },
};

/** A scalar as the text writes it; "" for anything else. */
function shownText(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/**
 * Rebuilds the action (scoped to the item) as `{key, ...kept, ...seed}`,
 * by key: the item's other keys removed by their lines, the seed's set.
 * `key` is kept, and added as `""` when missing, for Action Type, Target
 * Type and Value Source alike.
 */
function rebuildChanges(form: FormSource, kept: Record<string, unknown>, seed: Record<string, unknown>): ValueChange[] {
  const item = form.read([]);
  const existing = item.kind === "map" ? Object.keys(item.value) : [];
  const target: Record<string, unknown> = { ...kept, ...seed };
  const changes: ValueChange[] = [];
  if (!existing.includes("key")) changes.push({ path: ["key"], value: "" });
  for (const key of existing) {
    if (key !== "key" && !Object.hasOwn(target, key)) changes.push({ path: [key], remove: true });
  }
  for (const [key, value] of Object.entries(target)) {
    const current = form.read([key]);
    if (!(current.kind === "scalar" && current.value === value)) changes.push({ path: [key], value });
  }
  return changes;
}

function valueSourceType(form: FormSource): "static" | "from_attribute" | "from_context" {
  if (form.read(["from_context"]).kind !== "absent") return "from_context";
  if (form.read(["from_attribute"]).kind !== "absent") return "from_attribute";
  return "static";
}

function targetType(form: FormSource): "key" | "pattern" {
  return form.read(["pattern"]).kind !== "absent" ? "pattern" : "key";
}

function listLength(view: ValueView): number {
  return view.kind === "list" ? view.value.length : 0;
}

export function AttributesProcessorForm() {
  const form = useForm();
  const view = form.read(["actions"]);
  const count = view.kind === "list" ? view.value.length : 0;
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set([0]));

  const toggleAction = (index: number) => {
    const newExpanded = new Set(expandedActions);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedActions(newExpanded);
  };

  const addAction = () => {
    if (form.set(["actions", count], { key: "", action: "insert", value: "" }) === "refused") return;
    // Auto-expand newly added action
    setExpandedActions(new Set([...expandedActions, count]));
  };

  const removeAction = (index: number) => {
    if (form.remove(["actions", index]) === "refused") return;
    const newExpanded = new Set<number>();
    expandedActions.forEach((i) => {
      if (i < index) newExpanded.add(i);
      else if (i > index) newExpanded.add(i - 1);
    });
    setExpandedActions(newExpanded);
  };

  const countFilterEntries = (which: "include" | "exclude") =>
    listLength(form.read([which, "services"])) +
    listLength(form.read([which, "span_names"])) +
    listLength(form.read([which, "metric_names"]));

  const filterCount = countFilterEntries("include") + countFilterEntries("exclude");

  return (
    <div className="space-y-4">
      <ConfigField label="Actions" description="Applied in order, top to bottom.">
        {view.kind !== "list" && view.kind !== "absent" ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: count }, (_item, index) => (
              <FormScope key={index} path={["actions", index]}>
                <ActionCard
                  index={index}
                  isExpanded={expandedActions.has(index)}
                  onToggle={() => toggleAction(index)}
                  onRemove={() => removeAction(index)}
                />
              </FormScope>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addAction}
              className="w-full"
              disabled={form.disabled}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Action
            </Button>
          </div>
        )}
      </ConfigField>

      <ConfigSection title="Filtering" count={filterCount}>
        <FormScope path={["include"]}>
          <FilterSection which="include" title="Include" description="Only process matching telemetry." />
        </FormScope>

        <FormScope path={["exclude"]}>
          <FilterSection which="exclude" title="Exclude" description="Skip matching telemetry. Applied after include." />
        </FormScope>

        <p className="text-[11px] leading-4 text-muted-foreground">
          Log body, attribute, and resource filters are available in the YAML editor.
        </p>
      </ConfigSection>
    </div>
  );
}

/** An action's card, under `actions.<index>`. */
function ActionCard({
  index,
  isExpanded,
  onToggle,
  onRemove,
}: {
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const form = useForm();
  const item = form.read([]);
  const actionType = shownText(form.read(["action"]));
  const key = shownText(form.read(["key"]));
  const header = actionType.charAt(0).toUpperCase() + actionType.slice(1);

  const changeActionType = (newType: string) => {
    const seed = Object.hasOwn(ACTION_SEEDS, newType) ? ACTION_SEEDS[newType as ActionType] : {};
    form.apply(rebuildChanges(form, { action: newType }, seed));
  };

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Action Header */}
      <div
        className="flex items-center justify-between p-2.5 bg-muted/50 cursor-pointer hover:bg-muted"
        onClick={onToggle}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium text-sm">
            {header}
            {key ? `: ${key}` : " (configure key)"}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Remove action"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          disabled={form.disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Action Body */}
      {isExpanded && (
        <div className="p-2.5 space-y-2">
          {item.kind !== "map" ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  path={["key"]}
                  id={`action-${index}-key`}
                  label={actionType === "extract" ? "Source Attribute Key" : "Attribute Key"}
                  placeholder={actionType === "extract" ? "e.g. http.url" : "e.g. environment"}
                  keepEmpty
                />

                <SelectField
                  path={["action"]}
                  id={`action-${index}-type`}
                  label="Action Type"
                  options={ACTION_TYPE_OPTIONS}
                  onSelect={changeActionType}
                />
              </div>

              {/* INSERT/UPDATE/UPSERT: Value source */}
              {(actionType === "insert" || actionType === "update" || actionType === "upsert") && (
                <ValueSourceFields index={index} />
              )}

              {/* DELETE/HASH: Target type */}
              {(actionType === "delete" || actionType === "hash") && <TargetFields index={index} />}

              {/* EXTRACT: Pattern */}
              {actionType === "extract" && (
                <TextField
                  path={["pattern"]}
                  id={`action-${index}-pattern`}
                  label="Regex Pattern"
                  description="Named groups (?P<name>…) become new attributes."
                  placeholder={`e.g. ${findPattern("URL Protocol + Domain + Path").pattern}`}
                  keepEmpty
                />
              )}

              {/* CONVERT: Converted Type */}
              {actionType === "convert" && (
                <SelectField
                  path={["converted_type"]}
                  id={`action-${index}-convert`}
                  label="Convert to Type"
                  options={CONVERT_OPTIONS}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Insert, update and upsert: where the value comes from, and the value. */
function ValueSourceFields({ index }: { index: number }) {
  const form = useForm();
  const source = valueSourceType(form);
  const action = shownText(form.read(["action"]));
  return (
    <>
      <ConfigField label="Value Source" htmlFor={`action-${index}-source`}>
        <Select
          value={source}
          onValueChange={(type) => {
            if (type === source) return;
            // A clean action with only key and action type, and the source's placeholder.
            const seed =
              type === "static"
                ? { value: "" }
                : type === "from_attribute"
                  ? { from_attribute: "source_attribute" }
                  : { from_context: "client.address" };
            form.apply(rebuildChanges(form, { action }, seed));
          }}
          disabled={form.disabled}
        >
          <SelectTrigger id={`action-${index}-source`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="static">Literal value</SelectItem>
            <SelectItem value="from_attribute">From attribute</SelectItem>
            <SelectItem value="from_context">From context</SelectItem>
          </SelectContent>
        </Select>
      </ConfigField>

      {source === "static" && (
        <TextField
          path={["value"]}
          id={`action-${index}-value`}
          label="Value"
          description="String, number, or boolean."
          placeholder="e.g. production, true, 42"
          keepEmpty
        />
      )}

      {source === "from_attribute" && (
        <TextField
          path={["from_attribute"]}
          id={`action-${index}-from-attr`}
          label="Source Attribute"
          placeholder="e.g. http.method"
          keepEmpty
        />
      )}

      {source === "from_context" && (
        <TextField
          path={["from_context"]}
          id={`action-${index}-from-ctx`}
          label="Context Path"
          placeholder="e.g. metadata.*, auth.*, client.address"
          keepEmpty
        />
      )}
    </>
  );
}

/** Delete and hash: one key, or every key a pattern matches. */
function TargetFields({ index }: { index: number }) {
  const form = useForm();
  const target = targetType(form);
  const action = shownText(form.read(["action"]));
  return (
    <>
      <ConfigField label="Target Type" htmlFor={`action-${index}-target`}>
        <Select
          value={target}
          onValueChange={(type) => {
            if (type === target) return;
            const seed = type === "key" ? {} : { pattern: findPattern("Generic Prefix").pattern };
            form.apply(rebuildChanges(form, { action }, seed));
          }}
          disabled={form.disabled}
        >
          <SelectTrigger id={`action-${index}-target`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="key">Single Attribute Key</SelectItem>
            <SelectItem value="pattern">Regex Pattern (bulk)</SelectItem>
          </SelectContent>
        </Select>
      </ConfigField>

      {target === "pattern" && (
        <TextField
          path={["pattern"]}
          id={`action-${index}-pattern`}
          label="Regex Pattern"
          description="Matched against attribute keys."
          placeholder={`e.g. ${findPattern("Temp Prefix").pattern}`}
          keepEmpty
        />
      )}
    </>
  );
}

/** Include or Exclude, under `include` / `exclude`: match type, the cache (regexp), the name lists. */
function FilterSection({ which, title, description }: { which: "include" | "exclude"; title: string; description: string }) {
  const form = useForm();
  const matchType = form.read(["match_type"]);
  const regexp = matchType.kind === "scalar" && matchType.value === "regexp";
  const cacheEnabled = form.read(["regexp", "cacheenabled"]);
  const section = form.read([]).kind;

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
      </div>

      {section !== "map" && section !== "absent" ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <FilterFields which={which} regexp={regexp} cacheOn={cacheEnabled.kind === "scalar" && cacheEnabled.value === true} />
      )}
    </div>
  );
}

function FilterFields({ which, regexp, cacheOn }: { which: "include" | "exclude"; regexp: boolean; cacheOn: boolean }) {
  return (
    <>
      <SelectField path={["match_type"]} id={`${which}-match-type`} label="Match Type" options={MATCH_TYPE_OPTIONS} />

      {regexp && (
        <>
          <CheckboxField
            path={["regexp", "cacheenabled"]}
            id={`${which}-cache-enabled`}
            label="Enable Caching"
            description={
              <>
                Caches match results when filters use regexp matching. · Default{" "}
                <span className="font-mono">false</span>
              </>
            }
            defaultChecked={false}
          />

          {cacheOn && (
            <NumberField
              path={["regexp", "cachemaxnumentries"]}
              id={`${which}-cache-max`}
              label="Max Cache Entries"
              defaultValue="0 (no limit)"
              placeholder="0"
            />
          )}
        </>
      )}

      <StringListField path={["services"]} label="Service Names" placeholder="e.g. frontend" />

      <StringListField
        path={["span_names"]}
        label="Span Names"
        description="Traces only."
        placeholder="e.g. http.request"
      />

      <StringListField
        path={["metric_names"]}
        label="Metric Names"
        description="Metrics only."
        placeholder="e.g. http.server.duration"
      />
    </>
  );
}
