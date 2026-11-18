import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { CheckboxSetField, DurationField, MultiValueField, SelectField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { isTruthy, listLength } from "./shared/counts.js";

/*
 * The Kubernetes cluster receiver's form (ADR 0018), over the form's fields
 * (D9c decision 2, D9b's contract): each field writes its own key.
 *
 * - Fixed (D9c decisions 3 and 9): Add Namespace and Add Metadata Exporter
 *   hold an empty row until something is typed in it (never writing
 *   `""`). The collector refuses a blank metadata exporter at start
 *   (`receiver/k8sclusterreceiver/watcher.go:467-509`, "exporter is not in
 *   collector config"), and a blank namespace is an informer on every
 *   namespace that still turns the node and namespace watches off
 *   (`watcher.go:213-215`). A row emptied and left is removed.
 * - Node Conditions and Allocatable Types are checkbox lists written by
 *   item (D9c decision 5): an unset list shows none ticked,
 *   and the first tick writes that item alone. Node conditions' collector
 *   default is `[Ready]` (`factory.go:28, 34`), named in the hint "Default
 *   Ready"; allocatable types have none. An item the list holds that isn't
 *   one of the boxes (`storage`, `nvidia.com/gpu`, which the collector reads
 *   as any resource name) shows after them, ticked.
 * - Unset shows the collector's default (D9b decision 3; `factory.go:22-39`):
 *   Authentication Type `serviceAccount`, Distribution `kubernetes`,
 *   Collection Interval `10s`, Metadata Collection Interval `5m`, in the
 *   placeholder and the "Default …" hint, never as values.
 * - Copy (D9c decision 4, Appearance): Namespaces says setting any stops the
 *   node and namespace metrics (`config.go:48-51`, `watcher.go:213-215`);
 *   Metadata Exporters says each must be in a metrics pipeline
 *   (`receiver.go:55-56` looks them up among the metrics exporters).
 *
 * The Namespaces and Metadata Exporters labels point at ids no row has
 * (Ruling 38): a click on them focuses nothing.
 *
 * Ids are fixed per field (`condition-<index>`, `allocatable-<index>`);
 * no value reaches an attribute (decision 10).
 */

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None" },
] as const;

const DISTRIBUTIONS = [
  { value: "kubernetes", label: "Kubernetes" },
  { value: "openshift", label: "OpenShift" },
] as const;

const NODE_CONDITIONS = ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"].map((condition) => ({
  value: condition,
  label: condition,
}));

const ALLOCATABLE_TYPES = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  { value: "ephemeral-storage", label: "Ephemeral Storage" },
  { value: "pods", label: "Pods" },
] as const;

export function K8sClusterReceiverForm() {
  const form = useForm();
  const resourcesCount =
    listLength(form.read(["namespaces"])) +
    listLength(form.read(["node_conditions_to_report"])) +
    listLength(form.read(["allocatable_types_to_report"]));
  const advancedCount = listLength(form.read(["metadata_exporters"])) + (isTruthy(form.read(["k8s_leader_elector"])) ? 1 : 0);

  return (
    <div className="space-y-4">
      <SelectField
        path={["auth_type"]}
        id="auth-type"
        label="Authentication Type"
        defaultValue="serviceAccount"
        options={AUTH_TYPES}
      />

      <SelectField
        path={["distribution"]}
        id="distribution"
        label="Distribution"
        defaultValue="kubernetes"
        description="Affects which metrics are available."
        options={DISTRIBUTIONS}
      />

      <DurationField
        path={["collection_interval"]}
        id="collection-interval"
        label="Collection Interval"
        defaultValue="10s"
        description="How often collected metrics are emitted."
      />

      <DurationField
        path={["metadata_collection_interval"]}
        id="metadata-collection-interval"
        label="Metadata Collection Interval"
        defaultValue="5m"
        description="How often entity metadata is collected."
      />

      <ConfigSection title="Resources" count={resourcesCount}>
        <ConfigField
          label="Namespaces"
          description="Leave empty to monitor all namespaces. Setting any stops node and namespace metrics."
          htmlFor="namespaces"
        >
          <MultiValueField
            path={["namespaces"]}
            placeholder="e.g. kube-system"
            addButtonText="Add Namespace"
            holdEmpty
            vaultAware
          />
        </ConfigField>

        <CheckboxSetField
          path={["node_conditions_to_report"]}
          id="condition"
          label="Node Conditions to Report"
          items={NODE_CONDITIONS}
          defaultHint="Ready"
        />

        <CheckboxSetField
          path={["allocatable_types_to_report"]}
          id="allocatable"
          label="Allocatable Types to Report"
          items={ALLOCATABLE_TYPES}
        />
      </ConfigSection>

      <ConfigSection title="Advanced" count={advancedCount}>
        <ConfigField
          label="Metadata Exporters"
          description="Exporters that sync cluster entity metadata; each must be in a metrics pipeline."
          htmlFor="metadata-exporters"
        >
          <MultiValueField
            path={["metadata_exporters"]}
            placeholder="e.g. signalfx"
            addButtonText="Add Metadata Exporter"
            holdEmpty
            vaultAware
          />
        </ConfigField>

        <TextField
          path={["k8s_leader_elector"]}
          id="leader-elector"
          label="Leader Elector Extension"
          description="Only the elected leader replica collects when multiple collectors run."
          placeholder="e.g. k8s_leader_elector"
        />

        <InlineAlert variant="info" title="RBAC required">
          Needs a ClusterRole with get, list, and watch on pods, nodes, namespaces, events, and workload resources (plus
          clusterresourcequotas on OpenShift).
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}
