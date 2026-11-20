# Provenance

The evaluator's code is Telflo's own. It copies no third-party source: the
OpenTelemetry code it runs comes in as Go modules, at the versions `go.mod`
pins and `go.sum` checks.

- **OTTL**: `github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl`
  (Apache-2.0), with `pdata` and `componenttest` from the OpenTelemetry
  Collector (Apache-2.0). `pkg/ottl` follows the catalog's default
  collector version (`catalog/distributions/otelcol-contrib.json`):
  `pkg/ottlassert`'s `TestOTTLVersionIsTheCatalogueDefault` fails when they
  differ.
- **Test only**: `github.com/getkin/kin-openapi` (MIT), for
  `internal/server`'s OpenAPI conformance test; no file but a test imports
  it, so it is never in the binary (`TestKinOpenAPIIsATestOnlyDependency`).

Every module's license is checked by `scripts/check-licenses.sh` against the
platform's policy (`scripts/license-policy.json`): a license outside its
allowed list passes only when it is MPL-2.0 and the module, at the version
the build uses, is named in the policy's `goModules`.
