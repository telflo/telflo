import { z } from "zod";
import {
  CollectorGroupNamespaceSchema,
  CollectorGroupReplicasSchema,
  gatewayNameProblem,
  KUBERNETES_DEFAULT_NAMESPACE,
  KUBERNETES_ROLES,
  KubernetesAnnotationsSchema,
  kubernetesNamespaceProblem,
  KubernetesVolumesSchema,
  type KubernetesRole,
  type KubernetesVolume,
} from "./fleets.js";
import {
  INSTALL_ENV_MAXIMUM,
  INSTALL_ENV_NAME_MAXIMUM_LENGTH,
  INSTALL_ENV_NAME_PATTERN,
  installEnvValueProblem,
  RESERVED_INSTALL_ENV_NAMES,
  shellQuote,
} from "./install.js";
import { QUICK_DEPLOY_URL_PATTERN } from "./quick-deploy.js";
import { BEARER_PATTERN } from "./quick-deploy-command.js";

/*
 * The Kubernetes-supervisor fleet's Helm install (D17d-2 decisions 15 to 18;
 * Preflight rulings 1, 4, 6, 7 and 8): the facts a Kubernetes group's install
 * reads (no bearer), the values file the platform's chart takes (D18:
 * `charts/supervisor-collector`) (`helmValuesYaml`: the browser's download
 * and a Helm values link's public download render it alike; the browser saves
 * it as `helmValuesFileName(release, fragment)`, a link's curl as
 * `helmValuesFileName(release)`), and the commands the dialogs show (`helm
 * upgrade --install … -f '<release>-values[-<fragment>].yaml'`, the link's
 * `curl … -o '<release>-values.yaml'`, `helm uninstall`). Pure: no request,
 * no environment.
 *
 *   GET …/fleets/{fleetId}/groups/{groupId}/install   HelmInstallFactsSchema (a Kubernetes group's)
 *
 * The values file holds the fleet's default token's bearer: it is a secret
 * as an install command is (ADR 0024): built in memory, handed to the
 * download, never kept, logged or put in a URL. A Quick Deploy command
 * holds the link's secret. Release names, namespaces, variable names and
 * values are configuration text. So no message here holds a value: a
 * backstop's throw (`HelmBuildError`) names the field only.
 */

/**
 * The platform's own published chart and its version (D18 decisions 9 and
 * 10): TELFLO_HELM_CHART_REFERENCE's and TELFLO_HELM_CHART_VERSION's
 * defaults. `scripts/publish-chart.sh` reads both lines exactly and checks
 * them against `charts/supervisor-collector/Chart.yaml`: a chart change bumps
 * both together.
 */
export const DEFAULT_HELM_CHART_REFERENCE = "oci://ghcr.io/telflo/telflo/charts/supervisor-collector";
export const DEFAULT_HELM_CHART_VERSION = "0.1.0";

/**
 * TELFLO_HELM_CHART_REFERENCE's form (Preflight ruling 6): an `oci://`
 * reference of lowercase letters, digits and `._:/-` (a mirror's port too),
 * nothing a shell's `'…'` reads specially.
 */
export const HELM_CHART_REFERENCE_PATTERN = /^oci:\/\/[a-z0-9]+([._:/-][a-z0-9]+)*$/;

/** TELFLO_HELM_CHART_VERSION's form: an exact `x.y.z`, no leading zero, no `v`. */
export const HELM_CHART_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * An image repository with nothing a shell or YAML reads specially
 * (D17c-1 decision 34): TELFLO_COLLECTOR_IMAGE_REPOSITORY's
 * form, and the values' `image.repository`.
 */
export const COLLECTOR_IMAGE_REPOSITORY_PATTERN = /^[a-z0-9]+([._:/-][a-z0-9]+)*$/;

/**
 * The agent endpoint's form (D17c-1 decision 34, tightened): http(s) or
 * ws(s), a host name or an IPv4 or bracketed IPv6 address, a port, a path of
 * letters, digits and `._~%/+-`; no user name, query or fragment. Nothing a
 * shell, YAML or a placeholder reads specially. TELFLO_OPAMP_AGENT_PUBLIC_URL's
 * rule, the Linux bundle's backstop and the values' `endpoint`.
 */
export const AGENT_ENDPOINT_PATTERN =
  /^(?:https?|wss?):\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/+-]*)?$/;

