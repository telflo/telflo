import {
  annotationsWithKubernetes,
  collectorGroupRole,
  KUBERNETES_DEFAULT_NAMESPACE,
  KUBERNETES_REPLICAS_GATEWAY_ONLY,
  kubernetesOf,
  type CollectorGroup,
  type FleetType,
  type KubernetesAnnotations,
  type KubernetesRole,
  type PublicCollectorGroup,
} from "@telflo/contracts";
import { AppError } from "../../../errors.js";
import { collectorGroupSettingsUnreadable, fieldDetail } from "../../fleets/errors.js";

/*
 * A collector group on the public surface (D25 decision 35), mapped from
 * and to the platform's: the role is the group's
 * on its fleet (collectorGroupRole, never the stored one), a Kubernetes
 * group's namespace and a gateway's replicas are its annotations'
 * `telflo.kubernetes` (D17d-1 decision 2), read by kubernetesOf and written
 * by annotationsWithKubernetes, which keeps every other key. A group's
 * name and namespace are configuration text: replies only, never a log
 * line or an error's words.
 */

/** A 400 `invalid_request` naming the body's field, in the platform's details shape (fieldDetail). */
export function fieldRefused(field: string, message: string): AppError {
  return new AppError("invalid_request", message, 400, [fieldDetail(field, message)]);
}

/** The settings a Kubernetes group installs with (helmFactsOf's reading): its stored ones, or the Agent's defaults before its first save. */
function settingsOf(group: Pick<CollectorGroup, "annotations">, role: KubernetesRole): KubernetesAnnotations | undefined {
  const { readable, kubernetes } = kubernetesOf(group.annotations);
  if (!readable) return undefined;
  if (kubernetes === null) return role === "node" ? { role, namespace: KUBERNETES_DEFAULT_NAMESPACE, volumes: [] } : undefined;
  return kubernetes.role === role ? kubernetes : undefined;
}

/** A group as the public surface answers it, on a fleet of `fleetType`. */
export function toPublicGroup(group: CollectorGroup, fleetType: FleetType): PublicCollectorGroup {
  const role = collectorGroupRole(group, fleetType);
  const settings = role === null ? undefined : settingsOf(group, role);
  return {
    id: group.id,
    fleetId: group.fleetId,
    name: group.name,
    isDefault: group.isDefault,
    role,
    namespace: settings?.namespace ?? null,
    replicas: settings === undefined || role !== "gateway" ? null : (settings.replicas ?? 1),
    assignedPublishedVersionId: group.assignedPublishedVersionId,
    configurationId: group.assignedVersion?.configurationId ?? null,
    versionNumber: group.assignedVersion?.versionNumber ?? null,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

/** The Kubernetes fields a server fleet's group refuses, 400 at the first one sent. */
export function refuseKubernetesFields(fields: { role?: unknown; namespace?: unknown; replicas?: unknown }): void {
  for (const field of ["role", "namespace", "replicas"] as const) {
    if (fields[field] !== undefined) throw fieldRefused(field, "Only a kubernetes-supervisor fleet's groups take it.");
  }
}

/**
 * A new Kubernetes group's annotations (decision 35): its role is the
 * name's (`cluster` the Cluster, any other a gateway pool; the Agent is the
 * fleet's Default group, never made), which `role`, when sent, must name;
 * the namespace (the default when left out), a gateway's replicas (none:
 * 1), no volumes. The name's own rule is the service's (a gateway's name a
 * DNS-1035 label: 400 at `name`).
 */
export function kubernetesAnnotationsForCreate(
  name: string,
  fields: { role?: KubernetesRole | undefined; namespace?: string | undefined; replicas?: number | undefined },
): Record<string, unknown> | null {
  const role = collectorGroupRole({ isDefault: false, name }, "kubernetes-supervisor") as KubernetesRole;
  if (fields.role !== undefined && fields.role !== role) throw fieldRefused("role", `Must be ${role}: a group's role is its name's (cluster is the Cluster, any other a gateway pool).`);
  if (fields.replicas !== undefined && role !== "gateway") throw fieldRefused("replicas", KUBERNETES_REPLICAS_GATEWAY_ONLY);
  return annotationsWithKubernetes(null, {
    role,
    namespace: fields.namespace ?? KUBERNETES_DEFAULT_NAMESPACE,
    ...(fields.replicas === undefined ? {} : { replicas: fields.replicas }),
    volumes: [],
  });
}

/**
 * A Kubernetes group's annotations with `namespace` and `replicas` merged
 * into its settings (decision 35's merge): a field left out keeps the
 * group's, null clears it (the default namespace; a gateway's 1 replica),
 * its volumes and every other key kept. Settings that can't be read are
 * 409 `collector_group_settings_unreadable`, as its install's; replicas on
 * a group that isn't a gateway are 400 at `replicas`.
 */
export function kubernetesAnnotationsMerged(
  group: Pick<CollectorGroup, "annotations" | "isDefault" | "name">,
  fields: { namespace?: string | null | undefined; replicas?: number | null | undefined },
): Record<string, unknown> | null {
  const role = collectorGroupRole(group, "kubernetes-supervisor") as KubernetesRole;
  if (typeof fields.replicas === "number" && role !== "gateway") throw fieldRefused("replicas", KUBERNETES_REPLICAS_GATEWAY_ONLY);
  const settings = settingsOf(group, role);
  if (settings === undefined) throw collectorGroupSettingsUnreadable();
  const namespace = fields.namespace === undefined ? settings.namespace : (fields.namespace ?? KUBERNETES_DEFAULT_NAMESPACE);
  const replicas = fields.replicas === undefined ? settings.replicas : (fields.replicas ?? undefined);
  return annotationsWithKubernetes(group.annotations, {
    role,
    namespace,
    ...(replicas === undefined ? {} : { replicas }),
    volumes: settings.volumes,
  });
}
