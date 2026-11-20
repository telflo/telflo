import { Plus, Trash2 } from "lucide-react";

import { ConfigField } from "./ConfigField.js";
import {
  BareTextField,
  FormScope,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The resource processor's form, over the form. The attributes are a sortable
 * list of cards; each card's fields write their own key under
 * `attributes.<index>`.
 *
 * - Dragging a card (pointer or keyboard) moves the item's own lines, its
 *   comments and quoting with it (`form.move`).
 * - "Add Attribute" appends `{key: "", value: "", action:
 *   "insert"}`; the trash button removes the item's lines.
 * - Fixed, so a person's own config isn't lost: changing the
 *   action writes `action`, adds the key the new action needs and removes
 *   the ones it no longer uses, leaving the item's other keys (a
 *   `converted_type`, a `default_value`) as they are, never rebuilding the
 *   item from its key, action and value source. To delete: the value
 *   source's keys go (`pattern` stays). From delete (or any action) to
 *   insert, update or upsert: `pattern` goes, and a `value: ""` is added
 *   when the item has no value source.
 * - Fixed: changing the value source swaps just those keys (the old one
 *   removed, the new one written `""`). A value
 *   keeps its type unless the person retypes it: the number `42` is shown as
 *   written and never rewritten as `"42"` until edited.
 * - Fixed: an action outside insert/update/upsert/delete (the collector's
 *   hash, extract, convert) shows as an extra option, as written, not a blank
 *   select.
 * - Clearing a card's Key or value writes `""`;
 *   clearing the Key Pattern (optional for delete) removes it.
 *
 * Cards are keyed and identified by index (`attr-0`), never by a key or
 * value.
 */

type ValueSource = "literal" | "from_attribute" | "from_context";

const SOURCE_KEYS: Record<ValueSource, string> = {
  literal: "value",
  from_attribute: "from_attribute",
  from_context: "from_context",
};

const ACTION_OPTIONS = [
  { value: "insert", label: "Insert" },
  { value: "update", label: "Update" },
  { value: "upsert", label: "Upsert" },
  { value: "delete", label: "Delete" },
] as const;

/** The item's value source, read from the text. */
function valueSourceOf(form: FormSource): ValueSource {
  if (form.read(["from_attribute"]).kind !== "absent") return "from_attribute";
  if (form.read(["from_context"]).kind !== "absent") return "from_context";
  return "literal";
}

/** The changes for a new action (scoped to the item): `action`, the key it needs, not the ones it doesn't use. */
function actionChanges(form: FormSource, next: string): ValueChange[] {
  const has = (key: string) => form.read([key]).kind !== "absent";
  const changes: ValueChange[] = [{ path: ["action"], value: next }];
  if (next === "delete") {
    for (const key of Object.values(SOURCE_KEYS)) {
      if (has(key)) changes.push({ path: [key], remove: true });
    }
  } else {
    if (has("pattern")) changes.push({ path: ["pattern"], remove: true });
    if (!Object.values(SOURCE_KEYS).some(has)) changes.push({ path: ["value"], value: "" });
  }
  return changes;
}

/** The changes for a new value source (scoped to the item): the old source's key swapped for the new one's. */
function valueSourceChanges(form: FormSource, next: ValueSource): ValueChange[] {
  const changes: ValueChange[] = [];
  for (const [source, key] of Object.entries(SOURCE_KEYS)) {
    if (source !== next && form.read([key]).kind !== "absent") changes.push({ path: [key], remove: true });
  }
  changes.push({ path: [SOURCE_KEYS[next]], value: "" });
  return changes;
}

export function ResourceProcessorForm() {
  const form = useForm();
  const view = form.read(["attributes"]);
  const count = view.kind === "list" ? view.value.length : 0;
  const indices = Array.from({ length: count }, (_item, index) => index);

  const addAttribute = () => {
    form.set(["attributes", count], { key: "", value: "", action: "insert" });
  };

  return (
    <div className="space-y-4">
      <ConfigField label="Resource Attributes" description="Actions run top to bottom. Drag to reorder.">
        {view.kind !== "list" && view.kind !== "absent" ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <div className="space-y-2">
            <SortableList
              list="attr"
              items={indices}
              onReorder={(from, to) => form.move(["attributes"], from, to)}
              listClassName="space-y-2"
              contextId="resource-attributes"
            >
              {(index, _position, id) => (
                <SortableItem key={id} id={id} disabled={form.disabled}>
                  {({ isDragging, dragHandleProps }) => (
                    <div
                      className={`flex gap-2 items-start p-2.5 bg-muted/50 rounded-md border border-border ${
                        isDragging ? "shadow-lg ring-2 ring-brand" : ""
                      }`}
                    >
                      <SortableHandle {...dragHandleProps} className="mt-2" disabled={form.disabled} />
                      <div className="flex-1 space-y-2">
                        <FormScope path={["attributes", index]}>
                          <AttributeFields index={index} />
                        </FormScope>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove attribute"
                        onClick={() => form.remove(["attributes", index])}
                        className="mt-1"
                        disabled={form.disabled}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </SortableItem>
              )}
            </SortableList>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addAttribute}
              className="w-full"
              disabled={form.disabled}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Attribute
            </Button>
          </div>
        )}
      </ConfigField>
    </div>
  );
}

/** A card's fields, under `attributes.<index>`. */
function AttributeFields({ index }: { index: number }) {
  const form = useForm();
  if (form.read([]).kind !== "map") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  const action = form.read(["action"]);
  const isDelete = action.kind === "scalar" && action.value === "delete";
  const source = valueSourceOf(form);

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <TextField path={["key"]} id={`attr-${index}-key`} label="Key" placeholder="e.g. environment" keepEmpty />
        <SelectField
          path={["action"]}
          id={`attr-${index}-action`}
          label="Action"
          placeholder="Action"
          options={ACTION_OPTIONS}
          onSelect={(next) => form.apply(actionChanges(form, next))}
        />
      </div>

      {!isDelete && (
        <>
          <ConfigField label="Value Source" htmlFor={`attr-${index}-source`}>
            <Select
              value={source}
              onValueChange={(next) => {
                if (next !== source) form.apply(valueSourceChanges(form, next as ValueSource));
              }}
              disabled={form.disabled}
            >
              <SelectTrigger id={`attr-${index}-source`}>
                <SelectValue placeholder="Value source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="literal">Literal value</SelectItem>
                <SelectItem value="from_attribute">From attribute</SelectItem>
                <SelectItem value="from_context">From context</SelectItem>
              </SelectContent>
            </Select>
          </ConfigField>

          {source === "literal" && <BareTextField path={["value"]} placeholder="e.g. production" ariaLabel="Value" />}
          {source === "from_attribute" && (
            <BareTextField path={["from_attribute"]} placeholder="e.g. host.name" ariaLabel="Source attribute key" />
          )}
          {source === "from_context" && (
            <BareTextField path={["from_context"]} placeholder="e.g. auth.subject" ariaLabel="Context key" />
          )}
        </>
      )}

      {isDelete && (
        <TextField
          path={["pattern"]}
          id={`attr-${index}-pattern`}
          label="Key Pattern"
          description="Deletes every key matching this regex."
          placeholder="e.g. ^http\..*"
        />
      )}
    </>
  );
}
