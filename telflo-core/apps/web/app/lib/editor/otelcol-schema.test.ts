// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { CATALOGUE_VERSIONS, offeredVersions } from "../../../scripts/palette-defaults.js";
import { CATALOGUE_RENAMED_TYPES, isAtOrAfter, spelledType } from "~/lib/collector/renamed-types.js";
import {
  committedSchema,
  ERROR,
  positionOf,
  schemaWorker,
  WARNING,
  type Diagnostic,
  type SchemaWorker,
} from "~/test/schema-worker.js";
import { checkedVersion, seededFlows } from "~/test/seeded-flows.js";

/*
 * What each offered version's committed schema tells the YAML tab, run
 * through monaco-yaml's own worker.
 *
 * Where upstream agrees, the checks are behavior rather than key lists: a
 * component's settings are what completion offers inside it, and a text
 * either warns or doesn't. The journald surface is upstream's at each
 * version, which has `include_log_record_original`, and the `matches` items
 * are open; file_storage is open (upstream has no schema for it);
 * clickhouse, awss3 / aws_s3 and failover are upstream's. Every non-string
 * setting accepts a `${…}` reference. The ClickStack flows block is at the
 * end. The palette's seeded keys are covered by
 * otelcol-schema-warnings.test.ts, which runs every palette default (and
 * every seeded flow).
 */

const DISTRIBUTION = "otelcol-contrib";
const VERSIONS = offeredVersions(CATALOGUE_VERSIONS[DISTRIBUTION] ?? []).map((offer) => offer.version);
const RENAMES = CATALOGUE_RENAMED_TYPES[DISTRIBUTION] ?? [];

/** The sections, by component kind. */
const SECTION = { receiver: "receivers", processor: "processors", exporter: "exporters", extension: "extensions", connector: "connectors" } as const;

