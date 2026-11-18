import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { ApiTokenAccess } from "@telflo/contracts";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardHeader } from "~/components/ui/card.js";
import { ApiError, getPersonalApiTokens, isSessionEnded } from "~/lib/api-client.js";
import {
  cliTokenName,
  cliTokenNamePrefix,
  HANDOFF_WAIT_MS,
  parseCliAuthFragment,
  postToListener,
  type CliAuthParameters,
} from "~/lib/cli-auth.js";
import { usePersonalApiTokenCalls } from "~/lib/personal-api-tokens.js";
import { API_TOKEN_CREATE_FAILED_MESSAGE } from "~/lib/service-accounts.js";

/*
 * `/cli-auth` (D27 decisions 21 and 22; Preflight rulings 11, 13, 15 and
 * 16): `telflo login`'s browser side. The CLI opens it as
 * `/cli-auth#state=…&port=…&host=…`; Approve mints a personal token, revokes
 * that machine's earlier CLI tokens and hands the new one to the CLI's
 * listener on `127.0.0.1`.
 *
 * - The server can't see the fragment, so the server render and the first
 *   client render are neutral ("Checking the sign-in link…"). An effect then
 *   reads the fragment once and takes it out of the address bar
 *   (`replaceState`, the router's state kept); a missing or malformed one,
 *   or a reload, is the invalid link's words and nothing else. A new
 *   fragment arriving in the same tab (`hashchange`: a second `telflo
 *   login`'s address pasted here) is read the same way and starts a new
 *   session, the earlier one's state and token dropped (Ruling 250); a
 *   token its Approve was still making is revoked (Ruling 254).
 * - Approve (disabled while it runs): the create (`CLI — <host> · <UTC
 *   time>`), the list, a revoke of each unrevoked token whose name starts
 *   exactly with `CLI — <host> · ` (never the new one; a failure is a fixed
 *   warning), then the handoff. While the handoff waits the page says the
 *   browser may ask for local network access. A 204 is "Done."; a
 *   `TypeError`, 60 s, or any other status shows the token once to paste,
 *   and the request stays open: a 204 after that still says "Done.".
 * - Cancel posts the denial (best effort) and says "Cancelled.".
 * - A 409 shows the API's own message; the limit's with a link to the
 *   Account page.
 *
 * Privacy: the token lives only in the create's reply, a ref for the
 * handoff and the fallback's display, shown inside `ph-no-capture` (the
 * Copy button only), never in a URL, storage, a toast, an attribute or a
 * log, and gone with the page. The host is visible text inside
 * `ph-no-capture` only. Toasts and the title are fixed words.
 */

export const CHECKING_WORDS = "Checking the sign-in link…";
export const INVALID_LINK_WORDS = "This sign-in link isn't valid. Run telflo login again.";
export const WAITING_WORDS = "Your browser may ask to allow access to this device: allow it to finish.";
export const DONE_WORDS = "Done. Return to your terminal.";
export const FALLBACK_WORDS = "Paste it into the terminal.";
export const CANCELLED_WORDS = "Cancelled.";
export const REVOKE_FAILED_WARNING = "Couldn't revoke this machine's earlier CLI tokens: revoke them on the Account page.";
export const DESCRIPTION_WORDS = "Approve to create a personal token for the CLI. It acts as you, with your role, in every organization you belong to.";

/** The access a CLI token may have, the default first. */
const ACCESS_CHOICES: ReadonlyArray<{ value: ApiTokenAccess; label: string }> = [
  { value: "write", label: "Write" },
  { value: "read", label: "Read" },
];
/** Its expiry in days (30 chosen). */
const EXPIRY_CHOICES = [1, 7, 30, 90] as const;
type ExpiryDays = (typeof EXPIRY_CHOICES)[number];
const DEFAULT_EXPIRY_DAYS: ExpiryDays = 30;

type Phase = "checking" | "invalid" | "ready" | "waiting" | "fallback" | "done" | "cancelled";

