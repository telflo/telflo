import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectorDistribution, Configuration } from "@telflo/contracts";
import { ConfigurationCard } from "./ConfigurationCard.js";
import { CATALOGUE, CONTRIB_LABEL } from "~/test/collector-distributions.js";
import { COLLEAGUE_EMAIL, MEMBER_EMAIL, MINE, ORPHANED, THEIRS } from "~/test/configurations.js";

function renderCard(
  configuration: Configuration,
  isOwn: boolean,
  canDelete = true,
  distributions: CollectorDistribution[] | null = CATALOGUE,
) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const { container } = render(
    <ConfigurationCard
      configuration={configuration}
      isOwn={isOwn}
      canDelete={canDelete}
      onOpen={onOpen}
      onDelete={onDelete}
      distributions={distributions}
    />,
  );
  const card = container.firstElementChild as HTMLElement;
  return { card, onOpen, onDelete, user: userEvent.setup() };
}

describe("ConfigurationCard", () => {
  it("shows the name and the description, and not the member's own email", () => {
    const { card } = renderCard(MINE, true);

    expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Collects traces and metrics from production");
    expect(card).not.toHaveTextContent(MEMBER_EMAIL);
  });

  it("shows the creator's email on someone else's card, and \"No description\" for none", () => {
    const { card } = renderCard(THEIRS, false);

    expect(card).toHaveTextContent(COLLEAGUE_EMAIL);
    expect(card).toHaveTextContent("No description");
  });

  it("shows no email when the creator's account is gone", () => {
    const { card } = renderCard(ORPHANED, false);

    expect(card).not.toHaveTextContent("@");
  });

  it("puts the name in no attribute: no title", () => {
    const { card } = renderCard(THEIRS, false);

    for (const element of [card, ...card.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain("Staging Logs");
        expect(attribute.value).not.toContain(COLLEAGUE_EMAIL);
      }
    }
  });

  it("is one button that opens on a click, on Enter and on Space, and isn't a link", async () => {
    const { card, onOpen, user } = renderCard(MINE, true);
    expect(card).toHaveAttribute("role", "button");
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card.closest("a")).toBeNull();

    await user.click(card);
    card.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith(MINE);
  });

  it("opens once from Edit, which doesn't also click the card", async () => {
    const { onOpen, onDelete, user } = renderCard(MINE, true);

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(MINE);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("has Delete where it's allowed, someone else's card too (an admin's), and Delete doesn't open", async () => {
    const { onOpen, onDelete, user } = renderCard(THEIRS, false);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // With the Delete pressed, the opener (the playground's prompt gives the focus back there).
    expect(onDelete).toHaveBeenCalledWith(THEIRS, screen.getByRole("button", { name: "Delete" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("lets the keyboard press Delete: Enter on it doesn't open the card", async () => {
    const { onOpen, onDelete, user } = renderCard(THEIRS, false);

    screen.getByRole("button", { name: "Delete" }).focus();
    await user.keyboard("{Enter}");

    expect(onDelete).toHaveBeenCalledWith(THEIRS, screen.getByRole("button", { name: "Delete" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("has no Delete where it isn't allowed, and Edit still opens", async () => {
    const { onOpen, user } = renderCard(THEIRS, false, false);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onOpen).toHaveBeenCalledWith(THEIRS);
  });

  it.each([
    ["Published", THEIRS, "border-brand/25"],
    ["Draft", MINE, "border-border"],
  ])("shows %s in the footer's left slot, the badge's text the word alone", (word, configuration, variantClass) => {
    const { card } = renderCard(configuration, configuration === MINE);

    const badge = within(card).getByText(word);
    expect(badge).toHaveTextContent(new RegExp(`^${word}$`));
    expect(badge).toHaveClass(variantClass);
    // The footer: the badge's slot left, the actions right, and the divider drawn.
    const footer = within(card).getByRole("button", { name: "Edit" }).parentElement!.parentElement!;
    expect(footer.firstElementChild).toContainElement(badge);
    expect(footer).toHaveClass("border-border");
    expect(within(card).getByRole("heading", { level: 3 }).parentElement).not.toContainElement(badge);
    expect(card).not.toHaveTextContent(word === "Published" ? "Draft" : "Published");
    for (const attribute of badge.attributes) {
      expect(attribute.name).not.toMatch(/^(title|aria-label|data-)/);
    }
  });

  it("ignores other keys", () => {
    const { card, onOpen } = renderCard(MINE, true);

    fireEvent.keyDown(card, { key: "a" });

    expect(onOpen).not.toHaveBeenCalled();
  });

  describe("the distribution tag", () => {
    it("shows the compact distribution label with its icon", () => {
      const { card } = renderCard(MINE, true);

      expect(within(card).getByText("Otel Contrib")).toBeInTheDocument();
      // The tag renders an inline SVG mark next to the label.
      expect(within(card).getByTitle(/built for/i).querySelector("svg")).not.toBeNull();
      // In the footer's left slot, after the status badge.
      const footer = within(card).getByRole("button", { name: "Edit" }).parentElement!.parentElement!;
      expect(footer.firstElementChild).toHaveTextContent(/^DraftOtel Contrib$/);
    });

    it("renders an unknown distribution id as-is instead of crashing", () => {
      const { card } = renderCard({ ...MINE, collectorDistribution: "grafana-alloy" }, true);

      expect(within(card).getByText("grafana-alloy")).toBeInTheDocument();
      expect(within(card).getByTitle(/built for/i).querySelector("svg")).not.toBeNull();
    });

    // Every configuration has a distribution here, so the tag is never
    // omitted; while the catalogue is unread (or failed) it is found from the
    // id alone.
    it("shows the tag from the id alone while the catalogue is unread", () => {
      const { card } = renderCard(MINE, true, true, null);

      expect(within(card).getByText("Otel Contrib")).toBeInTheDocument();
      expect(within(card).getByTitle("Built for otelcol-contrib — chosen when this configuration was created.")).toBeInTheDocument();
    });

    it("gives the tag a fixed tooltip naming the catalogue's label, and no name, email or description in any attribute", () => {
      const { card } = renderCard(THEIRS, false);

      const tag = within(card).getByTitle(`Built for ${CONTRIB_LABEL} — chosen when this configuration was created.`);
      expect(tag).toHaveTextContent(/^Otel Contrib$/);
      for (const element of [tag, ...tag.querySelectorAll("*")]) {
        for (const attribute of element.attributes) {
          expect(attribute.value).not.toContain(THEIRS.name);
          expect(attribute.value).not.toContain(COLLEAGUE_EMAIL);
          expect(attribute.name).not.toMatch(/^data-/);
        }
      }
    });
  });
});
