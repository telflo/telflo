import type { ConfigurationValidationError, ConfigurationValidationRequirement } from "@telflo/contracts";
import { ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { componentPositions, type EditorPosition } from "~/lib/editor/component-position.js";
import { selectCollectorValidation, useEditorStore } from "~/lib/stores/editor-store.js";

/** The bar's texts (D13b decisions 4 and 14). */
export const VALIDATING_TEXT = "validating config…";
export const UNAVAILABLE_TEXT = "validation unavailable · config not checked";

export function validText(collectorVersion: string): string {
  return `config valid · v${collectorVersion}`;
}

export function errorsText(count: number, collectorVersion: string): string {
  return `${count} ${count === 1 ? "error" : "errors"} · v${collectorVersion}`;
}

export function retiredText(collectorVersion: string): string {
  return `not checked · v${collectorVersion} is retired — pick an offered version to check this config`;
}

/** The playground's 429 (D31-1 decision 3): the seconds left until it checks again, counting down. */
export function checkingPausedText(seconds: number): string {
  return `Checking paused — try again in ${seconds} s`;
}

/**
 * The whole seconds from now until `retryAt` (epoch ms), at least 1, read
 * again every second while it is set; null when it isn't.
 */
function useSecondsUntil(retryAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [retryAt]);
  if (retryAt === undefined) return null;
  return Math.max(1, Math.ceil((retryAt - now) / 1000));
}

export function requirementsText(count: number): string {
  return `${count} deployment ${count === 1 ? "requirement" : "requirements"}`;
}

const ROW_CLASS = "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px]";
const TOGGLE_CLASS = `${ROW_CLASS} text-left transition-colors hover:bg-accent/60`;

/**
 * The collector validator's status bar, under the YAML editor (D13b
 * decisions 3, 4, 7 and 14), for the text
 * on screen (`selectCollectorValidation`). Nothing while idle; then
 * `validating config…` with a spinner, `config valid · v0.162.0`,
 * `{n} error(s) · v0.162.0` with a chevron and its list collapsed until
 * clicked, amber `validation unavailable · config not checked` with the
 * reason beneath (the playground's 429: "Checking paused — try again in N
 * s", counting down; D31-1 decision 3), or amber `not checked · v… is
 * retired — …`. The
 * requirements row, collapsible, shows with a valid answer and an invalid
 * one alike; requirements are never errors.
 *
 * Each error row is `{componentPath}: {message}`. A row whose path names a
 * key in the text on screen (`componentPositions`) is a button that puts
 * Monaco's cursor there (`onJump`); any other row is plain text.
 *
 * It sits inside the YAML tab's replay-blocked container (`ph-no-capture`).
 * The messages echo the configuration's values, so no attribute here holds
 * a message, a path or any text of the configuration (ADR 0024: replay
 * can't mask attributes): they are text, and every button's name is its
 * text. The unavailable reason is never in a `title`.
 */
export function ValidationStatus({ onJump }: { onJump: (position: EditorPosition) => void }) {
  const validation = useEditorStore(selectCollectorValidation);
  const text = useEditorStore((state) => state.text);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [requirementsExpanded, setRequirementsExpanded] = useState(false);
  const pausedFor = useSecondsUntil(validation.status === "unavailable" ? validation.retryAt : undefined);

  if (validation.status === "idle") return null;

  const requirements: ConfigurationValidationRequirement[] =
    validation.status === "valid" || validation.status === "invalid" ? validation.requirements : [];

  return (
    <div className="shrink-0 border-t border-border bg-muted/40">
      {validation.status === "validating" && (
        <div className={ROW_CLASS}>
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">{VALIDATING_TEXT}</span>
        </div>
      )}

      {validation.status === "valid" && (
        <div className={ROW_CLASS}>
          <span className="tf-dot bg-ok" />
          <span className="text-ok">{validText(validation.collectorVersion)}</span>
        </div>
      )}

      {validation.status === "unavailable" && (
        <>
          <div className={ROW_CLASS}>
            <span className="tf-dot bg-warn" />
            <span className="text-warn">{UNAVAILABLE_TEXT}</span>
          </div>
          {/* Why: always shown, it's what to do ("retry shortly"). */}
          <div className="px-3 pb-2">
            <div className="rounded-[4px] border border-warn/25 bg-warn-soft px-2 py-1.5 text-xs text-warn">
              {pausedFor === null ? validation.message : checkingPausedText(pausedFor)}
            </div>
          </div>
        </>
      )}

      {validation.status === "retired" && (
        <div className={ROW_CLASS}>
          <span className="tf-dot bg-warn" />
          <span className="text-warn">{retiredText(validation.collectorVersion)}</span>
        </div>
      )}

      {validation.status === "invalid" && (
        <>
          <button
            type="button"
            onClick={() => setErrorsExpanded((expanded) => !expanded)}
            aria-expanded={errorsExpanded}
            className={TOGGLE_CLASS}
          >
            <span className="tf-dot bg-fail" />
            <span className="text-fail">{errorsText(validation.errors.length, validation.collectorVersion)}</span>
            {errorsExpanded ? (
              <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          {errorsExpanded && <ErrorRows text={text} errors={validation.errors} onJump={onJump} />}
        </>
      )}

      {requirements.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setRequirementsExpanded((expanded) => !expanded)}
            aria-expanded={requirementsExpanded}
            className={TOGGLE_CLASS}
          >
            <Info className="h-3 w-3 text-warn" />
            <span className="text-warn">{requirementsText(requirements.length)}</span>
            {requirementsExpanded ? (
              <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          {requirementsExpanded && (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto px-3 pb-2">
              {requirements.map((requirement, index) => (
                <li key={index} className="rounded-[4px] border border-warn/25 bg-warn-soft px-2 py-1.5 text-xs">
                  <div className="mb-0.5 font-medium text-warn">{requirement.title}</div>
                  <div className="text-warn/90">{requirement.description}</div>
                  {requirement.componentPath !== null && (
                    <div className="mt-1 font-mono text-[10px] text-warn/70">{requirement.componentPath}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The errors' list: a row that names a key in the text jumps to it. The text is parsed once per answer. */
function ErrorRows({
  text,
  errors,
  onJump,
}: {
  text: string;
  errors: ConfigurationValidationError[];
  onJump: (position: EditorPosition) => void;
}) {
  const positionOf = useMemo(() => componentPositions(text), [text]);
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto px-3 pb-2">
      {errors.map((error, index) => {
        const position = positionOf(error.componentPath);
        const content = (
          <>
            {error.componentPath !== null && (
              <>
                <span className="font-mono font-medium text-fail">{error.componentPath}:</span>{" "}
              </>
            )}
            <span className="text-fail">{error.message}</span>
          </>
        );
        return (
          <li key={index} className="rounded-[4px] border border-fail/25 bg-fail-soft text-xs">
            {position === null ? (
              <div className="px-2 py-1.5">{content}</div>
            ) : (
              <button
                type="button"
                onClick={() => onJump(position)}
                className="block w-full px-2 py-1.5 text-left transition-colors hover:bg-fail/10"
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
