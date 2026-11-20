import { FormScope, SelectField, TextField, useForm } from "../form-context.js";
import { presenceOf, SectionHint, SectionToggle, UnshowableSectionHint } from "./section-toggle.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * A Prometheus scrape job's `tls_config`: the TLS section's markup and copy
 * for the fields Prometheus has, over the form's fields.
 *
 * The receiver hands its `config:` block to Prometheus' strict loader
 * (contrib v0.162.0 `receiver/prometheusreceiver/config.go:187-205`;
 * prometheus v3.14.0 `config/config.go:81`, `yaml.UnmarshalStrict`), so the
 * block is prometheus/common v0.71.0's `TLSConfig`
 * (`config/http_config.go:1324-1353`), not the collector's `configtls`:
 * - The versions are `TLS10`-`TLS13` (`http_config.go:72-91`; `"1.2"` is
 *   refused, "unknown TLS version: 1.2"), so the box writes
 *   `{min_version: TLS12, max_version: TLS13}`. Prometheus has no default for
 *   either, so unset shows blank.
 * - No Client CA File, its reload, Reload Interval or the system
 *   pool box: the scrape client has no such keys, and the strict loader
 *   refuses them. A key already in the text is kept.
 * - The box reads "Customize TLS for this job's scrapes", with the hint
 *   that `scheme` decides whether TLS is used (an https scrape with no
 *   `tls_config` uses the system's CAs; the label and the ids never name
 *   the job).
 *
 * Ids are `<idPrefix>-…`, the prefix fixed by the form by the job's index
 * (`prometheus-job-0-tls`), never its name.
 */

/** The box's label and hint. */
export const PROMETHEUS_TLS_LABEL = "Customize TLS for this job's scrapes";
export const PROMETHEUS_TLS_HINT = "Off: https scrapes use the system's CAs. Scheme decides whether TLS is used.";

/** What ticking the box writes: Prometheus' version names (`http_config.go:72-77`). */
export const PROMETHEUS_TLS_SEED = { min_version: "TLS12", max_version: "TLS13" } as const;

const VERSIONS = [
  { value: "TLS10", label: "TLS 1.0" },
  { value: "TLS11", label: "TLS 1.1" },
  { value: "TLS12", label: "TLS 1.2" },
  { value: "TLS13", label: "TLS 1.3" },
] as const;

export function PrometheusTLSSection({ path, idPrefix }: { path: ValuePath; idPrefix: string }) {
  const form = useForm();
  const state = presenceOf(form.read(path));

  const toggle = (
    <div className="space-y-1.5">
      <SectionToggle
        id={`${idPrefix}-enable`}
        label={PROMETHEUS_TLS_LABEL}
        state={state}
        disabled={form.disabled}
        onToggle={(on) => {
          if (on) form.set(path, { ...PROMETHEUS_TLS_SEED });
          else form.remove(path);
        }}
      />
      <SectionHint>{PROMETHEUS_TLS_HINT}</SectionHint>
      {state === "unshowable" && <UnshowableSectionHint />}
    </div>
  );

  if (state !== "on") return toggle;

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/50 p-3">
      {toggle}

      <FormScope path={path}>
        <TextField
          path={["cert_file"]}
          id={`${idPrefix}-cert-file`}
          label="Certificate File"
          placeholder="e.g. /path/to/server.crt"
        />

        <TextField
          path={["key_file"]}
          id={`${idPrefix}-key-file`}
          label="Key File"
          description="Private key for the certificate."
          placeholder="e.g. /path/to/server.key"
        />

        <TextField
          path={["ca_file"]}
          id={`${idPrefix}-ca-file`}
          label="CA File"
          description="Trusted CA for verifying the peer certificate."
          placeholder="e.g. /path/to/ca.crt"
        />

        <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
          <SelectField
            path={["min_version"]}
            id={`${idPrefix}-min-version`}
            label="Min TLS Version"
            placeholder=""
            options={VERSIONS}
          />

          <SelectField
            path={["max_version"]}
            id={`${idPrefix}-max-version`}
            label="Max TLS Version"
            placeholder=""
            options={VERSIONS}
          />
        </div>
      </FormScope>
    </div>
  );
}
