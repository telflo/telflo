# supervisor-collector

The Telflo platform's Helm chart for a Kubernetes fleet's collectors: an
OpAMP supervisor (`opampsupervisor`, PID 1) running `otelcol-contrib`, from the
platform's image `ghcr.io/telflo/telflo/collector`. It is published as
`oci://ghcr.io/telflo/telflo/charts/supervisor-collector`.

The platform's Install with Helm dialog writes the values file and the
command, for example:

```
helm upgrade --install 'telflo-node' 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector' \
  --version '0.1.0' \
  -n 'observability' --create-namespace \
  -f 'telflo-node-values-1a2b3c4d.yaml' \
  --wait --timeout=120s
```

A chart change is a new `version` (a published version is never
overwritten), and the platform's default chart version moves with it.

## Roles

`role` picks the workload. Each release installs one collector group.

| Role | Workload | RBAC | Named |
|---|---|---|---|
| `node` (the Agent) | a DaemonSet, one pod a node; reads `/var/log/pods` read-only; state in the hostPath `/var/lib/telflo/supervisor/<fullname>` | a ClusterRole for `nodes/stats`, `nodes/proxy` | `fullnameOverride`, else `telflo-node` |
| `cluster` (the Cluster) | a StatefulSet of one, state on a 1Gi PVC | a ClusterRole to get, list and watch pods, nodes, namespaces, events, services, endpoints and the `apps` workloads | `fullnameOverride`, else `telflo-cluster` |
| `gateway` | a StatefulSet of `replicas`, state on 5Gi PVCs, and a Service on 4317 (OTLP gRPC) and 4318 (OTLP HTTP) | none | its `group` (the Service's address) |

## Values

| Key | Meaning |
|---|---|
| `role` | `node`, `cluster` or `gateway` (required). |
| `group` | The collector group's name. A gateway's names its objects and Service: a DNS-1035 label of at most 52 characters, not `node`, `cluster`, `telflo-node` or `telflo-cluster`. The node and the cluster pass their role's name; it doesn't name them. |
| `fullnameOverride` | The Agent's or the Cluster's object name (below). Empty: `telflo-node` / `telflo-cluster`. When set, a DNS-1123 label of at most 52 characters. A gateway's names ignore it, but a set value is still checked (on every role). |
| `collectorGroupId` | The collector group's id, a UUID (any case), required. The pods get it as `COLLECTOR_GROUP_ID`, which binds each collector to its group. |
| `endpoint`, `token` | The OpAMP server's URL and the fleet's enrollment token, both required. The token is kept in the Secret `<fullname>-token` and reaches the pods as `OPAMP_TOKEN`. |
| `allowInsecure` | `true` skips TLS verification to the OpAMP server (the platform sets it for `http` endpoints). Default `false`. |
| `image.repository`, `image.tag`, `image.pullPolicy` | Default `ghcr.io/telflo/telflo/collector`, the tag `appVersion` (`0.162.0`) when empty, `IfNotPresent`. The platform always sets the tag to the group's collector version. |
| `replicas` | The gateway's replicas (the Cluster always runs one). |
| `resources` | The collector container's resources, every role. |
| `nodeSelector`, `tolerations` | The node role's DaemonSet only. |
| `serviceAccount.create`, `serviceAccount.name` | Create the ServiceAccount (default `true`); its name, default the fullname. |
| `nodeLogHostPath` | The node role's log directory, mounted read-only at `/var/log/pods`. Default `/var/log/pods`. |
| `collectorEnv` | Variables the deployed configuration reads with `${env:NAME}`, as `NAME: value`. Kept in the Secret `<fullname>-collector-env`, given to the collector by `envFrom` (explicit variables, such as `OPAMP_*`, win); a `checksum/collector-env` annotation rolls the pods when a value changes. Every name is quoted, so any variable name arrives as written, a YAML word such as `ON`, `yes`, `null` or `~` included. |
| `volumes` | Extra hostPath mounts for every role: `hostPath`, `hostPathType` (default `Directory`), `mountPath`, `readOnly` (default `true`; an explicit `false` stays writable). |
| `clickhouse.*`, `collectorDataDir` | A ClickStack mode, not used by the platform: with `clickhouse.endpoint` set, the pods run as uid 10001, get `CLICKHOUSE_*` and `OPAMP_SERVER_URL`, a `<fullname>-clickhouse` Secret (or `existingSecret`) and a durable `collectorDataDir` (a PVC, or the node's hostPath `/var/lib/telflo/collector/<fullname>`). |

## Guards

`templates/_guards.tpl`, called from `secret.yaml`'s first line, refuses a
render (and so an install or upgrade) when a value is wrong. Helm stops the
whole render on any template's `fail`, and each workload's `checksum/token`
includes `secret.yaml`, so nothing renders past a bad value. Each message
names the key, never its value:

| Refused | Message |
|---|---|
| `role` not one of the three | `role must be one of: node, cluster, gateway` |
| a gateway without `group` | `gateway role requires a group name` |
| a gateway's `group` not a string | `group must be a string` |
| a gateway's `group` not `^[a-z]([-a-z0-9]*[a-z0-9])?$` or over 52 characters | `group must be a DNS-1035 label of at most 52 characters for a gateway` |
| a gateway named `node`, `cluster`, `telflo-node` or `telflo-cluster` | `group must not be node, cluster, telflo-node or telflo-cluster for a gateway` |
| a set `fullnameOverride` not a string, not `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` or over 52 characters | `fullnameOverride must be a DNS-1123 label of at most 52 characters` |
| `collectorGroupId` missing, not a string or not `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` | `collectorGroupId must be a collector group's id (a UUID)` |
| `endpoint` or `token` empty | `endpoint and token are required` |

Helm 4's `helm lint` only logs a guard's `fail` (it passes with no values at
all): the render tests carry every guard.

## Names

`tsc.fullname` is a gateway's `group`; else `fullnameOverride` when set; else
`telflo-cluster` or `telflo-node`. It names the ServiceAccount (when
`serviceAccount.name` is empty), the Secrets `<fullname>-token`,
`<fullname>-collector-env` and `<fullname>-clickhouse`, the ClusterRole, the
ClusterRoleBinding with its `roleRef` and subject, the DaemonSet or
StatefulSet with its `serviceName`, its `app` label and selector, the
gateway's Service and selector, the `OPAMP_TOKEN` and `envFrom` references,
and the node's hostPaths `/var/lib/telflo/supervisor/<fullname>` and
`/var/lib/telflo/collector/<fullname>`; a StatefulSet's PVCs follow
(`storage-<fullname>-0`). Release names don't name anything.

The platform passes `fullnameOverride` for the node and the cluster: the fleet
id's first 8 characters, `-` and the group's slug (`3f9a1c2e-default`,
`3f9a1c2e-cluster`), and keeps the release names `telflo-node`,
`telflo-cluster` and the gateway's name. So two fleets' Agents and Clusters
run in one cluster, each fleet in its own namespace, with their own
ClusterRoles and node state.

Every name, and the binding subject's namespace, is written quoted: a gateway
or namespace named by a YAML word (`on`, `yes`, `null`) stays that string
under Helm's YAML 1.1 parse instead of becoming `true` or null.

## A new token rolls the pods

Each workload's pod template carries `checksum/token`, the sha256 of the
rendered token Secret (`secret.yaml`), always; and `checksum/collector-env`
when `collectorEnv` is set. A `helm upgrade` with a new token changes the
annotation, so Kubernetes rolls the DaemonSet's or StatefulSet's pods, the
ones the old token's revocation refused included: after a new default token,
run each group's Install with Helm again and its pods restart with the new
token. The checksum changes with the token Secret's text, which is the token
and the Secret's name (the fullname); not with the endpoint, the image,
`collectorEnv`, the namespace or the release. Each platform download seals the
token afresh, so every Install with Helm again restarts the group's pods (a
rolling restart), as a variable or version change does.

The annotation is a hash of the sealed bearer, never the bearer; it is
high-entropy, and readable by whoever can read the pods.

The roll relies on there being no readiness probe (the chart has none): a pod
the OpAMP server refuses keeps running (its supervisor retries) and stays
Ready, so the roll replaces it. A future readiness probe that followed the
OpAMP connection would leave refused pods unready, and a StatefulSet (the
Cluster's, a gateway's) with the default `OrderedReady` management waits for
every pod to be Ready before it replaces one: the roll that brings the new
token would stall on the very pods it is meant to fix.

## Limits

Recorded, not fixed in 0.1.0:

- Upgrading a release of the `telflo-supervisor-collector` chart (0.3.x) to
  this chart renames the Agent's and the Cluster's objects and moves the node
  state, so the Agent enrolls again as a new collector (the old one goes
  offline); an upgraded Cluster leaves its PVC `storage-telflo-cluster-0`
  behind.
- **One fleet per namespace.** The release names are fixed (`telflo-node`,
  `telflo-cluster`), so a second fleet's Agent or Cluster installed into the
  first's namespace upgrades the first's release (takes it over). Install
  each fleet into its own namespace.
- Two gateways of one name in one namespace collide.
- A gateway named `<8 hex>-default` or `<8 hex>-cluster` in a fleet's Agent's
  or Cluster's namespace collides with that fleet's objects (Helm refuses:
  another release owns them). Only for a fleet whose id starts with a letter
  (`a`–`f`): a gateway's name must start with one.
- Two fleets whose ids share their first 8 characters collide on the
  ClusterRole (Helm refuses; about 2^-32 for random v4 ids).
- `HOST_IP` is the pod's IP (`status.podIP`), not the node's.
- An extra volume is named by its mount path's slug, so two mount paths with
  one slug collide (the platform refuses those).
- The ClickStack parts (`clickhouse.*`, `collectorDataDir`, uid 10001, the
  node's `fix-storage-ownership` init container) are untested on a real
  cluster.
- `nodeSelector` and `tolerations` apply to the node role only; the Cluster
  and gateways have none.
- No standard `app.kubernetes.io/*` labels; only `app: <fullname>`.
- Some operator and ClickStack values are written unquoted:
  `clickhouse.passwordKey` (the ClickStack Secret's key and its reference),
  `nodeLogHostPath` (the node's log hostPath) and `collectorDataDir` inside
  the init container's `sh -c` command. The platform never sets them; a YAML
  word or shell text there is the operator's.

## Tests

```
bash charts/supervisor-collector/tests/render-tests.sh
```

Real `helm template` and `helm lint --strict` renders, offline (no registry,
no cluster, no credentials; Helm's homes in a temporary directory): eight base
cases (mounts' `readOnly`, `collectorEnv`, the token Secret, a render without
values); every guard alone with its message and no value in the output; the
names with and without an override, two fleets' overrides disjoint, a gateway
ignoring one; YAML-word names, `collectorEnv` keys and volume mount and host
paths checked after a YAML 1.1 parse by Helm's own `fromYaml`;
`checksum/token` on every workload and `checksum/collector-env`; each pod's
identity variables (`COLLECTOR_GROUP_ID`, `OPAMP_ENDPOINT`,
`OPAMP_ALLOW_INSECURE_CONNECTIONS`, the token's reference, the field
references, `HOST_IP` the pod's IP), its mounts paired with its volumes and
claims, and each ClusterRole's rules exactly; the image; `helm lint --strict`
for each role. `tests/` is left out of the package (`.helmignore`).
