import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormScope,
  NumberField,
  SelectField,
  TextField,
  useForm,
  type FormSource,
  type SelectOption,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { isTruthy } from "./shared/counts.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The AWS S3 exporter's form, over the form's fields: each field writes its
 * own key, the uploader's under `s3uploader`. Collector claims are contrib
 * v0.162.0's `exporter/awss3exporter`.
 *
 * - The Sending Queue shows off while `sending_queue` is absent: the
 *   exporter's queue is `configoptional.Default` (`factory.go:51`), off
 *   unless the block is in the text. `absentMeans: "off-optional"`: ticking
 *   writes `SendingQueueSection`'s block, unticking removes it. Retry is on
 *   by default (`configretry.NewDefaultBackOffConfig`, `factory.go:66`), as
 *   `RetryConfigSection` shows it.
 * - The selects remove their keys at the collector's defaults: Storage
 *   Class `STANDARD` (`factory.go:60`), SDK Retry Mode `standard`
 *   (`factory.go:61`), Compression None; Unique Key Segment and Canned ACL
 *   have unset options ("Random integer", "None (do not set)", the sentinel
 *   `__unset__`, never written). Unset, each shows the default as its
 *   placeholder.
 * - Storage Class offers the collector's 15 (`config.go:112-115, 133-135`,
 *   the AWS SDK's `StorageClass.Values()`): STANDARD through
 *   EXPRESS_ONEZONE, then FSX_OPENZFS, FSX_ONTAP, AWS_BACKUP_WARM and
 *   AWS_BACKUP_LOW_COST_WARM.
 * - Partition Timezone's placeholder is `Local`, the default
 *   (`s3_writer.go:94-103`), not `UTC`.
 * - Dynamic Routing's two fields sit in a pruning scope on
 *   `resource_attrs_to_s3` (the block goes when emptied); the Logs-only alert
 *   (the marshaler only has a logs marshaler, `marshaler.go:57-66`) and the
 *   credentials alert.
 * - Region and Bucket cleared remove their keys (`region: ""` is refused,
 *   `config.go:126-128`).
 *
 * Ids are fixed; option values are the collector's names, never a value
 * from the text.
 */

const MARSHALERS: readonly SelectOption[] = [
  { value: "otlp_json", label: "OTLP JSON (.json)" },
  { value: "otlp_proto", label: "OTLP Protobuf (.binpb)" },
  { value: "sumo_ic", label: "Sumo Logic Installed Collector archive (logs only)" },
  { value: "body", label: "Log body as text (logs only)" },
];

/** The collector's storage classes (`config.go:112-115`; AWS SDK s3 v1.113.1 `enums.go:1556-1574`). */
export const STORAGE_CLASSES = [
  "STANDARD",
  "REDUCED_REDUNDANCY",
  "STANDARD_IA",
  "ONEZONE_IA",
  "INTELLIGENT_TIERING",
  "GLACIER",
  "DEEP_ARCHIVE",
  "OUTPOSTS",
  "GLACIER_IR",
  "SNOW",
  "EXPRESS_ONEZONE",
  "FSX_OPENZFS",
  "FSX_ONTAP",
  "AWS_BACKUP_WARM",
  "AWS_BACKUP_LOW_COST_WARM",
] as const;

const ACLS = [
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
  "aws-exec-read",
  "bucket-owner-read",
  "bucket-owner-full-control",
] as const;

const UPLOADER: ValuePath = ["s3uploader"];
const at = (key: string): ValuePath => [...UPLOADER, key];

/** A value set: not unset or `""`. */
function isSet(form: FormSource, path: ValuePath): boolean {
  const view = form.read(path);
  return view.kind !== "absent" && !(view.kind === "scalar" && view.value === "");
}

const options = (values: readonly string[]): SelectOption[] => values.map((value) => ({ value, label: value }));

