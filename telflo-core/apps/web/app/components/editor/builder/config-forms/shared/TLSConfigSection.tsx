import { CheckboxField, FormScope, SelectField, TextField, useForm } from "../form-context.js";
import { idPart, presenceOf, SectionHint, SectionToggle, UnshowableSectionHint } from "./section-toggle.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The TLS section, over the form's fields. Bound to the `tls` block's path
 * under the form.
 *
 * The box shows whether a `tls` block is there; ticking it writes
 * `min_version: "1.2"` and `max_version: "1.3"` as the block, unticking
 * removes the block. Each is one change.
 *
 * Two variants:
 * - "server" (receivers, health_check): the section as it is;
 * - "client" (the OTLP exporters): with no `tls` block an exporter still
 *   uses TLS, with the system's CAs, as its endpoint allows, so the box
 *   reads "Customize TLS for …" with a hint saying so, and Client CA File
 *   and its reload (server settings the collector refuses on an exporter)
 *   aren't shown. It writes what the server variant writes.
 * The exporters' `insecure` box is the form's, not this section's.
 * resourcedetection's OpenShift detector is a client of the Kubernetes API
 * (`configtls.ClientConfig`,
 * `processor/resourcedetectionprocessor/internal/openshift/config.go:50-52`)
 * and takes the client variant, with its own hint (`clientHint`): with no CA
 * file it trusts the service account's CA (`config.go:75-77`), not the
 * system's.
 *
 * The versions show unset as unset, the collector's default as the
 * placeholder and the "Default" hint.
 *
 * `keepKeys` names keys of the block that aren't the section's (remote
 * write's `insecure`, its own box, always shown). The box is on while the
 * block holds any other key; unticking removes the others and keeps those
 * (the whole block when it holds none of them); ticking writes the versions
 * into the block beside them, by key.
 */

export type TLSVariant = "server" | "client";

/** The client variant's hint under its box. */
export const CLIENT_TLS_HINT = "Off: the collector uses TLS with the system's CAs, as the endpoint allows.";

const VERSIONS = [
  { value: "1.0", label: "TLS 1.0" },
  { value: "1.1", label: "TLS 1.1" },
  { value: "1.2", label: "TLS 1.2" },
  { value: "1.3", label: "TLS 1.3" },
] as const;

interface TLSConfigSectionProps {
  /** The `tls` block's path under the form. */
  path: ValuePath;
  /** The form's name for the protocol ("gRPC", "OTLP gRPC"): the label, and the fields' fixed ids. */
  protocolLabel: string;
  variant: TLSVariant;
  /** The client variant's hint under its box, where it isn't `CLIENT_TLS_HINT`. */
  clientHint?: string;
  /** Keys of the block that aren't the section's: kept when it is unticked, and not counted as on (remote write's `insecure`). */
  keepKeys?: readonly string[];
}

export function TLSConfigSection({ path, protocolLabel, variant, clientHint = CLIENT_TLS_HINT, keepKeys = [] }: TLSConfigSectionProps) {
  const form = useForm();
  const block = form.read(path);
  const keys = block.kind === "map" ? Object.keys(block.value) : [];
  const kept = keys.filter((key) => keepKeys.includes(key));
  const own = keys.filter((key) => !keepKeys.includes(key));
  const presence = presenceOf(block);
  const state = presence === "on" && kept.length > 0 && own.length === 0 ? "off" : presence;
  const suffix = idPart(protocolLabel);
  const client = variant === "client";

  const toggle = (
    <SectionToggle
      id={`tls-enable-${suffix}`}
      label={client ? `Customize TLS for ${protocolLabel}` : `Enable TLS for ${protocolLabel}`}
      state={state}
      disabled={form.disabled}
      onToggle={(on) => {
        if (on && kept.length > 0) {
          form.apply([
            { path: [...path, "min_version"], value: "1.2" },
            { path: [...path, "max_version"], value: "1.3" },
          ]);
        } else if (on) {
          form.set(path, { min_version: "1.2", max_version: "1.3" });
        } else if (kept.length > 0) {
          form.apply(own.map((key) => ({ path: [...path, key], remove: true as const })));
        } else {
          form.remove(path);
        }
      }}
    />
  );
  const hint = client && <SectionHint>{clientHint}</SectionHint>;

  if (state !== "on") {
    if (!client && state === "off") return toggle;
    return (
      <div className="space-y-1.5">
        {toggle}
        {hint}
        {state === "unshowable" && <UnshowableSectionHint />}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/50 p-3">
      {client ? (
        <div className="space-y-1.5">
          {toggle}
          {hint}
        </div>
      ) : (
        toggle
      )}

      <FormScope path={path}>
        {/* Certificate Files */}
        <TextField
          path={["cert_file"]}
          id={`tls-cert-file-${suffix}`}
          label="Certificate File"
          placeholder="e.g. /path/to/server.crt"
        />

        <TextField
          path={["key_file"]}
          id={`tls-key-file-${suffix}`}
          label="Key File"
          description="Private key for the certificate."
          placeholder="e.g. /path/to/server.key"
        />

        <TextField
          path={["ca_file"]}
          id={`tls-ca-file-${suffix}`}
          label="CA File"
          description="Trusted CA for verifying the peer certificate."
          placeholder="e.g. /path/to/ca.crt"
        />

        {/* Client Certificate Verification */}
        {!client && (
          <div className="space-y-4 border-t border-border pt-3">
            <TextField
              path={["client_ca_file"]}
              id={`tls-client-ca-file-${suffix}`}
              label="Client CA File"
              description="CA for validating client certificates (mutual TLS)."
              placeholder="e.g. /path/to/client-ca.crt"
            />

            <CheckboxField
              path={["client_ca_file_reload"]}
              id={`client-ca-reload-${suffix}`}
              label="Enable client CA file reload"
              defaultChecked={false}
              labelClassName="text-xs text-muted-foreground"
            />
          </div>
        )}

        {/* TLS Version */}
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
          <SelectField
            path={["min_version"]}
            id={`tls-min-version-${suffix}`}
            label="Min TLS Version"
            defaultValue="1.2"
            options={VERSIONS}
          />

          <SelectField
            path={["max_version"]}
            id={`tls-max-version-${suffix}`}
            label="Max TLS Version"
            defaultValue="1.3"
            options={VERSIONS}
          />
        </div>

        {/* Advanced Settings */}
        <div className="space-y-4 border-t border-border pt-3">
          <TextField
            path={["reload_interval"]}
            id={`tls-reload-interval-${suffix}`}
            label="Reload Interval"
            defaultValue="0s (disabled)"
            description="How often to reload certificates, e.g. 1h or 30m."
            placeholder="0s"
          />

          <CheckboxField
            path={["include_system_ca_certs_pool"]}
            id={`system-ca-${suffix}`}
            label="Include system CA certificates pool"
            defaultChecked={false}
            labelClassName="text-xs text-muted-foreground"
          />
        </div>
      </FormScope>
    </div>
  );
}
