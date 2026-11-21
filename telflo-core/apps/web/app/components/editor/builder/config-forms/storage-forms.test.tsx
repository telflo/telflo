import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { AWSS3ExporterForm, STORAGE_CLASSES } from "./AWSS3ExporterForm.js";
import { AWSS3ReceiverForm, SQS_QUEUE_URL_SEED, SQS_TOAST, SUFFIX_HINT, TIME_RANGE_TOAST } from "./AWSS3ReceiverForm.js";
import {
  ASYNC_INSERT_HINT,
  ClickhouseExporterForm,
  COMPRESS_HINT,
  ENGINE_PARAMS_HINT,
  METRIC_TABLE_KEYS,
  TLS_HINT,
} from "./ClickhouseExporterForm.js";
import { APPEND_TOAST, FileExporterForm, ROTATION_HINT } from "./FileExporterForm.js";
import { FormProvider, UNSET_OPTION, useComponentForm } from "./form-context.js";
import { formFor } from "./registry.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { getComponentDocsUrl } from "~/lib/graph/otel-docs.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { componentValueText } from "~/lib/graph/text-edits.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The S3 exporter and receiver, ClickHouse and file forms: their forms over
 * the form contract. Each field is driven as a person would on the storage
 * corpus text (comments, an anchor and its merge, block and flow lists,
 * `0750`, LF as the file has it, and CRLF), and writes only its key. 19
 * cases (S3 receiver 10, S3 exporter 5, ClickHouse exporter 4) close the
 * file: their fixtures are the corpus file's, their round trips the corpus
 * invariant's, and their form-edit sides are the tests here.
 *
 * Collector claims cite contrib v0.162.0 (`exporter/awss3exporter`,
 * `receiver/awss3receiver`, `exporter/clickhouseexporter`,
 * `exporter/fileexporter`) and core v0.162.0.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The storage corpus (LF, as the file is). */
const CORPUS = LF(corpusText("forms-storage.yaml"));

const EX = "exporters.awss3";
const RX_SQS = "receivers.awss3/sqs_traces";
const RX_REPLAY = "receivers.aws_s3/replay";
const RX = "receivers.awss3";
const CH = "exporters.clickhouse";
const FILE_ROTATED = "exporters.file/rotated";
const FILE_APPEND = "exporters.file/append";

/** A text holding only `lines` under `section`'s `name` (at four spaces), in a pipeline. */
function own(section: "receivers" | "exporters", name: string, lines: string): string {
  const body = lines.trimEnd() === "" ? [`  ${name}: {}`] : [`  ${name}:`, lines.trimEnd()];
  const receivers = section === "receivers" ? ["receivers:", ...body] : ["receivers:", "  otlp:", "    protocols:", "      grpc:"];
  const exporters = section === "exporters" ? ["exporters:", ...body] : ["exporters:", "  debug:"];
  const id = name.split(":")[0]!;
  return [
    ...receivers,
    ...exporters,
    "service:",
    "  pipelines:",
    "    logs:",
    `      receivers: [${section === "receivers" ? id : "otlp"}]`,
    `      exporters: [${section === "exporters" ? id : "debug"}]`,
    "",
  ].join("\n");
}

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "warning").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const toasts = (kind: "error" | "success" | "warning" | "info") => vi.mocked(toast[kind]).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

/** The form a component's key gets, from the registry, as the Configuration tab finds it. */
function formOf(key: string) {
  const node = componentNamed(key);
  const Form = formFor(node.type as "receiver" | "exporter", node.data.componentSubType ?? "");
  if (!Form) throw new Error(`no form for ${key}`);
  return Form;
}

