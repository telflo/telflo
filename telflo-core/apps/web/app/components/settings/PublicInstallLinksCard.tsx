import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Switch } from "~/components/ui/switch.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, getOrganizationSettings, isSessionEnded, updateOrganizationSettings } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_READ_TIMEOUT_MS, FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { refusalMessage } from "~/lib/organizations.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * Settings → Organization's "Public install links": the current
 * organization's switch for both public link kinds (Linux Quick Deploy and
 * Helm values links), on by default.
 *
 * - Read at mount (`GET …/organizations/{o}/settings`, any member, under the
 *   10 s hang guard): "Loading…"; a failed read "Failed to load the
 *   organization's settings" with "Try again". The route keys the card by
 *   the current organization, and an answer for an earlier one is dropped.
 * - A `Switch` named by the card's title and described by its words;
 *   disabled for a member who isn't an admin, with "Only an admin can change
 *   this." An admin's change sends the `PATCH` (CSRF, the write hang guard),
 *   not optimistically: the switch disabled meanwhile, then the server's
 *   value and "Public install links turned off" / "…turned on"; a failure
 *   toasts the API's words (`refusalMessage`) or "Failed to change public
 *   install links", the value kept. An admin's role gone meanwhile
 *   (`organization_admin_required`), the organization's or the terms'
 *   refusal revalidate the layout; a session ended is silent.
 * - Privacy: fixed words only; the organization's name is never in it.
 */

export const PUBLIC_INSTALL_LINKS_TITLE = "Public install links";
export const PUBLIC_INSTALL_LINKS_DESCRIPTION =
  "Quick Deploy links let anyone holding the link download an installer for a fleet without signing in; a Helm values link also carries the fleet's default token. Turn them off to allow only signed-in downloads.";
export const ONLY_AN_ADMIN_WORDS = "Only an admin can change this.";
export const SETTINGS_LOAD_FAILED_MESSAGE = "Failed to load the organization's settings";
export const SETTINGS_CHANGE_FAILED_MESSAGE = "Failed to change public install links";
export const LINKS_TURNED_OFF_MESSAGE = "Public install links turned off";
export const LINKS_TURNED_ON_MESSAGE = "Public install links turned on";

type Read = { kind: "loading" } | { kind: "failed" } | { kind: "read"; on: boolean };

export function PublicInstallLinksCard() {
  const current = useCurrentUser();
  const organizationId = current?.organization.id ?? "";
  const isAdmin = current?.organization.role === "admin";
  const isStillCurrent = useStillCurrent(organizationId);
  const { revalidate } = useRevalidator();
  const id = useId();
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const reads = useRef(0);

  const load = useCallback(async () => {
    if (organizationId === "") return;
    const number = ++reads.current;
    const sentIn = organizationId;
    setRead({ kind: "loading" });
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    try {
      const settings = await getOrganizationSettings(sentIn, { signal: guard.signal });
      if (number === reads.current && isStillCurrent(sentIn)) setRead({ kind: "read", on: settings.publicInstallLinks });
    } catch (failure) {
      if (number !== reads.current || !isStillCurrent(sentIn) || isSessionEnded(failure)) return;
      setRead({ kind: "failed" });
    } finally {
      guard.clear();
    }
  }, [organizationId, isStillCurrent]);

  useEffect(() => {
    void load();
    return () => {
      // Unmounted (another organization's card takes its place): a late answer is dropped.
      reads.current += 1;
    };
  }, [load]);

  const change = async (next: boolean) => {
    if (!isAdmin || savingRef.current || read.kind !== "read") return;
    const sentIn = organizationId;
    savingRef.current = true;
    setSaving(true);
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const settings = await updateOrganizationSettings(sentIn, { publicInstallLinks: next }, { signal: guard.signal });
      if (!isStillCurrent(sentIn)) return;
      setRead({ kind: "read", on: settings.publicInstallLinks });
      toast.success(settings.publicInstallLinks ? LINKS_TURNED_ON_MESSAGE : LINKS_TURNED_OFF_MESSAGE);
    } catch (failure) {
      if (!isStillCurrent(sentIn) || isSessionEnded(failure)) return;
      toast.error(refusalMessage(failure, SETTINGS_CHANGE_FAILED_MESSAGE));
      // The role or the organization changed meanwhile: the layout reads the user again.
      if (
        isOrganizationGone(failure) ||
        isTermsAcceptanceRequired(failure) ||
        (failure instanceof ApiError && failure.code === "organization_admin_required")
      ) {
        void revalidate();
      }
    } finally {
      guard.clear();
      savingRef.current = false;
      setSaving(false);
    }
  };

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const adminId = `${id}-admin`;
  return (
    <Card className="mt-6">
      <CardHeader className="pb-2">
        <CardTitle id={titleId}>{PUBLIC_INSTALL_LINKS_TITLE}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-start justify-between gap-4">
          <p id={descriptionId} className="text-[13px] text-muted-foreground">
            {PUBLIC_INSTALL_LINKS_DESCRIPTION}
          </p>
          {read.kind === "read" && (
            <Switch
              checked={read.on}
              onCheckedChange={(next) => void change(next)}
              disabled={!isAdmin || saving}
              aria-labelledby={titleId}
              aria-describedby={isAdmin ? descriptionId : `${descriptionId} ${adminId}`}
              className="mt-0.5"
            />
          )}
        </div>
        {read.kind === "loading" && (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading…
          </p>
        )}
        {read.kind === "failed" && (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-muted-foreground">{SETTINGS_LOAD_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {!isAdmin && (
          <p id={adminId} className="text-xs text-muted-foreground">
            {ONLY_AN_ADMIN_WORDS}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
