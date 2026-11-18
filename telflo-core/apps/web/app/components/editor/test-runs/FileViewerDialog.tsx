import { Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { prettyPrint, toCanonicalFormat, type JsonFormat } from "~/lib/test-runs/json-format.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { TestFileViewer } from "./TestFileViewer.js";

interface FileViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog's title: fixed words, or a file's name as text (never an attribute). */
  title: ReactNode;
  /** Called when the dialog opens; resolves to the file's text. Must keep its identity while the file is the same. */
  loadText: () => Promise<string>;
  /** When given, a Download button on the footer's left. */
  onDownload?: () => void | Promise<void>;
}

/**
 * A test file, the run's text or its logs in a read-only viewer (D14a
 * decisions 22 and 23). JSON and
 * NDJSON are pretty-printed; Copy puts them back as they were (one compact
 * document a line for NDJSON, compact JSON for one document, the text as it
 * is otherwise). Differences:
 * - Copy says "Copied to clipboard" (else "Failed to copy to clipboard",
 *   the YAML tab's words) as it closes the dialog, never silently;
 * - a failure shows the API's words, else "Failed to load file", and a
 *   session that ended shows the fallback (the session-ended handler takes
 *   the browser to sign in);
 * - replay (ADR 0024): the whole dialog is `ph-no-capture`, the viewer's
 *   live region inside it (TestFileViewer); the title, which may be a file's
 *   name, is text only.
 */
export function FileViewerDialog({ open, onOpenChange, title, loadText, onDownload }: FileViewerDialogProps) {
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<JsonFormat>("raw");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    setFormat("raw");
    loadText()
      .then((text) => {
        if (cancelled) return;
        const result = prettyPrint(text);
        setContent(result.display);
        setFormat(result.format);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(failureMessage(caught, "Failed to load file") ?? "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadText]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toCanonicalFormat(content, format));
      toast.success("Copied to clipboard");
      onOpenChange(false);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const copyDisabled = loading || error !== null || content.length === 0;
  const copyTitle =
    format === "ndjson" ? "Copy as NDJSON (one compact object per line)" : format === "single" ? "Copy as compact JSON" : "Copy text";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl h-[85vh] flex flex-col ph-no-capture" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-border bg-muted/40">
          {loading ? (
            <div className="flex items-center justify-center py-16" role="status" aria-label="Loading file">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : error !== null ? (
            <p className="p-4 text-[13px] text-fail">{error}</p>
          ) : content ? (
            <TestFileViewer value={content} language={format === "raw" ? "plaintext" : "json"} className="h-full" />
          ) : (
            <p className="p-4 text-[13px] text-muted-foreground">(empty file)</p>
          )}
        </div>
        <DialogFooter>
          {onDownload && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onDownload()}
              disabled={copyDisabled}
              className="sm:mr-auto"
              title="Download file"
            >
              <Download className="w-4 h-4" />
              Download
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()} disabled={copyDisabled} title={copyTitle}>
            <Copy className="w-4 h-4" />
            Copy
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
