# Contributing

Thanks for helping. Bug reports, fixes, docs and features are all welcome.

## Before you start

- **A bug or a question:** open an
  [issue](https://github.com/telflo/telflo/issues) with the release, how
  you run Telflo, and what you saw.
- **A security vulnerability:** don't open an issue; see
  [SECURITY.md](SECURITY.md).
- **A feature or a larger change:** open an issue first, so we can agree
  on the approach before you write it.

## Working on it

You need Node.js 22 or later and Docker.
[Running locally](docs/development.md#running-locally) shows how to start
the services, the API and the web app from a checkout, and the rest of
[docs/development.md](docs/development.md) covers the tests and the
repository's layout.

## Before you open a pull request

From `telflo-core/`:

```bash
npm run typecheck
npm run lint
npm test               # needs npm run dev:services
npm run check:naming
```

Run `npm run test:e2e` too when you change the web app. A change to a
service under `services/` runs that service's own tests (its README says
how).

- **Every change comes with its tests.** The test suite is how this
  project catches regressions, so a fix includes a test that fails without
  it.
- **Keep a pull request to one change**, and say in its description what
  it changes and why.
- **Pull requests go to `main`** and need CI to pass and a maintainer's
  review.

## License

Telflo is licensed under the [Apache License 2.0](LICENSE). By opening a
pull request you agree that your contribution is licensed under it too
(section 5 of the license). There's no CLA to sign.
