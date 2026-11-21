# The collector catalog

The OpenTelemetry Collector distributions a configuration can be built for,
and each distribution's collector versions. One hand-edited file per
distribution, `distributions/<distribution>.json`. Today there is one,
`otelcol-contrib.json` (OpenTelemetry Collector Contrib).

This README sits beside the files, not in `telflo-core/`, because the
catalog isn't the TypeScript workspace's: several components read the same
files. The platform's migration step syncs them into the database, the
collector validator's image and the testing image bake in the collectors
they offer, and the collector image's build and publish scripts build one
image per offered version. Whoever edits a file starts here.

## What reads it

- **The platform's migration step** (`npm run db:migrate`, and the stack's
  `migrate` container) validates every file before it touches the
  database, then runs the migrations, then upserts the files into two
  tables, `collector_distributions` and `collector_versions`. An invalid
  catalog stops the step before anything is migrated or written. The API
  reads only the tables, never these files.
- **The test databases** are synced the same way when the tests prepare
  them, so a test run also refuses an invalid catalog.
- **The collector validator's image** (`services/otelcol-validator/Dockerfile`,
  built from the repository's root) reads `otelcol-contrib.json` while it
  builds: it downloads the `linux_amd64` or `linux_arm64` collector of
  every offered (not deprecated) version, or only those its
  `OTELCOL_VERSIONS` build argument names, checks each against the entry's
  `sha256` and bakes it in. A download whose hash isn't the entry's fails
  the build. The image also carries a copy of the files, to know which
  versions exist (`services/otelcol-validator/README.md`).
- **The collector image's build script**
  (`scripts/build-collector-image.sh`) reads `otelcol-contrib.json`
  directly: the build takes a version's `linux_amd64` and `linux_arm64`
  `otelcolContrib` and `opampSupervisor` URLs and `sha256` (refusing an
  unknown or deprecated version and any value that isn't the catalog's
  format), and `build-collector-image.sh --list-offered` gives the collector
  workflow (`.github/workflows/collector.yml`) every offered version, newest
  first, for its `all`. An install's image is tagged by its group's
  collector version, so a newly offered version's image is published (the
  collector workflow with that `collector_version` and `publish: true`, on
  the maintainers' go-ahead: `--build-oci`, then `--push-oci` of those same
  bytes) before a group's published version uses it; the platform's release
  checks that every offered version's image exists (`docs/releasing.md`,
  `docker/collector-image/README.md`).
- **The web app's build** bundles each file's `renamedTypes`: the editor
  maps a component the collector renamed to its palette entry by them, and
  the palette writes a dropped component with the name its version's pin
  knows (`telflo-core/apps/web/app/lib/collector/renamed-types.ts`). It also
  bundles each file's versions, to pick the YAML tab's schema by the pin: an
  offered version gets its generated schema, a deprecated one syntax only
  (`telflo-core/apps/web/app/lib/editor/collector-schema.ts`). The web image
  copies this folder before it builds, and its build refuses to run when no
  `distributions/*.json` arrived. Elsewhere a web built without the files
  never runs without renames: the built server fails to start, and the dev
  server starts but its first page fails. A running web app sees a change
  only once it is rebuilt (the dev server, on its next reload).
- **The validator's rename test** (`services/otelcol-validator/tests/test_binary_renames.py`,
  run in its image with `pytest -m binary`) reads `renamedTypes` and runs
  every offered collector over each rename.
- **The palette-defaults fixture**
  (`services/otelcol-validator/tests/fixtures/palette-defaults.json`) is
  generated from the files' offered versions, each version's
  `supportedComponents` (which palette entries its toolbox shows) and the
  renames, with the palette: what a drop of each palette entry writes on
  each offered version.
  `npm run fixture:palette-defaults --workspace @telflo/web` (from
  `telflo-core/`) writes it; the web's suite fails while it is stale, and
  the validator's binary tests run every offered collector over it. Nothing
  else is generated from the files.
- **The collector schemas**, one per offered version, are generated
  from upstream's files, not from these, but must match them: the
  generator (`telflo-core/apps/web/scripts/generate-otelcol-schemas.ts`)
  refuses to run while its inputs
  (`telflo-core/apps/web/scripts/otelcol-schemas/inputs.json`) don't list
  exactly the offered versions, and the catalog rule test in the web's
  suite (`scripts/generate-otelcol-schemas.test.ts`) fails while
  `telflo-core/apps/web/public/schemas/<distribution>/` doesn't hold
  exactly one file per offered version.

## Adding a collector version

Each upstream release adds one entry. Upstream
(`open-telemetry/opentelemetry-collector-releases`) publishes the collector
and the OpAMP supervisor under separate tags, `v<version>` and
`cmd/opampsupervisor/v<version>`.

