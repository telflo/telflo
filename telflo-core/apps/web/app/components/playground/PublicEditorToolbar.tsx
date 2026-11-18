import { Link } from "react-router";
import { Rocket, Save } from "lucide-react";
import { EditorEditActions } from "~/components/editor/EditorEditActions.js";
import { Button } from "~/components/ui/button.js";
import { PUBLISH_TOOLTIP } from "~/lib/editor/publishing.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { PUBLISH_LOCKED_ACTION } from "./PlaygroundToolbar.js";
import { PlaygroundVersionPicker } from "./PlaygroundVersionPicker.js";

/*
 * The blank public editor's toolbar (D31-1 decisions 7, 28 and 38; Q210,
 * Preflight ruling 10), built on the playground toolbar's pieces. On the
 * left, the Telflo mark linking to sign-in (D36-1 decision 23: no home page
 * in the app; the public editor has no sidebar to hold it), the
 * configuration's name as text (no rename, no "Unsaved" badge) and the fixed
 * collector picker (`PlaygroundVersionPicker`: the pin, a change locked;
 * Q210). No version picker. On the right, under the editor tour's
 * `toolbar-actions` anchor: the shared edit actions (`EditorEditActions`),
 * Save, always enabled (it stages the edit and opens "Sign in to save":
 * `onSave`), and Publish, shown and locked, as the playground's (Ruling 276).
 * The name is text, never an attribute (ADR 0024).
 */
export function PublicEditorToolbar({ onSave }: { onSave: () => void }) {
  const name = useEditorStore((state) => state.configuration?.name ?? "");
  const locked = useLockedAction();

  return (
    <div className="h-12 bg-card border-b border-border px-3 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Link to="/login" className="flex shrink-0 items-center">
          <img src="/telflo-logo-dark.svg" alt="Telflo" className="h-5 w-auto dark:hidden" />
          <img src="/telflo-logo-full.svg" alt="Telflo" className="hidden h-5 w-auto dark:block" />
        </Link>
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
