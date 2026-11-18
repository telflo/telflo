import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `unquote` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-unquote-…`). Field is
 * required (`docs/operators/unquote.md`), so it shows no default, and isn't
 * rootable (`transformer/unquote/config.go:35`).
 *
 * Fixed (decision 4): the quote styles no longer list "Single quotes:
 * 'value' → value". The collector unquotes with `strconv.Unquote`
 * (`unquote/transformer.go:39`), which takes single quotes around one
 * character only (`unquote.md`), so `'value'` is an error.
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function UnquoteOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Remove surrounding quotes from a string field.
          <br />
          Example: <code className={CODE}>&quot;hello world&quot;</code> → <code className={CODE}>hello world</code>
        </p>
      </div>

      <ConfigField label="Field" description="Field to unquote." htmlFor={opId("unquote-field")}>
        <FieldSelector path={["field"]} id={opId("unquote-field")} />
      </ConfigField>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Supported quote styles:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            Double quotes: <code className={CODE}>&quot;value&quot;</code> → <code className={CODE}>value</code>
          </li>
          <li>
            Backticks: <code className={CODE}>`value`</code> → <code className={CODE}>value</code>
          </li>
          <li>
            Escaped quotes are handled: <code className={CODE}>&quot;say \&quot;hello\&quot;&quot;</code> →{" "}
            <code className={CODE}>say &quot;hello&quot;</code>
          </li>
        </ul>
      </div>
    </div>
  );
}
