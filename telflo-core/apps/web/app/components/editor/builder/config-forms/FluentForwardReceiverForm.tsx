import { TextField } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";

/*
 * The Fluent Forward receiver's form, over the form's fields: Endpoint writes
 * its own key.
 *
 * - Clearing Endpoint writes `""` (a `keepEmpty` field). The collector has
 *   no default endpoint (`receiver/fluentforwardreceiver/factory.go:27-29`
 *   at contrib v0.162.0); an empty one listens on a random TCP port
 *   (`receiver.go:81-92`), which the config validation reports.
 * - Copy: the tag attribute is `fluent.tag` (`conversion.go:22`,
 *   `tagAttributeKey`), not `fluentd.tag`.
 *
 * The id is fixed; no value reaches an attribute.
 */

/** The alert under Endpoint (the tag attribute is `fluent.tag`, `conversion.go:22`). */
export const FLUENT_FORWARD_ALERT =
  "The receiver does not support TLS or the Forward protocol handshake. The FluentD tag is stored in the fluent.tag log attribute, and a UDP heartbeat responder runs on the same port for TCP endpoints.";

export function FluentForwardReceiverForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="fluentforward-endpoint"
        label="Endpoint"
        required
        description="TCP address to listen on, or a unix://<socket_path> Unix domain socket. Point Fluent Bit/Fluentd forward outputs here."
        placeholder="e.g. 0.0.0.0:8006"
        keepEmpty
      />

      <InlineAlert variant="info">{FLUENT_FORWARD_ALERT}</InlineAlert>
    </div>
  );
}
