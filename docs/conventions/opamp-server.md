# The opamp-server, from its own repository

This guide takes a change merged in the opamp-server's repository into the
platform: pulling that version into the development stack, checking that
everything works with it, and releasing it.

Every command below runs from the platform's root (this repository's top
folder) unless a step says otherwise, and each block is one command. The
examples release `0.2.0`; use the version you are releasing.

## Where the server lives

- **Its repository:** `github.com/telflo/opamp-server` (public,
  Apache-2.0). Its `README.md` says what the server does and how to run
  and install it, and `CONTRIBUTING.md` has the rules for changing it and
  its gates (`make check`).
- **Its releases:** an annotated tag `v<version>` in that repository, the
  image `ghcr.io/telflo/opamp-server:<version>` (linux/amd64 and
  linux/arm64), the chart `oci://ghcr.io/telflo/charts/opamp-server` at
  the same version and the binaries with their GitHub Release, all public.
  Its release workflow publishes them from the tag (its `CONTRIBUTING.md`,
  "Releasing"); pushing the tag is a maintainer's. There is no `latest`, and
  a published version is never pushed again: a fix is a new version.
- **What the platform runs:** `docker-compose.yml`'s `opamp-migrate` and
  `opamp-server` both run `ghcr.io/telflo/opamp-server:<version>@<digest>`,
  the release `vendor/opamp-server/PIN` names, and build nothing. Docker
  resolves the reference by its digest, so only the drift check reads the
  tag. `opamp-bootstrap` (`postgres:18`, as psql) runs
  `vendor/opamp-server/bootstrap.sql`. The image is public, so pulling it
  needs no login. The Compose install, `deploy/compose/compose.yaml`
  (`docs/compose.md`), runs the same two services on the same reference,
  and its `db-bootstrap` runs its own copy of the bootstrap,
  `deploy/compose/opamp-server/bootstrap.sql`, byte for byte the vendored
  one.
- **`vendor/opamp-server/`** holds the three files of the release the
  platform reads, byte for byte, and the PIN:

  | File | The release's path | Read by |
  |---|---|---|
  | `openapi.yaml` | `api/openapi.yaml` | the API's OpenAPI-checked fakes and its client's contract tests, and the browser tests' fake |
  | `bootstrap.sql` | `deploy/bootstrap.sql` | compose's `opamp-bootstrap` (the roles and the database) |
  | `org-token-corpus.json` | `handlers/testdata/org-token-corpus.json` | the fill-in's ports' tests: the API's, the web's and the validator's `test_org_variables.py` |
  | `PIN` | | the drift check, `scripts/publish-chart.sh --chart telflo` |

  `PIN` is exactly four lines, read with `sed` and never sourced. 0.2.4's,
  for example:

  ```
  version=0.2.4
  commit=9f850c1949efc9b94fa64e189fc33941105e5d8e
  digest=sha256:fc59e5c918f6d698722a5dc79c8e7d5901cf2c870b3a5b3d7ab5e84e40843bb5
  chart-tree=3e752202c616ad7cbf7d5f2af8fd2aee6c3307f3
  ```

  The version is read from the PIN wherever a test or script needs it (the
  PIN check's self-test, the chart's render tests, the kind smoke), so
  a pin change edits no version text there.

  The commit is the one the tag `v<version>` names, and the digest is the
  published image's index digest (both platforms). The chart-tree is the
  git tree id of that commit's `charts/opamp-server` (`git rev-parse
  v<version>:charts/opamp-server`), the vendored chart's (below).
  `.gitattributes` keeps the three copied files out of diffs and
  line-ending conversion; the PIN shows in diffs, so a release's pin
  change is readable in its PR.
- **The vendored chart.** The
  platform's chart, `charts/telflo`, depends on the opamp-server
  chart, and holds that release's `charts/opamp-server` unpacked under
  `charts/telflo/charts/opamp-server`, byte for byte. Its
  `Chart.yaml` declares the dependency at `oci://ghcr.io/telflo/charts`,
  at the PIN's version, but nothing pulls it: Helm renders, lints and
  packages the vendored tree offline. There is no `Chart.lock`; never run
  `helm dependency update` or `build` there. The vendored chart is never
  edited: a change to it is a new opamp-server release.
