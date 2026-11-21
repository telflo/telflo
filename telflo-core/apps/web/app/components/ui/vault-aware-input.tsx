import * as React from "react";
import { VARIABLES_UNAVAILABLE_MESSAGE } from "@telflo/contracts";

import { Input } from "~/components/ui/input.js";
import { MentionDropdown } from "~/components/ui/mention-dropdown.js";
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover.js";
import { useOrgVariableAutocomplete } from "~/lib/hooks/use-org-variable-autocomplete.js";
import { useOrgVariables } from "~/lib/org-variables.js";
import { cn } from "~/lib/utils.js";

/*
 * An input with the `$` picker of organization variables and the pinned
 * `${env:}` row. Its rows are the active organization's variables' names and
 * descriptions, from `lib/org-variables.ts`'s one shared read: ten inputs on a
 * page read them once. While that read is under way the picker says "Loading
 * organization variables..." above the env row (shown meanwhile, so what Enter
 * picks is visible); a failed read says so, above the env row, and the
 * picker's next opening reads again. A pick inserts `${org:NAME}`; the
 * `${env:}` row stays pinned below the list.
 *
 * The caller's handlers are composed with the picker's, so a caller's
 * `onKeyDown` never switches the picker's keys off and a caller's `onBlur`
 * never replaces its closing: the picker handles a key first, and a key it
 * consumes (arrows, Enter, Escape while open) doesn't reach the caller, so
 * Enter picks a row rather than committing the field; every other key,
 * Cmd/Ctrl+S among them, reaches the caller. The caller's `onBlur` runs unless
 * focus moved into the picker (a row being clicked; the input takes focus
 * back). A forwarded ref may be a callback; the cursor placement holds then
 * too.
 *
 * The picker's rows are text inside a Radix popover in `<body>`, which the
 * signed-in layout masks; the popover is also `ph-no-capture` (its names
 * and descriptions are configuration text shown in a field's dropdown, so
 * replay records nothing of them).
 *
 * The delayed close's timer is cleared when the input unmounts (one
 * left running after a test's teardown can fail a unit-suite run).
 */

/**
 * What a change reports: the input's text (what a caller would read from
 * `e.target.value`). A picked row changes the text without a DOM event, so
 * this is the text alone, not a `ChangeEvent`.
 */
export interface VaultAwareChange {
  target: { value: string };
  currentTarget: { value: string };
}

/**
 * The picker's words when the organization's variables couldn't be read: the
 * family's, the variables routes' and Validate's 503 words. Its "Try again"
 * is the picker's next opening, which reads again.
 */
export const ORG_VARIABLES_UNREAD_MESSAGE = VARIABLES_UNAVAILABLE_MESSAGE;

export type VaultAwareInputProps = Omit<React.ComponentProps<"input">, "onChange"> & {
  onChange?: ((change: VaultAwareChange) => void) | undefined;
};

const VaultAwareInput = React.forwardRef<HTMLInputElement, VaultAwareInputProps>(
  ({ className, value, onChange, onKeyDown, onBlur, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const stringValue = value != null ? String(value) : "";
    const [localValue, setLocalValue] = React.useState(stringValue);

    React.useEffect(() => {
      setLocalValue(value != null ? String(value) : "");
    }, [value]);

    const handleChange = React.useCallback(
      (newValue: string) => {
        setLocalValue(newValue);
        onChange?.({ target: { value: newValue }, currentTarget: { value: newValue } });
      },
      [onChange],
    );

    const orgVariables = useOrgVariables();
    const autocomplete = useOrgVariableAutocomplete({
      inputRef,
      value: localValue,
      onChange: handleChange,
      items: orgVariables.names,
    });
    const isOpen = autocomplete.isOpen;

    // A picker opening after a failed read, or with names a minute old, reads them again (the rows stay meanwhile).
    const { refresh } = orgVariables;
    React.useEffect(() => {
      if (isOpen) refresh();
    }, [isOpen, refresh]);

    // The delayed close goes with the input: a timer left after an unmount would set state on nothing (and, in the
    // unit suite, run after the test's DOM is gone).
    const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(closeTimer.current), []);

    return (
      <Popover open={isOpen} onOpenChange={(open) => !open && autocomplete.close()}>
        <PopoverAnchor asChild>
          <Input
            {...props}
            ref={setRefs}
            className={className}
            value={localValue}
            onChange={autocomplete.handleInputChange}
            onKeyDown={(e) => {
              if (isOpen) autocomplete.handleKeyDown(e);
              if (!e.defaultPrevented) onKeyDown?.(e);
            }}
            onBlur={(e) => {
              // relatedTarget must be read synchronously — inside the timeout
              // the event is stale (e.currentTarget is null).
              if (e.relatedTarget && contentRef.current?.contains(e.relatedTarget)) {
                return; // focus moved into the dropdown; let the click land
              }
              // Some browsers don't focus buttons on mousedown (relatedTarget
              // is null mid-click), so fall back to a short delay.
              clearTimeout(closeTimer.current);
              closeTimer.current = setTimeout(() => {
                if (!contentRef.current?.contains(document.activeElement)) {
                  autocomplete.close();
                }
              }, 150);
              onBlur?.(e);
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          ref={contentRef}
          className="ph-no-capture w-64 p-0 max-h-60 overflow-auto"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          {isOpen && (
            <>
              {orgVariables.loading ? (
                <div className="p-3 text-center text-sm text-muted-foreground">Loading organization variables...</div>
              ) : orgVariables.failed ? (
                <div className="p-3 text-center text-sm text-muted-foreground">{ORG_VARIABLES_UNREAD_MESSAGE}</div>
              ) : (
                <MentionDropdown
                  sigil="$"
                  items={autocomplete.filteredItems}
                  highlightedIndex={autocomplete.highlightedIndex}
                  onSelect={autocomplete.handleSelect}
                  onHighlight={autocomplete.setHighlightedIndex}
                  renderLabel={(v) => `\${org:${v.name}}`}
                  emptyMessage="No matching variables"
                />
              )}
              <button
                type="button"
                className={cn(
                  "w-full border-t border-border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  autocomplete.highlightedIndex === autocomplete.filteredItems.length && "bg-accent",
                )}
                onClick={autocomplete.handleSelectEnv}
                onMouseEnter={() => autocomplete.setHighlightedIndex(autocomplete.filteredItems.length)}
              >
                <span className="font-mono text-xs text-foreground">{"${env:}"}</span>
                <span className="ml-2 text-xs text-muted-foreground">Environment variable</span>
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
    );
  },
);

VaultAwareInput.displayName = "VaultAwareInput";

export { VaultAwareInput };
