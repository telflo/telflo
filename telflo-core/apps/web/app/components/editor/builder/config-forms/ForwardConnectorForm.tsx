import { InlineAlert } from "./InlineAlert.js";

/*
 * The forward connector's form (ADR 0018). The forward connector has no
 * configuration options (its `Config` is empty at collector v0.162.0), so the
 * form only confirms the intentionally empty value; it writes nothing.
 */

export function ForwardConnectorForm() {
  return (
    <div className="space-y-4">
      <InlineAlert variant="info">
        Emitted as an empty <span className="font-mono">forward: {"{}"}</span> block. Routing is defined by the pipeline
        wiring on the canvas.
      </InlineAlert>
    </div>
  );
}