- **The sibling checkout.** The drift check and the dev override read a
  clone of the server's repository beside the platform, `../opamp-server`,
  or wherever `OPAMP_SERVER_SRC` names (a relative path is resolved against
  the platform's root, not your current folder). Clone it once (the
  repository is public):

  ```sh
  git clone https://github.com/telflo/opamp-server.git ../opamp-server
  ```

- **The drift check, `scripts/check-opamp-server-pin.sh`** (a local gate,
  `docs/conventions/testing.md`), needs no network, registry or login,
  and no running Docker (without one it only skips the revision line
  below), but it does need the docker CLI with its compose plugin, and
  python3: without either it fails closed. It checks that:
  - the sibling is the top of a git checkout (it fails closed, naming the
    clone to make, when there is none);
  - its tag `v<version>`, under `refs/tags/` (a branch of that name doesn't
    count), is the PIN's commit;
  - each vendored file equals that commit's file (`git cat-file blob`);
  - `docker-compose.yml`'s two services each have one `image:`, equal to
    `ghcr.io/telflo/opamp-server:<version>@<digest>`, and no `build:` and
    no YAML merge key (`<<:`), and nothing else in it names the image
    outside comments, read as text;
  - the same as Compose itself reads the file (merge keys, anchors and
    all): `docker compose config --format json`, parsed with python3, must
    give the two services the pinned image and no build, and
    `opamp-bootstrap` must mount `vendor/opamp-server/bootstrap.sql`
    at `/opamp/bootstrap.sql` and run it with exactly `docker-compose.yml`'s
    committed command (`psql … -f /opamp/bootstrap.sql`) and no entrypoint.
    It runs on the client side only, through an empty temporary
    `DOCKER_CONFIG` and no `.env`, so it reaches no daemon,
    registry or credential helper (on this Mac it passes with `DOCKER_HOST`
    pointing where no daemon answers);
  - and that again through Compose's own file discovery in the root (no
    `-f`, `COMPOSE_FILE` unset): what a plain `docker compose` there reads,
    an override file included;
  - the Compose install: `deploy/compose/compose.yaml`'s
    `opamp-migrate` and `opamp-server` run the pinned image
    and build nothing, as text and as Compose reads the file (with
    `--project-directory deploy/compose` and a placeholder env file made at
    run time, never its `.env`); its `db-bootstrap` mounts
    `deploy/compose/opamp-server/bootstrap.sql` at `/opamp/bootstrap.sql`
    and runs exactly its own committed command, with no entrypoint; and
    that copy is the tag's `deploy/bootstrap.sql`, byte for byte
    (`scripts/release/check-compose-install.sh` holds it equal to the
    vendored one too);
  - the root's compose files are an allowlist, matched without regard to
    case: `docker-compose.yml` and `docker-compose.opamp-server-dev.yml`,
    and no other `compose.y*ml`, `docker-compose.y*ml` or
    `*compose.override.y*ml`. So a personal `docker-compose.override.yml`
    at the root fails the check;
  - when the pinned image is in the local Docker store (`docker image
    inspect`, never a pull), its `org.opencontainers.image.revision` label
    must be the PIN's commit, which ties the digest to the release. When it
    isn't there, or Docker can't be asked, one line says its revision
    wasn't checked, which isn't a failure: a release PR pulls the image
    first;
  - the vendored chart is the release's: the tag's `charts/opamp-server`
    is the PIN's chart-tree, and so are HEAD's tree at
    `charts/telflo/charts/opamp-server` and the working tree's
    files there (tracked and untracked, hashed as git would, nothing
    written). A changed, added or removed file fails it;
  - no file git ignores sits in the vendored chart but `.DS_Store`: Helm
    would package or render it, and the tree ids can't see it. Remove one
    the check names;
  - one version: the dependency `charts/telflo/Chart.yaml`
    declares (exactly one `opamp-server`, at `oci://ghcr.io/telflo/charts`),
    the vendored `Chart.yaml`'s and the PIN's. Helm passes a mismatch
    silently.

  `scripts/publish-chart.sh --chart telflo` checks the chart-tree
  again on the chart it extracts from HEAD, with no sibling checkout, before
  it lints or packages anything.

  The boundary: the check reads the repository's committed files, and any
  file at the root a plain `docker compose` would read. Your own local
  configuration is out of scope by design: it never reads a gitignored
  `.env` (Compose runs with `--env-file /dev/null`), and it runs with
  `COMPOSE_FILE` unset, so exported `COMPOSE_*` settings are yours.

  The digest is checked as text, and pulling the image proves it real
  (below).
  Its test, `scripts/check-opamp-server-pin.test.sh`, builds its own
  throwaway sibling and breaks each half. Run the check:

  ```sh
  scripts/check-opamp-server-pin.sh
  ```

  When everything matches it prints an OK line naming the pinned release;
  for 0.3.0, `check-opamp-server-pin: OK: v0.3.0 (…)`. `--refresh` and
  `--restore`, its two other modes, are below.
