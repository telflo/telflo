/*
 * The collector's defaults the Kubernetes forms show, at contrib v0.162.0.
 * Paths are under `processor/resourcedetectionprocessor/` unless given in
 * full.
 *
 * - `DETECTORS`: the names resourcedetection registers (`factory.go:73-105`),
 *   33 of them. `k8snode` is `k8s_api`'s deprecated alias, registered on its
 *   own and reading its own `k8snode` block (`internal/k8sapi/k8s.go:23-24`;
 *   `config.go:156-160, 265-268`); `nova` is OpenStack's
 *   (`internal/openstack/nova/nova.go:23`); there is no `openstack`.
 * - `RESOURCE_ATTRIBUTE_DEFAULTS`: each detector's resource attributes and
 *   whether the collector emits each one while `resource_attributes.<name>
 *   .enabled` is unset, from the detector's `metadata.yaml`
 *   (`resource_attributes.<name>.enabled`; mdatagen's
 *   `DefaultResourceAttributesConfig`, which each detector's
 *   `CreateDefaultConfig` takes, `config.go:181-215`). `env` and
 *   `dynatrace` have no settings (`internal/env/env.go`,
 *   `internal/dynatrace/metadata.yaml`); `k8snode` and `k8s_api` share
 *   `internal/k8sapi`'s. `elastic_beanstalk` reads its settings under
 *   `elasticbeanstalk` (`config.go:99-100`). Where a feature gate decides
 *   whether an enabled attribute is emitted, the gate's default at v0.162.0
 *   decides (elastic_beanstalk's, below).
 * - `K8S_ATTRIBUTES_DEFAULT_METADATA`: k8sattributes' `extract.metadata`
 *   while unset (`processor/k8sattributesprocessor/factory.go:45-51`): the
 *   attributes its `metadata.yaml` enables (`metadata.yaml:21-235`), less
 *   `container.image.tag` and with `container.image.tags`, as its two
 *   conventions gates are Beta, so on
 *   (`internal/metadata/generated_feature_gates.go:9-23`;
 *   `options.go:50-149`), in the order the hint names them.
 *
 * The `metrics.<name>.enabled` tables take the same shape.
 */

/** The collector version these defaults are read from. */
export const DEFAULTS_VERSION = "v0.162.0";

/** Every detector name resourcedetection registers (`factory.go:73-105`). */
export const DETECTORS = [
  "akamai",
  "alibaba_ecs",
  "aks",
  "azure",
  "azureappservice",
  "azurecontainerapps",
  "azurefunctions",
  "consul",
  "digitalocean",
  "docker",
  "ec2",
  "ecs",
  "eks",
  "elastic_beanstalk",
  "lambda",
  "env",
  "gcp",
  "heroku",
  "hetzner",
  "ibmcloud_classic",
  "ibmcloud_vpc",
  "scaleway",
  "system",
  "openshift",
  "nova",
  "oraclecloud",
  "k8s_api",
  "k8snode",
  "kubeadm",
  "dynatrace",
  "tencent_cvm",
  "upcloud",
  "vultr",
] as const;

export interface DetectorDefaults {
  /** The detector's `metadata.yaml` `resource_attributes` block, under `processor/resourcedetectionprocessor/`. */
  source: string;
  /** Each resource attribute, and whether the collector emits it while its `enabled` is unset. */
  attributes: Readonly<Record<string, boolean>>;
}

