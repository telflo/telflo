import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MultiValueInput } from "./multi-value-input.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup(values: string[] = ["SECRET-ONE", "SECRET-TWO"]) {
  const onValueChange = vi.fn();
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <MultiValueInput
      label="Metadata Keys"
      id="metadata-keys"
      values={values}
      rowKeys={values.map((_value, index) => index)}
      onValueChange={onValueChange}
      onAdd={onAdd}
      onRemove={onRemove}
      placeholder="e.g. tenant.id"
      helpText="Batch separately per unique value of these keys."
      addButtonText="Add Metadata Key"
    />,
  );
  return { onValueChange, onAdd, onRemove, ...view };
}

describe("MultiValueInput", () => {
  it("shows its rows, fixed Remove labels and its add button and hint", () => {
    setup();
    expect(screen.getByText("Metadata Keys")).toHaveClass("text-[13px]", "font-medium");
    const rows = screen.getAllByPlaceholderText("e.g. tenant.id");
    expect(rows.map((row) => (row as HTMLInputElement).value)).toEqual(["SECRET-ONE", "SECRET-TWO"]);
    expect(rows[0]).toHaveAttribute("id", "metadata-keys");
    expect(rows[1]).not.toHaveAttribute("id");
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Add Metadata Key" })).toBeInTheDocument();
    expect(screen.getByText("Batch separately per unique value of these keys.")).toBeInTheDocument();

    const leaks = [...document.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => attribute.name !== "value" && attribute.value.includes("SECRET"))
        .map((attribute) => `${element.tagName}[${attribute.name}]`),
    );
    expect(leaks).toEqual([]);
  });

  it("hands back a row's typing once, after the pause, by index", () => {
    vi.useFakeTimers();
    const { onValueChange } = setup();
    const row = screen.getAllByPlaceholderText("e.g. tenant.id")[1]!;
    fireEvent.change(row, { target: { value: "SECRET-TW" } });
    act(() => vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS - 1));
    fireEvent.change(row, { target: { value: "SECRET-T" } });
    act(() => vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS - 1));
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(1, "SECRET-T");
  });

  it("adds and removes by index, writing a held row first", async () => {
    const user = userEvent.setup();
    const { onValueChange, onAdd, onRemove } = setup();
    fireEvent.change(screen.getAllByPlaceholderText("e.g. tenant.id")[0]!, { target: { value: "held" } });

    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(onValueChange).toHaveBeenCalledWith(0, "held");
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(onValueChange.mock.invocationCallOrder[0]).toBeLessThan(onRemove.mock.invocationCallOrder[0]!);

    await user.click(screen.getByRole("button", { name: "Add Metadata Key" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("shows only the add button with no values, and nothing works while disabled", () => {
    render(
      <MultiValueInput values={[]} rowKeys={[]} onValueChange={() => {}} onAdd={() => {}} onRemove={() => {}} disabled />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
