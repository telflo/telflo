import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.js";
import { cn } from "~/lib/utils.js";

/*
 * A help popover, its icon lucide's `CircleHelp`.
 * `label` becomes the trigger's `aria-label` and `title`, so it is always
 * fixed text (the palette's "About <entry>"), never a person's content.
 */

interface HelpPopoverProps {
  label: string;
  title?: string;
  children: ReactNode;
  triggerClassName?: string;
  iconClassName?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

const DEFAULT_TRIGGER_CLASS =
  "inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors";

export function HelpPopover({
  label,
  title,
  children,
  triggerClassName,
  iconClassName = "w-4 h-4",
  contentClassName,
  align = "start",
  side,
}: HelpPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger aria-label={label} title={label} className={cn(triggerClassName ?? DEFAULT_TRIGGER_CLASS)}>
        <CircleHelp className={iconClassName} />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        {...(side ? { side } : {})}
        collisionPadding={8}
        className={cn("max-w-sm p-3", contentClassName)}
      >
        {title && <p className="text-[13px] font-medium text-foreground mb-1">{title}</p>}
        <div className="text-[13px] text-muted-foreground space-y-2">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
