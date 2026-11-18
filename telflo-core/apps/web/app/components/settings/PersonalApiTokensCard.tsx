import { useState } from "react";
import { Plus } from "lucide-react";
import type { ApiToken, ApiTokensResponse } from "@telflo/contracts";
import { ApiReferenceNote } from "~/components/settings/ApiReferenceNote.js";
import { ApiTokenRevealDialog } from "~/components/settings/ApiTokenRevealDialog.js";
import { ApiTokensTable } from "~/components/settings/ApiTokensTable.js";
import { CreateApiTokenDialog } from "~/components/settings/CreateApiTokenDialog.js";
import { RevokeApiTokenDialog } from "~/components/settings/RevokeApiTokenDialog.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { useAccountRead } from "~/lib/account.js";
import { getPersonalApiTokens } from "~/lib/api-client.js";
import {
  PERSONAL_API_TOKENS_DESCRIPTION,
  PERSONAL_API_TOKENS_EMPTY,
  PERSONAL_API_TOKENS_LOAD_FAILED_MESSAGE,
  PERSONAL_API_TOKENS_SCOPE_WORDS,
  PERSONAL_API_TOKENS_TITLE,
  usePersonalApiTokenCalls,
} from "~/lib/personal-api-tokens.js";

/*
 * Settings › Account's "API tokens" (D25 decisions 3, 28 and 50; Preflight
 * ruling 22), the page's last card: the signed-in person's own `tf_`
 * tokens, which act as them, with their role, in every organization they
 * belong to (X-Telflo-Org per request). Only they see or revoke them.
 *
 * - The list: D22's tokens table (ApiTokensTable), each by its prefix as
 *   visible text in the masked shell; "Loading…", or "Failed to load API
 *   tokens" with "Try again"; "No tokens yet."
 * - "Create token" opens D22's create dialog with the person's own calls;
 *   its reply's token is held in this card's state for D22's reveal dialog
 *   alone (inside ph-no-capture, the copy button only), dropped however the
 *   reveal closes, and the list is read again then, not while it is shown.
 * - Revoke per row (named through aria-labelledby), with D22's
 *   confirmation; the list read again after.
 * - The fixed words say a personal token acts as you in every organization
 *   you belong to and that admins can't see it. A token's name is the
 *   person's content: visible text only, never an attribute, a toast or a
 *   title. The "API reference" links the API's own page (ApiReferenceNote).
 */

const loadTokens = (signal: AbortSignal): Promise<ApiTokensResponse> => getPersonalApiTokens({ signal });

export function PersonalApiTokensCard() {
  const { read, reload } = useAccountRead(loadTokens);
  const calls = usePersonalApiTokenCalls();
  const [createOpen, setCreateOpen] = useState(false);
  // The created token, from the create's reply, for the reveal alone.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiToken | null>(null);

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{PERSONAL_API_TOKENS_TITLE}</CardTitle>
          <CardDescription>{PERSONAL_API_TOKENS_DESCRIPTION}</CardDescription>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)} className="shrink-0 gap-1.5">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Create token
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[13px] text-muted-foreground">{PERSONAL_API_TOKENS_SCOPE_WORDS}</p>
        <ApiReferenceNote className="text-[13px] text-muted-foreground" />
        {read.kind === "loading" && (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading…
          </p>
        )}
        {read.kind === "failed" && (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-muted-foreground">{PERSONAL_API_TOKENS_LOAD_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        )}
        {read.kind === "read" &&
          (read.value.items.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">{PERSONAL_API_TOKENS_EMPTY}</p>
          ) : (
            <ApiTokensTable tokens={read.value.items} onRevoke={setToRevoke} />
          ))}
      </CardContent>
      <CreateApiTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        calls={calls}
        onCreated={setRevealed}
        onUnknownOutcome={reload}
      />
      <ApiTokenRevealDialog
        token={revealed}
        onClose={() => {
          setRevealed(null);
          reload();
        }}
      />
      <RevokeApiTokenDialog
        open={toRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setToRevoke(null);
        }}
        calls={calls}
        token={toRevoke}
        onRevoked={() => {
          setToRevoke(null);
          reload();
        }}
      />
    </Card>
  );
}
