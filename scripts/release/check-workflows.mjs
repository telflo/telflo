#!/usr/bin/env node
// check-workflows.mjs: the release workflows' static check (D36-2 decisions
// 77, 83-85, 87 and 103; Preflight rulings 7 (PR-9-PR-15); Rulings 391-392).
// It reads .github/workflows/release.yml and collector.yml with the `yaml`
// package telflo-core already holds, and their raw text, and holds every rule
// below; each failure is printed as `check-workflows: <file>: <rule>: <why>`.
//
//   node scripts/release/check-workflows.mjs [--dir <workflows folder>] [--root <repository>]
//
// The rules (their ids):
//   workflow-files       the folder holds exactly ci.yml, collector.yml and release.yml
//   yaml                 each file parses with no error, duplicate key, anchor or alias; every
//                        job and step is a block mapping (no flow-style `{ … }` step)
//   workflow-keys        the top level holds only name, on, permissions, concurrency and jobs
//   matrix               each job's strategy exactly its spec's (Ruling 402): release.yml's
//                        build `matrix: { image: [api, web, otelcol-validator, otelcol-testing,
//                        ottl-evaluator] }`; collector.yml's build, test and publish `matrix:
//                        { version: ${{ fromJSON(needs.check.outputs.versions) }} }`; no
//                        include or exclude; no other job a strategy
//   job-env              a job's own env: is exactly its spec's (Ruling 402): the publishing
//                        jobs `TELFLO_CRANE: ""`, every other job none (values reach a step
//                        through its own env:, where required-steps pins them)
//   job-keys             a job holds only needs, if, runs-on, timeout-minutes, permissions,
//                        outputs, strategy (matrix only), environment, env and steps: never
//                        container, services, defaults, uses, continue-on-error …
//   step-keys            a step holds only name, id, uses, with, env, run and working-directory
//   step-if              no step carries `if:` (none needs one: a step that may be skipped
//                        is a safety step that may not run)
//   needs                each job needs exactly its set (release: static, build and package
//                        version; stack-smoke version, build; archive-smoke and kind-smoke
//                        version, build, package; collector: build check, test check and
//                        build)
//   required-steps       each job holds its safety steps, in order, each the exact run: line
//                        (and env values) below: version verify-tag.sh, the collector checks
//                        and archive; static static.sh; build and package their scripts; the
//                        smokes load-images.sh then their steps.sh step (stack-smoke,
//                        archive-smoke, kind-smoke: the smoke's output through redact.sh,
//                        decision 84, Ruling 408); publish the push scripts,
//                        pull-back.sh, the collector check and steps.sh github-release last;
//                        collector.yml's check, build, test, publish and chart likewise
//   job-outputs          a job's outputs are exactly its spec's (release's version: tag,
//                        version and commit from steps.tag, the verify-tag.sh step, and
//                        collector_version from steps.collector; collector's check: versions
//                        and has from steps.versions), and a step's id only those, each on
//                        its own step
//   with-keys            each action's with: only the keys of its allow-list (never
//                        checkout's repository, path, submodules or token, nor
//                        download-artifact's run-id, repository or github-token …)
//   env-names            every env: (workflow, job, step) names only what the steps' scripts
//                        read: an allow-list (DOCKER_CONFIG, HELM_REGISTRY_CONFIG, TAG, EXPECT,
//                        COMMIT, VERSION, COLLECTOR_VERSION, IMAGE, PUBLISH, GH_TOKEN,
//                        GHCR_USER, GHCR_TOKEN, and a job's TELFLO_CRANE), which is the guard.
//                        The deny list (TELFLO_TOOLS_*, BASH_ENV, ENV, NODE_OPTIONS, LD_*,
//                        DYLD_*, PATH, GIT_*, npm_config_*, DOCKER_* but DOCKER_CONFIG, HELM_*
//                        but HELM_REGISTRY_CONFIG, proxies, HOME, TMPDIR …) refuses nothing the
//                        allow-list doesn't: it only words the message ("it changes what runs
//                        or where"), so a name added to the allow-list by mistake is still
//                        refused when the deny list names it (Ruling 402, nit 4)
//   env-values           DOCKER_CONFIG is always ${{ runner.temp }}/docker, HELM_REGISTRY_CONFIG
//                        ${{ runner.temp }}/helm/registry/config.json, GHCR_USER ${{ github.actor }}
//   load-platform        every load-images.sh call names --platform linux/amd64 (the runner's;
//                        Ruling 400)
//   smoke-direct         no run: names a smoke script (smoke-compose-install.sh, smoke-kind.sh,
//                        smoke-test-stack.sh): the smokes run only through steps.sh, their output
//                        through redact.sh, so an extra step beside the required one can't
//                        reach an unfiltered log (Ruling 409)
//   trigger              release.yml: only `push: tags: ["v*"]`; collector.yml: only
//                        workflow_dispatch
//   pull-request-target  no pull_request_target anywhere
//   dispatch-inputs      collector.yml's inputs: collector_version (string, required)
//                        and publish (boolean, default false), nothing else
//   permissions-top      the top-level permissions is {}
//   jobs                 exactly the expected jobs
//   job-permissions      each job's permissions exactly its allowlist (release: version
//                        contents+packages read, publish contents+packages write, the rest
//                        contents read; collector: check contents+packages read, publish
//                        and chart contents read + packages write, the rest contents read)
//   runs-on              every job on ubuntu-24.04 (never -latest)
//   timeout              every job has timeout-minutes, 1-360
//   concurrency          one workflow-level group (release / collector), cancel-in-progress
//                        false; no job-level concurrency
//   uses-allowed         only the actions of the allow-list below (Actions' "Allow select
//                        actions" lists exactly these), no local or docker:// action, no
//                        reusable workflow: every parsed step's uses: (structurally), and
//                        every raw `uses:` line of the text
//   uses-pin             each `uses:` pinned by the allow-list's full 40-hex commit SHA
//   uses-version-comment each `uses:` value carries the comment `# <its version>` (on the
//                        parsed node, and on the raw line)
//   setup-pins           setup-helm's version v4.2.1; setup-qemu's binfmt image by digest
//   persist-credentials  every checkout has persist-credentials: false
//   checkout-ref         release.yml: `version` checks out github.sha (fetch-depth 0), every
//                        other job needs.version.outputs.commit; collector.yml: github.sha
//   expression-in-run    no `${{` inside a run: (values come through env:)
//   run-form             every run: is one line: `bash <tracked script> <args>`, `npm ci` or
//                        `npm run build -w @telflo/cli` (in telflo-core), `mkdir -p
//                        "$RUNNER_TEMP/<name>"`, or the opamp-server clone; no shell
//                        operator, no substitution, no `shell:`
//   run-script           the script a run: names exists in the repository
//   opamp-clone          the clone is the public repository at vendor/opamp-server/PIN's tag
//   no-attest            --no-attest nowhere
//   github-env           GITHUB_ENV and GITHUB_PATH nowhere
//   status-functions     no always(), failure() or cancelled(), and no continue-on-error, but
//                        one: collector.yml's chart job's if: is exactly CHART_IF below, its
//                        `!cancelled()` (Ruling 401: a skipped publish, nothing to build,
//                        mustn't skip a chart-only bump); that expression on any other job,
//                        or any other status function, is refused
//   secrets              no secret but secrets.GITHUB_TOKEN, and that only in a job that
//                        reads or writes packages
//   token-env            the job's token is `${{ secrets.GITHUB_TOKEN }}` only (never
//                        github.token), and only docker/login-action's password or a step's
//                        env: GH_TOKEN on release.yml's version job's verify-tag.sh (the
//                        lightweight-tag fallback, Ruling 396) or on steps.sh github-release,
//                        GHCR_TOKEN on steps.sh helm-login; never a job's env, another
//                        action's input or any other place
//   telflo-crane         TELFLO_CRANE never set to a value at any level (each parsed env:, and
//                        the text); the publishing jobs set it "" in their env:, no step sets it
//   login                docker/login-action only to ghcr.io with GITHUB_TOKEN, no `scope`,
//                        its env DOCKER_CONFIG ${{ runner.temp }}/docker, only in a job with
//                        packages; every script step after it has that DOCKER_CONFIG
//   helm-login           steps.sh helm-login only in a job writing packages, and it and
//                        every script step after it have HELM_REGISTRY_CONFIG
//                        ${{ runner.temp }}/helm/registry/config.json
//   publish-needs        release.yml's publish needs every other job; collector.yml's publish
//                        needs check and test, its chart check and publish
//   publish-environment  the publishing jobs, and only they, run in the `release` environment
//   publish-if           a job's if: is exactly its spec's: release.yml's jobs none;
//                        collector.yml's build and test `${{ needs.check.outputs.has == 'true' }}`
//                        (nothing to build: skipped, Ruling 399), publish that and
//                        inputs.publish, chart CHART_IF (Ruling 401)
//   artifacts            uploads keep 3 days, fail on no files, and hold only files of
//                        ${{ runner.temp }}/oci/, /collector/ or /release/ (images and release
//                        files); downloads go to one of those folders
//   free-disk            each image-handling job's second step (after checkout) is
//                        steps.sh free-disk with at least its need (build 14, smokes 13,
//                        kind 18, publish 13; collector build 14, test 8, publish 8)
// Exit 0 every rule holds; 1 a rule fails; 2 usage or no `yaml` package.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let root = resolve(here, "..", "..");
let dir = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if ((argv[i] === "--dir" || argv[i] === "--root") && i + 1 < argv.length) {
    if (argv[i] === "--dir") dir = resolve(argv[i + 1]);
    else root = resolve(argv[i + 1]);
    i += 1;
  } else {
    console.error("usage: node scripts/release/check-workflows.mjs [--dir <workflows folder>] [--root <repository>]");
    process.exit(2);
  }
}
if (!dir) dir = join(root, ".github", "workflows");

