import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, DESCRIBED_BOX, DurationField, FormScope, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { listLength } from "./shared/counts.js";
import { IncludeExcludeSection } from "./shared/IncludeExcludeSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The host metrics receiver's form, over the form's fields: each field writes
 * its own key.
 *
 * - Kept: a scraper is on while its key is under `scrapers`, a bare `cpu:`
 *   included (the collector configures every key it finds there with the
 *   scraper's defaults, `receiver/hostmetricsreceiver/ config.go:62-93`).
 *   Ticking one writes `{}`, and load `{cpu_average: false}`; unticking
 *   removes the key. The last one can be unticked: the collector refuses a
 *   receiver with no scraper (`config.go:43-45`), which the config validation
 *   reports; the form doesn't block it. A scraper whose value can't hold
 *   settings is read-only with `UNSHOWABLE_VALUE_MESSAGE`, and shows no
 *   section. When `scrapers` itself isn't a mapping, no box is ticked (none
 *   can be said to be on), all are disabled, and the hint shows once.
 * - Fixed: each scraper's filters are the shared `IncludeExcludeSection`: the
 *   first item is written with `match_type: strict` (with none, the collector
 *   refuses a list that has items,
 *   `internal/filter/filterset/ config.go:37-48`), include and exclude are
 *   kept together (the collector builds both,
 *   `internal/scraper/diskscraper/disk_scraper_others.go:51-63`,
 *   `filesystemscraper/config.go:78-117`) and both show when both are set,
 *   and a side's first row is held until something is typed in it (never
 *   `[""]`). The filter keys are the collector's
 *   (`diskscraper/config.go:19-26`, `filesystemscraper/config.go:23-57`,
 *   `networkscraper/config.go:15-23`, `processscraper/config.go:20-61`).
 * - Unset shows the collector's default: Collection Interval `1m` and Initial
 *   Delay `1s` (core
 *   `scraper/scraperhelper/ internal/controller/generated_config.go:39-40`,
 *   v0.162.0), Metadata Collection Interval `5m` (`factory.go:39`), as
 *   placeholders and hints; the boxes unticked (every scraper's booleans
 *   default to false: `loadscraper/factory.go:21-25`,
 *   `processscraper/factory.go:44-48`, `filesystemscraper/factory.go:22-26`).
 * - Changed: clearing Root Path removes the key, never writing `""` (which
 *   the collector reads as unset, `config.go:25`).
 * - The row markup: the scraper and described boxes'
 *   `flex items-start space-x-3` rows with a `grid gap-1 leading-none`
 *   block, the error boxes' `flex items-center space-x-3` rows,
 *   `text-sm font-medium cursor-pointer` labels.
 *
 * Ids are fixed (`scraper-<name>`, a name from the fixed catalog; each
 * filter's `<section>-mode`, `<section>-include-<index>`); no value reaches
 * an attribute.
 */

/** The scraper catalog, the collector's at v0.162.0 (`factory.go:44-56`), with the README's OS tags. */
const SCRAPER_INFO = {
  cpu: { label: "CPU", description: "CPU utilization metrics", os: "All" },
  disk: { label: "Disk", description: "Disk I/O metrics", os: "All" },
  filesystem: { label: "Filesystem", description: "File system utilization", os: "All" },
  load: { label: "Load", description: "CPU load average", os: "All" },
  memory: { label: "Memory", description: "Memory utilization", os: "All" },
  network: { label: "Network", description: "Network I/O & TCP connections", os: "All" },
  paging: { label: "Paging", description: "Paging/swap space usage", os: "All" },
  processes: { label: "Processes", description: "Process count by state", os: "Linux/Mac/BSD" },
  process: { label: "Process", description: "Per-process metrics", os: "Linux/Win/Mac/BSD" },
  system: { label: "System", description: "Miscellaneous system metrics", os: "Linux/Win/Mac" },
  nfs: { label: "NFS", description: "NFS server/client metrics", os: "Linux only" },
} as const;

type ScraperName = keyof typeof SCRAPER_INFO;

const SCRAPER_NAMES = Object.keys(SCRAPER_INFO) as ScraperName[];

/** What ticking a scraper writes: `{}`, and load's `cpu_average: false`. */
const SCRAPER_SEED: Readonly<Record<ScraperName, Record<string, unknown>>> = {
  ...(Object.fromEntries(SCRAPER_NAMES.map((name) => [name, {}])) as Record<ScraperName, Record<string, unknown>>),
  load: { cpu_average: false },
};

type ScraperState = "on" | "off" | "unshowable";

/** On while the key is under `scrapers` (a bare `cpu:` included); read-only when it can't hold settings. */
function scraperState(scrapers: ValueView, value: ValueView, name: ScraperName): ScraperState {
  if (scrapers.kind === "absent") return "off";
  if (scrapers.kind !== "map") return "unshowable";
  if (!Object.hasOwn(scrapers.value, name)) return "off";
  return value.kind === "map" || value.kind === "absent" ? "on" : "unshowable";
}

/** The described box rows. */
const ROW = "flex items-start space-x-3";
const DESCRIBED = "grid gap-1 leading-none";
const LABEL = "text-sm font-medium cursor-pointer";

export function HostmetricsReceiverForm() {
  const form = useForm();
  const scrapers = form.read(["scrapers"]);
  const states = Object.fromEntries(
    SCRAPER_NAMES.map((name) => [name, scraperState(scrapers, form.read(["scrapers", name]), name)]),
  ) as Record<ScraperName, ScraperState>;
  const isScraperEnabled = (name: ScraperName) => states[name] === "on";
  const anyUnshowable = scrapers.kind !== "absent" && scrapers.kind !== "map";

  const toggleScraper = (name: ScraperName, enabled: boolean) => {
    if (enabled) form.set(["scrapers", name], SCRAPER_SEED[name]);
    else form.remove(["scrapers", name]);
  };

  /** Items in a scraper's filter blocks, as the section counts them. */
  const count = (name: ScraperName, blocks: readonly (readonly [string, string])[]) =>
    blocks.reduce((sum, [block, list]) => sum + listLength(form.read(["scrapers", name, block, list])), 0);
  const diskDeviceCount = count("disk", [
    ["include", "devices"],
    ["exclude", "devices"],
  ]);
  const filesystemFilterCount = count("filesystem", [
    ["include_devices", "devices"],
    ["exclude_devices", "devices"],
    ["include_fs_types", "fs_types"],
    ["exclude_fs_types", "fs_types"],
    ["include_mount_points", "mount_points"],
    ["exclude_mount_points", "mount_points"],
  ]);
  const networkInterfaceCount = count("network", [
    ["include", "interfaces"],
    ["exclude", "interfaces"],
  ]);
  const processNameCount = count("process", [
    ["include", "names"],
    ["exclude", "names"],
  ]);

  return (
    <div className="space-y-4">
      <DurationField
        path={["collection_interval"]}
        id="collection-interval"
        label="Collection Interval"
        defaultValue="1m"
        description="How often to collect metrics."
      />

      <DurationField
        path={["initial_delay"]}
        id="initial-delay"
        label="Initial Delay"
        defaultValue="1s"
        description="Wait before the first collection."
      />

      <ConfigField label="Scrapers" description="Select which metrics to collect.">
        <div className="space-y-2.5">
          {SCRAPER_NAMES.map((scraperName) => {
            const info = SCRAPER_INFO[scraperName];
            const state = states[scraperName];
            return (
              <div key={scraperName} className="flex items-start space-x-3">
                <Checkbox
                  id={`scraper-${scraperName}`}
                  className={DESCRIBED_BOX}
                  checked={!anyUnshowable && state !== "off"}
                  onCheckedChange={(checked) => {
                    if ((checked === true) !== (state !== "off")) toggleScraper(scraperName, checked === true);
                  }}
                  disabled={form.disabled || state === "unshowable" || anyUnshowable}
                />
                <div className="flex-1 grid gap-1 leading-none">
                  <Label htmlFor={`scraper-${scraperName}`} className="text-sm font-medium cursor-pointer">
                    {info.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {info.description}
                    {info.os !== "All" && <span className="ml-2 font-mono text-muted-foreground">[{info.os}]</span>}
                  </p>
                  {state === "unshowable" && !anyUnshowable && (
                    <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {anyUnshowable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      {isScraperEnabled("disk") && (
        <ConfigSection title="Disk Scraper" count={diskDeviceCount}>
          <FormScope path={["scrapers", "disk"]}>
            <IncludeExcludeSection
              id="disk-devices"
              title="Device Filter"
              itemLabel="Device"
              listKey="devices"
              placeholder="e.g. sda"
              includePath={["include"]}
              excludePath={["exclude"]}
            />
          </FormScope>
        </ConfigSection>
      )}

      {isScraperEnabled("filesystem") && (
        <ConfigSection title="Filesystem Scraper" count={filesystemFilterCount}>
          <FormScope path={["scrapers", "filesystem"]}>
            <IncludeExcludeSection
              id="fs-devices"
              title="Device Filter"
              itemLabel="Device"
              listKey="devices"
              placeholder="e.g. /dev/sda1"
              includePath={["include_devices"]}
              excludePath={["exclude_devices"]}
            />

            <IncludeExcludeSection
              id="fs-types"
              title="Filesystem Type Filter"
              itemLabel="FS Type"
              listKey="fs_types"
              placeholder="e.g. ext4"
              includePath={["include_fs_types"]}
              excludePath={["exclude_fs_types"]}
            />

            <IncludeExcludeSection
              id="fs-mount-points"
              title="Mount Point Filter"
              itemLabel="Mount Point"
              listKey="mount_points"
              placeholder="e.g. /home"
              includePath={["include_mount_points"]}
              excludePath={["exclude_mount_points"]}
            />

            <DescribedBox
              path={["include_virtual_filesystems"]}
              id="include-virtual-fs"
              label="Include Virtual Filesystems"
              description="Include pseudo filesystems like /proc and /sys."
            />
          </FormScope>
        </ConfigSection>
      )}

      {isScraperEnabled("load") && (
        <ConfigSection title="Load Scraper">
          <FormScope path={["scrapers", "load"]}>
            <DescribedBox
              path={["cpu_average"]}
              id="cpu-average"
              label="Divide by CPU Count"
              description="Divide load averages by the number of logical CPUs."
            />
          </FormScope>
        </ConfigSection>
      )}

      {isScraperEnabled("network") && (
        <ConfigSection title="Network Scraper" count={networkInterfaceCount}>
          <FormScope path={["scrapers", "network"]}>
            <IncludeExcludeSection
              id="network-interfaces"
              title="Interface Filter"
              itemLabel="Interface"
              listKey="interfaces"
              placeholder="e.g. eth0"
              includePath={["include"]}
              excludePath={["exclude"]}
            />
          </FormScope>
        </ConfigSection>
      )}

      {isScraperEnabled("process") && (
        <ConfigSection title="Process Scraper" count={processNameCount}>
          <FormScope path={["scrapers", "process"]}>
            <IncludeExcludeSection
              id="process-names"
              title="Process Name Filter"
              itemLabel="Process Name"
              listKey="names"
              placeholder="e.g. nginx"
              includePath={["include"]}
              excludePath={["exclude"]}
            />

            <ConfigField label="Error Handling">
              <div className="space-y-2">
                <ErrorBox path={["mute_process_all_errors"]} id="mute-all-errors" label="Mute All Process Errors" />
                <ErrorBox path={["mute_process_name_error"]} id="mute-name-error" label="Mute Process Name Errors" />
                <ErrorBox path={["mute_process_exe_error"]} id="mute-exe-error" label="Mute Process Executable Errors" />
                <ErrorBox path={["mute_process_io_error"]} id="mute-io-error" label="Mute Process I/O Errors" />
                <ErrorBox path={["mute_process_user_error"]} id="mute-user-error" label="Mute Process User Errors" />
                <ErrorBox
                  path={["mute_process_cgroup_error"]}
                  id="mute-cgroup-error"
                  label="Mute Process Cgroup Errors (Linux only)"
                />
              </div>
            </ConfigField>

            <DurationField
              path={["scrape_process_delay"]}
              id="scrape-process-delay"
              label="Scrape Process Delay"
              description="Wait before collecting metrics for new processes."
              placeholder="e.g. 10s"
            />
          </FormScope>
        </ConfigSection>
      )}

      <ConfigSection title="Advanced">
        <TextField
          path={["root_path"]}
          id="root-path"
          label="Root Path"
          description="Host filesystem mount path when running in a container."
          placeholder="e.g. /hostfs"
        />

        <DurationField
          path={["metadata_collection_interval"]}
          id="metadata-interval"
          label="Metadata Collection Interval"
          defaultValue="5m"
          description="How often to collect entity event metadata (experimental)."
        />

        <InlineAlert title="Per-scraper intervals">
          To scrape at different intervals, add multiple hostmetrics receiver instances (e.g.{" "}
          <span className="font-mono">hostmetrics/disk</span>) with different{" "}
          <span className="font-mono">collection_interval</span> values.
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}

/** A described box: the label and its description beside it (`include-virtual-fs`, `cpu-average`). */
function DescribedBox({ path, id, label, description }: { path: ValuePath; id: string; label: string; description: string }) {
  return (
    <CheckboxField
      path={path}
      id={id}
      label={label}
      description={description}
      defaultChecked={false}
      rowClassName={ROW}
      describedClassName={DESCRIBED}
      labelClassName={LABEL}
    />
  );
}

/** One of the process scraper's error boxes: a `flex items-center space-x-3` row. */
function ErrorBox({ path, id, label }: { path: ValuePath; id: string; label: string }) {
  return (
    <CheckboxField
      path={path}
      id={id}
      label={label}
      defaultChecked={false}
      rowClassName="flex items-center space-x-3"
      labelClassName={LABEL}
    />
  );
}
