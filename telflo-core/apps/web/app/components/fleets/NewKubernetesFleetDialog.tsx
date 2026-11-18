import { NewFleetDialog, type NewFleetDialogProps } from "~/components/fleets/NewFleetDialog.js";

/** What the platform makes for a Kubernetes fleet (D17a Parity Notes): both tokens, shown once, no static token. */
export const KUBERNETES_FLEET_INTRO =
  "No bridge, no operator — just per-pod OpAMP supervisor collectors deployed by Helm into node, cluster, and gateway groups. Collectors report their own configuration when they connect, or you can assign one per group. Once the fleet is created, both of its tokens are shown here once, to copy.";

/**
 * "New Kubernetes Supervisor Fleet" (ADR 0018), a Name only: the rotate token
 * never expires. Its text says what the platform does (both tokens shown
 * once; decision 24). The create itself is `NewFleetDialog`'s.
 */
export function NewKubernetesFleetDialog(props: NewFleetDialogProps) {
  return (
    <NewFleetDialog
      {...props}
      type="kubernetes-supervisor"
      title="New Kubernetes Supervisor Fleet"
      description="Give this fleet a name."
      intro={KUBERNETES_FLEET_INTRO}
      withExpiry={false}
    />
  );
}
