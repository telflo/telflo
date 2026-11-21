import { describe, expect, it } from "vitest";
import { clusterGroup, collectorGroup, gatewaysGroup, kubernetesAnnotations, kubernetesGroups, SECOND_GATEWAY_GROUP_ID } from "~/test/fleets.js";
import {
  gatewayAddress,
  groupColumnText,
  groupLabel,
  groupsInFleetOrder,
  helmUninstallOf,
  isRiskyHostPath,
  KUBERNETES_ROLE_LABELS,
  kubernetesGroupRows,
  kubernetesRowKey,
  kubernetesRowName,
  kubernetesSettingsOf,
  pathAsRead,
  releaseNamespaceOf,
  sameShownKubernetes,
  volumeRecipesFor,
} from "./kubernetes-groups.js";

// A Kubernetes fleet's groups as its screens name and order them.

describe("groupLabel", () => {
  it("names a Kubernetes fleet's Agent and Cluster by role, a gateway by its name", () => {
    expect(groupLabel(collectorGroup(), "kubernetes-supervisor")).toBe("Agent");
    expect(groupLabel(clusterGroup(), "kubernetes-supervisor")).toBe("Cluster");
    expect(groupLabel(gatewaysGroup(), "kubernetes-supervisor")).toBe("gateways");
  });

  it("names every server group by its name, Default and a group named cluster included", () => {
    expect(groupLabel(collectorGroup(), "server")).toBe("Default");
    expect(groupLabel(clusterGroup(), "server")).toBe("cluster");
  });

  it("reads the role from the group, never its stored annotations", () => {
    const stored = { telflo: { kubernetes: { role: "cluster", namespace: "telflo-collectors", volumes: [] } } };
    expect(groupLabel(gatewaysGroup({ annotations: stored }), "kubernetes-supervisor")).toBe("gateways");
    expect(KUBERNETES_ROLE_LABELS).toEqual({ node: "Agent", cluster: "Cluster", gateway: "Gateway" });
  });
});

describe("groupColumnText", () => {
  it("is a gateway's name, and null (a dash) for a Kubernetes fleet's Agent and Cluster", () => {
    expect(groupColumnText(collectorGroup(), "kubernetes-supervisor")).toBeNull();
    expect(groupColumnText(clusterGroup(), "kubernetes-supervisor")).toBeNull();
    expect(groupColumnText(gatewaysGroup(), "kubernetes-supervisor")).toBe("gateways");
  });

  it("is a server group's name", () => {
    expect(groupColumnText(collectorGroup(), "server")).toBe("Default");
    expect(groupColumnText(clusterGroup(), "server")).toBe("cluster");
  });
});

describe("groupsInFleetOrder", () => {
  it("lists a Kubernetes fleet's Agent, then the Cluster, then the gateways in the API's order", () => {
    expect(groupsInFleetOrder(kubernetesGroups(), "kubernetes-supervisor").map((group) => group.name)).toEqual([
      "Default",
      "cluster",
      "alpha",
      "gateways",
    ]);
  });

  it("keeps a server fleet's groups in the API's order, and never changes the array given", () => {
    const groups = kubernetesGroups();
    expect(groupsInFleetOrder(groups, "server").map((group) => group.name)).toEqual(["Default", "alpha", "cluster", "gateways"]);
    groupsInFleetOrder(groups, "kubernetes-supervisor");
    expect(groups.map((group) => group.name)).toEqual(["Default", "alpha", "cluster", "gateways"]);
  });
});

