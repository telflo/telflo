import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { useCopiedText } from "~/lib/hooks/use-copied-text.js";

/** The dots that stand for a masked token's middle: always 8, so they don't give its length away. */
export const MASK_DOTS = "••••••••";

/**
 * A token as `masked` shows it: its prefix (up to and including the first
 * `_`), its first 4 characters after that, the dots, and its last 4
 * (`tfd_abcd••••••••wxyz`). A token with fewer than 16 characters after
 * its prefix, too few to hide 8 of them, shows its prefix and the dots only.
 */
export function maskSecret(secret: string): string {
  const underscore = secret.indexOf("_");
  const prefix = underscore === -1 ? "" : secret.slice(0, underscore + 1);
  const rest = secret.slice(prefix.length);
  if (rest.length < 16) return `${prefix}${MASK_DOTS}`;
  return `${prefix}${rest.slice(0, 4)}${MASK_DOTS}${rest.slice(-4)}`;
}

/**
 * A secret shown once to copy: a fleet token's bearer (D17a decision 24,
 * Preflight ruling 13; ADR 0024), an install, Quick Deploy or Helm command
 * holding one (D17c-1, D17c-2, D17d-2), and a service account's API token
 * (D22 decision 45).
 *
 * - The box is `ph-no-capture`, so session replay records nothing inside it,
 *   and the Copy button is inside the box, so autocapture skips its click
 *   too. The secret is the text of a `<code>` (selectable whole, wrapping
 *   anywhere), never an input's `value`, and never in an attribute: the
 *   button's accessible name is the caller's fixed words ("Copy default
 *   token"), never the secret.
 * - Copy reads "Copied" for 2 s, and a second Copy within them starts the
 *   2 s again. The button's accessible name stays the caller's words, so a
 *   screen reader hears "Copied" through an sr-only live region instead.
 *   A clipboard the browser refuses (an insecure origin has none) toasts
 *   "Failed to copy to clipboard", never the error or the secret; the text
 *   stays there to select by hand.
 *
 * - `multiline` (D17c-1 Preflight ruling 25): an install command, one flag
 *   a line, or the Linux token screen's lines, its line breaks kept
 *   (`whitespace-pre-wrap`) and copied as shown.
 *
 * - `masked`: a token on its own line shows only its prefix, its first 4
 *   characters and its last 4 (`maskSecret`), so a glance at the screen
 *   doesn't give it away. Copy still copies the whole token, and a Show
 *   button (named "Show " plus the caller's words without "Copy ") swaps in
 *   the whole text, for a browser with no clipboard. Until Show, the whole
 *   token is in no text and no attribute of the page.
 *
 * It lives in `components/secrets/`, shared by the screens that show one,
 * rather than in `components/ui/`: it is for secrets only, so it isn't
 * reused for something replay should see.
 */
export function SecretCopyBox({
  secret,
  copyLabel,
  multiline = false,
  masked = false,
}: {
  secret: string;
  copyLabel: string;
  multiline?: boolean;
  masked?: boolean;
}) {
  const { copied, copy } = useCopiedText(secret);
  const [shown, setShown] = useState(false);
  const hidden = masked && !shown;
  const noun = copyLabel.replace(/^Copy /, "");

  return (
    <div className="ph-no-capture flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2">
      <code
        className={`min-w-0 flex-1 break-all font-mono text-xs leading-relaxed${hidden ? " select-none" : " select-all"}${multiline ? " whitespace-pre-wrap" : ""}`}
      >
        {hidden ? maskSecret(secret) : secret}
      </code>
      {masked ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={`${shown ? "Hide" : "Show"} ${noun}`}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {shown ? "Hide" : "Show"}
        </Button>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={copyLabel} onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
