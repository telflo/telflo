import { Plus, Trash2 } from "lucide-react";

import { ConfigField } from "../../ConfigField.js";
import { BareTextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useCardKeys } from "../../shared/card-keys.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { Button } from "~/components/ui/button.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";

/*
 * The `assign_keys` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-assign-keys-…`); each
 * key's input gets a fixed id by index, `op-<index>-assign-keys-key-<row>`
 * (decision 10), and its placeholder is `key<n>`, from the row's number.
 *
 * Keys is written by item (D9b decision 2): a row's typing sets its key
 * (held; cleared, it writes `""`, so the item stays), Add Key appends
 * `key<n+1>`, and Remove removes the item's
 * lines; the rows are keyed by their items (`useCardKeys`; D9c Ruling 68).
 * Remove is disabled while there is one key: the
 * collector refuses an empty `keys` (`transformer/assignkeys/config.go:51-53`).
 * A `keys` that isn't a list of scalars is read-only with decision 3's hint.
 * Changed (D9b decision 3): Field is required (`docs/operators/assign_keys.md`;
 * a body, attribute or resource field, `config.go:55-79`) and shows no
 * default (never `body` as a value it doesn't write). It isn't rootable
 * (`config.go:40`, an `entry.Field`).
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function AssignKeysForm() {
  const form = useForm();
  const opId = useOperatorId();
  const view = form.read(["keys"]);
  const items = view.kind === "absent" ? [] : view.kind === "list" ? view.value.map((_item, index) => form.read(["keys", index]).kind) : null;
  const count = items?.every((kind) => kind === "scalar") ? items.length : null;
  const disabled = form.disabled || count === null;
  // Rows keyed by their items (Ruling 68), so a Remove click can't land on the next key's row.
  const cards = useCardKeys(count === null || view.kind !== "list" ? [] : view.value);

  return (
    <div className="space-y-4">
      <ConfigField label="Field" description="Field containing the list to transform." required htmlFor={opId("assign-keys-field")}>
        <FieldSelector path={["field"]} id={opId("assign-keys-field")} />
      </ConfigField>

      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground">Keys</label>
        <p className="text-xs text-muted-foreground">Keys must match the number of elements in the input list.</p>

        {count === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

        <div className="space-y-2">
          {Array.from({ length: count ?? 0 }, (_unused, index) => (
            <div key={cards.keys[index]} className="flex gap-2 items-center">
              <span className="text-xs text-muted-foreground w-6">{index + 1}.</span>
              <BareTextField
                path={["keys", index]}
                id={opId(`assign-keys-key-${index}`)}
                placeholder={`key${index + 1}`}
                className="flex-1 font-mono text-sm"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  flushHeldEdits();
                  if (form.remove(["keys", index]) === "written") cards.remove(index);
                }}
                type="button"
                aria-label="Remove"
                disabled={disabled || (count ?? 0) <= 1}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button
          onClick={() => {
            if (count === null) return;
            flushHeldEdits();
            form.set(["keys", count], `key${count + 1}`);
          }}
          size="sm"
          variant="outline"
          type="button"
          className="w-full"
          disabled={disabled}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Key
        </Button>
      </div>

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Example:</strong> Input list <code className={CODE}>[1, &quot;debug&quot;, true]</code>{" "}
          with keys <code className={CODE}>[&quot;id&quot;, &quot;level&quot;, &quot;flag&quot;]</code> produces:
          <br />
          <code className={CODE}>{`{"id": 1, "level": "debug", "flag": true}`}</code>
        </p>
      </div>
    </div>
  );
}
