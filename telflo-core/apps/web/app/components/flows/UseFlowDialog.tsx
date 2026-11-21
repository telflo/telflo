import { useEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH,
  CONFIGURATION_NAME_MAXIMUM_LENGTH,
  type Flow,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import { captureEvent } from "~/lib/analytics.js";
import {
  configurationRefusalMessage,
  isOrganizationGone,
  isTermsAcceptanceRequired,
  useStillCurrent,
} from "~/lib/configurations.js";
import {
  FlowNotLoadableError,
  createConfigurationFromFlow,
  flowCopyPin,
  pinMovedSentence,
  type InstantiatedFlow,
} from "~/lib/flows/instantiate-flow.js";
import { useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `UseFlowDialog`: "Use this flow" on a flow's page, the name-and-create
 * step, prefilled with the flow's name and summary so the common case is one
 * click. Its details:
 * - the pin is the flow's, or the distribution's default when the catalog
 *   no longer offers it, which a sentence under "pinned to collector v…"
 *   says; no ClickStack coercion;
 * - it behaves as the create dialog does: Create is enabled once the
 *   trimmed name isn't empty; the name and description are trimmed; Cancel,
 *   Escape, an outside click and the close button do nothing while the
 *   create is under way, and a second create can't start beside it; a
 *   refusal says the API's message, an unreadable flow "This flow could not
 *   be loaded: …", anything else "Failed to use this flow"; a 404
 *   `organization_not_found` or a 403 `terms_acceptance_required` closes it
 *   and revalidates the layout, with no toast; an answer after the dialog
 *   unmounted, or after the organization changed, does nothing;
 * - no "Select an organization first": there is always an active one.
 * `config_created` is captured as the create dialog does, with no properties:
 * no flow's name or text reaches an event. The dialog stays open through the
 * move to the editor, so the gallery doesn't flash underneath.
 */

export const USE_FLOW_FAILED_MESSAGE = "Failed to use this flow";

interface UseFlowDialogProps {
  flow: Flow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UseFlowDialog({ flow, open, onOpenChange }: UseFlowDialogProps) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const organizationId = useCurrentUser()?.organization.id ?? "";
  const isStillCurrent = useStillCurrent(organizationId);
  const { distributions } = useCollectorDistributions(open);
  const pin = flowCopyPin(flow, distributions);
  const moved = pinMovedSentence(pin);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Reentry guard: a double Enter lands before `busy` has re-rendered.
  const creatingRef = useRef(false);
  const [busy, setBusy] = useState(false);

  // Re-seeded on each opening, and for another flow; not by a revalidation
  // that answers the same flow again, which would drop what was typed.
  const { name: flowName, summary: flowSummary } = flow;
  useEffect(() => {
    if (open) {
      setName(flowName);
      setDescription(flowSummary);
    }
  }, [open, flow.slug, flowName, flowSummary]);

  const close = () => {
    if (!creatingRef.current) onOpenChange(false);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (creatingRef.current || !trimmed) return;
    creatingRef.current = true;
    setBusy(true);
    const sentIn = organizationId;
    let instantiated: InstantiatedFlow;
    try {
      instantiated = await createConfigurationFromFlow({
        flow,
        organizationId: sentIn,
        name: trimmed,
        description: description.trim(),
        distributions,
      });
    } catch (error) {
      creatingRef.current = false;
      setBusy(false);
      if (!isStillCurrent(sentIn)) return;
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        onOpenChange(false);
        void revalidate();
        return;
      }
      toast.error(
        error instanceof FlowNotLoadableError ? error.message : configurationRefusalMessage(error, USE_FLOW_FAILED_MESSAGE),
      );
      return;
    }
    // Still busy: the editor replaces this page, and with it the dialog.
    if (!isStillCurrent(sentIn)) {
      creatingRef.current = false;
      setBusy(false);
      return;
    }
    captureEvent("config_created");
    void navigate(instantiated.editorPath);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use this flow</DialogTitle>
          <DialogDescription>
            Creates your own configuration from {flow.name}. Edit it freely — it won&apos;t change when the flow is
            updated.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="flow-config-name" className="mb-2 block">
              Configuration name
            </Label>
            <Input
              id="flow-config-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              autoFocus
              maxLength={CONFIGURATION_NAME_MAXIMUM_LENGTH}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="flow-config-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="flow-config-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH}
            />
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">pinned to collector v{pin.version}</p>
          {moved !== null && <p className="text-[12px] leading-[1.4] text-muted-foreground">{moved}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleCreate();
            }}
            disabled={busy || !name.trim()}
          >
            {busy ? "Creating…" : "Create configuration"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
