import type { AccountSession, AccountSessionsResponse } from "@telflo/contracts";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { SignOutEverywhereDialog } from "~/components/settings/SignOutEverywhereDialog.js";
import {
  SESSION_SIGN_OUT_FAILED_MESSAGE,
  SESSION_SIGNED_OUT_MESSAGE,
  SESSIONS_LOAD_FAILED_MESSAGE,
  accountFailureMessage,
  sessionTitle,
  useAccountRead,
} from "~/lib/account.js";
import { deleteSession, isSessionEnded, listSessions } from "~/lib/api-client.js";
import { formatDateTime, formatDateTimeToTheSecond } from "~/lib/format.js";

/*
 * Settings › Account's "Sessions": the account's live sessions, the
 * current one first, each row "{browser} on {system}" ("Unknown browser",
 * "unknown system" for others), "This browser" on the current one,
 * "Signed in …", "Last active …" and "IP address …", all as visible text
 * in the masked shell.
 *
 * - "Sign out" on every other row, no confirm: `DELETE …/sessions/{id}`,
 *   then "Session signed out." and the list read again. A refusal toasts its
 *   fixed message (and the list is read again: the session may be gone);
 *   anything else "Failed to sign out the session". The current row has no
 *   Sign out (that is Logout's). After a row's Sign out succeeds, its row
 *   goes with the list's read, so the card's heading takes the focus (unless
 *   it has moved elsewhere meanwhile).
 * - Each Sign out is named through `aria-labelledby` by fixed words and the
 *   session's sign-in time, to the second so two rows read apart: "Sign out
 *   the session signed in Oct 9, 2026, 7:58:30 AM". Never an IP, a browser
 *   or a system in an attribute.
 * - "Sign out everywhere" below the list (SignOutEverywhereDialog).
 */

const loadSessions = (signal: AbortSignal): Promise<AccountSessionsResponse> => listSessions({ signal });

/** A row's Sign out's name: fixed words and the sign-in time. */
export function signOutName(session: Pick<AccountSession, "signedInAt">): string {
  return `Sign out the session signed in ${formatDateTimeToTheSecond(session.signedInAt)}`;
}

export function SessionsCard() {
  const id = useId();
  const { read, reload } = useAccountRead(loadSessions);
  const [signingOut, setSigningOut] = useState<ReadonlySet<string>>(new Set());
  const [everywhereOpen, setEverywhereOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const signOut = async (sessionId: string, button: HTMLElement) => {
    if (signingOut.has(sessionId)) return;
    setSigningOut((before) => new Set(before).add(sessionId));
    try {
      await deleteSession(sessionId);
      toast.success(SESSION_SIGNED_OUT_MESSAGE);
      reload();
      // Only a focus that is lost or on the going row's button moves: on the body, gone, or that button.
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected || active === button) heading.current?.focus();
    } catch (failure) {
      if (isSessionEnded(failure)) return;
      toast.error(accountFailureMessage(failure, SESSION_SIGN_OUT_FAILED_MESSAGE));
      reload();
    } finally {
      setSigningOut((before) => {
        const after = new Set(before);
        after.delete(sessionId);
        return after;
      });
    }
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle ref={heading} tabIndex={-1} className="outline-none">
          Sessions
        </CardTitle>
        <CardDescription>Browsers signed in to your account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {read.kind === "loading" && (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading…
          </p>
        )}
        {read.kind === "failed" && (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-muted-foreground">{SESSIONS_LOAD_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        )}
        {read.kind === "read" && (
          <ul aria-label="Sessions" className="divide-y divide-border">
            {read.value.items.map((session) => {
              const rowId = `${id}-session-${session.id}`;
              return (
                <li key={session.id} className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 space-y-0.5">
                    {/* A div: the Badge is a div, which a p can't hold. */}
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {sessionTitle(session)}
                      {session.isCurrent && <Badge variant="info">This browser</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">Signed in {formatDateTime(session.signedInAt)}</p>
                    <p className="text-xs text-muted-foreground">Last active {formatDateTime(session.lastActiveAt)}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      IP address {session.ipAddress ?? "unknown"}
                    </p>
                  </div>
                  {!session.isCurrent && (
                    <>
                      <span id={`${rowId}-sign-out`} className="sr-only" hidden>
                        {signOutName(session)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-labelledby={`${rowId}-sign-out`}
                        disabled={signingOut.has(session.id)}
                        onClick={(event) => void signOut(session.id, event.currentTarget)}
                      >
                        Sign out
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Button type="button" variant="outline" onClick={() => setEverywhereOpen(true)}>
          Sign out everywhere
        </Button>
      </CardContent>
      <SignOutEverywhereDialog open={everywhereOpen} onOpenChange={setEverywhereOpen} />
    </Card>
  );
}
