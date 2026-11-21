import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EnrollmentTokenListed } from "@telflo/contracts";
import { formatDateTime, formatRelativeTime } from "~/lib/format.js";
import { tokensInEveryState } from "~/test/fleets.js";
import { collectorCount, expiresBadge, tokenRowName, TokensTable } from "./TokensTable.js";

/*
 * The Tokens table: its rows, each status and expiry badge for a default,
 * current, being-replaced, expired and revoked token, and the row actions'
 * names. The tab's flows are in `TokensTab.test.tsx`.
 */

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const DAY = 86_400_000;
const tokens = tokensInEveryState(NOW);

function renderTable(list: EnrollmentTokenListed[]) {
  const onAction = vi.fn();
  render(<TokensTable tokens={list} now={NOW} onAction={onAction} />);
  return { onAction, user: userEvent.setup() };
}

const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell");
const rows = () => screen.getAllByRole("row").slice(1);

describe("TokensTable", () => {
  it("has the columns Kind, Created, Expires, Status, Active in the last 5 minutes, and actions; the API's order", () => {
    const list = [tokens.current, tokens.beingReplaced, tokens.expired, tokens.revoked, tokens.defaultToken];
    renderTable(list);
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual([
      "Kind",
      "Created",
      "Expires",
      "Status",
      "Active in the last 5 minutes",
      "Actions",
    ]);
    expect(rows().map((row) => cellsOf(row)[0]!.textContent)).toEqual(["Rotate", "Rotate", "Rotate", "Rotate", "Default"]);
  });

  it.each([
    ["the default token", tokens.defaultToken, "Never", "bg-secondary", "Valid", "bg-secondary", "1 collector", true],
    ["the current rotate token", tokens.current, "1y", "text-ok", "Current", "text-ok", "3 collectors", true],
    ["the token being replaced", tokens.beingReplaced, "20d left", "text-warn", "Being replaced", "text-brand", "2 collectors", true],
    ["an expired rotate token", tokens.expired, "Expired", "text-muted-foreground", "Expired", "text-muted-foreground", "0 collectors", false],
    ["a revoked rotate token", tokens.revoked, "Never", "bg-secondary", "Revoked", "bg-secondary", "0 collectors", false],
    ["the revoked default token", tokens.revokedDefaultToken, "Never", "bg-secondary", "Revoked", "bg-secondary", "0 collectors", false],
  ] as const)("shows %s: its Expires and Status badges, its active count, and its actions", (_name, token, expires, expiresColour, status, statusColour, active, actions) => {
    const list = [tokens.current, tokens.beingReplaced, tokens.expired, tokens.revoked, token.kind === "default" ? token : tokens.defaultToken];
    renderTable(list);
    const row = rows()[list.indexOf(token)]!;
    const [, created, expiresCell, statusCell, activeCell, actionsCell] = cellsOf(row);
    expect(created).toHaveTextContent(`${formatDateTime(token.createdAt)}${formatRelativeTime(token.createdAt, NOW)}`);
    expect(within(expiresCell!).getByText(expires)).toHaveClass(expiresColour);
    // The date beneath the badge; none under "Never" (no "—" line).
    expect(expiresCell!.textContent).toBe(token.expiresAt === null ? expires : `${expires}${formatDateTime(token.expiresAt)}`);
    expect(within(statusCell!).getByText(status)).toHaveClass(statusColour);
    expect(activeCell).toHaveTextContent(new RegExp(`^${active}$`));
    if (actions) {
      expect(within(actionsCell!).getAllByRole("button").map((each) => each.textContent)).toEqual(["Reveal", "Revoke"]);
    } else {
      expect(within(actionsCell!).queryAllByRole("button")).toEqual([]);
    }
  });

  it('says until when a token being replaced keeps working, as text ("until {date}")', () => {
    renderTable([tokens.current, tokens.beingReplaced, tokens.defaultToken]);
    const statusCell = cellsOf(rows()[1]!)[3]!;
    expect(within(statusCell).getByText("Being replaced")).toBeInTheDocument();
    expect(within(statusCell).getByText(`until ${formatDateTime(tokens.beingReplaced.expiresAt)}`)).toBeInTheDocument();
    expect(statusCell.querySelector("[title]")).toBeNull();
  });

  it("hands Current to the token being replaced once the newer one is revoked", () => {
    const revokedCurrent = { ...tokens.current, revokedAt: new Date(NOW - 1000).toISOString() };
    renderTable([revokedCurrent, tokens.beingReplaced, tokens.defaultToken]);
    expect(within(cellsOf(rows()[0]!)[3]!).getByText("Revoked")).toBeInTheDocument();
    expect(within(cellsOf(rows()[1]!)[3]!).getByText("Current")).toBeInTheDocument();
  });

  it.each([
    ["at its expiry", 0, "Expired"],
    ["a second past", -1000, "Expired"],
    ["a second before", 1000, "<1d left"],
    ["3 days before", 3 * DAY, "3d left"],
    ["45 days before", 45 * DAY, "45d"],
  ])("reads an expiry %s as %s", (_why, ms, label) => {
    expect(expiresBadge(new Date(NOW + ms).toISOString(), NOW).label).toBe(label);
  });

  it.each([
    [0, "0 collectors"],
    [1, "1 collector"],
    [12, "12 collectors"],
  ])("counts %s active as %s", (count, words) => {
    expect(collectorCount(count)).toBe(words);
  });

  it("names each row's actions by kind and creation through aria-labelledby, never a title", async () => {
    const { onAction, user } = renderTable([tokens.current, tokens.defaultToken]);
    const rotateName = `the rotate token created ${formatDateTime(tokens.current.createdAt)}`;
    for (const name of [`Reveal ${rotateName}`, `Revoke ${rotateName}`, "Reveal the default token", "Revoke the default token"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-labelledby");
      expect(button).not.toHaveAttribute("title");
      expect(button).not.toHaveAttribute("aria-label");
    }
    const reveal = screen.getByRole("button", { name: "Reveal the default token" });
    await user.click(reveal);
    expect(onAction).toHaveBeenCalledWith("reveal", tokens.defaultToken, reveal);
    const revoke = screen.getByRole("button", { name: `Revoke ${rotateName}` });
    await user.click(revoke);
    expect(onAction).toHaveBeenCalledWith("revoke", tokens.current, revoke);
  });

  // A revoked default token followed by a new one.
  it("names a default token by its date too when the fleet holds more than one", () => {
    const newDefault = { ...tokens.defaultToken, id: "c0ffee00-0000-4000-8000-0000000000d3", createdAt: new Date(NOW - DAY).toISOString() };
    renderTable([newDefault, tokens.current, tokens.revokedDefaultToken]);
    const name = `the default token created ${formatDateTime(newDefault.createdAt)}`;
    expect(screen.getByRole("button", { name: `Reveal ${name}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Revoke ${name}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal the default token" })).toBeNull();
    // The Kind column still says Default for both.
    expect(rows().map((row) => cellsOf(row)[0]!.textContent)).toEqual(["Default", "Rotate", "Default"]);
    expect(tokenRowName(newDefault, 1)).toBe("the default token");
    expect(tokenRowName(newDefault, 2)).toBe(name);
    expect(tokenRowName(tokens.current, 2)).toBe(`the rotate token created ${formatDateTime(tokens.current.createdAt)}`);
  });
});
