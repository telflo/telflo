import { TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { StringListField } from "./shared/StringListField.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The bearer token auth extension's form (ADR 0018), over the form's
 * fields (D9b decisions 2 and 3): each field writes its own key, and
 * clearing one removes it. Tokens are written by item; removing the last
 * removes `tokens`.
 *
 * Carried forward (Parity Notes): Scheme keeps an empty value, `scheme:
 * ""`, which the collector reads as "send the bare token" (an empty scheme
 * isn't prepended, `bearertokenauth.go`, contrib v0.162.0; ClickStack's
 * shipped config uses it); once written it can't be unset here, only in
 * the YAML box.
 *
 * The collector's defaults (`createDefaultConfig`, contrib v0.162.0):
 * header `Authorization`, scheme `Bearer`.
 *
 * No token reaches an attribute: the token rows' remove buttons say
 * "Remove" (decision 10; Preflight ruling 5).
 */

/** Whether the text holds a truthy value. */
function truthy(view: ValueView): boolean {
  return view.kind !== "absent" && Boolean(view.value);
}

export function BearerTokenAuthExtensionForm() {
  const form = useForm();
  const token = form.read(["token"]);
  const tokens = form.read(["tokens"]);
  const filename = form.read(["filename"]);
  const hasCredential = truthy(token) || (tokens.kind === "list" && tokens.value.length > 0) || truthy(filename);

  return (
    <div className="space-y-4">
      {!hasCredential && (
        <InlineAlert variant="warn">
          Provide a token, a tokens list, or a filename — the extension fails collector validation without a credential
          source.
        </InlineAlert>
      )}

      <TextField
        path={["token"]}
        id="bearertokenauth-token"
        label="Token"
        description="Single static token. Prefer an ${env:VAR} reference over a literal value."
        placeholder="e.g. ${env:OTLP_AUTH_TOKEN}"
      />

      <StringListField
        path={["tokens"]}
        label="Tokens"
        description="Any listed token is accepted (useful on the receiver side for rotation)."
        placeholder="e.g. ${env:OTLP_AUTH_TOKEN}"
        emptyRemovesKey
      />

      <TextField
        path={["filename"]}
        id="bearertokenauth-filename"
        label="Token File"
        description="File parsed line by line; the first whitespace-delimited word on each line is a token."
        placeholder="e.g. /etc/otelcol/tokens"
      />

      {truthy(token) && truthy(filename) && (
        <InlineAlert variant="warn">
          Both token and filename are set — the collector ignores token when a filename is configured.
        </InlineAlert>
      )}

      <TextField
        path={["scheme"]}
        id="bearertokenauth-scheme"
        label="Scheme"
        defaultValue="Bearer"
        description='Prepended to the credential ("Bearer <token>"). An explicitly empty scheme sends the bare token.'
        placeholder="Bearer (collector default when unset)"
        keepEmpty
      />

      <TextField
        path={["header"]}
        id="bearertokenauth-header"
        label="Header"
        defaultValue="Authorization"
        description="Header (HTTP) or metadata key (gRPC) carrying the credential."
        placeholder="Authorization"
      />

      <p className="text-[11px] leading-4 text-muted-foreground">
        Reference this extension from a receiver or exporter via auth.authenticator. Upstream requires TLS on exporters
        using bearer auth, so tokens are never sent in cleartext.
      </p>
    </div>
  );
}
