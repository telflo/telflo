import { act, renderHook } from "@testing-library/react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";

import { computeTriggerState, useOrgVariableAutocomplete } from "./use-org-variable-autocomplete.js";
import type { OrgVariableName } from "~/lib/org-variables.js";

/* The picker's cases (D9b Parity Notes). */

describe("computeTriggerState", () => {
  const open = (value: string) => computeTriggerState(value, value.length);

  it("opens on a bare $", () => {
    expect(open("endpoint: $")).toMatchObject({ isOpen: true, filterText: "" });
  });

  it("stays open through ${", () => {
    expect(open("endpoint: ${")).toMatchObject({ isOpen: true, filterText: "" });
  });

  it("stays open through a partial scheme", () => {
    expect(open("endpoint: ${or")).toMatchObject({ isOpen: true, filterText: "" });
  });

  it("filters on the name after ${org:", () => {
    expect(open("endpoint: ${org:PR")).toMatchObject({ isOpen: true, filterText: "PR" });
  });

  it("filters on a bare query typed straight after $", () => {
    expect(open("endpoint: $PR")).toMatchObject({ isOpen: true, filterText: "PR" });
  });

  it("closes once the reference is complete", () => {
    expect(open("endpoint: ${org:PROD}")).toMatchObject({ isOpen: false });
  });

  it("closes on a character that cannot continue a reference", () => {
    expect(open("endpoint: $ ")).toMatchObject({ isOpen: false });
  });

  it("tracks the last $ rather than an earlier one", () => {
    const state = open("a: ${org:X} b: $PR");
    expect(state).toMatchObject({ isOpen: true, filterText: "PR" });
    expect(state.triggerIndex).toBe(15);
  });
});

// D20 (Q81): a row is a name and a description, never a value.
const PROD: OrgVariableName = { id: "v1", name: "PROD", description: "Prod OTLP endpoint" };
const STAGING: OrgVariableName = { id: "v2", name: "STAGING", description: "Staging endpoint" };
const REGION: OrgVariableName = { id: "v3", name: "REGION", description: null };

/**
 * Simulate the user typing `text` into the input, ending with the cursor at
 * the end. Drives the hook's `handleInputChange` exactly as the real
 * <input onChange> would, so the picker opens legitimately.
 */
function typeInto(
  result: { current: ReturnType<typeof useOrgVariableAutocomplete> },
  inputRef: { current: HTMLInputElement },
  text: string,
) {
  inputRef.current.value = text;
  act(() => {
    result.current.handleInputChange({
      target: { value: text, selectionStart: text.length },
    } as unknown as ChangeEvent<HTMLInputElement>);
  });
}

function setup(initialValue: string, items: readonly OrgVariableName[] = [PROD]) {
  let value = initialValue;
  const inputRef = { current: document.createElement("input") };
  const { result, rerender } = renderHook(() =>
    useOrgVariableAutocomplete({
      inputRef,
      value,
      onChange: (v) => {
        value = v;
      },
      items,
    }),
  );
  return {
    inputRef,
    result,
    rerender,
    getValue: () => value,
  };
}

describe("useOrgVariableAutocomplete handleSelect", () => {
  const cases: Array<[string, string]> = [
    ["endpoint: $", "endpoint: ${org:PROD}"],
    ["endpoint: $PR", "endpoint: ${org:PROD}"],
    ["endpoint: ${", "endpoint: ${org:PROD}"],
    ["endpoint: ${org:", "endpoint: ${org:PROD}"],
    ["endpoint: ${org:PR", "endpoint: ${org:PROD}"],
  ];

  it.each(cases)("splices %s into %s", (start, expected) => {
    const { inputRef, result, getValue } = setup(start);
    typeInto(result, inputRef, start);

    act(() => result.current.handleSelect(PROD));

    expect(getValue()).toBe(expected);
  });

  it("splices in place, leaving an earlier reference untouched", () => {
    const start = "a: ${org:X} b: $PR";
    const { inputRef, result, getValue } = setup(start);
    typeInto(result, inputRef, start);

    act(() => result.current.handleSelect(PROD));

    expect(getValue()).toBe("a: ${org:X} b: ${org:PROD}");
  });

  it("places the cursor right after the inserted }", async () => {
    const start = "endpoint: $";
    const { inputRef, result, getValue } = setup(start);
    typeInto(result, inputRef, start);

    act(() => result.current.handleSelect(PROD));
    // Mirror what the real <input> does: the component re-renders with the
    // new value before the hook's setTimeout callback runs.
    inputRef.current.value = getValue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const expected = "endpoint: ${org:PROD}".length;
    expect(inputRef.current.selectionStart).toBe(expected);
    expect(inputRef.current.selectionEnd).toBe(expected);
  });
});

