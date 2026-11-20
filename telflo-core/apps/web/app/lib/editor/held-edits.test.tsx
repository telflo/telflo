import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushHeldEdits, useHeldEdit } from "./held-edits.js";
import { hasHeldEdits } from "~/test/held-edits.js";

/*
 * Held edits: what a field holds that
 * the store doesn't have yet is written before the page saves and when the
 * field goes, and closing the tab asks while any is held.
 */

/** A field holding `draft` until it writes it into `written`. */
function Field({ written, initial = null }: { written: string[]; initial?: string | null }) {
  const [draft, setDraft] = useState<string | null>(initial);
  const flush = () => {
    if (draft === null) return;
    written.push(draft);
    setDraft(null);
  };
  useHeldEdit(draft !== null, flush);
  return (
    <input aria-label="field" value={draft ?? ""} onChange={(event) => setDraft(event.target.value)} />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("held edits", () => {
  it("closing the tab asks while any field holds an edit, through one listener, and stops once each is written", () => {
    const listen = vi.spyOn(window, "addEventListener");
    const written: string[] = [];
    const view = render(
      <>
        <Field written={written} initial="a" />
        <Field written={written} initial="b" />
        <Field written={written} />
      </>,
    );

    expect(hasHeldEdits()).toBe(true);
    expect(listen.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);

    act(() => flushHeldEdits());

    expect(written.sort()).toEqual(["a", "b"]);
    expect(hasHeldEdits()).toBe(false);
    view.unmount();
  });

  it("flushing writes each held edit once; a field holding none writes nothing", () => {
    const written: string[] = [];
    const view = render(<Field written={written} />);

    act(() => flushHeldEdits());
    expect(hasHeldEdits()).toBe(false);
    view.unmount();
    expect(written).toEqual([]);

    const held = render(<Field written={written} initial="x" />);
    act(() => flushHeldEdits());
    act(() => flushHeldEdits());
    expect(written).toEqual(["x"]);
    held.unmount();
    expect(written).toEqual(["x"]);
  });

  it("a flush that throws doesn't stop the others, is released, and its error surfaces after them", () => {
    const written: string[] = [];
    const failure = new Error("the field's flush failed");
    const flushes: string[] = [];
    function Throwing({ name }: { name: string }) {
      useHeldEdit(true, () => {
        flushes.push(name);
        throw name === "first" ? failure : new Error("a later failure");
      });
      return null;
    }
    const view = render(
      <>
        <Throwing name="first" />
        <Field written={written} initial="kept" />
        <Throwing name="second" />
      </>,
    );
    expect(hasHeldEdits()).toBe(true);

    let thrown: unknown = null;
    act(() => {
      try {
        flushHeldEdits();
      } catch (error) {
        thrown = error;
      }
    });

    // Every held edit was flushed, the one after the throw included; the first error is the one surfaced.
    expect(flushes).toEqual(["first", "second"]);
    expect(written).toEqual(["kept"]);
    expect(thrown).toBe(failure);
    // The throwing fields no longer hold, so nothing keeps the unload guard armed, and a save flushes cleanly.
    expect(hasHeldEdits()).toBe(false);
    expect(() => flushHeldEdits()).not.toThrow();
    expect(flushes).toEqual(["first", "second"]);
    // Their own flush when they go still runs, as for any field.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      view.unmount();
    } catch {
      // React reports a throwing cleanup; the registry is what matters here.
    }
    expect(hasHeldEdits()).toBe(false);
  });

  it("a field whose flush leaves it holding (a refused write) keeps guarding", () => {
    function Refused() {
      useHeldEdit(true, () => undefined);
      return null;
    }
    const view = render(<Refused />);
    act(() => flushHeldEdits());
    expect(hasHeldEdits()).toBe(true);
    view.unmount();
    expect(hasHeldEdits()).toBe(false);
  });

  it("a field that goes (a section collapsing, another node selected) writes what it holds, and no longer guards", () => {
    const written: string[] = [];
    const view = render(<Field written={written} initial="kept" />);
    expect(hasHeldEdits()).toBe(true);

    view.unmount();

    expect(written).toEqual(["kept"]);
    expect(hasHeldEdits()).toBe(false);
  });
});
