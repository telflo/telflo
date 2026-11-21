import { useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { Configuration } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { deleteConfiguration } from "~/lib/api-client.js";
import {
  configurationRefusalMessage,
  isConfigurationGone,
  isOrganizationGone,
  isTermsAcceptanceRequired,
  useStillCurrent,
} from "~/lib/configurations.js";

/*
 * Deleting a configuration. It stays open until the API answers,
 * "Deleting..." meanwhile, and says nothing on success:
 * - Escape, an outside click and the close button do nothing while the
 *   delete is under way, so it really does stay open;
 * - a failure toasts the API's message for a refusal, else "An error has
 *   occurred. Please refresh the page.", never a server error's message. A
 *   published configuration's refusals are such: a fleet using it (409
 *   `configuration_in_use`), the person's fleet limit (429 `rate_limited`),
 *   its fleet usage unreadable (503 `fleets_unavailable`, "nothing was
 *   deleted"); the dialog stays open for a retry;
 * - a 404 `configuration_not_found` (someone else deleted it) toasts its
 *   message, closes and reloads the list; a 404 `organization_not_found`
 *   closes and revalidates the layout, with no toast: the page moves to the
 *   session's organization. A 403 `terms_acceptance_required` does the same:
 *   the layout's terms dialog opens, and the list reloads after Accept;
 * - a delete that answers after the dialog has unmounted, or after the
 *   organization changed, does nothing: it closes, reloads and toasts
 *   nothing, so a fresh dialog open meanwhile stays open.
 */

export const DELETE_FAILED_MESSAGE = "An error has occurred. Please refresh the page.";

interface DeleteConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configuration: Configuration | null;
  organizationId: string;
  /** Reloads the list. */
  onDeleted: () => void;
}

export function DeleteConfigurationDialog({
  open,
  onOpenChange,
  configuration,
  organizationId,
  onDeleted,
}: DeleteConfigurationDialogProps) {
  const { revalidate } = useRevalidator();
  const [isDeleting, setIsDeleting] = useState(false);
  const isStillCurrent = useStillCurrent(organizationId);

  const close = () => onOpenChange(false);

  const handleDelete = async () => {
    if (!configuration || isDeleting) return;
    setIsDeleting(true);
    const sentIn = organizationId;
    try {
      await deleteConfiguration(sentIn, configuration.id);
    } catch (error) {
      setIsDeleting(false);
      if (!isStillCurrent(sentIn)) return;
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        close();
        void revalidate();
        return;
      }
      toast.error(configurationRefusalMessage(error, DELETE_FAILED_MESSAGE));
      if (isConfigurationGone(error)) {
        close();
        onDeleted();
      }
      return;
    }
    setIsDeleting(false);
    if (!isStillCurrent(sentIn)) return;
    close();
    onDeleted();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isDeleting) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Configuration</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{" "}
            {configuration?.name
              ? `"${configuration.name}"`
              : "this configuration"}
            ? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void handleDelete();
            }}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