function renderForm(text: string, key: string) {
  openText(text);
  const user = userEvent.setup();
  const Form = formOf(key);
  render(
    <ComponentForm nodeId={componentNamed(key).id}>
      <Form />
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  const parsed = parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
  return parsed[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
/** A hint line, by its whole text. */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name may also hold its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\d*$`) }));
}

const box = (label: string) => screen.getByRole("checkbox", { name: label });
const combo = (label: string) => screen.getByRole("combobox", { name: label });

/** Where `key`'s lines start in `text`: its name's line under its section. */
function componentAt(text: string, key: string): number {
  const dot = key.indexOf(".");
  return text.indexOf(`\n  ${key.slice(dot + 1)}:`, text.indexOf(`\n${key.slice(0, dot)}:`));
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  /** The text the case runs on (LF); the corpus by default. */
  base?: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  check: (value: Value) => void;
}

const EX_END = "      max_interval: 30s\n  clickhouse:\n";
const up = (v: Value) => v.s3uploader as Value;

const EXPORTER_CASES: FieldCase[] = [
  {
    name: "Region",
    key: EX,
    edit: (user) => retypeInto(user, byId("awss3-region"), "eu-west-1"),
    from: "      region: eu-central-1\n",
    to: "      region: eu-west-1\n",
    check: (v) => expect(up(v).region).toBe("eu-west-1"),
  },
  {
    name: "Region cleared removes the key (never region: \"\", refused, config.go:126-128)",
    key: EX,
    edit: (user) => retypeInto(user, byId("awss3-region"), ""),
    from: "      region: eu-central-1\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("region"),
  },
  {
    name: "Bucket",
    key: EX,
    edit: (user) => retypeInto(user, byId("awss3-bucket"), "${env:AWS_S3_BUCKET}"),
    from: "      s3_bucket: databucket\n",
    to: "      s3_bucket: ${env:AWS_S3_BUCKET}\n",
    check: (v) => expect(up(v).s3_bucket).toBe("${env:AWS_S3_BUCKET}"),
  },
  {
    name: "Prefix",
    key: EX,
    edit: (user) => retypeInto(user, byId("awss3-prefix"), "traces"),
    from: "      s3_prefix: metric\n",
    to: "      s3_prefix: traces\n",
    check: (v) => expect(up(v).s3_prefix).toBe("traces"),
  },
  {
    name: "Base Prefix",
    key: EX,
    edit: (user) => retypeInto(user, byId("awss3-base-prefix"), "environment/dev"),
    from: "      s3_base_prefix: environment/prod\n",
    to: "      s3_base_prefix: environment/dev\n",
    check: (v) => expect(up(v).s3_base_prefix).toBe("environment/dev"),
  },
  {
    name: "Marshaler",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Format & Compression");
      await pickIn(user, combo("Marshaler"), "Log body as text (logs only)");
    },
    from: "    marshaler: otlp_proto\n",
    to: "    marshaler: body\n",
    check: (v) => expect(v.marshaler).toBe("body"),
  },
  {
    name: "Compression zstd",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Format & Compression");
      await pickIn(user, combo("Compression"), "zstd");
    },
    from: "      compression: gzip\n",
    to: "      compression: zstd\n",
    check: (v) => expect(up(v).compression).toBe("zstd"),
  },
  {
    name: "Compression None removes the key",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Format & Compression");
      await pickIn(user, combo("Compression"), "None");
    },
    from: "      compression: gzip\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("compression"),
  },
  {
    name: "Encoding Extension (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Format & Compression");
      await typeInto(user, byId("awss3-encoding"), "text_encoding");
    },
    from: EX_END,
    to: "      max_interval: 30s\n    encoding: text_encoding\n  clickhouse:\n",
    check: (v) => expect(v.encoding).toBe("text_encoding"),
  },
  {
    name: "Encoding File Extension (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Format & Compression");
      await typeInto(user, byId("awss3-encoding-ext"), "txt");
    },
    from: EX_END,
    to: "      max_interval: 30s\n    encoding_file_extension: txt\n  clickhouse:\n",
    check: (v) => expect(v.encoding_file_extension).toBe("txt"),
  },
  {
    name: "Partition Format",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await retypeInto(user, byId("awss3-partition-format"), "%Y/%m/%d");
    },
    from: "      s3_partition_format: '%Y/%m/%d/%H/%M'\n",
    // The scalar keeps the quotes it was written with.
    to: "      s3_partition_format: '%Y/%m/%d'\n",
    check: (v) => expect(up(v).s3_partition_format).toBe("%Y/%m/%d"),
  },
  {
    name: "Partition Timezone",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await retypeInto(user, byId("awss3-partition-tz"), "Europe/London");
    },
    from: "      s3_partition_timezone: UTC\n",
    to: "      s3_partition_timezone: Europe/London\n",
    check: (v) => expect(up(v).s3_partition_timezone).toBe("Europe/London"),
  },
  {
    name: "File Prefix (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await typeInto(user, byId("awss3-file-prefix"), "otel-");
    },
    from: "      unique_key_func_name: uuidv7\n",
    to: "      unique_key_func_name: uuidv7\n      file_prefix: otel-\n",
    check: (v) => expect(up(v).file_prefix).toBe("otel-"),
  },
  {
    name: "Unique Key Segment: Random integer removes the key (the unset option)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await pickIn(user, combo("Unique Key Segment"), "Random integer");
    },
    from: "      unique_key_func_name: uuidv7\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("unique_key_func_name"),
  },
  {
    name: "Storage Class: one of the four added",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await pickIn(user, combo("Storage Class"), "AWS_BACKUP_LOW_COST_WARM");
    },
    from: "      storage_class: STANDARD_IA\n",
    to: "      storage_class: AWS_BACKUP_LOW_COST_WARM\n",
    check: (v) => expect(up(v).storage_class).toBe("AWS_BACKUP_LOW_COST_WARM"),
  },
  {
    name: "Storage Class: STANDARD removes the key (the default, factory.go:60)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await pickIn(user, combo("Storage Class"), "STANDARD");
    },
    from: "      storage_class: STANDARD_IA\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("storage_class"),
  },
  {
    name: "Canned ACL (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await pickIn(user, combo("Canned ACL"), "bucket-owner-full-control");
    },
    from: "      unique_key_func_name: uuidv7\n",
    to: "      unique_key_func_name: uuidv7\n      acl: bucket-owner-full-control\n",
    check: (v) => expect(up(v).acl).toBe("bucket-owner-full-control"),
  },
  {
    name: "Bucket From Resource Attribute",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Dynamic Routing");
      await retypeInto(user, byId("awss3-attr-bucket"), "s3.bucket");
    },
    from: "      s3_bucket: com.awss3.bucket\n",
    to: "      s3_bucket: s3.bucket\n",
    check: (v) => expect(v.resource_attrs_to_s3).toEqual({ s3_bucket: "s3.bucket", s3_prefix: "com.awss3.prefix" }),
  },
  {
    name: "Prefix From Resource Attribute cleared: the block keeps the bucket",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Dynamic Routing");
      await retypeInto(user, byId("awss3-attr-prefix"), "");
    },
    from: "      s3_prefix: com.awss3.prefix\n",
    to: "",
    check: (v) => expect(v.resource_attrs_to_s3).toEqual({ s3_bucket: "com.awss3.bucket" }),
  },
  {
    name: "Endpoint (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await typeInto(user, byId("awss3-endpoint"), "http://minio:9000");
    },
    from: "      unique_key_func_name: uuidv7\n",
    to: "      unique_key_func_name: uuidv7\n      endpoint: http://minio:9000\n",
    check: (v) => expect(up(v).endpoint).toBe("http://minio:9000"),
  },
  {
    name: "Role ARN",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("awss3-role-arn"), "arn:aws:iam::210987654321:role/w");
    },
    from: "      role_arn: arn:aws:iam::123456789012:role/otel-s3-writer\n",
    to: "      role_arn: arn:aws:iam::210987654321:role/w\n",
    check: (v) => expect(up(v).role_arn).toBe("arn:aws:iam::210987654321:role/w"),
  },
  {
    name: "Force Path-Style unticked removes the key",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await user.click(box("Force Path-Style Addressing"));
    },
    from: "      s3_force_path_style: true\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("s3_force_path_style"),
  },
  {
    name: "Disable SSL ticked writes true",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await user.click(box("Disable SSL"));
    },
    from: "      unique_key_func_name: uuidv7\n",
    to: "      unique_key_func_name: uuidv7\n      disable_ssl: true\n",
    check: (v) => expect(up(v).disable_ssl).toBe(true),
  },
  {
    name: "SDK Retry Mode: Standard removes the key (the default, factory.go:61)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await pickIn(user, combo("SDK Retry Mode"), "Standard");
    },
    from: "      retry_mode: adaptive\n",
    to: "",
    check: (v) => expect(up(v)).not.toHaveProperty("retry_mode"),
  },
  {
    name: "SDK Retry Mode: None writes nop",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await pickIn(user, combo("SDK Retry Mode"), "None");
    },
    from: "      retry_mode: adaptive\n",
    to: "      retry_mode: nop\n",
    check: (v) => expect(up(v).retry_mode).toBe("nop"),
  },
  {
    name: "SDK Max Attempts 0, written plain",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("awss3-retry-attempts"), "0");
    },
    from: "      retry_max_attempts: 5\n",
    to: "      retry_max_attempts: 0\n",
    check: (v) => expect(up(v).retry_max_attempts).toBe(0),
  },
  {
    name: "SDK Max Backoff",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("awss3-retry-backoff"), "1m");
    },
    from: "      retry_max_backoff: 30s\n",
    to: "      retry_max_backoff: 1m\n",
    check: (v) => expect(up(v).retry_max_backoff).toBe("1m"),
  },
  {
    name: "Timeout",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Timeout, Retry & Queue");
      await retypeInto(user, byId("awss3-timeout"), "45s");
    },
    from: "    timeout: 20s\n",
    to: "    timeout: 45s\n",
    check: (v) => expect(v.timeout).toBe("45s"),
  },
];

const dl = (v: Value) => v.s3downloader as Value;
const RX_SQS_END = "      max_number_of_messages: 5\n";

const RECEIVER_CASES: FieldCase[] = [
  {
    name: "Region",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-region"), "eu-west-2"),
    from: "      region: us-east-1\n      s3_bucket: mybucket\n",
    to: "      region: eu-west-2\n      s3_bucket: mybucket\n",
    check: (v) => expect(dl(v).region).toBe("eu-west-2"),
  },
  {
    name: "Bucket cleared removes the key (never \"\")",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-bucket"), ""),
    from: "      s3_bucket: mybucket\n      s3_prefix: mytrace\n",
    to: "      s3_prefix: mytrace\n",
    check: (v) => expect(dl(v)).not.toHaveProperty("s3_bucket"),
  },
  {
    name: "Prefix",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-prefix"), "logs"),
    from: "      s3_prefix: mytrace\n",
    to: "      s3_prefix: logs\n",
    check: (v) => expect(dl(v).s3_prefix).toBe("logs"),
  },
  {
    name: "SQS Queue URL",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-queue-url"), "${env:QUEUE}"),
    from: "      queue_url: https://sqs.us-east-1.amazonaws.com/123456789012/test-queue\n",
    to: "      queue_url: ${env:QUEUE}\n",
    check: (v) => expect((v.sqs as Value).queue_url).toBe("${env:QUEUE}"),
  },
  {
    name: "SQS Region",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-sqs-region"), "us-west-2"),
    from: "      region: us-east-1\n      wait_time_seconds: 10\n",
    to: "      region: us-west-2\n      wait_time_seconds: 10\n",
    check: (v) => expect((v.sqs as Value).region).toBe("us-west-2"),
  },
  {
    name: "SQS Endpoint (unset)",
    key: RX_SQS,
    edit: (user) => typeInto(user, byId("awss3r-sqs-endpoint"), "http://localstack:4566"),
    from: RX_SQS_END,
    to: `${RX_SQS_END}      endpoint: http://localstack:4566\n`,
    check: (v) => expect((v.sqs as Value).endpoint).toBe("http://localstack:4566"),
  },
  {
    name: "Long-Poll Wait 0, plain",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-sqs-wait"), "0"),
    from: "      wait_time_seconds: 10\n",
    to: "      wait_time_seconds: 0\n",
    check: (v) => expect((v.sqs as Value).wait_time_seconds).toBe(0),
  },
  {
    name: "Messages Per Poll",
    key: RX_SQS,
    edit: (user) => retypeInto(user, byId("awss3r-sqs-max"), "10"),
    from: "      max_number_of_messages: 5\n",
    to: "      max_number_of_messages: 10\n",
    check: (v) => expect((v.sqs as Value).max_number_of_messages).toBe(10),
  },
  {
    name: "Start Time, written as a string (yaml.v3 reads a bare date as a timestamp)",
    key: RX_REPLAY,
    edit: (user) => retypeInto(user, byId("awss3r-starttime"), "2024-02-01"),
    from: '    starttime: "2024-01-01 01:00"\n',
    to: '    starttime: "2024-02-01"\n',
    check: (v) => expect(v.starttime).toBe("2024-02-01"),
  },
  {
    name: "End Time",
    key: RX_REPLAY,
    edit: (user) => retypeInto(user, byId("awss3r-endtime"), "2024-03-01T00:00:00Z"),
    from: '    endtime: "2024-01-02"\n',
    to: '    endtime: "2024-03-01T00:00:00Z"\n',
    check: (v) => expect(v.endtime).toBe("2024-03-01T00:00:00Z"),
  },
  {
    name: "Partition Format (unset)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await typeInto(user, byId("awss3r-partition-format"), "%Y/%m/%d");
    },
    from: "      tag_object_after_ingestion: true\n",
    to: '      tag_object_after_ingestion: true\n      s3_partition_format: "%Y/%m/%d"\n',
    check: (v) => expect(dl(v).s3_partition_format).toBe("%Y/%m/%d"),
  },
  {
    name: "Partition Timezone",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await retypeInto(user, byId("awss3r-partition-tz"), "Asia/Tokyo");
    },
    from: "      s3_partition_timezone: UTC\n",
    to: "      s3_partition_timezone: Asia/Tokyo\n",
    check: (v) => expect(dl(v).s3_partition_timezone).toBe("Asia/Tokyo"),
  },
  {
    name: "File Prefix (unset)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await typeInto(user, byId("awss3r-file-prefix"), "otel-");
    },
    from: "      tag_object_after_ingestion: true\n",
    to: "      tag_object_after_ingestion: true\n      file_prefix: otel-\n",
    check: (v) => expect(dl(v).file_prefix).toBe("otel-"),
  },
  {
    name: "Expect Telemetry Type ticked removes the key (the default true, config.go:85)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await user.click(box("Expect Telemetry Type in File Prefix"));
    },
    from: "      file_prefix_include_telemetry_type: false\n",
    to: "",
    check: (v) => expect(dl(v)).not.toHaveProperty("file_prefix_include_telemetry_type"),
  },
  {
    name: "Expect Telemetry Type unticked (unset, so ticked) writes false",
    key: RX_SQS,
    edit: async (user) => {
      await openSection(user, "Object Layout");
      await user.click(box("Expect Telemetry Type in File Prefix"));
    },
    from: "      skip_ingesting_tagged_objects: true\n",
    to: "      skip_ingesting_tagged_objects: true\n      file_prefix_include_telemetry_type: false\n",
    check: (v) => expect(dl(v).file_prefix_include_telemetry_type).toBe(false),
  },
  {
    name: "an encoding's extension",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Encodings");
      await retypeInto(user, screen.getByRole("textbox", { name: "Encoding 1 extension" }), "otlp_encoding");
    },
    from: "      - extension: text_encoding\n",
    to: "      - extension: otlp_encoding\n",
    check: (v) => expect(v.encodings).toEqual([{ extension: "otlp_encoding", suffix: ".txt" }]),
  },
  {
    name: "an encoding's suffix cleared removes suffix only",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Encodings");
      await retypeInto(user, screen.getByRole("textbox", { name: "Encoding 1 suffix" }), "");
    },
    from: "        suffix: .txt\n",
    to: "",
    check: (v) => expect(v.encodings).toEqual([{ extension: "text_encoding" }]),
  },
  {
    name: "Tag Objects After Ingestion unticked removes the key",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Lifecycle");
      await user.click(box("Tag Objects After Ingestion"));
    },
    from: "      tag_object_after_ingestion: true\n",
    to: "",
    check: (v) => expect(dl(v)).not.toHaveProperty("tag_object_after_ingestion"),
  },
  {
    name: "Skip Already-Tagged Objects ticked writes true",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Object Lifecycle");
      await user.click(box("Skip Already-Tagged Objects"));
    },
    from: "      tag_object_after_ingestion: true\n",
    to: "      tag_object_after_ingestion: true\n      skip_ingesting_tagged_objects: true\n",
    check: (v) => expect(dl(v).skip_ingesting_tagged_objects).toBe(true),
  },
  {
    name: "Endpoint (unset)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Connection");
      await typeInto(user, byId("awss3r-endpoint"), "http://minio:9000");
    },
    from: "      tag_object_after_ingestion: true\n",
    to: "      tag_object_after_ingestion: true\n      endpoint: http://minio:9000\n",
    check: (v) => expect(dl(v).endpoint).toBe("http://minio:9000"),
  },
  {
    name: "Endpoint Partition (unset)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Connection");
      await typeInto(user, byId("awss3r-partition-id"), "aws-cn");
    },
    from: "      tag_object_after_ingestion: true\n",
    to: "      tag_object_after_ingestion: true\n      endpoint_partition_id: aws-cn\n",
    check: (v) => expect(dl(v).endpoint_partition_id).toBe("aws-cn"),
  },
  {
    name: "Force Path-Style unticked removes the key",
    key: RX_SQS,
    edit: async (user) => {
      await openSection(user, "Connection");
      await user.click(box("Force Path-Style Addressing"));
    },
    from: "      s3_force_path_style: true\n",
    to: "",
    check: (v) => expect(dl(v)).not.toHaveProperty("s3_force_path_style"),
  },
  {
    name: "OpAMP Progress Notifications",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("awss3r-opamp"), "opamp/progress");
    },
    from: "      opampextension: opamp\n",
    to: "      opampextension: opamp/progress\n",
    check: (v) => expect(v.notifications).toEqual({ opampextension: "opamp/progress" }),
  },
  {
    name: "OpAMP Progress Notifications cleared removes notifications (the pruning scope)",
    key: RX_REPLAY,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("awss3r-opamp"), "");
    },
    from: "    notifications:\n      opampextension: opamp\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("notifications"),
  },
];

