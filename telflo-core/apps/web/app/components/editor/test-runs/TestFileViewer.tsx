import Editor from "@monaco-editor/react";
import { defineTelfloThemes } from "~/lib/editor/monaco-themes.js";
import { useAriaContainer } from "~/lib/editor/use-aria-container.js";
import { useEditorPreferences } from "~/lib/editor/use-editor-preferences.js";
import { MonacoGate } from "./MonacoGate.js";

interface TestFileViewerProps {
  value: string;
  /** "json" for a JSON or NDJSON file (pretty-printed), "plaintext" for anything else. */
  language: "json" | "plaintext";
  className?: string;
}

/**
 * A read-only Monaco for a test file, the run's text or its logs (D14a
 * decisions 22 and 23). Differences:
 * - the person's theme and all four editor preferences, as every Monaco
 *   here (`useEditorPreferences`; D21 decisions 27 and 28), the tab size
 *   setting how wide a tab character shows; the themes are defined before
 *   mount (Preflight ruling 14), not Monaco's own themes;
 * - it mounts once initMonaco() has resolved (MonacoGate);
 * - JSON has its tokens only (initMonaco's mode configuration): no worker;
 * - replay (ADR 0024): the text is private, so the editor sits in a
 *   `ph-no-capture` block, Monaco's screen-reader live region in the
 *   shell's one replay-blocked host (`useAriaContainer`, Ruling 48),
 *   word-based suggestions off, and no `path` (Monaco writes it into
 *   a `data-uri` attribute).
 */
export function TestFileViewer({ value, language, className }: TestFileViewerProps) {
  const preferences = useEditorPreferences();
  const { ariaHost } = useAriaContainer();

  return (
    <div className={`${className ?? "h-full"} flex flex-col ph-no-capture`}>
      <div className="flex-1 min-h-0">
        <MonacoGate>
          <Editor
            height="100%"
            language={language}
            value={value}
            beforeMount={defineTelfloThemes}
            onMount={preferences.attach}
            theme={preferences.theme}
            options={{
              readOnly: true,
              ...preferences.options,
              fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              fontLigatures: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              scrollbar: { vertical: "visible", horizontal: "visible" },
              renderValidationDecorations: "off",
              wordBasedSuggestions: "off",
              ...(ariaHost === null ? {} : { ariaContainerElement: ariaHost }),
            }}
          />
        </MonacoGate>
      </div>
    </div>
  );
}