/** `diagnostics` as `line: message` (1-based lines), sorted. */
function listed(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1}: ${diagnostic.message}`).sort();
}

/** The YAML of one component `id` in `section` with `body` (indented under it). */
function component(section: string, id: string, body: string): string {
  const lines = body.split("\n").filter((line) => line.length > 0);
  return `${section}:\n  ${id}:\n${lines.map((line) => `    ${line}`).join("\n")}\n`;
}

const notAllowed = (key: string) => `Property ${key} is not allowed.`;
const MAP_EXPECTED = "Expected a map or a ${…} reference.";

/** A schema as these tests read it: each section's component names and patterns. */
interface SectionsSchema {
  properties: Record<string, { properties: Record<string, unknown>; patternProperties: Record<string, unknown> }>;
}

describe.each(VERSIONS)(`${DISTRIBUTION} %s's schema`, (version) => {
  const schema = committedSchema(DISTRIBUTION, version) as SectionsSchema;
  let worker: SchemaWorker;
  /** The version's name for a palette type (`aws_s3` or `awss3`). */
  const pinned = (kind: keyof typeof SECTION, paletteType: string) => spelledType(kind, paletteType, DISTRIBUTION, version);
  /** The keys completion offers in an empty line under `path` (each key's own line, two spaces deeper each). */
  async function keysUnder(section: string, id: string, ...path: string[]): Promise<string[]> {
    const lines = [`${section}:`, `  ${id}:`, ...path.map((key, depth) => `${"  ".repeat(depth + 2)}${key}:`)];
    const indent = "  ".repeat(path.length + 2);
    const text = `${lines.join("\n")}\n${indent}\n`;
    const items = await worker.complete(text, { line: lines.length, character: indent.length });
    return items.map((item) => item.label).sort();
  }

  beforeAll(async () => {
    worker = await schemaWorker(schema);
  });

  describe("the clickhouse exporter", () => {
    it("offers the exporter's settings", async () => {
      expect(await keysUnder("exporters", "clickhouse")).toEqual(
        [
          "async_insert",
          "cluster_name",
          "compress",
          "connection_params",
          "create_schema",
          "database",
          "endpoint",
          "json",
          "logs_table_name",
          "metrics_table_name",
          "metrics_tables",
          "password",
          "profiles_table_name",
          "retry_on_failure",
          "sending_queue",
          "table_engine",
          "timeout",
          "tls",
          "traces_table_name",
          "ttl",
          "username",
        ].sort(),
      );
    });

    it("offers the full sending_queue, a storage extension and its batch included (an optional section: enabled too)", async () => {
      expect(await keysUnder("exporters", "clickhouse", "sending_queue")).toEqual(
        ["batch", "block_on_overflow", "enabled", "num_consumers", "queue_size", "sizer", "storage", "wait_for_result"].sort(),
      );
      expect(await keysUnder("exporters", "clickhouse", "sending_queue", "batch")).toEqual(
        ["enabled", "flush_timeout", "max_size", "min_size", "partition", "sizer"].sort(),
      );
    });

    it("warns about the removed ttl_days, the same for `clickhouse` and `clickhouse/logs`", async () => {
      const body = "endpoint: tcp://clickhouse:9000\nttl: 72h\nttl_days: 3\nsending_queue:\n  storage: file_storage";
      const bare = await worker.validate(component("exporters", "clickhouse", body));
      expect(listed(bare)).toEqual([`5: ${notAllowed("ttl_days")}`]);
      expect(listed(await worker.validate(component("exporters", "clickhouse/logs", body)))).toEqual(listed(bare));
    });

    it("lets a ${…} reference stand in for a boolean, an integer and an enum, and nothing else", async () => {
      const references = [
        "endpoint: ${env:CLICKHOUSE_ENDPOINT}",
        "async_insert: ${env:ASYNC}",
        "create_schema: ${org:CREATE_SCHEMA}",
        "compress: ${env:COMPRESS}",
        "sending_queue:",
        "  queue_size: ${env:QUEUE_SIZE}",
        "  sizer: ${org:SIZER}",
      ].join("\n");
      expect(await worker.validate(component("exporters", "clickhouse", references))).toEqual([]);

      const wrong = "async_insert: tcp://clickhouse:9000\nsending_queue:\n  queue_size: lots";
      expect(listed(await worker.validate(component("exporters", "clickhouse", wrong)))).toEqual([
        "3: Expected true, false or a ${…} reference.",
        "5: Expected an integer or a ${…} reference.",
      ]);
    });
  });

  describe("the journald receiver", () => {
    const surface = [
      "all",
      "attributes",
      "convert_message_bytes",
      "directory",
      "dmesg",
      "files",
      "grep",
      "id",
      "identifiers",
      "include_log_record_original",
      "journalctl_path",
      "matches",
      "merge",
      "namespace",
      "operators",
      "output",
      "priority",
      "resource",
      "retry_on_failure",
      "root_path",
      "start_at",
      "storage",
      "type",
      "units",
      ...(isAtOrAfter(version, "0.162.0") ? ["convert_to_semantic_conventions"] : []),
    ].sort();

    it("offers the receiver's settings as upstream has them at this version", async () => {
      expect(await keysUnder("receivers", "journald")).toEqual(surface);
    });

    it("accepts units, priority, start_at, matches, operators and include_log_record_original, the same for an instance", async () => {
      const body = [
        "units: [ssh, kubelet]",
        "priority: info",
        "start_at: end",
        "include_log_record_original: true",
        "matches:",
        "  - _SYSTEMD_UNIT: ssh.service",
        "    _ANY_FIELD_THE_JOURNAL_HAS: anything",
        "operators:",
        "  - type: move",
        "    from: body",
        "    to: attributes.message",
      ].join("\n");
      expect(await worker.validate(component("receivers", "journald", body))).toEqual([]);
      expect(await worker.validate(component("receivers", "journald/system", body))).toEqual([]);
    });

    it("warns about a key upstream doesn't have", async () => {
      expect(listed(await worker.validate(component("receivers", "journald", "units: [ssh]\nunit: ssh")))).toEqual([
        `4: ${notAllowed("unit")}`,
      ]);
    });
  });

  describe("the file_storage extension", () => {
    it("is open: upstream has no schema for it, so no key of it warns", async () => {
      const body = [
        "directory: /var/lib/otelcol/file_storage",
        "create_directory: true",
        "directory_permissions: '0750'",
        "fsync: true",
        "timeout: 1s",
        "compaction:",
        "  on_start: true",
        "  on_rebound: true",
        "  rebound_needed_threshold_mib: 100",
        "  check_interval: 5s",
        "a_key_upstream_never_described: 1",
      ].join("\n");
      expect(await worker.validate(component("extensions", "file_storage", body))).toEqual([]);
      expect(await worker.validate(component("extensions", "file_storage/queue", body))).toEqual([]);
    });
  });

  describe("the awss3 exporter", () => {
    it("offers the exporter's settings and its s3uploader's", async () => {
      expect(await keysUnder("exporters", "awss3")).toEqual(
        ["encoding", "encoding_file_extension", "marshaler", "resource_attrs_to_s3", "retry_on_failure", "s3uploader", "sending_queue", "timeout"].sort(),
      );
      expect(await keysUnder("exporters", "awss3", "s3uploader")).toEqual(
        [
          "acl",
          "compression",
          "disable_ssl",
          "endpoint",
          "file_prefix",
          "region",
          "retry_max_attempts",
          "retry_max_backoff",
          "retry_mode",
          "role_arn",
          "s3_base_prefix",
          "s3_bucket",
          "s3_force_path_style",
          "s3_partition_format",
          "s3_partition_timezone",
          "s3_prefix",
          "storage_class",
          "unique_key_func_name",
        ].sort(),
      );
    });

    it("shares the exporter helper's queue and retry settings with clickhouse", async () => {
      for (const path of ["sending_queue", "retry_on_failure"]) {
        const awss3 = await keysUnder("exporters", "awss3", path);
        expect(awss3.length, path).toBeGreaterThan(0);
        expect(awss3, path).toEqual(await keysUnder("exporters", "clickhouse", path));
      }
    });

    it("warns the same for `awss3` and `awss3/archive`", async () => {
      const body = "s3uploader:\n  region: us-east-1\n  s3_bucket: telemetry\n  s3_buckt: typo";
      const bare = await worker.validate(component("exporters", "awss3", body));
      expect(listed(bare)).toEqual([`6: ${notAllowed("s3_buckt")}`]);
      expect(listed(await worker.validate(component("exporters", "awss3/archive", body)))).toEqual(listed(bare));
    });
  });

  describe("the awss3 receiver", () => {
    const name = pinned("receiver", "awss3");
    const other = name === "aws_s3" ? "awss3" : "aws_s3";

    it(`offers ${name}'s settings, its s3downloader's and its sqs's`, async () => {
      expect(await keysUnder("receivers", name)).toEqual(["encodings", "endtime", "notifications", "s3downloader", "sqs", "starttime"]);
      expect(await keysUnder("receivers", name, "s3downloader")).toEqual(
        [
          "endpoint",
          "endpoint_partition_id",
          "file_prefix",
          "file_prefix_include_telemetry_type",
          "region",
          "s3_bucket",
          "s3_force_path_style",
          "s3_partition_format",
          "s3_partition_timezone",
          "s3_prefix",
          "skip_ingesting_tagged_objects",
          "tag_object_after_ingestion",
        ].sort(),
      );
      expect(await keysUnder("receivers", name, "sqs")).toEqual(["endpoint", "max_number_of_messages", "queue_url", "region", "wait_time_seconds"]);
    });

    const body = "s3downloader:\n  region: us-east-1\n  s3_bucket: telemetry\nsqs:\n  queue_url: https://sqs.example\n  regin: typo";
    if (name === "aws_s3") {
      it("accepts the old name awss3 silently, with the same settings", async () => {
        const current = await worker.validate(component("receivers", "aws_s3", body));
        expect(listed(current)).toEqual([`8: ${notAllowed("regin")}`]);
        expect(listed(await worker.validate(component("receivers", "awss3", body)))).toEqual(listed(current));
        expect(listed(await worker.validate(component("receivers", "awss3/replay", body)))).toEqual(listed(current));
      });
    } else {
      it(`warns about ${other}, a name this collector doesn't have yet`, async () => {
        expect(listed(await worker.validate(component("receivers", other, body)))).toEqual([`2: ${notAllowed(other)}`]);
        expect(listed(await worker.validate(component("receivers", name, body)))).toEqual([`8: ${notAllowed("regin")}`]);
      });
    }
  });

  describe("the failover connector", () => {
    it("offers the connector's settings", async () => {
      expect(await keysUnder("connectors", "failover")).toEqual(
        ["priority_levels", "retry_interval", "sending_queue", ...(isAtOrAfter(version, "0.162.0") ? ["condition"] : [])].sort(),
      );
    });

    it("accepts priority_levels as a list of pipeline-name lists", async () => {
      const body = "priority_levels:\n  - [traces/primary, traces/also]\n  - [traces/secondary]\nretry_interval: 5m";
      expect(await worker.validate(component("connectors", "failover", body))).toEqual([]);
    });

    it("warns about retry_gap and max_retries, removed upstream in 0.157.0", async () => {
      const body = "priority_levels: [[traces/primary]]\nretry_gap: 30s\nmax_retries: 10";
      expect(listed(await worker.validate(component("connectors", "failover", body)))).toEqual([
        `4: ${notAllowed("retry_gap")}`,
        `5: ${notAllowed("max_retries")}`,
      ]);
    });
  });

  // Where upstream's schema omits or mistypes what the collector
  // reads, that part is open (the generator's open-parts.json, each checked
  // against the Go). Most of them no palette default or corpus text reaches,
  // so a schema closing one again would pass the warnings test; these texts
  // use each, as the collector reads it.
  describe("the parts upstream describes wrongly stay open", () => {
    it.each([
      ["the HTTP client's flat keep-alive keys and headers as a map", "exporters", ["otlp_http", "otlphttp"], "endpoint: http://backend:4318\nmax_idle_conns: 10\nidle_conn_timeout: 90s\nheaders:\n  X-Tenant: acme"],
      ["the HTTP server's flat keep-alive keys", "receivers", ["otlp"], "protocols:\n  http:\n    endpoint: 0.0.0.0:4318\n    keep_alives_enabled: true\n    idle_timeout: 60s"],
      ["stanza's sizes with units", "receivers", ["file_log", "filelog"], "include: [/var/log/*.log]\nfingerprint_size: 1kb\nmax_log_size: 1MiB"],
      ["a telemetry level by name", "exporters", ["debug"], "verbosity: detailed"],
      ["cumulativetodelta's initial_value by name", "processors", ["cumulative_to_delta", "cumulativetodelta"], "initial_value: auto"],
      ["spanmetrics' histogram unit by name", "connectors", ["span_metrics", "spanmetrics"], "histogram:\n  unit: ms"],
      ["kafka's required_acks: all", "exporters", ["kafka"], "producer:\n  required_acks: all"],
      ["transform's flat statements", "processors", ["transform"], 'trace_statements:\n  - set(attributes["env"], "prod")'],
      ["receiver_creator's receivers, read by hand", "receivers", ["receiver_creator"], "watch_observers: [k8s_observer]\nreceivers:\n  redis/on_pod:\n    rule: type == \"port\" && port == 6379\n    config:\n      password: secret"],
      [
        "Prometheus's scrape_config_files, any-case actions, any scheme, underscores",
        "receivers",
        ["prometheus"],
        [
          "config:",
          "  scrape_config_files: [/etc/prometheus/scrape/*.yml]",
          "  scrape_configs:",
          "    - job_name: self",
          "      scheme: HTTPS",
          "      metric_name_escaping_scheme: underscores",
          "      relabel_configs:",
          "        - action: Replace",
          "          source_labels: [__address__]",
          "          target_label: instance",
          "      static_configs:",
          "        - targets: [localhost:8888]",
        ].join("\n"),
      ],
    ] as const)("%s", async (_what, section, names, body) => {
      // The first name the version builds (a type renamed during the offered versions has both).
      const name = names.find((candidate) => candidate in schema.properties[section]!.properties);
      expect(name, names.join(" or ")).toBeDefined();
      expect(await worker.validate(component(section, name!, body))).toEqual([]);
    });
  });

  // An optional section (upstream's x-optional, a configoptional.Optional,
  // whose Unmarshal reads and deletes enabled) takes enabled where it is
  // optional, and only there: a typo beside it still warns.
  describe("optional sections", () => {
    it.each([
      ["otlp's grpc", "receivers", ["otlp"], "protocols:\n  grpc:\n    KEY: false", true],
      ["otlp's http (the HTTP server's settings are open)", "receivers", ["otlp"], "protocols:\n  http:\n    KEY: false", false],
      ["otlp's grpc keepalive.server_parameters", "receivers", ["otlp"], "protocols:\n  grpc:\n    keepalive:\n      server_parameters:\n        KEY: false", true],
      ["otlp's grpc tls", "receivers", ["otlp"], "protocols:\n  grpc:\n    tls:\n      KEY: false", true],
      ["jaeger's thrift_compact", "receivers", ["jaeger"], "protocols:\n  thrift_compact:\n    KEY: false", true],
      ["loadbalancing's resolver.dns", "exporters", ["load_balancing", "loadbalancing"], "resolver:\n  dns:\n    hostname: collectors\n    KEY: false", true],
      ["spanmetrics' histogram.exponential", "connectors", ["span_metrics", "spanmetrics"], "histogram:\n  exponential:\n    KEY: false", true],
      ["otlp_grpc's keepalive", "exporters", ["otlp_grpc", "otlp"], "endpoint: backend:4317\nkeepalive:\n  KEY: false", true],
      ["otlp_grpc's sending_queue.batch", "exporters", ["otlp_grpc", "otlp"], "endpoint: backend:4317\nsending_queue:\n  batch:\n    KEY: false", true],
    ] as const)("%s takes enabled: false", async (_what, section, names, body, typoWarns) => {
      const name = names.find((candidate) => candidate in schema.properties[section]!.properties);
      expect(name, names.join(" or ")).toBeDefined();
      expect(await worker.validate(component(section, name!, body.replace("KEY", "enabled")))).toEqual([]);
      const typo = (await worker.validate(component(section, name!, body.replace("KEY", "enabld")))).map((diagnostic) => diagnostic.message);
      expect(typo).toEqual(typoWarns ? [notAllowed("enabld")] : []);
    });

    it("warns about enabled where the same settings aren't optional (an exporter's tls)", async () => {
      const name = ["otlp_grpc", "otlp"].find((candidate) => candidate in schema.properties.exporters!.properties)!;
      const diagnostics = await worker.validate(component("exporters", name, "endpoint: backend:4317\ntls:\n  enabled: false"));
      expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([notAllowed("enabled")]);
    });
  });

  describe("tail_sampling's policies", () => {
    it("accept a policy extension's settings under its type's name, at the top and in and/composite sub-policies", async () => {
      const body = [
        "policies:",
        "  - name: custom",
        "    type: my_extension",
        "    my_extension:",
        "      threshold: 5",
        "  - name: both",
        "    type: and",
        "    and:",
        "      and_sub_policy:",
        "        - name: inner",
        "          type: my_extension",
        "          my_extension: {threshold: 5}",
      ].join("\n");
      expect(await worker.validate(component("processors", "tail_sampling", body))).toEqual([]);
    });

    it("take only a map under another key, as an extension's settings are: a mistyped setting holding a scalar warns, at the top and in a drop sub-policy", async () => {
      const body = [
        "policies:",
        "  - name: slow",
        "    type: latency",
        "    tpye: latency",
        "  - name: dropped",
        "    type: drop",
        "    drop:",
        "      drop_sub_policy:",
        "        - name: inner",
        "          type: my_extension",
        "          nme: foo",
        "          my_extension: {threshold: 5}",
      ].join("\n");
      expect(listed(await worker.validate(component("processors", "tail_sampling", body)))).toEqual([
        `13: ${MAP_EXPECTED}`,
        `6: ${MAP_EXPECTED}`,
      ]);
    });

    it("never offer the Go field upstream names, and still warn about a typo inside a policy's own settings", async () => {
      const items = await worker.complete("processors:\n  tail_sampling:\n    policies:\n      - name: a\n        \n", { line: 4, character: 8 });
      const offered = items.map((item) => item.label);
      expect(offered).toContain("latency");
      expect(offered).not.toContain("ExtensionCfg");
      const body = "policies:\n  - name: slow\n    type: latency\n    latency:\n      threshold_ms: 5\n      thresold_ms: 5";
      expect(listed(await worker.validate(component("processors", "tail_sampling", body)))).toEqual([`8: ${notAllowed("thresold_ms")}`]);
    });
  });

  it("checks transform's context statements as upstream describes them, a number among the statements included", async () => {
    const body = "log_statements:\n  - context: log\n    statments:\n      - set(attributes[\"a\"], \"b\")\nmetric_statements:\n  - 5";
    expect(listed(await worker.validate(component("processors", "transform", body)))).toEqual([
      `5: ${notAllowed("statments")}`,
      '8: Incorrect type. Expected "string".',
    ]);
  });

  // Upstream's ecs and gcp detectors declare only their resource attributes
  // (and gcp its labels), so a client_config under them warns. The
  // collector refuses it on 0.159.0 and ignores it from 0.160.0 (the
  // confighttp regression): either way it does nothing.
  it("warns about client_config under resourcedetection's ecs and gcp detectors", async () => {
    const text = component(
      "processors",
      pinned("processor", "resourcedetection"),
      "detectors: [ecs, gcp]\necs:\n  client_config:\n    timeout: 5s\ngcp:\n  client_config:\n    timeout: 5s",
    );
    expect(listed(await worker.validate(text))).toEqual([`5: ${notAllowed("client_config")}`, `8: ${notAllowed("client_config")}`]);
  });

  describe("typos and unknown types", () => {
    const valid = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n";

    it("accepts the otlp receiver as written", async () => {
      expect(await worker.validate(valid)).toEqual([]);
    });

    it("warns about a typo under the otlp receiver", async () => {
      const text = valid.replace("protocols:", "protocls:");
      expect(listed(await worker.validate(text))).toEqual([`3: ${notAllowed("protocls")}`]);
    });

    it("warns about an unknown key in a nested object", async () => {
      const text = valid.replace("endpoint:", "endpont:");
      expect(listed(await worker.validate(text))).toEqual([`5: ${notAllowed("endpont")}`]);
    });

    it("warns about an unknown receiver type, and an instance of one", async () => {
      const text = `${valid}  otlpp: {}\n  otlpp/2: {}\n`;
      expect(listed(await worker.validate(text))).toEqual([`6: ${notAllowed("otlpp")}`, `7: ${notAllowed("otlpp/2")}`]);
    });
  });

  describe("old names and instance ids", () => {
    const fileLog = pinned("receiver", "filelog");
    const body = "include: [/var/log/*.log]\nstart_at: beginning\nexclude_older_than: 24h\nmade_up: 1";

    it.each(["filelog", `${fileLog}/app`, "filelog/app"])(`%s validates with ${fileLog}'s settings`, async (id) => {
      const canonical = await worker.validate(component("receivers", fileLog, body));
      expect(listed(canonical)).toEqual([`6: ${notAllowed("made_up")}`]);
      expect(listed(await worker.validate(component("receivers", id, body)))).toEqual(listed(canonical));
    });

    it.each(["filelog", `${fileLog}/app`])(`%s shows ${fileLog}'s hover`, async (id) => {
      const canonicalText = component("receivers", fileLog, body);
      const canonical = await worker.hover(canonicalText, positionOf(canonicalText, "exclude_older_than", 2));
      expect(canonical).toMatch(/\S/);
      const text = component("receivers", id, body);
      expect(await worker.hover(text, positionOf(text, "exclude_older_than", 2))).toBe(canonical);
    });

    const renamed = RENAMES.filter((rename) => isAtOrAfter(version, rename.since));
    it.each(renamed.map((rename) => [rename.kind, rename.deprecatedName, rename.name] as const))(
      "the %s's old name %s is accepted as %s is",
      async (kind, oldName, name) => {
        const section = SECTION[kind];
        expect(await worker.validate(`${section}:\n  ${name}:\n  ${oldName}:\n  ${oldName}/2: {}\n`)).toEqual([]);
      },
    );
  });

  describe("completion under receivers:", () => {
    const schemaReceivers = schema.properties.receivers!;
    /** The aliases the schema accepts: `^name(/.+)?$`, a name completion never offers. */
    const aliases = Object.keys(schemaReceivers.patternProperties)
      .map((pattern) => /^\^([^/()]+)\(\/\.\+\)\?\$$/.exec(pattern)?.[1])
      .filter((alias): alias is string => alias !== undefined);

    async function offered(): Promise<string[]> {
      return (await worker.complete("receivers:\n  \n", { line: 1, character: 2 })).map((item) => item.label);
    }

    it(`offers ${pinned("receiver", "awss3")}, the pin's name for the awss3 receiver, and not the other spelling`, async () => {
      const labels = await offered();
      const name = pinned("receiver", "awss3");
      expect(labels).toContain(name);
      expect(labels).not.toContain(name === "aws_s3" ? "awss3" : "aws_s3");
    });

    it("offers every receiver the version builds, under the pin's names, and no alias or instance id", async () => {
      const labels = await offered();
      expect(aliases.length).toBeGreaterThan(0);
      expect(labels.sort()).toEqual(Object.keys(schemaReceivers.properties).sort());
      expect(labels.filter((label) => aliases.includes(label) || label.includes("/"))).toEqual([]);
      for (const rename of RENAMES.filter((entry) => entry.kind === "receiver" && isAtOrAfter(version, entry.since))) {
        expect(labels, rename.name).toContain(rename.name);
        expect(labels, rename.deprecatedName).not.toContain(rename.deprecatedName);
      }
    });
  });

  it("shows upstream's description on hover", async () => {
    const text = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n";
    expect(await worker.hover(text, positionOf(text, "endpoint", 2))).toMatch(/^Endpoint configures the address for this network connection\./);
  });

  it("shows hover without the schema's source, as the editor's options say (`hoverSchemaSource: false`)", async () => {
    const text = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n";
    const hover = await worker.hover(text, positionOf(text, "endpoint", 2));
    expect(hover).not.toBeNull();
    expect(hover).not.toMatch(/Source|otelcol\.json|inmemory:/);
  });

  describe("severity", () => {
    it("gives every schema finding as a Warning: unknown keys and types, a wrong type, an out-of-list value", async () => {
      const text = [
        "receivers:",
        "  otlp:",
        "    protocls: {}",
        "  otlpp: {}",
        "  journald:",
        "    include_log_record_original: maybe",
        "  elasticsearch:",
        "    metrics:",
        "      elasticsearch.breaker.memory.estimated:",
        "        aggregation_strategy: median",
        "exporters:",
        "  debug: [not, a, map]",
        "",
      ].join("\n");
      const diagnostics = await worker.validate(text);
      expect(listed(diagnostics)).toEqual([
        '10: Value is not accepted. Valid values: "sum", "avg", "min", "max".',
        "12: Incorrect type. Expected one of object, string, null.",
        `3: ${notAllowed("protocls")}`,
        `4: ${notAllowed("otlpp")}`,
        "6: Expected true, false or a ${…} reference.",
      ]);
      expect(diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(diagnostics.map(() => WARNING));
    });

    it("gives a syntax error and a duplicate key as Errors", async () => {
      const syntax = await worker.validate("receivers:\n  otlp: {\n");
      expect(syntax.map((diagnostic) => [diagnostic.severity, diagnostic.message])).toEqual([
        [ERROR, "Flow map in block collection must be sufficiently indented and end with a }"],
      ]);

      const duplicate = await worker.validate("receivers:\n  otlp: {}\n  otlp: {}\n");
      expect(duplicate.map((diagnostic) => [diagnostic.severity, diagnostic.message])).toEqual([[ERROR, "Map keys must be unique"]]);
    });
  });
});

