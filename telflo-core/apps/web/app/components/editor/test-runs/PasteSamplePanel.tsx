import { TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH, testSampleFileName, type TestFile } from "@telflo/contracts";
import { WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { pickStrategyKind } from "~/lib/test-runs/fixture-shape.js";
import { failureMessage, sampleRefusal } from "~/lib/test-runs/messages.js";
import { SampleEditor } from "./SampleEditor.js";

interface PasteSamplePanelProps {
  organizationId: string;
  /** The signal of the pipeline chosen in the run dialog; null when there is none. */
  signalType: string | null;
  /** That pipeline's name in the text (`service.pipelines`' key), for its strategy. */
  pipelineName: string | null;
  /** The saved file, which the dialog then selects for the run. */
  onDone: (file: TestFile) => void;
  onCancel: () => void;
}

/**
 * Paste a sample instead of uploading a file (D14a decision 16). Saved, the
 * sample is a file in My Files like any upload, so it can be used again.
 *
 * Differences (the Parity Notes):
 * - no "Generate with AI" (ADR 0007);
 * - the editor's mode follows the target pipeline's strategy, narrowed to
 *   that pipeline (D14a Preflight ruling 14): JSON for OTLP, plain text for
 *   filelog and syslog, not every pipeline of the signal;
 * - the name's extension is checked before saving, as the size is
 *   (`sampleRefusal`): only the six, with the API's words;
 * - a refusal shows the API's words (`failureMessage`).
 *
 * The sample is private text (ADR 0024): it sits inside SampleEditor's
 * `ph-no-capture` block, and neither it nor its name reaches an attribute.
 * Rendered only while the dialog shows it, so it opens empty each time.
 */
export function PasteSamplePanel({ organizationId, signalType, pipelineName, onDone, onCancel }: PasteSamplePanelProps) {
  const saveSample = useTestingStore((state) => state.saveSample);
  const yamlText = useEditorStore((state) => state.text);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  // The tester's strategy for this pipeline: raw lines for a filelog or
  // syslog receiver (an operator test), an OTLP/JSON document otherwise.
  const strategy = useMemo(
    () => (signalType ? pickStrategyKind(yamlText, signalType, pipelineName) : "otlp"),
    [yamlText, signalType, pipelineName],
  );
  const rawMode = strategy !== "otlp";

  const handleFormat = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      toast.error("Content is not valid JSON");
    }
  };

  const canSave = !saving && name.trim().length > 0 && text.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    const displayName = name.trim();
    const format = rawMode ? "text" : "json";
    const refusal = sampleRefusal(text, testSampleFileName(displayName, format));
    if (refusal !== null) {
      toast.error(refusal);
      return;
    }
    setSaving(true);
    try {
      const file = await saveSample(organizationId, { displayName, text, format });
      toast.success("Sample saved to My Files");
      onDone(file);
    } catch (error) {
      const message = failureMessage(error, "Failed to save the sample");
      if (message !== null) toast.error(message);
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pb-2">
        <h3 className="text-sm font-semibold">Paste Test Sample</h3>
        {!rawMode && (
          <button
            type="button"
            onClick={handleFormat}
            disabled={saving || text.trim().length === 0}
            title="Format JSON"
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <WandSparkles className="w-3.5 h-3.5" />
            Format
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1 pb-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="paste-sample-name">
          Name
        </label>
        <input
          id="paste-sample-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
          maxLength={TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH}
          placeholder="Saved to My Files under this name"
          className="w-full min-w-0 px-3 py-1.5 text-[13px] rounded-md border border-input bg-transparent"
        />
      </div>

      <div className="flex-1 min-h-0 rounded-md border border-input overflow-hidden">
        <SampleEditor value={text} onChange={setText} language={rawMode ? "plaintext" : "json"} />
      </div>
      <p className="text-[11px] text-muted-foreground pt-1">
        {rawMode
          ? `Raw log lines (one record per line), as your ${strategy} receiver reads them from disk. Saved as a reusable file in My Files.`
          : `OTLP/JSON matching the pipeline's signal (${signalType ?? "select a pipeline"}). Saved as a reusable file in My Files.`}
      </p>

      <div className="flex justify-end gap-2 pt-3">
        <button
          onClick={onCancel}
          disabled={saving}
          className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
        >
          {saving ? "Saving…" : "Use Sample"}
        </button>
      </div>
    </div>
  );
}