const CH_TLS_END = "      ca_file: /etc/ssl/certs/ca.pem\n";

const CLICKHOUSE_CASES: FieldCase[] = [
  {
    name: "Endpoint",
    key: CH,
    edit: (user) => retypeInto(user, byId("clickhouse-endpoint"), "https://ch.example.com:8443"),
    from: "    endpoint: tcp://clickhouse:9000?dial_timeout=10s\n",
    to: "    endpoint: https://ch.example.com:8443\n",
    check: (v) => expect(v.endpoint).toBe("https://ch.example.com:8443"),
  },
  {
    name: "Database",
    key: CH,
    edit: (user) => retypeInto(user, byId("clickhouse-database"), "telemetry"),
    from: "    database: otel\n",
    to: "    database: telemetry\n",
    check: (v) => expect(v.database).toBe("telemetry"),
  },
  {
    name: "Username",
    key: CH,
    edit: (user) => retypeInto(user, byId("clickhouse-username"), "writer"),
    from: "    username: otel_writer\n",
    to: "    username: writer\n",
    check: (v) => expect(v.username).toBe("writer"),
  },
  {
    name: "Password",
    key: CH,
    edit: (user) => retypeInto(user, byId("clickhouse-password"), "${env:CH_PASSWORD}"),
    from: "    password: ${env:CLICKHOUSE_PASSWORD}\n",
    to: "    password: ${env:CH_PASSWORD}\n",
    check: (v) => expect(v.password).toBe("${env:CH_PASSWORD}"),
  },
  {
    name: "Data TTL",
    key: CH,
    edit: (user) => retypeInto(user, byId("clickhouse-ttl"), "24h"),
    from: "    ttl: 72h\n",
    to: "    ttl: 24h\n",
    check: (v) => expect(v.ttl).toBe("24h"),
  },
  {
    name: "Create Schema on Startup ticked writes true",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await user.click(box("Create Schema on Startup"));
    },
    from: "    create_schema: false\n",
    to: "    create_schema: true\n",
    check: (v) => expect(v.create_schema).toBe(true),
  },
  {
    name: "Logs Table",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await retypeInto(user, byId("clickhouse-logs-table"), "logs");
    },
    from: "    logs_table_name: my_logs\n",
    to: "    logs_table_name: logs\n",
    check: (v) => expect(v.logs_table_name).toBe("logs"),
  },
  {
    name: "Traces Table",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await retypeInto(user, byId("clickhouse-traces-table"), "traces");
    },
    from: "    traces_table_name: my_traces\n",
    to: "    traces_table_name: traces\n",
    check: (v) => expect(v.traces_table_name).toBe("traces"),
  },
  {
    name: "Gauge Metrics Table",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await retypeInto(user, byId("clickhouse-metrics-gauge"), "gauges");
    },
    from: "        name: my_metrics_gauge\n",
    to: "        name: gauges\n",
    check: (v) => expect(v.metrics_tables).toEqual({ gauge: { name: "gauges" }, exponential_histogram: { name: "my_metrics_exp_histogram" } }),
  },
  {
    name: "Sum Metrics Table (unset): its kind under metrics_tables",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await typeInto(user, byId("clickhouse-metrics-sum"), "sums");
    },
    from: "        name: my_metrics_exp_histogram\n",
    to: "        name: my_metrics_exp_histogram\n      sum:\n        name: sums\n",
    check: (v) => expect((v.metrics_tables as Value).sum).toEqual({ name: "sums" }),
  },
  {
    name: "Gauge Metrics Table cleared removes the kind (the pruning scope)",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Schema & Tables");
      await retypeInto(user, byId("clickhouse-metrics-gauge"), "");
    },
    from: "      gauge:\n        name: my_metrics_gauge\n",
    to: "",
    check: (v) => expect(v.metrics_tables).toEqual({ exponential_histogram: { name: "my_metrics_exp_histogram" } }),
  },
  {
    name: "Cluster Name",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Cluster & Engine");
      await retypeInto(user, byId("clickhouse-cluster"), "c2");
    },
    from: "    cluster_name: my_cluster\n",
    to: "    cluster_name: c2\n",
    check: (v) => expect(v.cluster_name).toBe("c2"),
  },
  {
    name: "Table Engine",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Cluster & Engine");
      await retypeInto(user, byId("clickhouse-engine"), "ReplacingMergeTree");
    },
    from: "      name: ReplicatedMergeTree\n",
    to: "      name: ReplacingMergeTree\n",
    check: (v) => expect((v.table_engine as Value).name).toBe("ReplacingMergeTree"),
  },
  {
    name: "Engine Parameters cleared: the block keeps the name",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Cluster & Engine");
      await retypeInto(user, byId("clickhouse-engine-params"), "");
    },
    from: "      params: \"'/clickhouse/tables/{shard}/otel', '{replica}'\"\n",
    to: "",
    check: (v) => expect(v.table_engine).toEqual({ name: "ReplicatedMergeTree" }),
  },
  {
    name: "Async Insert unticked writes false",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Performance");
      await user.click(box("Async Insert"));
    },
    from: "    async_insert: true\n",
    to: "    async_insert: false\n",
    check: (v) => expect(v.async_insert).toBe(false),
  },
  {
    name: "Compression",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Performance");
      await pickIn(user, combo("Compression"), "br");
    },
    from: "    compress: zstd\n",
    to: "    compress: br\n",
    check: (v) => expect(v.compress).toBe("br"),
  },
  {
    name: "Request Timeout",
    key: CH,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retypeInto(user, byId("clickhouse-timeout"), "15s");
    },
    from: "    timeout: 10s\n",
    to: "    timeout: 15s\n",
    check: (v) => expect(v.timeout).toBe("15s"),
  },
  {
    name: "Skip TLS Verification unticked writes false",
    key: CH,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(box("Skip TLS Verification (insecure)"));
    },
    from: "      insecure_skip_verify: true\n",
    to: "      insecure_skip_verify: false\n",
    check: (v) => expect((v.tls as Value).insecure_skip_verify).toBe(false),
  },
  {
    name: "CA File",
    key: CH,
    edit: async (user) => {
      await openSection(user, "TLS");
      await retypeInto(user, byId("clickhouse-tls-ca"), "/etc/ca.pem");
    },
    from: CH_TLS_END,
    to: "      ca_file: /etc/ca.pem\n",
    check: (v) => expect((v.tls as Value).ca_file).toBe("/etc/ca.pem"),
  },
  {
    name: "Client Certificate (unset)",
    key: CH,
    edit: async (user) => {
      await openSection(user, "TLS");
      await typeInto(user, byId("clickhouse-tls-cert"), "/etc/client.pem");
    },
    from: CH_TLS_END,
    to: `${CH_TLS_END}      cert_file: /etc/client.pem\n`,
    check: (v) => expect((v.tls as Value).cert_file).toBe("/etc/client.pem"),
  },
  {
    name: "Client Key (unset)",
    key: CH,
    edit: async (user) => {
      await openSection(user, "TLS");
      await typeInto(user, byId("clickhouse-tls-key"), "/etc/client-key.pem");
    },
    from: CH_TLS_END,
    to: `${CH_TLS_END}      key_file: /etc/client-key.pem\n`,
    check: (v) => expect((v.tls as Value).key_file).toBe("/etc/client-key.pem"),
  },
];

