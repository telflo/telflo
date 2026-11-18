import type { ReactNode } from "react";

import { cn } from "~/lib/utils.js";

type InlineAlertVariant = "info" | "warn" | "fail";

interface InlineAlertProps {
  variant?: InlineAlertVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

const boxStyles: Record<InlineAlertVariant, string> = {
  info: "border-border bg-muted/50",
  warn: "border-warn/25 bg-warn-soft",
  fail: "border-fail/25 bg-fail-soft",
};

const titleStyles: Record<InlineAlertVariant, string> = {
  info: "text-foreground",
  warn: "text-warn",
  fail: "text-fail",
};

const bodyStyles: Record<InlineAlertVariant, string> = {
  info: "text-muted-foreground",
  warn: "text-warn",
  fail: "text-fail",
};

/* The one sanctioned callout box for config forms. `info` is for essential
 * context that a field hint can't carry — keep it RARE so it stays noticed;
 * `warn`/`fail` sit adjacent to the field that triggered them. */
export function InlineAlert({ variant = "info", title, children, className }: InlineAlertProps) {
  return (
    <div className={cn("rounded-md border px-3 py-2", boxStyles[variant], className)}>
      {title && <p className={cn("text-xs font-medium", titleStyles[variant])}>{title}</p>}
      <div className={cn("text-xs", title && "mt-1", bodyStyles[variant])}>{children}</div>
    </div>
  );
}
