import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

describe("Tooltip", () => {
  it("renders its content as text, in a portal in <body>, with its classes", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Apply</TooltipTrigger>
          <TooltipContent className="max-w-xs">Why it can't apply</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const content = (await screen.findAllByText("Why it can't apply")).find((el) => el.classList.contains("z-50"))!;
    expect(content).toHaveClass("rounded-[4px]", "bg-primary", "text-xs", "max-w-xs");
    expect(content.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(document.body);
  });
});
