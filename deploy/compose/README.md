# Telflo with Docker Compose

This folder runs Telflo on one machine with Docker Compose: the same images,
settings and defaults as the Helm chart.

- **Trying it:** follow the Quick start in Telflo's README,
  <https://github.com/telflo/telflo#quick-start>.
- **Running it for real** (TLS in front, a real mail relay, upgrades,
  backups): <https://github.com/telflo/telflo/blob/main/docs/compose.md>.
- **Every setting:** <https://github.com/telflo/telflo/blob/main/docs/configuration.md>.

In short:

```sh
./setup.sh --help                 # the options
./setup.sh --public-url <origin> --agent-url <origin> --mailpit
docker compose up -d
docker compose exec -T api telflo-admin bootstrap --email <you> --organization "<name>"
```

`setup.sh` runs once. It writes `.env` and `secrets/`, which hold every
secret of the install: keep them out of any repository and back them up
together. It refuses to run again over them.

## Moving from Mailpit to a real mail relay

Mailpit (`setup.sh --mailpit`) is for trying Telflo only: it keeps every
message in an inbox on this machine instead of delivering it. To send real
mail:

1. Stop and remove Mailpit, while `.env` still names its profile:

   ```sh
   docker compose stop mailpit && docker compose rm -f mailpit
   ```

2. Edit `.env`: set `COMPOSE_PROFILES=` (empty), remove
   `TELFLO_MAILPIT_PORT`, and set the mail lines to your relay's:
   `TELFLO_MAIL_FROM`, `TELFLO_SMTP_HOST`, `TELFLO_SMTP_PORT`,
   `TELFLO_SMTP_TLS` (`starttls`, `implicit` or `none`),
   `TELFLO_SMTP_ALLOW_INSECURE=false`, and, for a relay that needs a login,
   `TELFLO_SMTP_USERNAME` and `TELFLO_SMTP_PASSWORD`. A value holding a
   space or a `#` goes in single quotes.

3. Start again, so the API reads the new settings:

   ```sh
   docker compose up -d
   ```