export function AWSS3ExporterForm() {
  const form = useForm();
  const endpoint = form.read(at("endpoint"));
  const hasEndpoint = endpoint.kind === "scalar" && String(endpoint.value).trim() !== "";
  const marshalerView = form.read(["marshaler"]);
  const marshaler = marshalerView.kind === "scalar" ? String(marshalerView.value) : "otlp_json";
  const logsOnlyMarshaler = marshaler === "sumo_ic" || marshaler === "body";
  // A select at the collector's default removes its key.
  const selectRemoving = (key: string, unset: string) => (value: string) => {
    if (value === unset) form.remove(at(key));
    else form.set(at(key), value);
  };

  const layoutCount = ["s3_partition_format", "s3_partition_timezone", "file_prefix", "storage_class", "acl", "unique_key_func_name"].filter(
    (key) => isSet(form, at(key)),
  ).length;
  const dynamicCount = ["s3_bucket", "s3_prefix"].filter((key) => isTruthy(form.read(["resource_attrs_to_s3", key]))).length;

  return (
    <div className="space-y-4">
      <TextField
        path={at("region")}
        id="awss3-region"
        label="Region"
        required
        defaultValue="us-east-1"
        description="AWS region of the bucket. Required even with a custom endpoint."
      />

      <TextField
        path={at("s3_bucket")}
        id="awss3-bucket"
        label="Bucket"
        required={!hasEndpoint}
        description="Target bucket. Required unless a custom endpoint is set."
        placeholder="e.g. ${env:AWS_S3_BUCKET}"
      />

      <TextField
        path={at("s3_prefix")}
        id="awss3-prefix"
        label="Prefix"
        description="Key prefix under the base prefix (a folder inside the bucket). Can be overridden per resource — see Dynamic Routing."
        placeholder="e.g. telemetry"
      />

      <TextField
        path={at("s3_base_prefix")}
        id="awss3-base-prefix"
        label="Base Prefix"
        description="Root prefix applied to every object and never overridden by resource attributes (e.g. environment/prod)."
        placeholder="e.g. environment/prod"
      />

      <InlineAlert variant="info" title="Credentials">
        Taken from the AWS SDK default chain — <span className="font-mono">AWS_ACCESS_KEY_ID</span>
        {" / "}
        <span className="font-mono">AWS_SECRET_ACCESS_KEY</span> env vars, an instance or task role, IRSA, or a shared config
        profile. They are never part of this configuration.
      </InlineAlert>

      <ConfigSection title="Format & Compression">
        <SelectField
          path={["marshaler"]}
          id="awss3-marshaler"
          label="Marshaler"
          defaultValue="otlp_json"
          description="Object format. Ignored when an encoding extension is set."
          options={MARSHALERS}
        />

        {logsOnlyMarshaler && (
          <InlineAlert variant="warn" title="Logs only">
            The <span className="font-mono">{marshaler}</span> marshaler only supports logs pipelines.
            {marshaler === "sumo_ic" &&
              " Records also need _sourceCategory, _sourceHost and _sourceName resource attributes (add them with a resource processor)."}
          </InlineAlert>
        )}

        <SelectField
          path={at("compression")}
          id="awss3-compression"
          label="Compression"
          defaultValue="none"
          description="Compress each object before upload. zstd needs a collector of v0.142 or newer."
          options={[
            { value: "none", label: "None" },
            { value: "gzip", label: "gzip" },
            { value: "zstd", label: "zstd" },
          ]}
          onSelect={selectRemoving("compression", "none")}
        />

        <TextField
          path={["encoding"]}
          id="awss3-encoding"
          label="Encoding Extension"
          description="Id of an encoding extension (e.g. text_encoding) that marshals the data instead of the built-in marshaler."
          placeholder="e.g. text_encoding"
        />

        <TextField
          path={["encoding_file_extension"]}
          id="awss3-encoding-ext"
          label="Encoding File Extension"
          description="Suffix appended to object keys when an encoding extension is used. Leave empty for none."
          placeholder="e.g. txt"
        />
      </ConfigSection>

      <ConfigSection title="Object Layout" count={layoutCount}>
        <TextField
          path={at("s3_partition_format")}
          id="awss3-partition-format"
          label="Partition Format"
          defaultValue="year=%Y/month=%m/day=%d/hour=%H/minute=%M"
          description="strftime layout for the time-based part of the key."
          className="font-mono text-xs"
        />

        <TextField
          path={at("s3_partition_timezone")}
          id="awss3-partition-tz"
          label="Partition Timezone"
          defaultValue="Local"
          description="IANA zone used to format the partition, e.g. UTC or Europe/London."
        />

        <TextField
          path={at("file_prefix")}
          id="awss3-file-prefix"
          label="File Prefix"
          description="Prefix for the object file name, before the unique segment."
          placeholder="e.g. otel-"
        />

        <SelectField
          path={at("unique_key_func_name")}
          id="awss3-unique-key"
          label="Unique Key Segment"
          defaultValue="random integer"
          description="How the collision-avoiding part of the object name is generated. UUIDv7 keys sort by creation time."
          unsetOption={{ label: "Random integer" }}
          options={[{ value: "uuidv7", label: "UUIDv7" }]}
        />

        <SelectField
          path={at("storage_class")}
          id="awss3-storage-class"
          label="Storage Class"
          defaultValue="STANDARD"
          options={options(STORAGE_CLASSES)}
          itemClassName="font-mono text-xs"
          onSelect={selectRemoving("storage_class", "STANDARD")}
        />

        <SelectField
          path={at("acl")}
          id="awss3-acl"
          label="Canned ACL"
          defaultValue="none"
          description="Object ACL header. Leave unset on buckets with ACLs disabled (the AWS default), or uploads fail."
          unsetOption={{ label: "None (do not set)" }}
          options={options(ACLS)}
          itemClassName="font-mono text-xs"
        />
      </ConfigSection>

      <ConfigSection title="Dynamic Routing" count={dynamicCount}>
        <FormScope path={["resource_attrs_to_s3"]} prune>
          <TextField
            path={["s3_bucket"]}
            id="awss3-attr-bucket"
            label="Bucket From Resource Attribute"
            description="Resource attribute whose value replaces the bucket when present; falls back to the bucket above."
            placeholder="e.g. com.awss3.bucket"
            className="font-mono text-xs"
          />

          <TextField
            path={["s3_prefix"]}
            id="awss3-attr-prefix"
            label="Prefix From Resource Attribute"
            description="Resource attribute whose value replaces the prefix (not the base prefix) when present."
            placeholder="e.g. com.awss3.prefix"
            className="font-mono text-xs"
          />
        </FormScope>
      </ConfigSection>

      <ConfigSection title="Connection">
        <TextField
          path={at("endpoint")}
          id="awss3-endpoint"
          label="Endpoint"
          description="S3 REST endpoint override for MinIO, LocalStack, or VPC endpoints. Replaces the endpoint built from region and bucket."
          placeholder="e.g. http://minio:9000"
        />

        <TextField
          path={at("role_arn")}
          id="awss3-role-arn"
          label="Role ARN"
          description="IAM role assumed before uploading (cross-account buckets)."
          placeholder="arn:aws:iam::123456789012:role/otel-s3-writer"
          className="font-mono text-xs"
        />

        <CheckboxField
          path={at("s3_force_path_style")}
          id="awss3-force-path-style"
          label="Force Path-Style Addressing"
          description="Use bucket-in-path URLs. Needed by most S3-compatible stores."
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-sm"
        />

        <CheckboxField
          path={at("disable_ssl")}
          id="awss3-disable-ssl"
          label="Disable SSL"
          description="Talk plain HTTP to the endpoint. Local testing only."
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-sm"
        />

        <SelectField
          path={at("retry_mode")}
          id="awss3-retry-mode"
          label="SDK Retry Mode"
          defaultValue="standard"
          description="AWS SDK request retryer. nop disables SDK retries entirely (the exporter retry below still applies)."
          options={[
            { value: "standard", label: "Standard" },
            { value: "adaptive", label: "Adaptive (client-side rate limiting)" },
            { value: "nop", label: "None" },
          ]}
          onSelect={selectRemoving("retry_mode", "standard")}
        />

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            path={at("retry_max_attempts")}
            id="awss3-retry-attempts"
            label="SDK Max Attempts"
            defaultValue="3"
            description="0 retries until success or a non-retryable error."
          />

          <DurationField path={at("retry_max_backoff")} id="awss3-retry-backoff" label="SDK Max Backoff" defaultValue="20s" />
        </div>
      </ConfigSection>

      <ConfigSection title="Timeout, Retry & Queue">
        <DurationField
          path={["timeout"]}
          id="awss3-timeout"
          label="Timeout"
          defaultValue="5s"
          description="Per-upload deadline. Raise it for large batches or slow links."
        />

        <RetryConfigSection path={["retry_on_failure"]} />
        <p className="text-[11px] leading-4 text-muted-foreground">
          Exporter-level retry (retry_on_failure) needs a collector of v0.151 or newer; older versions only have the SDK retry
          above.
        </p>

        <SendingQueueSection path={["sending_queue"]} showBatchSettings={true} absentMeans="off-optional" />
      </ConfigSection>
    </div>
  );
}
