<!-- naming-check: allow-telflow-references -->
<!-- This document quotes the banned misspelling when specifying the rule that bans it.
     See scripts/check-naming.sh for the CI guard this document defines. -->

# Naming and ubiquitous language

**Source:** design spec §3.12

**`telflo`, never `telflow`** — enforced by a CI grep that fails the build.

One term per concept, used identically in schema, API, code and UI:

| Term | Means | Replaces |
|---|---|---|
| `organization` | The tenant boundary; owns everything | `org`, `org_id` |
| `user` | A person | — |
| `organization_member` | user ↔ organization with a role | `org_users` |
| `configuration` | A collector config someone edits | — |
| `configuration_version` | An immutable revision | — |
| `publication` | Immutable, self-describing snapshot of a configuration version, served to collectors (in `telflo_opamp_server`; ADR 0026) | `published_configuration` |
| `fleet` | Labeled group of collectors sharing enrollment and default config | `deployment` (old sense) |
| `collector_group` | Subdivision within a fleet with its own configuration | — |
| `collector_instance` | One running collector | `client_instance` |
| `enrollment_token` | Credential a collector uses to join a fleet | `client_token` |
| `install_template` | Files rendered into an install bundle | `deployment_template` |
| `install_option` | A platform/architecture install choice | `deployment_option` |

Banned: `org`, `config`, `deployment` meaning a fleet, `client` meaning a
collector, and `telflow` in any casing.

`organization_id` is kept in `telflo_opamp_server`, as an opaque tenant key, rather
than renamed to `tenant_id`. The open-source boundary is enforced by separate
databases and the opamp-server's API (ADR 0026), not by vocabulary; two names for one value imposes
a permanent translation tax on engineers, logs and support. One line in
opamp-server's README — *"`organization_id` is an opaque owner identifier
supplied by the integrator; opamp-server never interprets it"* — does the same
job. This would flip only if opamp-server were ever to be embedded in another
product with a different ownership model.

## Database

| Rule | Example |
|---|---|
| Schema: every object in `platform`, never `public` (`PLATFORM_SCHEMA` in `packages/db`); a `SECURITY DEFINER` function pins `search_path = platform, pg_temp` or `pg_catalog, platform` | `platform.users`, `platform.pgmigrations` |
| Database and roles: `telflo_platform`, owned by `telflo_platform_owner` (runs the migrations); the privileges in `telflo_platform_runtime` (no login), held by the API's login `telflo_platform`. Roles and databases belong to the whole Postgres server, so they carry the full prefix; the schema doesn't | `telflo_platform_owner`, `telflo_platform_test` |
| Tables: plural snake_case | `users`, `configurations`, `collector_groups` |
| No abbreviations | `organization_id`, never `org_id` |
| Primary key | `id uuid primary key default uuidv7()` |
| Foreign keys | `<singular>_id` |
| Junction tables | both nouns plural — `organization_members` |
| Timestamps | always `timestamptz`, UTC — `created_at`, `updated_at`, `deleted_at` |
| Booleans | `is_` / `has_` prefix |
| Enums | Postgres enum type, singular name — `deployment_status` |
| Indexes | `idx_<table>_<cols>`, unique `uq_<table>_<cols>`, FK `fk_<table>_<ref>`; in `telflo_opamp_server` an index's `<cols>` leave out the leading `organization_id` every index has, and no name is longer than 63 bytes (see below) |
| Views | suffix `_view` |
| Functions | verb-first snake_case |

**Index names in `telflo_opamp_server`** (D16a Preflight ruling 3, 2026-10-12).
Every index on an organization's rows leads with `organization_id`
(the opamp-server's `CONTRIBUTING.md`, "SQL", in its own repository since
D26; `docs/conventions/go.md` until then), so an index's name leaves that column out:
`idx_<table>_<the columns after organization_id>`
(`idx_collector_instances_fleet_id_name`), and so does a partial unique
index's (`uq_collector_groups_fleet_id_where_is_default`). A unique
constraint's name lists its columns whole, the organization included, as
the composite keys' targets must (`uq_fleets_organization_id_id`,
`uq_fleets_organization_id_label`). Every name stays within Postgres's 63
bytes: a longer one is silently cut, and its `comment on` then names the
cut one. D11a's `idx_publications_organization_id_configuration_id`
predates the rule and keeps its name.

**Exception: the collector catalogue's columns** (D13a, 2026-10-06). The
columns of `collector_distributions` and `collector_versions` mirror the
field names of the catalogue's files (`catalog/distributions/*.json`,
a format other components share), snake_cased, so the boolean `deprecated` keeps its
name rather than becoming `is_deprecated` (D13a Ruling 25). The files are
read by other components too (D13b's validator, D14, D18), so the files'
names stay as they are and the columns follow them. `is_default` (the
files' `default`) follows the rule.

## API

| Rule | Example |
|---|---|
| REST, kebab-case, plural nouns | `/api/v1/organizations/:organizationId/configurations` |
| Surfaces | `/api/v1/*` (cookie session), `/api/public/v1/*` (`tf_` tokens) |
| JSON is camelCase; the database is snake_case | Mapping happens in the repository layer, exactly once |
| Error envelope | `{ error: { code, message, details? } }` |
| Pagination | `?limit=&cursor=` → `{ items, nextCursor }` |
| No verbs in paths | `POST /configurations` |

JWT claims are the one exception to camelCase JSON: they follow JWT
convention (`sub`, `iat`, `organization_id`), because they sit alongside
registered claims that are snake_case by specification.

## TypeScript

| Rule | Example |
|---|---|
| Files | kebab-case — `configuration-repository.ts` |
| React components | PascalCase file and export |
| Types and interfaces | PascalCase. An interface implemented by a factory or a class takes an `I` prefix: `IUserRepository`, `IMailer`, or `IBook` for a `class Book implements IBook`. Standalone shapes that nothing implements don't, whether written as `interface`, `type` or Zod inference: `User`, `EmailMessage`, `RegisterRequest` (ADR 0020) |
| Zod schema / inferred type | `ConfigurationSchema` → `type Configuration` |
| Contracts | `CreateConfigurationRequest` / `CreateConfigurationResponse` |
| Booleans | `isLoading`, `hasChanges`, `shouldRetry` |
| Exports | no default exports except where a framework requires |
| Module layout | `modules/<name>/{routes,service,schema}.ts`, plus `modules/<name>/repositories/<noun>-repository.ts`, each exporting an `I<Noun>Repository` interface and a `create<Noun>Repository(…)` factory that returns it (ADR 0020) |

## Packages, services, environment

| Rule | Example |
|---|---|
| Workspace packages | `@telflo/contracts`, `@telflo/db`, `@telflo/api`, `@telflo/web`, `@telflo/cli` (`telflo-core/apps/cli`, whose bin is `telflo`; the root package is already named `telflo`, so the CLI's is renamed `telflo` only when it is published, D27) |
| Compose services | `api`, `web`, `db`, `mailpit` |
| Application env vars | `TELFLO_` prefix — `TELFLO_DATABASE_URL` |
| Standard env vars | left alone — `OTEL_EXPORTER_OTLP_ENDPOINT` |

## Tests

| Rule | Example |
|---|---|
| Unit tests | colocated, `configuration-service.test.ts` |
| Integration tests | `*.integration.test.ts` |
| Test names | describe behavior — `it("rejects a name longer than 200 characters")` |
