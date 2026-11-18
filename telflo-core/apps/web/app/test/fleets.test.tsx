import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { TOOLTIP_TRIGGERS, anyStateHolds, expectNoAttributeHoldsInOpenTooltips, expectTextOnlyInsideNoCapture } from "./fleets.js";

/**
 * The tooltip canaries' own test (D17b-1 Preflight ruling 15): the
 * collectors grid puts a Radix checkbox and a Select trigger beside its
 * tooltips, and each carries `data-state` and is focusable, but opens no
 * tooltip.
 */
describe("expectNoAttributeHoldsInOpenTooltips", () => {
  function renderControls() {
    return render(
      <TooltipProvider delayDuration={0}>
        <Checkbox aria-label="Select all on this page" />
        <Select defaultValue="all">
          <SelectTrigger aria-label="Filter by group">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All groups</SelectItem>
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>In sync</span>
          </TooltipTrigger>
          <TooltipContent>in sync: running its target configuration</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
  }

  it("opens the tooltips alone, passing over a checkbox and a Select trigger that carry data-state", async () => {
    const { container } = renderControls();
    const checkbox = container.querySelector('[role="checkbox"]');
    const trigger = container.querySelector('[role="combobox"]');
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(trigger).toHaveAttribute("data-state", "closed");
    expect((checkbox as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    expect((trigger as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);

    expect(checkbox!.matches(TOOLTIP_TRIGGERS)).toBe(false);
    expect(trigger!.matches(TOOLTIP_TRIGGERS)).toBe(false);
    expect(await expectNoAttributeHoldsInOpenTooltips("canary-name-7c2e", container)).toBe(1);
  });

  it("fails when an open tooltip leaves the text in an attribute", async () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>web-01</span>
          </TooltipTrigger>
          <TooltipContent title="canary-name-7c2e">seen</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await expect(expectNoAttributeHoldsInOpenTooltips("canary-name-7c2e", container)).rejects.toThrow();
  });
});

/** The bearer canary's own test (D17b-2 Preflight ruling 15): text only inside `ph-no-capture`. */
describe("expectTextOnlyInsideNoCapture", () => {
  const BEARER = "tfr_bearer-canary-41d9";

  it("passes, counting the text nodes, when every one holding the text is inside ph-no-capture, however deep", () => {
    render(
      <div>
        <p>Rotate token</p>
        <div className="ph-no-capture">
          <code>{BEARER}</code>
          <span>
            <span>Copy {BEARER}</span>
          </span>
        </div>
      </div>,
    );
    expect(expectTextOnlyInsideNoCapture(BEARER)).toBe(2);
  });

  it("fails when the text is nowhere on the page, or only split across text nodes: nothing was there to prove", () => {
    expect(() => expectTextOnlyInsideNoCapture("not-on-the-page")).toThrow();
    render(
      <div className="ph-no-capture">
        <code>
          {"tfr_bearer-"}
          {"canary-41d9"}
        </code>
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
  });

  it.each([
    ["an aria-label", { "aria-label": `Copy ${BEARER}` }],
    ["a title", { title: BEARER }],
    ["a data-* attribute", { "data-bearer": BEARER }],
  ])("fails when %s outside ph-no-capture holds the text, though the text node is inside", (_which, attributes) => {
    render(
      <div>
        <div className="ph-no-capture">{BEARER}</div>
        <button type="button" {...attributes}>
          Copy
        </button>
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
  });

  it("fails when an attribute inside ph-no-capture holds the text: a bearer has no attribute exception", () => {
    render(
      <div className="ph-no-capture">
        <code>{BEARER}</code>
        <input readOnly value={BEARER} aria-label="Token" />
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
  });

  it("fails when document.title holds the text", () => {
    render(<div className="ph-no-capture">{BEARER}</div>);
    const title = document.title;
    document.title = `Token ${BEARER}`;
    try {
      expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
    } finally {
      document.title = title;
    }
  });

  // Ruling 22 (F2's Minor): no single node outside holds it, but their text joined does.
  it.each([
    [
      "text nodes",
      <code key="split">
        {"tfr_bearer-"}
        {"canary-41d9"}
      </code>,
    ],
    [
      "elements",
      <p key="split">
        <span>tfr_bearer-</span>
        <span>canary-41d9</span>
      </p>,
    ],
  ])("fails when the text is split across %s outside ph-no-capture while a whole copy sits inside", (_which, outside) => {
    render(
      <div>
        <div className="ph-no-capture">
          <code>{BEARER}</code>
        </div>
        {outside}
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow(/split across nodes/);
  });

  // Ruling 28 (the fix-wave review's n1): a root inside a ph-no-capture ancestor has nothing outside it.
  it("passes for a root inside a ph-no-capture ancestor, the root itself unclassed; fails for the same root outside one", () => {
    const { unmount } = render(
      <div className="ph-no-capture">
        <section data-testid="inside">
          <code>{BEARER}</code>
        </section>
      </div>,
    );
    expect(expectTextOnlyInsideNoCapture(BEARER, screen.getByTestId("inside"))).toBe(1);
    unmount();
    render(
      <div>
        <div className="ph-no-capture">
          <code>{BEARER}</code>
        </div>
        <section data-testid="outside">
          <code>
            <span>tfr_bearer-</span>
            <span>canary-41d9</span>
          </code>
          <div className="ph-no-capture">{BEARER}</div>
        </section>
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER, screen.getByTestId("outside"))).toThrow(/split across nodes/);
  });

  it("fails when a text node holding the text is outside ph-no-capture, a portal's included", () => {
    const { unmount } = render(
      <div>
        <div className="ph-no-capture">{BEARER}</div>
        <p>Your token: {BEARER}</p>
      </div>,
    );
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
    unmount();

    // A dialog's portal is a child of body, outside the rendered container.
    const portal = document.createElement("div");
    portal.textContent = BEARER;
    document.body.appendChild(portal);
    expect(() => expectTextOnlyInsideNoCapture(BEARER)).toThrow();
    portal.remove();
  });
});

/** A component holding `value` in its state and rendering none of it. */
function StateHolder({ value }: { value: unknown }) {
  const [held] = useState(value);
  return held === undefined ? null : <span>held</span>;
}

// D17d-2 Ruling 49 (the review's Nit 2): a dialog's typed env values are a Map, which Object.values sees nothing of.
describe("anyStateHolds", () => {
  const CANARY = "state-canary";

  it.each([
    { case: "a string", value: `x-${CANARY}-y` },
    { case: "an object's property, however deep", value: { a: [{ b: CANARY }] } },
    { case: "a Map's value", value: new Map([["NAME", CANARY]]) },
    { case: "a Map's key", value: new Map([[CANARY, "value"]]) },
    { case: "a Set's member", value: new Set(["other", CANARY]) },
    { case: "a Map inside an array inside an object", value: { env: [new Map([["NAME", { typed: CANARY }]])] } },
    { case: "a Set inside a Map's value", value: new Map([["NAME", new Set([CANARY])]]) },
  ])("finds the text in $case", ({ value }) => {
    const { container } = render(<StateHolder value={value} />);
    expect(anyStateHolds(CANARY, container)).toBe(true);
  });

  it.each([
    { case: "a Map", value: new Map([["NAME", "value"]]) },
    { case: "a Set", value: new Set(["value"]) },
    { case: "an object", value: { a: ["value"] } },
  ])("finds nothing in $case without it", ({ value }) => {
    const { container } = render(<StateHolder value={value} />);
    expect(anyStateHolds(CANARY, container)).toBe(false);
  });
});
