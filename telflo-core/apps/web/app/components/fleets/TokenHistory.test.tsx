import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EnrollmentTokenEvent } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import type { TokenHistoryRead } from "~/lib/tokens.js";
import { CREATOR, DEFAULT_TOKEN_ID, expectNoAttributeHolds, REVOKED_TOKEN_ID, ROTATE_TOKEN_ID, tokenEvent, tokensInEveryState } from "~/test/fleets.js";
import { eventTokenWords, TOKEN_EVENT_WORDS, TOKEN_NOT_LISTED, TokenHistory } from "./TokenHistory.js";

/*
 * The token history: its rows, words, empty state, failure and "Load more".
 * The hook's paging (`useTokensTab`) is `lib/tokens.test.ts`'s; the tab's
 * own flows (a poll, "Load more" over the API) are `TokensTab.test.tsx`'s.
 */

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const tokens = tokensInEveryState(NOW);
const LIST = [tokens.current, tokens.revoked, tokens.defaultToken];
const UNLISTED_ID = "c0ffee00-0000-4000-8000-0000000000b2";

function history(overrides: Partial<TokenHistoryRead> = {}): TokenHistoryRead {
  return { events: [], hasMore: false, loadingMore: false, failed: false, loadMore: vi.fn(), ...overrides };
}

function renderHistory(read: TokenHistoryRead, list = LIST) {
  const onRetry = vi.fn();
  render(<TokenHistory history={read} tokens={list} onRetry={onRetry} />);
  return { onRetry, user: userEvent.setup() };
}

const EVENTS: EnrollmentTokenEvent[] = [
  tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e04", tokenId: DEFAULT_TOKEN_ID, event: "viewed", occurredAt: "2026-10-14T11:00:00.000Z" }),
  tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e03", tokenId: ROTATE_TOKEN_ID, event: "issued", occurredAt: "2026-10-14T10:00:00.000Z" }),
  tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e02", tokenId: REVOKED_TOKEN_ID, event: "rotated", occurredAt: "2026-10-14T10:00:00.000Z" }),
  tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e01", tokenId: REVOKED_TOKEN_ID, event: "revoked", actor: null, occurredAt: "2026-10-13T09:00:00.000Z" }),
  tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e00", tokenId: UNLISTED_ID, event: "issued", occurredAt: "2026-10-13T08:00:00.000Z" }),
];

describe("TokenHistory", () => {
  it("lists each event newest first: When, Event, Token by kind and creation, By as plain text", () => {
    renderHistory(history({ events: EVENTS }));
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual(["When", "Event", "Token", "By"]);
    const rotateWords = `Rotate token created ${formatDateTime(tokens.current.createdAt)}`;
    const revokedWords = `Rotate token created ${formatDateTime(tokens.revoked.createdAt)}`;
    expect(screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      [formatDateTime("2026-10-14T11:00:00.000Z"), "Revealed", "Default token", CREATOR.email],
      [formatDateTime("2026-10-14T10:00:00.000Z"), "Issued", rotateWords, CREATOR.email],
      [formatDateTime("2026-10-14T10:00:00.000Z"), "Rotated", revokedWords, CREATOR.email],
      [formatDateTime("2026-10-13T09:00:00.000Z"), "Revoked", revokedWords, "—"],
      [formatDateTime("2026-10-13T08:00:00.000Z"), "Issued", TOKEN_NOT_LISTED, CREATOR.email],
    ]);
    // An email is text, never a link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names each event in its fixed words: viewed reads Revealed", () => {
    expect(TOKEN_EVENT_WORDS).toEqual({ issued: "Issued", viewed: "Revealed", rotated: "Rotated", revoked: "Revoked" });
  });

  it('names every token "A token not listed" while the tokens are unread', () => {
    expect(eventTokenWords(DEFAULT_TOKEN_ID, null)).toBe(TOKEN_NOT_LISTED);
    expect(TOKEN_NOT_LISTED).toBe("A token not listed");
    renderHistory(history({ events: EVENTS.slice(0, 2) }), null as never);
    expect(screen.getAllByText(TOKEN_NOT_LISTED)).toHaveLength(2);
  });

  // A revoked default token followed by a new one.
  it("names a default token by its creation when the fleet holds more than one", () => {
    const newDefault = { ...tokens.defaultToken, id: "c0ffee00-0000-4000-8000-0000000000d4", createdAt: "2026-10-14T09:30:00.000Z" };
    const list = [newDefault, tokens.current, tokens.revokedDefaultToken];
    renderHistory(
      history({
        events: [
          tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e06", tokenId: newDefault.id, event: "issued", occurredAt: "2026-10-14T09:30:00.000Z" }),
          tokenEvent({ id: "c0ffee00-0000-4000-8000-000000000e05", tokenId: DEFAULT_TOKEN_ID, event: "revoked", occurredAt: "2026-10-14T09:00:00.000Z" }),
        ],
      }),
      list,
    );
    expect(screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[2]!.textContent)).toEqual([
      `Default token created ${formatDateTime(newDefault.createdAt)}`,
      `Default token created ${formatDateTime(tokens.revokedDefaultToken.createdAt)}`,
    ]);
    expect(eventTokenWords(DEFAULT_TOKEN_ID, [tokens.revokedDefaultToken])).toBe("Default token");
  });

  it('says "No token events yet." when empty', () => {
    renderHistory(history({ events: [] }));
    expect(screen.getByText("No token events yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says it is loading until its first read answers", () => {
    renderHistory(history({ events: null }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the token history…");
  });

  it('shows a failed first read ("Failed to load the token history") with Try again, the tab\'s reload', async () => {
    const { onRetry, user } = renderHistory(history({ events: null, failed: true }));
    expect(screen.getByText("Failed to load the token history")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers "Load more" while a next page exists, "Loading…" (disabled) while it reads', async () => {
    const loadMore = vi.fn();
    const { user } = renderHistory(history({ events: EVENTS, hasMore: true, loadMore }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("disables Load more while it reads, and offers none on the last page", () => {
    const { unmount } = render(<TokenHistory history={history({ events: EVENTS, hasMore: true, loadingMore: true })} tokens={LIST} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    unmount();
    renderHistory(history({ events: EVENTS, hasMore: false }));
    expect(screen.queryByRole("button", { name: /Load more|Loading…/ })).toBeNull();
  });

  it("holds no email in an attribute", () => {
    const email = "canary-history-9c1d@example.com";
    renderHistory(history({ events: [tokenEvent({ actor: { ...CREATOR, email } })] }));
    expect(screen.getByRole("table")).toHaveTextContent(email);
    expectNoAttributeHolds(email);
  });
});
