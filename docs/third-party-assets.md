# Third-party assets

Artwork telflo ships that others made, with where each came from and under
what license. Code dependencies are covered by `npm run check:licenses`;
this file covers what is copied into the source instead (path data, images,
fonts not installed from npm, and built code vendored unchanged), and data
generated from others' files. D30's notices file is built from it.

Each asset also carries its source and license in a comment beside it.

## Vendor marks

The builder's canvas, toolbox and Configuration tab show these marks to name
the system a component talks to (D9a decision 10), each drawn as a
monochrome silhouette tinted in the component type's colour. The OTLP/HTTP
exporter's quick setups show them beside the backend each pre-fills (D9b
decision 8), drawn in colour: Grafana in its orange, Dynatrace
in the text colour, Datadog in its purple. The public flows library's and
the landing showcase's flow tiles show them as a flow's sources and
destinations (D12 Preflight ruling 10), each in a round badge, tinted in the
brand colour (`--mkt-logo-*` in `app.css`) or, for Elastic, in its own
colours; the landing page's integrations draw some of the same path data
(`components/landing/brand-icons.tsx`). The marks are their owners'
trademarks; a copyright license on the artwork grants no trademark rights.

| Mark | Used for | File | Source | License | Changes |
|---|---|---|---|---|---|
| Kubernetes | the Kubernetes receivers (`k8s_cluster`, `k8s_events`, `k8sobjects`, `kubeletstats`) and the `k8sattributes` processor | `telflo-core/apps/web/app/components/editor/builder/icons/KubernetesIcon.tsx` | devicon, [`icons/kubernetes/kubernetes-plain.svg` at `d98a72c`](https://github.com/devicons/devicon/blob/d98a72cb9a6d8e543ddbddc32bac231572349e96/icons/kubernetes/kubernetes-plain.svg) (2021-05-15) | MIT (devicon, Copyright (c) 2015 konpa) | split into one path per shape; fill `currentColor`. Kubernetes is a trademark of The Linux Foundation |
| Datadog | the Datadog receiver and exporter, the OTLP/HTTP exporter's "Datadog" quick setup, and the flow tiles of the public flows library and the landing showcase (D12, through `components/marketing/flows-ui.tsx`) | `telflo-core/apps/web/app/components/editor/builder/icons/DatadogIcon.tsx` | Simple Icons release 16.33.0, [`icons/datadog.svg` at `e01988c`](https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/datadog.svg) (tag `16.33.0`, commit `e01988cc57a3aca39621023f9881e9b733ebcd77`; Simple Icons cites [Datadog's press resources](https://www.datadoghq.com/about/resources)) | CC0-1.0 (Simple Icons) | none to the path; fill `currentColor` (tinted `#632CA6` in the quick setup, `--mkt-logo-datadog` on the flow tiles). Datadog is a trademark of Datadog, Inc., used under its brand guidelines |
| Grafana | the OTLP/HTTP exporter's "Grafana Cloud" quick setup | `telflo-core/apps/web/app/components/editor/builder/icons/GrafanaIcon.tsx` | Simple Icons release 16.33.0, [`icons/grafana.svg` at `e01988c`](https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/grafana.svg) (tag `16.33.0`, commit `e01988cc57a3aca39621023f9881e9b733ebcd77`; Simple Icons cites [grafana.com](https://grafana.com)) | CC0-1.0 (Simple Icons) | none to the path; fill `#F46800` (Simple Icons' brand colour). Grafana is a trademark of Grafana Labs |
| Dynatrace signet | the OTLP/HTTP exporter's "Dynatrace" quick setup | `telflo-core/apps/web/app/components/editor/builder/icons/DynatraceIcon.tsx` | the npm package `@dynatrace/strato-icons` 2.6.1, `DynatraceSignetIcon` (`__icons/DynatraceSignetIcon.js`), from the tarball [`strato-icons-2.6.1.tgz`](https://registry.npmjs.org/@dynatrace/strato-icons/-/strato-icons-2.6.1.tgz) (integrity `sha512-gJWByoJQ7QXxpeduLgLQEvOqUfR2HaM7S+41PGSKDbXJce4UI/D+glM2/LlYYZa1O4AVRvr41XGfOI1j6brJuw==`) | Apache-2.0 (the package's `LICENSE`) | none to the four paths; viewBox `0 0 20 20` and fill `currentColor`, as the package draws it. Dynatrace is a trademark of Dynatrace LLC |
| Kubernetes (Simple Icons) | the flow tiles (D12), and the landing page's integrations (since D4) | `telflo-core/apps/web/app/components/marketing/flow-logos.tsx` (`KubernetesLogo`) and `telflo-core/apps/web/app/components/landing/brand-icons.tsx` (`BRANDS.kubernetes`) | Simple Icons release 16.33.0, [`icons/kubernetes.svg` at `e01988c`](https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/kubernetes.svg) (tag `16.33.0`, commit `e01988cc57a3aca39621023f9881e9b733ebcd77`; Simple Icons cites [kubernetes/kubernetes' `logo/` at `cac5388`](https://github.com/kubernetes/kubernetes/tree/cac53883f4714452f3084a22e4be20d042a9df33/logo)) | CC0-1.0 (Simple Icons) | none to the path (checked against [jsDelivr's copy](https://cdn.jsdelivr.net/npm/simple-icons@16.33.0/icons/kubernetes.svg), sha256 `ceee2f4e87fa1533600672190c156194039f744fa9b5da10e83f002178e84b47`); fill `currentColor`, tinted `--mkt-logo-kubernetes` on the tiles; `#326CE5` (Simple Icons' brand colour) on the landing page. Kubernetes is a trademark of The Linux Foundation |
| Prometheus | the flow tiles (D12), and the landing page's integrations (since D4) | `telflo-core/apps/web/app/components/marketing/flow-logos.tsx` (`PrometheusLogo`) and `telflo-core/apps/web/app/components/landing/brand-icons.tsx` (`BRANDS.prometheus`) | Simple Icons release 16.33.0, [`icons/prometheus.svg` at `e01988c`](https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/prometheus.svg) (tag `16.33.0`, commit `e01988cc57a3aca39621023f9881e9b733ebcd77`; Simple Icons cites [prometheus.io](https://prometheus.io)) | CC0-1.0 (Simple Icons) | none to the path (sha256 of the SVG `6dd2480e57936b879f7626b7c71dcd51163da700d8510843516a66316bf8f379`); fill `currentColor`, tinted `--mkt-logo-prometheus` on the tiles; `#E6522C` (Simple Icons' brand colour) on the landing page. Prometheus is a trademark of The Linux Foundation |
| ClickHouse (Simple Icons, one colour) | the flow tiles (D12) | `telflo-core/apps/web/app/components/marketing/flow-logos.tsx` (`ClickHouseLogo`) | Simple Icons release 16.33.0, [`icons/clickhouse.svg` at `e01988c`](https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/clickhouse.svg) (tag `16.33.0`, commit `e01988cc57a3aca39621023f9881e9b733ebcd77`; Simple Icons cites [the ClickHouse repository's `logo-clickhouse.svg` at `12bd453`](https://github.com/ClickHouse/ClickHouse/blob/12bd453a43819176d25ecf247033f6cb1af54beb/website/images/logo-clickhouse.svg)) | CC0-1.0 (Simple Icons) | none to the path (sha256 of the SVG `9fa7c12613763111ca26bbc1fe10994960028bc3da9faf47247de231a0b27589`); fill `currentColor`, tinted `--mkt-logo-clickhouse` on a dark badge. ClickHouse is a trademark of ClickHouse, Inc. |
| Elastic (cluster mark) | the flow tiles (D12 decision 17) | `telflo-core/apps/web/app/components/marketing/flow-logos.tsx` (`ElasticLogoColor`) | EUI (Elastic UI) v30.6.0, [`src/components/icon/assets/logo_elastic.svg` at `2086a97`](https://github.com/elastic/eui/blob/2086a97230b9d99c4e584522945397b63ce9daf9/src/components/icon/assets/logo_elastic.svg) (tag `v30.6.0`, commit `2086a97230b9d99c4e584522945397b63ce9daf9`; sha256 of the SVG `94e884ecdca7ec6b9312244abb9a1df898a8c9381fa69634df29c1d95593b7fe`) | Apache-2.0 (EUI's `LICENSE` and `package.json` at that commit). EUI's `NOTICE.txt`: "EUI / Copyright 2012-2018 Elasticsearch B.V.", which D30's notices file reproduces with the license; the rest of that NOTICE covers two MIT-licensed date-picker sources the mark doesn't come from | none to the seven paths, their fills (`#FFFFFF`, `#FEC514`, `#00BFB3`, `#F04E98`, `#1BA9F5`, `#93C90E`, `#0077CC`) or the viewBox (`0 0 32 32`); the root's `width` and `height` dropped for the badge's size class. Elastic is a trademark of Elasticsearch B.V. |
| ClickHouse bars (ClickStack's mark) | the ClickHouse exporter | `telflo-core/apps/web/app/components/editor/builder/icons/ClickStackIcon.tsx` | the ClickHouse repository, [`website/images/logo-clickhouse.svg` at `12bd453`](https://github.com/ClickHouse/ClickHouse/blob/12bd453a43819176d25ecf247033f6cb1af54beb/website/images/logo-clickhouse.svg) (the artwork Simple Icons cites) | Apache-2.0 (the ClickHouse repository, Copyright 2016-2022 ClickHouse, Inc.) | the bars only, without the wordmark; the first bar's red segment merged into one bar; fill `currentColor`. ClickHouse is a trademark of ClickHouse, Inc. |

## Project marks

The OpenTelemetry mark names the collector build a configuration is for, not
a system a component talks to, and is drawn in its own two colours, so it
has its own section. D13a shows it beside the OpenTelemetry Collector
Contrib distribution (D13a decision 13, Preflight ruling 19): in the create
dialog's Distribution dropdown, the editor toolbar's locked distribution and
the configurations list's distribution tag. The landing page has drawn the
same path data since D4. One row covers both copies. cncf/artwork states no
copyright license: its `LICENSE.md` points only to the Linux Foundation's
trademark usage guidelines. D30 revisits these terms before any bundle
ships.

| Mark | Used for | File | Source | License | Changes |
|---|---|---|---|---|---|
| OpenTelemetry (two-tone) | the OpenTelemetry Collector Contrib distribution (D13a), the landing page's integrations, and the flow tiles of the public flows library and the landing showcase (D12, through `components/marketing/flows-ui.tsx`) | `telflo-core/apps/web/app/components/collector/OtelIcon.tsx` (`OtelIcon`) and `telflo-core/apps/web/app/components/landing/brand-icons.tsx` (`BRANDS.opentelemetry`) | cncf/artwork, [`projects/opentelemetry/icon/color/opentelemetry-icon-color.svg` at `0026624`](https://github.com/cncf/artwork/blob/002662490acb2303c7301acc0256c00790e03e9f/projects/opentelemetry/icon/color/opentelemetry-icon-color.svg) (commit `002662490acb2303c7301acc0256c00790e03e9f`) | the Linux Foundation's trademark usage guidelines; no copyright license stated | none to the two paths or their fills (`#F5A800`, `#425CC7`); viewBox `-12.7 -12.7 1024.4 1024.4`. OpenTelemetry is a trademark of The Linux Foundation |

## Generated data

Data telflo generates from upstream's files and ships. The YAML tab's
Monaco reads the collector's configuration schema of the version's pin for
completion, hover and Warning markers (D13c decisions 1 and 14). One file
per offered collector version is generated by
`telflo-core/apps/web/scripts/generate-otelcol-schemas.ts`
(`npm run generate:otelcol-schemas --workspace=@telflo/web`) from
upstream's files at that version's tags, each pinned to its commit in
`telflo-core/apps/web/scripts/otelcol-schemas/inputs.json`, and committed;
each file's top-level `$comment` names its sources, their commits and the
license. Upstream's repositories are Apache-2.0. Only contrib carries a
NOTICE file; it covers two pieces of code, hostmetrics' processscraper
(`process.go`, code from gopsutil, BSD-3-Clause) and `internal/grpcutil`
(code derived from gRPC-Go, Apache-2.0), neither of which feeds a schema,
and D30's notices file reproduces it with the license.

| Data | Used for | File | Source | License | Changes |
|---|---|---|---|---|---|
| The OpenTelemetry Collector Contrib configuration schemas, one per offered version (0.159.0 to 0.162.0) | the YAML tab's completion, hover and schema Warnings, by the version's pin (D13c) | `telflo-core/apps/web/public/schemas/otelcol-contrib/v<version>.json` | the `config.schema.yaml` files and the `metadata.yaml` type names (and `deprecated_type` aliases) of [open-telemetry/opentelemetry-collector-contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) and [open-telemetry/opentelemetry-collector](https://github.com/open-telemetry/opentelemetry-collector), and `distributions/otelcol-contrib/manifest.yaml` of [open-telemetry/opentelemetry-collector-releases](https://github.com/open-telemetry/opentelemetry-collector-releases) (which components the distribution builds), each at the version's tag, pinned to the commit `inputs.json` lists | Apache-2.0 (Copyright The OpenTelemetry Authors); contrib's NOTICE named above | generated, not copied: upstream's references resolved and its compositions flattened into one file per version, every object closed, readable definition names, a `${…}` reference (and null, a plain string or an integer where the collector reads one) accepted, `x-*` extensions, formats and titles dropped; the service section written by hand (`otelcol-schemas/hand-written.json`); the parts upstream describes wrongly or not at all opened, each with its reason in `otelcol-schemas/open-parts.json` |

## Vendored code

Built files of another project, copied into the source unchanged rather
than installed from npm. Swagger UI draws the API reference page,
`/api/public/v1/docs/` (D25 decision 49, Preflight ruling 20; Q170): the
npm package `swagger-ui-dist` depends on `@scarf/scarf`, whose postinstall
script sends install-time telemetry, so its files are vendored instead of
installed. `npm run check:licenses` checks the folder against
`scripts/license-policy.json`'s `vendored` entry: exactly these files, each
with the sha256 below, under those licenses. The API serves only the
bundle and the stylesheet (with its own `index.html` and `init.js` beside
the folder); the license files ship with them for D30's notices file.

| Code | Used for | Files | Source | License | Changes |
|---|---|---|---|---|---|
| Swagger UI 5.32.15 | the API reference page (D25): the OpenAPI document's operations, Authorize and try-it | `telflo-core/apps/api/src/modules/public-api/docs/swagger-ui/`: `swagger-ui-bundle.js` (sha256 `a7e344f2770b2f07527ce828e0951626983b8f2dcdb7a826689c0232023f995b`), `swagger-ui.css` (sha256 `d7f39f764aa18c7b47dd05b9af5613e373e4ac0f3557c2693d52d0abc2464d76`), `LICENSE` (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), `NOTICE` (sha256 `0d20d1adef18aee3f40dd258172155521ce702ac445cb5f7b7d60ed32dad2fb2`), `swagger-ui-bundle.js.LICENSE.txt` (sha256 `63818894e4b04cd0e3180d9cb20761e227a939121e7484f8e1d528227c756f89`) | the npm tarball [`swagger-ui-dist-5.32.15.tgz`](https://registry.npmjs.org/swagger-ui-dist/-/swagger-ui-dist-5.32.15.tgz) (published 2026-09-04; integrity `sha512-TSFER+rFQlf1nzk6WvKkMaHTxAPQ3eAAxigFThnxQedSREanfZgSbJFayZVs/ULnSbNdrJOb99vLD6xpb3R3eg==`, checked against the registry's), from [swagger-api/swagger-ui](https://github.com/swagger-api/swagger-ui) | Apache-2.0 (`LICENSE`; `NOTICE`: "swagger-ui / Copyright 2020-2021 SmartBear Software Inc.", which D30's notices file reproduces). The bundle's own list, `swagger-ui-bundle.js.LICENSE.txt`, is PARTIAL (webpack keeps only the banners marked to be preserved): it names MIT (React, react-dom, scheduler, use-sync-external-store, Immutable, classnames, deep-extend, buffer, fast-json-patch, repeat-string, safe-buffer), BSD-3-Clause (ieee754) and DOMPurify 3.4.13 (Apache-2.0 or MPL-2.0; Apache-2.0 chosen); the bundle also holds code whose banners it drops, e.g. zenscroll (Unlicense), remarkable (MIT), short-unique-id and apidom (Apache-2.0). D30's notices file lists swagger-ui@5.32.15's production dependencies in full | none: byte for byte the tarball's files. The stylesheet's last line names a source map (`swagger-ui.css.map`) that isn't vendored; a browser asks for it only with its developer tools open, and gets the page's 404 |