1. **Add the entry** to `versions` in
   `distributions/otelcol-contrib.json`, newest first, copying the entry
   below it and changing every version number in it:
   - `version` `0.163.0` (major.minor.patch), `label` `v0.163.0`,
     `description` null unless there is something to say;
   - `releasedAt`: the date of upstream's `v<version>` tag, in UTC
     (`YYYY-MM-DD`), as the other entries have it;
   - `default` false, `deprecated` false, `deprecatedNote` null;
   - `containerImage` `otel/opentelemetry-collector-contrib:0.163.0`
     (check the image exists);
   - `distribution` the file's own (`otelcol-contrib`),
     `otelcolContribVersion` null and `supportedComponents` null (Contrib
     supports every component);
   - `otelcolContrib` and `opampSupervisor`: a `downloadUrl` and a
     `sha256` for each of the five platforms (`linux_amd64`,
     `linux_arm64`, `darwin_amd64`, `darwin_arm64`, `windows_amd64`), ten in
     all. The URLs follow the other entries' pattern: the collector's
     `…/download/v<version>/otelcol-contrib_<version>_<platform>.tar.gz`
     (Windows too), the supervisor's
     `…/download/cmd%2Fopampsupervisor%2Fv<version>/opampsupervisor_<version>_<platform>`
     (`.exe` on Windows).

2. **Take each hash from upstream, two ways.** Upstream stopped publishing
   `checksums.txt` after v0.140.0. Each asset now has its own
   `<asset>.sha256` file beside it; read the hash from there, and check it
   against the asset's `digest` in the GitHub API. Both must match. For
   example, for one asset:

   ```bash
   base=https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download
   curl -sSL "$base/v0.163.0/otelcol-contrib_0.163.0_linux_amd64.tar.gz.sha256"
   gh api repos/open-telemetry/opentelemetry-collector-releases/releases/tags/v0.163.0 \
     --jq '.assets[] | select(.name == "otelcol-contrib_0.163.0_linux_amd64.tar.gz") | .digest'
   # the supervisor's tag: releases/tags/cmd%2Fopampsupervisor%2Fv0.163.0
   ```

   The `.sha256` file holds the bare hash; the `digest` is `sha256:`
   followed by the same hash. Do this for all ten assets. Never take a hash
   from a mirror, a blog or an earlier entry.

