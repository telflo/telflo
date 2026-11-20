import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { InlineAlert } from "../InlineAlert.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The OTLP exporters' `tls.insecure` box: a warn alert and checkbox, shown
 * while a `tls` block is there, writing `insecure` in it by key.
 *
 * "Skip TLS verification (insecure)" would say something the collector doesn't
 * do (its `configtls`, `configgrpc` and `confighttp` at v0.162.0). `insecure`
 * turns TLS off on gRPC (unless the endpoint is https:// or a CA file is set),
 * and on HTTP drops these settings, leaving the endpoint's scheme to decide.
 * Each exporter's label and hint say what it does, naming
 * `insecure_skip_verify` for skipping verification. Unset shows unticked (the
 * collector's `false`); a value that isn't a boolean leaves the box read-only
 * with the unshowable-value hint.
 */

export type InsecureProtocol = "grpc" | "http";

/** The label and the hint's two halves around `insecure_skip_verify`, per exporter. */
export const INSECURE_COPY: Readonly<Record<InsecureProtocol, { label: string; before: string; after: string }>> = {
  grpc: {
    label: "Disable TLS (plaintext, insecure)",
    before:
      "Sends without TLS, unless the endpoint starts with https:// or a CA file is set. To keep TLS but skip certificate checks, leave this off and set ",
    after: " in the YAML.",
  },
  http: {
    label: "Ignore these TLS settings (insecure)",
    before:
      "Without a CA file, the settings here are ignored and the endpoint's scheme decides TLS: http:// sends plaintext, https:// uses TLS and verifies the server. To skip verification, leave this off and set ",
    after: " in the YAML.",
  },
};

export function TLSInsecureCheckbox({ path, protocol }: { path: ValuePath; protocol: InsecureProtocol }) {
  const form = useForm();
  const view = form.read(path);
  const checked = view.kind === "absent" ? false : view.value === true || view.value === false ? view.value : null;
  const copy = INSECURE_COPY[protocol];

  return (
    <InlineAlert variant="warn">
      <div className="flex items-center gap-2">
        <Checkbox
          id="tls-insecure"
          checked={checked ?? false}
          onCheckedChange={(next) => {
            if ((next === true) !== checked) form.set(path, next === true);
          }}
          disabled={form.disabled || checked === null}
        />
        <Label htmlFor="tls-insecure" className="text-xs text-warn">
          {copy.label}
        </Label>
      </div>
      <p className="ml-6 mt-1 text-[11px] leading-4">
        {copy.before}
        <code className="font-mono">insecure_skip_verify</code>
        {copy.after}
      </p>
      {checked === null && <p className="ml-6 mt-1 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </InlineAlert>
  );
}