const FILE_CASES: FieldCase[] = [
  {
    name: "File Path",
    key: FILE_ROTATED,
    edit: (user) => retypeInto(user, byId("path"), "/var/log/otel/t.json"),
    from: "    path: /var/log/otel/telemetry.json\n",
    to: "    path: /var/log/otel/t.json\n",
    check: (v) => expect(v.path).toBe("/var/log/otel/t.json"),
  },
  {
    name: "Max Backups",
    key: FILE_ROTATED,
    edit: async (user) => {
      await openSection(user, "Rotation");
      await retypeInto(user, byId("rotation-max-backups"), "7");
    },
    from: "      max_backups: 3\n",
    to: "      max_backups: 7\n",
    check: (v) => expect(v.rotation).toEqual({ max_megabytes: 10, max_days: 3, max_backups: 7, localtime: true }),
  },
  {
    name: "Max Days 0 over the anchor's merged key: the exporter's own key, the anchor untouched (0 can be typed)",
    key: FILE_ROTATED,
    edit: async (user) => {
      await openSection(user, "Rotation");
      await retypeInto(user, byId("rotation-max-days"), "0");
    },
    from: "      localtime: true\n",
    to: "      localtime: true\n      max_days: 0\n",
    check: (v) => expect(v.rotation).toEqual({ max_megabytes: 10, max_days: 0, max_backups: 3, localtime: true }),
  },
];