/**
 * The variables the platform's chart sets on the collector's container
 * itself (`charts/supervisor-collector/templates/_helpers.tpl:99-106`,
 * `tsc.collectorEnv`; D18 Q65;
 * Preflight ruling 4): its explicit `env` beats `collectorEnv`'s `envFrom`
 * (`tsc.collectorEnvFrom`), so a value typed for one of them would be
 * silently ignored. A Kubernetes group's facts leave them out.
 */
export const HELM_CHART_ENV_NAMES = ["POD_NAMESPACE", "POD_NAME", "NODE_NAME", "HOST_IP"] as const;

/**
 * A Helm values link's refusal of one of HELM_CHART_ENV_NAMES (D17d-2
 * Ruling 41): the chart's own, so a typed value would be ignored. No name
 * in its words.
 */
export const HELM_CHART_ENV_NAME_MESSAGE = "The chart sets this variable itself: it can't be set here.";

/**
 * The public Helm values download's Content-Disposition file name (D17d-2
 * Ruling 36): the Quick Deploy command's curl names its own file with `-o`
 * (`helmValuesFileName`), so this is only what a browser opening the link
 * would save.
 */
export const HELM_VALUES_DOWNLOAD_NAME = "values.yaml";

/** The Agent's and the Cluster's releases (the chart's own object names); a gateway's is its name. */
export const HELM_AGENT_RELEASE = "telflo-node";
export const HELM_CLUSTER_RELEASE = "telflo-cluster";

/** A group's Helm release (decision 3): `telflo-node` for the Agent, `telflo-cluster` for the Cluster, a gateway's name. */
export function helmReleaseName(role: KubernetesRole, name: string): string {
  switch (role) {
    case "node":
      return HELM_AGENT_RELEASE;
    case "cluster":
      return HELM_CLUSTER_RELEASE;
    case "gateway":
      return name;
  }
}

/** A UUID, any case: a group's id (the values' `collectorGroupId`, the chart's guard) and a fleet's. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A group's name's slug in the chart's names: at most 40 characters. */
const FULLNAME_SLUG_MAXIMUM_LENGTH = 40;

/**
 * The chart's `fullnameOverride` for the Agent: the fleet id's 8 characters,
 * `-`, a slug (a DNS-1123 label of at most 49 characters in all); for the
 * Cluster exactly `<8 hex>-cluster` (D18 Preflight ruling 10).
 */
const AGENT_FULLNAME_OVERRIDE_PATTERN = /^[0-9a-f]{8}-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const CLUSTER_FULLNAME_OVERRIDE_PATTERN = /^[0-9a-f]{8}-cluster$/;
const FULLNAME_OVERRIDE_MAXIMUM_LENGTH = 8 + 1 + FULLNAME_SLUG_MAXIMUM_LENGTH;

/**
 * A group's name's slug: lowercase, every run of anything but `a-z0-9` one
 * `-`, `-` trimmed, at most 40 characters, `-` trimmed again after the slice
 * (so a cut landing on a separator never leaves a trailing `-`, which is no
 * DNS-1123 label), `group` when nothing is left (D18 Preflight ruling 11).
 */
function groupNameSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, FULLNAME_SLUG_MAXIMUM_LENGTH)
      .replace(/-+$/g, "") || "group"
  );
}

/**
 * A group's `fullnameOverride` (D18 decision 21; Preflight ruling 11): the
 * chart's object names for the Agent and the Cluster, so two fleets' groups
 * share a cluster: the fleet id's
 * first 8 characters lowercased, `-`, the group's name's slug (`Default` →
 * `<8>-default`, `cluster` → `<8>-cluster`); `null` for a gateway (its name
 * is its objects' name). Built on the server from the fleet's id and the
 * group's name, never typed (decision 19). Throws
 * `HelmBuildError("fleetId")` on a fleet id that isn't a UUID.
 */
export function helmFullnameOverride(fleetId: string, role: KubernetesRole, groupName: string): string | null {
  if (typeof fleetId !== "string" || !UUID.test(fleetId)) throw new HelmBuildError("fleetId");
  if (role === "gateway") return null;
  return `${fleetId.slice(0, 8).toLowerCase()}-${groupNameSlug(groupName)}`;
}

/**
 * Whether `fullnameOverride` has its role's shape (Preflight ruling 10):
 * none for a gateway; the Agent's a DNS-1123 label of `<8 hex>-<slug>`, at
 * most 49 characters; the Cluster's exactly `<8 hex>-cluster`. Whether its 8
 * characters are the fleet's is checked where the fleet's id is known (the
 * facts carry none).
 */
