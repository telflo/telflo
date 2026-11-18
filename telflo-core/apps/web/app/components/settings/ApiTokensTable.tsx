import { useId } from "react";
import { Trash2 } from "lucide-react";
import type { ApiToken } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { formatServiceAccountDate, listedPrefix } from "~/lib/service-accounts.js";

/*
 * A list of `tf_` tokens not revoked (D22 decision 43; D25 decision 50,
 * Preflight ruling 22): a service account's, on its page, and a person's
 * own, on the Account page. Name, Prefix (`tf_AbC12xYz…`), Access ("Read &
 * Write" or "Read"), Expires (a date or "Never", and "Expired" by the API's
 * clock), Last used (a date or "Never"), Created, and a Revoke per row named
 * through `aria-labelledby` by "Revoke token" and the row's name cell: the
 * name and the prefix are visible text in the masked shell only, never an
 * attribute. A plain `<table>`.
 */

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

export interface ApiTokensTableProps {
  tokens: ApiToken[];
  onRevoke: (token: ApiToken) => void;
}

export function ApiTokensTable({ tokens, onRevoke }: ApiTokensTableProps) {
  const id = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Name</th>
              <th className={HEAD_CLASS}>Prefix</th>
              <th className={HEAD_CLASS}>Access</th>
              <th className={HEAD_CLASS}>Expires</th>
              <th className={HEAD_CLASS}>Last used</th>
              <th className={HEAD_CLASS}>Created</th>
              <th className={HEAD_CLASS}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {tokens.map((token) => {
              const rowId = `${id}-token-${token.id}`;
              return (
                <tr key={token.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <span id={`${rowId}-name`} className="font-medium text-foreground">
                      {token.name}
                    </span>
                  </td>
                  <td className={CELL_CLASS}>
                    <span className="font-mono text-xs text-muted-foreground">{listedPrefix(token.prefix)}</span>
                  </td>
                  <td className={CELL_CLASS}>
                    {token.access === "write" ? <Badge variant="warning">Read &amp; Write</Badge> : <Badge variant="secondary">Read</Badge>}
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs tabular-nums text-muted-foreground">{formatServiceAccountDate(token.expiresAt)}</span>
                      {token.isExpired && <Badge variant="destructive">Expired</Badge>}
                    </div>
                  </td>
                  <td className={CELL_CLASS}>
                    <span className="text-xs tabular-nums text-muted-foreground">{formatServiceAccountDate(token.lastUsedAt)}</span>
                  </td>
                  <td className={CELL_CLASS}>
                    <span className="text-xs tabular-nums text-muted-foreground">{formatServiceAccountDate(token.createdAt)}</span>
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex justify-end">
                      <span id={`${rowId}-revoke`} className="sr-only" hidden>
                        Revoke token
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-fail"
                        aria-labelledby={`${rowId}-revoke ${rowId}-name`}
                        onClick={() => onRevoke(token)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