describe("every field writes only its key", () => {
  it.each(
    [...EXPORTER_CASES, ...RECEIVER_CASES, ...CLICKHOUSE_CASES, ...FILE_CASES].flatMap((c) => [
      [`${c.key}: ${c.name}, LF`, c, false] as const,
      [`${c.key}: ${c.name}, CRLF`, c, true] as const,
    ]),
  )(
    "%s",
    async (_name, c, crlf) => {
      const base = c.base ?? CORPUS;
      const before = crlf ? CRLF(base) : base;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from).length).toBeGreaterThanOrEqual(2);
      const user = renderForm(before, c.key);

      await c.edit(user);

      // The component's own occurrence of `from` changes, and nothing else.
      const at = before.indexOf(from, componentAt(before, c.key));
      expect(text()).toBe(before.slice(0, at) + to + before.slice(at + from.length));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(toasts("error")).toEqual([]);
      expect(toasts("info")).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

// ── Opening writes nothing ──

async function openEverything(user: UserEvent) {
  for (let round = 0; round < 3; round++) {
    for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
  }
}

describe("opening writes nothing", () => {
  // One test per text, each with its own time limit.
  it.each([
    // 4 top fields; marshaler, compression, 2 encodings; 6 layout; 2 routing; 7 connection; timeout, 2 boxes.
    ["the S3 exporter, the storage corpus", CORPUS, EX, 30],
    ["the S3 exporter, CRLF", CRLF(CORPUS), EX, 30],
    ["an empty S3 exporter", own("exporters", "awss3", ""), EX, 25],
    // 3 top fields, the mode, 5 SQS fields; 4 layout; 3 lifecycle and connection boxes, 2 connection fields, OpAMP.
    ["the S3 receiver in SQS mode", CORPUS, RX_SQS, 18],
    ["the S3 receiver in SQS mode, CRLF", CRLF(CORPUS), RX_SQS, 18],
    ["the aws_s3 receiver over a time range, with an encoding", CORPUS, RX_REPLAY, 18],
    ["the awss3 receiver beside the awss3 exporter", CORPUS, RX, 15],
    ["an empty S3 receiver", own("receivers", "awss3", ""), RX, 15],
    // 5 top fields; 1 box, 7 tables; cluster, 2 engine; box, select, timeout; box, 3 TLS; retry 5; queue 4+.
    ["clickhouse, the storage corpus", CORPUS, CH, 35],
    ["clickhouse, CRLF", CRLF(CORPUS), CH, 35],
    ["an empty clickhouse", own("exporters", "clickhouse", ""), CH, 25],
    ["file/rotated, its rotation merged from an anchor", CORPUS, FILE_ROTATED, 4],
    ["file/append", CORPUS, FILE_APPEND, 4],
    ["file/append, CRLF", CRLF(CORPUS), FILE_APPEND, 4],
  ] as const)(
    "opening %s, every section, focusing every field, writes nothing and leaves the editor clean",
    async (_name, base, key, minimum) => {
      const user = renderForm(base, key);
      await openEverything(user);
      expect(screen.queryAllByRole("button", { expanded: false })).toEqual([]);
      const { textboxes, all } = formControls();
      expect(all).toBeGreaterThanOrEqual(minimum);
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
      expect(toasts("info")).toEqual([]);
    },
    20_000,
  );

  it("each component gets its own form, from the registry: the receiver's and the exporter's awss3 differ, aws_s3 is the receiver's", () => {
    openText(CORPUS);
    expect(formOf(EX)).toBe(AWSS3ExporterForm);
    expect(formOf(RX)).toBe(AWSS3ReceiverForm);
    expect(formOf(RX_SQS)).toBe(AWSS3ReceiverForm);
    expect(formOf(RX_REPLAY)).toBe(AWSS3ReceiverForm);
    expect(formOf(CH)).toBe(ClickhouseExporterForm);
    expect(formOf(FILE_ROTATED)).toBe(FileExporterForm);
    expect(AWSS3ReceiverForm).not.toBe(AWSS3ExporterForm);
  });
});

// ── The S3 exporter ──

describe("the S3 exporter's queue, selects and copy", () => {
  it("the Sending Queue is off while absent: the exporter's queue is configoptional.Default (factory.go:51); ticking writes the default block, unticking removes it", async () => {
    const base = own("exporters", "awss3", "    s3uploader:\n      s3_bucket: b");
    const user = renderForm(base, EX);
    await openSection(user, "Timeout, Retry & Queue");
    expect(box("Enable Sending Queue")).toHaveAttribute("data-state", "unchecked");
    // Retry is on by default (configretry.NewDefaultBackOffConfig, factory.go:66).
    expect(box("Enable Retry on Failure")).toHaveAttribute("data-state", "checked");
    await user.click(box("Enable Sending Queue"));
    expect(valueOf(EX).sending_queue).toEqual({ enabled: true, num_consumers: 10, queue_size: 1000 });
    expect(entries()).toBe(1);
    await user.click(box("Enable Sending Queue"));
    expect(text()).toBe(base);
  });

  it("the corpus's queue (enabled: true) shows on; unticking removes the block, one change", async () => {
    const user = renderForm(CORPUS, EX);
    await openSection(user, "Timeout, Retry & Queue");
    expect(box("Enable Sending Queue")).toHaveAttribute("data-state", "checked");
    await user.click(box("Enable Sending Queue"));
    expect(valueOf(EX)).not.toHaveProperty("sending_queue");
    expect(text()).toBe(CORPUS.replace("    sending_queue:\n      enabled: true\n      num_consumers: 10\n      queue_size: 100\n", ""));
    expect(entries()).toBe(1);
  });

  it("Storage Class offers the collector's 15 (config.go:112-115, 133-135)", async () => {
    expect(STORAGE_CLASSES).toHaveLength(15);
    const user = renderForm(own("exporters", "awss3", ""), EX);
    await openSection(user, "Object Layout");
    await user.click(combo("Storage Class"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([...STORAGE_CLASSES]);
    for (const added of ["FSX_OPENZFS", "FSX_ONTAP", "AWS_BACKUP_WARM", "AWS_BACKUP_LOW_COST_WARM"]) {
      expect(screen.getByRole("option", { name: added })).toBeInTheDocument();
    }
  });

  it("unset shows each default as its placeholder and hint, Partition Timezone Local (s3_writer.go:94-103)", async () => {
    const user = renderForm(own("exporters", "awss3", ""), EX);
    expect(byId("awss3-region")).toHaveAttribute("placeholder", "us-east-1");
    await openSection(user, "Format & Compression");
    await openSection(user, "Object Layout");
    await openSection(user, "Connection");
    expect(combo("Marshaler")).toHaveTextContent("OTLP JSON (.json)");
    expect(combo("Compression")).toHaveTextContent("None");
    expect(byId("awss3-partition-tz")).toHaveAttribute("placeholder", "Local");
    expect(combo("Unique Key Segment")).toHaveTextContent("Random integer");
    expect(combo("Storage Class")).toHaveTextContent("STANDARD");
    expect(combo("Canned ACL")).toHaveTextContent("None (do not set)");
    expect(combo("SDK Retry Mode")).toHaveTextContent("Standard");
    expect(byId("awss3-retry-attempts")).toHaveAttribute("placeholder", "3");
    expect(text()).toBe(own("exporters", "awss3", ""));
  });

  it("a value equal to the unset sentinel shows as written, under the written-value token", async () => {
    const user = renderForm(own("exporters", "awss3", `    s3uploader:\n      acl: ${UNSET_OPTION}`), EX);
    await openSection(user, "Object Layout");
    expect(combo("Canned ACL")).toHaveTextContent(UNSET_OPTION);
    await user.click(combo("Canned ACL"));
    expect(screen.getByRole("option", { name: UNSET_OPTION })).toHaveAttribute("data-state", "checked");
  });

  it("the Logs-only alert for sumo_ic and body (marshaler.go:57-66), and Bucket's required mark only without an endpoint", async () => {
    const user = renderForm(own("exporters", "awss3", "    marshaler: sumo_ic\n    s3uploader:\n      endpoint: http://minio:9000"), EX);
    expect(screen.getByText("Bucket").textContent).toBe("Bucket");
    await openSection(user, "Format & Compression");
    expect(screen.getByText("Logs only")).toBeInTheDocument();
    expect(screen.getByText(/Records also need _sourceCategory/)).toBeInTheDocument();
    cleanup();
    renderForm(own("exporters", "awss3", "    marshaler: otlp_proto"), EX);
    expect(screen.getByText("Bucket").textContent).toBe("Bucket*");
    expect(screen.getByText("Credentials")).toBeInTheDocument();
    expect(screen.queryByText("Logs only")).toBeNull();
  });

  it("clearing both resource attributes removes resource_attrs_to_s3 (the pruning scope)", async () => {
    const user = renderForm(CORPUS, EX);
    await openSection(user, "Dynamic Routing");
    await retypeInto(user, byId("awss3-attr-prefix"), "");
    await retypeInto(user, byId("awss3-attr-bucket"), "");
    expect(valueOf(EX)).not.toHaveProperty("resource_attrs_to_s3");
    expect(text()).toBe(CORPUS.replace("    resource_attrs_to_s3:\n      s3_bucket: com.awss3.bucket\n      s3_prefix: com.awss3.prefix\n", ""));
    // A block holding a key no field shows stays.
    cleanup();
    const kept = own("exporters", "awss3", "    resource_attrs_to_s3:\n      s3_prefix: p\n      future_key: x");
    const again = renderForm(kept, EX);
    await openSection(again, "Dynamic Routing");
    await retypeInto(again, byId("awss3-attr-prefix"), "");
    expect(valueOf(EX).resource_attrs_to_s3).toEqual({ future_key: "x" });
  });
});

// ── The S3 receiver's mode switch ──

const pickMode = (user: UserEvent, label: "SQS notifications (continuous)" | "Time range (one-shot replay)") =>
  pickIn(user, combo("Ingest Mode"), label);

describe("the S3 receiver's Ingest Mode", () => {
  it("shows the text's mode: sqs present is SQS, a time range otherwise (config.go:99-117)", () => {
    renderForm(CORPUS, RX_SQS);
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");
    expect(byId("awss3r-queue-url")).toHaveValue("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
    expect(byId("awss3r-starttime")).toBeNull();
    cleanup();
    renderForm(CORPUS, RX_REPLAY);
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    expect(byId("awss3r-starttime")).toHaveValue("2024-01-01 01:00");
    expect(byId("awss3r-queue-url")).toBeNull();
  });

  it("→ SQS seeds the palette's queue reference and the downloader's region, removing the times in one change, toasted (config.go:117)", async () => {
    const user = renderForm(CORPUS, RX_REPLAY);
    await pickMode(user, "SQS notifications (continuous)");
    const value = valueOf(RX_REPLAY);
    expect(value.sqs).toEqual({ queue_url: "${env:AWS_SQS_QUEUE_URL}", region: "us-west-1" });
    expect(SQS_QUEUE_URL_SEED).toBe("${env:AWS_SQS_QUEUE_URL}");
    // Never `queue_url: ""`, which the collector refuses (config.go:135-137).
    expect((value.sqs as Value).queue_url).not.toBe("");
    expect(value).not.toHaveProperty("starttime");
    expect(value).not.toHaveProperty("endtime");
    expect(toasts("info")).toEqual([SQS_TOAST]);
    expect(SQS_TOAST).toBe("Removed starttime and endtime: they can't be used with SQS.");
    expect(entries()).toBe(1);
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");
    expect(byId("awss3r-queue-url")).toHaveValue("${env:AWS_SQS_QUEUE_URL}");
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("→ SQS without a downloader region seeds us-east-1 (the default, config.go:83); with no times, no toast", async () => {
    const base = own("receivers", "awss3", "    s3downloader:\n      s3_bucket: b");
    const user = renderForm(base, RX);
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    await pickMode(user, "SQS notifications (continuous)");
    expect(valueOf(RX)).toEqual({ s3downloader: { s3_bucket: "b" }, sqs: { queue_url: "${env:AWS_SQS_QUEUE_URL}", region: "us-east-1" } });
    expect(LF(text())).toContain('    sqs:\n      queue_url: ${env:AWS_SQS_QUEUE_URL}\n      region: us-east-1\n');
    expect(toasts("info")).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("→ Time range is held: nothing written, sqs kept, until a time is typed; that write removes sqs in the same change, toasted", async () => {
    const user = renderForm(CORPUS, RX_SQS);
    await pickMode(user, "Time range (one-shot replay)");
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    expect(byId("awss3r-starttime")).toHaveValue("");
    expect(screen.getByText("Both times are required")).toBeInTheDocument();
    await typeInto(user, byId("awss3r-starttime"), "2024-05-01");
    const value = valueOf(RX_SQS);
    expect(value.starttime).toBe("2024-05-01");
    expect(value).not.toHaveProperty("sqs");
    expect(toasts("info")).toEqual([TIME_RANGE_TOAST]);
    expect(TIME_RANGE_TOAST).toBe("Removed the sqs block: it can't be used with a time range.");
    expect(entries()).toBe(1);
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    // The end time is a plain write.
    await typeInto(user, byId("awss3r-endtime"), "2024-05-02");
    expect(valueOf(RX_SQS).endtime).toBe("2024-05-02");
    expect(toasts("info")).toEqual([TIME_RANGE_TOAST]);
    expect(screen.queryByText("Both times are required")).toBeNull();
    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");
  });

  it("the held Time range stays through edits to the form's other fields and their undo; a time typed then takes it", async () => {
    const user = renderForm(CORPUS, RX_SQS);
    await pickMode(user, "Time range (one-shot replay)");
    await retypeInto(user, byId("awss3r-bucket"), "other-bucket");
    expect(valueOf(RX_SQS).s3downloader).toMatchObject({ s3_bucket: "other-bucket" });
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    expect(valueOf(RX_SQS).sqs).toBeDefined();
    await retypeInto(user, byId("awss3r-prefix"), "other");
    act(() => void builderStore().undo());
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
    await typeInto(user, byId("awss3r-starttime"), "2024-05-01");
    expect(valueOf(RX_SQS).starttime).toBe("2024-05-01");
    expect(valueOf(RX_SQS)).not.toHaveProperty("sqs");
    // After the undo's own toast.
    expect(toasts("info").filter((message) => message !== TIME_RANGE_TOAST)).toEqual(["Undo: Update AWS S3 (sqs_traces)"]);
    expect(toasts("info").at(-1)).toBe(TIME_RANGE_TOAST);
  });

  it("the held Time range goes when sqs changes by a write it didn't make: an undo, the YAML box", async () => {
    const user = renderForm(CORPUS, RX_SQS);
    await retypeInto(user, byId("awss3r-queue-url"), "https://sqs.example/q2");
    await pickMode(user, "Time range (one-shot replay)");
    // The undo puts the queue back: sqs changed.
    act(() => void builderStore().undo());
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");

    await pickMode(user, "Time range (one-shot replay)");
    const nodeId = componentNamed(RX_SQS).id;
    act(() => {
      builderStore().setComponentValue(nodeId, componentValueText(text(), RX_SQS).replace("wait_time_seconds: 10", "wait_time_seconds: 11"));
    });
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");
    expect(toasts("info")).not.toContain(TIME_RANGE_TOAST);
    expect(valueOf(RX_SQS).sqs).toBeDefined();
  });

  it("choosing SQS again while Time range is held drops the hold and writes nothing", async () => {
    const user = renderForm(CORPUS, RX_SQS);
    await pickMode(user, "Time range (one-shot replay)");
    await pickMode(user, "SQS notifications (continuous)");
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
    expect(byId("awss3r-queue-url")).toHaveValue("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
  });

  it("a text holding both (refused, config.go:116-118) shows SQS; Time range then removes sqs at once, the times being there", async () => {
    const base = own("receivers", "awss3", '    starttime: "2024-01-01"\n    endtime: "2024-01-02"\n    sqs:\n      queue_url: q\n      region: r');
    const user = renderForm(base, RX);
    expect(combo("Ingest Mode")).toHaveTextContent("SQS notifications (continuous)");
    await pickMode(user, "Time range (one-shot replay)");
    expect(valueOf(RX)).toEqual({ starttime: "2024-01-01", endtime: "2024-01-02" });
    expect(toasts("info")).toEqual([TIME_RANGE_TOAST]);
    expect(entries()).toBe(1);
  });

  it("a null sqs is none to the collector (config.go:101): the time range shows", () => {
    renderForm(own("receivers", "awss3", "    sqs:\n    s3downloader:\n      s3_bucket: b"), RX);
    expect(combo("Ingest Mode")).toHaveTextContent("Time range (one-shot replay)");
  });
});

// ── The S3 receiver's encodings ──

describe("the S3 receiver's Encodings", () => {
  const extensionOf = (n: number) => screen.getByRole("textbox", { name: `Encoding ${n} extension` });
  const suffixOf = (n: number) => screen.getByRole("textbox", { name: `Encoding ${n} suffix` });

  it("Add Encoding holds a row (never {extension: \"\", suffix: \"\"}, refused: identifiable.go:131-141); the extension writes it as a block item", async () => {
    const user = renderForm(CORPUS, RX_REPLAY);
    await openSection(user, "Encodings");
    expect(hint(SUFFIX_HINT)).toBeInTheDocument();
    expect(SUFFIX_HINT).toBe("An empty suffix matches every object.");
    await user.click(screen.getByRole("button", { name: "Add Encoding" }));
    expect(text()).toBe(CORPUS);
    // A suffix first waits in the row.
    await typeInto(user, suffixOf(2), ".log");
    expect(text()).toBe(CORPUS);
    await typeInto(user, extensionOf(2), "text_encoding/log");
    expect(text()).toBe(
      CORPUS.replace("        suffix: .txt\n", "        suffix: .txt\n      - extension: text_encoding/log\n        suffix: .log\n"),
    );
    expect(entries()).toBe(1);
    expect(toasts("info")).toEqual([]);
  });

  it("the first encoding of a receiver without encodings is a block list; suffix written only when typed", async () => {
    const user = renderForm(CORPUS, RX);
    await openSection(user, "Encodings");
    await user.click(screen.getByRole("button", { name: "Add Encoding" }));
    await typeInto(user, extensionOf(1), "text_encoding");
    expect(text()).toBe(CORPUS.replace("      s3_prefix: logs\n", "      s3_prefix: logs\n    encodings:\n      - extension: text_encoding\n"));
    expect(valueOf(RX).encodings).toEqual([{ extension: "text_encoding" }]);
    expect(entries()).toBe(1);
  });

  it("a held row left empty is dropped; its Remove writes nothing", async () => {
    const user = renderForm(CORPUS, RX_REPLAY);
    await openSection(user, "Encodings");
    await user.click(screen.getByRole("button", { name: "Add Encoding" }));
    await user.click(extensionOf(2));
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.queryByRole("textbox", { name: "Encoding 2 extension" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Encoding" }));
    await user.click(screen.getAllByRole("button", { name: "Remove encoding" })[1]!);
    expect(screen.queryByRole("textbox", { name: "Encoding 2 extension" })).toBeNull();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
  });

  it("removing the last encoding removes encodings", async () => {
    const user = renderForm(CORPUS, RX_REPLAY);
    await openSection(user, "Encodings");
    await user.click(screen.getByRole("button", { name: "Remove encoding" }));
    expect(valueOf(RX_REPLAY)).not.toHaveProperty("encodings");
    expect(text()).toBe(CORPUS.replace("    encodings:\n      - extension: text_encoding\n        suffix: .txt\n", ""));
    expect(entries()).toBe(1);
  });

  it("clearing both fields of an item removes it, never {}; the extension cleared beside a suffix removes the extension key only", async () => {
    const base = own("receivers", "awss3", "    encodings:\n      - extension: a\n        suffix: .a\n      - extension: b");
    const user = renderForm(base, RX);
    await openSection(user, "Encodings");
    await retypeInto(user, extensionOf(1), "");
    expect(valueOf(RX).encodings).toEqual([{ suffix: ".a" }, { extension: "b" }]);
    await retypeInto(user, suffixOf(1), "");
    expect(valueOf(RX).encodings).toEqual([{ extension: "b" }]);
    expect(LF(text())).not.toContain("{}");
  });

  it("an item that isn't a mapping is a read-only row with the unshowable-value hint; its Remove works", async () => {
    const user = renderForm(own("receivers", "awss3", "    encodings:\n      - text_encoding\n      - extension: b"), RX);
    await openSection(user, "Encodings");
    expect(extensionOf(1)).toBeDisabled();
    expect(extensionOf(2)).toBeEnabled();
    await user.click(screen.getAllByRole("button", { name: "Remove encoding" })[0]!);
    expect(valueOf(RX).encodings).toEqual([{ extension: "b" }]);
  });
});

// ── ClickHouse ──

describe("ClickHouse's defaults, hints and pruning", () => {
  it("defaults as placeholders: Database default (config.go:102), TTL 0 (config.go:129), the exponential histogram table otel_metrics_exponential_histogram (config.go:109, 137)", async () => {
    const user = renderForm(own("exporters", "clickhouse", ""), CH);
    expect(byId("clickhouse-database")).toHaveAttribute("placeholder", "default");
    expect(byId("clickhouse-ttl")).toHaveAttribute("placeholder", "0");
    await openSection(user, "Schema & Tables");
    expect(byId("clickhouse-metrics-exponential_histogram")).toHaveAttribute("placeholder", "otel_metrics_exponential_histogram");
    expect(METRIC_TABLE_KEYS.map((table) => table.defaultName)).toEqual([
      "otel_metrics_gauge",
      "otel_metrics_sum",
      "otel_metrics_summary",
      "otel_metrics_histogram",
      "otel_metrics_exponential_histogram",
    ]);
    expect(box("Create Schema on Startup")).toHaveAttribute("data-state", "checked");
    await openSection(user, "Performance");
    expect(box("Async Insert")).toHaveAttribute("data-state", "checked");
    expect(combo("Compression")).toHaveTextContent("lz4");
  });

  it("the hints: TLS (config.go:223-234), async_insert and compress (config.go:182-191), the engine's parameters (config.go:281-284)", async () => {
    const user = renderForm(CORPUS, CH);
    await openSection(user, "TLS");
    expect(hint(TLS_HINT)).toBeInTheDocument();
    expect(TLS_HINT).toBe("Setting a certificate, key, CA, server name or Skip Verify connects with TLS, whatever the endpoint.");
    await openSection(user, "Performance");
    expect(ASYNC_INSERT_HINT).toBe("Ignored when the endpoint or connection params set async_insert.");
    expect(
      hint(`Lets ClickHouse buffer and batch inserts server-side. Server settings can still override this. ${ASYNC_INSERT_HINT}`),
    ).toBeInTheDocument();
    expect(COMPRESS_HINT).toBe("Ignored when the endpoint or connection params set compress.");
    expect(hint(`${COMPRESS_HINT} · Default lz4`)).toBeInTheDocument();
    await openSection(user, "Cluster & Engine");
    expect(ENGINE_PARAMS_HINT).toBe("Ignored unless Table Engine is set.");
    expect(hint(`Raw parameter string passed to the engine. ${ENGINE_PARAMS_HINT}`)).toBeInTheDocument();
  });

  it("Password is a plain text field", () => {
    renderForm(CORPUS, CH);
    expect(byId("clickhouse-password")).toHaveAttribute("type", "text");
    expect(byId("clickhouse-password")).toHaveValue("${env:CLICKHOUSE_PASSWORD}");
  });

  it("clearing the last metric table removes its kind, then metrics_tables (two pruning levels)", async () => {
    const user = renderForm(CORPUS, CH);
    await openSection(user, "Schema & Tables");
    await retypeInto(user, byId("clickhouse-metrics-gauge"), "");
    await retypeInto(user, byId("clickhouse-metrics-exponential_histogram"), "");
    expect(valueOf(CH)).not.toHaveProperty("metrics_tables");
    expect(text()).toBe(
      CORPUS.replace(
        "    metrics_tables:\n      gauge:\n        name: my_metrics_gauge\n      exponential_histogram:\n        name: my_metrics_exp_histogram\n",
        "",
      ),
    );
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("a kind holding a key no field shows stays (the pruning guard)", async () => {
    const base = own("exporters", "clickhouse", "    metrics_tables:\n      gauge:\n        name: g\n        future_key: x");
    const user = renderForm(base, CH);
    await openSection(user, "Schema & Tables");
    await retypeInto(user, byId("clickhouse-metrics-gauge"), "");
    expect(valueOf(CH).metrics_tables).toEqual({ gauge: { future_key: "x" } });
  });

  it("clearing Table Engine and its parameters removes table_engine", async () => {
    const user = renderForm(CORPUS, CH);
    await openSection(user, "Cluster & Engine");
    await retypeInto(user, byId("clickhouse-engine-params"), "");
    await retypeInto(user, byId("clickhouse-engine"), "");
    expect(valueOf(CH)).not.toHaveProperty("table_engine");
    expect(text()).toBe(
      CORPUS.replace("    table_engine:\n      name: ReplicatedMergeTree\n      params: \"'/clickhouse/tables/{shard}/otel', '{replica}'\"\n", ""),
    );
  });

  it("the queue and retry are on by default (configoptional.Some, config.go:122-123)", async () => {
    const user = renderForm(own("exporters", "clickhouse", "    endpoint: tcp://c:9000"), CH);
    await openSection(user, "Retry on Failure");
    await openSection(user, "Sending Queue");
    expect(box("Enable Retry on Failure")).toHaveAttribute("data-state", "checked");
    expect(box("Enable Sending Queue")).toHaveAttribute("data-state", "checked");
  });
});

// ── File ──

describe("the file exporter's rotation", () => {
  it("the hint: rotation is on while the block is in the text (config.go:195-199)", async () => {
    const user = renderForm(CORPUS, FILE_APPEND);
    await openSection(user, "Rotation");
    expect(hint(ROTATION_HINT)).toBeInTheDocument();
    expect(ROTATION_HINT).toBe("Setting any of these turns rotation on; with none set, the file isn't rotated.");
    expect(byId("rotation-max-days")).toHaveAttribute("placeholder", "0");
  });

  it("a rotation value while append: true removes append in the same change, toasted (config.go:126-128); 0 can be typed", async () => {
    const user = renderForm(CORPUS, FILE_APPEND);
    await openSection(user, "Rotation");
    await typeInto(user, byId("rotation-max-days"), "0");
    expect(valueOf(FILE_APPEND)).toEqual({ path: "/var/log/otel/append.json", rotation: { max_days: 0 } });
    expect(LF(text())).toContain("    path: /var/log/otel/append.json\n    rotation:\n      max_days: 0\n");
    expect(toasts("info")).toEqual([APPEND_TOAST]);
    expect(APPEND_TOAST).toBe("Removed append: it can't be used with rotation.");
    expect(entries()).toBe(1);
    // A further rotation value: append is gone, no toast.
    await typeInto(user, byId("rotation-max-backups"), "5");
    expect(toasts("info")).toEqual([APPEND_TOAST]);
    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("append: false is taken beside rotation: nothing else changes, no toast", async () => {
    const base = own("exporters", "file", "    path: ./o.json\n    append: false");
    const user = renderForm(base, "exporters.file");
    await openSection(user, "Rotation");
    await typeInto(user, byId("rotation-max-megabytes"), "50");
    expect(valueOf("exporters.file")).toEqual({ path: "./o.json", append: false, rotation: { max_megabytes: 50 } });
    expect(toasts("info")).toEqual([]);
  });

  it("clearing the last rotation key removes rotation (never rotation: {}, still on); a key no field shows keeps it", async () => {
    const base = own("exporters", "file", "    path: ./o.json\n    rotation:\n      max_days: 3");
    const user = renderForm(base, "exporters.file");
    await openSection(user, "Rotation");
    await retypeInto(user, byId("rotation-max-days"), "");
    expect(text()).toBe(base.replace("    rotation:\n      max_days: 3\n", ""));
    expect(entries()).toBe(1);
    cleanup();
    const kept = own("exporters", "file", "    path: ./o.json\n    rotation:\n      max_days: 3\n      localtime: true");
    const again = renderForm(kept, "exporters.file");
    await openSection(again, "Rotation");
    await retypeInto(again, byId("rotation-max-days"), "");
    expect(valueOf("exporters.file").rotation).toEqual({ localtime: true });
  });

  it("a rotation: {} in the text stays until a key typed into it is cleared", async () => {
    const base = own("exporters", "file", "    path: ./o.json\n    rotation: {}");
    const user = renderForm(base, "exporters.file");
    await openSection(user, "Rotation");
    await typeInto(user, byId("rotation-max-backups"), "4");
    expect(valueOf("exporters.file").rotation).toEqual({ max_backups: 4 });
    await retypeInto(user, byId("rotation-max-backups"), "");
    expect(valueOf("exporters.file")).not.toHaveProperty("rotation");
  });
});

// ── Privacy ──

describe("privacy", () => {
  function scan(mark: string): string[] {
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(mark)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
      if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(mark)) leaks.push("option value");
    }
    return leaks;
  }
  const shownText = () => document.body.textContent + [...document.querySelectorAll("input")].map((e) => e.value).join();
  const MARK = "zq-mark";

  it("the S3 exporter puts no bucket, ARN, endpoint or value in any attribute, every select opened", async () => {
    const marked = own(
      "exporters",
      "awss3",
      [
        `    s3uploader: {region: ${MARK}-region, s3_bucket: ${MARK}-bucket, s3_prefix: ${MARK}-prefix, endpoint: http://${MARK}-ep, role_arn: arn:${MARK}-arn, acl: ${MARK}-acl, storage_class: ${MARK}-sc, compression: ${MARK}-comp, retry_mode: ${MARK}-rm, unique_key_func_name: ${MARK}-uk}`,
        `    marshaler: ${MARK}-marshaler`,
        `    encoding: ${MARK}-encoding`,
        `    resource_attrs_to_s3: {s3_bucket: ${MARK}-attr}`,
      ].join("\n"),
    );
    const user = renderForm(marked, EX);
    await openEverything(user);
    for (const what of ["region", "bucket", "prefix", "ep", "arn", "acl", "sc", "comp", "rm", "uk", "marshaler", "encoding", "attr"]) {
      expect(shownText()).toContain(`${MARK}-${what}`);
    }
    const leaks = scan(MARK);
    for (const label of ["Marshaler", "Compression", "Unique Key Segment", "Storage Class", "Canned ACL", "SDK Retry Mode"]) {
      await user.click(combo(label));
      leaks.push(...scan(MARK));
      await user.keyboard("{Escape}");
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
  });

  it("the S3 receiver puts no bucket, queue URL, time or encoding in any attribute, in either mode", async () => {
    const sqs = own(
      "receivers",
      "awss3",
      [
        `    s3downloader: {region: ${MARK}-region, s3_bucket: ${MARK}-bucket, endpoint: http://${MARK}-ep}`,
        `    sqs: {queue_url: https://${MARK}-queue, region: ${MARK}-sqsregion}`,
        `    encodings: [{extension: ${MARK}-ext, suffix: ${MARK}-suffix}]`,
        `    notifications: {opampextension: ${MARK}-opamp}`,
      ].join("\n"),
    );
    const user = renderForm(sqs, RX);
    await openEverything(user);
    for (const what of ["region", "bucket", "ep", "queue", "sqsregion", "ext", "suffix", "opamp"]) expect(shownText()).toContain(`${MARK}-${what}`);
    const leaks = scan(MARK);
    await user.click(combo("Ingest Mode"));
    leaks.push(...scan(MARK));
    await user.keyboard("{Escape}");
    expect(leaks).toEqual([]);
    cleanup();
    const timed = own("receivers", "awss3", `    starttime: ${MARK}-start\n    endtime: ${MARK}-end`);
    renderForm(timed, RX);
    expect(shownText()).toContain(`${MARK}-start`);
    expect(scan(MARK)).toEqual([]);
  });

  it("ClickHouse puts no endpoint, password, table or path in any attribute", async () => {
    const marked = own(
      "exporters",
      "clickhouse",
      [
        `    endpoint: tcp://${MARK}-ep:9000`,
        `    username: ${MARK}-user`,
        `    password: ${MARK}-password`,
        `    database: ${MARK}-db`,
        `    metrics_tables: {gauge: {name: ${MARK}-gauge}}`,
        `    table_engine: {name: ${MARK}-engine, params: ${MARK}-params}`,
        `    compress: ${MARK}-compress`,
        `    tls: {ca_file: ${MARK}-ca}`,
      ].join("\n"),
    );
    const user = renderForm(marked, CH);
    await openEverything(user);
    for (const what of ["ep", "user", "password", "db", "gauge", "engine", "params", "compress", "ca"]) {
      expect(shownText()).toContain(`${MARK}-${what}`);
    }
    const leaks = scan(MARK);
    await user.click(combo("Compression"));
    leaks.push(...scan(MARK));
    await user.keyboard("{Escape}");
    expect(leaks).toEqual([]);
  });

  it("the file exporter puts no path in any attribute", async () => {
    const user = renderForm(own("exporters", "file", `    path: /${MARK}-path\n    rotation: {max_days: 3}`), "exporters.file");
    await openEverything(user);
    expect(shownText()).toContain(`${MARK}-path`);
    expect(scan(MARK)).toEqual([]);
  });
});

// ── S3 and ClickHouse cases ──

describe("S3 receiver (10), S3 exporter (5) and ClickHouse exporter (4) cases", () => {
  const nodeOf = (key: string) => {
    const result = parse(CORPUS);
    if (!result.ok) throw new Error(result.reason);
    return result.graph.nodes.find((n) => n.data.key === key);
  };

  // awss3-receiver.test.ts 1–3.
  it("receiver 1: is registered as a receiver, labeled AWS S3", () => {
    expect(findPaletteEntry("receiver", "awss3")?.label).toBe("AWS S3");
  });
  it("receiver 2: seeds the continuous (SQS) mode, not a time range that would go stale", () => {
    const seed = findPaletteEntry("receiver", "awss3")!.defaultConfig as Value;
    expect((seed.s3downloader as Value).region).toBe("us-east-1");
    expect((seed.s3downloader as Value).s3_bucket).toMatch(/^\$\{env:/);
    expect((seed.sqs as Value).queue_url).toMatch(/^\$\{env:/);
    expect((seed.sqs as Value).queue_url).toBe(SQS_QUEUE_URL_SEED);
    expect(seed).not.toHaveProperty("starttime");
    expect(seed).not.toHaveProperty("endtime");
  });
  it("receiver 3: links to the contrib README", () => {
    expect(getComponentDocsUrl("receiver", "awss3")).toContain("receiver/awss3receiver");
  });
  // 4–6: the time-range instance's generation, now the corpus invariant; the form side writes the times and an encoding as a block item (above).
  it("receiver 4: the time-range receiver keeps its collector key and its pipeline", () => {
    expect(nodeOf(RX_REPLAY)?.type).toBe("receiver");
    expect(CORPUS).toContain("      receivers: [otlp, aws_s3/replay, awss3]\n");
  });
  it("receiver 5: keeps the nested downloader block and the time range", () => {
    const value = valueOf(RX_REPLAY, CORPUS);
    expect(value).toMatchObject({ starttime: "2024-01-01 01:00", endtime: "2024-01-02", s3downloader: { region: "us-west-1" } });
  });
  it("receiver 6: encodings are a list of extension/suffix maps, written as a block list", () => {
    expect(valueOf(RX_REPLAY, CORPUS).encodings).toEqual([{ extension: "text_encoding", suffix: ".txt" }]);
    expect(CORPUS).toContain("    encodings:\n      - extension: text_encoding\n        suffix: .txt\n");
  });
  // 7–8: the SQS round trip, by the corpus invariant; the instance name.
  it("receiver 7: parses into a recognized awss3 receiver with its instance name", () => {
    const node = nodeOf(RX_SQS);
    expect(node?.type).toBe("receiver");
    expect(node?.data.componentSubType).toBe("awss3");
    expect(node?.data.label).toBe("AWS S3 (sqs_traces)");
  });
  it("receiver 8: regenerates the same receiver config (opening and editing write only their lines; the corpus invariant)", () => {
    expect(valueOf(RX_SQS, CORPUS).sqs).toEqual({
      queue_url: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
      region: "us-east-1",
      wait_time_seconds: 10,
      max_number_of_messages: 5,
    });
  });
  // 9–10: receiver and exporter apart.
  it("receiver 9: keeps receiver and exporter apart by kind, with their own docs and forms", () => {
    expect(nodeOf(RX)?.type).toBe("receiver");
    expect(nodeOf(EX)?.type).toBe("exporter");
    expect(getComponentDocsUrl("receiver", "awss3")).not.toBe(getComponentDocsUrl("exporter", "awss3"));
    expect(formFor("receiver", "awss3")).not.toBe(formFor("exporter", "awss3"));
  });
  it("receiver 10: both sections stay in the text", () => {
    expect(valueOf(RX, CORPUS)).toMatchObject({ s3downloader: { s3_bucket: "archive" } });
    expect(valueOf(EX, CORPUS)).toMatchObject({ s3uploader: { s3_bucket: "databucket" } });
  });

  // awss3-exporter.test.ts 1–5.
  it("exporter 1: is registered in the palette with a us-east-1, ${env:} bucket and otlp_json seed", () => {
    const entry = findPaletteEntry("exporter", "awss3")!;
    expect(entry.label).toBe("AWS S3");
    const seed = entry.defaultConfig as Value;
    expect((seed.s3uploader as Value).region).toBe("us-east-1");
    expect((seed.s3uploader as Value).s3_bucket).toMatch(/^\$\{env:/);
    expect(seed.marshaler).toBe("otlp_json");
  });
  it("exporter 2: links to the contrib README", () => {
    expect(getComponentDocsUrl("exporter", "awss3")).toContain("exporter/awss3exporter");
  });
  it("exporter 3: parses into an exporter node with the full config", () => {
    expect(nodeOf(EX)?.type).toBe("exporter");
    expect(valueOf(EX, CORPUS)).toMatchObject({
      s3uploader: { region: "eu-central-1", s3_base_prefix: "environment/prod", unique_key_func_name: "uuidv7", retry_max_attempts: 5 },
      marshaler: "otlp_proto",
      resource_attrs_to_s3: { s3_prefix: "com.awss3.prefix" },
      retry_on_failure: { enabled: true },
    });
  });
  it("exporter 4: it is in all three pipelines", () => {
    const pipelines = (parseYaml(CORPUS) as { service: { pipelines: Record<string, { exporters: string[] }> } }).service.pipelines;
    for (const name of ["traces", "metrics", "logs"]) expect(pipelines[name]!.exporters).toContain("awss3");
  });
  it("exporter 5: survives the editor store: opening and an edit keep s3uploader (above), the corpus invariant keeps the rest", () => {
    openText(CORPUS);
    expect(text()).toBe(CORPUS);
    expect(valueOf(EX).s3uploader).toBeDefined();
  });

  // clickhouse-exporter.test.ts 1–4.
  it("clickhouse 1: is registered in the palette with a tcp:// endpoint and async_insert on", () => {
    const entry = findPaletteEntry("exporter", "clickhouse")!;
    expect(entry.label).toBe("ClickHouse");
    expect((entry.defaultConfig as Value).endpoint).toContain("tcp://");
    expect((entry.defaultConfig as Value).async_insert).toBe(true);
  });
  it("clickhouse 2: parses into an exporter node with the full config", () => {
    expect(nodeOf(CH)?.type).toBe("exporter");
    expect(valueOf(CH, CORPUS)).toMatchObject({
      endpoint: "tcp://clickhouse:9000?dial_timeout=10s",
      metrics_tables: { gauge: { name: "my_metrics_gauge" }, exponential_histogram: { name: "my_metrics_exp_histogram" } },
      table_engine: { name: "ReplicatedMergeTree" },
      tls: { insecure_skip_verify: true },
      create_schema: false,
    });
  });
  it("clickhouse 3: it is in the traces and logs pipelines", () => {
    const pipelines = (parseYaml(CORPUS) as { service: { pipelines: Record<string, { exporters: string[] }> } }).service.pipelines;
    expect(pipelines.traces!.exporters).toContain("clickhouse");
    expect(pipelines.logs!.exporters).toContain("clickhouse");
  });
  it("clickhouse 4: the store keeps metrics_tables; a form edit keeps the other tables (above)", () => {
    openText(CORPUS);
    expect(valueOf(CH).metrics_tables).toEqual({
      gauge: { name: "my_metrics_gauge" },
      exponential_histogram: { name: "my_metrics_exp_histogram" },
    });
  });
});
