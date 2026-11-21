import { useEffect, useState } from "react";
import { toast } from "sonner";

/** How long the button reads "Copied" after a copy. */
export const COPIED_FOR_MS = 2_000;

/** `YamlEditor.tsx`'s words for a copy the browser refused. */
export const COPY_FAILED_MESSAGE = "Failed to copy to clipboard";

/**
 * Copies `text` to the clipboard (`copy`), and whether the latest copy reads
 * "Copied" (`copied`): for 2 s, a second copy within them starting the 2 s
 * again. A clipboard the browser refuses toasts "Failed to copy to
 * clipboard", never the error or the text. The secret's box
 * (`SecretCopyBox`) uses it.
 */
export function useCopiedText(text: string): { copied: boolean; copy: () => Promise<void> } {
  // Which copy reads "Copied" (null: none): each copy is a new one, so its 2 s start again.
  const [copiedCount, setCopiedCount] = useState<number | null>(null);

  useEffect(() => {
    if (copiedCount === null) return;
    const timer = setTimeout(() => setCopiedCount(null), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copiedCount]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCount((count) => (count ?? 0) + 1);
    } catch {
      toast.error(COPY_FAILED_MESSAGE);
    }
  };

  return { copied: copiedCount !== null, copy };
}