describe("kubernetesGroupRows", () => {
  it("is the Agent, the Cluster with its group, then the gateways", () => {
    expect(kubernetesGroupRows(kubernetesGroups()).map((row) => [row.role, row.group?.name ?? null])).toEqual([
      ["node", "Default"],
      ["cluster", "cluster"],
      ["gateway", "alpha"],
      ["gateway", "gateways"],
    ]);
  });

  it("draws the Cluster before its group exists, after the Agent", () => {
    const rows = kubernetesGroupRows([collectorGroup(), gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha" })]);
    expect(rows.map((row) => [row.role, row.group?.name ?? null])).toEqual([
      ["node", "Default"],
      ["cluster", null],
      ["gateway", "alpha"],
    ]);
  });
});

describe("kubernetesRowName and kubernetesRowKey", () => {
  it("name a row by its role, a gateway by its name; key it by its group's id, the Cluster by its role before and after its group exists", () => {
    const [agent, cluster, gateway] = kubernetesGroupRows([collectorGroup(), gatewaysGroup()]);
    expect([agent, cluster, gateway].map((row) => kubernetesRowName(row!))).toEqual(["Agent", "Cluster", "gateways"]);
    expect(kubernetesRowKey(agent!)).toBe(collectorGroup().id);
    expect(kubernetesRowKey(cluster!)).toBe("role-cluster");
    expect(kubernetesRowKey(gateway!)).toBe(gatewaysGroup().id);
    // Its first Assign keeps the key: the row and its controls stay, and the focus with them.
    const [, assigned] = kubernetesGroupRows([collectorGroup(), clusterGroup(), gatewaysGroup()]);
    expect(assigned!.group).not.toBeNull();
    expect(kubernetesRowKey(assigned!)).toBe("role-cluster");
  });
});

describe("kubernetesSettingsOf and sameShownKubernetes", () => {
  it("reads a group's settings, none for no group or no key, unreadable for a shape Telflo can't read", () => {
    expect(kubernetesSettingsOf(null)).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesSettingsOf(collectorGroup())).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesSettingsOf(gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) })).kubernetes?.namespace).toBe("edge");
    expect(kubernetesSettingsOf(gatewaysGroup({ annotations: { telflo: { kubernetes: { namespace: 1 } } } }))).toEqual({ readable: false, kubernetes: null });
  });

  it("compares the settings as shown: the same, both none, or both unreadable; another client's keys don't count", () => {
    expect(sameShownKubernetes(kubernetesAnnotations(), { ...kubernetesAnnotations(), theirs: 1 })).toBe(true);
    expect(sameShownKubernetes(null, { other: true })).toBe(true);
    expect(sameShownKubernetes({ telflo: "x" }, { telflo: { kubernetes: [] } })).toBe(true);
    expect(sameShownKubernetes(kubernetesAnnotations(), kubernetesAnnotations({ replicas: 2 }))).toBe(false);
    expect(sameShownKubernetes(kubernetesAnnotations(), null)).toBe(false);
    expect(sameShownKubernetes(kubernetesAnnotations(), { telflo: "x" })).toBe(false);
    const volume = { hostPath: "/a", hostPathType: "Directory", mountPath: "/a", readOnly: true } as const;
    expect(sameShownKubernetes(kubernetesAnnotations({ volumes: [volume] }), kubernetesAnnotations({ volumes: [{ ...volume, readOnly: false }] }))).toBe(false);
  });
});

