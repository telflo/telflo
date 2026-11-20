import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `scope_name_parser` operator's form, over the card's scope. Its id is
 * the card's (`op-<index>-scope-parse-from`). Parse From has no default: the
 * collector's is an empty field (`helper/scope_name.go:14-23`), so the path is
 * the person's to give.
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function ScopeNameParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Sets the instrumentation scope name from a log field. This is useful for identifying the source library or component that
          generated the log.
        </p>
      </div>

      <ConfigField label="Parse From" description="Field containing the scope/logger name." htmlFor={opId("scope-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("scope-parse-from")} />
      </ConfigField>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Common use cases:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            Java/Log4j: <code className={CODE}>attributes.logger</code>
          </li>
          <li>
            Python: <code className={CODE}>attributes.name</code>
          </li>
          <li>
            Application identifier: <code className={CODE}>attributes.app_name</code>
          </li>
        </ul>
      </div>
    </div>
  );
}