// The shipped ClickStack flows, on the generated schemas: every seeded flow
// whose YAML names CLICKHOUSE_ENDPOINT, each against the schema of the version
// a copy of it gets (`checkedVersion`: its pin while offered, else the
// distribution's default, so a retired pin, whose schema the generator
// deletes, moves the check rather than breaking it). Today otel-to-clickstack
// and datadog-to-clickstack-migration-bridge are on 0.162.0,
// clickhouse-failover-gateway-s3-overflow on 0.159.0. Every key a flow sets on
// a clickhouse exporter (any instance), on its sending_queue, and on a
// file_storage extension where the flow declares one, must be one the schema
// allows, or the editor draws squiggles on a flow Telflo ships.
//
// The generated schema names a component's bare type under `properties` and
// its instances under the pattern `^name/.+$`, both a `$ref` to one
// definition in `$defs` (followed here, as a chain, to the node holding the
// settings). So `bothForms` finds both entries and checks they are one
// definition, and a key is checked against every entry that applies to the
// flow's id (`clickhouse` the bare one, `clickhouse/rrweb` the pattern). A
// node is closed only with `additionalProperties: false` (then a key is
// allowed when it is listed under `properties` or matches its
// `patternProperties`); file_storage's definition is open (upstream has no
// schema for it), so every key of it is allowed, which this checks rather
// than assumes.
describe("the seeded ClickStack flows", () => {
  /** A schema node as these tests read it. */
  interface SchemaNode {
    $ref?: string;
    properties?: Record<string, SchemaNode>;
    patternProperties?: Record<string, SchemaNode>;
    additionalProperties?: unknown;
    allOf?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  }
  interface GeneratedSchema {
    $defs: Record<string, SchemaNode>;
    properties: Record<string, SchemaNode>;
  }

  const flows = seededFlows().filter((flow) => flow.yaml.includes("CLICKHOUSE_ENDPOINT"));

  /** `node` with its `$ref`s (`#/$defs/<name>`, the generator's only kind) followed to the node holding its settings. */
  function resolved(schema: GeneratedSchema, node: SchemaNode | undefined): SchemaNode {
    const seen = new Set<string>();
    let current = node;
    while (current?.$ref !== undefined) {
      const name = /^#\/\$defs\/(.+)$/.exec(current.$ref)?.[1];
      expect(name, current.$ref).toBeDefined();
      expect(seen.has(name!), `a $ref cycle through ${name}`).toBe(false);
      seen.add(name!);
      current = schema.$defs[name!];
    }
    expect(current, "a $ref names no definition").toBeDefined();
    // The generator's nodes hold their settings directly: a combinator here would hide keys this check doesn't read.
    expect([current!.allOf, current!.anyOf, current!.oneOf]).toEqual([undefined, undefined, undefined]);
    return current!;
  }

  /** The bare form (`properties[name]`) and the instance form (`patternProperties["^name/.+$"]`), resolved: one definition. */
  function bothForms(schema: GeneratedSchema, section: string, name: string): [SchemaNode, SchemaNode] {
    const entries = schema.properties[section]!;
    const bare = entries.properties?.[name];
    const pattern = entries.patternProperties?.[`^${name}/.+$`];
    expect(bare, `${name} missing from ${section}' properties`).toBeDefined();
    expect(pattern, `${name}/… missing from ${section}' patternProperties`).toBeDefined();
    expect(pattern, `${name} and ${name}/… are one definition`).toEqual(bare);
    return [resolved(schema, bare), resolved(schema, pattern)];
  }

  /** Every node that applies to the component `id` in `section`: its `properties` entry and each pattern it matches, resolved. */
  function entriesFor(schema: GeneratedSchema, section: string, id: string): SchemaNode[] {
    const entries = schema.properties[section]!;
    const applying = [
      ...(entries.properties?.[id] === undefined ? [] : [entries.properties[id]]),
      ...Object.entries(entries.patternProperties ?? {})
        .filter(([pattern]) => new RegExp(pattern, "u").test(id))
        .map(([, node]) => node),
    ];
    expect(applying.length, `nothing in ${section} allows ${id}`).toBeGreaterThan(0);
    return applying.map((node) => resolved(schema, node));
  }

  /** The keys of `used` that `node` rejects: none when it is open (no `additionalProperties: false`). */
  function rejected(node: SchemaNode, used: readonly string[]): string[] {
    if (node.additionalProperties !== false) return [];
    const patterns = Object.keys(node.patternProperties ?? {}).map((pattern) => new RegExp(pattern, "u"));
    return used.filter((key) => !(key in (node.properties ?? {})) && !patterns.some((pattern) => pattern.test(key)));
  }

  /** A component's settings as the flow's YAML holds them (an empty component is null). */
  function settings(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) return {};
    expect(typeof value).toBe("object");
    return value as Record<string, unknown>;
  }

  it("are present in the seed", () => {
    expect(flows.map((flow) => flow.slug)).toEqual(
      expect.arrayContaining(["otel-to-clickstack", "datadog-to-clickstack-migration-bridge", "clickhouse-failover-gateway-s3-overflow"]),
    );
  });

  it.each(flows.map((flow) => [flow.slug, checkedVersion(flow), flow] as const))(
    "%s only uses clickhouse, sending_queue and file_storage keys its checked version's (%s) schema allows",
    (_slug, version, flow) => {
      expect(flow.collectorDistribution).toBe(DISTRIBUTION);
      const schema = committedSchema(DISTRIBUTION, version) as GeneratedSchema;
      const doc = parseYaml(flow.yaml) as { exporters?: Record<string, unknown>; extensions?: Record<string, unknown> };

      const [clickhouse, clickhouseInstance] = bothForms(schema, "exporters", "clickhouse");
      expect(clickhouse.additionalProperties, "the clickhouse exporter is closed, so its keys are checked").toBe(false);
      expect(clickhouseInstance).toBe(clickhouse);
      const instances = Object.entries(doc.exporters ?? {}).filter(([id]) => /^clickhouse(\/|$)/u.test(id));
      expect(instances.length).toBeGreaterThan(0);
      for (const [id, value] of instances) {
        const config = settings(value);
        for (const entry of entriesFor(schema, "exporters", id)) {
          expect(rejected(entry, Object.keys(config)), `${id} sets keys the schema rejects`).toEqual([]);
          const queue = settings(config.sending_queue);
          const queueNode = resolved(schema, entry.properties?.sending_queue);
          expect(queueNode.additionalProperties, "clickhouse's sending_queue is closed, so its keys are checked").toBe(false);
          expect(rejected(queueNode, Object.keys(queue)), `${id}'s sending_queue sets keys the schema rejects`).toEqual([]);
        }
      }

      // Upstream's ClickStack config ships without a persistent queue, so
      // file_storage is only checked where a flow declares it.
      bothForms(schema, "extensions", "file_storage");
      for (const [id, value] of Object.entries(doc.extensions ?? {}).filter(([name]) => /^file_storage(\/|$)/u.test(name))) {
        for (const entry of entriesFor(schema, "extensions", id)) {
          expect(rejected(entry, Object.keys(settings(value))), `${id} sets keys the schema rejects`).toEqual([]);
        }
      }
    },
  );
});