interface Problem {
  message: string;
  /** The live tokens' limit: the Account page is where one is revoked. */
  accountLink: boolean;
}

interface FragmentRead {
  phase: "checking" | "invalid" | "ready";
  parameters: CliAuthParameters | null;
  /** Which reading this is: each new fragment starts a new session of the page. */
  reading: number;
}

/**
 * The fragment, read after the first render and taken out of the address
 * bar; read again whenever a new one arrives in this document (Ruling 250:
 * a second `telflo login`'s address opened in a tab already here is a
 * same-document navigation, `hashchange`, not a new page).
 */
function useFragmentParameters(): FragmentRead {
  const [read, setRead] = useState<FragmentRead>({ phase: "checking", parameters: null, reading: 0 });
  const readOnce = useRef(false);
  useEffect(() => {
    const take = (): void => {
      const { hash, pathname } = window.location;
      const parameters = parseCliAuthFragment(hash);
      if (hash !== "") window.history.replaceState(window.history.state, "", pathname);
      setRead((previous) => ({ phase: parameters === null ? "invalid" : "ready", parameters, reading: previous.reading + 1 }));
    };
    if (!readOnce.current) {
      readOnce.current = true;
      take();
    }
    // replaceState fires no hashchange: only a new fragment arriving does.
    const onHashChange = (): void => {
      if (window.location.hash !== "") take();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return read;
}

export function CliAuthPage() {
  const fragment = useFragmentParameters();
  if (fragment.phase !== "ready" || fragment.parameters === null) {
    return <CliAuthCard>{fragment.phase === "checking" ? <p role="status">{CHECKING_WORDS}</p> : <p>{INVALID_LINK_WORDS}</p>}</CliAuthCard>;
  }
  // A new fragment is a new session: the earlier one's state, token and wait are dropped with it.
  return <CliAuthSession key={fragment.reading} parameters={fragment.parameters} />;
}

/** One sign-in link's session: Approve or Cancel for these parameters. */
function CliAuthSession({ parameters }: { parameters: CliAuthParameters }) {
  const calls = usePersonalApiTokenCalls();
  const [phase, setPhase] = useState<Phase>("ready");
  const [access, setAccess] = useState<ApiTokenAccess>("write");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryDays>(DEFAULT_EXPIRY_DAYS);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // The token: the create's reply, held for the handoff only.
  const tokenRef = useRef<string | null>(null);
  // The fallback's display: set only when the page shows the token to paste.
  const [shown, setShown] = useState<string | null>(null);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Leaving (the page, or this session for a new link's): the wait stopped and the token dropped.
  useEffect(
    () => () => {
      clearTimeout(waitTimer.current);
      tokenRef.current = null;
    },
    [],
  );

  const { state, port, host } = parameters;

  const showFallback = (isCurrent: () => boolean): void => {
    clearTimeout(waitTimer.current);
    if (!isCurrent() || tokenRef.current === null) return;
    setShown(tokenRef.current);
    setPhase((current) => (current === "waiting" ? "fallback" : current));
  };

  const handOff = (token: string, isCurrent: () => boolean): void => {
    setPhase("waiting");
    waitTimer.current = setTimeout(() => showFallback(isCurrent), HANDOFF_WAIT_MS);
    postToListener(port, { state, token }).then(
      (status) => {
        if (status !== 204) return showFallback(isCurrent);
        clearTimeout(waitTimer.current);
        tokenRef.current = null;
        if (!isCurrent()) return;
        setShown(null);
        setPhase("done");
      },
      () => showFallback(isCurrent),
    );
  };

  const revokeEarlier = async (newTokenId: string): Promise<void> => {
    const prefix = cliTokenNamePrefix(host);
    let failed = false;
    try {
      const { items } = await getPersonalApiTokens();
      for (const each of items) {
        if (!each.name.startsWith(prefix) || each.id === newTokenId) continue;
        await calls.revoke(each.id).catch(() => {
          failed = true;
        });
      }
    } catch {
      failed = true;
    }
    if (failed) toast.warning(REVOKE_FAILED_WARNING);
  };

  const approve = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    const isCurrent = calls.startCall();
    try {
      const created = await calls.create({ name: cliTokenName(host, new Date()), access, expiresInDays });
      // A session left while it was made (a new link's fragment, the page left) never hands it off:
      // the token is revoked, best effort, and the reply dropped (Ruling 254).
      const abandon = (): void => {
        tokenRef.current = null;
        calls.revoke(created.apiToken.id).catch(() => undefined);
      };
      if (!isCurrent()) return abandon();
      tokenRef.current = created.token;
      await revokeEarlier(created.apiToken.id);
      if (!isCurrent()) return abandon();
      handOff(created.token, isCurrent);
    } catch (failure) {
      if (!isCurrent() || isSessionEnded(failure)) return;
      const limit = failure instanceof ApiError && failure.code === "api_token_limit_reached";
      setProblem({ message: calls.failureMessage(failure, API_TOKEN_CREATE_FAILED_MESSAGE), accountLink: limit });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const cancel = (): void => {
    if (busyRef.current) return;
    postToListener(port, { state, error: "denied" }).catch(() => undefined);
    setPhase("cancelled");
  };

  return (
    <CliAuthCard
      title={
        <>
          Sign in the Telflo CLI on <span className="ph-no-capture">{host}</span>
        </>
      }
    >
      {phase === "ready" && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted-foreground">{DESCRIPTION_WORDS}</p>
          <fieldset disabled={busy}>
            <legend className="mb-2 text-[13px] font-medium text-foreground">Access</legend>
            <div className="grid grid-cols-2 gap-2">
              {ACCESS_CHOICES.map((each) => (
                <Choice key={each.value} name="cli-auth-access" checked={access === each.value} onChoose={() => setAccess(each.value)}>
                  {each.label}
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={busy}>
            <legend className="mb-2 text-[13px] font-medium text-foreground">Expires in</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {EXPIRY_CHOICES.map((days) => (
                <Choice key={days} name="cli-auth-expiry" checked={expiresInDays === days} onChoose={() => setExpiresInDays(days)}>
                  {days === 1 ? "1 day" : `${days} days`}
                </Choice>
              ))}
            </div>
          </fieldset>
          {problem !== null && (
            <Alert variant="destructive">
              <AlertDescription>
                {problem.message}
                {problem.accountLink && (
                  <>
                    {" "}
                    <Link to="/settings/account" className="underline">
                      Go to the Account page
                    </Link>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void approve()} disabled={busy}>
              {busy ? "Approving…" : "Approve"}
            </Button>
          </div>
        </div>
      )}
      {phase === "waiting" && <p role="status">{WAITING_WORDS}</p>}
      {phase === "fallback" && shown !== null && (
        <div className="space-y-3">
          <p>{FALLBACK_WORDS}</p>
          <SecretCopyBox secret={shown} copyLabel="Copy token" />
        </div>
      )}
      {phase === "done" && <p role="status">{DONE_WORDS}</p>}
      {phase === "cancelled" && <p role="status">{CANCELLED_WORDS}</p>}
    </CliAuthCard>
  );
}

function CliAuthCard({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-lg p-6">
      <Card>
        <CardHeader>
          <h1 className="text-lg font-semibold leading-tight">{title ?? "Sign in the Telflo CLI"}</h1>
        </CardHeader>
        <CardContent className="text-[13px]">{children}</CardContent>
      </Card>
    </div>
  );
}

function Choice({ name, checked, onChoose, children }: { name: string; checked: boolean; onChoose: () => void; children: React.ReactNode }) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors ${
        checked ? "border-brand bg-brand-soft text-foreground" : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChoose} className="h-3.5 w-3.5" />
      {children}
    </label>
  );
}
