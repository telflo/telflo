import { useCallback, useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { EnrollmentTokenListed } from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, getEnrollmentTokens, isSessionEnded, revealEnrollmentToken } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_READ_TIMEOUT_MS, FLEET_WRITE_TIMEOUT_MS, isFleetGone } from "~/lib/fleets.js";
import { useOpeningReads, type OpeningRead } from "~/lib/hooks/use-opening-reads.js";
import { tokenValidAt } from "~/lib/tokens.js";
import { GROUP_NOT_FOUND_MESSAGE } from "./GroupDialog.js";

/*
 * What the install dialogs share (`InstallDialog` and `HelmInstallDialog`):
 * an opening's reads and its liveness, the refusals every request of the
 * opening handles alike, and the reveal of the fleet's valid default token
 * (with the install's facts read again beside the tokens). Nothing here
 * holds a bearer: the caller's state, or the caller's click chain, does.
 */

/** The refusals an assignment fixes: their words, and "Assign" (the Helm dialog's: the Groups tab). */
export const ASSIGN_REFUSALS: ReadonlySet<string> = new Set([
  "collector_group_unassigned",
  "collector_group_assignment_deleted",
  "collector_version_not_offered",
]);
/** The refusals no retry changes: their words alone. */
export const FINAL_REFUSALS: ReadonlySet<string> = new Set(["fleet_archived", "fleet_type_not_installable"]);
/** A reveal refused for its token (revoked meanwhile, or gone): no default token to reveal. */
export const TOKEN_REFUSALS: ReadonlySet<string> = new Set(["enrollment_token_revoked", "enrollment_token_expired", "enrollment_token_not_found"]);

/** The install dialogs' words while the organization's switch is off. */
export const PUBLIC_INSTALL_LINKS_OFF_WORDS = "Public install links are turned off for this organization.";

/** The reveal's chain ends here: the opening is over (closed, unmounted, another organization). */
export const CLOSED = Symbol("the opening is over");
/** No valid default token to reveal. */
export const NO_DEFAULT_TOKEN = Symbol("no valid default token");

/** A reveal's facts read refused: told as the facts' refusal, not the reveal's. */
export class FactsRefused {
  constructor(readonly error: unknown) {}
}

/** The fleet's valid default token, if any (a default token never expires: not revoked). */
export function validDefaultToken(tokens: readonly EnrollmentTokenListed[], now: number): EnrollmentTokenListed | undefined {
  return tokens.find((token) => token.kind === "default" && tokenValidAt(token, now));
}

export interface InstallOpeningProps {
  open: boolean;
  organizationId: string;
  onOpenChange: (open: boolean) => void;
  onFleetChanged: () => void;
  onGroupsChanged: () => void;
}

export interface InstallOpening {
  read: OpeningRead;
  /** Whether the opening is still on for the organization a request was sent in. */
  live: (sentIn: string) => boolean;
  isStillCurrent: (sentIn: string) => boolean;
  /** The group gone: "Group not found", closed, the groups read again. */
  groupGone: () => void;
  /** A refusal common to every request of the opening, handled; false for one the caller shows. */
  handledEverywhere: (failure: unknown) => boolean;
  /** The callers' latest callbacks (a late answer calls the current ones). */
  latest: { readonly current: Pick<InstallOpeningProps, "onOpenChange" | "onFleetChanged" | "onGroupsChanged"> };
}

/** One opening of an install dialog (the caller keys it per opening: `useOpeningKey`). */
export function useInstallOpening({ open, organizationId, onOpenChange, onFleetChanged, onGroupsChanged }: InstallOpeningProps): InstallOpening {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const live = useCallback((sentIn: string) => openRef.current && isStillCurrent(sentIn), [isStillCurrent]);

  const latest = useRef({ onOpenChange, onFleetChanged, onGroupsChanged });
  useEffect(() => {
    latest.current = { onOpenChange, onFleetChanged, onGroupsChanged };
  });

  const groupGone = () => {
    toast.error(GROUP_NOT_FOUND_MESSAGE);
    latest.current.onOpenChange(false);
    latest.current.onGroupsChanged();
  };

  const handledEverywhere = (failure: unknown): boolean => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      latest.current.onOpenChange(false);
      void revalidate();
      return true;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return true;
    if (isFleetGone(failure)) {
      latest.current.onOpenChange(false);
      latest.current.onFleetChanged();
      return true;
    }
    if (failure instanceof ApiError && failure.code === "collector_group_not_found") {
      groupGone();
      return true;
    }
    return false;
  };

  return { read, live, isStillCurrent, groupGone, handledEverywhere, latest };
}

/**
 * The opening's bearer: the tokens read, the valid default token, its reveal. Throws CLOSED once the opening is over,
 * NO_DEFAULT_TOKEN with none valid. With `readFacts` (a group's install facts), the facts are read again with the
 * tokens: a refusal throws FactsRefused, and the facts read are the ones the text (or the file) is built from.
 */
export async function revealDefaultBearer<Facts>(
  opening: Pick<InstallOpening, "read" | "live">,
  sentIn: string,
  fleetId: string,
  readFacts?: (signal: AbortSignal) => Promise<Facts>,
): Promise<{ bearer: string; tokenId: string; facts: Facts | null }> {
  const { read, live } = opening;
  const [tokens, fresh] = await Promise.all([
    read((signal) => getEnrollmentTokens(sentIn, fleetId, { signal })),
    readFacts === undefined ? Promise.resolve(undefined) : read(readFacts),
  ]);
  if (tokens === null || fresh === null || !live(sentIn)) throw CLOSED;
  if (fresh !== undefined && !fresh.ok) throw new FactsRefused(fresh.error);
  if (!tokens.ok) throw tokens.error;
  const token = validDefaultToken(tokens.value.tokens, Date.now());
  if (token === undefined) throw NO_DEFAULT_TOKEN;
  const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
  try {
    const revealed = await revealEnrollmentToken(sentIn, fleetId, token.id, { signal: guard.signal });
    if (!live(sentIn)) throw CLOSED;
    return { bearer: revealed.token.bearer, tokenId: token.id, facts: fresh === undefined ? null : fresh.value };
  } finally {
    guard.clear();
  }
}