function fullnameOverrideFits(role: KubernetesRole, fullnameOverride: string | null): boolean {
  if (role === "gateway") return fullnameOverride === null;
  if (typeof fullnameOverride !== "string" || fullnameOverride.length > FULLNAME_OVERRIDE_MAXIMUM_LENGTH) return false;
  return (role === "cluster" ? CLUSTER_FULLNAME_OVERRIDE_PATTERN : AGENT_FULLNAME_OVERRIDE_PATTERN).test(fullnameOverride);
}

const RELEASES: readonly string[] = [HELM_AGENT_RELEASE, HELM_CLUSTER_RELEASE];

function checkedRelease(release: string): string {
  if (typeof release !== "string" || !(RELEASES.includes(release) || gatewayNameProblem(release) === null)) {
    throw new HelmBuildError("release");
  }
  return release;
}

/** A browser download's fragment (D17d-2 Ruling 37): exactly 8 lowercase hex digits. */
export const HELM_VALUES_FRAGMENT_PATTERN = /^[0-9a-f]{8}$/;

/**
 * The values file's name for a release (D17d-2 Rulings 36 and 37):
 * `<release>-values.yaml` without `unique` (a link's curl, the Quick Deploy
 * path), `<release>-values-<unique>.yaml` with it (a browser download, its
 * `unique` a fresh `helmDownloadFragment` per download).
 *
 * What holds, and how:
 * - within a fleet, the per-release name tells its groups apart: one
 *   group's install never names another group's file;
 * - the browser's per-download fragment makes the printed command name the
 *   file THIS download saved: two downloads are two names (never the
 *   older file, whose token may be revoked), and another fleet's Agent
 *   (whose release is also `telflo-node`) is another name, never this one;
 * - curl's `-o` overwrites the file it names, and `&&` stops the install
 *   when the download fails, so the curl path needs no fragment;
 * - a browser that saved the download under another name anyway (its own
 *   rename, a sandbox) is the dialog's "saved under another name" sentence:
 *   the last resort, not a guarantee of this function.
 *
 * Throws `HelmBuildError` on a release outside its rule (`release`) or a
 * `unique` that isn't 8 lowercase hex digits (`unique`).
 */
export function helmValuesFileName(release: string, unique?: string): string {
  const checked = checkedRelease(release);
  if (unique === undefined) return `${checked}-values.yaml`;
  if (typeof unique !== "string" || !HELM_VALUES_FRAGMENT_PATTERN.test(unique)) throw new HelmBuildError("unique");
  return `${checked}-values-${unique}.yaml`;
}

/**
 * A browser download's fragment (Ruling 37) from 4 random bytes: 8
 * lowercase hex digits. The dialog passes `crypto.getRandomValues(new
 * Uint8Array(4))`, fresh for each download; tests pass fixed bytes. Throws
 * `HelmBuildError("random")` on anything but 4 bytes.
 */
export function helmDownloadFragment(random: Uint8Array): string {
  if (!(random instanceof Uint8Array) || random.length !== 4) throw new HelmBuildError("random");
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `name` is one of `release`'s values files (Ruling 37):
 * `^<release>-values(-[0-9a-f]{8})?\.yaml$` for THIS release, so another
 * release's file (another group's) is never one. False for a release
 * outside its rule.
 */
