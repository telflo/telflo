import * as React from "react";

import { Input } from "~/components/ui/input.js";
import { cn } from "~/lib/utils.js";

/*
 * A duration field. Its error shows only for what the collector refuses:
 * what Go's `time.ParseDuration` refuses, when the value holds no `${…}`
 * reference (the collector expands those first), so `1m30s`, `0`, `-5s`
 * and `${env:TIMEOUT}` pass. A value is still passed on when invalid, and
 * validity follows the value shown, not only the last keystroke.
 */

/** Go's `time.ParseDuration`: `0`, or signed number-and-unit runs (`1h30m`, `1.5h`, `.5s`, `300ms`). */
const GO_DURATION = /^[-+]?(?:0|(?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/;

/** Whether the collector takes `value` as a duration: empty (unset), a Go duration, or one holding a reference. */
export function isCollectorDuration(value: string): boolean {
  return value === "" || GO_DURATION.test(value) || value.includes("${");
}

export interface DurationInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value?: string | undefined;
  onChange?: ((value: string | undefined) => void) | undefined;
  /**
   * Whether the collector refuses the value, when the caller knows better
   * than the characters (a plain integer in the text is nanoseconds).
   * Omitted, the characters decide.
   */
  invalid?: boolean | undefined;
  /** The error shown for an invalid value, where the grammar isn't Go's (Prometheus' durations, say). */
  message?: string | undefined;
}

const DurationInput = React.forwardRef<HTMLInputElement, DurationInputProps>(
  ({ className, value, onChange, invalid, message, ...props }, ref) => {
    const isValid = invalid === undefined ? isCollectorDuration(value ?? "") : !invalid;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      if (onChange) {
        onChange(newValue || undefined);
      }
    };

    return (
      <div className="relative">
        <Input
          ref={ref}
          value={value || ""}
          onChange={handleChange}
          className={cn(className, !isValid && "border-fail focus-visible:border-fail focus-visible:ring-fail/25")}
          {...props}
        />
        {!isValid && (
          <p className="text-xs text-fail mt-1">{message ?? "Invalid duration format. Use: 1ns, 1us, 1ms, 1s, 1m, or 1h"}</p>
        )}
      </div>
    );
  },
);

DurationInput.displayName = "DurationInput";

export { DurationInput };
