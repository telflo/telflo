import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils.js";

/*
 * A form's collapsible section (ADR 0018; D9a Preflight ruling 19). D9a's
 * Configuration tab uses it for the collapsed "Advanced" section; D9b's
 * forms use the rest.
 */

interface ConfigSectionProps {
  title: string;
  /** Open on first render. Sections holding required fields must pass true. */
  defaultOpen?: boolean;
  /** Forces the section open while true (e.g. a validation error inside). */
  forceOpen?: boolean;
  /** Small right-aligned mono annotation, e.g. an active-item count. */
  count?: string | number;
  /** Override the default uppercase-mono title styling (e.g. for a path). */
  titleClassName?: string;
  children: ReactNode;
  className?: string;
}

/* Collapsible form section: hairline-separated, mono micro-label header.
 * Replaces the per-form tab bars — sections keep every group discoverable
 * by name at any panel width, where tabs collapsed into an unlabeled
 * dropdown below ~400px. */
export function ConfigSection({
  title,
  defaultOpen = false,
  forceOpen = false,
  count,
  titleClassName,
  children,
  className,
}: ConfigSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const isOpen = open || forceOpen;

  return (
    <div className={cn("border-t border-border", className)}>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        className="group flex h-9 w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", isOpen && "rotate-90")}
          />
          <span
            className={cn(
              "truncate font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors group-hover:text-foreground",
              titleClassName,
            )}
          >
            {title}
          </span>
        </span>
        {count !== undefined && count !== "" && count !== 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
        )}
      </button>
      {isOpen && <div className="space-y-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}
