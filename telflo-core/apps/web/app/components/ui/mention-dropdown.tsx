import { FileText } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils.js";

/*
 * The rows of VaultAwareInput's `$` picker (ADR 0018). Rows are text; nothing
 * a row shows is an attribute (D9b decision 10; D20 decision 39). A row is a
 * variable's name over its description (D20 Q81: one name and a description);
 * a row with no description shows the name alone.
 */

interface MentionItem {
  id: string;
  name: string;
  description: string | null;
}

interface MentionDropdownProps<T extends MentionItem> {
  items: readonly T[];
  highlightedIndex: number;
  onSelect: (item: T) => void;
  onHighlight: (index: number) => void;
  /** Trigger character rendered before the name. */
  sigil: string;
  /** Optional override for the primary label; defaults to `${sigil}{name}`. */
  renderLabel?: (item: T) => React.ReactNode;
  emptyMessage?: string;
  icon?: React.ComponentType<{ className?: string }>;
}

/**
 * Dropdown for the `$` org-variable picker in `VaultAwareInput`. Renders the
 * filtered org-variable list; the caller appends a pinned `${env:}` row of
 * its own below it.
 */
export function MentionDropdown<T extends MentionItem>({
  items,
  highlightedIndex,
  onSelect,
  onHighlight,
  sigil,
  renderLabel,
  emptyMessage = "No matching items",
  icon: Icon = FileText,
}: MentionDropdownProps<T>) {
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  React.useEffect(() => {
    const el = itemRefs.current[highlightedIndex];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  if (items.length === 0) {
    return <div className="p-3 text-center text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div className="py-1">
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          className={cn(
            "w-full px-3 py-2 text-left text-sm transition-colors",
            "hover:bg-accent",
            index === highlightedIndex && "bg-accent",
          )}
          onClick={() => onSelect(item)}
          onMouseEnter={() => onHighlight(index)}
        >
          <div className="flex items-center gap-2">
            <Icon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="font-mono text-xs text-foreground">
              {renderLabel ? (
                renderLabel(item)
              ) : (
                <>
                  {sigil}
                  {"{"}
                  {item.name}
                  {"}"}
                </>
              )}
            </span>
          </div>
          {item.description !== null && <div className="text-xs text-muted-foreground mt-0.5 ml-5">{item.description}</div>}
        </button>
      ))}
    </div>
  );
}
