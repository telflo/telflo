import { Lock } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { CREATE_FROM_PUBLISHED_LABEL, publishedVersionMessage } from "~/lib/editor/publishing.js";
import { useCreateVersion } from "~/lib/editor/use-create-version.js";
import { selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * Above the canvas while the open version is published (D11b decision 4):
 * "Version {N} is published and can't be changed.", and one button, "Create
 * a new version from it", which is D10's create from the open version
 * (`useCreateVersion`): unnamed, no dialog, carrying the text on screen (a
 * stale tab's unsaved text included; Preflight ruling 12), and opening the
 * new version; its failures are D10's. The button is disabled while a save,
 * a create or a publish is under way. Nothing here is a label or a name:
 * the version is named by its number (ADR 0024; decision 14).
 */
export function PublishedVersionBanner() {
  const isPublished = useEditorStore(selectIsVersionPublished);
  const versionNumber = useEditorStore((state) => state.version?.versionNumber ?? null);
  const busy = useEditorStore((state) => state.isSaving || state.isCreatingVersion || state.isPublishing);
  const { createVersion } = useCreateVersion();

  if (!isPublished || versionNumber === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-brand/25 bg-brand-soft px-3 py-2 text-[13px] text-foreground">
      <Lock className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
      <p className="min-w-0 flex-1">{publishedVersionMessage(versionNumber)}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 text-xs"
        disabled={busy}
        onClick={() => void createVersion("")}
      >
        {CREATE_FROM_PUBLISHED_LABEL}
      </Button>
    </div>
  );
}
