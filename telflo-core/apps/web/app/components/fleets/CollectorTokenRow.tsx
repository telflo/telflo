import type { EnrollmentTokenListed } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import { currentRotateToken, tokenValidAt } from "~/lib/tokens.js";

/*
 * A collector's details' Token row (D17b-1 decision 25, Preflight ruling
 * 11): the token the collector last enrolled or polled with
 * (`enrollmentTokenId`) against the fleet's tokens, read with the details,
 * by the opamp-server's own rule for the current rotate token
 * (`GetActiveRotate` in `store/enrollmenttokens/postgres.go`: valid rotate
 * tokens ordered `do_refresh, created_at desc, id desc`, the first one
 * current; a token valid while it isn't revoked and its expiry, if any, is
 * after now, `Token.ValidAt`; both in `lib/tokens.ts`, which the Tokens tab
 * shares, D17b-2 Preflight ruling 12). The words are text, never an
 * `aria-label` or a `title`.
 */

/** A token that no longer authenticates: the collector is refused (401) on its next poll. */
export const TOKEN_REFUSED_WORDS = "Revoked or expired: refused on its next poll";
export const DEFAULT_TOKEN_WORDS = "Default token";
export const CURRENT_ROTATE_TOKEN_WORDS = "Rotate token (current)";
export const UNKNOWN_TOKEN_WORDS = "Unknown token";

type Token = Pick<EnrollmentTokenListed, "id" | "kind" | "expiresAt" | "revokedAt" | "doRefresh" | "createdAt">;

/**
 * The Token row's words for a collector's token among the fleet's, at
 * `now`: "—" for none; "Unknown token" for one the list doesn't hold; for a
 * revoked token or one at or past its expiry (either kind), "Revoked or
 * expired: refused on its next poll"; "Default token"; the fleet's current
 * rotate token "Rotate token (current)"; any other valid rotate token, one
 * a rotation is replacing (a rotation caps its predecessor's expiry at the
 * grace's end), "Rotate token (being replaced until {its expiry})", or
 * "Rotate token (being replaced)" without one.
 */
export function collectorTokenWords(tokenId: string | null, tokens: readonly Token[], now: number): string {
  if (tokenId === null) return "—";
  const token = tokens.find((each) => each.id === tokenId);
  if (token === undefined) return UNKNOWN_TOKEN_WORDS;
  if (!tokenValidAt(token, now)) return TOKEN_REFUSED_WORDS;
  if (token.kind === "default") return DEFAULT_TOKEN_WORDS;
  if (currentRotateToken(tokens, now)?.id === token.id) return CURRENT_ROTATE_TOKEN_WORDS;
  return token.expiresAt === null
    ? "Rotate token (being replaced)"
    : `Rotate token (being replaced until ${formatDateTime(token.expiresAt)})`;
}

/** What the details hold of the fleet's tokens: under way, failed, or read. */
export type TokensRead = { state: "loading" } | { state: "failed" } | { state: "read"; tokens: readonly Token[] };

/** The words while the tokens read is under way, and when it failed. */
export const TOKENS_LOADING_WORDS = "Loading…";
export const TOKENS_FAILED_WORDS = "Failed to load the fleet's tokens";

export function CollectorTokenRow({ tokenId, tokens, now }: { tokenId: string | null; tokens: TokensRead; now: number }) {
  if (tokenId === null) return <span className="text-muted-foreground">—</span>;
  if (tokens.state === "loading") return <span className="text-muted-foreground">{TOKENS_LOADING_WORDS}</span>;
  if (tokens.state === "failed") return <span className="text-muted-foreground">{TOKENS_FAILED_WORDS}</span>;
  return <span className="text-[13px] text-foreground">{collectorTokenWords(tokenId, tokens.tokens, now)}</span>;
}
