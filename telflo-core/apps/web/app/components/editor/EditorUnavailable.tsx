import { AlertCircle, FileQuestion } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button.js";

/** Why there is no configuration to show; a failed load can be tried again, and an unknown version leads to the latest. */
type EditorUnavailableProps =
  | { reason: "not_found" }
  | { reason: "version_not_found"; configurationId: string }
  | { reason: "failed"; onRetry: () => void };

const MESSAGES: Record<EditorUnavailableProps["reason"], string> = {
  not_found: "Configuration not found",
  version_not_found: "Version not found",
  failed: "Failed to load configuration",
};

/**
 * What the editor shows when it has no configuration to open (D8 decision
 * 12), with "Back to configurations" (`/app`), never a toast alone with the
 * previous configuration left on screen.
 * - `not_found`: a 404 `configuration_not_found`, or an address whose id
 *   isn't a UUID: "Configuration not found".
 * - `version_not_found`: a 404 `configuration_version_not_found`, or an
 *   address whose version id isn't a UUID (D10 decision 9): "Version not
 *   found", with "Open the latest version", `/editor/{id}`, which opens the
 *   person's selection, else the newest. The previous version's canvas is
 *   never left on screen.
 * - `failed`: a load that failed otherwise, whose toast says the same:
 *   "Failed to load configuration", with "Try again".
 */
export function EditorUnavailable(props: EditorUnavailableProps) {
  const Icon = props.reason === "failed" ? AlertCircle : FileQuestion;
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center gap-2.5 text-center">
      <Icon className="h-5 w-5 text-muted-foreground" />
      <p className="text-[13px] text-muted-foreground">{MESSAGES[props.reason]}</p>
      <div className="flex items-center gap-2">
        {props.reason === "failed" && (
          <Button variant="outline" onClick={props.onRetry}>
            Try again
          </Button>
        )}
        {props.reason === "version_not_found" && (
          <Button variant="outline" asChild>
            <Link to={`/editor/${encodeURIComponent(props.configurationId)}`}>Open the latest version</Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to="/app">Back to configurations</Link>
        </Button>
      </div>
    </div>
  );
}
