import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  CheckboxSetField,
  DESCRIBED_BOX,
  DurationField,
  FormScope,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { presenceOf } from "./shared/section-toggle.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";

/*
 * The kubelet stats receiver's form, over the form's fields: each field
 * writes its own key.
 *
 * - The collector's `auth_type` default is `tls`
 *   (`receiver/kubeletstatsreceiver/factory.go:43-55`); unset shows TLS
 *   Certificate as the placeholder with the hint "Default tls" (Service
 *   Account is marked "(recommended)"), and the per-auth fields follow the
 *   shown value, so an unset `auth_type` shows TLS's certificate fields. The
 *   section opens on its own while TLS shows, as it does for `tls`: its
 *   certificate and key are required.
 * - Unset shows the collector's default: Collection Interval `10s`
 *   (`factory.go:44-45`), Initial Delay `1s` (core scraperhelper's
 *   `NewDefaultControllerConfig`), Metric Groups "Default container, pod,
 *   node" (`factory.go:27-31`, applied only while unset,
 *   `config.go:128-132`). Metric groups and extra metadata labels are
 *   checkbox lists written by item: an unset list shows none ticked, and
 *   the first tick writes that item alone.
 * - Enable Kubernetes API Access writes
 *   `k8s_api_config: {auth_type: serviceAccount}` and unticking removes the
 *   block; it shows ticked while the block is in the text. Its
 *   Authentication Type has no default (`internal/k8sconfig/config.go:90-93`
 *   refuses an empty one), so unset shows none.
 * - Copy: Node Name, Volume Type, the RBAC alert and Enable Kubernetes API
 *   Access's hint say what the collector does: `config.go:137-150`, the
 *   node name is read by the node utilization metrics, which are off by
 *   default; `README.md:188-189`, the kubelet's `/pods` gives the volume
 *   type, and `README.md:232-234`, the API adds the persistent volume's
 *   details; `README.md:329-331`, the permissions.
 * - The row markup: `flex items-start space-x-3` rows, `leading-none` labels,
 *   `text-xs` descriptions.
 *
 * Ids are fixed, by index in the checkbox lists (`metric-group-<index>`); no
 * value reaches an attribute.
 */

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "tls", label: "TLS Certificate" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None (insecure port 10255)" },
] as const;

const K8S_API_AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account" },
  { value: "kubeConfig", label: "Kube Config" },
] as const;

const METRIC_GROUPS = [
  { value: "container", label: "Container" },
  { value: "pod", label: "Pod" },
  { value: "node", label: "Node" },
  { value: "volume", label: "Volume" },
] as const;

const EXTRA_METADATA_LABELS = [
  { value: "container.id", label: "Container ID", description: "Increases metric cardinality" },
  {
    value: "k8s.volume.type",
    label: "Volume Type",
    description: "Cloud provider volume metadata; Kubernetes API access adds persistent volume details.",
  },
] as const;

const AUTH_KEYS = ["auth_type", "ca_file", "cert_file", "key_file", "context", "insecure_skip_verify"] as const;

/** The checkbox rows and their labels here. */
const ROW = "flex items-start space-x-3";
const ROW_LABEL = "text-sm font-medium cursor-pointer leading-none";

/** The collector's `auth_type` while unset (`factory.go:49-53`). */
const DEFAULT_AUTH_TYPE = "tls";

