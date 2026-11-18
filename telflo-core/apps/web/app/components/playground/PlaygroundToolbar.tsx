import { Rocket, Save } from "lucide-react";
import { EditorEditActions } from "~/components/editor/EditorEditActions.js";
import { Button } from "~/components/ui/button.js";
import { PUBLISH_TOOLTIP } from "~/lib/editor/publishing.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { PlaygroundVersionPicker } from "./PlaygroundVersionPicker.js";

/** The sign-up prompt's words for Publish. */
export const PUBLISH_LOCKED_ACTION = "publish a configuration so fleets can deploy it";

/*
 * The playground editor's toolbar (D31-1 decision 28; Ruling 276, Preflight
 * ruling 10): the signed-in EditorToolbar's look, cut to what a visitor
 * has. On the left, the configuration's name as text (no rename; no
 * "Unsaved" badge: nothing here saves) and the fixed collector picker
 * (`PlaygroundVersionPicker`: the pin, a change locked); no version picker.
 * On the right, under the editor tour's `toolbar-actions` anchor: the shared
 * edit actions (`EditorEditActions`: undo, redo, duplicate, delete, the same
 * DOM as the signed-in toolbar's), Save, always enabled (it stages the edit
 * and opens "Sign in to save": `onSave`), and Publish, shown and locked (the
 * sign-up prompt). Task 5's public editor toolbar is built on the same
 * pieces. The name is text, never an attribute (ADR 0024).
 */
export function PlaygroundToolbar({ onSave }: { onSave: () => void }) {
  const name = useEditorStore((state) => state.configuration?.name ?? "");
  const locked = useLockedAction();

  return (
    <div className="h-12 bg-card border-b border-border px-3 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <h1 id="configuration_name" className="min-w-0 max-w-[28vw] truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
          {name}
        </h1>
        <PlaygroundVersionPicker />
      </div>

      <div className="flex shrink-0 items-center gap-2" data-tour-step="toolbar-actions">
        <EditorEditActions />

        <div className="w-px h-5 bg-border" />

        <Button onClick={onSave} variant="default" size="sm" className="h-8 gap-2">
          <Save className="w-4 h-4" />
          Save
        </Button>
        <Button
          onClick={(event) => locked?.(PUBLISH_LOCKED_ACTION, event.currentTarget)}
          variant="default"
          size="sm"
          className="h-8 gap-2"
          title={PUBLISH_TOOLTIP}
        >
          <Rocket className="w-4 h-4" />
          Publish
        </Button>
      </div>
    </div>
  );
}