let YAML;
try {
  YAML = createRequire(join(root, "telflo-core", "package.json"))("yaml");
} catch {
  console.error("check-workflows: the `yaml` package isn't installed (npm ci in telflo-core)");
  process.exit(2);
}

// The allow-list: each action, its commit and its version (Preflight ruling 7, PR-14).
const ACTIONS = {
  "actions/checkout": ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
  "actions/setup-node": ["949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"],
  "azure/setup-helm": ["9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310", "v5.0.1"],
  "docker/login-action": ["81c6f93d4bc991e510b342a00b419b3bb4efc5c6", "v4.7.0"],
  "docker/setup-qemu-action": ["99012661954931238ded8c8b007157a8430204e1", "v4.4.0"],
  "actions/upload-artifact": ["cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"],
  "actions/download-artifact": ["9000827ccba6bdab643e8b6fd33ac0654aef8333", "v8.0.2"],
};
const HELM_VERSION = "v4.2.1";
const BINFMT =
  "tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0";
const RUNNER = "ubuntu-24.04";
const DOCKER_CONFIG = "${{ runner.temp }}/docker";
const HELM_REGISTRY_CONFIG = "${{ runner.temp }}/helm/registry/config.json";
const TOKEN = "${{ secrets.GITHUB_TOKEN }}";
const COMMIT = "${{ needs.version.outputs.commit }}";
const SHA = "${{ github.sha }}";
const READ = { contents: "read" };
const VERSION_OUT = "${{ needs.version.outputs.version }}";
const COLLECTOR_OUT = "${{ needs.version.outputs.collector_version }}";
const MATRIX_VERSION = "${{ matrix.version }}";
const HAS = "${{ needs.check.outputs.has == 'true' }}";
const PUBLISH_HAS = "${{ inputs.publish && needs.check.outputs.has == 'true' }}";
// The one status function the workflows hold (Ruling 401): the chart job runs with publish when
// the check passed and the publish passed, or the publish was skipped because nothing was to be
// built (a chart-only bump); never after a failed or cancelled test or publish.
const CHART_IF =
  "${{ !cancelled() && inputs.publish && needs.check.result == 'success' && (needs.publish.result == 'success' || (needs.publish.result == 'skipped' && needs.check.outputs.has == 'false')) }}";
