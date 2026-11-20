import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  CheckboxSetField,
  DESCRIBED_BOX,
  DurationField,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useCheckboxSet,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { attributeDefault } from "./k8s-defaults.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";

/*
 * The resource detection processor's form, over the form's fields: each field
 * writes its own key. Collector paths are
 * `processor/resourcedetectionprocessor/` at contrib v0.162.0.
 *
 * - Detectors: collapsible groups of checkboxes over `detectors`, written
 *   by item (`useCheckboxSet`, `CheckboxSetField`'s reading and writing):
 *   ticking appends the detector (no reorder: the hint says to reorder in
 *   the YAML), unticking removes its lines. Unset shows none ticked, with
 *   the collector's default in the hint, "Default env"
 *   (`factory.go:129-131`), and the first tick writes that detector alone.
 *   Ids are `detector-<index>`.
 * - Changed: the catalog is the collector's (`k8s-defaults.ts` `DETECTORS`,
 *   `factory.go:73-105`): `nova` in place of `openstack`, which isn't a
 *   detector (the collector refuses it, "invalid detector key"); ten more
 *   detectors, each in the group it fits (Azure's three in Azure;
 *   `k8s_api`, `k8snode`'s current name, beside it and `kubeadm` in
 *   Kubernetes; `dynatrace`, which reads the OneAgent's file on the host,
 *   in Environment & System; the other clouds' in Other Clouds), with no
 *   settings sections. A detector the text holds that isn't one of them
 *   (`openstack`) shows after the groups, ticked, as text, so it can be
 *   unticked and is never lost.
 * - Fixed: the ECS, GCP and Docker "Client Timeout" fields are
 *   gone: they wrote `client_config.timeout`, which those detectors don't
 *   have (`internal/aws/ecs/config.go:11`, `internal/gcp/config.go:13-14`,
 *   `internal/docker/config.go:11`) and the collector refuses; the
 *   top-level Timeout is their HTTP client's (`config.go:56-58`). A key
 *   already in the text is left alone.
 * - Fixed: each resource attribute's box shows the collector's default
 *   while its `enabled` is unset (`k8s-defaults.ts`, each detector's
 *   `metadata.yaml`), not every one ticked (most of eks' and system's are
 *   off). A box writes
 *   `<detector>.resource_attributes.<attribute>.enabled: <bool>`. The boxes
 *   are a fixed set; ids are `<detector>-attr-<index>`, never the name.
 * - Changed: the Kubernetes Node section edits `k8snode.*`, which only the
 *   `k8snode` detector reads (`config.go:156-160, 265-268`); it shows for
 *   `k8snode` alone, and `k8s_api` has no section. Its Authentication Type
 *   shows the collector's default while unset, "Default serviceAccount"
 *   (`internal/k8sapi/config.go:51-55`).
 * - OpenShift's TLS is the shared section's client variant: `openshift.tls`
 *   is a client's (`configtls.ClientConfig`,
 *   `internal/openshift/config.go:50-52`), which refuses the server
 *   variant's Client CA File and its reload. Its hint says what off means
 *   there: with no CA file, the service account's CA
 *   (`internal/openshift/config.go:75-77`).
 * - Fixed: Add Tag Pattern holds an empty row until something is typed in it
 *   (never `""`, an empty regex, which matches every tag).
 * - Kept: Hostname Sources shows `dns` and `os` ticked while unset, the
 *   collector's default (`internal/system/system.go:48-50`), and its first
 *   toggle writes them with the change. Fixed: an empty list shows so too, as
 *   the collector reads `[]` as its default (same lines); unticking the last
 *   still leaves `[]`.
 *   Kept: the AWS order alert; the selected detectors' chips; each
 *   section's count and empty text.
 * - Unset shows the collector's default: Timeout `5s`
 *   (`factory.go:153-157`), Override on (`factory.go:133`), Max Attempts 3
 *   and Max Backoff `20s` (`internal/aws/ec2/config.go:34-40`).
 *
 * Every id is fixed per field or by index; no value reaches an attribute.
 */

