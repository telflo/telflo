# The telflo CLI, for its developers

The user's guide is the CLI's own README
(`telflo-core/apps/cli/README.md`); the security rules are
`docs/conventions/security.md`, "The telflo CLI".

Every command below runs from `telflo-core/` unless a step says otherwise,
and each block is one command.

## What it is

- **The package:** `telflo-core/apps/cli`, the workspace `@telflo/cli`
  (the root package is already `telflo`), version `0.3.0`, `"private":
  true`, `"license": "Apache-2.0"` (as the repository, with its own
  copy of `LICENSE` so the tarball carries it), ESM, Node 22 or newer, the
  bin `telflo` (`dist/index.js`). Its runtime dependencies are `commander`
  and `yaml`, pinned; nothing else.
- **No runtime import from a workspace package:** a tarball installs
  alone. Replies are typed with `import type { … } from
  "@telflo/contracts"` (a dev dependency); `eslint.config.js` refuses any
  other import of `@telflo/*` in `apps/cli` (the inline `import { type X
  }` form included: under `verbatimModuleSyntax` it leaves a runtime
  import), and the package check searches `dist/`. A constant copied from
  the contracts has a drift test that imports them (tests may).
- **The layout:** `src/index.ts` (the bin, three lines), `src/program.ts`
  (the root command, `--json`, `-V`), `src/api.ts` (the one client:
  timeouts, no redirects, `Retry-After`, the error words), `src/server.ts`,
  `src/credentials.ts`, `src/context.ts` (the login a command runs with),
  `src/output.ts` (exit codes, `emit`, `printTable`, `terminalText`,
  `withoutTokens`), `src/login-listener.ts` and `src/login-browser.ts`
  (the browser login), `src/commands/*.ts` (one area each: they print),
  `src/ops/*.ts` (the calls: data only, they never print), and
  `skills/telflo-cli/` (the agent skill `telflo skills install` copies).
  Unit tests sit beside their modules; the integration tests and their
  harness are in `tests/` (never built, never packed).
- **Two tsconfigs:** `tsconfig.json` (NodeNext, no emit: the typecheck,
  `src/` and `tests/`) and `tsconfig.build.json` (`dist/`, no
  declarations, maps or build info).

## Build and run from the checkout

```bash
npm run build -w @telflo/cli
```

`build` empties `dist/` first, then compiles `src/` (tests excluded);
`prepack` runs it, so a tarball never holds a stale `dist/`. Run the
build with `node`, with a config folder and a HOME of your own so it never
reads or writes your real login:

```bash
mkdir -m 700 /tmp/telflo-cli-dev
```

```bash
HOME=/tmp/telflo-cli-dev TELFLO_CLI_CONFIG_DIR=/tmp/telflo-cli-dev node apps/cli/dist/index.js --help
```

