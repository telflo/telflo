import type { ReactNode } from "react";

import { Label } from "~/components/ui/label.js";

/*
 * A form field: a label, the control, and a one-line hint. The
 * Configuration tab uses it for the instance name; the component forms for
 * every field.
 */

interface ConfigFieldProps {
  label: string;
  /** One short sentence beneath the control. Omit when the label says it all. */
  description?: string;
  /** The collector-side default, shown as `Default <value>` in the hint line.
   * Keep the control's placeholder showing the same value. */
  defaultValue?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}

export function ConfigField({ label, description, defaultValue, required, children, htmlFor }: ConfigFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="block truncate text-[13px] font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-fail">
            *
          </span>
        )}
      </Label>
      {children}
      {(description || defaultValue) && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {description}
          {defaultValue && (
            <>
              {description ? " · " : ""}Default <span className="font-mono">{defaultValue}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
