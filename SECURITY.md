# Security policy

## Supported versions

Before 1.0, only the latest release gets security fixes. A fix ships as a
new release; upgrade to it as its release notes describe.

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through GitHub: this
repository's **Security** tab → **Report a vulnerability**. Only the
maintainers see the report.

Include what you can of:

- the release or commit, and how you run it (the Compose install, the
  Helm chart, or from source);
- which part is affected: the web app, the API, the gateway, the CLI, the
  collector image, the Compose install, the Helm chart or the release
  artifacts;
- the steps to reproduce it, and what an attacker gains.

You'll get an acknowledgement, then updates until it's fixed or declined.
Once a fix is released, it's published as a GitHub security advisory,
crediting you unless you'd rather not be named.

A vulnerability in the opamp-server itself goes to
[telflo/opamp-server](https://github.com/telflo/opamp-server/security)
the same way.

## Running it safely

- Use a release's Compose install or the Helm chart, not the repository's
  `docker-compose.yml`: that one is for development, with committed
  passwords and keys.
- Put TLS in front of the gateway and the agent endpoint; Telflo serves
  plain http ([docs/compose.md](docs/compose.md),
  [docs/kubernetes.md](docs/kubernetes.md)).
- Generate every secret and key the install asks for, and keep them out of
  version control ([docs/configuration.md](docs/configuration.md)).
