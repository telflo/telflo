import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOpeningKey } from "./use-opening-key.js";

describe("useOpeningKey", () => {
  it("changes each time open turns true, and only then", () => {
    const { result, rerender } = renderHook(({ open }) => useOpeningKey(open), { initialProps: { open: false } });
    const closed = result.current;

    rerender({ open: true });
    const first = result.current;
    expect(first).not.toBe(closed);
    rerender({ open: true });
    expect(result.current).toBe(first);

    rerender({ open: false });
    expect(result.current).toBe(first);
    rerender({ open: true });
    expect(result.current).not.toBe(first);
  });
});
