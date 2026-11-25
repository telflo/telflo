# Run it on Kubernetes

The Helm chart, `oci://ghcr.io/telflo/telflo/charts/telflo`, installs
Telflo into one namespace: the gateway, the web app, the API (its
migrations in an init container), the collector validator, tester and OTTL
evaluator, one Postgres in a StatefulSet for both databases, and the
opamp-server's own chart as a dependency. Each part is its own Deployment,
NetworkPolicies keep the tester and the evaluator from reaching anything,
and every pod runs non-root with a read-only root. The
[chart's README](../charts/telflo/README.md) lists every object and value.

**What the cluster needs:** Kubernetes 1.25 or later, a default
StorageClass, LoadBalancer Services (or NodePort, or a port-forward), and
a network plugin that enforces NetworkPolicies. On your machine: `kubectl`,
Helm 3, `curl`, `openssl`, and `sha256sum` or `shasum`. `<context>` below is
your cluster's kubectl context: every command names it, so none runs
against your current context by accident.

```sh
# 1. The namespace, held to the restricted Pod Security level.
kubectl --context <context> create namespace telflo
kubectl --context <context> label namespace telflo pod-security.kubernetes.io/enforce=restricted

# 2. The Secrets. Download create-secrets.sh from the release, with the checksums,
#    and check it: it prints "create-secrets.sh: OK".
release=https://github.com/telflo/telflo/releases/download/v0.2.4
curl -fsSL -O "$release/create-secrets.sh" -O "$release/SHA256SUMS"
grep 'create-secrets.sh$' SHA256SUMS | if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi

#    Write a new file of fresh secrets (mode 0600). Edit it if you need its optional
#    sections (a mail relay's login, Google's client, a pull token), then create the
#    Secrets from it, in the namespace.
bash create-secrets.sh --init my.secrets.env
bash create-secrets.sh --context <context> --namespace telflo my.secrets.env

# 3. The chart. publicUrl is the gateway's https origin as browsers reach it; the
#    opamp-server's publicUrl is the agent endpoint as collectors reach it.
helm install telflo oci://ghcr.io/telflo/telflo/charts/telflo --version 0.2.4 --kube-context <context> -n telflo \
  --set publicUrl=https://telflo.example.com \
  --set opamp-server.server.publicUrl=https://opamp.example.com/opamp/api/v1 \
  --set api.mail.from=telflo@example.com \
  --set api.mail.smtp.host=smtp.example.com \
  --wait --timeout 20m

# 4. Check it. Forward the gateway to this machine; this keeps running until
#    Ctrl-C, so leave it in this terminal.
kubectl --context <context> -n telflo port-forward svc/telflo-gateway 8080:80

#    Then, in a second terminal, ask for the sign-in page: it answers 200.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/login

# 5. The first admin, at once. It prints a link to set the password, once, as
#    its last line: open it yourself, and keep it out of any log.
kubectl --context <context> -n telflo exec deploy/telflo-api -c api -- telflo-admin bootstrap --email <your email> --organization "<your organization>"
```

**Back up `my.secrets.env` outside the cluster,** above all the
opamp-server's `encryption-key`: without it, no collector's enrollment
token can be read again. The chart's README,
["`scripts/create-secrets.sh`"](../charts/telflo/README.md#scriptscreate-secretssh),
describes the file and rotating its values.

**Trying it before your DNS and TLS are ready.** Install with
`--set publicUrl=http://localhost:8080` instead, and sign in through
step 4's port-forward at `http://localhost:8080`: the session cookies are
Secure, which a browser allows over plain http on `localhost` only. The
bootstrap's link then starts with that address too.

**The first admin** is the product admin, who manages the whole install,
and the admin of the organization the command made. Nobody can sign up
under the default `site.registration: invite-only`, so that admin invites
everyone else. A lost or expired link:
[`telflo-admin reset-link`](configuration.md#telflo-admin-reset-link).

**Your own values file.** Past a first install, keep the values in a file
and pass it with `-f my-values.yaml` to `helm install` and `helm upgrade`.
At least `publicUrl`, `opamp-server.server.publicUrl` and the mail
(`api.mail`), plus your cluster's own: storage classes, the two Services'
annotations, and any `site` value other than the open source's defaults.
[docs/configuration.md](configuration.md) names each setting's chart
value.

**Exposure.** Two Services face outside the cluster, both of type
LoadBalancer by default: the gateway's (`gateway.service`) and the
opamp-server's agent endpoint (`opamp-server.service.agent`). The
opamp-server's management API is always ClusterIP. Terminate TLS at your
load balancer, or at an Ingress or Gateway of your own routed to the
gateway's Service, and give the https origins as the two `publicUrl`s.
`api.trustProxyHops` (default 1, the gateway) counts the proxies that add
an `X-Forwarded-For` entry in front of the API: add yours if it adds one.
Your cloud's annotations go in your values file, never in the chart.

**Sizing.** Each part has its own `replicas` and `resources`, for example:

```yaml
api:
  replicas: 2
  resources:
    requests: { cpu: 250m, memory: 512Mi }
otelcolTesting:
  resources:
    limits: { memory: 2Gi }
```

**Upgrading.** Back up the database first: each new API pod migrates it
as it starts, and going back means restoring the backup. Then run the same
`helm upgrade` with your values file and the new release's `--version`.
The chart's README, ["Upgrade"](../charts/telflo/README.md#upgrade) and
["Uninstall"](../charts/telflo/README.md#uninstall), has the details,
including the volumes an uninstall keeps.

**Tested on a throwaway cluster.** `scripts/smoke-kind.sh` installs the
chart into a kind cluster and drives it end to end
([the chart's README](../charts/telflo/README.md#the-kind-smoke)).