/** The detector groups, with the collector's catalog at v0.162.0. */
export const DETECTOR_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["Environment & System", ["env", "system", "dynatrace"]],
  ["AWS", ["lambda", "elastic_beanstalk", "ec2", "ecs", "eks"]],
  ["Azure", ["azure", "aks", "azureappservice", "azurecontainerapps", "azurefunctions"]],
  ["Google Cloud", ["gcp"]],
  ["Kubernetes", ["k8snode", "k8s_api", "openshift", "kubeadm"]],
  ["Container", ["docker"]],
  [
    "Other Clouds",
    [
      "heroku",
      "consul",
      "digitalocean",
      "hetzner",
      "akamai",
      "scaleway",
      "vultr",
      "upcloud",
      "nova",
      "oraclecloud",
      "alibaba_ecs",
      "ibmcloud_classic",
      "ibmcloud_vpc",
      "tencent_cvm",
    ],
  ],
];

export const DETECTOR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  env: "Environment variables (OTEL_RESOURCE_ATTRIBUTES)",
  system: "Host and OS information",
  dynatrace: "Dynatrace OneAgent host metadata",
  lambda: "AWS Lambda runtime",
  elastic_beanstalk: "AWS Elastic Beanstalk",
  ec2: "AWS EC2 instance metadata",
  ecs: "AWS ECS task metadata",
  eks: "AWS Elastic Kubernetes Service",
  azure: "Azure VM instance metadata",
  aks: "Azure Kubernetes Service",
  azureappservice: "Azure App Service",
  azurecontainerapps: "Azure Container Apps",
  azurefunctions: "Azure Functions",
  gcp: "Google Cloud Platform (GCE, GKE, Cloud Run, etc.)",
  k8snode: "Kubernetes node metadata",
  k8s_api: "Kubernetes node and cluster metadata (replaces k8snode)",
  openshift: "Red Hat OpenShift cluster",
  kubeadm: "Kubeadm cluster metadata",
  docker: "Docker container runtime",
  heroku: "Heroku dyno metadata",
  consul: "HashiCorp Consul",
  digitalocean: "DigitalOcean droplet",
  hetzner: "Hetzner Cloud",
  akamai: "Akamai Linode",
  scaleway: "Scaleway instance",
  vultr: "Vultr instance",
  upcloud: "UpCloud server",
  nova: "OpenStack Nova instance",
  oraclecloud: "Oracle Cloud Infrastructure",
  alibaba_ecs: "Alibaba Cloud ECS instance",
  ibmcloud_classic: "IBM Cloud Classic instance",
  ibmcloud_vpc: "IBM Cloud VPC instance",
  tencent_cvm: "Tencent Cloud CVM instance",
};

const CATALOG = DETECTOR_GROUPS.flatMap(([, detectors]) => detectors);

const HOSTNAME_SOURCES = [
  { value: "dns", label: "DNS - FQDN via DNS lookup" },
  { value: "os", label: "OS - Kernel-reported hostname" },
  { value: "cname", label: "CNAME - Canonical name lookup" },
  { value: "lookup", label: "LOOKUP - Reverse DNS of the host IP" },
] as const;

const AUTH_TYPES = [
  { value: "serviceAccount", label: "Service Account (recommended)" },
  { value: "kubeConfig", label: "Kube Config" },
  { value: "none", label: "None" },
] as const;

/** The OpenShift TLS box's hint: off, the collector trusts the service account's CA (`internal/openshift/config.go:75-77`). */
export const OPENSHIFT_TLS_HINT = "Off: the collector uses TLS with the service account's CA.";

