import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { SelectField, TextareaField, UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { ItemScope, useHeldItem, type HeldItem } from "./shared/held-item.js";
import { PipelineListField, useConnectorPipelineOptions } from "./shared/PipelineListField.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The routing connector's form, over the form's fields. The routes are a
 * sortable list of cards; each card's fields write their own key under
 * `table.<index>` (`ItemScope`), so keys the form doesn't show stay.
 *
 * - Dragging a route moves its own lines (`form.move`). A card's expanded
 *   state follows the card (`useCardKeys`), not the
 *   index; the first card starts expanded. Ids are by
 *   card index (`route-0-context`, sortable `route-0`), never a value.
 * - Target Pipelines and Default Pipelines are `PipelineListField`s over
 *   `connectorPipelineOptions` (the canvas's pipelines less the ones that
 *   export to this connector, of their signal). Choosing a pipeline writes
 *   the route's entry and, in the store, the connector into that
 *   pipeline's receivers, one change with its toast; removing one takes
 *   the connector out of receivers once nothing here names the pipeline,
 *   unless it is the pipeline's only receiver
 *   (`connector/routingconnector/router.go` `errPipelineNotFound`). A
 *   route's last target pipeline can't be removed (its Remove disabled,
 *   with a hint to remove the route): the form never writes
 *   `pipelines: []`, which `config.go:83-91` refuses; Default Pipelines'
 *   last one takes the key with it.
 * - Fixed: Add Route holds a card that isn't in the text (never
 *   `{context: resource, condition: "", pipelines: []}`, which
 *   `config.go:83-91` refuses). Its first expression typed or pipeline
 *   chosen writes the route, `{context: resource, <kind>: typed}` or
 *   `{context: resource, pipelines: [p]}` (until its expression is typed,
 *   the config validation reports the route), keeping `context: resource`; a
 *   context or action chosen before then is held with it. "No routes
 *   configured" hides while a card is held.
 * - Changed: Context unset is blank, with the hint "Default: inferred from
 *   the expression's paths, else resource" (`router.go:247- 259`);
 *   `otelcol` is offered (`config.go:102`), and Request says it is
 *   deprecated (`router.go:234- 237`). Action and Error Mode show their
 *   defaults as placeholders: move, and ignore (the beta gate
 *   `connector.routing.defaultErrorModeIgnore`, `factory.go:19-24`).
 * - Changed: Context switched to Request renames a statement to a condition
 *   in place, in the same change, with a toast (the request context takes
 *   conditions only, `config.go:106-112`); with both keys the statement is
 *   removed.
 * - Changed: Match Using renames the expression's key in place; with
 *   neither key, the chosen kind is held until an expression is typed
 *   (never `statement: ""`). A cleared expression removes its key.
 */

const CONTEXTS = [
  { value: "resource", label: "Resource (once per bundle)" },
  { value: "span", label: "Span (traces, per span)" },
  { value: "metric", label: "Metric (metrics, per metric)" },
  { value: "datapoint", label: "Datapoint (metrics, per data point)" },
  { value: "log", label: "Log (logs, per record)" },
  { value: "otelcol", label: "OTel Collector (client/gRPC metadata)" },
  { value: "request", label: "Request (HTTP/gRPC metadata, deprecated)" },
] as const;

const EXPRESSION_PLACEHOLDERS: Readonly<Record<string, string>> = {
  resource: 'attributes["deployment.environment"] == "prod"',
  span: 'attributes["http.method"] == "GET"',
  metric: 'name == "http.server.duration"',
  datapoint: 'attributes["region"] == "eu-west-1"',
  log: "severity_number >= SEVERITY_NUMBER_ERROR",
  otelcol: 'otelcol.client.metadata["X-Tenant"][0] == "acme"',
  request: 'request["X-Tenant"] == "acme"',
};

const ACTIONS = [
  { value: "move", label: "Move" },
  { value: "copy", label: "Copy" },
] as const;

const ERROR_MODES = [
  { value: "propagate", label: "Propagate (drop payload)" },
  { value: "ignore", label: "Ignore (log, use default)" },
  { value: "silent", label: "Silent (use default)" },
] as const;

export const CONTEXT_DESCRIPTION =
  "Where the expression is evaluated. Use the coarsest context that works. · Default: inferred from the expression's paths, else resource";

/** The toast for Context switched to Request. */
export const STATEMENT_TO_CONDITION = "Changed the statement to a condition: the request context takes conditions only.";

const TARGETS_HELP =
  "Pipelines that receive matching telemetry — the connector is wired into their receivers automatically. Multiple pipelines fan the data out to all of them.";

/** Under a route's last target pipeline, whose Remove is disabled (`config.go:83-91` refuses `pipelines: []`). */
export const ROUTE_KEEPS_LAST_PIPELINE = "A route needs at least one pipeline. Remove the route instead.";