export function isHelmValuesFileName(release: string, name: string): boolean {
  if (typeof release !== "string" || typeof name !== "string") return false;
  if (!(RELEASES.includes(release) || gatewayNameProblem(release) === null)) return false;
  const prefix = `${release}-values`;
  const suffix = ".yaml";
  if (name.length < prefix.length + suffix.length || !name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const middle = name.slice(prefix.length, name.length - suffix.length);
  return middle === "" || (middle.startsWith("-") && HELM_VALUES_FRAGMENT_PATTERN.test(middle.slice(1)));
}

/**
 * A Kubernetes group's install facts (decision 15; Preflight ruling 1;
 * `no-store`, no bearer): a server group's facts' image, endpoint, insecure
 * flag, collector, variables (the chart's own left out) and id, and, in
 * place of its mounts, the Helm install: the chart and its version, the
 * image's repository (the values' `image.repository`; the tag is the
 * collector's version), the group's release, its `fullnameOverride` (D18:
 * the Agent's and the Cluster's, `helmFullnameOverride`; null for a
 * gateway), role, namespace, replicas (a gateway's; null for the Agent and
 * the Cluster) and volumes. Strict.
 */
export const HelmInstallFactsSchema = z
  .object({
    imageTag: z.string(),
    endpoint: z.string(),
    allowInsecureConnections: z.boolean(),
    collector: z.object({ distribution: z.string(), version: z.string() }).strict(),
    // Shell names, none reserved or the chart's own, each once (as InstallFactsSchema's).
    envVarNames: z
      .array(
        z
          .string()
          .max(INSTALL_ENV_NAME_MAXIMUM_LENGTH)
          .regex(INSTALL_ENV_NAME_PATTERN)
          .refine((name) => !(RESERVED_INSTALL_ENV_NAMES as readonly string[]).includes(name))
          .refine((name) => !(HELM_CHART_ENV_NAMES as readonly string[]).includes(name)),
      )
      .refine((names) => new Set(names).size === names.length),
    groupId: z.string().uuid(),
    helm: z
      .object({
        chartReference: z.string().regex(HELM_CHART_REFERENCE_PATTERN),
        chartVersion: z.string().regex(HELM_CHART_VERSION_PATTERN),
        imageRepository: z.string().regex(COLLECTOR_IMAGE_REPOSITORY_PATTERN),
        release: z.string(),
        fullnameOverride: z.string().nullable(),
        role: z.enum(KUBERNETES_ROLES),
        namespace: CollectorGroupNamespaceSchema,
        replicas: CollectorGroupReplicasSchema.nullable(),
        volumes: KubernetesVolumesSchema,
      })
      .strict()
      .superRefine((helm, context) => {
        if ((helm.role === "gateway") !== (helm.replicas !== null)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "A gateway's replicas only.", path: ["replicas"] });
        }
        const release = helm.role === "gateway" ? gatewayNameProblem(helm.release) === null : helm.release === helmReleaseName(helm.role, helm.release);
        if (!release) context.addIssue({ code: z.ZodIssueCode.custom, message: "Not the group's release.", path: ["release"] });
        if (!fullnameOverrideFits(helm.role, helm.fullnameOverride)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Not the group's fullnameOverride.", path: ["fullnameOverride"] });
        }
      }),
  })
  .strict();

export type HelmInstallFacts = z.infer<typeof HelmInstallFactsSchema>;

/**
 * Whose a `HelmBuildError`'s field is (D17d-2 Ruling 48): `choices` for the
 * typed variables (`collectorEnv`, `collectorEnv.N`, `collectorEnv.N.name`,
 * `collectorEnv.N.value`: what a person typed, a Helm values link's stored
 * values), `operator` for every other field (the group's settings, the
 * install's settings and the catalogue's version in the facts, the
 * revealed token, the chart's settings: none a person typed for the
 * install, so a refusal is the operator's to fix).
 */
export type HelmBuildErrorSource = "choices" | "operator";

/**
 * A backstop's refusal (the dialog and the API check every field first):
 * anything else is a broken contract, never written into a values file or
 * a command. Its message and `field` name the field only, never its value
 * (`collectorEnv.N.value` by its index), so the API may log the field;
 * `source` says whose the field is (the public download logs a `choices`
 * refusal at warn, an `operator` one at error).
 */
export class HelmBuildError extends Error {
  readonly field: string;
  readonly source: HelmBuildErrorSource;

  constructor(field: string) {
    super(`The Helm install's ${field} fails its rule.`);
    this.name = "HelmBuildError";
    this.field = field;
    this.source = field === "collectorEnv" || field.startsWith("collectorEnv.") ? "choices" : "operator";
  }
}

/** A typed variable for the values' `collectorEnv`. */
export interface HelmEnvValue {
  name: string;
  value: string;
}

/** What `helmValuesYaml` renders (Preflight ruling 7): the values, and the typed variables. */
export interface HelmValuesInput {
  role: KubernetesRole;
  /** A gateway's name; else the role (`node`, `cluster`). */
  group: string;
  /** The Agent's and the Cluster's object names (`helmFullnameOverride`, D18); null for a gateway. */
  fullnameOverride: string | null;
  collectorGroupId: string;
  image: { repository: string; tag: string };
  allowInsecure: boolean;
  /** A gateway's; null for the Agent and the Cluster. */
  replicas: number | null;
  endpoint: string;
  /** The default token's bearer as the reveal answers it, without `Bearer ` (the image adds it). */
  token: string;
  volumes: readonly KubernetesVolume[];
  /** In the order typed; none for no `collectorEnv`. */
  collectorEnv: readonly HelmEnvValue[];
}