/** The resource attributes the boxes toggle, per detector (no others). */
export const RESOURCE_ATTRIBUTE_BOXES: Readonly<Record<string, readonly string[]>> = {
  ec2: [
    "cloud.provider",
    "cloud.platform",
    "cloud.account.id",
    "cloud.region",
    "cloud.availability_zone",
    "host.id",
    "host.image.id",
    "host.name",
    "host.type",
  ],
  ecs: [
    "cloud.provider",
    "cloud.platform",
    "cloud.account.id",
    "cloud.region",
    "cloud.availability_zone",
    "aws.ecs.cluster.arn",
    "aws.ecs.task.arn",
    "aws.ecs.task.family",
    "aws.ecs.task.id",
    "aws.ecs.task.revision",
    "aws.ecs.launchtype",
    "aws.log.group.names",
    "aws.log.group.arns",
    "aws.log.stream.names",
    "aws.log.stream.arns",
  ],
  eks: [
    "cloud.provider",
    "cloud.platform",
    "cloud.account.id",
    "cloud.availability_zone",
    "cloud.region",
    "host.id",
    "host.image.id",
    "host.name",
    "host.type",
    "k8s.cluster.name",
  ],
  azure: [
    "cloud.provider",
    "cloud.platform",
    "cloud.account.id",
    "cloud.region",
    "cloud.availability_zone",
    "host.id",
    "host.name",
    "azure.vm.name",
    "azure.vm.size",
    "azure.vm.scaleset.name",
    "azure.resourcegroup.name",
  ],
  gcp: [
    "cloud.provider",
    "cloud.platform",
    "cloud.account.id",
    "cloud.region",
    "cloud.availability_zone",
    "host.id",
    "host.name",
    "host.type",
    "faas.instance",
    "faas.name",
    "faas.version",
    "gcp.cloud_run.job.execution",
    "gcp.cloud_run.job.task_index",
    "gcp.gce.instance.hostname",
    "gcp.gce.instance.name",
    "k8s.cluster.name",
  ],
  system: [
    "host.name",
    "host.id",
    "os.type",
    "os.description",
    "host.arch",
    "host.ip",
    "host.mac",
    "host.cpu.model.name",
    "host.cpu.model.id",
    "host.cpu.stepping",
    "host.cpu.cache.l2.size",
    "host.cpu.family",
    "host.cpu.vendor.id",
    "host.interface",
    "os.name",
    "os.version",
    "os.build.id",
  ],
  docker: ["container.image.name", "container.name", "host.name", "os.type"],
  k8snode: ["k8s.node.name", "k8s.node.uid"],
};

const AWS_DETECTORS = ["lambda", "elastic_beanstalk", "ec2", "ecs", "eks"];
const AWS_DETECTOR_ORDER = ["lambda", "elastic_beanstalk", "eks", "ecs", "ec2"];

/** The per-detector boxes: each shows the collector's default while its `enabled` is unset. */
function ResourceAttributeToggles({ detector }: { detector: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px] font-medium">Resource Attributes</Label>
      {(RESOURCE_ATTRIBUTE_BOXES[detector] ?? []).map((attribute, index) => (
        <CheckboxField
          key={attribute}
          path={[detector, "resource_attributes", attribute, "enabled"]}
          id={`${detector}-attr-${index}`}
          label={attribute}
          defaultChecked={attributeDefault(detector, attribute)}
          labelClassName="cursor-pointer font-mono text-xs font-normal"
        />
      ))}
    </div>
  );
}

