import type { ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { FormScope, TextareaField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The basic auth extension's form, over the form's fields: each field
 * writes its own key, and clearing one removes it. Collector claims cite
 * contrib v0.162.0, `extension/basicauthextension`.
 *
 * An instance runs in one mode: client (`client_auth`, the username and
 * password an exporter sends) or server (`htpasswd`, the entries a receiver
 * checks requests against). The collector refuses both blocks together and
 * neither (`config.go:50-63`; an explicit null is neither, as unset). The
 * Mode select is read from the text, never held: unset shows Client, and
 * the client fields write `client_auth` as they are typed. Choosing a mode
 * removes the other block and writes `{}` for the chosen one when the text
 * has none, in one change, with a toast when a block was removed. A text
 * holding both shows the fail alert and the select empty, so either choice
 * resolves it.
 *
 * The warnings:
 * - client: a missing username or password (Start resolves only the values
 *   given, and an unresolved one is sent as `""`, `extension.go:103-160`);
 *   a value beside its `*_file` twin (the file wins,
 *   `credentialsfile.NewValueResolver`);
 * - server: neither a file nor inline entries. `validate` accepts
 *   `htpasswd: {}`, but the extension isn't created ("no credential source
 *   provided", `extension.go:37-40`), so the collector doesn't start.
 *
 * `username_file` and `password_file` are in every offered version's
 * `ClientAuthSettings` (v0.159.0 to v0.162.0).
 */

type Mode = "client" | "server";

const MODES: readonly { value: Mode; label: string; block: string }[] = [
  { value: "client", label: "Client (client_auth)", block: "client_auth" },
  { value: "server", label: "Server (htpasswd)", block: "htpasswd" },
];

/** The toast for a mode's block removed by the switch. */
export function removedModeMessage(block: string): string {
  return `Removed ${block}: the collector takes one mode per instance. Undo to restore it.`;
}

/** Whether the text holds a truthy value. */
function truthy(view: ValueView): boolean {
  return view.kind !== "absent" && Boolean(view.value);
}

export function BasicAuthExtensionForm() {
  const form = useForm();
  const adjustments = useAdjustments();
  const present = MODES.filter((mode) => form.read([mode.block]).kind !== "absent");
  const conflict = present.length > 1;
  const mode: Mode = present.length === 1 ? present[0]!.value : "client";

  const choose = (next: Mode) => {
    const removed = present.filter((other) => other.value !== next);
    const changes: ValueChange[] = removed.map((other) => ({ path: [other.block], remove: true }));
    const chosen = MODES.find((candidate) => candidate.value === next)!;
    if (!present.includes(chosen)) changes.push({ path: [chosen.block], value: {} });
    const result = form.apply(changes);
    if (removed.length > 0) adjustments.note(removed.map((other) => removedModeMessage(other.block)), result);
  };

  return (
    <div className="space-y-4">
      <ConfigField
        label="Mode"
        htmlFor="basicauth-mode"
        description="Client attaches credentials to an exporter's requests; server checks a receiver's incoming requests. One mode per instance."
      >
        <Select
          // Empty while both blocks are set: the placeholder shows, and either choice is a change.
          value={conflict ? "" : mode}
          onValueChange={(value) => choose(value as Mode)}
          disabled={form.disabled}
        >
          <SelectTrigger id="basicauth-mode">
            <SelectValue placeholder="Choose one mode to keep" />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ConfigField>

      {conflict && (
        <InlineAlert variant="fail">
          Both client_auth and htpasswd are set — the collector rejects this. Choose a mode to keep; the other block is
          removed.
        </InlineAlert>
      )}

      {present.length === 0 && (
        <InlineAlert variant="warn">
          Set a username and password (client) or htpasswd entries (server) — the extension fails collector validation
          without one.
        </InlineAlert>
      )}

      {(conflict || mode === "client") && (
        <Block path={["client_auth"]}>
          <ClientFields />
        </Block>
      )}

      {(conflict || mode === "server") && (
        <Block path={["htpasswd"]}>
          <ServerFields />
        </Block>
      )}

      <p className="text-[11px] leading-4 text-muted-foreground">
        Reference this extension from a receiver or exporter via auth.authenticator. Basic auth only base64-encodes
        credentials, so use TLS on the connection.
      </p>
    </div>
  );
}

/**
 * The fields under a block that may be absent, null or a mapping: they read
 * and write under it (a write makes it a mapping); anything else (a list, a
 * scalar) is read-only with `UNSHOWABLE_VALUE_MESSAGE`.
 */
function Block({ path, children }: { path: ValuePath; children: ReactNode }) {
  const form = useForm();
  const view = form.read(path);
  if (view.kind !== "absent" && view.kind !== "map") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  return <FormScope path={path}>{children}</FormScope>;
}

/** Client mode's fields, under `client_auth`. */
function ClientFields() {
  const form = useForm();
  const username = form.read(["username"]);
  const usernameFile = form.read(["username_file"]);
  const password = form.read(["password"]);
  const passwordFile = form.read(["password_file"]);
  const hasFile = truthy(usernameFile) || truthy(passwordFile);
  const shadowed = [
    truthy(username) && truthy(usernameFile) ? "username" : null,
    truthy(password) && truthy(passwordFile) ? "password" : null,
  ].filter((name) => name !== null);

  return (
    <>
      <TextField
        path={["username"]}
        id="basicauth-username"
        label="Username"
        description="Prefer an ${env:VAR} reference over a literal value."
        placeholder="e.g. ${env:BASIC_AUTH_USERNAME}"
      />

      <TextField
        path={["password"]}
        id="basicauth-password"
        label="Password"
        description="Prefer an ${env:VAR} reference over a literal value."
        placeholder="e.g. ${env:BASIC_AUTH_PASSWORD}"
      />

      {(!(truthy(username) || truthy(usernameFile)) || !(truthy(password) || truthy(passwordFile))) && (
        <InlineAlert variant="warn">
          Set both a username and a password (or their files) — a missing value is sent as an empty string.
        </InlineAlert>
      )}

      <ConfigSection title="Credentials from Files" defaultOpen={hasFile}>
        <p className="text-[11px] leading-4 text-muted-foreground">
          A file wins over the matching value above and is watched for changes, so credentials rotate without a
          restart.
        </p>

        <TextField
          path={["username_file"]}
          id="basicauth-username-file"
          label="Username File"
          placeholder="e.g. /etc/secrets/username"
        />

        <TextField
          path={["password_file"]}
          id="basicauth-password-file"
          label="Password File"
          placeholder="e.g. /etc/secrets/password"
        />
      </ConfigSection>

      {shadowed.length > 0 && (
        <InlineAlert variant="warn">
          Both a value and a file are set for the {shadowed.join(" and ")} — the collector uses the file and ignores the
          value.
        </InlineAlert>
      )}
    </>
  );
}

/** Server mode's fields, under `htpasswd`. */
function ServerFields() {
  const form = useForm();
  const empty = !truthy(form.read(["file"])) && !truthy(form.read(["inline"]));

  return (
    <>
      <TextField
        path={["file"]}
        id="basicauth-htpasswd-file"
        label="htpasswd File"
        description="Path to an htpasswd file on the collector host."
        placeholder="e.g. /etc/otelcol/.htpasswd"
      />

      <TextareaField
        path={["inline"]}
        id="basicauth-htpasswd-inline"
        label="Inline Entries"
        description="One user:password line per user, plain or hashed (bcrypt, SHA, MD5). Read after the file, so an inline line overrides the file's entry for the same user."
        placeholder="e.g. ${env:BASIC_AUTH_USERNAME}:${env:BASIC_AUTH_PASSWORD}"
        className="font-mono text-xs"
        rows={3}
      />

      {empty && (
        <InlineAlert variant="warn">
          Add an htpasswd file or inline entries — with neither, the extension isn't created and the collector doesn't
          start.
        </InlineAlert>
      )}
    </>
  );
}
