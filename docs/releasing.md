# Releasing Telflo

How a release of Telflo is made: for whoever prepares a release's pull
request, and for the maintainer who tags it. What each workflow guards is
`docs/conventions/security.md`, "The release pipeline"; what it tests is
`docs/conventions/testing.md`, "The release workflow's tests".

**On this page:** [What a release is](#what-a-release-is) ·
[Once, before the first release](#once-before-the-first-release) ·
[The collector workflow](#the-collector-workflow) ·
[Rehearse a release on your machine](#rehearse-a-release-on-your-machine) ·
[Cutting a release](#cutting-a-release) ·
[Installing a staged release](#installing-a-staged-release) ·
[When a run fails](#when-a-run-fails) ·
[Patch releases](#patch-releases) ·
[What GHCR shows](#what-ghcr-shows)

## What a release is

A release is one version, `MAJOR.MINOR.PATCH` (digits only, no leading
zeros, nothing after: `0.1.0`, `0.1.12`, `1.0.0`), tagged `v<version>` on a
commit of `main`. It is made in two steps: the tag's run builds and tests
the bytes, then stages them (a second registry namespace and a draft
GitHub Release); the end-to-end tests install that stage; and the finalize
workflow then copies the same bytes, by digest, to the public namespace
and publishes the Release. There are no release-candidate tags: the stage
is the version itself, so what users install is byte for byte what the
end-to-end tests installed, and a version is spent only once it is public.

The version is written in these places, all equal, and
`scripts/release/check-version.sh` (a static gate) holds them so:
- `charts/telflo/Chart.yaml`: `version` and `appVersion`;
- `deploy/compose/compose.yaml`: every Telflo image's tag
  (`"${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/<name>:<version>"`:
  the public registry unless the install's `TELFLO_IMAGE_REGISTRY` names
  another);
- `README.md`'s Quick start: the release's download address
  (`releases/download/v<version>`) and the archive's name
  (`telflo-compose-<version>`);
- `docs/kubernetes.md`: the chart's `--version <version>` and the
  download address.

A `v*` tag starts `.github/workflows/release.yml`. It checks the tag, runs
the static gates, builds the five platform images (`api`, `web`,
`otelcol-validator`, `otelcol-testing`, `ottl-evaluator`) once for
`linux/amd64` and `linux/arm64` with their SBOM and provenance, packages
the chart and the Compose archive, runs the three smokes on those amd64
images (each one's output through `scripts/gates/redact.sh`), and only
then stages, in the namespace `ghcr.io/telflo/telflo-staging`:
- the images, `ghcr.io/telflo/telflo-staging/<name>:<version>`, the same
  bytes the smokes ran (every digest kept);
- the chart, `oci://ghcr.io/telflo/telflo-staging/charts/telflo`, at
  `<version>`;
- a **draft** GitHub Release `v<version>` holding
  `telflo-compose-<version>.tar.gz`, `create-secrets.sh`, `SHA256SUMS` and
  `digests.txt`, with notes naming each image's public reference and
  digest, the chart and the collector versions it was checked against.

It pulls each one back by digest from the stage before it makes the draft.
`digests.txt` is the stage's record: one `<name> sha256:<hex>` line for
each image's index digest, then the chart's OCI digest (`charts/telflo`)
and its package's sha256 (`charts/telflo.tgz`).

Then, once the end-to-end tests have passed on the stage,
`.github/workflows/finalize.yml`, started by hand, copies exactly those
digests to the public namespace (`scripts/release/promote.sh`: by digest,
so the attestations come along, each copy checked by digest), pulls the
public tags back against `digests.txt`, and publishes the draft:
- the images, `ghcr.io/telflo/telflo/<name>:<version>`;
- the chart, `oci://ghcr.io/telflo/telflo/charts/telflo`, at `<version>`;
- the GitHub Release `v<version>`, a normal release (never marked
  pre-release), latest unless a higher version's Release is.

It never builds, packages or re-tags anything. The collector images and
the supervisor-collector chart are not part of a release: the collector
workflow publishes them (below) to the public namespace only, and the
release only checks they exist.

## Once, before the first release

The repository's settings, made once by a repository admin, in this
order. Each `gh api` line runs with that admin's own GitHub CLI login.

1. **A tag ruleset:** only repository admins may create, move or delete
   `v*` tags (Settings › Rules › Rulesets › New tag ruleset: target
   `v*`; restrict creations, updates and deletions; the bypass list
   Repository admin). The workflow refuses a tag whose commit isn't on
   `main` in any case. Or from the command line (`actor_id` 5 is the
   Repository admin role):

   ```sh
   gh api -X POST repos/telflo/telflo/rulesets --input - <<'EOF'
   {"name":"release tags","target":"tag","enforcement":"active",
    "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
    "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"}],
    "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
   EOF
   ```

   Check: the ruleset is listed, `tag` and `active`:

   ```sh
   gh api repos/telflo/telflo/rulesets --jq '.[] | [.name, .target, .enforcement] | @tsv'
   ```

2. **The `release` environment** (Settings › Environments): its
   deployment branches and tags limited to the tag pattern `v*` (the
   release workflow's) and the branch `main` (the collector workflow's,
   which is dispatched from `main`), and a maintainer as its required
   reviewer: every publish waits for that reviewer's **Approve**. Create
   it before the first collector run: a workflow naming a missing environment creates
   it with no deployment limits. Or from the command line, the
   environment with custom deployment policies:

   ```sh
   gh api -X PUT repos/telflo/telflo/environments/release --input - <<'EOF'
   {"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   EOF
   ```

   then its two policies, the tag pattern:

   ```sh
   gh api -X POST repos/telflo/telflo/environments/release/deployment-branch-policies -f name='v*' -f type=tag
   ```

   and the branch:

   ```sh
   gh api -X POST repos/telflo/telflo/environments/release/deployment-branch-policies -f name=main -f type=branch
   ```

   Check: `v*` as `tag` and `main` as `branch`:

   ```sh
   gh api repos/telflo/telflo/environments/release/deployment-branch-policies --jq '.branch_policies[] | [.name, .type] | @tsv'
   ```

   The finalize workflow is started from `main`, so the `main` policy
   admits it too, and the same reviewer approves it.
3. **Packages:** new packages under `ghcr.io/telflo/telflo/` and
   `ghcr.io/telflo/telflo-staging/` are created by the workflow's own token
   and linked to this repository; no access grant is needed.
   - The public ones (`telflo/<name>`, `telflo/charts/<name>`, the
     collector's): each is public (Package settings › Change visibility),
     so an install needs no registry login. The release's images and chart
     appear there with the first finalize.
   - The stage's (`telflo-staging/<name>` for the five images,
     `telflo-staging/charts/telflo`): the first staged release's run
     creates them. Their visibility is the owner's choice. Private keeps
     unfinished versions out of view: the end-to-end tests then sign in
     with a read-only token (a classic token with `read:packages` only, or
     a GitHub App's), as [Installing a staged
     release](#installing-a-staged-release) says. Public is simpler, but
     anyone can pull a version that may never ship. The workflows read and
     write them with their own token either way.
   - Abandoning a stage deletes package versions with the admin's own
     GitHub CLI login, which needs the packages scopes once:

     ```sh
     gh auth refresh -h github.com -s read:packages,delete:packages
     ```
4. **Turn GitHub Actions on**, in this order, so the first run already
   has its allow-list. All four workflows stay enabled: `ci.yml` runs on
   every pull request and every push to `main`, `release.yml` on a `v*`
   tag, `finalize.yml` and `collector.yml` when started by hand.
   1. Turn Actions on, for the selected actions only, each pinned by its
      full commit SHA:

      ```sh
      gh api -X PUT repos/telflo/telflo/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
      ```

   2. The allow-list: exactly the actions the four workflows name, each as
      `owner/repo@<sha>`. This lists them:

      ```sh
      grep -ho 'uses: *[^ ]*' .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/finalize.yml .github/workflows/collector.yml | sed 's/uses: *//' | sort -u
      ```

      Then set them, with neither GitHub's own nor verified creators'
      actions allowed beyond it. The command repeats `-f
      'patterns_allowed[]=…'` once for each line of that list; for the
      workflows as they are (nine actions), it is:

      ```sh
      gh api -X PUT repos/telflo/telflo/actions/permissions/selected-actions \
        -F github_owned_allowed=false -F verified_allowed=false \
        -f 'patterns_allowed[]=actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
        -f 'patterns_allowed[]=actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333' \
        -f 'patterns_allowed[]=actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e' \
        -f 'patterns_allowed[]=actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1' \
        -f 'patterns_allowed[]=actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0' \
        -f 'patterns_allowed[]=actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9' \
        -f 'patterns_allowed[]=azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310' \
        -f 'patterns_allowed[]=docker/login-action@81c6f93d4bc991e510b342a00b419b3bb4efc5c6' \
        -f 'patterns_allowed[]=docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1'
      ```

      If the grep lists anything else, use its lines instead. Check:
      `github_owned_allowed` and `verified_allowed` false, and
      `patterns_allowed` exactly the grep's list:

      ```sh
      gh api repos/telflo/telflo/actions/permissions/selected-actions
      ```

   3. The default token read-only, and Actions never creating or approving
      pull requests:

      ```sh
      gh api -X PUT repos/telflo/telflo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
      ```

      Check: `read` and `false` (often GitHub's defaults already):

      ```sh
      gh api repos/telflo/telflo/actions/permissions/workflow
      ```

   4. Check: the four workflows `active`:

      ```sh
      gh api repos/telflo/telflo/actions/workflows --jq '.workflows[] | [.path, .state] | @tsv'
      ```

      A workflow showing `disabled_manually` is enabled with its file's
      name, for `ci.yml`:

      ```sh
      gh api -X PUT repos/telflo/telflo/actions/workflows/ci.yml/enable
      ```

   A workflow file changed later needs its allow-list changed with it
   when it names another action or SHA.
5. **The collector images first**: the collector workflow
   with `all` and `publish: true` (below), so `ghcr.io/telflo/telflo/
   collector` holds every version the catalog offers and the
   supervisor-collector chart 0.1.0 is published. The release's first job
   fails otherwise (`run the collector workflow for <version>`). After
   steps 1, 2 and 4 (the publish job runs in the `release` environment),
   start it:

   ```sh
   gh workflow run collector.yml -R telflo/telflo --ref main -f collector_version=all -f publish=true
   ```

   then follow it to its end:

   ```sh
   gh run watch -R telflo/telflo
   ```

   Check: the run passed, and the collector images and the chart are
   listed under the organization's Packages:

   ```sh
   gh run list -R telflo/telflo --workflow collector.yml -L 1
   ```

   A failed job: [When a run fails](#when-a-run-fails), or "Re-run failed
   jobs" on the run's page (nothing published is overwritten).
6. **Postgres's pin current:** 18.7 (`postgres:18.7`'s index digest,
   `sha256:9f4fd4aa…`). A re-pin, through a pull request: the then-current
   18.x tag's index digest
   (`crane digest docker.io/library/postgres:18.<n>`, with
   `scripts/release/tools.sh fetch crane`) in `charts/telflo/values.yaml`'s
   `postgres.image.digest` (and the comment above it), both `postgres`
   lines of `deploy/compose/compose.yaml`, `scripts/release/tools.lock`'s
   `postgres` row (its version too), both `postgres` services of
   `.github/workflows/ci.yml` (`check-workflows.sh` holds them to the
   lock's digest), `charts/telflo/tests/profiles/full.yaml`, the
   digest's prefix in `scripts/release/check-compose-install.test.sh`, the
   README's "tested with" row. Find the old digest's other copies with
   `git grep <old digest>`. The vendored opamp-server chart's own pin is
   never edited: its Postgres is off in this chart, and the pin changes
   with an opamp-server release. The render tests (against `tools.lock`)
   and `scripts/release/check-compose-install.sh` (the Compose file against
   the chart) hold the copies equal.

## The collector workflow

`.github/workflows/collector.yml` publishes the collector image,
`ghcr.io/telflo/telflo/collector:<collector version>`, for both processor
types with its attestations, and the supervisor-collector chart,
`oci://ghcr.io/telflo/telflo/charts/supervisor-collector`, when its
`Chart.yaml` version isn't published yet (a published chart version is
never pushed again). It is started by hand, from `main`, with two inputs:
- `collector_version`: a version the catalog
  (`catalog/distributions/otelcol-contrib.json`) offers and hasn't
  deprecated, or `all` for every offered version, one job each;
- `publish`: `false` by default (build and test only); `true` publishes,
  after the tests pass, in the `release` environment.

With `publish: true`, a version already on GHCR is never pushed again: an
explicit `collector_version` that is published already is refused before
anything builds; `all` builds, tests and publishes only the offered
versions not yet published, naming the others in the check job's log; and
when every offered version is published, the check job says so in a notice
and the run has no image to build or publish: the build, test and publish
jobs are skipped, and the supervisor-collector chart's job still runs, so a
chart version bump alone is published by `all` with `publish: true` (the
chart job runs after a publish that passed, or one skipped because there
was nothing to build, never after a failed or canceled test or publish).
With `publish: false`, `all` builds and tests every offered version.

```sh
gh workflow run collector.yml -R telflo/telflo --ref main -f collector_version=all -f publish=true
```

Then follow it:

```sh
gh run watch -R telflo/telflo
```

Run it, on a maintainer's yes each time (a run with `publish: false` still
spends minutes):
- before the first release, with `all` (above);
- when the catalog offers a new collector version, before any group's
  published version uses it (and before the next release, which checks
  every offered version);
- when `charts/supervisor-collector/Chart.yaml`'s version is bumped (with
  the contracts' `DEFAULT_HELM_CHART_VERSION`).

A run that stopped part way is resumed with "Re-run failed jobs" (the
check job, which passed, isn't run again): the push skips a tag already
holding its archive's digest, and with another digest the run fails and
nothing is overwritten. It makes no GitHub Release. The image's build is `scripts/build-collector-image.sh
<version> --build-oci`, its publish `--push-oci`, the chart's
`scripts/publish-chart.sh --package` and `--push-package`: the same
scripts run on a laptop against a throwaway registry.

## Rehearse a release on your machine

`scripts/release/rehearse.sh` runs the release's own scripts, in the
release workflow's order, on this machine, with a throwaway registry on
127.0.0.1 standing in for GHCR. It is the release's end-to-end test: run it
before a release's pull request merges (step 1 of "Cutting a release"), and
again whenever the pipeline, a Dockerfile, the chart or the Compose install
changes. Nothing it does reaches GitHub or GHCR. Its header
(`scripts/release/rehearse.sh`) holds every rule below.

**What it proves**, on the commit checked out:
- the tag's check (`verify-tag.sh`) passes for `v<version>`, in a throwaway
  clone whose `main` is that commit, with a local annotated tag;
- every collector version the catalog offers builds for amd64 and arm64
  with its attestations, runs, is pushed and pulled back by digest; the
  supervisor-collector chart is published; the release's collector checks
  find them all;
- the static gates (`scripts/gates/static.sh`) pass;
- the five platform images build for both processor types with their
  attestations; the chart and the Compose archive are packaged;
- the three smokes pass on those exact bytes: the stack smoke in
  open-source mode, the README's Quick start from the archive, the
  packaged chart in kind, each called as the workflow calls it
  (`scripts/release/steps.sh stack-smoke`, `archive-smoke`, `kind-smoke`:
  its output through `scripts/gates/redact.sh`). They run the images for the machine's own
  platform (`load-images.sh`'s default: `linux/arm64` on an
  Apple-silicon Mac, natively), where the workflow runs the `linux/amd64`
  ones on its runner: between them, both platforms are smoked (Ruling
  400);
- the stage copies the same bytes to the local registry's
  `telflo/telflo-staging`, each is pulled back by digest, and `digests.txt`
  and the release notes are written;
- the finalize: `promote.sh` copies the stage, by those digests, to the
  local registry's `telflo/telflo`, and the pull-back checks every public
  tag against `digests.txt`.

It doesn't prove GitHub's side: the runners, the actions and their pins,
the token's permissions, the `release` environment, GHCR, the draft
GitHub Release and its publishing (`steps.sh github-release --draft`,
`finalize-check` and `finalize-publish`, which their self-tests run
against a stand-in `gh`). `scripts/release/check-workflows.sh` holds the
workflow files to their rules; the first tag's run and the first finalize
show the rest.

**Before you start:**
- Docker Desktop running (or another Docker engine), and on the `PATH`:
  git, jq, python3, curl, node and npm, helm (4.2.1, the workflow's) and
  kubectl. The rehearsal fetches its own kind, crane and buildx (below);
  it installs nothing else.
- `npm ci` in `telflo-core`, once per checkout (the static gates and the
  smokes' CLI need it; the rehearsal never runs it).
- A clean checkout of the commit to rehearse: no change and no untracked
  file. `--version` is `charts/telflo/Chart.yaml`'s version.
- AC power. On battery it refuses unless you add `--allow-battery`. It
  keeps the Mac awake itself (it runs under `caffeinate -is`); keep the
  lid open.
- Disk: 25 GB free for Docker (about 20 GB is used: the images, the
  builder's cache and a kind node), and 10 GB where the work folder is
  (the archives take about 4 GB).
- Time: about 1.5 to 2.5 hours on an Apple-silicon laptop, most of it the
  builds (the amd64 half is emulated).
- Nothing named `telflo-rehearse-*` left from an earlier run (the cleanup
  command below removes it), and the rehearsal's ports free on 127.0.0.1:
  34601–34611, 34700–34702, 34710–34712 and 34720 (`--port-base <n>`
  moves them all).

**The command**, from the checkout's root:

```sh
# Print the checks, the downloads and the steps; start nothing.
scripts/release/rehearse.sh --version 0.1.0 --work "$HOME/telflo-rehearsal-$(date +%Y%m%d-%H%M)" --dry-run
```

```sh
# The rehearsal. --work is a new folder outside the checkout; it holds
# everything the run makes, and its logs afterwards.
scripts/release/rehearse.sh --version 0.1.0 --work "$HOME/telflo-rehearsal-$(date +%Y%m%d-%H%M)"
```

**What it keeps.** At the end, whatever happened, it removes by name what
the run made: its marker and its registry, a smoke's leftovers (every
container, volume and network named `telflo-rehearse-*`), the
`telflo-release` builder if the run created it, the release-named images
it loaded into Docker (`ghcr.io/telflo/telflo/<name>:<version>` and the
collector's, when they weren't there before, each only while its image id
is still the one the run recorded when it loaded it), and everything in
the work folder but its logs. With `--keep` it removes only its marker and
lists what it kept: the registry, the work folder (the archives, the
clones), the images and the builder, for instance to try the README's
Quick start from its archive and images. Then remove them with:

```sh
# Removes what that run made (its rehearse.state names it), then the folder.
scripts/release/rehearse.sh --cleanup --work <the run's folder>
```

While a rehearsal is running (its marker volume `telflo-rehearse-run`
and its registry are labeled with its work folder and process), another
one refuses to start and `--cleanup` refuses to remove anything. Neither a
run's end nor `--cleanup` ever prunes, and neither removes anything but
the `telflo-rehearse-*` names, the `telflo-release` builder the run made
and the images its `rehearse.state` names; an object labeled for another
rehearsal that is running is left alone. The smokes' own objects carry no
label: they are removed by their `telflo-rehearse-*` names, which no other
run can hold while one runs. The private tools (`.tools/` and
`tools.lock`'s images) stay for the next run; `scripts/release/tools.sh
remove` deletes them and the builder.

**Reading the result.** The run ends with a table, kept as
`<work>/summary.txt`: each step (`prep-*`, then the release's steps) with
its exit code and seconds; the total time; how many secret-shaped lines
its output held (redact.sh's marker), which must be 0; the kube check
(context and kubeconfig unchanged); and what it removed or kept. The last
line is `PASS` (exit 0) or `FAIL` (exit 1: a step or a check failed; exit
2 means it refused before anything ran). A failing step is named with its
log, `FAIL at <step> (exit <n>): <work>/logs/<nn>-<step>.log`. Every
step's output, already redacted, is in `<work>/logs/`, and all of it in
`<work>/rehearse.log`; the static gates' own logs are in
`<work>/static/logs/`, with their table in `<work>/static/summary.txt`.

**What it downloads** (only what isn't on the machine already):
- kind, crane and buildx: release binaries pinned in
  `scripts/release/tools.lock`, each checked against its sha256 before it
  may run, into the git-ignored `.tools/`;
- `tools.lock`'s images, each by its digest: `registry:2`, BuildKit, its
  SBOM scanner, the kind node, Postgres and Mailpit;
- the opamp-server's source at `vendor/opamp-server/PIN`'s tag (a
  `git clone` of `github.com/telflo/opamp-server`, for the pin check);
- what the builds download, as on a runner: the Dockerfiles' base images
  by digest, npm, Go and Debian packages, and, for each collector version,
  the upstream otelcol-contrib and OpAMP supervisor releases (sha256-pinned
  in the catalog); inside the kind node, the chart's Postgres by digest.

It never pulls or re-tags an image the smokes run by tag (`postgres:18`,
`axllent/mailpit:v1.31`, `nginx:1.30-alpine` at the chart's digest,
`ghcr.io/telflo/opamp-server` at the PIN's): it stops before the first
step if one isn't there.

**What it never touches:**
- GitHub, GHCR or any registry but its own on 127.0.0.1: no login, no
  push elsewhere, no Release;
- your `~/.docker`: from its first Docker call (the checks before the
  work folder exists, and `--cleanup`'s) Docker uses a temporary
  configuration holding no login, then Docker and Helm use one in the work
  folder, also holding no login; a call to a credential helper fails the
  run;
- the Compose projects `telflo`, `telflo-dev` and `telflo-platform`, and
  the development stack's and dev servers' ports (50080, 51025, 51234,
  51235, 53000, 55432, 58025, 8080): its projects, clusters and containers
  are `telflo-rehearse-*`, a `COMPOSE_PROJECT_NAME` naming one of those
  three is refused, and so is a `--port-base` reaching one of those
  ports;
- your kube context and kubeconfig: the kind cluster's kubeconfig is in
  the work folder, and the run fails if the current context, or the
  kubeconfig file's sha256 or modification time, changed;
- `telflo-core/.env` and your shell's settings: every `TELFLO_*`,
  `OPAMP_*`, `AWS_*`, `COMPOSE_*`, `PG*` and `DATABASE_URL` variable is
  unset for the run, which sets its own;
- anything in Docker but its own names, the builder it made and the
  images it loaded: never a prune.

## Cutting a release

1. **The release pull request**, on a branch from `main`: the version in
   every place above (`scripts/release/check-version.sh` passes), and
   `CHANGELOG.md`'s "Unreleased" notes under the version, dated. Before it
   merges, the
   local full suite (`docs/conventions/testing.md`, "CI gates": the unit
   suites, coverage, the browser tests, the static gates, the three
   smokes) and the rehearsal ([Rehearse a release on your
   machine](#rehearse-a-release-on-your-machine): the release's scripts in
   the workflow's order against a throwaway local registry), with the
   results in the PR, and its `ci` check (`.github/workflows/ci.yml`)
   green. A maintainer merges it.
2. **The tag**, annotated, on `main` as merged:

   ```sh
   git switch main
   ```

   ```sh
   git pull --ff-only
   ```

   ```sh
   git tag -a v0.1.0 -m "telflo 0.1.0"
   ```

3. **The push** (a repository admin's: only admins may push a `v*` tag):

   ```sh
   git push origin v0.1.0
   ```

   Push **one release tag at a time**, and the next only once this run has
   ended. The workflow's runs share one concurrency group that never
   cancels a running one, but GitHub keeps only one *waiting* run per
   group: a newer tag's run cancels an older one still waiting, and that
   canceled run must be re-run by hand (Actions › the run › "Re-run all
   jobs").

4. **Follow the run** (`gh run watch -R telflo/telflo`). Its first job
   refuses, with nothing built, a tree in which gitleaks finds a secret
   `.gitleaksignore` doesn't list (`scripts/release/check-secrets.sh`), a
   lightweight tag (the hint: `git tag -a`), a tag that isn't `v` plus
   `Chart.yaml`'s version, a commit that isn't on `main`, a version of
   which any image or the chart is already public, and a version staged
   already and not abandoned (`scripts/release/verify-tag.sh`, which asks
   both namespaces); and it fails when a collector image or the
   supervisor-collector chart it needs is missing.
5. **Approve the stage.** Once every test job has passed, the publish job
   waits for the `release` environment's reviewer to **Approve** it
   (Actions › the run › Review deployments). It pushes to
   `ghcr.io/telflo/telflo-staging` only and makes the draft Release:
   nothing is public yet.
6. **The end-to-end tests against the stage**: install `0.1.0` from the
   stage with Helm and with Compose ([Installing a staged
   release](#installing-a-staged-release)) and run them. If they fail,
   nothing of the version is public: abandon the stage ([When a run
   fails](#when-a-run-fails)), fix it, and tag the same version again.
7. **Run Finalize** once they pass, from `main`, with the version:

   ```sh
   gh workflow run finalize.yml -R telflo/telflo --ref main -f version=0.1.0
   ```

   then follow it:

   ```sh
   gh run watch -R telflo/telflo
   ```

   Its job waits for the `release` environment's reviewer to **Approve**
   it. It refuses a version with no draft Release, a draft without
   `digests.txt`, a tag that isn't annotated or isn't on `main`, a staged
   image or chart that isn't the record's digest, and a public tag that
   holds another digest; then it copies the stage by digest, pulls the
   public tags back against `digests.txt`, and publishes the Release last.
8. **Check what was published:** the Release's files and notes,

   ```sh
   gh release view v0.1.0 -R telflo/telflo
   ```

   and, from a new folder, the README's Quick start from those files.

## Installing a staged release

What the end-to-end tests install: the version's own chart and archive,
the stage's bytes, with the registry an install-time setting. Nothing
staged names the stage: the chart's `image.registry` and the Compose
file's `TELFLO_IMAGE_REGISTRY` point it there for the test only.

If the stage's packages are private, sign in first with a read-only token
(`read:packages` only), the token on standard input: for Helm,

```sh
helm registry login ghcr.io --username <your GitHub user> --password-stdin
```

and the cluster pulls with an image pull secret named in
`global.imagePullSecrets` (and `opamp-server.imagePullSecrets`, the same
list); for Compose, on the machine that runs it,

```sh
docker login ghcr.io --username <your GitHub user> --password-stdin
```

**Helm:** the staged chart, its images from the stage, with the other
values of `docs/kubernetes.md`:

```sh
helm install telflo oci://ghcr.io/telflo/telflo-staging/charts/telflo --version 0.1.0 --set image.registry=ghcr.io/telflo/telflo-staging
```

**Compose:** the draft Release's archive (a draft's files are visible to
the repository's maintainers only), from a new folder:

```sh
gh release download v0.1.0 -R telflo/telflo --pattern 'telflo-compose-*' --pattern SHA256SUMS --pattern create-secrets.sh
```

Then the README's Quick start from those files, with this line in the
install's `.env` (or `TELFLO_IMAGE_REGISTRY` set in the environment that
runs `docker compose`) before its first `docker compose up`:

```sh
TELFLO_IMAGE_REGISTRY=ghcr.io/telflo/telflo-staging
```

Remove it once the tests are done: an upgrade copies `.env` forward, so an
install kept for later would go on pulling from the stage.

## When a run fails

- **Before anything was staged** (a test job, a build, or the publish
  job before its first push): fix it through a pull request and merge it;
  then a repository admin deletes the tag, on GitHub and locally, and tags the same
  version again on the new `main`:

  ```sh
  git push origin :refs/tags/v0.1.0
  ```

  ```sh
  git tag -d v0.1.0
  ```

  Then steps 2 and 3 of "Cutting a release" again. A tag may be made
  again only while nothing of its version is public or staged:
  `verify-tag.sh` refuses it otherwise. The new run builds new bytes (the
  builds aren't byte-reproducible), which is fine: none were published.
- **A failure that a re-run fixes** (a runner lost, a network error):
  GitHub's "Re-run failed jobs" reruns them on the same run's artifacts,
  so the bytes staged are still the bytes tested; the publish skips every
  tag already holding its archive's digest. The tag's check, which
  passed, isn't run again, so a re-run can finish a stage that stopped
  part way. A draft Release left by a failed upload is deleted first
  (`gh release delete v0.1.0 -R telflo/telflo`): the job never makes one
  twice. A finalize that stopped part way is run again the same way
  (step 7): the copy skips every public tag already holding its digest.
- **The stage failed its end-to-end tests** (or was staged by mistake):
  nothing of it is public, so the version isn't spent. A repository admin
  abandons the stage, on their own machine with their GitHub CLI login
  ([the packages scopes](#once-before-the-first-release)): the staged
  package versions tagged `0.1.0` and the draft Release are deleted, and
  it refuses, deleting nothing, when anything of the version is public.
  First the list of what it deletes:

  ```sh
  scripts/release/steps.sh abandon-stage --version 0.1.0 --dry-run
  ```

  then the deletion:

  ```sh
  scripts/release/steps.sh abandon-stage --version 0.1.0
  ```

  It never deletes the tag: delete it as above (on GitHub, then locally),
  fix the fault through a pull request, and tag the same version again on
  the new `main`.
- **After something was published** (a finalize copied anything to the
  public namespace): that version is spent. A fault in what was published
  is fixed in the next patch version (`0.1.1`), a new release through all
  the steps above ([Patch releases](#patch-releases), when `main` has
  moved on).

## Patch releases

A patch release (`0.2.1` after `0.2.0`) fixes a released line. When
`main` holds nothing unreleased, it is an ordinary release from `main`,
as above. When `main` already holds unreleased work that shouldn't ship
yet:

1. Branch `release-<major>.<minor>` (`release-0.2`) from the line's last
   tag, if the branch doesn't exist yet:

   ```sh
   git switch -c release-0.2 v0.2.0
   ```

2. Fix it there, through a pull request into that branch: the fix (a
   cherry-pick of `main`'s fix where there is one), the version in every
   place above, and `CHANGELOG.md`'s notes for it. The same fix also goes
   to `main`, so the next minor release keeps it.
3. Tag the release on that branch (`git tag -a v0.2.1 -m "telflo 0.2.1"`)
   and push the tag, as in "Cutting a release": it is staged, tested end
   to end and finalized the same way.
4. When a newer line has been released (a `0.3.x` beside the `0.2.1`),
   the finalize publishes the Release with `--latest=false`, so the
   releases page's "Latest" (and `releases/latest`) keeps naming the
   newest line: `steps.sh finalize-publish` passes `--latest=false`
   whenever the Release marked latest names a higher version, and
   `--latest=true` otherwise.

One thing in today's workflows stands in the way, so a patch release
from a release branch needs it changed first, through a pull request: the
tag's check (`scripts/release/verify-tag.sh`) and the finalize's
(`steps.sh finalize-check`) refuse a tag whose commit isn't on `main`.
Until then, a patch release is made from `main`.

## What GHCR shows

- Each image's package lists the version's tag and, beside it, tags named
  `sha256-<digest>`: crane's fallback for the OCI referrers API, pointing
  at the image's attestations. They are expected; leave them (and delete
  them with their image, if that version is ever deleted).
- There is no `latest` tag: an install always names its version.
- The public packages are public: pulling them needs no login.
- The stage's packages, `telflo-staging/<name>` and
  `telflo-staging/charts/telflo`, hold each version from its tag's run
  until it is abandoned; a finalized version stays there too (the public
  tags are copies of it), and may be deleted from the stage once its
  Release is published.
- The old public packages under `ghcr.io/telflo/platform/` (the collector
  images 0.159.0–0.162.0 and the supervisor-collector chart 0.1.0) are
  left as they are.
