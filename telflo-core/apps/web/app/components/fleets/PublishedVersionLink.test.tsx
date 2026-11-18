import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it } from "vitest";
import { CONFIGURATION_ID, expectNoAttributeHolds, expectNoAttributeHoldsInOpenTooltips, VERSION_ID } from "~/test/fleets.js";
import { PublishedVersionLink, type PublishedVersionLinkProps } from "./PublishedVersionLink.js";

// "{configurationName} @v{n}" linked to the editor (D17c-1 decisions 7 and
// 46; Preflight ruling 32): truncated with a tooltip in tables, whole and
// without one in dialogs; the name in no attribute.

const LONG = `nginx-logs-${"x".repeat(120)}-canary`;

function EditorStub() {
  const { configurationId, versionId } = useParams();
  return <p>{`editor ${configurationId} ${versionId}`}</p>;
}

function renderLink(props: Partial<PublishedVersionLinkProps> = {}, configurationName = "checkout-otel") {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/fleet"]}>
      <Routes>
        <Route
          path="/fleet"
          element={
            <div>
              <PublishedVersionLink
                version={{ configurationId: CONFIGURATION_ID, configurationName, versionId: VERSION_ID, versionNumber: 4 }}
                {...props}
              />
            </div>
          }
        />
        <Route path="/editor/:configurationId/:versionId" element={<EditorStub />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, ...view };
}

describe("PublishedVersionLink in a table (the default)", () => {
  it("links '{name} @v{n}' to the editor's version, the whole text its name, with no title or aria-label", () => {
    renderLink();
    const link = screen.getByRole("link", { name: "checkout-otel @v4" });
    expect(link).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}/${VERSION_ID}`);
    expect(link.textContent).toBe("checkout-otel @v4");
    expect(link).toHaveClass("text-[13px]", "text-brand", "whitespace-nowrap");
    expect(link).not.toHaveAttribute("title");
    expect(link).not.toHaveAttribute("aria-label");
  });

  it("truncates the name at 16rem and never @v{n}", () => {
    renderLink({}, LONG);
    const name = screen.getByText(LONG);
    expect(name.tagName).toBe("SPAN");
    expect(name).toHaveClass("inline-block", "truncate", "max-w-64", "align-bottom");
    expect(name.textContent).toBe(LONG);
    // " @v4" sits after the truncated span, in the link itself.
    expect(name.parentElement).toBe(screen.getByRole("link"));
    expect(screen.getByRole("link").textContent).toBe(`${LONG} @v4`);
    expect(screen.getByRole("link")).toHaveAccessibleName(`${LONG} @v4`);
  });

  it("encodes the ids in the editor's path", () => {
    render(
      <MemoryRouter>
        <PublishedVersionLink version={{ configurationId: "a/b", configurationName: "c", versionId: "d?e", versionNumber: 1 }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/editor/a%2Fb/d%3Fe");
  });

  it("shows the full text in a tooltip always, on hover and on keyboard focus", async () => {
    const { user } = renderLink({}, LONG);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("data-state", "closed");
    await user.hover(link);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(`${LONG} @v4`);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await user.unhover(link);

    await user.tab();
    expect(link).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(`${LONG} @v4`);
  });

  it("adds a meaning as the tooltip's second line, after the full text", async () => {
    renderLink({ meaning: "Running: the last published version it was sent." });
    act(() => screen.getByRole("link").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect([...tooltip.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "checkout-otel @v4",
      "Running: the last published version it was sent.",
    ]);
  });

  it("still goes to the editor, its tooltip open", async () => {
    const { user } = renderLink();
    act(() => screen.getByRole("link").focus());
    await screen.findByRole("tooltip");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(`editor ${CONFIGURATION_ID} ${VERSION_ID}`)).toBeInTheDocument();
  });
});

describe("PublishedVersionLink in a dialog", () => {
  it("shows the whole name, wrapping, with no truncation and no tooltip", async () => {
    const { user, container } = renderLink({ variant: "dialog" }, LONG);
    const link = screen.getByRole("link", { name: `${LONG} @v4` });
    expect(link).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}/${VERSION_ID}`);
    expect(link).toHaveClass("[overflow-wrap:anywhere]");
    expect(link).not.toHaveClass("whitespace-nowrap");
    const name = within(link).getByText(LONG);
    expect(name).not.toHaveClass("truncate");
    expect(name).not.toHaveClass("max-w-64");
    // No tooltip's trigger: focus opens nothing.
    expect(link).not.toHaveAttribute("data-state");
    await user.tab();
    expect(link).toHaveFocus();
    await act(async () => {});
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(await expectNoAttributeHoldsInOpenTooltips(LONG, container)).toBe(0);
  });
});

// ADR 0024, D17b-1 decision 32: a configuration's name is text in the masked shell, never an attribute.
describe("PublishedVersionLink's privacy", () => {
  it.each(["table", "dialog"] as const)("holds the configuration's name in no attribute (%s), its tooltip open", async (variant) => {
    const { container } = renderLink({ variant, meaning: variant === "table" ? "Running: the last published version it was sent." : undefined }, LONG);
    expect(container).toHaveTextContent(LONG);
    expectNoAttributeHolds(LONG);
    expect(await expectNoAttributeHoldsInOpenTooltips(LONG, container)).toBe(variant === "table" ? 1 : 0);
  });
});