/**
 * The values for a group from its facts, the reveal's bearer and the typed
 * variables (the browser's download and the public download alike). Throws
 * on a variable the facts don't offer.
 */
export function helmValuesInputOf(facts: HelmInstallFacts, bearer: string, env: readonly HelmEnvValue[]): HelmValuesInput {
  if (!Array.isArray(env)) throw new HelmBuildError("collectorEnv");
  const offered = new Set(facts.envVarNames);
  for (const [index, variable] of env.entries()) {
    if (!isEntry(variable)) throw new HelmBuildError(`collectorEnv.${index}`);
    if (!offered.has(variable.name)) throw new HelmBuildError(`collectorEnv.${index}.name`);
  }
  const { role, release, fullnameOverride, imageRepository, replicas, volumes } = facts.helm;
  return {
    role,
    group: role === "gateway" ? release : role,
    fullnameOverride,
    collectorGroupId: facts.groupId,
    image: { repository: imageRepository, tag: facts.collector.version },
    allowInsecure: facts.allowInsecureConnections,
    replicas,
    endpoint: facts.endpoint,
    token: bearer,
    volumes,
    collectorEnv: env.map(({ name, value }) => ({ name, value })),
  };
}

/** A variable's entry is an object (not null, not an array): anything else is `collectorEnv.N`'s refusal, never a TypeError. */
function isEntry(variable: unknown): boolean {
  return typeof variable === "object" && variable !== null && !Array.isArray(variable);
}

const IMAGE_TAG = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** A UTF-16 surrogate not in a pair: no YAML parser takes it, raw or escaped. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * A double-quoted YAML scalar of printable ASCII only (Preflight ruling 7):
 * `"` and `\` escaped, U+0020 to U+007E as they are, every other code point
 * `\uXXXX` (or `\UXXXXXXXX` past the BMP). Helm's YAML 1.1 parser folds a
 * raw U+0085 to a space and refuses a raw U+FFFF, so nothing else is
 * written raw: the file is ASCII.
 */
function yamlString(value: string, field: string): string {
  if (typeof value !== "string" || LONE_SURROGATE.test(value)) throw new HelmBuildError(field);
  let scalar = '"';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (character === '"') scalar += '\\"';
    else if (character === "\\") scalar += "\\\\";
    else if (point >= 0x20 && point <= 0x7e) scalar += character;
    else if (point <= 0xffff) scalar += `\\u${point.toString(16).padStart(4, "0")}`;
    else scalar += `\\U${point.toString(16).padStart(8, "0")}`;
  }
  return `${scalar}"`;
}

function checkedVariables(collectorEnv: readonly HelmEnvValue[]): readonly HelmEnvValue[] {
  if (!Array.isArray(collectorEnv) || collectorEnv.length > INSTALL_ENV_MAXIMUM) throw new HelmBuildError("collectorEnv");
  const seen = new Set<string>();
  for (const [index, variable] of collectorEnv.entries()) {
    if (!isEntry(variable)) throw new HelmBuildError(`collectorEnv.${index}`);
    const { name, value } = variable;
    const named =
      typeof name === "string" &&
      name.length <= INSTALL_ENV_NAME_MAXIMUM_LENGTH &&
      INSTALL_ENV_NAME_PATTERN.test(name) &&
      !(RESERVED_INSTALL_ENV_NAMES as readonly string[]).includes(name) &&
      !(HELM_CHART_ENV_NAMES as readonly string[]).includes(name) &&
      !seen.has(name);
    if (!named) throw new HelmBuildError(`collectorEnv.${index}.name`);
    seen.add(name);
    // installEnvValueProblem refuses a lone surrogate too (Ruling 36); yamlString checks again.
    if (typeof value !== "string" || installEnvValueProblem(value) !== null) throw new HelmBuildError(`collectorEnv.${index}.value`);
  }
  return collectorEnv;
}

