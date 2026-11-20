import {
  collectorGroupRole,
  gatewayNameProblem,
  helmReleaseName,
  helmUninstallCommand,
  KUBERNETES_AGENT_LOG_PATH,
  KUBERNETES_DEFAULT_NAMESPACE,
  kubernetesOf,
  type CollectorGroup,
  type FleetType,
  type KubernetesAnnotations,
  type KubernetesHostPathType,
  type KubernetesRole,
  type KubernetesVolume,
} from "@telflo/contracts";

/*
 * A Kubernetes-supervisor fleet's groups as its screens name them. A group's
 * role comes from the contracts' `collectorGroupRole` (the fleet's Default
 * group is the Agent, the group named `cluster` the Cluster, any other a
 * gateway pool), never from the stored `kubernetes.role`, so an unreadable key
 * never hides a role. A server fleet's groups are named by their names, in the
 * API's order, as before. Nothing here puts a name anywhere but the text it
 * returns.
 */

/** A role's words on screen: the Role column's, the Groups tab's badges'. */
export const KUBERNETES_ROLE_LABELS: Record<KubernetesRole, string> = {
  node: "Agent",
  cluster: "Cluster",
  gateway: "Gateway",
};

type NamedGroup = Pick<CollectorGroup, "isDefault" | "name">;

/**
 * A group as the fleet's screens name it (the Group filter, the edit's Group
 * select and its hints, bulk move, the details' Group row): a Kubernetes
 * fleet's Agent and Cluster by their role, a gateway and any server group by
 * its name.
 */
export function groupLabel(group: NamedGroup, fleetType: FleetType): string {
  const role = collectorGroupRole(group, fleetType);
  return role === null || role === "gateway" ? group.name : KUBERNETES_ROLE_LABELS[role];
}

/**
 * The name in the collectors grid's Group column: a gateway's (after its
 * role's badge), null for a Kubernetes fleet's Agent and Cluster, whose
 * badge alone names them (as the Groups tab); a server group's.
 */
export function groupColumnText(group: NamedGroup, fleetType: FleetType): string | null {
  const role = collectorGroupRole(group, fleetType);
  return role === null || role === "gateway" ? group.name : null;
}

/**
 * The groups in the order the fleet's screens list them: on a Kubernetes
 * fleet the Agent, then the Cluster, then the gateways in the API's order
 * (the API sorts the Default group first, then by name, which would put
 * `cluster` among the gateways); a server fleet's in the API's order.
 */