Against the local stack, log in through its gateway (plain `http://` is
allowed for `localhost`, `127.0.0.0/8` and `[::1]` only; the page it opens,
`/cli-auth`, is the stack's web app):

```bash
HOME=/tmp/telflo-cli-dev TELFLO_CLI_CONFIG_DIR=/tmp/telflo-cli-dev node apps/cli/dist/index.js login --server http://localhost:50080
```

`TELFLO_CLI_CONFIG_DIR` keeps a local and a hosted login side by side.
Never point a probe at the default server (`https://telflo.com`): a test
or probe of the default names a loopback stand-in with `--server`.

## Test

The CLI's tests are the vitest project `cli`. Its integration tests run
the real API in process (`tests/harness.ts`: `buildServer` on the test
database, listening on `127.0.0.1:0`, the client on real `fetch`, tokens
made by the API's own helpers), so they need the test database as every
API integration test does (`docs/conventions/testing.md`, "Local setup").
`tests/setup.ts` blanks `TELFLO_TOKEN`, `TELFLO_SERVER`, `TELFLO_ORG` and
`TELFLO_CONFIG_DIR`, and points `TELFLO_CLI_CONFIG_DIR`, `XDG_CONFIG_HOME`
and `HOME` at a temporary folder per file.

```bash
npx vitest run --project cli --maxWorkers=1 --minWorkers=1
```

Always single-worker: the project's integration files share one database,
and `fileParallelism: false` doesn't hold when vitest runs them from the
root (two files at once deadlock). One file, or a few:

```bash
npx vitest run --project cli --maxWorkers=1 --minWorkers=1 apps/cli/src/commands/skills.test.ts
```

`apps/cli/src` meets the coverage floors on its own (the root's
`vitest.config.ts` excludes `src/index.ts` and `tests/`):

```bash
npx vitest run --project cli --maxWorkers=1 --minWorkers=1 --coverage --coverage.include='apps/cli/src/**'
```

The rules the tests keep (`docs/conventions/security.md`): a token, a
bearer or an install command is checked with boolean canaries only, the
canary before any comparison of a command's output; the listener is
tested with real loopback requests; nothing reads the user's own
`~/.config/telflo` or `~/.telflo`. The browser login's end-to-end spec is
`e2e/cli-auth.e2e.ts` (the web's suite; it starts the CLI's own listener
module).

## The package check

```bash
bash ../scripts/check-cli-package.sh
```

It packs `@telflo/cli` (`npm pack`, which builds it) with a temporary HOME,
npm config and `TELFLO_CLI_CONFIG_DIR`, then checks:
- the tarball holds only `package.json`, `README.md`, `LICENSE`, `dist/**`
  and `skills/**` (no declarations, maps, build info or tests);
- its manifest keeps `"private": true`, `Apache-2.0` and `bin.telflo`, and
  names no `@telflo/` runtime dependency; no `dist/**/*.js` imports
  `@telflo/`;
- it installs alone, `-g --offline` into a prefix of its own, from a cache
  holding only its two dependencies (`npm cache add` reads the public
  registry, unless `--cache <dir>` names a cache that holds them), and its
  `node_modules` holds those two only;
- the installed `telflo -V` prints the package's version and `--help`
  exits 0, with an empty environment but `PATH`.

`--keep <dir>` installs into `<dir>` (empty or new) and keeps it: the stack
smoke's `TELFLO_SMOKE_CLI` is then `<dir>/lib/node_modules/@telflo/cli/dist/index.js`.
It never publishes, logs in or writes to a registry. The full suite's
static gates run `cli-build` (`npm run build -w @telflo/cli`) and
`cli-package` (this check with `--keep`) after the web's build.

## The stack smoke

`scripts/smoke-test-stack.sh` drives the CLI through the gateway of a
running stack (`docs/conventions/testing.md`, "The smoke's CLI steps"). It
runs the CLI `TELFLO_SMOKE_CLI` names, by default the checkout's
`telflo-core/apps/cli/dist/index.js`, so build it first when running the
smoke by hand; the full suite names the package check's install. The smoke
fails at once when the CLI is missing or its `-V` fails.

## Installing a build by hand (the walkthrough)

Nothing is on npm yet: a person installs the tarball into a prefix of its
own, because the older Telflo CLI, `telflo` 0.1.2 on npm, installs a
`telflo` bin too:

```bash
mkdir -p /tmp/telflo-cli-pack
```

```bash
npm pack -w @telflo/cli --pack-destination /tmp/telflo-cli-pack
```

```bash
npm install -g --prefix /tmp/telflo-cli-install /tmp/telflo-cli-pack/telflo-cli-0.3.0.tgz
```

```bash
/tmp/telflo-cli-install/bin/telflo -V
```

## Releasing

Nothing is published yet: npm's `telflo` is still the older Telflo CLI
(0.1.2), which its users' `npm install -g telflo` gets, and that package
is maintained by one account (`anasmilhem`) only. **Each publish happens
only on the maintainers' explicit yes.** No agent runs `npm publish`,
`npm login`, `npm adduser`, `npm token`, `npm dist-tag` or any registry
write, and `"private": true` stays until the maintainers say otherwise.
The checklist, for a publish:

1. **The npm account** is settled: who publishes `telflo`
   (today's one maintainer is `anasmilhem`) and how the project holds it.
2. **The name:** the package becomes `telflo` (it is `@telflo/cli` only
   because the workspace root is `telflo`), `"private": true` removed, in
   a reviewed commit.
3. **The version:** bump `version` in `apps/cli/package.json` (npm never
   takes a version twice, even after an unpublish). `telflo -V` reads
   `package.json` at run time; `src/version.test.ts` checks the two agree
   and pins the number, so it changes with the bump.
4. **The default server:** `https://telflo.com` must answer the platform's
   `/api/public/v1/whoami`, and `/cli-auth` must be live there.
5. **The gates:** from a clean checkout of `main`, the cli project's tests
   with its coverage, typecheck, lint, the naming check, the license
   check, and `bash ../scripts/check-cli-package.sh`; the stack smoke with
   the tarball's install.
6. **The contents:** `npm pack --dry-run -w @telflo/cli` lists only
   `package.json`, `README.md`, `dist/**` and `skills/**`; the README and
   the skill describe this version's commands.
7. **The publish itself**, by a maintainer or on a maintainer's yes, from
   that checkout, after the dry run: one version, never pushed again (a
   fix is a new version). Then `npm view telflo` shows it.

The library export an MCP server would need is not in this package.
