import type { TestTemplate } from "@telflo/contracts";
import { Download, Eye, HelpCircle } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { getTestTemplateFile } from "~/lib/api-client.js";
import { downloadBlob } from "~/lib/download.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore, type SelectedTestTemplate } from "~/lib/stores/testing-store.js";
import { receiverTypeLabel, signalLabel } from "~/lib/test-templates/labels.js";
import { decodeFileText } from "~/lib/test-runs/json-format.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { FileViewerDialog } from "./FileViewerDialog.js";

interface TemplatesPanelProps {
  onDone: () => void;
  onCancel: () => void;
  onSelectTemplate: (template: SelectedTestTemplate) => void;
}

/** The filters' "Any": no filter. */
const ANY_VALUE = "__any__";

/** What the step says when the templates can't be read. */
export const TEMPLATES_LOAD_FAILED_MESSAGE = "Failed to load templates";

/** The distinct values `valueOf` gives the templates, sorted by their labels. */
function presentValues(templates: TestTemplate[], valueOf: (template: TestTemplate) => string, labelOf: (value: string) => string) {
  return [...new Set(templates.map(valueOf))].sort((left, right) => labelOf(left).localeCompare(labelOf(right)));
}

/**
 * The run dialog's and the definition dialog's Templates step: the
 * product-wide sample inputs, filtered by receiver type and signal, each
 * viewed, downloaded or picked. Highlight a row and OK picks it.
 *
 * Differences:
 * - read afresh each time the step shows (the store's `loadTemplates`),
 *   not once a session; a session that ended toasts
 *   nothing;
 * - receiver types show by their palette labels ("File Log"), the raw value
 *   as a fallback, in the filter and the details, and signals by their
 *   words ("Traces", "Logs", "Metrics"), not "traces"; each filter offers
 *   the values present, sorted by label; the filters are labelled
 *   (`aria-labelledby`);
 * - a download is the template's bytes, named by its original file name
 *   with its extension (not the display name without one),
 *   through a detached anchor (`downloadBlob`): the name never reaches the
 *   page, a URL or an attribute;
 * - no template name reaches an attribute: the Download, Show details and
 *   View contents buttons are named by hidden text, through
 *   `aria-labelledby`, never the name in an `aria-label`; their titles stay
 *   fixed words; the viewer is `ph-no-capture` (FileViewerDialog);
 * - in the playground, the sample's templates are listed and picked (read
 *   for the editor's organization, `loadTemplates`), and a template's View
 *   contents and Download open the sign-up prompt at their buttons
 *   (`useLockedAction`), never reaching signed-in routes.
 */
