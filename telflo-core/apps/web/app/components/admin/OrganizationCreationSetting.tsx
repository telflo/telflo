import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Switch } from "~/components/ui/switch.js";
import { abortAfter } from "~/lib/abort-after.js";
import { getProductAdminSettings, isSessionEnded, updateProductAdminSettings } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * The product admins' switch, "Only product admins can create organizations",
 * a section of `/product-admin/product-admins`. On by default, in every
 * registration mode; it holds no personal data.
 *
 * - Read at mount (`GET /api/v1/product-admin/settings`, under the 10 s
 *   hang guard): "Loading…"; a failed read "Failed to load the site's
 *   settings" with "Try again".
 * - A `Switch` named by the section's title and described by its words.
 *   A change sends the `PATCH`, not optimistically: the switch disabled
 *   meanwhile, then the server's value and a fixed-word toast; a failure
 *   toasts the API's words or "Failed to change who can create
 *   organizations", the value kept.
 * - A 403 `product_admin_required` (the flag cleared since the page opened)
 *   goes to `/app`, as the other product-admin pages; a session that ended
 *   says nothing.
 * - Organizations that already exist are untouched: their admins keep
 *   inviting (the words say so).
 */

export const ORGANIZATION_CREATION_TITLE = "Only product admins can create organizations";
export const ORGANIZATION_CREATION_DESCRIPTION =
  "Invite-only means someone already on the site has to invite you. With this off, anyone with an account can create an organization and invite people into it. Turn it on to keep that to product admins. Organizations that already exist keep their admins, who can still invite people.";
export const ORGANIZATION_CREATION_LOAD_FAILED_MESSAGE = "Failed to load the site's settings";
export const ORGANIZATION_CREATION_CHANGE_FAILED_MESSAGE = "Failed to change who can create organizations";
export const ORGANIZATION_CREATION_RESTRICTED_TOAST = "Only product admins can create organizations now";
export const ORGANIZATION_CREATION_OPEN_TOAST = "Anyone with an account can create organizations now";

/** A read that never answers ends after this, as a failure (the product-admin pages' hang guard). */
export const ORGANIZATION_CREATION_TIMEOUT_MS = 10_000;

type Read = { kind: "loading" } | { kind: "failed" } | { kind: "read"; restricted: boolean };

export function OrganizationCreationSetting() {
  const navigate = useNavigate();
  const id = useId();
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const reads = useRef(0);

  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    const number = ++reads.current;
    setRead({ kind: "loading" });
    const guard = abortAfter(ORGANIZATION_CREATION_TIMEOUT_MS);
    try {
      const settings = await getProductAdminSettings({ signal: guard.signal });
      if (number === reads.current) setRead({ kind: "read", restricted: settings.organizationCreation === "product-admins" });
    } catch (failure) {
      if (number !== reads.current || isSessionEnded(failure)) return;
      if (isProductAdminRefusal(failure)) {
        leave();
        return;
      }
      setRead({ kind: "failed" });
    } finally {
      guard.clear();
    }
  }, [leave]);

  useEffect(() => {
    void load();
    return () => {
      // Unmounted: a late answer is dropped.
      reads.current += 1;
    };
  }, [load]);

  const change = async (restricted: boolean) => {
    if (savingRef.current || read.kind !== "read") return;
    savingRef.current = true;
    setSaving(true);
    const guard = abortAfter(ORGANIZATION_CREATION_TIMEOUT_MS);
    try {
      const settings = await updateProductAdminSettings(
        { organizationCreation: restricted ? "product-admins" : "everyone" },
        { signal: guard.signal },
      );
      const now = settings.organizationCreation === "product-admins";
      setRead({ kind: "read", restricted: now });
      toast.success(now ? ORGANIZATION_CREATION_RESTRICTED_TOAST : ORGANIZATION_CREATION_OPEN_TOAST);
    } catch (failure) {
      if (isProductAdminRefusal(failure)) {
        leave();
        return;
      }
      const message = failureMessage(failure, ORGANIZATION_CREATION_CHANGE_FAILED_MESSAGE);
      if (message !== null) toast.error(message);
    } finally {
      guard.clear();
      savingRef.current = false;
      setSaving(false);
    }
  };

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  return (
    <section aria-labelledby={titleId} className="mb-5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {ORGANIZATION_CREATION_TITLE}
          </h2>
          <p id={descriptionId} className="mt-1 text-[13px] text-muted-foreground">
            {ORGANIZATION_CREATION_DESCRIPTION}
          </p>
        </div>
        {read.kind === "read" && (
          <Switch
            checked={read.restricted}
            onCheckedChange={(next) => void change(next)}
            disabled={saving}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="mt-0.5"
          />
        )}
      </div>
      {read.kind === "loading" && (
        <p role="status" className="mt-2 text-[13px] text-muted-foreground">
          Loading…
        </p>
      )}
      {read.kind === "failed" && (
        <div className="mt-2 flex items-center gap-3">
          <p className="text-[13px] text-muted-foreground">{ORGANIZATION_CREATION_LOAD_FAILED_MESSAGE}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
