import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `uri_parser` operator's form, over the card's scope. Ids are the card's
 * (`op-<index>-uri-…`).
 *
 * The description and the output fields leave out `fragment`: the parser
 * writes scheme, user, host, port, path and query
 * (`internal/coreinternal/parseutils/uri.go:100-128`), and a fragment only
 * under the alpha `parser.uri.ecscompliant` gate, as `url.fragment` (`:56-98`;
 * `pkg/stanza/operator/parser/uri/parser.go:34`). Unset Parse From and Parse
 * To show the collector's `body` and `attributes` (`helper/parser.go:26-27`),
 * Parse To rootable (`:35`).
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function UriParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Parses URIs into components: scheme, host, port, path, query.
          <br />
          Example: <code className={CODE}>https://example.com:8080/path?query=1</code>
        </p>
      </div>

      <ConfigField label="Parse From" description="Field containing the URI string." defaultValue="body" htmlFor={opId("uri-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("uri-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for parsed URI components." defaultValue="attributes" htmlFor={opId("uri-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("uri-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Output fields:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            <code className={CODE}>scheme</code> - http, https, etc.
          </li>
          <li>
            <code className={CODE}>host</code> - hostname
          </li>
          <li>
            <code className={CODE}>port</code> - port number
          </li>
          <li>
            <code className={CODE}>path</code> - URL path
          </li>
          <li>
            <code className={CODE}>query</code> - query string (parsed as map)
          </li>
          <li>
            <code className={CODE}>user</code> - username (if present)
          </li>
        </ul>
      </div>
    </div>
  );
}