export function TemplatesPanel({ onDone, onCancel, onSelectTemplate }: TemplatesPanelProps) {
  const templates = useTestingStore((state) => state.templates);
  const templatesLoading = useTestingStore((state) => state.templatesLoading);
  const templatesLoaded = useTestingStore((state) => state.templatesLoaded);
  const loadTemplates = useTestingStore((state) => state.loadTemplates);
  const organizationId = useEditorStore((state) => state.organizationId);
  const locked = useLockedAction();
  const [receiverFilter, setReceiverFilter] = useState(ANY_VALUE);
  const [signalFilter, setSignalFilter] = useState(ANY_VALUE);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TestTemplate | null>(null);
  const idPrefix = useId();

  // Read afresh each time the step shows (it mounts).
  useEffect(() => {
    loadTemplates(organizationId).catch((error: unknown) => {
      if (failureMessage(error, "") !== null) toast.error(TEMPLATES_LOAD_FAILED_MESSAGE);
    });
  }, [loadTemplates, organizationId]);

  const receiverTypes = useMemo(() => presentValues(templates, (template) => template.receiverType, receiverTypeLabel), [templates]);
  const signals = useMemo(() => presentValues(templates, (template) => template.signal, signalLabel), [templates]);
  const filtered = useMemo(
    () =>
      templates.filter(
        (template) =>
          (receiverFilter === ANY_VALUE || template.receiverType === receiverFilter) &&
          (signalFilter === ANY_VALUE || template.signal === signalFilter),
      ),
    [templates, receiverFilter, signalFilter],
  );
  const highlighted = filtered.find((template) => template.id === highlightedId) ?? null;

  // A highlighted template the filters hide is no longer highlighted, so it
  // doesn't come back highlighted when they widen.
  useEffect(() => {
    if (highlightedId !== null && highlighted === null) setHighlightedId(null);
  }, [highlightedId, highlighted]);

  const viewingId = viewing?.id ?? null;
  const loadViewingText = useCallback(async () => {
    if (viewingId === null) throw new Error("No template selected");
    return decodeFileText(await getTestTemplateFile(viewingId));
  }, [viewingId]);

  const handleDownload = async (template: TestTemplate) => {
    setDownloadingId(template.id);
    try {
      const bytes = await getTestTemplateFile(template.id);
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), template.fileName);
    } catch (error) {
      if (failureMessage(error, "") !== null) toast.error(`Failed to download ${template.name}`, { className: "ph-no-capture" });
    } finally {
      setDownloadingId((current) => (current === template.id ? null : current));
    }
  };

  const handleOk = () => {
    if (highlighted === null) return;
    onSelectTemplate({ id: highlighted.id, name: highlighted.name });
    onDone();
  };

  const isLoading = templatesLoading && !templatesLoaded;
  const receiverLabelId = `${idPrefix}-receiver`;
  const signalLabelId = `${idPrefix}-signal`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-2 min-h-0">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span id={receiverLabelId} className="text-xs font-medium text-muted-foreground">
              Receiver Type
            </span>
            <Select value={receiverFilter} onValueChange={setReceiverFilter}>
              <SelectTrigger aria-labelledby={receiverLabelId}>
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Any</SelectItem>
                {receiverTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {receiverTypeLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span id={signalLabelId} className="text-xs font-medium text-muted-foreground">
              Signal Type
            </span>
            <Select value={signalFilter} onValueChange={setSignalFilter}>
              <SelectTrigger aria-labelledby={signalLabelId}>
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Any</SelectItem>
                {signals.map((signal) => (
                  <SelectItem key={signal} value={signal}>
                    {signalLabel(signal)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-6" role="status" aria-label="Loading templates">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-muted-foreground/25 border-t-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {templates.length === 0 ? "No templates available." : "No templates match the selected filters."}
          </p>
        ) : (
          <div className="rounded-md border border-border bg-card max-h-56 overflow-y-auto">
            <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 bg-muted/90 backdrop-blur-sm border-b border-border font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              <span>Name</span>
              <span className="w-6" aria-hidden />
              <span className="w-6" aria-hidden />
              <span className="w-6" aria-hidden />
            </div>
            <ul className="divide-y divide-border">
              {filtered.map((template) => {
                const isSelected = highlightedId === template.id;
                const downloadLabelId = `${idPrefix}-download-${template.id}`;
                const detailsLabelId = `${idPrefix}-details-${template.id}`;
                const viewLabelId = `${idPrefix}-view-${template.id}`;
                return (
                  <li
                    key={template.id}
                    className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 transition-colors border-l-2 ${
                      isSelected ? "bg-accent border-l-brand" : "border-l-transparent hover:bg-accent/50"
                    }`}
                  >
                    {/* The name in text, which replay masks, never in an attribute. */}
                    <span id={downloadLabelId} className="sr-only">
                      Download {template.name}
                    </span>
                    <span id={detailsLabelId} className="sr-only">
                      Show details for {template.name}
                    </span>
                    <span id={viewLabelId} className="sr-only">
                      View contents of {template.name}
                    </span>
                    <div
                      className="flex items-center gap-2 min-w-0 py-2 cursor-pointer"
                      onClick={() => setHighlightedId(template.id)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setHighlightedId(template.id);
                        }
                      }}
                    >
                      <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{template.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => (locked ? locked("download a template", event.currentTarget) : void handleDownload(template))}
                      disabled={downloadingId === template.id}
                      aria-labelledby={downloadLabelId}
                      title="Download"
                      className="p-1 text-muted-foreground hover:text-brand rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <Popover>
                      <PopoverTrigger
                        aria-labelledby={detailsLabelId}
                        title="Show details"
                        className="p-1 text-muted-foreground hover:text-brand rounded"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </PopoverTrigger>
                      <PopoverContent align="end" side="left" collisionPadding={8} className="max-w-sm p-3">
                        <p className="text-[13px] font-semibold text-foreground mb-1 break-words">{template.name}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-2">
                          <span>
                            <span className="uppercase tracking-wider">Receiver:</span>{" "}
                            <span className="font-mono text-foreground">{receiverTypeLabel(template.receiverType)}</span>
                          </span>
                          <span>
                            <span className="uppercase tracking-wider">Signal:</span>{" "}
                            <span className="font-mono text-foreground">{signalLabel(template.signal)}</span>
                          </span>
                        </div>
                        <p className="text-[13px] text-muted-foreground whitespace-pre-wrap">
                          {template.description.trim() ? template.description : "No description."}
                        </p>
                      </PopoverContent>
                    </Popover>
                    <button
                      type="button"
                      onClick={(event) => (locked ? locked("view a template's contents", event.currentTarget) : setViewing(template))}
                      aria-labelledby={viewLabelId}
                      title="View contents"
                      className="p-1 text-muted-foreground hover:text-brand rounded"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleOk}
          disabled={highlighted === null}
          className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
        >
          OK
        </button>
      </div>

      {viewing !== null && (
        <FileViewerDialog
          open
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          title={viewing.name}
          loadText={loadViewingText}
        />
      )}
    </div>
  );
}
