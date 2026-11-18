import { describe, expect, it } from "vitest";

import {
  attributeDefault,
  DEFAULTS_VERSION,
  DETECTORS,
  K8S_ATTRIBUTES_DEFAULT_METADATA,
  RESOURCE_ATTRIBUTE_DEFAULTS,
} from "./k8s-defaults.js";
import { DETECTOR_DESCRIPTIONS, DETECTOR_GROUPS, RESOURCE_ATTRIBUTE_BOXES } from "./ResourceDetectionProcessorForm.js";

/*
 * The collector's defaults the Kubernetes forms show (D9c decisions 4 to 6;
 * plan Task 3), checked against contrib v0.162.0's sources, read when this
 * test was written and transcribed here with their places: each detector's
 * `metadata.yaml` `resource_attributes` block (under
 * `processor/resourcedetectionprocessor/`), as the attributes it enables
 * and those it doesn't, a gate that is off at v0.162.0 overriding (elastic_beanstalk's).
 */

/** [detector, its metadata.yaml block, enabled by default, not enabled by default] at v0.162.0. */
const METADATA: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
  ["akamai", "internal/akamai/metadata.yaml:11-65", ["cloud.account.id", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.image.id", "host.image.name", "host.name", "host.type"], []],
  ["alibaba_ecs", "internal/alibaba/ecs/metadata.yaml:11-65", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.image.id", "host.name", "host.type"], []],
  ["aks", "internal/azure/aks/metadata.yaml:6-24", ["cloud.platform", "cloud.provider"], ["k8s.cluster.name"]],
  ["azure", "internal/azure/metadata.yaml:12-70", ["azure.resourcegroup.name", "azure.vm.name", "azure.vm.scaleset.name", "azure.vm.size", "cloud.account.id", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.name"], ["cloud.availability_zone"]],
  ["azureappservice", "internal/azure/appservice/metadata.yaml:6-58", ["azure.app_service.instance.id", "azure.resource_group.name", "cloud.account.id", "cloud.platform", "cloud.provider", "cloud.region", "cloud.resource_id", "deployment.environment.name", "service.name"], []],
  ["azurecontainerapps", "internal/azure/containerapps/metadata.yaml:6-28", ["azure.container_app.instance.id", "cloud.platform", "cloud.provider", "service.name"], []],
  ["azurefunctions", "internal/azure/functions/metadata.yaml:6-60", ["azure.resource_group.name", "cloud.account.id", "cloud.platform", "cloud.provider", "cloud.region", "cloud.resource_id", "faas.instance", "service.name"], ["deployment.environment.name"]],
  ["consul", "internal/consul/metadata.yaml:13-31", ["cloud.region", "host.id", "host.name"], []],
  ["digitalocean", "internal/digitalocean/metadata.yaml:11-35", ["cloud.provider", "cloud.region", "host.id", "host.name"], []],
  ["docker", "internal/docker/metadata.yaml:6-30", ["host.name", "os.type"], ["container.image.name", "container.name"]],
  ["ec2", "internal/aws/ec2/metadata.yaml:6-60", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.image.id", "host.name", "host.type"], []],
  ["ecs", "internal/aws/ecs/metadata.yaml:6-96", ["aws.ecs.cluster.arn", "aws.ecs.launchtype", "aws.ecs.task.arn", "aws.ecs.task.family", "aws.ecs.task.id", "aws.ecs.task.revision", "aws.log.group.arns", "aws.log.group.names", "aws.log.stream.arns", "aws.log.stream.names", "cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region"], []],
  ["eks", "internal/aws/eks/metadata.yaml:6-66", ["cloud.platform", "cloud.provider"], ["cloud.account.id", "cloud.availability_zone", "cloud.region", "host.id", "host.image.id", "host.name", "host.type", "k8s.cluster.name"]],
  // metadata.yaml enables all seven; deployment.environment.name and deployment.id are emitted only under the Alpha
  // EmitV1DeploymentConventions gate (elasticbeanstalk.go:79-105; metadata.yaml:15-20), so off (D9c Ruling 43).
  ["elastic_beanstalk", "internal/aws/elasticbeanstalk/metadata.yaml:23-63", ["cloud.platform", "cloud.provider", "deployment.environment", "service.instance.id", "service.version"], ["deployment.environment.name", "deployment.id"]],
  ["gcp", "internal/gcp/metadata.yaml:6-121", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "faas.instance", "faas.name", "faas.version", "gcp.cloud_run.job.execution", "gcp.cloud_run.job.task_index", "gcp.gce.instance_group_manager.name", "gcp.gce.instance_group_manager.region", "gcp.gce.instance_group_manager.zone", "host.id", "host.name", "host.type", "k8s.cluster.name"], ["gcp.gce.instance.hostname", "gcp.gce.instance.name"]],
  ["heroku", "internal/heroku/metadata.yaml:6-52", ["cloud.provider", "heroku.app.id", "heroku.dyno.id", "heroku.release.commit", "heroku.release.creation_timestamp", "service.instance.id", "service.name", "service.version"], []],
  ["hetzner", "internal/hetzner/metadata.yaml:11-47", ["cloud.availability_zone", "cloud.provider", "cloud.region", "host.id", "host.name"], ["cloud.platform"]],
  ["ibmcloud_classic", "internal/ibmcloud/classic/metadata.yaml:11-53", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.resource_id", "host.id", "host.name"], []],
  ["ibmcloud_vpc", "internal/ibmcloud/vpc/metadata.yaml:11-77", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "cloud.resource_id", "host.id", "host.image.id", "host.image.name", "host.name", "host.type"], []],
  ["k8s_api", "internal/k8sapi/metadata.yaml:6-24", ["k8s.cluster.uid", "k8s.node.name", "k8s.node.uid"], []],
  ["k8snode", "internal/k8sapi/metadata.yaml:6-24", ["k8s.cluster.uid", "k8s.node.name", "k8s.node.uid"], []],
  ["kubeadm", "internal/kubeadm/metadata.yaml:6-18", ["k8s.cluster.name", "k8s.cluster.uid"], []],
  ["lambda", "internal/aws/lambda/metadata.yaml:6-60", ["aws.log.group.names", "aws.log.stream.names", "cloud.platform", "cloud.provider", "cloud.region", "faas.instance", "faas.max_memory", "faas.name", "faas.version"], []],
  ["nova", "internal/openstack/nova/metadata.yaml:11-53", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "host.id", "host.name", "host.type"], []],
  ["openshift", "internal/openshift/metadata.yaml:6-30", ["cloud.platform", "cloud.provider", "cloud.region", "k8s.cluster.name"], []],
  ["oraclecloud", "internal/oraclecloud/metadata.yaml:11-71", ["cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.name", "host.type", "k8s.cluster.name", "oracle_cloud.realm"], ["cloud.resource_id"]],
  ["scaleway", "internal/scaleway/metadata.yaml:11-71", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.image.id", "host.image.name", "host.name", "host.type"], []],
  ["system", "internal/system/metadata.yaml:6-106", ["host.name", "os.type"], ["host.arch", "host.cpu.cache.l2.size", "host.cpu.family", "host.cpu.model.id", "host.cpu.model.name", "host.cpu.stepping", "host.cpu.vendor.id", "host.id", "host.interface", "host.ip", "host.mac", "os.build.id", "os.description", "os.name", "os.version"]],
  ["tencent_cvm", "internal/tencent/cvm/metadata.yaml:11-65", ["cloud.account.id", "cloud.availability_zone", "cloud.platform", "cloud.provider", "cloud.region", "host.id", "host.image.id", "host.name", "host.type"], []],
  ["upcloud", "internal/upcloud/metadata.yaml:11-35", ["cloud.provider", "cloud.region", "host.id", "host.name"], []],
  ["vultr", "internal/vultr/metadata.yaml:11-41", ["cloud.provider", "cloud.region", "host.id", "host.name"], ["cloud.platform"]],
];

describe("the defaults at contrib v0.162.0", () => {
  it("reads v0.162.0", () => {
    expect(DEFAULTS_VERSION).toBe("v0.162.0");
  });

  it.each(METADATA)("%s: each resource attribute's default is its metadata.yaml's (%s)", (detector, source, on, off) => {
    const defaults = RESOURCE_ATTRIBUTE_DEFAULTS[detector]!;
    expect(defaults.source).toBe(source);
    expect(Object.keys(defaults.attributes).sort()).toEqual([...on, ...off].sort());
    for (const attribute of on) expect(attributeDefault(detector, attribute)).toBe(true);
    for (const attribute of off) expect(attributeDefault(detector, attribute)).toBe(false);
  });

  it("covers every detector with settings; env and dynatrace have none", () => {
    // `internal/env/env.go` has no Config; `internal/dynatrace/metadata.yaml` has no resource_attributes.
    expect(Object.keys(RESOURCE_ATTRIBUTE_DEFAULTS).sort()).toEqual(METADATA.map(([detector]) => detector).sort());
    expect(DETECTORS.filter((detector) => !(detector in RESOURCE_ATTRIBUTE_DEFAULTS)).sort()).toEqual(["dynatrace", "env"]);
  });

  it("a name outside the table is a programming error, never a default", () => {
    expect(() => attributeDefault("system", "host.nope")).toThrow();
    expect(() => attributeDefault("openstack", "host.id")).toThrow();
  });

  it("the catalog is the 33 names factory.go:73-105 registers: nova, not openstack; k8s_api and its k8snode alias", () => {
    expect(DETECTORS).toHaveLength(33);
    expect(new Set(DETECTORS).size).toBe(33);
    expect(DETECTORS).toContain("nova");
    expect(DETECTORS).not.toContain("openstack");
    for (const added of [
      "alibaba_ecs",
      "azureappservice",
      "azurecontainerapps",
      "azurefunctions",
      "dynatrace",
      "ibmcloud_classic",
      "ibmcloud_vpc",
      "kubeadm",
      "tencent_cvm",
      "k8s_api",
      "k8snode",
    ]) {
      expect(DETECTORS).toContain(added);
    }
  });

  it("k8sattributes' default metadata: metadata.yaml:21-235's enabled attributes, with both conventions gates on", () => {
    // container.image.tag (metadata.yaml:43) is dropped and container.image.tags (:47) kept while
    // DontEmitV0K8sConventions and EmitV1K8sConventions are Beta (generated_feature_gates.go:9-23; options.go:65-72).
    expect([...K8S_ATTRIBUTES_DEFAULT_METADATA]).toEqual([
      "container.image.name",
      "container.image.tags",
      "k8s.deployment.name",
      "k8s.namespace.name",
      "k8s.node.name",
      "k8s.pod.name",
      "k8s.pod.start_time",
      "k8s.pod.uid",
    ]);
  });
});

describe("resourcedetection's form over the catalog", () => {
  it("its groups hold every detector of the catalog once, and each has a description", () => {
    const grouped = DETECTOR_GROUPS.flatMap(([, detectors]) => detectors);
    expect([...grouped].sort()).toEqual([...DETECTORS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const detector of grouped) expect(DETECTOR_DESCRIPTIONS[detector]).toBeTruthy();
    // The groups, in their order.
    expect(DETECTOR_GROUPS.map(([group]) => group)).toEqual([
      "Environment & System",
      "AWS",
      "Azure",
      "Google Cloud",
      "Kubernetes",
      "Container",
      "Other Clouds",
    ]);
  });

  it("every box toggles an attribute its detector has (no key the collector refuses)", () => {
    for (const [detector, attributes] of Object.entries(RESOURCE_ATTRIBUTE_BOXES)) {
      for (const attribute of attributes) expect(RESOURCE_ATTRIBUTE_DEFAULTS[detector]!.attributes).toHaveProperty([attribute]);
    }
  });
});