describe("useOrgVariableAutocomplete handleSelectEnv", () => {
  it("inserts ${env:} in place of a verbatim-typed, unfinished reference", () => {
    const start = "endpoint: ${org:PR";
    const { inputRef, result, getValue } = setup(start);
    typeInto(result, inputRef, start);

    act(() => result.current.handleSelectEnv());

    expect(getValue()).toBe("endpoint: ${env:}");
  });

  it("places the cursor between : and }", async () => {
    const start = "endpoint: ${org:PR";
    const { inputRef, result, getValue } = setup(start);
    typeInto(result, inputRef, start);

    act(() => result.current.handleSelectEnv());
    inputRef.current.value = getValue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const expected = "endpoint: ${env:".length;
    expect(inputRef.current.selectionStart).toBe(expected);
    expect(inputRef.current.selectionEnd).toBe(expected);
  });
});

describe("useOrgVariableAutocomplete's keys (telflo)", () => {
  const key = (name: string) => {
    let prevented = false;
    return {
      event: { key: name, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent<HTMLInputElement>,
      prevented: () => prevented,
    };
  };

  it("never opens on mount, even for a value ending in $", () => {
    const { result } = setup("endpoint: $");
    expect(result.current.isOpen).toBe(false);
    const down = key("ArrowDown");
    act(() => result.current.handleKeyDown(down.event));
    expect(down.prevented()).toBe(false);
  });

  it("moves through the variables and the env row, wrapping both ways, and Enter picks", () => {
    const { inputRef, result, getValue } = setup("", [PROD, STAGING]);
    typeInto(result, inputRef, "$");
    expect(result.current.filteredItems).toEqual([PROD, STAGING]);

    act(() => result.current.handleKeyDown(key("ArrowUp").event));
    expect(result.current.highlightedIndex).toBe(2);
    act(() => result.current.handleKeyDown(key("ArrowDown").event));
    expect(result.current.highlightedIndex).toBe(0);
    act(() => result.current.handleKeyDown(key("ArrowDown").event));
    expect(result.current.highlightedIndex).toBe(1);
    act(() => result.current.handleKeyDown(key("ArrowUp").event));
    expect(result.current.highlightedIndex).toBe(0);

    const enter = key("Enter");
    act(() => result.current.handleKeyDown(enter.event));
    expect(enter.prevented()).toBe(true);
    expect(getValue()).toBe("${org:PROD}");
    expect(result.current.isOpen).toBe(false);
  });

  it("Enter on the env row inserts ${env:}", () => {
    const { inputRef, result, getValue } = setup("");
    typeInto(result, inputRef, "$");
    act(() => result.current.handleKeyDown(key("ArrowDown").event));
    act(() => result.current.handleKeyDown(key("Enter").event));
    expect(getValue()).toBe("${env:}");
  });

  it("filters by the name or the description, and keeps the highlight in range", () => {
    const { inputRef, result } = setup("", [PROD, STAGING]);
    typeInto(result, inputRef, "$");
    act(() => result.current.handleKeyDown(key("ArrowUp").event));
    expect(result.current.highlightedIndex).toBe(2);
    typeInto(result, inputRef, "$stag");
    expect(result.current.filteredItems).toEqual([STAGING]);
    typeInto(result, inputRef, "$endpoint");
    expect(result.current.filteredItems).toEqual([PROD, STAGING]);
    typeInto(result, inputRef, "${org:otlp");
    expect(result.current.filteredItems).toEqual([PROD]);
    typeInto(result, inputRef, "${org:nothing");
    expect(result.current.filteredItems).toEqual([]);
  });

  it("filters a row with no description by its name alone", () => {
    const { inputRef, result } = setup("", [PROD, REGION]);
    typeInto(result, inputRef, "$reg");
    expect(result.current.filteredItems).toEqual([REGION]);
    typeInto(result, inputRef, "$endpoint");
    expect(result.current.filteredItems).toEqual([PROD]);
  });

  it("clamps the highlight when a filter leaves fewer rows", () => {
    const { inputRef, result, rerender } = setup("", [PROD, STAGING]);
    typeInto(result, inputRef, "$");
    act(() => result.current.handleKeyDown(key("ArrowUp").event));
    expect(result.current.highlightedIndex).toBe(2);
    // A filter change with no input event (the list's own) still clamps.
    act(() => result.current.setHighlightedIndex(2));
    typeInto(result, inputRef, "$STAG");
    rerender();
    expect(result.current.highlightedIndex).toBeLessThanOrEqual(1);
  });

  it("Escape closes (its own key), Tab closes and lets focus move, and a closed picker ignores keys", () => {
    const { inputRef, result } = setup("");
    typeInto(result, inputRef, "$");
    const escape = key("Escape");
    act(() => result.current.handleKeyDown(escape.event));
    expect(escape.prevented()).toBe(true);
    expect(result.current.isOpen).toBe(false);

    typeInto(result, inputRef, "$");
    const tab = key("Tab");
    act(() => result.current.handleKeyDown(tab.event));
    expect(tab.prevented()).toBe(false);
    expect(result.current.isOpen).toBe(false);

    typeInto(result, inputRef, "$");
    const other = key("a");
    act(() => result.current.handleKeyDown(other.event));
    expect(result.current.isOpen).toBe(true);
  });

  it("a pick with no trigger does nothing", () => {
    const { result, getValue } = setup("x");
    act(() => result.current.handleSelectEnv());
    act(() => result.current.handleSelect(PROD));
    expect(getValue()).toBe("x");
  });
});