3. **Add the version's renames.** Read upstream's changelog for the
   release (`opentelemetry-collector-contrib`'s and the core collector's)
   for components renamed to a new type, the old one kept as a deprecated
   alias (`deprecated_type` in the component's `metadata.yaml`). Add each
   to the file's `renamedTypes` (below), `since` the new version, and add
   its smallest accepted configuration to the rename test's
   `CONFIGURATIONS` (the test fails, naming it, until you do). CI's
   `otelcol-validator` job then runs every offered collector over every
   **listed** rename: the new name passes from `since` on and is an unknown
   type before it, and the old name passes on every offered version. What
   that catches is narrow, so the changelog reading is the check:
   - a rename you don't list is never tested, and nothing fails: the
     palette keeps writing the old name, which the collector still
     accepts (with a deprecation warning when it starts);
   - a wrong `since` fails only when an offered version lies between the
     right one and yours; when none does (both at or before the oldest
     offered version, say), the test passes. The palette then writes the
     wrong name for a pin between the two: no offered version, but a
     version still pinned to a retired release there gets it on every drop
     (the old name where the collector already knew the new one, which it
     still accepts; or the new name where it didn't yet, which that
     collector refuses, and the validator, which doesn't check a retired
     pin, doesn't say).

4. **Making it the default** is a product decision, not part of adding it:
   every new configuration gets the default, and the component forms were
   built against 0.162.0. To move it, set `default` true on the new entry
   and false on the old one, and move the old entry's `description`
   ("Current default.") with it. Existing versions keep their pins: nothing
   moves a version's collector version but a person.
   **The OTTL evaluator moves with the default**: its
   `pkg/ottl` must be the default's version, and
   `services/ottl-evaluator/pkg/ottlassert/ottl_version_test.go`'s
   `TestOTTLVersionIsTheCatalogueDefault` fails until it is (it reads this
   file and the evaluator's `go.mod`). Move `pkg/ottl` and
   `componenttest` to the new version and `pdata` to its match (`go get …
   && go mod tidy` with `GOTOOLCHAIN=local`), run the evaluator's checks
   (`services/ottl-evaluator/README.md`), and read OTTL's changelog for
   converters added or removed and for what no longer parses, since stored
   rules were checked against the old one.
   **So does the stack smoke's collector**:
   `docker/smoke-collector/Dockerfile` copies the default's
   `/opt/otelcol/v<version>/otelcol-contrib` out of the validator image and
   runs it under the OpAMP supervisor of the same version, and
   `scripts/smoke-test-stack.sh` fails before its first step until both
   name the new default.

5. **Sync and check.** From `telflo-core/`, `npm run db:migrate` validates
   the catalog and syncs it into your development database; a second run
   writes nothing. The catalog's own test checks the committed files:
   `npm test` runs it with everything else, or run just it with
   `npx vitest run packages/db/src/collector-catalogue/catalogue.test.ts`
   (with `npm run dev:services` up, as for every test run). The compose
   stack picks the change up when its images are rebuilt (`docker compose
   up --build`), since the `migrate` image carries a copy of this
   folder. A running API serves the new rows at once; a browser sees them
   on its next page load.

6. **The validator's image bakes it in.** Every offered version is in the
   collector validator's image, so the new entry's collector is downloaded
   and checked against its `sha256` the next time the image is built:
   locally with `docker compose build otelcol-validator` from the
   repository root (a stack started with `docker compose up --build`
   rebuilds it too), and in CI's `otelcol-validator` job, which builds the
   image with every offered version and runs the real-collector tests in
   it. A wrong `sha256` or URL fails that build. Until its image is
   rebuilt, a running validator doesn't know the new version and can't
   check it.

7. **Write the palette-defaults fixture again.** From `telflo-core/`,
   `npm run fixture:palette-defaults --workspace @telflo/web` and commit
   `services/otelcol-validator/tests/fixtures/palette-defaults.json` (the
   web's suite fails, naming the command, until you do). The validator's
   binary tests then run the new collector over every palette default and
   over the component forms' handoff cases
   (`tests/test_binary_handoffs.py`): a default it refuses, or a handoff
   case whose answer changed, fails CI's `otelcol-validator` job until its
   expected answer is settled.

8. **Generate the version's collector schema**. Add the version to
   `versions` in `telflo-core/apps/web/scripts/otelcol-schemas/inputs.json`
   with its three tags, each pinned to its commit: contrib's and core's
   `v<version>` (core's `v0.N` is the same commit as its `v1.(N-94)`) and
   the releases repository's `v<version>`. Then, from `telflo-core/`,
   `npm run generate:otelcol-schemas --workspace=@telflo/web` (it fetches
   upstream with `git`) and commit
   `apps/web/public/schemas/otelcol-contrib/v<version>.json`. The web's
   catalog rule test fails until the file exists, and its schema tests
   check that every listed rename's old name is accepted by the new schema
   from its `since` (the schema's old names are the `deprecated_type` each
   built component's `metadata.yaml` gives). The
   run stops, naming it, on a reference upstream never wrote, an open part
   the version no longer uses, a built component upstream has no schema
   for (list it in `open-parts.json`, or in `hand-written.json`'s
   `withoutSettings` if it takes none), or a setting upstream names after a
   Go field (a capital first letter): check each against the collector's Go
   at the tag and edit `otelcol-schemas/open-parts.json`.
   Six of its entries are limited to versions ending at 0.162.0
   (sd_notify, span_pruning, credentialsfile's `retry_on_failure_config`,
   the two azure `resource_attributes_config`, carbon's
   `internal/protocol.parser_config`): where one still holds at the new
   version, the run says to extend its `versions`. A component the
   manifest newly builds from outside contrib and core goes in
   `inputs.json`'s `external`, with its module, kind, type and repository.
   The web's schema
   warnings test (`app/lib/editor/otelcol-schema-warnings.test.ts`) then
   runs every palette default and corpus text on the new schema; a new
   warning is either upstream wrong (an open part) or a text the collector
   refuses (an expected warning, with its reason).

## The collector's renames (`renamedTypes`)

Upstream renames component types now and then (`filelog` became `file_log`
in 0.149.0), keeping the old name as a deprecated alias. Each file lists its
distribution's renames, required, `[]` when there are none:

```json
"renamedTypes": [
  { "kind": "receiver", "name": "file_log", "deprecatedName": "filelog", "since": "0.149.0" }
]
```

- `kind`: `receiver`, `processor`, `exporter`, `connector` or
  `extension`, singular. Every rename is that kind's only: the OTLP
  exporter became `otlp_grpc`, the receiver is still `otlp`, so an
  `otlp_grpc` receiver is a type the collector doesn't have.
- `name`: the current type; `deprecatedName`: the old one, which the
  palette spells. Both a lowercase letter, then lowercase letters, digits
  or `_`, at most 64 characters, and never the same.
- `since`: the upstream version from which `name` is accepted
  (major.minor.patch). It needn't be a version the file offers. The palette
  writes `name` for a component dropped on a version pinned at or after it,
  `deprecatedName` before it; changing the pin later rewrites nothing.
- No chain: a kind's `deprecatedName` is never another of its renames'
  `name` in the same file (a type renamed twice is one entry, from its
  oldest name the palette spells to its newest).
- The sync stores the list as it is, in its order
  (`collector_distributions.renamed_types`), and
  `GET /api/v1/collector-distributions` serves it with each distribution;
  the web reads its own copy from these files when it is built.

The starting 16 were established by running every offered collector;
three of the comments they replaced had the wrong version.

## Retiring a version

**Never delete a version, and never remove a distribution.** A
configuration version may be pinned to it, and the sync refuses a catalog
that drops a row the database holds, changing nothing. Instead, set
`deprecated` true and give a `deprecatedNote` saying why (it becomes the
tooltip). A deprecated version leaves the pickers; a version already pinned
to it keeps its pin, shown as `v0.155.0 (deprecated)`. The default can't be
deprecated: move the default first. The validator's image drops a deprecated
version's collector the next time it is built, so a version pinned to it is
no longer checked. Remove the version from
`telflo-core/apps/web/scripts/otelcol-schemas/inputs.json` and run the
generator, which deletes its schema: a version pinned to it gets syntax
markers only in the YAML tab. The web's catalog rule test fails until the
file is gone.

A flow pinned to it keeps its pin, and "Use this flow" and "Start from a
flow" create a copy of it on the distribution's default version instead,
saying so in the dialog. The seeded flows' checks follow the same rule by
themselves: the validator's binary test
(`services/otelcol-validator/tests/test_binary_flows.py`) and the web's
schema tests (`otelcol-schema-warnings.test.ts`, the ClickStack block of
`otelcol-schema.test.ts`) check a flow on its pin while the catalog offers
it, else on the default, so nothing there needs editing, and the
seeded-flows fixture keeps the old pin. Then re-pin the live flows on the
version: in `/product-admin/flows` (a product admin), the table's Collector
column marks each flow whose pin the catalog no longer offers ("No longer
offered"); edit each one and pick an offered version. Copies made before
keep their own pins, as every configuration does.

Migration 023 holds a copy of 0.162.0's row, for its backfill. It is never
edited: the sync updates that row like any other.

## A migration that needs a catalog row

The migrations run before the sync, so a migration can't count on the files'
rows being in the tables yet: on a new database they aren't. A migration
that needs a row (as 023's backfill needs 0.162.0) inserts that row itself,
and the sync then updates it from the file like any other.

## Switching to a branch with an older catalogue

A database synced from a newer catalog holds rows an older branch's files
don't list, and the sync refuses that catalog (`npm run db:migrate` and
`npm test` fail, naming the rows) rather than deleting a row a configuration
may be pinned to. It changes nothing, and nothing in the code works around
it. To recover:

- **The test databases** (`telflo_platform_test`, and the browser tests'
  `telflo_platform_e2e_test`): drop them. Their suites recreate and sync them on the
  next run.
- **Your own `telflo`:** put each missing row back in its file, a version
  with `deprecated` true and a `deprecatedNote` saying why, then run
  `npm run db:migrate`. Never delete the row from the database: a
  configuration version may be pinned to it.

## The validator's rules, in brief

`packages/db/src/collector-catalogue/catalogue.ts` checks every rule below.
It lists every problem it finds, by file and entry. In brief:

- **The files:** each is `<distribution>.json`, named after its
  `distribution` (lowercase words joined by single hyphens, at most 64
  characters), with a non-empty `label`; a distribution is in one file
  only; no field outside the format.
- **Defaults:** exactly one distribution is the default; each distribution
  has exactly one default version, which isn't deprecated.
- **Each version:** listed once; `version` major.minor.patch, at most 64
  characters; `releasedAt` a real `YYYY-MM-DD` date; a non-empty `label`;
  `distribution` its file's; a deprecated version has its
  `deprecatedNote`.
- **Downloads, in every entry:** each `downloadUrl` is exactly upstream's
  release of the entry's own version and platform, under
  `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/`
  (the patterns in step 1); each `sha256` is 64 lowercase hex characters.
- **Offered (not deprecated) versions:** a valid `containerImage`, and
  both binaries for all five platforms (a deprecated entry may have gaps).
- **`supportedComponents`:** null (every component) or exactly the five
  sections (`receivers`, `processors`, `exporters`, `connectors`,
  `extensions`). A distribution other than Contrib names the live Contrib
  version it is built on (`otelcolContribVersion`); a container-only one
  lists what it supports, no section empty.
- **`renamedTypes`:** in every file, each entry exactly `kind`, `name`,
  `deprecatedName` and `since` in the formats above; a kind's `name` is
  renamed once and its `deprecatedName` listed once in a file; no chain (a
  kind's `deprecatedName` is never another of its renames' `name` in the
  same file); and since the web's table is the union of the files, a
  kind's `name` has the same `deprecatedName` in every file.

The opamp-server checks a publication's `collector.distribution` and
`collector.version` against the same formats.
