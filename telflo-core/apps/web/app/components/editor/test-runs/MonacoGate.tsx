import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button.js";
import { initMonaco } from "~/lib/editor/monaco-setup.js";

/**
 * Renders `children` (a Monaco editor) only once initMonaco() has resolved,
 * as the YAML tab and SampleEditor do: a mount before `loader.config`
 * fetches Monaco from a CDN. "Loading editor…" until then; "The editor
 * couldn't load." with "Try again" when it fails (SampleEditor's words).
 * The viewers and Compare share it.
 */
export function MonacoGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    initMonaco().then(
      () => current && setStatus("ready"),
      () => current && setStatus("failed"),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  if (status === "ready") return <>{children}</>;
  if (status === "failed") {
    return (
      <div className="flex flex-col items-center justify-center gap-2.5 h-full text-[13px] text-muted-foreground">
        <p>The editor couldn't load.</p>
        <Button
          variant="outline"
          onClick={() => {
            setStatus("loading");
            setAttempt((previous) => previous + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  return <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">Loading editor…</div>;
}