/**
 * The values file (decision 17; Preflight ruling 7): a header comment, then
 * the keys in this order — `role`, `group`, `fullnameOverride` (the
 * Agent and the Cluster only; D18 Preflight ruling 12), `collectorGroupId`,
 * `image.repository`, `image.tag`, `allowInsecure`, `replicas` (a gateway
 * only), `endpoint`, `token`, `volumes` (each `type: "hostPath"`) — and
 * `collectorEnv` (the typed variables, their names quoted keys, only when
 * any: any shell name, a YAML 1.1 word too, since the chart quotes them; D18
 * decision 23). Every string a double-quoted ASCII scalar; numbers and
 * booleans bare. Throws `HelmBuildError` on a field outside its rule (the
 * public download renders it without the facts' schema, so a gateway's
 * `fullnameOverride`, or the Agent's or the Cluster's out of its shape, is
 * refused here too).
 */
export function helmValuesYaml(input: HelmValuesInput): string {
  const { role, group, fullnameOverride, collectorGroupId, image, allowInsecure, replicas, endpoint, token, volumes } = input;
  const settings = KubernetesAnnotationsSchema.safeParse({
    role,
    namespace: KUBERNETES_DEFAULT_NAMESPACE,
    ...(replicas === null ? {} : { replicas }),
    volumes,
  });
  if (!settings.success) throw new HelmBuildError(String(settings.error.issues[0]?.path[0] ?? "volumes"));
  if (role === "gateway" ? typeof replicas !== "number" : replicas !== null) throw new HelmBuildError("replicas");
  if (role === "gateway" ? gatewayNameProblem(group) !== null : group !== role) throw new HelmBuildError("group");
  if (!fullnameOverrideFits(role, fullnameOverride)) throw new HelmBuildError("fullnameOverride");
  if (typeof collectorGroupId !== "string" || !UUID.test(collectorGroupId)) throw new HelmBuildError("collectorGroupId");
  if (typeof image?.repository !== "string" || !COLLECTOR_IMAGE_REPOSITORY_PATTERN.test(image.repository)) {
    throw new HelmBuildError("image.repository");
  }
  if (typeof image.tag !== "string" || !IMAGE_TAG.test(image.tag)) throw new HelmBuildError("image.tag");
  if (typeof allowInsecure !== "boolean") throw new HelmBuildError("allowInsecure");
  if (typeof endpoint !== "string" || !AGENT_ENDPOINT_PATTERN.test(endpoint)) throw new HelmBuildError("endpoint");
  if (typeof token !== "string" || !BEARER_PATTERN.test(token)) throw new HelmBuildError("token");
  const collectorEnv = checkedVariables(input.collectorEnv);

  const lines = [
    "# This file holds the fleet's default token: delete it once the release is installed.",
    `role: ${yamlString(role, "role")}`,
    `group: ${yamlString(group, "group")}`,
    ...(fullnameOverride === null ? [] : [`fullnameOverride: ${yamlString(fullnameOverride, "fullnameOverride")}`]),
    `collectorGroupId: ${yamlString(collectorGroupId, "collectorGroupId")}`,
    "image:",
    `  repository: ${yamlString(image.repository, "image.repository")}`,
    `  tag: ${yamlString(image.tag, "image.tag")}`,
    `allowInsecure: ${allowInsecure ? "true" : "false"}`,
  ];
  if (role === "gateway") lines.push(`replicas: ${String(replicas)}`);
  lines.push(`endpoint: ${yamlString(endpoint, "endpoint")}`, `token: ${yamlString(token, "token")}`);
  const checkedVolumes = settings.data.volumes;
  if (checkedVolumes.length === 0) {
    lines.push("volumes: []");
  } else {
    lines.push("volumes:");
    for (const [index, volume] of checkedVolumes.entries()) {
      lines.push(
        `  - type: "hostPath"`,
        `    hostPath: ${yamlString(volume.hostPath, `volumes.${index}.hostPath`)}`,
        `    hostPathType: ${yamlString(volume.hostPathType, `volumes.${index}.hostPathType`)}`,
        `    mountPath: ${yamlString(volume.mountPath, `volumes.${index}.mountPath`)}`,
        `    readOnly: ${volume.readOnly ? "true" : "false"}`,
      );
    }
  }
  if (collectorEnv.length > 0) {
    lines.push("collectorEnv:");
    for (const [index, { name, value }] of collectorEnv.entries()) {
      lines.push(`  ${yamlString(name, `collectorEnv.${index}.name`)}: ${yamlString(value, `collectorEnv.${index}.value`)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** What `helm upgrade --install` names: the release, the chart and its version, the namespace, the values file. */
export interface HelmInstallParts {
  release: string;
  chartReference: string;
  chartVersion: string;
  namespace: string;
  /**
   * The values file `-f` reads (Ruling 37): the name the browser's download
   * saved (`helmValuesFileName(release, fragment)`); `helmValuesFileName(release)`
   * when left out. One of THIS release's names (`isHelmValuesFileName`).
   */
  valuesFile?: string;
}

function checkedNamespace(namespace: string): string {
  if (typeof namespace !== "string" || kubernetesNamespaceProblem(namespace) !== null) throw new HelmBuildError("namespace");
  return namespace;
}

/**
 * The install (decision 18; Preflight ruling 8), one flag a line, every
 * value single-quoted once: `--wait` bare (Helm 3's boolean, Helm 4's default strategy;
 * `--wait=watcher` Helm 3 refuses). No `--set-string`: the typed variables
 * travel in the values file (`-f '<release>-values[-<fragment>].yaml'`), off
 * the command line and the shell's history; `-f` names `valuesFile`, the
 * file the download saved (Ruling 37), one of the release's own names.
 * Throws on a release, values file, chart, version or namespace outside its
 * rule.
 */
export function helmInstallCommand({ release, chartReference, chartVersion, namespace, valuesFile }: HelmInstallParts): string {
  const quotedRelease = shellQuote(checkedRelease(release));
  const file = valuesFile === undefined ? helmValuesFileName(release) : valuesFile;
  if (!isHelmValuesFileName(release, file)) throw new HelmBuildError("valuesFile");
  const quotedFile = shellQuote(file);
  if (typeof chartReference !== "string" || !HELM_CHART_REFERENCE_PATTERN.test(chartReference)) throw new HelmBuildError("chartReference");
  if (typeof chartVersion !== "string" || !HELM_CHART_VERSION_PATTERN.test(chartVersion)) throw new HelmBuildError("chartVersion");
  const quotedNamespace = shellQuote(checkedNamespace(namespace));
  return [
    `helm upgrade --install ${quotedRelease} ${shellQuote(chartReference)} \\`,
    `  --version ${shellQuote(chartVersion)} \\`,
    `  -n ${quotedNamespace} --create-namespace \\`,
    `  -f ${quotedFile} \\`,
    "  --wait --timeout=120s",
  ].join("\n");
}

/**
 * A Helm values link's download (decision 18; Preflight ruling 8): D17c-2's
 * curl, the link off curl's command line (on its standard input as a config
 * line, `-K -`), `--proto '=https'` only for an https link, written to
 * the release's values file (`-o '<release>-values.yaml'`, Ruling 36); in a
 * subshell with `umask 077`, so the file is created 0600 and the person's
 * umask is left as it was. curl's `-f` writes nothing for a refused link.
 * Throws on a link the API doesn't make or a release outside its rule.
 */
export function helmValuesCurlCommand(url: string, release: string): string {
  if (typeof url !== "string" || !QUICK_DEPLOY_URL_PATTERN.test(url)) throw new HelmBuildError("url");
  const quotedFile = shellQuote(helmValuesFileName(release));
  const proto = url.startsWith("https://") ? " --proto '=https'" : "";
  return `( umask 077 && printf 'url = "%s"\\n' ${shellQuote(url)} | curl -q -g -fsS --retry 3${proto} -K - -o ${quotedFile} )`;
}

/**
 * The Helm Quick Deploy command (Preflight rulings 8 and 27; Ruling 37): the
 * link's download to the release's values file (`<release>-values.yaml`, no
 * fragment: `-o` overwrites), then, only once it succeeded, the install
 * reading that same file; an `install.valuesFile` is never used here.
 */
export function helmQuickDeployCommand(url: string, install: HelmInstallParts): string {
  const { valuesFile: _ignored, ...parts } = install;
  return `${helmValuesCurlCommand(url, parts.release)} && \\\n${helmInstallCommand(parts)}`;
}

/** The uninstall (decision 25): `helm uninstall '<release>' -n '<namespace>'`. Throws on either outside its rule. */
export function helmUninstallCommand({ release, namespace }: Pick<HelmInstallParts, "release" | "namespace">): string {
  return `helm uninstall ${shellQuote(checkedRelease(release))} -n ${shellQuote(checkedNamespace(namespace))}`;
}
