import type { ComponentType } from "react";

import type { OperatorType } from "../operator-catalog.js";
import { AddOperatorForm } from "./AddOperatorForm.js";
import { AssignKeysForm } from "./AssignKeysForm.js";
import { ContainerOperatorForm } from "./ContainerOperatorForm.js";
import { CopyOperatorForm } from "./CopyOperatorForm.js";
import { CsvParserForm } from "./CsvParserForm.js";
import { FilterOperatorForm } from "./FilterOperatorForm.js";
import { FlattenOperatorForm } from "./FlattenOperatorForm.js";
import { JsonArrayParserForm } from "./JsonArrayParserForm.js";
import { JsonParserForm } from "./JsonParserForm.js";
import { KeyValueParserForm } from "./KeyValueParserForm.js";
import { MoveOperatorForm } from "./MoveOperatorForm.js";
import { NoopOperatorForm } from "./NoopOperatorForm.js";
import { RecombineOperatorForm } from "./RecombineOperatorForm.js";
import { RegexParserForm } from "./RegexParserForm.js";
import { RegexReplaceForm } from "./RegexReplaceForm.js";
import { RemoveOperatorForm } from "./RemoveOperatorForm.js";
import { RetainOperatorForm } from "./RetainOperatorForm.js";
import { RouterOperatorForm } from "./RouterOperatorForm.js";
import { SanitizeUtf8Form } from "./SanitizeUtf8Form.js";
import { ScopeNameParserForm } from "./ScopeNameParserForm.js";
import { SeverityParserForm } from "./SeverityParserForm.js";
import { SyslogParserForm } from "./SyslogParserForm.js";
import { TimeParserForm } from "./TimeParserForm.js";
import { TraceParserForm } from "./TraceParserForm.js";
import { UnquoteOperatorForm } from "./UnquoteOperatorForm.js";
import { UriParserForm } from "./UriParserForm.js";

/*
 * The operator cards' type forms, by type (D9c plan Tasks 6 and 7). A card
 * shows its common fields, then the form for its type, when there is one.
 *
 * The contract a type form follows (Task 5's plug-in point):
 * - It takes no props. It reads and writes through `useForm()`, which the
 *   card scopes to its item (`FormScope` at `operators.<index>`), so its
 *   paths are the operator's own keys (`["parse_from"]`,
 *   `["routes", 0, "expr"]`); keys it doesn't show (`output`, `body`, …)
 *   stay in the text. It never writes on render or on mount.
 * - Every id it gives is per card: `useOperatorId()("json-parse-from")` is
 *   `op-<index>-json-parse-from`. No id, placeholder or other attribute
 *   holds a value from the text (decision 10).
 * - Its local UI state (a custom-layout toggle, a pattern switch before a
 *   regex is typed) lives in the form's own components: the card is keyed
 *   by its item, so the state follows the card when it moves (Preflight
 *   ruling 25). It goes when the card collapses.
 * - The shared pieces take the card's scope: `FieldSelector({path, id,
 *   rootable?})`, `TimestampConfigSection()` (the parser's `timestamp`
 *   block), `SeverityConfigSection()` (its `severity` block), and, for the
 *   severity parser's own `mapping`, `SeverityMappingRows({idPrefix})`,
 *   `useCustomMapping()` and `readSeverityMapping(form)`; the time layouts'
 *   presets and switch are `LAYOUT_PRESETS` and `layoutAfterSwitch` in
 *   `operator-catalog.ts`, read and written by `useLayoutControl`
 *   (`TimestampConfigSection.tsx`); `TextField`'s and `CheckboxField`'s
 *   `excludes` write decision 7's exclusive pairs.
 *
 * Task 6 adds the 12 parsers, Task 7 the 14 transformers and flow
 * operators: every one of the 26 has its form.
 */
export const OPERATOR_FORMS: Record<OperatorType, ComponentType> = {
  // Parsers (Task 6)
  json_parser: JsonParserForm,
  regex_parser: RegexParserForm,
  csv_parser: CsvParserForm,
  key_value_parser: KeyValueParserForm,
  syslog_parser: SyslogParserForm,
  json_array_parser: JsonArrayParserForm,
  container: ContainerOperatorForm,
  // Field parsers (Task 6)
  severity_parser: SeverityParserForm,
  time_parser: TimeParserForm,
  trace_parser: TraceParserForm,
  uri_parser: UriParserForm,
  scope_name_parser: ScopeNameParserForm,
  // Transform (Task 7)
  add: AddOperatorForm,
  copy: CopyOperatorForm,
  move: MoveOperatorForm,
  remove: RemoveOperatorForm,
  retain: RetainOperatorForm,
  flatten: FlattenOperatorForm,
  unquote: UnquoteOperatorForm,
  regex_replace: RegexReplaceForm,
  sanitize_utf8: SanitizeUtf8Form,
  assign_keys: AssignKeysForm,
  // Flow (Task 7)
  filter: FilterOperatorForm,
  router: RouterOperatorForm,
  recombine: RecombineOperatorForm,
  noop: NoopOperatorForm,
};
