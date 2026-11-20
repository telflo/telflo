import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, NumberField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";

/*
 * The file storage extension's form, over the form's fields: each field writes
 * its own key; clearing a field removes it; 0 can be entered. Timeout and
 * Check Interval stay plain text fields.
 *
 * The collector's defaults (`extension/storage/filestorage`
 * `createDefaultConfig`, contrib v0.162.0) show while a key is unset:
 * timeout `1s`; `create_directory` false; compaction `on_start`,
 * `on_rebound` and `cleanup_on_start` false, `rebound_needed_threshold_mib`
 * 100, `rebound_trigger_threshold_mib` 10, `check_interval` 5s,
 * `max_transaction_size` 65536; `fsync` false.
 *
 * Changed: Create Directory shows off while unset, as the collector has it.
 * The compaction directory's default is the collector's
 * (`getDefaultDirectory()`, `/var/lib/otelcol/file_storage` outside Windows),
 * its hint and placeholder, not the "storage directory": the collector
 * doesn't follow `directory` there.
 *
 * The Compaction section's count is the keys the `compaction` block holds.
 */

export function FileStorageExtensionForm() {
  const form = useForm();
  const compaction = form.read(["compaction"]);
  const compactionCount = compaction.kind === "map" ? Object.keys(compaction.value).length : 0;

  return (
    <div className="space-y-4">
      <TextField
        path={["directory"]}
        id="file-storage-directory"
        label="Directory"
        description="Where storage files are written; must be writable by the collector."
        placeholder="/var/lib/otelcol/file_storage"
      />

      <TextField
        path={["timeout"]}
        id="file-storage-timeout"
        label="Timeout"
        defaultValue="1s"
        description="Max time to wait acquiring a file lock."
        placeholder="1s"
      />

      <CheckboxField
        path={["create_directory"]}
        id="file-storage-create-directory"
        label="Create Directory"
        defaultChecked={false}
      />

      <ConfigSection title="Compaction" count={compactionCount}>
        <TextField
          path={["compaction", "directory"]}
          id="file-storage-compaction-directory"
          label="Directory"
          defaultValue="/var/lib/otelcol/file_storage"
          description="Scratch space used while rewriting the database."
        />

        <CheckboxField
          path={["compaction", "on_start"]}
          id="file-storage-compact-on-start"
          label="Compact On Start"
          description="Run a one-time compaction at collector startup."
          defaultChecked={false}
        />

        <CheckboxField
          path={["compaction", "on_rebound"]}
          id="file-storage-compact-on-rebound"
          label="Compact On Rebound"
          description="Compact continuously when the database grows past the threshold."
          defaultChecked={false}
        />

        <NumberField
          path={["compaction", "rebound_needed_threshold_mib"]}
          id="file-storage-rebound-needed"
          label="Rebound Needed Threshold"
          defaultValue="100"
          description="Database size in MiB that triggers rebound compaction."
        />

        <NumberField
          path={["compaction", "rebound_trigger_threshold_mib"]}
          id="file-storage-rebound-trigger"
          label="Rebound Trigger Threshold"
          defaultValue="10"
          description="Free MiB required before another rebound compaction runs."
        />

        <TextField
          path={["compaction", "check_interval"]}
          id="file-storage-check-interval"
          label="Check Interval"
          defaultValue="5s"
          description="How often to check whether rebound compaction should run."
          placeholder="5s"
        />

        <NumberField
          path={["compaction", "max_transaction_size"]}
          id="file-storage-max-transaction"
          label="Max Transaction Size"
          defaultValue="65536"
          description="Items per compaction transaction; 0 for unlimited."
        />

        <CheckboxField
          path={["compaction", "cleanup_on_start"]}
          id="file-storage-cleanup-on-start"
          label="Cleanup On Start"
          description="Delete leftover temp files from interrupted compactions at startup."
          defaultChecked={false}
        />
      </ConfigSection>

      <ConfigSection title="Advanced: Durability">
        <CheckboxField
          path={["fsync"]}
          id="file-storage-fsync"
          label="Fsync"
          description="Flush every write to disk before returning."
          defaultChecked={false}
        />

        <InlineAlert variant="warn" title="Throughput cost">
          Fsync reduces write throughput. Enable it only when crash consistency is required.
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}
