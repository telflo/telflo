import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";
import { formatDateTime } from "~/lib/format.js";

/** A new fleet's two bearers, shown once (D17a decision 24), and when its rotate token expires (null: never). */
export interface CreatedTokens {
  defaultBearer: string;
  rotateBearer: string;
  rotateExpiresAt: string | null;
}

/** The words above the tokens (D17a decision 24). */
export const COPY_THEM_NOW = "Copy them now: this dialog won't show them again.";

/**
 * The create dialog's last step (D17a decision 24, Preflight ruling 13): both
 * of the new fleet's tokens, each in its own `SecretCopyBox`, which keeps the
 * bearer inside `ph-no-capture` as text, never in an attribute. "Default
 * token" is the one an install uses and never expires; "Rotate token" says
 * when it expires. Each shows masked, its whole text only on Show; Copy
 * copies it whole. The bearers live only in the dialog's state, which Done
 * clears.
 */
export function CreatedFleetTokens({ tokens }: { tokens: CreatedTokens }) {
  return (
    <div className="grid gap-4 py-4">
      <div className="grid gap-2">
        <p className="text-[13px] font-medium text-foreground">Default token</p>
        <p className="text-xs text-muted-foreground">The one an install uses. It never expires.</p>
        <SecretCopyBox secret={tokens.defaultBearer} copyLabel="Copy default token" masked />
      </div>
      <div className="grid gap-2">
        <p className="text-[13px] font-medium text-foreground">Rotate token</p>
        <p className="text-xs text-muted-foreground">
          {tokens.rotateExpiresAt === null ? "It never expires." : `It expires ${formatDateTime(tokens.rotateExpiresAt)}.`}
        </p>
        <SecretCopyBox secret={tokens.rotateBearer} copyLabel="Copy rotate token" masked />
      </div>
    </div>
  );
}
