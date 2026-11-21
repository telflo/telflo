import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { toStored } from "~/lib/graph/stored-graph.js";
import type { EditorState } from "~/lib/stores/editor-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { usePlayground } from "./context.js";
import { NEW_CONFIGURATION_PIN, SAMPLE_DISTRIBUTION } from "./sample/types.js";
import { stagePlaygroundEdit } from "./staged-edit.js";

/*
 * The playground's Save: the playground editor's and the blank public
 * editor's Save button and Cmd/Ctrl+S. It stages the edit in this browser
 * (`stagePlaygroundEdit`), then:
 * - a signed-out visitor sees "Sign in to save" (the provider's
 *   `SignInToSaveDialog`): Sign in (`/login?redirectTo=/app`) or Create
 *   free account (`/register`);
 * - a signed-in one (this tab's user store holds them) goes to `/app`,
 *   where the handoff dialog opens. Without the store, they see
 *   the dialog too, and `/login` sends a signed-in person straight on.
 * The toasts are fixed words, never the configuration's name or text.
 */

/** The name a configuration without one is staged under. */
export const UNTITLED_CONFIGURATION_NAME = "Untitled configuration";

/** The toast when the create's schema would refuse the edit. */
export const SAVE_REFUSED_MESSAGE = "This configuration can't be saved: it's too large, or holds a character a configuration can't.";

/** The toast when this browser can't keep the edit. */
export const SAVE_UNAVAILABLE_MESSAGE = "This browser couldn't keep your configuration, so it can't be saved after you sign in.";

/** What Save reads from the editor store. */
export type PlaygroundSaveSource = Pick<EditorState, "configuration" | "text" | "graph" | "collectorVersion">;

/**
 * The Save action: call it with the editor store's state
 * (`save(useEditorStore.getState())`). Inside the playground only; outside
 * it does nothing.
 */
export function useStagePlaygroundSave(): (state: PlaygroundSaveSource) => void {
  const playground = usePlayground();
  const navigate = useNavigate();
  return useCallback(
    (state: PlaygroundSaveSource) => {
      if (playground === null) return;
      const name = state.configuration?.name.trim() || UNTITLED_CONFIGURATION_NAME;
      const result = stagePlaygroundEdit({
        name,
        yamlContent: state.text,
        ...toStored(state.graph),
        collectorDistribution: state.configuration?.collectorDistribution ?? SAMPLE_DISTRIBUTION,
        collectorVersion: state.collectorVersion ?? NEW_CONFIGURATION_PIN,
      });
      if (result === "refused") {
        toast.error(SAVE_REFUSED_MESSAGE);
        return;
      }
      if (result === "unavailable") {
        toast.error(SAVE_UNAVAILABLE_MESSAGE);
        return;
      }
      if (useUserStore.getState().current !== null) {
        void navigate("/app");
        return;
      }
      playground.openSignInToSave();
    },
    [playground, navigate],
  );
}