type Kind = "condition" | "statement";

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/** The expression's key the text has: statement over condition; none when neither. */
function kindIn(form: FormSource): Kind | null {
  if (form.read(["statement"]).kind !== "absent") return "statement";
  if (form.read(["condition"]).kind !== "absent") return "condition";
  return null;
}

/** The held card's item (a route): written once it has an expression or a pipeline. */
function routeReady(item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const route = item as Record<string, unknown>;
  const filled = (value: unknown) => value !== undefined && value !== null && value !== "";
  return filled(route.condition) || filled(route.statement) || (Array.isArray(route.pipelines) && route.pipelines.length > 0);
}

export function RoutingConnectorForm() {
  const form = useForm();
  const options = useConnectorPipelineOptions(form);
  const tableView = form.read(["table"]);
  const routes = tableView.kind === "list" ? tableView.value : [];
  const cards = useCardKeys(routes);
  const held = useHeldItem(["table"], { cards, ready: routeReady });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set([0]));
  const tableShowable = tableView.kind === "list" || tableView.kind === "absent";

  const toggle = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addRoute = () => {
    held.hold();
    setExpanded(new Set([...expanded, cards.next]));
  };

  const removeRoute = (index: number) => {
    if (form.remove(["table", index]) === "written") cards.remove(index);
  };

  const moveRoute = (from: number, to: number) => {
    // The held card, last, isn't in the text: it neither moves nor is a drop target.
    if (from >= routes.length || to >= routes.length) return;
    if (form.move(["table"], from, to) === "written") cards.move(from, to);
  };

  const defaults = form.read(["default_pipelines"]);
  const hasDefaultPipelines =
    defaults.kind === "list" && defaults.value.some((_item, index) => textOf(form.read(["default_pipelines", index])).trim() !== "");

  // The held card shows at the list's end, keyed as its item will be.
  const keys = held.held ? [...cards.keys, cards.next] : cards.keys;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div>
          <label className="text-sm font-medium">Routes</label>
          <p className="text-xs text-muted-foreground">
            Evaluated in order. With the default <em>move</em> action, each piece of telemetry matches at most one route.
          </p>
        </div>

        {routes.length === 0 && tableShowable && !held.held && (
          <InlineAlert variant="warn" title="No routes configured">
            Add at least one route — the collector rejects a routing connector with an empty table.
          </InlineAlert>
        )}

        {!tableShowable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <SortableList list="route" items={keys} onReorder={moveRoute} listClassName="space-y-2" contextId="routing-connector-routes">
            {(key, index, id) => {
              const isHeld = held.held && index === routes.length;
              return (
                <SortableItem key={key} id={id} disabled={form.disabled || isHeld}>
                  {({ isDragging, dragHandleProps }) => (
                    <div
                      className={`rounded-md border border-border bg-card overflow-hidden ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}
                    >
                      <ItemScope listPath={["table"]} index={index} held={isHeld ? held : undefined} seed={{ context: "resource" }}>
                        <RouteCard
                          index={index}
                          expanded={expanded.has(key)}
                          onToggle={() => toggle(key)}
                          onRemove={() => (isHeld ? held.drop() : removeRoute(index))}
                          handle={<SortableHandle {...dragHandleProps} disabled={form.disabled || isHeld} />}
                          held={isHeld ? held : undefined}
                          options={options}
                        />
                      </ItemScope>
                    </div>
                  )}
                </SortableItem>
              );
            }}
          </SortableList>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRoute}
          className="w-full"
          disabled={form.disabled || !tableShowable || held.held}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Route
        </Button>
      </div>

      <ConfigSection title="Fallback & Errors">
        <PipelineListField
          path={["default_pipelines"]}
          id="routing-default-pipelines"
          label="Default Pipelines"
          options={options}
          helpText="Pipelines for telemetry that matches no route."
          addButtonText="Add Pipeline"
          emptyRemovesKey
        />

        {!hasDefaultPipelines && (
          <InlineAlert variant="warn" title="Unmatched telemetry is dropped">
            Without default pipelines, telemetry that matches no route is silently discarded — no error, no log.
          </InlineAlert>
        )}

        <SelectField
          path={["error_mode"]}
          id="routing-error-mode"
          label="Error Mode"
          defaultValue="ignore"
          description="How OTTL evaluation errors are handled. propagate drops the whole payload; ignore logs the error and routes to the default pipelines; silent does the same without logging."
          options={ERROR_MODES}
        />
      </ConfigSection>
    </div>
  );
}

/** A route's card, under its `ItemScope` (the item's own, or the held card's). */
function RouteCard({
  index,
  expanded,
  onToggle,
  onRemove,
  handle,
  held,
  options,
}: {
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  handle: ReactNode;
  held: HeldItem | undefined;
  options: readonly { name: string }[];
}) {
  const form = useForm();
  const adjustments = useAdjustments();
  const showable = held !== undefined || form.read([]).kind === "map";
  const inText = showable ? kindIn(form) : null;
  // The kind chosen with neither key in the text: held until an expression is typed. It follows
  // the text's key while there is one, so a cleared expression keeps its kind.
  const [heldKind, setHeldKind] = useState<Kind>(inText ?? "condition");
  if (inText !== null && inText !== heldKind) setHeldKind(inText);
  const kind = inText ?? heldKind;
  const contextView = form.read(["context"]);
  const context = contextView.kind === "scalar" ? textOf(contextView) : "";
  const expression = textOf(form.read([kind]));
  const pipelinesView = form.read(["pipelines"]);
  const targets =
    pipelinesView.kind === "list"
      ? pipelinesView.value.map((_item, at) => textOf(form.read(["pipelines", at]))).filter((name) => name.trim() !== "")
      : [];
  const target = targets.length > 0 ? targets.join(", ") : "no pipelines";
  const summary = expression.trim() ? `${expression} → ${target}` : `no ${kind} → ${target}`;

  const setContext = (next: string) => {
    if (next !== "request") {
      form.set(["context"], next);
      return;
    }
    // config.go:106-112: the request context refuses a statement.
    const hasStatement = form.read(["statement"]).kind !== "absent";
    const hasCondition = form.read(["condition"]).kind !== "absent";
    if (!hasStatement) {
      form.set(["context"], next);
      // A held kind follows: the request context takes a condition.
      if (inText === null) setHeldKind("condition");
      return;
    }
    const changes: ValueChange[] = [
      { path: ["context"], value: next },
      hasCondition ? { path: ["statement"], remove: true } : { path: ["statement"], renameTo: "condition" },
    ];
    adjustments.note([STATEMENT_TO_CONDITION], form.apply(changes));
  };

  const setKind = (next: Kind) => {
    if (next === kind) return;
    if (inText === null) setHeldKind(next);
    else form.rename([inText], next);
  };

  const placeholder = EXPRESSION_PLACEHOLDERS[context] ?? EXPRESSION_PLACEHOLDERS.resource!;
  return (
    <>
      <div className="flex items-center justify-between p-2.5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {handle}
          <button
            type="button"
            className="flex items-center gap-2 flex-1 min-w-0 hover:bg-accent px-2 py-1 rounded text-left"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">Route {index + 1}</div>
              <div className="text-xs text-muted-foreground truncate font-mono">{summary}</div>
            </div>
          </button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove route"
          onClick={onRemove}
          disabled={form.disabled}
          className="text-fail hover:text-fail hover:bg-fail-soft"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-border p-2.5 space-y-3 bg-muted/50">
          {!showable ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <SelectField
                  path={["context"]}
                  id={`route-${index}-context`}
                  label="Context"
                  placeholder=""
                  description={CONTEXT_DESCRIPTION}
                  options={CONTEXTS}
                  onSelect={setContext}
                />

                <ConfigField
                  label="Match Using"
                  htmlFor={`route-${index}-match`}
                  defaultValue="condition"
                  description="Statement mutates matched data in the same pass; condition only matches."
                >
                  <Select
                    value={kind}
                    onValueChange={(value) => setKind(value as Kind)}
                    disabled={form.disabled || context === "request"}
                  >
                    <SelectTrigger id={`route-${index}-match`}>
                      <SelectValue placeholder="Select kind" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="condition">Condition (boolean expression)</SelectItem>
                      <SelectItem value="statement">Statement (route() where ...)</SelectItem>
                    </SelectContent>
                  </Select>
                </ConfigField>
              </div>

              <TextareaField
                path={[kind]}
                id={`route-${index}-expression`}
                label={kind === "statement" ? "Statement" : "Condition"}
                description={
                  kind === "statement"
                    ? "OTTL statement: route() where <expr>, or an editor like delete_key(...) where <expr>."
                    : "OTTL boolean expression evaluated against the selected context."
                }
                placeholder={kind === "statement" ? `route() where ${placeholder}` : placeholder}
                rows={2}
                className="font-mono text-xs"
              />

              {context === "request" && (
                <InlineAlert variant="info">
                  The request context only supports a single <span className="font-mono">==</span> or{" "}
                  <span className="font-mono">!=</span> comparison on HTTP headers / gRPC metadata, e.g.{" "}
                  <span className="font-mono">request["X-Tenant"] == "acme"</span>. gRPC metadata keys are lowercased.
                </InlineAlert>
              )}

              <SelectField
                path={["action"]}
                id={`route-${index}-action`}
                label="Action"
                defaultValue="move"
                description="move removes matched data from later routes; copy keeps it available for them and the default pipelines."
                options={ACTIONS}
              />

              <PipelineListField
                path={["pipelines"]}
                id={`route-${index}-targets`}
                label="Target Pipelines"
                options={options}
                helpText={TARGETS_HELP}
                addButtonText="Add Pipeline"
                keepLast={ROUTE_KEEPS_LAST_PIPELINE}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}
