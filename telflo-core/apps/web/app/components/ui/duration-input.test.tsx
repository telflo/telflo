import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DurationInput, isCollectorDuration } from "./duration-input.js";

const ERROR = "Invalid duration format. Use: 1ns, 1us, 1ms, 1s, 1m, or 1h";

describe("DurationInput (decision 4)", () => {
  it.each(["", "0", "+0", "-0", "1m30s", "1.5h", ".5s", "1.s", "300ms", "2h45m0.5s", "-5s", "1ns", "1us", "1µs", "1μs", "${env:TIMEOUT}", "${org:T}s"])(
    "the collector takes %j",
    (value) => {
      expect(isCollectorDuration(value)).toBe(true);
    },
  );

  it.each(["10", "abc", "1d", "5 s", "s", ".s", "1.5", "0s0", "1m30"])("the collector refuses %j", (value) => {
    expect(isCollectorDuration(value)).toBe(false);
  });

  it("shows its error only for what the collector refuses, and still hands the value on", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DurationInput aria-label="Timeout" value="1m30s" onChange={onChange} />);
    expect(screen.queryByText(ERROR)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Timeout" }), { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith("10");
    rerender(<DurationInput aria-label="Timeout" value="10" onChange={onChange} />);
    expect(screen.getByText(ERROR)).toHaveClass("text-xs", "text-fail", "mt-1");
    expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveClass("border-fail");

    fireEvent.change(screen.getByRole("textbox", { name: "Timeout" }), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    // The caller knows a plain integer in the text is nanoseconds.
    rerender(<DurationInput aria-label="Timeout" value="10" invalid={false} />);
    expect(screen.queryByText(ERROR)).toBeNull();
    rerender(<DurationInput aria-label="Timeout" value="5s" invalid />);
    expect(screen.getByText(ERROR)).toBeInTheDocument();
    rerender(<DurationInput aria-label="Timeout" />);
    expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveValue("");
  });
});
