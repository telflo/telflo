import type { CollectorValidationOutcome } from "~/lib/stores/editor-store.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/**
 * The collector validator's answer for exactly what is on screen now (the
 * open version, its text and its pin), as `useCollectorValidation` keeps it,
 * for the components that read `selectCollectorValidation`.
 */
export function answerValidation(outcome: CollectorValidationOutcome): void {
  const state = useEditorStore.getState();
  if (state.version === null) throw new Error("no version is open");
  state.setValidation({ versionId: state.version.id, text: state.text, collectorVersion: state.collectorVersion, outcome });
}

/** A component the collector refused, with a message echoing the text and a path, for the attribute scans. */
export const REFUSAL = {
  message: 'invalid keys: marker-message-9c2e "secret-in-text"',
  componentPath: "exporters::otlp/marker-path-4d1a",
};

/** Every attribute value under `root`, for checking none holds a message, a path or the text. */
export function attributeValues(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((element) => [...element.attributes].map((attribute) => attribute.value));
}
