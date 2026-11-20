import Editor from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button.js";
import { initMonaco } from "~/lib/editor/monaco-setup.js";
import { defineTelfloThemes } from "~/lib/editor/monaco-themes.js";
import { useAriaContainer } from "~/lib/editor/use-aria-container.js";
import { useEditorPreferences } from "~/lib/editor/use-editor-preferences.js";

interface SampleEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** "json" for OTLP inputs, "plaintext" for raw filelog or syslog lines; Monaco's controlled language. */
  language: "json" | "plaintext";
}

/**
 * The paste panel's writable Monaco. In detail:
 * - the person's theme and all four editor preferences, as every Monaco here
 *   (`useEditorPreferences`), the tab size on the model, not a fixed tab size
 *   of 2 with the minimap off. The themes are defined before mount;
 * - it mounts only once initMonaco() has resolved, as the YAML tab does: a
 *   mount before `loader.config` fetches Monaco from a CDN. "Loading
 *   editor…" until then; "The editor couldn't load." with "Try again" when it
 *   fails;
 * - JSON has its tokens only (initMonaco's mode configuration): no worker,
 *   no completion, no validation;
 * - replay: the sample is private text, so the editor sits in a
 *   `ph-no-capture` block, Monaco's screen-reader live region in the
 *   shell's one replay-blocked host (`useAriaContainer`), word-based
 *   suggestions off (each word would be a suggestion row's `aria-label`),
 *   and no `path` (Monaco writes it into a `data-uri` attribute).
 */
export function SampleEditor({ value, onChange, language }: SampleEditorProps) {
  const preferences = useEditorPreferences();
  const { ariaHost } = useAriaContainer();
  const [monacoStatus, setMonacoStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [monacoAttempt, setMonacoAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    initMonaco().then(
      () => current && setMonacoStatus("ready"),
      () => current && setMonacoStatus("failed"),
    );
    return () => {
      current = false;
    };
  }, [monacoAttempt]);

  return (
    <div className="h-full flex flex-col ph-no-capture">
      <div className="flex-1 min-h-0">
        {monacoStatus === "ready" ? (
          <Editor
            height="100%"
            language={language}
            value={value}
            onChange={(next) => onChange(next ?? "")}
            beforeMount={defineTelfloThemes}
            onMount={preferences.attach}
            theme={preferences.theme}
            options={{
              ...preferences.options,
              fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              fontLigatures: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              scrollbar: { vertical: "visible", horizontal: "visible" },
              wordWrap: "off",
              wordBasedSuggestions: "off",
              ...(ariaHost === null ? {} : { ariaContainerElement: ariaHost }),
            }}
          />
        ) : monacoStatus === "failed" ? (
          <div className="flex flex-col items-center justify-center gap-2.5 h-full text-[13px] text-muted-foreground">
            <p>The editor couldn't load.</p>
            <Button
              variant="outline"
              onClick={() => {
                setMonacoStatus("loading");
                setMonacoAttempt((attempt) => attempt + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">Loading editor…</div>
        )}
      </div>
    </div>
  );
}
