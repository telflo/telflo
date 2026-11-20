import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MentionDropdown } from "./mention-dropdown.js";

/* The rows: a variable's name over its description, each row text only. */

const ITEMS = [
  { id: "v1", name: "PROD", description: "Prod OTLP endpoint" },
  { id: "v2", name: "STAGING", description: "Staging endpoint" },
  { id: "v3", name: "REGION", description: null },
];

describe("MentionDropdown", () => {
  it("shows its empty message with no items", () => {
    render(<MentionDropdown sigil="$" items={[]} highlightedIndex={0} onSelect={() => {}} onHighlight={() => {}} />);
    expect(screen.getByText("No matching items")).toHaveClass("p-3", "text-center");
  });

  it("lists each item's reference and name, highlights one, and picks on click", () => {
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    const { rerender } = render(
      <MentionDropdown sigil="$" items={ITEMS} highlightedIndex={1} onSelect={onSelect} onHighlight={onHighlight} />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual(["${PROD}Prod OTLP endpoint", "${STAGING}Staging endpoint", "${REGION}"]);
    expect(rows[1]).toHaveClass("bg-accent");
    expect(rows[0]).not.toHaveClass("bg-accent");

    fireEvent.mouseEnter(rows[0]!);
    expect(onHighlight).toHaveBeenCalledWith(0);
    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);

    rerender(
      <MentionDropdown
        sigil="$"
        items={ITEMS}
        highlightedIndex={0}
        onSelect={onSelect}
        onHighlight={onHighlight}
        renderLabel={(item) => `\${org:${item.name}}`}
      />,
    );
    expect(screen.getByText("${org:PROD}")).toHaveClass("font-mono");
    const leaks = [...document.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].filter((attribute) => /PROD|Staging|REGION/.test(attribute.value)).map((attribute) => attribute.name),
    );
    expect(leaks).toEqual([]);
  });
});