export function groupsInFleetOrder<T extends NamedGroup>(groups: readonly T[], fleetType: FleetType): T[] {
  if (fleetType !== "kubernetes-supervisor") return [...groups];
  const rank = (group: T) => {
    const role = collectorGroupRole(group, fleetType);
    return role === "node" ? 0 : role === "cluster" ? 1 : 2;
  };
  // Array.prototype.sort is stable: the gateways keep the API's order.
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

/** One row of a Kubernetes fleet's Groups tab: its role, and its group (null: the Cluster before its first Assign). */
export interface KubernetesGroupRow {
  role: KubernetesRole;
  group: CollectorGroup | null;
}

/**
 * A Kubernetes fleet's Groups tab's rows: the Agent (the Default group),
 * the Cluster (its group, or none before its first Assign), then the
 * gateway pools in the API's order.
 */
export function kubernetesGroupRows(groups: readonly CollectorGroup[]): KubernetesGroupRow[] {
  const ordered = groupsInFleetOrder(groups, "kubernetes-supervisor");
  const rows: KubernetesGroupRow[] = ordered.map((group) => ({ role: collectorGroupRole(group, "kubernetes-supervisor") ?? "node", group }));
  if (!rows.some((row) => row.role === "cluster")) {
    const agents = rows.filter((row) => row.role === "node").length;
    rows.splice(agents, 0, { role: "cluster", group: null });
  }
  return rows;
}

/** What a row says of its role: "Agent", "Cluster", or a gateway's name (the row's More, Assign, Edit and Delete, the dialogs' titles). */
export function kubernetesRowName(row: KubernetesGroupRow): string {
  return row.role === "gateway" && row.group !== null ? row.group.name : KUBERNETES_ROLE_LABELS[row.role];
}

/**
 * A row's key (its React key and its controls' ids): the Cluster's role
 * (`role-cluster`) before and after its group exists, so its first Assign
 * keeps the row and its button, and the focus goes back to its Edit;
 * the Agent's and a gateway's group id (never a name).
 */
export function kubernetesRowKey(row: KubernetesGroupRow): string {
  return row.role === "cluster" ? "role-cluster" : (row.group?.id ?? `role-${row.role}`);
}

/**
 * A group's Kubernetes settings as its row and details show them: the
 * stored `telflo.kubernetes` read leniently (`kubernetesOf`), null for none
 * (the Agent before its first save, the Cluster before its group exists) or
 * for a key Telflo can't read (`readable` false: shown as none, replaced on
 * the next save).
 */
export function kubernetesSettingsOf(group: CollectorGroup | null): { readable: boolean; kubernetes: KubernetesAnnotations | null } {
  return kubernetesOf(group?.annotations ?? null);
}

/**
 * The namespace a Kubernetes group's Helm release is installed into, as the
 * screens derive it, null exactly where the API's `helmFactsOf` refuses the
 * group: its saved settings', the Agent's with none saved (before its first
 * save) the default, `telflo-collectors`; null for settings `kubernetesOf`
 * can't read, a Cluster or a gateway with none, a stored role that isn't
 * the group's (`collectorGroupRole`'s), or a gateway whose name
 * `gatewayNameProblem` refuses (a group written around the platform:
 * nothing is installed from its facts, so nothing names where it runs). The
 * namespace warning's and the uninstall lines' one reader: "none saved" is
 * never "no namespace" for the Agent.
 */
export function releaseNamespaceOf(group: CollectorGroup): string | null {
  const role = collectorGroupRole(group, "kubernetes-supervisor") ?? "node";
  const { readable, kubernetes } = kubernetesOf(group.annotations);
  if (!readable) return null;
  const settings = kubernetes ?? (role === "node" ? { role, namespace: KUBERNETES_DEFAULT_NAMESPACE } : null);
  if (settings === null || settings.role !== role) return null;
  if (role === "gateway" && gatewayNameProblem(group.name) !== null) return null;
  return settings.namespace;
}

/**
 * A Kubernetes group's `helm uninstall`: its release (`helmReleaseName` by its
 * role) in its namespace (`releaseNamespaceOf`: the Agent with no settings
 * saved, the default); null wherever `releaseNamespaceOf` is (where
 * `helmFactsOf` refuses the group), or when the builder refuses either part
 * (nothing to say then).
 */
export function helmUninstallOf(group: CollectorGroup): string | null {
  const namespace = releaseNamespaceOf(group);
  if (namespace === null) return null;
  const role = collectorGroupRole(group, "kubernetes-supervisor") ?? "node";
  try {
    return helmUninstallCommand({ release: helmReleaseName(role, group.name), namespace });
  } catch {
    return null;
  }
}

/**
 * The `helm uninstall`s of the groups named (a bulk delete's selected
 * collectors' groups): one per distinct group, in the fleet's order, those it
 * can't name (gone from `groups`, unreadable) left out.
 */
export function helmUninstallsOf(groupIds: readonly string[], groups: readonly CollectorGroup[]): string[] {
  const wanted = new Set(groupIds);
  return groupsInFleetOrder(
    groups.filter((group) => wanted.has(group.id)),
    "kubernetes-supervisor",
  )
    .map(helmUninstallOf)
    .filter((command): command is string => command !== null);
}

/** Whether two volumes lists hold the same volumes in the same order. */
export function sameVolumes(a: readonly KubernetesVolume[], b: readonly KubernetesVolume[]): boolean {
  return (
    a.length === b.length &&
    a.every((volume, index) => {
      const other = b[index]!;
      return (
        volume.hostPath === other.hostPath &&
        volume.hostPathType === other.hostPathType &&
        volume.mountPath === other.mountPath &&
        volume.readOnly === other.readOnly
      );
    })
  );
}

/** Whether two settings are the same: role, namespace, replicas and volumes. */
export function sameKubernetesSettings(a: KubernetesAnnotations | null, b: KubernetesAnnotations | null): boolean {
  if (a === null || b === null) return a === b;
  return a.role === b.role && a.namespace === b.namespace && a.replicas === b.replicas && sameVolumes(a.volumes, b.volumes);
}

/**
 * Whether two annotations hold the same Kubernetes settings as a dialog shows
 * them (`sameShownMounts`'s twin): the same settings, or both none, or both
 * unreadable.
 */
export function sameShownKubernetes(a: CollectorGroup["annotations"], b: CollectorGroup["annotations"]): boolean {
  const first = kubernetesOf(a);
  const second = kubernetesOf(b);
  return first.readable === second.readable && sameKubernetesSettings(first.kubernetes, second.kubernetes);
}

/**
 * A gateway's in-cluster address: its
 * Service in its namespace, OTLP over HTTP (4318) and gRPC (4317) on the
 * cluster's usual domain. A blank part reads `<name>` or `<namespace>` while
 * the person types.
 */
export function gatewayAddress(name: string, namespace: string): { http: string; grpc: string } {
  const host = `${name.trim() || "<name>"}.${namespace.trim() || "<namespace>"}.svc.cluster.local`;
  return { http: `http://${host}:4318`, grpc: `${host}:4317` };
}

/**
 * A path as Kubernetes (and the contracts' "each mount path once") reads it,
 * trimmed: each run of `/` one, no trailing `/` but the root's.
 */
export function pathAsRead(path: string): string {
  const single = path.trim().replace(/\/+/g, "/");
  return single.length > 1 ? single.replace(/\/$/, "") : single;
}

/** Host paths whose mount can give a collector broad access to its node. */
const RISKY_HOST_PATHS = ["/", "/etc", "/root", "/var/lib/kubelet"] as const;

/**
 * Whether a host path is a sensitive one: the
 * node's root, `/etc`, `/root`, `/var/lib/kubelet` or a path under one of the
 * last three, or a Docker or containerd socket. Read as Kubernetes reads it
 * (each run of `/` one, no trailing `/`), not as typed. A warning, never a block.
 */
export function isRiskyHostPath(path: string): boolean {
  const read = pathAsRead(path);
  if (read === "") return false;
  if ((RISKY_HOST_PATHS as readonly string[]).includes(read)) return true;
  if (RISKY_HOST_PATHS.some((risky) => risky !== "/" && read.startsWith(`${risky}/`))) return true;
  return read.endsWith("docker.sock") || read.endsWith("containerd.sock");
}

/** A one-click volume: a node path mounted at the same path in the collector. */
export interface KubernetesVolumeRecipe {
  path: string;
  description: string;
  hostPathType: KubernetesHostPathType;
  readOnly: boolean;
}

/**
 * The one-click volumes: read-only directories of the node's logs, each
 * with its description.
 */
export const KUBERNETES_VOLUME_RECIPES: readonly KubernetesVolumeRecipe[] = [
  { path: KUBERNETES_AGENT_LOG_PATH, description: "the kubelet's container logs (CRI)", hostPathType: "Directory", readOnly: true },
  { path: "/var/log/containers", description: `the older links into ${KUBERNETES_AGENT_LOG_PATH}`, hostPathType: "Directory", readOnly: true },
  { path: "/var/log", description: "the node's log root (custom app directories)", hostPathType: "Directory", readOnly: true },
  { path: "/var/log/journal", description: "systemd's journal (persistent)", hostPathType: "Directory", readOnly: true },
  { path: "/run/log/journal", description: "systemd's journal (volatile)", hostPathType: "Directory", readOnly: true },
];

/** The recipes a role's dialog offers: the Agent's leave out the path its chart already mounts. */
export function volumeRecipesFor(role: KubernetesRole): readonly KubernetesVolumeRecipe[] {
  return role === "node" ? KUBERNETES_VOLUME_RECIPES.filter((recipe) => recipe.path !== KUBERNETES_AGENT_LOG_PATH) : KUBERNETES_VOLUME_RECIPES;
}
