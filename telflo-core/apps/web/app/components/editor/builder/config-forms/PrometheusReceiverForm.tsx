import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormProvider,
  formSource,
  FormScope,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { ExcludingScope } from "./shared/ExcludingScope.js";
import { PrometheusTLSSection } from "./shared/PrometheusTLSSection.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Prometheus receiver's form, over the form's fields. The scrape jobs
 * are a sortable list of cards; each card's fields write their own key
 * under `config.scrape_configs.<index>` (`FormScope`), so keys the form
 * doesn't show (relabeling, service discovery, a job's `labels`) stay.
 *
 * The receiver hands `config:` to Prometheus' strict loader (contrib
 * v0.162.0 `receiver/prometheusreceiver/config.go:187-205`; prometheus
 * v3.14.0 `config/config.go:81`), so a job's keys and values are
 * Prometheus' own.
 *
 * - Dragging a job moves its own lines (`form.move`); a card's expanded state
 *   follows the card (`useCardKeys`), not the index. The first card starts
 *   expanded. Ids are by index (`job-name-0`, sortable `job-0`), never a
 *   value.
 * - Static Targets are the first target group's `targets`
 *   (`static_configs.0.targets`): Add Target appends
 *   `localhost:8080`, and on a job with no target group writes
 *   `static_configs: [{targets: [localhost:8080]}]`; other groups and a
 *   group's `labels` stay as written.
 * - Fixed: Report Extra Scrape Metrics writes
 *   `config.global.extra_scrape_metrics`, Prometheus' own key, which each
 *   job falls back to (`config/config.go:540, 943-945`), not the receiver's
 *   `report_extra_scrape_metrics`, removed in v0.149.0 and refused (contrib
 *   `CHANGELOG.md:3911-3913`; `config.go:30-58` has no such field). A key
 *   already in the text is left alone.
 * - Fixed: Add Job seeds the first `job-N` (N from the job count + 1 up) no
 *   job has: Prometheus refuses two jobs of one name
 *   (`config/config.go:444`), and `job-${count + 1}` alone could repeat one.
 * - Fixed: the Security box's TLS is `PrometheusTLSSection` (`TLS12`/`TLS13`,
 *   no server-only fields), its ids by the job's index
 *   (`prometheus-job-0-tls-…`), never the job's name.
 * - Changed: basic authentication and authorization exclude each other
 *   (prometheus/common v0.71.0 `config/http_config.go:434-437`): writing
 *   into one removes the other in the same change, with a toast. Each block
 *   goes with its last key cleared (a pruning scope; a key it doesn't show,
 *   `password`, keeps it).
 * - Changed: Honor Timestamps shows ticked while unset (Prometheus'
 *   default, `config/config.go:208`); Scrape Timeout's default says it is
 *   the interval when that is shorter (`config/config.go:913- 915`); Scheme
 *   shows its default as a hint, not a value; the interval and timeout are
 *   checked with Prometheus' grammar (`1d`, `1h30m`;
 *   `shared/prometheus-duration.ts`).
 * - Job Name keeps `""` when cleared (an item's key; Prometheus refuses it,
 *   `config/config.go:868-870`, and the config validation reports it).
 */

/** The toasts for a setting a change removes with it. */
export const REMOVED_AUTHORIZATION = "Removed authorization: it can't be used with basic authentication.";
export const REMOVED_BASIC_AUTH = "Removed basic authentication: it can't be used with authorization.";

/** Scrape Timeout's default: Prometheus' 10s, or the interval when shorter (`config/config.go:913-915`). */
export const SCRAPE_TIMEOUT_DEFAULT = "10s, or the scrape interval if shorter";

/** Where the jobs are. */
const JOBS: ValuePath = ["config", "scrape_configs"];

/** Add Target's seed. */
const TARGET_SEED = "localhost:8080";

const SCHEMES = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
] as const;

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/** The first `job-N`, from `count + 1` up, that no job is named (Prometheus refuses a repeat, `config/config.go:444`). */
export function nextJobName(names: readonly string[], count: number): string {
  let n = count + 1;
  while (names.includes(`job-${n}`)) n++;
  return `job-${n}`;
}

