import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { MultiValueField, SelectField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { isTruthy } from "./shared/counts.js";

/*
 * The Kubernetes events receiver's form, over the form's fields:
 * each field writes its own key.
 *
 * - Fixed: Add Namespace holds an empty row until something is typed in it
 *   (never writing `""`, which the receiver watches as every namespace,
 *   `receiver/k8seventsreceiver/receiver.go: 200-203`, so `[default, ""]`
 *   would collect everything). A row emptied and left is removed.
 * - Unset shows the collector's default: Authentication Type
 *   `serviceAccount` (`factory.go:26-33`), in the placeholder and the
 *   "Default …" hint, never as the value.
 * - Copy: the RBAC alert asks for get, list and watch on events only, the
 *   README's ClusterRole at v0.162.0 (`README.md:167-186`), not the workload
 *   resources too.
 *
 * Ids are fixed per field; no value reaches an attribute.
 */

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None" },
] as const;

export function K8sEventsReceiverForm() {
  const form = useForm();
  return (
    <div className="space-y-4">
      <SelectField
        path={["auth_type"]}
        id="auth-type"
        label="Authentication Type"
        defaultValue="serviceAccount"
        options={AUTH_TYPES}
      />

      <ConfigField label="Namespaces" description="Leave empty to collect events from all namespaces.">
        <MultiValueField
          path={["namespaces"]}
          placeholder="e.g. kube-system"
          addButtonText="Add Namespace"
          removeLabel="Remove namespace"
          holdEmpty
          vaultAware
        />
      </ConfigField>

      <InlineAlert variant="info" title="RBAC required">
        The collector's service account needs a ClusterRole with <span className="font-mono">get</span>,{" "}
        <span className="font-mono">list</span>, and <span className="font-mono">watch</span> on events.
      </InlineAlert>

      <ConfigSection title="Advanced: Leader Election" count={isTruthy(form.read(["k8s_leader_elector"])) ? 1 : 0}>
        <TextField
          path={["k8s_leader_elector"]}
          id="leader-elector"
          label="Leader Elector Extension"
          description="Elects one replica to collect events, preventing duplicates."
          placeholder="e.g. k8s_leader_elector"
        />
      </ConfigSection>
    </div>
  );
}
