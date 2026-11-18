# Telflo's OpAMP supervisor: the All In One install bundle (linux ${ARCH})

All In One is the simplest way to start managing collectors with OpAMP: this
bundle downloads otelcol-contrib and the OpAMP supervisor itself, and is a
foundation you can grow into a larger setup as your needs grow.

## The files

- `start_supervisor.sh`: the installer and launcher
- `supervisor-config.yaml`: the supervisor's configuration (the launcher
  writes the fleet's token into it, readable by root only)
- `otelcol-config.yaml`: the collector's starting configuration, a no-op
  (nop to nop) that opens no port. The collector receives its real
  configuration, the group's published version, from the OpAMP server once
  it connects.
- `README.md`: this file

## The fleet's token (OPAMP_TOKEN)

The bundle holds no token. Before the first run, export the fleet's token
(Telflo's install dialog shows it, on "Set the token, then run"):

```sh
export OPAMP_TOKEN='Bearer <token>'
```

The script keeps the token in `opamp.env` beside the supervisor's state
(only root can read it), so later runs need no export. Run it again with a
new `OPAMP_TOKEN` to replace it (after the fleet's default token is revoked
and a new one issued, say). Treat `opamp.env` as a secret: keep it out of
backups, images and tickets.

## The collector's name (optional)

Each collector shows a name in Telflo's Fleet Management. To choose it, pass
`--OPAMP_SERVER_NAME='your-name'` to `start_supervisor.sh`, a literal or
your shell's expansion of a variable:

```sh
sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='prod-collector-east-1'
sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME="$MY_HOST_LABEL"
```

Without the flag, the host's name is used. The name is written on every run,
as typed (any text but a line break or another control character).

## Running it

1. Unpack the bundle into the root path chosen in the install dialog,
   `${ROOT_PATH}`:
   `sudo mkdir -p ${ROOT_PATH} && sudo tar -xzf <bundle>.tar.gz -C ${ROOT_PATH}`
2. `export OPAMP_TOKEN='Bearer <token>'`
3. `cd ${ROOT_PATH} && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh`
4. The collector appears in the fleet's Collectors tab, usually within a
   minute.

The script downloads otelcol-contrib and the OpAMP supervisor v${OTELCOL_VERSION}
(`linux_${ARCH}`), checks their sha256 and execs the supervisor, in the
foreground. Running it again is safe: when the installed collector reports
another version (or a binary is missing), both binaries are downloaded again,
together. A bundle downloaded after the group's published version changed
collector version upgrades the host; the same version changes nothing.

## One command, from an install link

On the Linux methods, Telflo's install dialog can instead make an install
link and give one command that downloads this bundle from it, unpacks it into
`${ROOT_PATH}` and starts the supervisor. The link needs no sign-in; it
expires (24 hours after it is made, unless extended) and can be extended or
revoked under Install links on the fleet's Tokens tab. The command holds the
fleet's token and the link: treat it as a secret, and run it in a secure
shell (it stays in the shell's history). It runs in a subshell, so the
token is exported only inside it; the link reaches curl on its standard
input, never on a command line; and a refused download (a revoked or
expired link, say) stops it there, with curl's error and a non-zero exit
status, before `opamp.env` or the unit is written or anything started.
curl tries the download again, up to three times, only when the server is
briefly busy (a 429 or 503, or a timeout; also a 408, 500, 502 or 504
reply), waiting as its `Retry-After` says; a refused connection isn't
retried. Its line is
`curl -q -g -fsS --retry 3 --proto '=https' -K -` (`--proto` only for an
`https` link), and a revoked, expired or unknown link is never tried again.
The command is for a POSIX-style shell (bash, sh, dash or zsh): run `bash`
first and paste it in that. Pasted into csh or tcsh, no line of it runs:
its first and last lines hold an unbalanced parenthesis, each command's
line between ends in `&&`, and the systemd unit's text lines fail on their
own ("No match.", "Command not found."; its blank lines do nothing), so
none of it runs; fish isn't
checked. Two variants, by the dialog's "Install as a
systemd service (starts on boot)":

- **As a systemd service** (the default): it writes the token into
  `${ROOT_PATH}/opamp.env` (root's, mode 600) and the unit
  `/etc/systemd/system/telflo-supervisor.service` (root's, mode 644), then
  reloads systemd, enables the service and restarts it: the collector
  starts now and on every boot.
- **In the foreground** (unticked): it runs `./start_supervisor.sh` in that
  shell, as "Running it" above does.

## The systemd service

`telflo-supervisor.service` runs `${ROOT_PATH}/start_supervisor.sh` as root,
from `${ROOT_PATH}` (`Type=simple`, `Restart=always`, `RestartSec=5`, after
`network-online.target`, wanted by `multi-user.target`), with the
collector's name on its `ExecStart=` when one was given in the dialog, so a
restart keeps it. Its environment holds no token: the script reads it from
`opamp.env`. To follow its log:

```sh
sudo journalctl -u telflo-supervisor -f
```

`sudo systemctl status telflo-supervisor` shows its state, and
`sudo systemctl restart telflo-supervisor` restarts it. Running an install
link's command again (a new link, after the fleet's default token is
revoked and a new one issued, say) replaces `opamp.env` and the unit and
restarts the service, so the new token takes effect at once. To remove the
service: `sudo systemctl disable --now telflo-supervisor`, then delete
`/etc/systemd/system/telflo-supervisor.service` and its settings
(`sudo rm -rf /etc/systemd/system/telflo-supervisor.service.d`, and
`sudo rm /etc/telflo-supervisor.env` if you made that file, below) and run
`sudo systemctl daemon-reload`.

### The service's environment variables

systemd starts the service with its own clean environment: a variable
exported in your shell never reaches it, so a configuration that reads one
with `${env:…}` fails to apply. Tick the variable in the install dialog (its
value is written into `start_supervisor.sh`, readable by root only), or give
it to the service:

```sh
sudo systemctl edit telflo-supervisor
```

and add, in the editor that opens, for a plain value:

```
[Service]
Environment="NGINX_ENV=prod"
```

(one `Environment=` line per variable, `NGINX_ENV` and `prod` its name and
value; a `%` in a value is written `%%`, since systemd reads `%` as the start
of one of its specifiers). Save, then
`sudo systemctl restart telflo-supervisor`. The script passes its
environment on to the collector. The setting is kept in
`/etc/systemd/system/telflo-supervisor.service.d/override.conf`, so running
an install link's command again (which replaces the unit) keeps it.

A secret doesn't go in an `Environment=` line: systemd shows those values to
every user on the host (`systemctl show telflo-supervisor -p Environment`
needs no `sudo`), and `override.conf` is readable by every user. Put it in a
file only root can read instead (the `install` line once, since it empties
an existing file; afterwards just `sudoedit` it):

```sh
sudo install -m 600 -o root -g root /dev/null /etc/telflo-supervisor.env
sudoedit /etc/telflo-supervisor.env
```

with one `NAME='value'` line per variable (`BACKEND_KEY='<the secret>'`: single
quotes keep a `\` or a leading space in it exactly, unless it holds a `'`), and
add, in `sudo systemctl edit telflo-supervisor`:

```
[Service]
EnvironmentFile=/etc/telflo-supervisor.env
```

Save, then `sudo systemctl restart telflo-supervisor`. systemd reads the file
as root when it starts the service and shows only its path, never its
values.

## opamp.env

One line, the fleet's token in the shell's single quotes (a `'` in it
written `'\''`), owned by root and readable by root only (mode 600):

```
OPAMP_TOKEN='Bearer <token>'
```

The script writes it whenever it runs with `OPAMP_TOKEN` set, and reads it
when `OPAMP_TOKEN` is unset, refusing a file not root's own or writable by
another user or group. An install link's command, as a systemd service,
writes it in the same format before the service starts.

## The root path after the first run

```
${ROOT_PATH}/start_supervisor.sh
${ROOT_PATH}/supervisor-config.yaml
${ROOT_PATH}/otelcol-config.yaml
${ROOT_PATH}/otelcol-contrib   (downloaded)
${ROOT_PATH}/supervisor        (downloaded)
${ROOT_PATH}/opamp/            (the supervisor's state)
${ROOT_PATH}/opamp.env         (the fleet's token, root only)
```

To use another root path, download the bundle again from the install dialog.