export function KubeletStatsReceiverForm() {
  const form = useForm();
  const authView = form.read(["auth_type"]);
  // What the select shows: the text's value, or the collector's default while unset.
  const authType =
    authView.kind === "absent" ? DEFAULT_AUTH_TYPE : authView.kind === "scalar" ? String(authView.source ?? authView.value) : null;
  const authFieldCount = AUTH_KEYS.filter((key) => isTruthy(form.read([key]))).length;

  const apiView = form.read(["k8s_api_config"]);
  const apiState = presenceOf(apiView);
  const k8sApiFieldCount = apiView.kind === "map" ? Object.values(apiView.value).filter(Boolean).length : 0;
  const apiAuth = form.read(["k8s_api_config", "auth_type"]);

  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="endpoint"
        label="Endpoint"
        description="Kubelet address; ${env:K8S_NODE_NAME} injects the node name."
        placeholder="e.g. https://${env:K8S_NODE_NAME}:10250"
      />

      <DurationField
        path={["collection_interval"]}
        id="collection-interval"
        label="Collection Interval"
        defaultValue="10s"
        description="How often to scrape the kubelet."
      />

      <DurationField
        path={["initial_delay"]}
        id="initial-delay"
        label="Initial Delay"
        defaultValue="1s"
        description="Startup delay before the first collection."
      />

      <TextField
        path={["node"]}
        id="node"
        label="Node Name"
        description="Used by the node utilization metrics, which are off by default."
        placeholder="e.g. ${env:K8S_NODE_NAME}"
      />

      <ConfigSection title="Authentication" count={authFieldCount} defaultOpen={authType === "tls"}>
        <SelectField
          path={["auth_type"]}
          id="auth-type"
          label="Authentication Type"
          defaultValue={DEFAULT_AUTH_TYPE}
          options={AUTH_TYPES}
        />

        {authType === "none" && (
          <InlineAlert variant="warn" title="Insecure configuration">
            The read-only port 10255 is often disabled in modern clusters. Use Service Account authentication instead.
          </InlineAlert>
        )}

        {authType === "serviceAccount" && (
          <div className="space-y-4">
            <TextField
              path={["ca_file"]}
              id="ca-file"
              label="CA File"
              description="Override the mounted service-account CA certificate."
              placeholder="e.g. /var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
            />
            <CheckboxField
              path={["insecure_skip_verify"]}
              id="insecure-skip-verify"
              label="Skip TLS Verification"
              defaultChecked={false}
              labelClassName={ROW_LABEL}
              rowClassName={ROW}
            />
          </div>
        )}

        {authType === "tls" && (
          <div className="space-y-4">
            <TextField
              path={["cert_file"]}
              id="cert-file"
              label="Client Certificate File"
              required
              placeholder="e.g. /path/to/client.crt"
            />
            <TextField path={["key_file"]} id="key-file" label="Client Key File" required placeholder="e.g. /path/to/client.key" />
            <TextField path={["ca_file"]} id="ca-file-tls" label="CA File" placeholder="e.g. /path/to/ca.crt" />
            <CheckboxField
              path={["insecure_skip_verify"]}
              id="insecure-skip-verify-tls"
              label="Skip TLS Verification"
              defaultChecked={false}
              labelClassName={ROW_LABEL}
              rowClassName={ROW}
            />
          </div>
        )}

        {authType === "kubeConfig" && (
          <div className="space-y-4">
            <TextField
              path={["context"]}
              id="context"
              label="Context"
              description="Kubeconfig context; the API server proxies to the kubelet."
              placeholder="e.g. my-cluster-context"
            />
            <CheckboxField
              path={["insecure_skip_verify"]}
              id="insecure-skip-verify-kube"
              label="Skip TLS Verification"
              defaultChecked={false}
              labelClassName={ROW_LABEL}
              rowClassName={ROW}
            />
          </div>
        )}
      </ConfigSection>

      <ConfigSection title="Metrics" count={listLength(form.read(["metric_groups"]))}>
        <CheckboxSetField
          path={["metric_groups"]}
          id="metric-group"
          label="Metric Groups"
          items={METRIC_GROUPS}
          defaultHint="container, pod, node"
          className="space-y-3"
          rowClassName={ROW}
          labelClassName={ROW_LABEL}
        />

        <CheckboxSetField
          path={["extra_metadata_labels"]}
          id="extra-label"
          label="Extra Metadata Labels"
          items={EXTRA_METADATA_LABELS}
          className="space-y-3"
          rowClassName={ROW}
          describedClassName="grid gap-1.5 leading-none"
          descriptionClassName="text-xs text-muted-foreground"
        />

        <ConfigField
          label="Network Interfaces"
          description="Only eth0 is collected by default; collecting all raises cardinality."
        >
          <div className="space-y-3">
            <CheckboxField
              path={["collect_all_network_interfaces", "pod"]}
              id="collect-pod-interfaces"
              label="Collect All Pod Network Interfaces"
              defaultChecked={false}
              labelClassName={ROW_LABEL}
              rowClassName={ROW}
            />
            <CheckboxField
              path={["collect_all_network_interfaces", "node"]}
              id="collect-node-interfaces"
              label="Collect All Node Network Interfaces"
              defaultChecked={false}
              labelClassName={ROW_LABEL}
              rowClassName={ROW}
            />
          </div>
        </ConfigField>
      </ConfigSection>

      <ConfigSection title="Kubernetes API" count={k8sApiFieldCount}>
        <div className="flex items-start space-x-3">
          <Checkbox
            id="enable-k8s-api"
            className={DESCRIBED_BOX}
            checked={apiState !== "off"}
            onCheckedChange={(checked) => {
              if ((checked === true) === (apiState !== "off")) return;
              if (checked === true) form.set(["k8s_api_config"], { auth_type: "serviceAccount" });
              else form.remove(["k8s_api_config"]);
            }}
            disabled={form.disabled || apiState === "unshowable"}
          />
          <div className="grid gap-1.5 leading-none">
            <Label htmlFor="enable-k8s-api" className="text-sm font-medium cursor-pointer">
              Enable Kubernetes API Access
            </Label>
            <p className="text-xs text-muted-foreground">
              Required for node utilization metrics; adds persistent volume details to Volume Type.
            </p>
          </div>
        </div>
        {apiState === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

        {apiState === "on" && (
          <div className="pl-6 space-y-3 border-l-2 border-border">
            <FormScope path={["k8s_api_config"]}>
              <SelectField path={["auth_type"]} id="k8s-api-auth" label="Authentication Type" options={K8S_API_AUTH_TYPES} />
              {apiAuth.kind === "scalar" && apiAuth.value === "kubeConfig" && (
                <TextField path={["context"]} id="k8s-api-context" label="Context" placeholder="e.g. my-cluster-context" />
              )}
            </FormScope>
          </div>
        )}

        <InlineAlert variant="info" title="RBAC permissions">
          The service account needs <span className="font-mono">get</span> on{" "}
          <span className="font-mono">nodes/stats</span>, plus <span className="font-mono">nodes/pods</span> for extra
          metadata labels or request and limit utilization, and <span className="font-mono">get</span> on{" "}
          <span className="font-mono">persistentvolumeclaims</span> and{" "}
          <span className="font-mono">persistentvolumes</span> with Kubernetes API access.
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}
