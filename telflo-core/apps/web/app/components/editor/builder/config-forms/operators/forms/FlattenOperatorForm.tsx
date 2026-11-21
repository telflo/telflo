import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `flatten` operator's form, over the card's scope. Ids are the card's
 * (`op-<index>-flatten-…`).
 *
 * - What flatten does: it moves the named map's fields up one level, into
 *   its parent (`transformer/flatten/transformer.go:35-58`;
 *   `docs/operators/flatten.md:3-4`), and doesn't join keys with dots. The
 *   description is "Moves a map's fields up one level, into its parent.";
 *   there is no inline example, and the before/after example is the
 *   collector's first (`flatten.md:19-64`, Field `body.key1`), labeled
 *   "Before flatten, with Field body.key1:".
 * - Field is required (`flatten.md:12`) and not rootable: the collector
 *   builds it for a body, attribute or resource field
 *   (`flatten/config.go:47-68`) and refuses a bare `attributes` or
 *   `resource` (`entry/field.go:119-126`), so an empty suffix removes the
 *   key. Its hint is "Required. The map to flatten, under body,
 *   attributes or resource." (an empty Field is refused by the collector,
 *   `config.go:68`). It shows no default.
 * - There is no Depth field: `depth` isn't a key (`flatten/config.go:35-38`),
 *   and the collector ignores it (`operator/config.go:111`). A `depth` in the
 *   text is left alone.
 */

const PRE = "text-xs text-muted-foreground font-mono bg-muted p-2 rounded-[4px] mt-1 overflow-x-auto";

export function FlattenOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">Moves a map&apos;s fields up one level, into its parent.</p>
      </div>

      <ConfigField label="Field" description="Required. The map to flatten, under body, attributes or resource." htmlFor={opId("flatten-field")}>
        <FieldSelector path={["field"]} id={opId("flatten-field")} />
      </ConfigField>

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Before flatten, with Field body.key1:</strong>
        </p>
        <pre className={PRE}>
          {`{
  "key1": {
    "nested1": "nestedval1",
    "nested2": "nestedval2"
  },
  "key2": "val2"
}`}
        </pre>
        <p className="text-xs text-muted-foreground mt-2">
          <strong className="font-medium text-foreground">After flatten:</strong>
        </p>
        <pre className={PRE}>
          {`{
  "nested1": "nestedval1",
  "nested2": "nestedval2",
  "key2": "val2"
}`}
        </pre>
      </div>
    </div>
  );
}