- **The dev override, `docker-compose.opamp-server-dev.yml`,** builds the
  two services from the sibling (`build: ${OPAMP_SERVER_SRC:-../opamp-server}`,
  tagged `telflo-opamp-server:from-sibling`) and mounts the sibling's
  `deploy/bootstrap.sql` into the bootstrap. Their names, ports, secrets and
  health check stay `docker-compose.yml`'s. It's for a server change that
  isn't released yet.

## Taking a merged server change through local testing

A contributor's PR to the opamp-server has been reviewed and merged into its
`main`. Before it is released and the hosted solution moves to it, run the
platform on it.

1. **Bring the sibling up to date**, with `main` checked out there:

   ```sh
   git -C ../opamp-server pull --ff-only
   ```

   ```sh
   git -C ../opamp-server fetch --tags
   ```

2. **Build the server from the sibling**, the one service (the migrations
   use the same `telflo-opamp-server:from-sibling` image). Build before
   every `up` with the override: `up` runs whatever that tag already holds
   and builds only when it's missing, so without a build it can run an old
   one:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.opamp-server-dev.yml build opamp-server
   ```

   Don't use `up -d --build`: it would rebuild the collector validator and
   tester too, which download collectors. Then start the stack with the
   override:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.opamp-server-dev.yml up -d
   ```

   With the API and web running natively (`npm run dev:services`), start
   just the server instead, which runs its bootstrap and migrations first:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.opamp-server-dev.yml up -d opamp-server
   ```

   Running `npm run dev:services` again afterwards puts you back on the
   release without a word: it reads only `docker-compose.yml`, so it
   recreates the two opamp containers on the pinned image (and after a new
   migration, the pinned `serve` refuses the database). Use the command
   above again instead while testing the build.

   The migrations run on the stack's `telflo_opamp_server` database, so a change
   that adds one moves the database ahead of the pinned release (see
   [Going back](#going-back-to-the-pinned-release)).

3. **Copy the contract files from the sibling**, so the platform's tests
   check it against the server's new `openapi.yaml`, `bootstrap.sql` and
   corpus:

   ```sh
   scripts/check-opamp-server-pin.sh --refresh
   ```

   It copies the three files from the sibling's working tree into
   `vendor/opamp-server/`, then says whether the PIN still matches. When
   the change touched any of them, it says the PIN no longer matches:
   the drift check now fails, as it should, until a release holding them is
   pinned or `--restore` puts the pinned release's files back. Don't commit
   refreshed files.

4. **Run the platform's tests and the stack smoke.** The API's and the
   web's suites read the vendored files (`docs/conventions/testing.md`
   has their setup; [`docs/development.md`'s Testing](../development.md#testing)
   section too):

   ```sh
   npm --prefix telflo-core test
   ```

   The browser tests too: their fake opamp-server is the API's, checked
   against the vendored `openapi.yaml`:

   ```sh
   npm --prefix telflo-core run test:e2e
   ```

   The validator's `tests/test_org_variables.py` reads the corpus too
   (`services/otelcol-validator`, in its virtual environment, or its `test`
   image, which carries the corpus). Then the stack smoke, with the
   override in `COMPOSE_FILE`, so the second replica it starts
   (`docker compose run`) runs the build too, not the pinned image, and
   with `TELFLO_SMOKE_SITE=saas` and the SaaS's site values exported in the
   shell that started the stack
   ([`docs/development.md`](../development.md#the-whole-stack-in-containers);
   the smoke has no default site):

   ```sh
   COMPOSE_FILE=docker-compose.yml:docker-compose.opamp-server-dev.yml TELFLO_SMOKE_SITE=saas ./scripts/smoke-test-stack.sh
   ```

   Fix what breaks: in the server through another PR there (then repeat
   from step 1), or in the platform on a branch here (see [Changing both
   at once](#changing-both-at-once)).

## Releasing it

When the change works with the platform, it is released, and then the
platform is pinned to the release.

**The server's release** follows the opamp-server repository's
`CONTRIBUTING.md`, its "Releasing" section, the one place its steps are
kept: the release commit (`charts/opamp-server/Chart.yaml`'s `version` and
`appVersion`) through a pull request on that repository, with `make check`
and `make smoke` before it; the annotated tag `v<version>`, whose message
is `opamp-server <version>`, whose push starts the release workflow (every
gate on the tag's commit, then the image, the chart and the binaries with
their GitHub Release). Pushing the tag is a maintainer's.

**The platform's side**, with the sibling's `main` and tags pulled (step 1
of the local testing above):

1. **The release's index digest.** The PIN takes the image's **index**
   digest, the manifest list of both platforms: the publish's last line,
   `publish-image: pushed ghcr.io/telflo/opamp-server:0.2.0, index digest
   sha256:…`, or the top `Digest:` line of `docker buildx imagetools
   inspect` (the image is public: no login):

   ```sh
   docker buildx imagetools inspect ghcr.io/telflo/opamp-server:0.2.0
   ```

   Never another digest from the push's output: buildx prints several
   `sha256:` values (the layers, each platform's manifest, the index), and
   a platform manifest's digest in the PIN would pass every later check
   while pinning one platform only.

2. **The released image pulled by that digest** (no login: the image is
   public), which proves the digest real:

   ```sh
   docker pull ghcr.io/telflo/opamp-server:0.2.0@sha256:<the index digest>
   ```

   Its `revision` label must be the tag's commit:

   ```sh
   docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/telflo/opamp-server@sha256:<the index digest>
   ```

   The tag's commit:

   ```sh
   git -C ../opamp-server rev-parse 'v0.2.0^{commit}'
   ```

3. **The platform's PR**, on a branch of the platform:
   - `vendor/opamp-server/PIN`'s four lines: `version=0.2.0`, `commit=`
     the tag's commit, `digest=` the index digest, and `chart-tree=` the
     tag's chart's tree id:

     ```sh
     git -C ../opamp-server rev-parse 'v0.2.0:charts/opamp-server'
     ```

   - both of `docker-compose.yml`'s image lines (`opamp-migrate`'s
     and `opamp-server`'s):
     `image: ghcr.io/telflo/opamp-server:0.2.0@sha256:…`, the same digest;
   - the same two lines in the Compose install,
     `deploy/compose/compose.yaml`, and its copy of the bootstrap,
     `deploy/compose/opamp-server/bootstrap.sql`, copied from
     `vendor/opamp-server/bootstrap.sql` once `--restore` (below) has
     written the release's (the drift check and
     `scripts/release/check-compose-install.sh` both refuse a copy that
     differs);
   - the vendored chart, re-vendored from the tag. Remove the old tree
     first, so a file the release dropped goes too:

     ```sh
     git rm -r -q charts/telflo/charts/opamp-server
     ```

     ```sh
     mkdir -p charts/telflo/charts/opamp-server
     ```

     (`-p`: the vendored chart is the only one under `charts/`, so
     `git rm` removes that folder too.)

     ```sh
     git -C ../opamp-server archive 'v0.2.0:charts/opamp-server' | tar -x -C charts/telflo/charts/opamp-server
     ```

     ```sh
     git add charts/telflo/charts/opamp-server
     ```

   - the other lines that name the release: `charts/telflo/Chart.yaml`'s
     `opamp-server` dependency `version: 0.2.0`; and `values.yaml`'s
     `opamp-server.image.digest`, the PIN's digest. The render tests'
     expected image (`charts/telflo/tests/render-tests.sh`,
     `opamp_digest`), the kind smoke's `OPAMP_IMAGE`
     (`scripts/smoke-kind.sh`) and the PIN check's self-test read the
     version and digest from the PIN, so they need no edit. A changed
     platform chart ships in its next version;
   - the vendored files from the new tag, which `--restore` writes from the
     PIN's commit and then checks:

     ```sh
     scripts/check-opamp-server-pin.sh --restore
     ```

     It must end `check-opamp-server-pin: OK: v0.2.0 (…)`. Then the drift
     check alone, green; with the image now local, it also says the
     image's revision label is the PIN's:

     ```sh
     scripts/check-opamp-server-pin.sh
     ```

   - the platform on the pinned release: the stack without the override,
     then the tests (as in step 4 of the local testing above) and the stack
     smoke, without `COMPOSE_FILE`:

     ```sh
     docker compose -f docker-compose.yml up -d
     ```

     ```sh
     TELFLO_SMOKE_SITE=saas ./scripts/smoke-test-stack.sh
     ```

     (with the SaaS's site values exported, as above; the full suite runs
     it on throwaway stacks in both modes, `docs/conventions/testing.md`,
     "The three smokes");

   - the platform chart on the release: its render tests, then the
     kind smoke, which installs the vendored chart with the pinned
     image (`docs/conventions/testing.md`, "The three smokes"):

     ```sh
     bash charts/telflo/tests/render-tests.sh
     ```

     ```sh
     scripts/smoke-kind.sh
     ```

   The PR's diff shows the PIN's and both compose files' lines and the
   vendored chart's files (the three contract files are marked `-diff`).
   The local gates run before it, and its `ci` check
   (`.github/workflows/ci.yml`) passes, as for every PR; a maintainer
   merges it. A pin change ships to users in the platform's
   next release.

## Changing both at once

When a platform change needs a server change that isn't released yet, make
each on a branch of its own repository and run them together: the override
and `--refresh` (steps 2 and 3 of the local testing above), with the
sibling on the server's branch. The platform's branch can't merge while its
vendored files are refreshed (the drift check fails), so the order is: the
server's PR merged, the release, then the platform's PR carrying the pin
bump and its own change.

### Going back to the pinned release

1. **If the server change added a migration**, roll it back first, with the
   build, once for each migration it added: the pinned release's `serve`
   refuses a schema newer than its build. `down --yes-drop-data` drops the
   newest migration's tables and every row in them, so only on the
   development database:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.opamp-server-dev.yml run --rm --no-deps opamp-migrate migrate down --yes-drop-data
   ```

2. **The pinned release's contract files back:**

   ```sh
   scripts/check-opamp-server-pin.sh --restore
   ```

3. **The pinned image back**, without the override, which recreates the
   bootstrap, the migrations and the server on the vendored
   `bootstrap.sql` and the pinned image:

   ```sh
   docker compose -f docker-compose.yml up -d
   ```

   With the API and web running natively, their services instead:

   ```sh
   npm --prefix telflo-core run dev:services
   ```

4. **Optionally, remove the build:**

   ```sh
   docker image rm telflo-opamp-server:from-sibling
   ```

## No GHCR login

The opamp-server's image is public, so `docker compose up` (or
`npm run dev:services`) pulls it with no login. The agents' runs pull
nothing.
