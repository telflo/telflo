import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { FormScope, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The OIDC auth extension's form, over the form's fields. The providers
 * are collapsible cards, not sortable; each card's fields write their own
 * key under `providers.<index>`. "Add Provider" appends `{}` and opens it;
 * the trash button removes the item's lines (the last leaves
 * `providers: []`). Clearing Issuer URL writes `""`; clearing any other
 * field removes its key; unticking "Skip the audience check" removes
 * `ignore_audience`.
 *
 * The deprecated single-provider form (`issuer_url`, `audience`, … at the
 * top level, which ClickStack's shipped configs use) is flagged and never
 * written: its keys stay as they are, whatever the form edits.
 *
 * The collector's default attribute is `authorization` (`defaultAttribute`,
 * contrib v0.162.0). A provider needs an audience unless the check is
 * skipped (`ProviderCfg.Validate`).
 *
 * Cards are keyed and identified by index (`oidc-0-issuer`); an issuer URL
 * is shown in its card's header as text, never in an attribute.
 */

const LEGACY_KEYS = ["issuer_url", "audience", "ignore_audience", "issuer_ca_path", "username_claim", "groups_claim"];

/** Whether the text holds a truthy value. */
function truthy(view: ValueView): boolean {
  return view.kind !== "absent" && Boolean(view.value);
}

function isLegacyForm(form: FormSource): boolean {
  return LEGACY_KEYS.some((key) => truthy(form.read([key])));
}

export function OIDCAuthExtensionForm() {
  const form = useForm();
  const view = form.read(["providers"]);
  const count = view.kind === "list" ? view.value.length : 0;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(count === 1 ? [0] : []));

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const addProvider = () => {
    if (form.set(["providers", count], {}) === "refused") return;
    setExpanded((prev) => new Set(prev).add(count));
  };

  const removeProvider = (index: number) => {
    if (form.remove(["providers", index]) === "refused") return;
    setExpanded((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {isLegacyForm(form) && (
        <InlineAlert variant="warn">
          This config uses the deprecated single-provider form (issuer_url at the top level). It still works —
          ClickStack's shipped configs use it — but upstream will drop it; edit it in the YAML editor or migrate to the
          providers list below.
        </InlineAlert>
      )}

      <TextField
        path={["attribute"]}
        id="oidc-attribute"
        label="Auth Attribute"
        defaultValue="authorization"
        description="Header (HTTP) or metadata key (gRPC) the bearer JWT is read from."
        placeholder="authorization"
      />

      <ConfigField
        label="Providers"
        description="Incoming tokens are matched to a provider by their iss claim; unmatched issuers are rejected."
      >
        {view.kind !== "list" && view.kind !== "absent" ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: count }, (_item, index) => {
              const isExpanded = expanded.has(index);
              const issuer = form.read(["providers", index, "issuer_url"]);
              return (
                <div key={index} className="border border-border rounded-md overflow-hidden">
                  <div
                    className="flex items-center justify-between p-2.5 bg-muted/50 cursor-pointer hover:bg-muted"
                    onClick={() => toggle(index)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-medium text-sm">
                        {truthy(issuer) && issuer.kind === "scalar"
                          ? (issuer.source ?? String(issuer.value))
                          : "(configure issuer)"}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove provider"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeProvider(index);
                      }}
                      disabled={form.disabled}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {isExpanded && (
                    <div className="p-2.5 space-y-2">
                      <FormScope path={["providers", index]}>
                        <ProviderFields index={index} />
                      </FormScope>
                    </div>
                  )}
                </div>
              );
            })}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addProvider}
              className="w-full"
              disabled={form.disabled}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Provider
            </Button>
          </div>
        )}
      </ConfigField>

      <p className="text-[11px] leading-4 text-muted-foreground">
        Reference this extension from a receiver via auth.authenticator: oidc.
      </p>
    </div>
  );
}

/** A provider card's fields, scoped to its item. */
function ProviderFields({ index }: { index: number }) {
  const form = useForm();
  const item = form.read([]);
  if (item.kind !== "map" && item.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  const ignoreAudience = form.read(["ignore_audience"]);
  const ignoreChecked = ignoreAudience.kind === "absent" ? false : typeof ignoreAudience.value === "boolean" ? ignoreAudience.value : null;
  const audienceMissing = !truthy(form.read(["audience"])) && !truthy(ignoreAudience);

  return (
    <>
      <TextField
        path={["issuer_url"]}
        id={`oidc-${index}-issuer`}
        label="Issuer URL"
        required
        description="Base URL of the OIDC provider; JWKS keys are discovered from its well-known endpoint."
        placeholder="e.g. https://idp.example.com/realms/main"
        keepEmpty
      />

      <TextField
        path={["audience"]}
        id={`oidc-${index}-audience`}
        label="Audience"
        description="Expected aud claim. Required unless the audience check is skipped."
        placeholder="e.g. collector"
      />

      <div className="flex items-center gap-2">
        <Checkbox
          id={`oidc-${index}-ignore-audience`}
          checked={ignoreChecked ?? false}
          onCheckedChange={(checked) => {
            if ((checked === true) === ignoreChecked) return;
            if (checked === true) form.set(["ignore_audience"], true);
            else form.remove(["ignore_audience"]);
          }}
          disabled={form.disabled || ignoreChecked === null}
        />
        <Label htmlFor={`oidc-${index}-ignore-audience`} className="text-xs text-muted-foreground">
          Skip the audience check (weakens verification)
        </Label>
      </div>
      {ignoreChecked === null && <p className="ml-6 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

      {audienceMissing && (
        <InlineAlert variant="warn">
          An audience is required unless the check is explicitly skipped — the collector rejects this provider otherwise.
        </InlineAlert>
      )}

      <TextField
        path={["username_claim"]}
        id={`oidc-${index}-username-claim`}
        label="Username Claim"
        description="Claim used as the username when sub isn't suitable."
        placeholder="e.g. email"
      />

      <TextField
        path={["groups_claim"]}
        id={`oidc-${index}-groups-claim`}
        label="Groups Claim"
        description="Claim holding group membership."
        placeholder="e.g. groups"
      />

      <TextField
        path={["issuer_ca_path"]}
        id={`oidc-${index}-ca-path`}
        label="Issuer CA Path"
        description="CA cert for the issuer's TLS endpoint, when it isn't publicly trusted."
        placeholder="e.g. /etc/pki/tls/cert.pem"
      />

      <TextField
        path={["public_keys_file"]}
        id={`oidc-${index}-keys-file`}
        label="Public Keys File"
        description="Local JWKS file; when set, remote key discovery is disabled and the file is watched for changes."
        placeholder="e.g. /etc/otelcol/jwks.json"
      />
    </>
  );
}