export function PrometheusReceiverForm() {
  const form = useForm();
  const jobsView = form.read(JOBS);
  const jobs = jobsView.kind === "list" ? jobsView.value : [];
  const count = jobs.length;
  const cards = useCardKeys(jobs);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set([0]));
  const jobsShowable = jobsView.kind === "list" || jobsView.kind === "absent";
  const nameOf = (index: number) => textOf(form.read([...JOBS, index, "job_name"]));

  const toggle = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addJob = () => {
    const names = jobs.map((_job, index) => nameOf(index));
    // Add Job's seed, with a name no job has.
    const job = { job_name: nextJobName(names, count), scrape_interval: "10s", static_configs: [{ targets: ["localhost:8888"] }] };
    const result = jobsView.kind === "list" ? form.set([...JOBS, count], job) : form.set(JOBS, [job]);
    if (result !== "written") return;
    setExpanded(new Set([...expanded, cards.next]));
    cards.add();
  };

  const removeJob = (index: number) => {
    if (form.remove([...JOBS, index]) === "written") cards.remove(index);
  };

  const moveJob = (from: number, to: number) => {
    if (form.move(JOBS, from, to) === "written") cards.move(from, to);
  };

  return (
    <div className="space-y-4">
      <CheckboxField
        path={["trim_metric_suffixes"]}
        id="trim-suffixes"
        label="Trim Metric Suffixes"
        description="Strip type/unit suffixes to align with OTel naming."
        defaultChecked={false}
        {...DESCRIBED_ROW}
      />

      <CheckboxField
        path={["config", "global", "extra_scrape_metrics"]}
        id="extra-metrics"
        label="Report Extra Scrape Metrics"
        description="Adds scrape_* diagnostic metrics per target."
        defaultChecked={false}
        {...DESCRIBED_ROW}
      />

      <p className="text-sm font-medium text-foreground">Scrape Jobs</p>

      {count === 0 && jobsShowable && <p className="text-[11px] leading-4 text-muted-foreground">No scrape jobs configured</p>}

      {!jobsShowable ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <SortableList list="job" items={cards.keys} onReorder={moveJob} listClassName="space-y-3" contextId="prometheus-scrape-jobs">
          {(key, index, id) => (
            <SortableItem key={key} id={id} disabled={form.disabled}>
              {({ isDragging, dragHandleProps }) => (
                <div className={`border border-border rounded-md p-2.5 space-y-2 ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <SortableHandle {...dragHandleProps} disabled={form.disabled} />
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={expanded.has(key)}
                        className="flex min-w-0 items-center gap-2 text-sm font-medium hover:text-brand"
                      >
                        {expanded.has(key) ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <span className="truncate">
                          Job #{index + 1}: {nameOf(index)}
                        </span>
                      </button>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove job"
                      onClick={() => removeJob(index)}
                      disabled={form.disabled}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {expanded.has(key) && (
                    <FormScope path={[...JOBS, index]}>
                      <JobFields index={index} />
                    </FormScope>
                  )}
                </div>
              )}
            </SortableItem>
          )}
        </SortableList>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={addJob}
        type="button"
        disabled={form.disabled || !jobsShowable}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Job
      </Button>

      <ConfigSection title="Security" count={count}>
        {count === 0 && (
          <p className="text-[11px] leading-4 text-muted-foreground">Add a scrape job above to configure TLS and authentication</p>
        )}

        {cards.keys.map((key, index) => (
          <div key={key} className="border border-border rounded-md p-2.5 space-y-2">
            <h4 className="text-sm font-medium truncate">
              Job #{index + 1}: {nameOf(index)}
            </h4>
            <FormScope path={[...JOBS, index]}>
              <JobSecurity index={index} />
            </FormScope>
          </div>
        ))}
      </ConfigSection>

      <InlineAlert variant="info" title="YAML-only features">
        Service discovery (Kubernetes, Consul), relabeling, and OAuth2 are not available in this form. Edit them in the YAML
        editor.
      </InlineAlert>
    </div>
  );
}

/** The described box rows. */
const DESCRIBED_ROW = {
  rowClassName: "flex items-start gap-2.5",
  describedClassName: "grid flex-1 gap-1 leading-none",
  labelClassName: "cursor-pointer text-sm font-medium",
} as const;

/** The hint under a job whose item isn't a mapping. */
function UnshowableJob() {
  return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
}

/** A job card's fields, under `config.scrape_configs.<index>`. */
function JobFields({ index }: { index: number }) {
  const form = useForm();
  if (form.read([]).kind !== "map") {
    return (
      <div className="space-y-2 pt-2 border-t">
        <UnshowableJob />
      </div>
    );
  }
  return (
    <div className="space-y-2 pt-2 border-t">
      <TextField
        path={["job_name"]}
        id={`job-name-${index}`}
        label="Job Name"
        required
        description="Must be unique across jobs."
        placeholder="e.g. my-job"
        keepEmpty
      />

      <div className="grid grid-cols-2 gap-2">
        <DurationField
          path={["scrape_interval"]}
          id={`scrape-interval-${index}`}
          label="Scrape Interval"
          defaultValue="1m"
          placeholder="1m"
          grammar="prometheus"
        />

        <DurationField
          path={["scrape_timeout"]}
          id={`scrape-timeout-${index}`}
          label="Scrape Timeout"
          defaultValue={SCRAPE_TIMEOUT_DEFAULT}
          placeholder="10s"
          grammar="prometheus"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <TextField
          path={["metrics_path"]}
          id={`metrics-path-${index}`}
          label="Metrics Path"
          defaultValue="/metrics"
          placeholder="/metrics"
        />

        <SelectField path={["scheme"]} id={`scheme-${index}`} label="Scheme" defaultValue="http" options={SCHEMES} />
      </div>

      <StaticTargets index={index} />

      <details className="border border-border rounded-md p-2.5">
        <summary className="cursor-pointer text-sm font-medium">Advanced Options</summary>
        <div className="space-y-2 mt-2">
          <CheckboxField
            path={["honor_labels"]}
            id={`honor-labels-${index}`}
            label="Honor Labels"
            description="Keep target labels on conflict."
            defaultChecked={false}
            {...DESCRIBED_ROW}
          />

          <CheckboxField
            path={["honor_timestamps"]}
            id={`honor-timestamps-${index}`}
            label="Honor Timestamps"
            description="Use timestamps exposed by the target."
            defaultChecked={true}
            {...DESCRIBED_ROW}
          />

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              path={["sample_limit"]}
              id={`sample-limit-${index}`}
              label="Sample Limit"
              defaultValue="0 (no limit)"
              description="Max samples per scrape."
              placeholder="e.g. 1000"
            />

            <NumberField
              path={["target_limit"]}
              id={`target-limit-${index}`}
              label="Target Limit"
              defaultValue="0 (no limit)"
              placeholder="e.g. 100"
            />
          </div>
        </div>
      </details>
    </div>
  );
}

/** Whether `path` is `expected`, key for key. */
function samePath(path: ValuePath, expected: ValuePath): boolean {
  return path.length === expected.length && path.every((part, at) => part === expected[at]);
}

/**
 * The first target group's targets, as sortable rows. On a job
 * with no target group (`static_configs` unset, null or `[]`), Add Target
 * writes the group with the seed.
 */
function StaticTargets({ index }: { index: number }) {
  const form = useForm();
  const groups = form.read(["static_configs"]);
  const noGroup = groups.kind === "absent" || (groups.kind === "list" && groups.value.length === 0);
  const showable = noGroup || (groups.kind === "list" && form.read(["static_configs", 0]).kind === "map");
  const source = useMemo(
    () =>
      formSource(
        form.read,
        (changes) => {
          const [first] = changes;
          if (noGroup && changes.length === 1 && first !== undefined && "value" in first && samePath(first.path, ["static_configs", 0, "targets", 0])) {
            return form.apply([{ path: ["static_configs"], value: [{ targets: [first.value] }] }]);
          }
          return form.apply(changes);
        },
        form.disabled,
      ),
    [form, noGroup],
  );
  return (
    <ConfigField label="Static Targets">
      {showable ? (
        <FormProvider form={source}>
          <MultiValueField
            path={["static_configs", 0, "targets"]}
            placeholder="e.g. localhost:8080"
            addButtonText="Add Target"
            addValue={TARGET_SEED}
            removeLabel="Remove target"
            vaultAware
            sortable={{ list: "target", contextId: `prometheus-job-${index}-targets` }}
          />
        </FormProvider>
      ) : (
        <UnshowableJob />
      )}
    </ConfigField>
  );
}

/** A job's Security box: TLS, basic authentication and authorization, under `config.scrape_configs.<index>`. */
function JobSecurity({ index }: { index: number }) {
  const form = useForm();
  if (form.read([]).kind !== "map") return <UnshowableJob />;
  return (
    <>
      <PrometheusTLSSection path={["tls_config"]} idPrefix={`prometheus-job-${index}-tls`} />

      <details className="border border-border rounded-md p-2.5">
        <summary className="cursor-pointer text-sm font-medium">Basic Authentication</summary>
        <div className="space-y-2 mt-2">
          <ExcludingScope excludes={["authorization"]} message={REMOVED_AUTHORIZATION}>
            <FormScope path={["basic_auth"]} prune>
              <TextField path={["username"]} id={`basic-auth-username-${index}`} label="Username" placeholder="e.g. scraper" />
              <TextField
                path={["password_file"]}
                id={`basic-auth-password-file-${index}`}
                label="Password File"
                placeholder="e.g. /path/to/password-file"
              />
            </FormScope>
          </ExcludingScope>
        </div>
      </details>

      <details className="border border-border rounded-md p-2.5">
        <summary className="cursor-pointer text-sm font-medium">Authorization (Bearer Token)</summary>
        <div className="space-y-2 mt-2">
          <ExcludingScope excludes={["basic_auth"]} message={REMOVED_BASIC_AUTH}>
            <FormScope path={["authorization"]} prune>
              <TextField path={["type"]} id={`auth-type-${index}`} label="Type" defaultValue="Bearer" placeholder="Bearer" />
              <TextField
                path={["credentials_file"]}
                id={`auth-credentials-file-${index}`}
                label="Credentials File"
                placeholder="e.g. /path/to/token-file"
              />
            </FormScope>
          </ExcludingScope>
        </div>
      </details>
    </>
  );
}