const STATUS_FUNCTION = /\b(always|failure|cancelled|success)\s*\(/g;
// The matrices (Ruling 402).
const RELEASE_MATRIX = { matrix: { image: ["api", "web", "otelcol-validator", "otelcol-testing", "ottl-evaluator"] } };
const COLLECTOR_MATRIX = { matrix: { version: "${{ fromJSON(needs.check.outputs.versions) }}" } };
const PUBLISHING_ENV = { TELFLO_CRANE: "" };

// The safety steps, by their exact run: line and the env values they need.
const LOAD = (dir, versionVar, collector) =>
  `bash scripts/release/load-images.sh --oci "$RUNNER_TEMP/${dir}" --version "$${versionVar}"${collector ? " --image collector" : ""} --platform linux/amd64`;
const SMOKE_LOADS = [
  { run: LOAD("oci", "VERSION", false), env: { VERSION: VERSION_OUT } },
  { run: LOAD("collector", "COLLECTOR_VERSION", true), env: { COLLECTOR_VERSION: COLLECTOR_OUT } },
];
const VERIFY_TAG = 'bash scripts/release/verify-tag.sh "$TAG" --expect "$EXPECT"';
const COLLECTOR_ARCHIVE = 'bash scripts/release/steps.sh collector-archive --out "$RUNNER_TEMP/collector"';
const COLLECTOR_VERSIONS = 'bash scripts/release/steps.sh collector-versions "$COLLECTOR_VERSION" --publish "$PUBLISH"';

const SPECS = {
  "release.yml": {
    trigger: { push: { tags: ["v*"] } },
    group: "release",
    jobs: {
      version: {
        permissions: { contents: "read", packages: "read" },
        ref: SHA,
        fullHistory: true,
        needs: [],
        outputs: {
          tag: "${{ steps.tag.outputs.tag }}",
          version: "${{ steps.tag.outputs.version }}",
          commit: "${{ steps.tag.outputs.commit }}",
          collector_version: "${{ steps.collector.outputs.collector_version }}",
        },
        ids: { tag: VERIFY_TAG, collector: COLLECTOR_ARCHIVE },
        required: [
          { run: "bash scripts/release/check-secrets.sh" },
          { run: VERIFY_TAG, env: { TAG: "${{ github.ref_name }}", EXPECT: SHA, GH_TOKEN: TOKEN } },
          { run: "bash scripts/release/verify-collector-artifacts.sh" },
          { run: COLLECTOR_ARCHIVE },
        ],
      },
      static: {
        permissions: READ,
        ref: COMMIT,
        needs: ["version"],
        required: [{ run: 'bash scripts/gates/static.sh --work "$RUNNER_TEMP/static"' }],
      },
      build: {
        permissions: READ,
        ref: COMMIT,
        disk: 14,
        needs: ["version"],
        strategy: RELEASE_MATRIX,
        required: [
          { run: "bash scripts/release/steps.sh builder" },
          {
            run: 'bash scripts/publish-platform-images.sh --build-oci "$RUNNER_TEMP/oci" --builder telflo-release --image "$IMAGE"',
            env: { IMAGE: "${{ matrix.image }}" },
          },
        ],
      },
      package: {
        permissions: READ,
        ref: COMMIT,
        needs: ["version"],
        required: [
          { run: 'bash scripts/publish-chart.sh --chart telflo --package "$RUNNER_TEMP/release"' },
          { run: 'bash scripts/release/build-compose-archive.sh --out "$RUNNER_TEMP/release"' },
          { run: 'bash scripts/release/steps.sh release-files --out "$RUNNER_TEMP/release"' },
        ],
      },
      "stack-smoke": {
        permissions: READ,
        ref: COMMIT,
        disk: 13,
        needs: ["version", "build"],
        required: [
          ...SMOKE_LOADS,
          {
            run: 'bash scripts/release/steps.sh stack-smoke --version "$VERSION" --work "$RUNNER_TEMP/stack-smoke"',
            env: { VERSION: VERSION_OUT },
          },
        ],
      },
      "archive-smoke": {
        permissions: READ,
        ref: COMMIT,
        disk: 13,
        needs: ["version", "build", "package"],
        required: [
          ...SMOKE_LOADS,
          {
            run: 'bash scripts/release/steps.sh archive-smoke --version "$VERSION" --release "$RUNNER_TEMP/release" --work "$RUNNER_TEMP/archive-smoke"',
            env: { VERSION: VERSION_OUT },
          },
        ],
      },
      "kind-smoke": {
        permissions: READ,
        ref: COMMIT,
        disk: 18,
        needs: ["version", "build", "package"],
        required: [
          ...SMOKE_LOADS,
          {
            run: 'bash scripts/release/steps.sh kind-smoke --version "$VERSION" --release "$RUNNER_TEMP/release" --work "$RUNNER_TEMP/kind-smoke"',
            env: { VERSION: VERSION_OUT },
          },
        ],
      },
      publish: {
        permissions: { contents: "write", packages: "write" },
        ref: COMMIT,
        disk: 13,
        publishing: true,
        needs: "all",
        required: [
          { run: 'bash scripts/publish-platform-images.sh --push-oci "$RUNNER_TEMP/oci"' },
          {
            run: 'bash scripts/publish-chart.sh --chart telflo --push-package "$RUNNER_TEMP/release/telflo-$VERSION.tgz"',
            env: { VERSION: VERSION_OUT },
          },
          {
            run: 'bash scripts/release/pull-back.sh --oci "$RUNNER_TEMP/oci" --version "$VERSION" --chart "$RUNNER_TEMP/release/telflo-$VERSION.tgz"',
            env: { VERSION: VERSION_OUT },
          },
          { run: "bash scripts/release/verify-collector-artifacts.sh" },
          {
            run: 'bash scripts/release/steps.sh github-release --tag "$TAG" --commit "$COMMIT" --oci "$RUNNER_TEMP/oci" --release "$RUNNER_TEMP/release"',
            env: { TAG: "${{ needs.version.outputs.tag }}", COMMIT: COMMIT, GH_TOKEN: TOKEN },
            last: true,
          },
        ],
      },
    },
  },
  "collector.yml": {
    trigger: "dispatch",
    group: "collector",
    jobs: {
      check: {
        permissions: { contents: "read", packages: "read" },
        ref: SHA,
        needs: [],
        outputs: { versions: "${{ steps.versions.outputs.versions }}", has: "${{ steps.versions.outputs.has }}" },
        ids: { versions: COLLECTOR_VERSIONS },
        required: [
          {
            run: COLLECTOR_VERSIONS,
            env: { COLLECTOR_VERSION: "${{ inputs.collector_version }}", PUBLISH: "${{ inputs.publish }}" },
          },
        ],
      },
      build: {
        permissions: READ,
        ref: SHA,
        disk: 14,
        needs: ["check"],
        if: HAS,
        strategy: COLLECTOR_MATRIX,
        required: [
          { run: "bash scripts/release/steps.sh builder" },
          {
            run: 'bash scripts/build-collector-image.sh "$COLLECTOR_VERSION" --build-oci "$RUNNER_TEMP/oci" --builder telflo-release',
            env: { COLLECTOR_VERSION: MATRIX_VERSION },
          },
        ],
      },
      test: {
        permissions: READ,
        ref: SHA,
        disk: 8,
        needs: ["check", "build"],
        if: HAS,
        strategy: COLLECTOR_MATRIX,
        required: [
          { run: "bash docker/collector-image/entrypoint_test.sh" },
          { run: "bash docker/collector-image/build-collector-image_test.sh" },
          { run: "bash charts/supervisor-collector/tests/render-tests.sh" },
          { run: LOAD("oci", "COLLECTOR_VERSION", true), env: { COLLECTOR_VERSION: MATRIX_VERSION } },
          {
            run: 'bash scripts/release/steps.sh collector-test --version "$COLLECTOR_VERSION"',
            env: { COLLECTOR_VERSION: MATRIX_VERSION },
          },
        ],
      },
      publish: {
        permissions: { contents: "read", packages: "write" },
        ref: SHA,
        disk: 8,
        publishing: true,
        needs: ["check", "test"],
        if: PUBLISH_HAS,
        strategy: COLLECTOR_MATRIX,
        required: [
          {
            run: 'bash scripts/build-collector-image.sh "$COLLECTOR_VERSION" --push-oci "$RUNNER_TEMP/oci"',
            env: { COLLECTOR_VERSION: MATRIX_VERSION },
          },
          {
            run: 'bash scripts/release/pull-back.sh --oci "$RUNNER_TEMP/oci" --version "$COLLECTOR_VERSION" --image collector --no-chart',
            env: { COLLECTOR_VERSION: MATRIX_VERSION },
          },
        ],
      },
      chart: {
        permissions: { contents: "read", packages: "write" },
        ref: SHA,
        publishing: true,
        needs: ["check", "publish"],
        if: CHART_IF,
        required: [{ run: 'bash scripts/release/steps.sh chart-if-new --out "$RUNNER_TEMP/chart"' }],
      },
    },
  },
};
const WORKFLOW_FILES = ["ci.yml", "collector.yml", "release.yml"];
const WORKFLOW_KEYS = ["name", "on", "permissions", "concurrency", "jobs"];
const JOB_KEYS = ["needs", "if", "runs-on", "timeout-minutes", "permissions", "outputs", "strategy", "environment", "env", "steps"];
const STEP_KEYS = ["name", "id", "uses", "with", "env", "run", "working-directory"];
// Each action's with: keys (with-keys): nothing that changes what is checked out, from where,
// with which token, or where files land beyond the artifacts rule's folders.
const WITH_KEYS = {
  "actions/checkout": ["ref", "fetch-depth", "persist-credentials"],
  "actions/setup-node": ["node-version"],
  "azure/setup-helm": ["version"],
  "docker/login-action": ["registry", "username", "password"],
  "docker/setup-qemu-action": ["image", "platforms"],
  "actions/upload-artifact": ["name", "path", "retention-days", "compression-level", "if-no-files-found"],
  "actions/download-artifact": ["name", "pattern", "merge-multiple", "path"],
};
// env-names: the names the steps' scripts read, and the ones that change what runs or where.
const ENV_ALLOWED = [
  "DOCKER_CONFIG", "HELM_REGISTRY_CONFIG", "TAG", "EXPECT", "COMMIT", "VERSION", "COLLECTOR_VERSION",
  "IMAGE", "PUBLISH", "GH_TOKEN", "GHCR_USER", "GHCR_TOKEN", "TELFLO_CRANE",
];
const ENV_DENIED = [
  "TELFLO_TOOLS_LOCK", "TELFLO_TOOLS_PLATFORM", "TELFLO_TOOLS_DIR", "BASH_ENV", "ENV", "NODE_OPTIONS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "IFS", "CDPATH", "GLOBIGNORE", "NODE_PATH",
  "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PERL5LIB", "PERL5OPT", "RUBYOPT",
  "HOME", "TMPDIR", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "CURL_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GH_HOST", "GH_REPO", "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "CI", "GITHUB_ACTIONS", "RUNNER_TEMP", "GITHUB_REPOSITORY",
  "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "TELFLO_LOAD_IMAGES_NAME", "TELFLO_LOAD_IMAGES_PORT",
];
// The two allowed names a deny prefix would match (DOCKER_*, HELM_*): fixed values, env-values.
const ENV_VALUES_NAMES = ["DOCKER_CONFIG", "HELM_REGISTRY_CONFIG"];
const ENV_DENIED_PREFIX = /^(LD_|DYLD_|GIT_|NPM_CONFIG_|BASH_FUNC_|DOCKER_|BUILDKIT_|BUILDX_|HELM_|TELFLO_TOOLS_|KUBE)/i;
const ENV_VALUES = {
  DOCKER_CONFIG: "${{ runner.temp }}/docker",
  HELM_REGISTRY_CONFIG: "${{ runner.temp }}/helm/registry/config.json",
  GHCR_USER: "${{ github.actor }}",
};

const problems = [];
const problem = (file, rule, why) => problems.push(`check-workflows: ${file}: ${rule}: ${why}`);
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isMap(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// The repository's files (tracked, and untracked ones git doesn't ignore).
let files = new Set();
try {
  files = new Set(
    execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
  );
} catch {
  problem("-", "run-script", `${root} isn't a git checkout: the scripts a run: names can't be found`);
}
const pinPath = join(root, "vendor", "opamp-server", "PIN");
const pinVersion = existsSync(pinPath)
  ? (readFileSync(pinPath, "utf8").match(/^version=(\S+)$/m) || [])[1] || ""
  : "";

// workflow-files
let present = [];
try {
  present = readdirSync(dir).sort();
} catch {
  problem("-", "workflow-files", `no folder ${dir}`);
}
for (const name of present) {
  if (!WORKFLOW_FILES.includes(name)) problem(name, "workflow-files", `the folder holds exactly ${WORKFLOW_FILES.join(", ")}: no other file`);
}
for (const name of WORKFLOW_FILES) {
  if (present.length && !present.includes(name)) problem(name, "workflow-files", "missing");
}

// checkEnv: one env: map (the workflow's, a job's or a step's).
function checkEnv(file, where, env, level) {
  if (env === undefined) return;
  if (!isMap(env)) {
    problem(file, "env-names", `${where}.env: a mapping`);
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    // The allow-list is the guard; the deny list words the message (and keeps refusing a denied
    // name should one ever be added to the allow-list).
    const denied = ENV_DENIED.includes(upper) || (ENV_DENIED_PREFIX.test(k) && !ENV_VALUES_NAMES.includes(k));
    if (denied) {
      problem(file, "env-names", `${where}.env.${k}: it changes what runs or where (never set in a workflow)`);
    } else if (!ENV_ALLOWED.includes(k)) {
      problem(file, "env-names", `${where}.env.${k}: not a name the steps' scripts read (${ENV_ALLOWED.join(", ")})`);
    }
    if (k in ENV_VALUES && v !== ENV_VALUES[k]) problem(file, "env-values", `${where}.env.${k}: ${ENV_VALUES[k]} (got ${JSON.stringify(v)})`);
    if (k === "TELFLO_CRANE" && (level !== "job" || v !== "")) {
      problem(file, "telflo-crane", `${where}.env.TELFLO_CRANE: set (${JSON.stringify(v)}): only a publishing job's env sets it, to "" (crane is tools.sh's checked one only)`);
    }
  }
}

const SAFE_ARG = /^(--?[a-z][a-z0-9-]*|"\$[A-Z][A-Z0-9_]*(\/[A-Za-z0-9._$-]+)*"|[A-Za-z0-9@][A-Za-z0-9@._:\/=+-]*)$/;
function checkRun(file, job, index, step) {
  const where = `jobs.${job}.steps[${index}]`;
  const run = step.run;
  if (typeof run !== "string") {
    problem(file, "run-form", `${where}: run isn't a string`);
    return null;
  }
  if (run.includes("${{")) problem(file, "expression-in-run", `${where}: \${{ }} inside run: (pass it through env:)`);
  if ("shell" in step) problem(file, "run-form", `${where}: no shell: (the runner's default bash)`);
  const lines = run.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) {
    problem(file, "run-form", `${where}: a run: is one command line (${lines.length} lines)`);
    return null;
  }
  const line = lines[0].trim();
  if (/[;&|<>`\\]|\$\(|\$\{/.test(line)) {
    problem(file, "run-form", `${where}: a shell operator, substitution or escape in run: ${line}`);
    return null;
  }
  const words = line.split(/\s+/);
  const wd = step["working-directory"];
  if (words[0] === "bash") {
    const script = words[1] || "";
    const allowed =
      /^scripts\/[A-Za-z0-9._\/-]+\.sh$/.test(script) ||
      /^docker\/collector-image\/[A-Za-z0-9._-]+\.sh$/.test(script) ||
      /^charts\/[a-z0-9-]+\/tests\/render-tests\.sh$/.test(script);
    if (!allowed || script.includes("..") || wd !== undefined) {
      problem(file, "run-form", `${where}: bash runs a script of scripts/, docker/collector-image/ or a chart's tests, from the root: ${line}`);
      return null;
    }
    if (!files.has(script)) problem(file, "run-script", `${where}: ${script} isn't in the repository`);
    for (const w of words.slice(2)) {
      if (!SAFE_ARG.test(w)) problem(file, "run-form", `${where}: the argument ${w} isn't a plain word, an option or a quoted "$VARIABLE"`);
    }
    return script + " " + words.slice(2).join(" ");
  }
  if (line === "npm ci" || line === "npm run build -w @telflo/cli") {
    if (wd !== "telflo-core") problem(file, "run-form", `${where}: ${line} runs in telflo-core (working-directory)`);
    return null;
  }
  if (/^mkdir -p "\$RUNNER_TEMP\/[a-z][a-z0-9-]*"$/.test(line) && wd === undefined) return null;
  const clone = line.match(/^git clone --branch v(\S+) https:\/\/github\.com\/telflo\/opamp-server\.git \.\.\/opamp-server$/);
  if (clone && wd === undefined) {
    if (clone[1] !== pinVersion) {
      problem(file, "opamp-clone", `${where}: the clone is v${clone[1]}, vendor/opamp-server/PIN's is v${pinVersion || "?"}`);
    }
    return null;
  }
  problem(file, "run-form", `${where}: not tool setup, artifact handling or one call of a committed script: ${line}`);
  return null;
}

for (const [file, spec] of Object.entries(SPECS)) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    problem(file, "workflow-files", "missing");
    continue;
  }
  const text = readFileSync(path, "utf8");
  const doc = YAML.parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) {
    problem(file, "yaml", [...doc.errors, ...doc.warnings].map((e) => e.message.split("\n")[0]).join("; "));
    continue;
  }
  let anchored = false;
  YAML.visit(doc, {
    Alias() {
      anchored = true;
    },
    Node(_, node) {
      if (node.anchor) anchored = true;
    },
  });
  if (anchored) problem(file, "yaml", "no anchors or aliases (what is checked is what GitHub reads)");
  const wf = doc.toJS();
  if (!isMap(wf)) {
    problem(file, "yaml", "not a mapping");
    continue;
  }

  // Text rules.
  if (text.includes("pull_request_target")) problem(file, "pull-request-target", "pull_request_target appears");
  if (text.includes("--no-attest")) problem(file, "no-attest", "--no-attest appears (a rehearsal's only, never a workflow's)");
  if (/GITHUB_ENV|GITHUB_PATH/.test(text)) problem(file, "github-env", "GITHUB_ENV or GITHUB_PATH appears (a step must not set a later one's environment)");
  {
    // The text: no status function but the chart job's one allowed expression (Ruling 401).
    const found = [...text.matchAll(STATUS_FUNCTION)].length;
    const jobsMap = isMap(wf.jobs) ? wf.jobs : {};
    const allowed = file === "collector.yml" && isMap(jobsMap.chart) && jobsMap.chart.if === CHART_IF ? 1 : 0;
    if (found > allowed) problem(file, "status-functions", `always(), failure(), cancelled() or success() appears (${found}; ${allowed} allowed: collector.yml's chart job's exact if:)`);
  }
  if (/continue-on-error/.test(text)) problem(file, "status-functions", "continue-on-error appears");
  // Every expression: only secrets.GITHUB_TOKEN, never another secret or secrets[...].
  for (const e of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const m of e[1].matchAll(/\bsecrets\s*(\.\s*([A-Za-z0-9_]+)|\[|\b)/g)) {
      if (m[2] !== "GITHUB_TOKEN") problem(file, "secrets", `\${{${e[1]}}}: no secret but the job's GITHUB_TOKEN`);
    }
  }
  // token-env: every expression naming the token is counted; each must be one the
  // steps below find in an allowed place.
  if (/\bgithub\s*\.\s*token\b/.test(text)) problem(file, "token-env", "github.token appears (the token is secrets.GITHUB_TOKEN, where token-env allows it)");
  let tokenExpressions = 0;
  for (const e of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) if (/GITHUB_TOKEN/.test(e[1])) tokenExpressions += 1;
  let tokenPlaced = 0;
  for (const m of text.matchAll(/TELFLO_CRANE\s*:\s*(.*)$/gm)) {
    const value = m[1].replace(/\s+#.*$/, "").trim();
    if (value !== '""' && value !== "''") problem(file, "telflo-crane", `TELFLO_CRANE is set (${value}): crane is tools.sh's checked one only`);
  }
  // The `uses:` lines, raw: each pinned and commented.
  const usesLines = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
  for (const m of usesLines) {
    const [name, ref] = m[1].split("@");
    const comment = m[2].trim();
    if (!(name in ACTIONS)) {
      problem(file, "uses-allowed", `${m[1]} isn't on the allow-list`);
      continue;
    }
    const [sha, version] = ACTIONS[name];
    if (ref !== sha) problem(file, "uses-pin", `${name}@${ref || ""}: pin it by its full commit SHA ${sha} (${version})`);
    if (comment !== `# ${version}`) problem(file, "uses-version-comment", `${name}: the line must end with "# ${version}" (got "${comment}")`);
  }

  // on:
  if (spec.trigger === "dispatch") {
    const on = wf.on;
    if (!isMap(on) || !same(Object.keys(on), ["workflow_dispatch"])) {
      problem(file, "trigger", `only workflow_dispatch (got ${JSON.stringify(on)})`);
    }
    const inputs = isMap(on) && isMap(on.workflow_dispatch) ? on.workflow_dispatch.inputs : undefined;
    const cv = isMap(inputs) ? inputs.collector_version : undefined;
    const pb = isMap(inputs) ? inputs.publish : undefined;
    if (!isMap(inputs) || !same(Object.keys(inputs).sort(), ["collector_version", "publish"])) {
      problem(file, "dispatch-inputs", "the inputs are exactly collector_version and publish");
    }
    if (!isMap(cv) || cv.type !== "string" || cv.required !== true) {
      problem(file, "dispatch-inputs", "collector_version is a required string");
    }
    if (!isMap(pb) || pb.type !== "boolean" || pb.default !== false) {
      problem(file, "dispatch-inputs", "publish is a boolean whose default is false");
    }
  } else if (!same(wf.on, spec.trigger)) {
    problem(file, "trigger", `only ${JSON.stringify(spec.trigger)} (got ${JSON.stringify(wf.on)})`);
  }
  if (!isMap(wf.permissions) || Object.keys(wf.permissions).length !== 0) {
    problem(file, "permissions-top", `the top-level permissions must be {} (got ${JSON.stringify(wf.permissions)})`);
  }
  if (!same(wf.concurrency, { group: spec.group, "cancel-in-progress": false })) {
    problem(file, "concurrency", `concurrency: { group: ${spec.group}, cancel-in-progress: false } (got ${JSON.stringify(wf.concurrency)})`);
  }
  if (wf.env !== undefined) problem(file, "telflo-crane", "no workflow-level env: (each job's own)");
  for (const k of Object.keys(wf)) {
    if (!WORKFLOW_KEYS.includes(k)) problem(file, "workflow-keys", `${k}: the top level holds only ${WORKFLOW_KEYS.join(", ")}`);
  }
  checkEnv(file, "(workflow)", wf.env, "workflow");

  const jobs = isMap(wf.jobs) ? wf.jobs : {};
  if (!same(Object.keys(jobs).sort(), Object.keys(spec.jobs).sort())) {
    problem(file, "jobs", `the jobs are ${Object.keys(spec.jobs).join(", ")} (got ${Object.keys(jobs).join(", ")})`);
  }
  let parsedUses = 0;
  for (const [name, job] of Object.entries(jobs)) {
    const js = spec.jobs[name];
    if (!js || !isMap(job)) continue;
    if ("uses" in job) problem(file, "uses-allowed", `jobs.${name}: no reusable workflow`);
    const jobNode = doc.getIn(["jobs", name], true);
    if (jobNode && jobNode.flow) problem(file, "yaml", `jobs.${name}: a block mapping (no flow style)`);
    for (const k of Object.keys(job)) {
      if (!JOB_KEYS.includes(k)) problem(file, "job-keys", `jobs.${name}.${k}: a job holds only ${JOB_KEYS.join(", ")}`);
    }
    if (job.strategy !== undefined) {
      if (!isMap(job.strategy) || !same(Object.keys(job.strategy), ["matrix"])) {
        problem(file, "job-keys", `jobs.${name}.strategy: matrix only`);
      }
    }
    if (!same(job.strategy === undefined ? null : job.strategy, js.strategy === undefined ? null : js.strategy)) {
      problem(file, "matrix", `jobs.${name}: strategy must be exactly ${JSON.stringify(js.strategy === undefined ? null : js.strategy)} (got ${JSON.stringify(job.strategy)})`);
    }
    const wantJobEnv = js.publishing ? PUBLISHING_ENV : undefined;
    if (!same(job.env === undefined ? null : job.env, wantJobEnv === undefined ? null : wantJobEnv)) {
      problem(file, "job-env", `jobs.${name}: its own env: must be exactly ${JSON.stringify(wantJobEnv === undefined ? null : wantJobEnv)} (got ${JSON.stringify(job.env)})`);
    }
    if (typeof job.if === "string" && /\b(always|failure|cancelled|success)\s*\(/.test(job.if) && !(file === "collector.yml" && name === "chart" && job.if === CHART_IF)) {
      problem(file, "status-functions", `jobs.${name}: if: ${job.if}: a status function only in collector.yml's chart job, exactly its allow-listed expression`);
    }
    checkEnv(file, `jobs.${name}`, job.env, "job");
    // outputs, and the steps' ids (job-outputs)
    const wantOutputs = js.outputs || {};
    if (!same(job.outputs === undefined ? {} : job.outputs, wantOutputs)) {
      problem(file, "job-outputs", `jobs.${name}: outputs must be exactly ${JSON.stringify(wantOutputs)} (got ${JSON.stringify(job.outputs)})`);
    }
    if (!same(job.permissions, js.permissions)) {
      problem(file, "job-permissions", `jobs.${name}: permissions must be ${JSON.stringify(js.permissions)} (got ${JSON.stringify(job.permissions)})`);
    }
    if (job["runs-on"] !== RUNNER) problem(file, "runs-on", `jobs.${name}: runs-on ${RUNNER} (got ${JSON.stringify(job["runs-on"])})`);
    const timeout = job["timeout-minutes"];
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 360) problem(file, "timeout", `jobs.${name}: timeout-minutes 1-360`);
    if ("concurrency" in job) problem(file, "concurrency", `jobs.${name}: no job-level concurrency`);
    const env = isMap(job.env) ? job.env : {};
    for (const [k, v] of Object.entries(env)) {
      if (String(v).includes("GITHUB_TOKEN")) problem(file, "token-env", `jobs.${name}.env.${k}: the token never in a job's env (a step's, where token-env allows it)`);
    }
    const packages = isMap(job.permissions) ? job.permissions.packages : undefined;
    if (js.publishing) {
      if (env.TELFLO_CRANE !== "") problem(file, "telflo-crane", `jobs.${name}: a publishing job sets TELFLO_CRANE: "" (crane is tools.sh's)`);
      const environment = isMap(job.environment) ? job.environment.name : job.environment;
      if (environment !== "release") problem(file, "publish-environment", `jobs.${name}: runs in the release environment`);
    } else if ("environment" in job) {
      problem(file, "publish-environment", `jobs.${name}: only the publishing jobs run in an environment`);
    }
    const needs = job.needs === undefined ? [] : [].concat(job.needs);
    const needsRule = js.publishing ? "publish-needs" : "needs";
    const wantNeeds = js.needs === "all" ? Object.keys(spec.jobs).filter((j) => j !== name) : js.needs;
    if (!same([...needs].sort(), [...wantNeeds].sort())) {
      problem(file, needsRule, `jobs.${name}: needs exactly ${wantNeeds.join(", ") || "nothing"} (got ${needs.join(", ") || "nothing"})`);
    }
    if (js.if !== undefined && job.if !== js.if) problem(file, "publish-if", `jobs.${name}: if: ${js.if} (got ${JSON.stringify(job.if)})`);
    if (js.if === undefined && "if" in job) problem(file, "publish-if", `jobs.${name}: no if: (it always runs)`);
    const tokenJob = packages === "read" || packages === "write";
    const jobText = JSON.stringify(job);
    if (jobText.includes("secrets.GITHUB_TOKEN") && !tokenJob) {
      problem(file, "secrets", `jobs.${name}: GITHUB_TOKEN only in a job that reads or writes packages`);
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const stepNodes = doc.getIn(["jobs", name, "steps"], true);
    // required-steps: the safety steps, in order, each its exact run: line and env values.
    const required = js.required || [];
    let next = 0;
    let lastRun = -1;
    steps.forEach((step, index) => {
      if (!isMap(step) || typeof step.run !== "string") return;
      lastRun = index;
      if (next >= required.length) return;
      const want = required[next];
      const env = isMap(step.env) ? step.env : {};
      if (step.run.trim() === want.run && Object.entries(want.env || {}).every(([k, v]) => env[k] === v)) {
        if (want.last) want.at = index;
        next += 1;
      }
    });
    if (next < required.length) {
      const want = required[next];
      problem(file, "required-steps", `jobs.${name}: the step \`${want.run}\`${want.env ? ` (env ${JSON.stringify(want.env)})` : ""} is missing, changed or out of order`);
    }
    for (const want of required) {
      if (want.last && want.at !== undefined && want.at !== lastRun) {
        problem(file, "required-steps", `jobs.${name}: \`${want.run}\` is the job's last run: step`);
      }
      delete want.at;
    }
    // job-outputs: each id on its own step (outputs come only from those steps).
    const ids = js.ids || {};
    const seenIds = new Set();
    steps.forEach((step, index) => {
      if (!isMap(step) || !("id" in step)) return;
      const id = step.id;
      if (seenIds.has(id)) problem(file, "job-outputs", `jobs.${name}.steps[${index}]: the id ${id} twice`);
      seenIds.add(id);
      if (!(id in ids)) problem(file, "job-outputs", `jobs.${name}.steps[${index}]: id ${JSON.stringify(id)}: only ${Object.keys(ids).join(", ") || "no"} step ids in this job`);
      else if (typeof step.run !== "string" || step.run.trim() !== ids[id]) problem(file, "job-outputs", `jobs.${name}.steps[${index}]: the id ${id} belongs to \`${ids[id]}\``);
    });
    for (const id of Object.keys(ids)) if (!seenIds.has(id)) problem(file, "job-outputs", `jobs.${name}: no step with the id ${id} (\`${ids[id]}\`)`);
    let loggedIn = false;
    let helmLoggedIn = false;
    let checkoutSeen = false;
    steps.forEach((step, index) => {
      if (!isMap(step)) return;
      const where = `jobs.${name}.steps[${index}]`;
      const stepNode = stepNodes && stepNodes.items ? stepNodes.items[index] : undefined;
      if (stepNode && stepNode.flow) problem(file, "yaml", `${where}: a block mapping (no flow-style { … } step)`);
      for (const k of Object.keys(step)) {
        if (k !== "if" && !STEP_KEYS.includes(k)) problem(file, "step-keys", `${where}.${k}: a step holds only ${STEP_KEYS.join(", ")}`);
      }
      if ("if" in step) problem(file, "step-if", `${where}: no step carries if: (got ${JSON.stringify(step.if)})`);
      checkEnv(file, where, step.env, "step");
      const senv = isMap(step.env) ? step.env : {};
      const tokenEnv = Object.entries(senv).filter(([, v]) => String(v).includes("GITHUB_TOKEN"));
      if ("uses" in step && typeof step.uses !== "string") problem(file, "uses-allowed", `${where}: uses: is one action reference`);
      if (typeof step.uses === "string") {
        for (const [k] of tokenEnv) problem(file, "token-env", `${where}.env.${k}: the token never in an action's env`);
        parsedUses += 1;
        const [action, ref] = step.uses.split("@");
        if (step.uses.startsWith("./") || step.uses.startsWith("docker://")) problem(file, "uses-allowed", `${where}: ${step.uses}`);
        // The parsed value, structurally: allowed, pinned, and its node's comment the version.
        if (!(action in ACTIONS)) {
          problem(file, "uses-allowed", `${where}: ${step.uses} isn't on the allow-list`);
          return;
        }
        const [sha, version] = ACTIONS[action];
        if (ref !== sha || step.uses.split("@").length !== 2) problem(file, "uses-pin", `${where}: ${step.uses}: pin it by its full commit SHA ${sha} (${version})`);
        const usesNode = stepNode && typeof stepNode.get === "function" ? stepNode.get("uses", true) : undefined;
        const nodeComment = usesNode && typeof usesNode.comment === "string" ? usesNode.comment.trim() : "";
        if (nodeComment !== version) problem(file, "uses-version-comment", `${where}: ${action}: its uses: carries the comment "# ${version}" (got "${nodeComment}")`);
        const w = isMap(step.with) ? step.with : {};
        if (step.with !== undefined && !isMap(step.with)) problem(file, "with-keys", `${where}.with: a mapping`);
        for (const k of Object.keys(w)) {
          if (!WITH_KEYS[action].includes(k)) problem(file, "with-keys", `${where}.with.${k}: ${action} takes only ${WITH_KEYS[action].join(", ")}`);
        }
        if (action === "actions/checkout") {
          checkoutSeen = true;
          if (w["persist-credentials"] !== false) problem(file, "persist-credentials", `${where}: persist-credentials: false`);
          if (w.ref !== js.ref) problem(file, "checkout-ref", `${where}: ref ${js.ref} (got ${JSON.stringify(w.ref)})`);
          if (js.fullHistory && w["fetch-depth"] !== 0) problem(file, "checkout-ref", `${where}: fetch-depth: 0 (the main-ancestry check)`);
          if (index !== 0) problem(file, "checkout-ref", `${where}: the checkout is the job's first step`);
        }
        if (action === "azure/setup-helm" && w.version !== HELM_VERSION) problem(file, "setup-pins", `${where}: helm ${HELM_VERSION}`);
        if (action === "docker/setup-qemu-action" && w.image !== BINFMT) problem(file, "setup-pins", `${where}: binfmt ${BINFMT}`);
        for (const [k, v] of Object.entries(w)) {
          if (!String(v).includes("GITHUB_TOKEN")) continue;
          if (action === "docker/login-action" && k === "password" && v === TOKEN) tokenPlaced += 1;
          else problem(file, "token-env", `${where}.with.${k}: the token is an input of docker/login-action's password only`);
        }
        if (action === "docker/login-action") {
          if (w.registry !== "ghcr.io" || w.password !== TOKEN || w.username !== "${{ github.actor }}") {
            problem(file, "login", `${where}: ghcr.io, github.actor and the job's GITHUB_TOKEN only`);
          }
          if ("scope" in w) problem(file, "login", `${where}: no scope: input`);
          if (senv.DOCKER_CONFIG !== DOCKER_CONFIG) problem(file, "login", `${where}: env DOCKER_CONFIG ${DOCKER_CONFIG} (never the runner's home)`);
          if (!tokenJob) problem(file, "login", `${where}: a login only in a job with packages`);
          loggedIn = true;
        }
        if (action === "actions/download-artifact") {
          if (!/^\$\{\{ runner\.temp \}\}\/(oci|collector|release)$/.test(String(w.path || ""))) {
            problem(file, "artifacts", `${where}: path ${JSON.stringify(w.path)}: runner.temp's oci, collector or release folder`);
          }
        }
        if (action === "actions/upload-artifact") {
          if (w["retention-days"] !== 3) problem(file, "artifacts", `${where}: retention-days: 3`);
          if (w["if-no-files-found"] !== "error") problem(file, "artifacts", `${where}: if-no-files-found: error`);
          const paths = String(w.path || "").split("\n").map((p) => p.trim()).filter(Boolean);
          if (!paths.length) problem(file, "artifacts", `${where}: no path`);
          for (const p of paths) {
            if (!/^\$\{\{ runner\.temp \}\}\/(oci|collector|release)\/[A-Za-z0-9._${}\s-]*$/.test(p) || p.includes("..")) {
              problem(file, "artifacts", `${where}: ${p}: only the images' and the release's files (runner.temp's oci/, collector/ or release/)`);
            }
          }
        }
        return;
      }
      if ("run" in step) {
        const call = checkRun(file, name, index, step);
        if (typeof step.run === "string" && /smoke-(compose-install|kind|test-stack)\.sh/.test(step.run)) {
          problem(file, "smoke-direct", `${where}: a smoke runs only through scripts/release/steps.sh (its output through redact.sh), never called directly`);
        }
        if (typeof step.run === "string" && /scripts\/release\/load-images\.sh/.test(step.run)) {
          const platforms = [...step.run.matchAll(/--platform\s+(\S+)/g)].map((m) => m[1]);
          if (platforms.length !== 1 || platforms[0] !== "linux/amd64") {
            problem(file, "load-platform", `${where}: load-images.sh names --platform linux/amd64 (the runner's; got ${platforms.join(", ") || "none"})`);
          }
        }
        for (const [k, v] of tokenEnv) {
          const allowed =
            v === TOKEN &&
            ((k === "GH_TOKEN" && file === "release.yml" && name === "version" && call !== null && call.startsWith("scripts/release/verify-tag.sh ")) ||
              (k === "GH_TOKEN" && call !== null && call.startsWith("scripts/release/steps.sh github-release ")) ||
              (k === "GHCR_TOKEN" && call !== null && call.startsWith("scripts/release/steps.sh helm-login")));
          if (allowed) tokenPlaced += 1;
          else problem(file, "token-env", `${where}.env.${k}: the token only as GH_TOKEN on release.yml's version job's verify-tag.sh or steps.sh github-release, or GHCR_TOKEN on steps.sh helm-login`);
        }
        if (call && call.startsWith("scripts/release/steps.sh helm-login")) {
          if (packages !== "write") problem(file, "helm-login", `${where}: helm-login only in a job writing packages`);
          helmLoggedIn = true;
        }
        if (call && loggedIn && senv.DOCKER_CONFIG !== DOCKER_CONFIG) {
          problem(file, "login", `${where}: after the login, a script step's env DOCKER_CONFIG is ${DOCKER_CONFIG}`);
        }
        if (call && helmLoggedIn && senv.HELM_REGISTRY_CONFIG !== HELM_REGISTRY_CONFIG) {
          problem(file, "helm-login", `${where}: env HELM_REGISTRY_CONFIG ${HELM_REGISTRY_CONFIG}`);
        }
        return;
      }
      problem(file, "run-form", `${where}: a step is a uses: or a run:`);
    });
    if (!checkoutSeen) problem(file, "checkout-ref", `jobs.${name}: no checkout`);
    if (js.disk) {
      const second = steps[1];
      const m = isMap(second) && typeof second.run === "string" ? second.run.trim().match(/^bash scripts\/release\/steps\.sh free-disk (\d+)$/) : null;
      if (!m || Number(m[1]) < js.disk) problem(file, "free-disk", `jobs.${name}: the second step (after the checkout) is steps.sh free-disk ${js.disk} or more`);
    }
  }
  if (tokenPlaced !== tokenExpressions) {
    problem(file, "token-env", `${tokenExpressions} expressions name the token but ${tokenPlaced} are where token-env allows it (no other place: outputs, if:, comments)`);
  }
  if (parsedUses !== usesLines.length) {
    problem(file, "uses-version-comment", `${usesLines.length} uses: lines but ${parsedUses} steps with uses: (write each as "uses: <action>@<sha> # <version>" on its own line)`);
  }
}

if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`check-workflows: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-workflows: OK: ${Object.keys(SPECS).join(" and ")} hold every rule`);