/** Each detector's resource attributes and their defaults (`<detector>/metadata.yaml`). */
export const RESOURCE_ATTRIBUTE_DEFAULTS: Readonly<Record<string, DetectorDefaults>> = {
  akamai: {
    source: "internal/akamai/metadata.yaml:11-65",
    attributes: { "cloud.account.id": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.image.id": true, "host.image.name": true, "host.name": true, "host.type": true },
  },
  alibaba_ecs: {
    source: "internal/alibaba/ecs/metadata.yaml:11-65",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.image.id": true, "host.name": true, "host.type": true },
  },
  aks: {
    source: "internal/azure/aks/metadata.yaml:6-24",
    attributes: { "cloud.platform": true, "cloud.provider": true, "k8s.cluster.name": false },
  },
  azure: {
    source: "internal/azure/metadata.yaml:12-70",
    attributes: { "azure.resourcegroup.name": true, "azure.vm.name": true, "azure.vm.scaleset.name": true, "azure.vm.size": true, "cloud.account.id": true, "cloud.availability_zone": false, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.name": true },
  },
  azureappservice: {
    source: "internal/azure/appservice/metadata.yaml:6-58",
    attributes: { "azure.app_service.instance.id": true, "azure.resource_group.name": true, "cloud.account.id": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "cloud.resource_id": true, "deployment.environment.name": true, "service.name": true },
  },
  azurecontainerapps: {
    source: "internal/azure/containerapps/metadata.yaml:6-28",
    attributes: { "azure.container_app.instance.id": true, "cloud.platform": true, "cloud.provider": true, "service.name": true },
  },
  azurefunctions: {
    source: "internal/azure/functions/metadata.yaml:6-60",
    attributes: { "azure.resource_group.name": true, "cloud.account.id": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "cloud.resource_id": true, "deployment.environment.name": false, "faas.instance": true, "service.name": true },
  },
  consul: {
    source: "internal/consul/metadata.yaml:13-31",
    attributes: { "cloud.region": true, "host.id": true, "host.name": true },
  },
  digitalocean: {
    source: "internal/digitalocean/metadata.yaml:11-35",
    attributes: { "cloud.provider": true, "cloud.region": true, "host.id": true, "host.name": true },
  },
  docker: {
    source: "internal/docker/metadata.yaml:6-30",
    attributes: { "container.image.name": false, "container.name": false, "host.name": true, "os.type": true },
  },
  ec2: {
    source: "internal/aws/ec2/metadata.yaml:6-60",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.image.id": true, "host.name": true, "host.type": true },
  },
  ecs: {
    source: "internal/aws/ecs/metadata.yaml:6-96",
    attributes: { "aws.ecs.cluster.arn": true, "aws.ecs.launchtype": true, "aws.ecs.task.arn": true, "aws.ecs.task.family": true, "aws.ecs.task.id": true, "aws.ecs.task.revision": true, "aws.log.group.arns": true, "aws.log.group.names": true, "aws.log.stream.arns": true, "aws.log.stream.names": true, "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true },
  },
  eks: {
    source: "internal/aws/eks/metadata.yaml:6-66",
    attributes: { "cloud.account.id": false, "cloud.availability_zone": false, "cloud.platform": true, "cloud.provider": true, "cloud.region": false, "host.id": false, "host.image.id": false, "host.name": false, "host.type": false, "k8s.cluster.name": false },
  },
  elastic_beanstalk: {
    source: "internal/aws/elasticbeanstalk/metadata.yaml:23-63",
    // metadata.yaml enables all seven, but `deployment.environment.name` and
    // `deployment.id` are emitted only with the Alpha (so off)
    // EmitV1DeploymentConventions gate
    // (`internal/aws/elasticbeanstalk/elasticbeanstalk.go:79-105`;
    // `metadata.yaml:6-20`): off by default at v0.162.0.
    attributes: { "cloud.platform": true, "cloud.provider": true, "deployment.environment": true, "deployment.environment.name": false, "deployment.id": false, "service.instance.id": true, "service.version": true },
  },
  gcp: {
    source: "internal/gcp/metadata.yaml:6-121",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "faas.instance": true, "faas.name": true, "faas.version": true, "gcp.cloud_run.job.execution": true, "gcp.cloud_run.job.task_index": true, "gcp.gce.instance.hostname": false, "gcp.gce.instance.name": false, "gcp.gce.instance_group_manager.name": true, "gcp.gce.instance_group_manager.region": true, "gcp.gce.instance_group_manager.zone": true, "host.id": true, "host.name": true, "host.type": true, "k8s.cluster.name": true },
  },
  heroku: {
    source: "internal/heroku/metadata.yaml:6-52",
    attributes: { "cloud.provider": true, "heroku.app.id": true, "heroku.dyno.id": true, "heroku.release.commit": true, "heroku.release.creation_timestamp": true, "service.instance.id": true, "service.name": true, "service.version": true },
  },
  hetzner: {
    source: "internal/hetzner/metadata.yaml:11-47",
    attributes: { "cloud.availability_zone": true, "cloud.platform": false, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.name": true },
  },
  ibmcloud_classic: {
    source: "internal/ibmcloud/classic/metadata.yaml:11-53",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.resource_id": true, "host.id": true, "host.name": true },
  },
  ibmcloud_vpc: {
    source: "internal/ibmcloud/vpc/metadata.yaml:11-77",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "cloud.resource_id": true, "host.id": true, "host.image.id": true, "host.image.name": true, "host.name": true, "host.type": true },
  },
  k8s_api: {
    source: "internal/k8sapi/metadata.yaml:6-24",
    attributes: { "k8s.cluster.uid": true, "k8s.node.name": true, "k8s.node.uid": true },
  },
  k8snode: {
    source: "internal/k8sapi/metadata.yaml:6-24",
    attributes: { "k8s.cluster.uid": true, "k8s.node.name": true, "k8s.node.uid": true },
  },
  kubeadm: {
    source: "internal/kubeadm/metadata.yaml:6-18",
    attributes: { "k8s.cluster.name": true, "k8s.cluster.uid": true },
  },
  lambda: {
    source: "internal/aws/lambda/metadata.yaml:6-60",
    attributes: { "aws.log.group.names": true, "aws.log.stream.names": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "faas.instance": true, "faas.max_memory": true, "faas.name": true, "faas.version": true },
  },
  nova: {
    source: "internal/openstack/nova/metadata.yaml:11-53",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "host.id": true, "host.name": true, "host.type": true },
  },
  openshift: {
    source: "internal/openshift/metadata.yaml:6-30",
    attributes: { "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "k8s.cluster.name": true },
  },
  oraclecloud: {
    source: "internal/oraclecloud/metadata.yaml:11-71",
    attributes: { "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "cloud.resource_id": false, "host.id": true, "host.name": true, "host.type": true, "k8s.cluster.name": true, "oracle_cloud.realm": true },
  },
  scaleway: {
    source: "internal/scaleway/metadata.yaml:11-71",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.image.id": true, "host.image.name": true, "host.name": true, "host.type": true },
  },
  system: {
    source: "internal/system/metadata.yaml:6-106",
    attributes: { "host.arch": false, "host.cpu.cache.l2.size": false, "host.cpu.family": false, "host.cpu.model.id": false, "host.cpu.model.name": false, "host.cpu.stepping": false, "host.cpu.vendor.id": false, "host.id": false, "host.interface": false, "host.ip": false, "host.mac": false, "host.name": true, "os.build.id": false, "os.description": false, "os.name": false, "os.type": true, "os.version": false },
  },
  tencent_cvm: {
    source: "internal/tencent/cvm/metadata.yaml:11-65",
    attributes: { "cloud.account.id": true, "cloud.availability_zone": true, "cloud.platform": true, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.image.id": true, "host.name": true, "host.type": true },
  },
  upcloud: {
    source: "internal/upcloud/metadata.yaml:11-35",
    attributes: { "cloud.provider": true, "cloud.region": true, "host.id": true, "host.name": true },
  },
  vultr: {
    source: "internal/vultr/metadata.yaml:11-41",
    attributes: { "cloud.platform": false, "cloud.provider": true, "cloud.region": true, "host.id": true, "host.name": true },
  },
};

/** Whether the collector emits `attribute` for `detector` while its `enabled` is unset. */
export function attributeDefault(detector: string, attribute: string): boolean {
  const enabled = RESOURCE_ATTRIBUTE_DEFAULTS[detector]?.attributes[attribute];
  if (enabled === undefined) throw new Error("A resource attribute outside the collector's table.");
  return enabled;
}

/** k8sattributes' `extract.metadata` while unset, at v0.162.0 (see above). */
export const K8S_ATTRIBUTES_DEFAULT_METADATA = [
  "container.image.name",
  "container.image.tags",
  "k8s.deployment.name",
  "k8s.namespace.name",
  "k8s.node.name",
  "k8s.pod.name",
  "k8s.pod.start_time",
  "k8s.pod.uid",
] as const;
