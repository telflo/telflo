import { useEffect, useState } from "react";
import type { Route } from "./+types/verify-email";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { VerifyEmailPanel } from "~/components/auth/VerifyEmailPanel.js";
import { takeAddressBarToken } from "~/lib/address-bar-token.js";
import type { ThemeHandle } from "~/lib/theme.js";

/** Where the page keeps the link's token for a reload (lib/address-bar-token.ts). */
export const VERIFY_TOKEN_STORAGE_KEY = "telflo.verifyEmailToken";

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's.
export const handle = { theme: "remembered" } satisfies ThemeHandle;

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Confirm your email - Telflo" }];
}

/*
 * The link's token is in its fragment, `#token=…`, as the reset's and the
 * invitation's: a fragment never reaches a server, its logs or a Referer. A
 * link sent before carries it in its query, `?token=…`, and still works (a
 * link lasts 24 hours). The page takes it out of the address bar when it
 * mounts, before analytics can record the URL, and keeps it for a reload,
 * which confirms again as the link did. Until then the panel waits, as it
 * does on the server.
 */
export default function VerifyEmailPage() {
  /** `undefined` until the address bar has been read; then the token, or null. */
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const place = new URLSearchParams(window.location.hash.slice(1)).has("token") ? "fragment" : "query";
    setToken(takeAddressBarToken(place, VERIFY_TOKEN_STORAGE_KEY));
  }, []);

  return (
    <AuthShell showHomeLink>
      <VerifyEmailPanel token={token} />
    </AuthShell>
  );
}
