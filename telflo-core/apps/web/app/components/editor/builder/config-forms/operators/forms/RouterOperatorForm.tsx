import { Plus, Trash2 } from "lucide-react";

import { TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useCardKeys } from "../../shared/card-keys.js";
import { useOperatorId } from "../operator-ids.js";
import { Button } from "~/components/ui/button.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";

/*
 * The `router` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's: each route's fields are
 * `op-<index>-route-expr-<route>` and `op-<index>-route-output-<route>`
 * (by index, never a value; decision 10).
 * The card shows no On Error or Condition for a router (`OperatorCard.tsx`,
 * decision 4).
 *
 * Routes are written by item (D9b decision 2): a route's Expression and
 * Output write that route's keys, so keys the form doesn't show (a route's
 * `attributes`, `router/config.go:41-45`) stay; Remove removes the route's
 * lines; the cards are keyed by their items (`useCardKeys`; D9c Ruling 68).
 * Expression, cleared, writes `""` (a route's key is kept, `keepEmpty`);
 * Output and Default Output, cleared, remove their keys. An output written as a
 * list (the collector's `[]string`, `config.go:37, 44`) is read-only with
 * decision 3's hint; so is a `routes` that isn't a list of mappings.
 *
 * Fixed (decision 3; Preflight ruling 18): Add Route appends `{expr: "true"}`
 * with no `output` (never `output: ""`, an operator no one has, which the
 * collector refuses, `pipeline/directed.go:151-152`). A
 * route without an output builds (`config.go:48-86`; the router's
 * `SetOutputIDs` is a no-op, `router/transformer.go:160-161`), and an entry
 * it matches goes to no operator (`transformer.go:98-118`): the hint under
 * its Output, "Entries this route matches are dropped until an output is
 * set.", says so while the route has none (or an empty list).
 * D9c Ruling 70: an unset Default Output (or an empty list) says the same of
 * the entries no route matches, "Entries no route matches are dropped until
 * a default output is set.": the collector adds a catch-all route only for
 * a `default` (`config.go:54-60`), and an entry no route matches goes to no
 * operator (`transformer.go:98-121`; `SetOutputIDs` is a no-op, `:160-161`).
 */

/** Under the Output of a route that has none (Preflight ruling 18). */
export const ROUTE_WITHOUT_OUTPUT_HINT = "Entries this route matches are dropped until an output is set.";

/** Under an unset Default Output (D9c Ruling 70). */
export const NO_DEFAULT_OUTPUT_HINT = "Entries no route matches are dropped until a default output is set.";

function RouteCard({ index, onRemove }: { index: number; onRemove: () => void }) {
  const form = useForm();
  const opId = useOperatorId();
  const output = form.read(["routes", index, "output"]);
  const noOutput = output.kind === "absent" || (output.kind === "list" && output.value.length === 0);
  return (
    <div className="space-y-2 p-3 bg-muted/50 rounded-md border border-border">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Route {index + 1}</span>
        <Button variant="ghost" size="sm" onClick={onRemove} type="button" aria-label="Remove" disabled={form.disabled}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <TextField
        path={["routes", index, "expr"]}
        id={opId(`route-expr-${index}`)}
        label="Expression"
        description="Condition for this route."
        placeholder='attributes.level == "error"'
        className="font-mono text-xs"
        keepEmpty
      />

      <TextField
        path={["routes", index, "output"]}
        id={opId(`route-output-${index}`)}
        label="Output"
        description="Operator ID to route matching entries to."
        placeholder="error_handler"
        className="font-mono text-xs"
      />
      {noOutput && <p className="text-[11px] leading-4 text-muted-foreground">{ROUTE_WITHOUT_OUTPUT_HINT}</p>}
    </div>
  );
}

export function RouterOperatorForm() {
  const form = useForm();
  const opId = useOperatorId();
  const view = form.read(["routes"]);
  const defaultView = form.read(["default"]);
  const noDefault = defaultView.kind === "absent" || (defaultView.kind === "list" && defaultView.value.length === 0);
  const count =
    view.kind === "absent"
      ? 0
      : view.kind === "list" && view.value.every((_route, index) => form.read(["routes", index]).kind === "map")
        ? view.value.length
        : null;
  // Routes keyed by their items (Ruling 68), so a Remove click can't land on the next route's card.
  const cards = useCardKeys(count === null || view.kind !== "list" ? [] : view.value);

  return (
    <div className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Route log entries to different operators based on conditions. Routes are evaluated in order; first match wins.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Routes</h3>

        {count === 0 && <p className="text-xs text-muted-foreground">No routes configured. Click &quot;Add Route&quot; to create a routing rule.</p>}
        {count === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

        {Array.from({ length: count ?? 0 }, (_unused, index) => (
          <RouteCard
            key={cards.keys[index]}
            index={index}
            onRemove={() => {
              flushHeldEdits();
              if (form.remove(["routes", index]) === "written") cards.remove(index);
            }}
          />
        ))}

        <Button
          onClick={() => {
            if (count === null) return;
            flushHeldEdits();
            form.set(["routes", count], { expr: "true" });
          }}
          size="sm"
          variant="outline"
          type="button"
          className="w-full"
          disabled={form.disabled || count === null}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Route
        </Button>
      </div>

      <TextField
        path={["default"]}
        id={opId("router-default")}
        label="Default Output"
        description="Operator ID for entries that don't match any route."
        placeholder="default_handler"
        className="font-mono text-xs"
      />
      {noDefault && <p className="text-[11px] leading-4 text-muted-foreground">{NO_DEFAULT_OUTPUT_HINT}</p>}

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Note:</strong> Output IDs must reference operators defined elsewhere in the pipeline.
          Make sure the referenced operators exist.
        </p>
      </div>
    </div>
  );
}