export function ResourceDetectionProcessorForm() {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set(["Environment & System", "AWS"]));
  const detectors = useCheckboxSet({ path: ["detectors"], items: CATALOG });
  const selectedDetectors = detectors.values ?? [];
  const has = (detector: string) => selectedDetectors.includes(detector);

  const toggleGroup = (group: string) => {
    const next = new Set(expandedGroups);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    setExpandedGroups(next);
  };

  // AWS-specific detector order warning
  const hasAWSDetectors = selectedDetectors.some((d) => AWS_DETECTORS.includes(d));
  const hasSuboptimalAWSOrder =
    hasAWSDetectors &&
    selectedDetectors.some((d, i) =>
      selectedDetectors.slice(i + 1).some((later) => {
        const currentIdx = AWS_DETECTOR_ORDER.indexOf(d);
        const laterIdx = AWS_DETECTOR_ORDER.indexOf(later);
        return currentIdx !== -1 && laterIdx !== -1 && laterIdx < currentIdx;
      }),
    );

  const awsConfigurableCount = selectedDetectors.filter((d) => ["ec2", "ecs", "eks"].includes(d)).length;
  const cloudConfigurableCount = selectedDetectors.filter((d) => ["azure", "gcp", "system", "docker"].includes(d)).length;
  const k8sConfigurableCount = selectedDetectors.filter((d) => ["k8snode", "openshift"].includes(d)).length;

  const detectorRow = (detector: string, index: number, description?: string) => {
    const boxId = `detector-${index}`;
    const checked = detectors.isTicked(detector);
    return (
      <div key={index} className="flex items-start gap-2">
        <Checkbox
          id={boxId}
          className={DESCRIBED_BOX}
          checked={checked}
          onCheckedChange={(next) => {
            if ((next === true) !== checked) detectors.toggle(detector, next === true);
          }}
          disabled={detectors.disabled}
        />
        <div className="flex-1 grid gap-0.5">
          <Label htmlFor={boxId} className="cursor-pointer text-sm font-medium">
            {detector}
          </Label>
          {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <DurationField
        path={["timeout"]}
        id="timeout"
        label="Timeout"
        defaultValue="5s"
        description="Maximum time to wait for all detectors."
      />

      <CheckboxField
        path={["override"]}
        id="override"
        label="Override Existing Attributes"
        defaultChecked
        description="Detected values replace attributes already present."
      />

      {/* Detector Selection */}
      <ConfigField label="Detectors" description="Order matters: the first detector wins; reorder via the YAML editor." defaultValue="env">
        <div className="space-y-2">
          {DETECTOR_GROUPS.map(([group, groupDetectors]) => (
            <div key={group} className="rounded-md border border-border">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                className="flex w-full items-center justify-between p-2.5 transition-colors hover:bg-accent"
              >
                <span className="text-sm font-medium text-foreground">{group}</span>
                {expandedGroups.has(group) ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {expandedGroups.has(group) && (
                <div className="space-y-2 p-2.5 pt-0">
                  {groupDetectors.map((detector) => detectorRow(detector, CATALOG.indexOf(detector), DETECTOR_DESCRIPTIONS[detector]))}
                </div>
              )}
            </div>
          ))}
          {detectors.extras.length > 0 && (
            <div className="space-y-2 p-2.5">
              {detectors.extras.map((detector, index) => detectorRow(detector, CATALOG.length + index))}
            </div>
          )}
        </div>
        {detectors.unshowable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      {hasSuboptimalAWSOrder && (
        <InlineAlert variant="warn" title="AWS detector order">
          Use <span className="font-mono">lambda → elastic_beanstalk → eks → ecs → ec2</span> so specific environments take
          precedence over generic EC2.
        </InlineAlert>
      )}

      {selectedDetectors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedDetectors.map((detector, index) => (
            <span key={index} className="rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-xs">
              {detector}
            </span>
          ))}
        </div>
      )}

      {/* AWS Detector Configuration */}
      <ConfigSection title="AWS Detectors" count={awsConfigurableCount}>
        {has("ec2") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">EC2</h3>

            <MultiValueField
              path={["ec2", "tags"]}
              label="Tag Patterns"
              placeholder="e.g. ^environment$, ^team-.*"
              helpText="Regex for tag names to attach; requires the ec2:DescribeTags permission."
              addButtonText="Add Tag Pattern"
              holdEmpty
            />

            <NumberField
              path={["ec2", "max_attempts"]}
              id="ec2-max-attempts"
              label="Max Attempts"
              defaultValue="3"
              description="Retry attempts for the metadata endpoint."
            />

            <DurationField
              path={["ec2", "max_backoff"]}
              id="ec2-max-backoff"
              label="Max Backoff"
              defaultValue="20s"
              description="Maximum backoff between retries."
            />

            <CheckboxField
              path={["ec2", "fail_on_missing_metadata"]}
              id="ec2-fail-missing"
              label="Fail on Missing Metadata"
              defaultChecked={false}
            />

            <ResourceAttributeToggles detector="ec2" />
          </div>
        )}

        {has("ecs") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">ECS</h3>

            <ResourceAttributeToggles detector="ecs" />
          </div>
        )}

        {has("eks") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">EKS</h3>

            <InlineAlert variant="info" title="Runs in-cluster only">
              Requires <span className="font-mono">KUBERNETES_SERVICE_HOST</span> and{" "}
              <span className="font-mono">KUBERNETES_SERVICE_PORT</span> to be defined.
            </InlineAlert>

            <TextField
              path={["eks", "node_from_env_var"]}
              id="eks-node-env"
              label="Node Environment Variable"
              description="Environment variable holding the node name."
              placeholder="e.g. K8S_NODE_NAME"
            />

            <ResourceAttributeToggles detector="eks" />
          </div>
        )}

        {!selectedDetectors.some((d) => ["ec2", "ecs", "eks"].includes(d)) && (
          <p className="text-xs text-muted-foreground">Select the EC2, ECS, or EKS detector above to configure it here.</p>
        )}
      </ConfigSection>

      {/* Cloud & System Configuration */}
      <ConfigSection title="Cloud & System Detectors" count={cloudConfigurableCount}>
        {has("azure") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">Azure</h3>

            <MultiValueField
              path={["azure", "tags"]}
              label="Tag Patterns"
              placeholder="e.g. ^environment$, ^team-.*"
              helpText="Regex patterns for instance tag names to attach."
              addButtonText="Add Tag Pattern"
              holdEmpty
            />

            <ResourceAttributeToggles detector="azure" />
          </div>
        )}

        {has("gcp") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">GCP</h3>

            <ResourceAttributeToggles detector="gcp" />
          </div>
        )}

        {has("system") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">System</h3>

            <CheckboxSetField
              path={["system", "hostname_sources"]}
              id="hostname"
              label="Hostname Sources"
              description="Methods tried in priority order."
              defaultHint="dns, os"
              items={HOSTNAME_SOURCES}
              unsetShows={["dns", "os"]}
              emptyIsUnset
              className="space-y-2"
            />

            <ResourceAttributeToggles detector="system" />
          </div>
        )}

        {has("docker") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">Docker</h3>

            <InlineAlert variant="info" title="Docker socket required">
              Needs access to <span className="font-mono">/var/run/docker.sock</span> (Linux).
            </InlineAlert>

            <ResourceAttributeToggles detector="docker" />
          </div>
        )}

        {!selectedDetectors.some((d) => ["azure", "gcp", "system", "docker"].includes(d)) && (
          <p className="text-xs text-muted-foreground">Select the Azure, GCP, System, or Docker detector above to configure it here.</p>
        )}
      </ConfigSection>

      {/* Kubernetes Configuration */}
      <ConfigSection title="Kubernetes Detectors" count={k8sConfigurableCount}>
        {has("k8snode") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">Kubernetes Node</h3>

            <SelectField
              path={["k8snode", "auth_type"]}
              id="k8s-auth-type"
              label="Authentication Type"
              defaultValue="serviceAccount"
              options={AUTH_TYPES}
            />

            <TextField
              path={["k8snode", "node_from_env_var"]}
              id="k8s-node-env"
              label="Node Environment Variable"
              description="Environment variable holding the node name."
              placeholder="e.g. K8S_NODE_NAME"
            />

            <ResourceAttributeToggles detector="k8snode" />
          </div>
        )}

        {has("openshift") && (
          <div className="space-y-3 rounded-md border border-border p-2.5">
            <h3 className="text-sm font-medium text-foreground">OpenShift</h3>

            <TextField
              path={["openshift", "address"]}
              id="openshift-address"
              label="Kubernetes API Address"
              placeholder="e.g. https://kubernetes.default:443"
            />

            <TextField
              path={["openshift", "token"]}
              id="openshift-token"
              type="password"
              label="Service Account Token"
              description="Overrides the default service account token."
            />

            <TLSConfigSection path={["openshift", "tls"]} protocolLabel="OpenShift API" variant="client" clientHint={OPENSHIFT_TLS_HINT} />
          </div>
        )}

        {!selectedDetectors.some((d) => ["k8snode", "openshift"].includes(d)) && (
          <p className="text-xs text-muted-foreground">Select the Kubernetes Node or OpenShift detector above to configure it here.</p>
        )}
      </ConfigSection>
    </div>
  );
}