// Where a group's release runs, as the API's helmFactsOf installs it, and nothing where helmFactsOf refuses the group
// (409 collector_group_settings_unreadable): a table, row by row.
describe("releaseNamespaceOf and helmUninstallOf", () => {
  const edge = kubernetesAnnotations({ namespace: "edge" });
  it.each([
    { case: "a saved gateway", group: gatewaysGroup({ annotations: edge }), namespace: "edge", uninstall: "helm uninstall 'gateways' -n 'edge'" },
    {
      case: "the Agent before its first save: the default",
      group: collectorGroup(),
      namespace: "telflo-collectors",
      uninstall: "helm uninstall 'telflo-node' -n 'telflo-collectors'",
    },
    {
      case: "the Agent before its first save, other clients' annotations beside: the default",
      group: collectorGroup({ annotations: { other: { kept: true } } }),
      namespace: "telflo-collectors",
      uninstall: "helm uninstall 'telflo-node' -n 'telflo-collectors'",
    },
    {
      case: "a saved Cluster",
      group: clusterGroup({ annotations: kubernetesAnnotations({ role: "cluster", namespace: "monitoring", replicas: undefined }) }),
      namespace: "monitoring",
      uninstall: "helm uninstall 'telflo-cluster' -n 'monitoring'",
    },
    { case: "settings kubernetesOf can't read", group: collectorGroup({ annotations: { telflo: { kubernetes: "x" } } }), namespace: null, uninstall: null },
    { case: "a Cluster without settings", group: clusterGroup(), namespace: null, uninstall: null },
    { case: "a gateway without settings", group: gatewaysGroup(), namespace: null, uninstall: null },
    {
      case: "a gateway whose stored role is the Agent's",
      group: gatewaysGroup({ annotations: kubernetesAnnotations({ role: "node", namespace: "edge", replicas: undefined }) }),
      namespace: null,
      uninstall: null,
    },
    { case: "the Agent whose stored role is a gateway's", group: collectorGroup({ annotations: edge }), namespace: null, uninstall: null },
    { case: "a gateway named Not_A_Gateway (not a DNS-1035 label)", group: gatewaysGroup({ name: "Not_A_Gateway", annotations: edge }), namespace: null, uninstall: null },
    {
      case: "a gateway named telflo-node (reserved: the Agent's release)",
      group: gatewaysGroup({ name: "telflo-node", annotations: kubernetesAnnotations() }),
      namespace: null,
      uninstall: null,
    },
    {
      case: "a gateway named telflo-cluster (reserved: the Cluster's release)",
      group: gatewaysGroup({ name: "telflo-cluster", annotations: kubernetesAnnotations() }),
      namespace: null,
      uninstall: null,
    },
  ])("$case: namespace $namespace, uninstall $uninstall", ({ group, namespace, uninstall }) => {
    expect(releaseNamespaceOf(group)).toBe(namespace);
    expect(helmUninstallOf(group)).toBe(uninstall);
  });
});

describe("gatewayAddress", () => {
  it("is the gateway's Service in its namespace, OTLP over HTTP and gRPC, placeholders for blanks", () => {
    expect(gatewayAddress(" edge ", " obs ")).toEqual({ http: "http://edge.obs.svc.cluster.local:4318", grpc: "edge.obs.svc.cluster.local:4317" });
    expect(gatewayAddress("", "")).toEqual({ http: "http://<name>.<namespace>.svc.cluster.local:4318", grpc: "<name>.<namespace>.svc.cluster.local:4317" });
  });
});

describe("pathAsRead", () => {
  it("reads a path as Kubernetes does, trimmed: each run of / one, no trailing / but the root's", () => {
    expect(["/var/log/", " //var//log ", "/var/log", "/", "//", "", " "].map(pathAsRead)).toEqual(["/var/log", "/var/log", "/var/log", "/", "/", "", ""]);
  });
});

describe("isRiskyHostPath and volumeRecipesFor", () => {
  it("warns of the node's root, /etc, /root, /var/lib/kubelet and under them, and the runtimes' sockets, as Kubernetes reads a path", () => {
    for (const path of ["/", "/etc", "/etc/", "//etc", "/root/.ssh", "/var/lib/kubelet", "/var/lib/kubelet/pods", "/var/run/docker.sock", "/run/containerd/containerd.sock", " /etc "]) {
      expect(isRiskyHostPath(path), path).toBe(true);
    }
    for (const path of ["", "   ", "/var/log", "/etcetera", "/rooted", "/var/lib/kubelets", "/srv/docker.socket"]) expect(isRiskyHostPath(path), path).toBe(false);
  });

  it("offers safe recipes only, without the harness example, and the Agent's without /var/log/pods", () => {
    for (const role of ["node", "cluster", "gateway"] as const) {
      for (const recipe of volumeRecipesFor(role)) {
        expect(isRiskyHostPath(recipe.path), recipe.path).toBe(false);
        expect(recipe.readOnly).toBe(true);
        expect(recipe.path).not.toContain("starfeuds");
      }
    }
    expect(volumeRecipesFor("node").map((recipe) => recipe.path)).not.toContain("/var/log/pods");
    expect(volumeRecipesFor("gateway").map((recipe) => recipe.path)).toContain("/var/log/pods");
  });
});
