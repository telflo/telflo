import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { createOrgVariableReference, type OrgVariableName } from "~/lib/org-variables.js";

/*
 * The `$` picker of organization variables, with the pinned `${env:}` row.
 * Its rows come from `lib/org-variables.ts`'s one shared read: each a name
 * and its description, never a value. The typed filter matches either, and a
 * pick inserts `${org:NAME}`. A row is one name and a description.
 */

interface UseOrgVariableAutocompleteOptions {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** Full candidate list; filtered locally against the typed query. */
  items: readonly OrgVariableName[];
}

interface UseOrgVariableAutocompleteReturn {
  isOpen: boolean;
  filteredItems: readonly OrgVariableName[];
  highlightedIndex: number;
  /** True while the picker is open — the pinned `${env:}` row is always shown alongside the list. */
  showEnvRow: boolean;
  setHighlightedIndex: (index: number) => void;
  handleInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  handleSelect: (item: OrgVariableName) => void;
  handleSelectEnv: () => void;
  close: () => void;
}

interface TriggerState {
  isOpen: boolean;
  filterText: string;
  triggerIndex: number;
  /** End of the typed trigger span (i.e. the cursor position when it was computed). */
  triggerEnd: number;
}

const CLOSED_TRIGGER_STATE: TriggerState = {
  isOpen: false,
  filterText: "",
  triggerIndex: -1,
  triggerEnd: -1,
};

/** Prefixes of "${org:" that should keep the picker open while being typed. */
const PREFIXES = ["", "{", "{o", "{or", "{org", "{org:"];

/** What the pinned row inserts. */
const ENV_REFERENCE = "${env:}";

/**
 * Determines whether a live `$` reference is in progress just before
 * `cursorPos`, and what has been typed as the filter.
 *
 * The picker opens on a bare `$` and stays open while the user types toward
 * `${org:NAME}`, so both `$PROD` (shortcut) and `${org:PROD` (verbatim) filter
 * on "PROD". It closes as soon as the text can no longer become a reference,
 * or once a `}` completes one.
 */
export function computeTriggerState(value: string, cursorPos: number): TriggerState {
  const before = value.slice(0, cursorPos);
  const dollar = before.lastIndexOf("$");
  if (dollar < 0) return CLOSED_TRIGGER_STATE;

  const after = value.slice(dollar + 1, cursorPos);

  // A completed reference closes the picker.
  if (after.includes("}")) return CLOSED_TRIGGER_STATE;

  // Typing toward "${org:" — no filter yet.
  if (PREFIXES.includes(after)) {
    return { isOpen: true, filterText: "", triggerIndex: dollar, triggerEnd: cursorPos };
  }

  // "${org:NAME" — filter on NAME.
  if (after.startsWith("{org:")) {
    const query = after.slice("{org:".length);
    if (!/^[A-Za-z0-9_]*$/.test(query)) return CLOSED_TRIGGER_STATE;
    return { isOpen: true, filterText: query, triggerIndex: dollar, triggerEnd: cursorPos };
  }

  // "$NAME" shortcut — filter on NAME.
  if (/^[A-Za-z0-9_]+$/.test(after)) {
    return { isOpen: true, filterText: after, triggerIndex: dollar, triggerEnd: cursorPos };
  }

  return CLOSED_TRIGGER_STATE;
}

/**
 * `$` autocomplete for org variables, with a pinned `${env:}` row. The env
 * row is treated as one extra item past the end of `filteredItems` for
 * keyboard navigation purposes.
 */
export function useOrgVariableAutocomplete({
  inputRef,
  value,
  onChange,
  items,
}: UseOrgVariableAutocompleteOptions): UseOrgVariableAutocompleteReturn {
  // Always starts CLOSED and only opens in response to an explicit input
  // event (handleInputChange) — a value that already ends in a bare `$query`
  // must NOT auto-open the picker on mount.
  const [triggerState, setTriggerState] = useState<TriggerState>(CLOSED_TRIGGER_STATE);
  const { isOpen, filterText, triggerIndex, triggerEnd } = triggerState;
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const filteredItems = useMemo(() => {
    if (!filterText) return items;
    const lowerQuery = filterText.toLowerCase();
    return items.filter(
      (v) => v.name.toLowerCase().includes(lowerQuery) || (v.description?.toLowerCase().includes(lowerQuery) ?? false),
    );
  }, [items, filterText]);

  // The env row is always shown, one slot past the last variable.
  const optionCount = filteredItems.length + 1;

  // Reset highlight when filter changes
  const prevFilterRef = useRef(filterText);
  if (prevFilterRef.current !== filterText) {
    prevFilterRef.current = filterText;
    if (highlightedIndex >= optionCount) {
      setHighlightedIndex(Math.max(0, optionCount - 1));
    }
  }

  const close = useCallback(() => {
    setTriggerState(CLOSED_TRIGGER_STATE);
    setHighlightedIndex(0);
  }, []);

  /** Puts `insert` in place of the typed trigger, the cursor `cursorFromEnd` characters before its end. */
  const splice = useCallback(
    (insert: string, cursorFromEnd: number) => {
      if (triggerIndex < 0) return;
      const beforeTrigger = value.slice(0, triggerIndex);
      const afterTrigger = value.slice(triggerEnd);
      onChange(`${beforeTrigger}${insert}${afterTrigger}`);
      close();
      const cursor = triggerIndex + insert.length - cursorFromEnd;
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(cursor, cursor);
          inputRef.current.focus();
        }
      }, 0);
    },
    [triggerIndex, triggerEnd, value, onChange, close, inputRef],
  );

  const handleSelect = useCallback(
    (item: OrgVariableName) => splice(createOrgVariableReference(item.name), 0),
    [splice],
  );

  // The cursor lands between ':' and '}'.
  const handleSelectEnv = useCallback(() => splice(ENV_REFERENCE, 1), [splice]);

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart ?? newValue.length;

      onChange(newValue);
      setTriggerState(computeTriggerState(newValue, cursorPos));
      setHighlightedIndex(0);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev < optionCount - 1 ? prev + 1 : 0));
          break;

        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : optionCount - 1));
          break;

        case "Enter": {
          e.preventDefault();
          const item = filteredItems[highlightedIndex];
          if (highlightedIndex === filteredItems.length) {
            handleSelectEnv();
          } else if (item) {
            handleSelect(item);
          }
          break;
        }

        case "Escape":
          e.preventDefault();
          close();
          break;

        case "Tab":
          close();
          break;
      }
    },
    [isOpen, optionCount, filteredItems, highlightedIndex, handleSelect, handleSelectEnv, close],
  );

  return {
    isOpen,
    filteredItems,
    highlightedIndex,
    showEnvRow: isOpen,
    setHighlightedIndex,
    handleInputChange,
    handleKeyDown,
    handleSelect,
    handleSelectEnv,
    close,
  };
}
