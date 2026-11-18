import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { BearerTokenAuthExtensionForm } from "./BearerTokenAuthExtensionForm.js";
import { FileStorageExtensionForm } from "./FileStorageExtensionForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { OIDCAuthExtensionForm } from "./OIDCAuthExtensionForm.js";
import { OpAMPExtensionForm } from "./OpAMPExtensionForm.js";
import { formFor } from "./registry.js";
import { ConfigurationPanel } from "../ConfigurationPanel.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { CANT_EDIT_ON_CANVAS_MESSAGE, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The extension forms (D9b Task 8): file_storage, OpAMP, bearertokenauth
 * and OIDC, their forms over key paths. Each field is driven as a
 * person would (typing, clicking, picking) and writes only its key: the
 * text changes in that key's lines only, on a text with comments, an
 * anchor and a merge, `0750`, and CRLF line endings (decision 2). OpAMP's
 * transport switch renames the block in place, keeping `tls`, headers,
 * auth and comments, and removes `polling_interval` only going to ws
 * (decision 4). The OpAMP (4) and auth extension (8) cases close the
 * file.
 */

const EXTENSIONS = [
  "# The extension forms (D9b Task 8).",
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "exporters:",
  "  debug: {}",
  "extensions:",
  "  file_storage: # the storage",
  "    directory: /var/lib/otelcol/file_storage # where",
  "    timeout: 1s",
  "    create_directory: true",
  '    directory_permissions: "0750" # octal to the collector, from a string',
  "    compaction:",
  "      on_start: true # compact",
  // A bare `0750` (an int64 to the collector, filestorage config.go at contrib v0.162.0), which no write may reprint.
  "      rebound_needed_threshold_mib: 0750",
  "      check_interval: 5s",
  "  file_storage/base: &storage",
  "    directory: /var/lib/shared",
  "    fsync: true",
  "  file_storage/merged:",
  "    <<: *storage # the shared storage",
  "    timeout: 2s",
  "  opamp:",
  "    server:",
  "      ws: # the websocket",
  "        endpoint: wss://opamp.example.com:4320/v1/opamp # the server",
  "        tls:",
  "          insecure_skip_verify: true # lab only",
  "          ca_file: /etc/ca.pem",
  "        headers:",
  "          X-Tenant: acme # tenant",
  "        auth: bearertokenauth",
  "    instance_uid: 01890a5d-ac96-774b-b103-c34d6b3f1234",
  "    capabilities:",
  "      accepts_restart_command: true # remote restarts",
  "  opamp/polling:",
  "    server:",
  "      http:",
  "        endpoint: https://opamp.example.com/v1/opamp",
  "        polling_interval: 1m # slower",
  "        tls:",
  "          insecure: true",
  "        headers: {X-Tenant: acme}",
  "  bearertokenauth:",
  "    token: ${env:TOKEN} # the token",
  "    tokens:",
  "      - ${env:A} # first",
  "      - ${env:B}",
  "    scheme: Bearer",
  "    header: Authorization",
  "    filename: /etc/tokens",
  "  bearertokenauth/bare:",
  '    scheme: "" # bare token',
  "    tokens:",
  "      - ${env:OTLP_AUTH_TOKEN}",
  "  oidc:",
  "    attribute: authorization # the header",
  "    providers:",
  "      # the main idp",
  "      - issuer_url: https://idp.example.com # main",
  "        audience: collector",
  "        username_claim: email",
  "      - issuer_url: https://other.example.com",
  "        ignore_audience: true",
  "  oidc/legacy:",
  "    issuer_url: ${env:OIDC_ISSUER_URL} # deprecated",
  "    audience: ${env:OIDC_AUDIENCE}",
  "service:",
  "  extensions: [file_storage, opamp, bearertokenauth, oidc]",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(key: string, form: ReactNode, text = EXTENSIONS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{form}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const box = (name: string) => screen.getByRole("checkbox", { name });
/** A hint line, by its whole text ("… · Default 1s" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
/** An input showing `value`. */
const input = (value: string) => [...document.querySelectorAll("input")].find((i) => i.value === value);

/** The component `key`'s value, as the collector's YAML reads it. */
function valueOf(written: string, key: string): Record<string, unknown> {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Record<string, unknown>>>)[section]![name]!;
}

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, element: HTMLElement, typed: string) {
  await user.clear(element);
  if (typed !== "") await user.type(element, typed.replace(/[{[]/g, "$&$&"));
  await user.tab();
}

async function pick(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}( \\d+)?$`) }));
}

const FILE_STORAGE = "extensions.file_storage";
const OPAMP = "extensions.opamp";
const POLLING = "extensions.opamp/polling";
const BEARER = "extensions.bearertokenauth";
const BARE = "extensions.bearertokenauth/bare";
const OIDC = "extensions.oidc";
const LEGACY = "extensions.oidc/legacy";

const fileStorage = <FileStorageExtensionForm />;
const opamp = <OpAMPExtensionForm />;
const bearer = <BearerTokenAuthExtensionForm />;
const oidc = <OIDCAuthExtensionForm />;

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  form: ReactNode;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Record<string, unknown>) => void;
}

type Map = Record<string, unknown>;
const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, segment) => (v as Record<string | number, unknown> | undefined)?.[segment], value);

const CASES: FieldCase[] = [
  // file_storage
  {
    name: "file_storage Directory",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: (user) => retypeInto(user, byId("file-storage-directory"), "/data/storage"),
    from: "    directory: /var/lib/otelcol/file_storage # where\n",
    to: "    directory: /data/storage # where\n",
    check: (v) => expect(v.directory).toBe("/data/storage"),
  },
  {
    name: "file_storage Directory cleared removes the key",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: (user) => retypeInto(user, byId("file-storage-directory"), ""),
    from: "    directory: /var/lib/otelcol/file_storage # where\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("directory"),
  },
  {
    name: "file_storage Timeout",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: (user) => retypeInto(user, byId("file-storage-timeout"), "1m30s"),
    from: "    timeout: 1s\n",
    to: "    timeout: 1m30s\n",
    check: (v) => expect(v.timeout).toBe("1m30s"),
  },
  {
    name: "file_storage Create Directory unticked",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: (user) => user.click(box("Create Directory")),
    from: "    create_directory: true\n",
    to: "    create_directory: false\n",
    check: (v) => expect(v.create_directory).toBe(false),
  },
  {
    name: "file_storage Compaction Directory, added to the block",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await retypeInto(user, byId("file-storage-compaction-directory"), "/scratch");
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n      directory: /scratch\n",
    check: (v) => expect(at(v, "compaction", "directory")).toBe("/scratch"),
  },
  {
    name: "file_storage Compact On Start unticked",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await user.click(box("Compact On Start"));
    },
    from: "      on_start: true # compact\n",
    to: "      on_start: false # compact\n",
    check: (v) => expect(at(v, "compaction", "on_start")).toBe(false),
  },
  {
    name: "file_storage Compact On Rebound ticked",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await user.click(box("Compact On Rebound"));
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n      on_rebound: true\n",
    check: (v) => expect(at(v, "compaction", "on_rebound")).toBe(true),
  },
  {
    name: "file_storage Rebound Needed Threshold set to 0",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await retypeInto(user, byId("file-storage-rebound-needed"), "0");
    },
    from: "      rebound_needed_threshold_mib: 0750\n",
    to: "      rebound_needed_threshold_mib: 0\n",
    check: (v) => expect(at(v, "compaction", "rebound_needed_threshold_mib")).toBe(0),
  },
  {
    name: "file_storage Rebound Trigger Threshold",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await retypeInto(user, byId("file-storage-rebound-trigger"), "20");
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n      rebound_trigger_threshold_mib: 20\n",
    check: (v) => expect(at(v, "compaction", "rebound_trigger_threshold_mib")).toBe(20),
  },
  {
    name: "file_storage Check Interval",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await retypeInto(user, byId("file-storage-check-interval"), "10s");
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 10s\n",
    check: (v) => expect(at(v, "compaction", "check_interval")).toBe("10s"),
  },
  {
    name: "file_storage Max Transaction Size, a reference",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await retypeInto(user, byId("file-storage-max-transaction"), "${env:MAX_TX}");
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n      max_transaction_size: ${env:MAX_TX}\n",
    check: (v) => expect(at(v, "compaction", "max_transaction_size")).toBe("${env:MAX_TX}"),
  },
  {
    name: "file_storage Cleanup On Start ticked",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Compaction");
      await user.click(box("Cleanup On Start"));
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n      cleanup_on_start: true\n",
    check: (v) => expect(at(v, "compaction", "cleanup_on_start")).toBe(true),
  },
  {
    name: "file_storage Fsync ticked",
    key: FILE_STORAGE,
    form: fileStorage,
    edit: async (user) => {
      await openSection(user, "Advanced: Durability");
      await user.click(box("Fsync"));
    },
    from: "      check_interval: 5s\n",
    to: "      check_interval: 5s\n    fsync: true\n",
    check: (v) => expect(v.fsync).toBe(true),
  },
  // opamp
  {
    name: "opamp Server Endpoint",
    key: OPAMP,
    form: opamp,
    edit: (user) => retypeInto(user, byId("opamp-endpoint"), "wss://other:4320/v1/opamp"),
    from: "        endpoint: wss://opamp.example.com:4320/v1/opamp # the server\n",
    to: "        endpoint: wss://other:4320/v1/opamp # the server\n",
    check: (v) => expect(at(v, "server", "ws", "endpoint")).toBe("wss://other:4320/v1/opamp"),
  },
  {
    name: "opamp Auth Extension",
    key: OPAMP,
    form: opamp,
    edit: (user) => retypeInto(user, byId("opamp-auth"), "oauth2client"),
    from: "        auth: bearertokenauth\n",
    to: "        auth: oauth2client\n",
    check: (v) => expect(at(v, "server", "ws", "auth")).toBe("oauth2client"),
  },
  {
    name: "opamp a header's value",
    key: OPAMP,
    form: opamp,
    edit: async (user) => {
      await openSection(user, "Headers");
      await retypeInto(user, screen.getAllByPlaceholderText("Header value")[0]!, "globex");
    },
    from: "          X-Tenant: acme # tenant\n",
    to: "          X-Tenant: globex # tenant\n",
    check: (v) => expect(at(v, "server", "ws", "headers")).toEqual({ "X-Tenant": "globex" }),
  },
  {
    name: "opamp a header added",
    key: OPAMP,
    form: opamp,
    edit: async (user) => {
      await openSection(user, "Headers");
      await user.type(screen.getByPlaceholderText("e.g. Authorization"), "X-Region");
      await user.type(screen.getByPlaceholderText("e.g. Bearer token"), "eu{Enter}");
    },
    from: "          X-Tenant: acme # tenant\n",
    to: "          X-Tenant: acme # tenant\n          X-Region: eu\n",
    check: (v) => expect(at(v, "server", "ws", "headers")).toEqual({ "X-Tenant": "acme", "X-Region": "eu" }),
  },
  {
    name: "opamp Instance UID",
    key: OPAMP,
    form: opamp,
    edit: async (user) => {
      await openSection(user, "Identity");
      await retypeInto(user, byId("opamp-instance-uid"), "01890a5d-ac96-774b-b103-c34d6b3f9999");
    },
    from: "    instance_uid: 01890a5d-ac96-774b-b103-c34d6b3f1234\n",
    to: "    instance_uid: 01890a5d-ac96-774b-b103-c34d6b3f9999\n",
    check: (v) => expect(v.instance_uid).toBe("01890a5d-ac96-774b-b103-c34d6b3f9999"),
  },
  {
    name: "opamp restart commands back to the default removes capabilities with its last key",
    key: OPAMP,
    form: opamp,
    edit: (user) => user.click(box("Accept restart commands (SIGHUP; feature-gated, no Windows support)")),
    from: "    capabilities:\n      accepts_restart_command: true # remote restarts\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("capabilities"),
  },
  {
    name: "opamp report health turned off is written as a deviation",
    key: OPAMP,
    form: opamp,
    edit: (user) => user.click(box("Report health to the server (collector default)")),
    from: "      accepts_restart_command: true # remote restarts\n",
    to: "      accepts_restart_command: true # remote restarts\n      reports_health: false\n",
    check: (v) => expect(v.capabilities).toEqual({ accepts_restart_command: true, reports_health: false }),
  },
  {
    name: "opamp Polling Interval",
    key: POLLING,
    form: opamp,
    edit: (user) => retypeInto(user, byId("opamp-polling-interval"), "1m30s"),
    from: "        polling_interval: 1m # slower\n",
    to: "        polling_interval: 1m30s # slower\n",
    check: (v) => expect(at(v, "server", "http", "polling_interval")).toBe("1m30s"),
  },
  {
    name: "opamp transport ws -> http renames the block in place",
    key: OPAMP,
    form: opamp,
    edit: (user) => pick(user, byId("opamp-transport"), "HTTP (polling)"),
    from: "      ws: # the websocket\n",
    to: "      http: # the websocket\n",
    check: (v) =>
      expect(v.server).toEqual({
        http: {
          endpoint: "wss://opamp.example.com:4320/v1/opamp",
          tls: { insecure_skip_verify: true, ca_file: "/etc/ca.pem" },
          headers: { "X-Tenant": "acme" },
          auth: "bearertokenauth",
        },
      }),
  },
  {
    name: "opamp transport http -> ws renames the block and removes polling_interval",
    key: POLLING,
    form: opamp,
    edit: (user) => pick(user, byId("opamp-transport"), "WebSocket"),
    from: "      http:\n        endpoint: https://opamp.example.com/v1/opamp\n        polling_interval: 1m # slower\n",
    to: "      ws:\n        endpoint: https://opamp.example.com/v1/opamp\n",
    check: (v) =>
      expect(v.server).toEqual({
        ws: { endpoint: "https://opamp.example.com/v1/opamp", tls: { insecure: true }, headers: { "X-Tenant": "acme" } },
      }),
  },
  // bearertokenauth
  {
    name: "bearertokenauth Token",
    key: BEARER,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-token"), "${env:OTHER}"),
    from: "    token: ${env:TOKEN} # the token\n",
    to: "    token: ${env:OTHER} # the token\n",
    check: (v) => expect(v.token).toBe("${env:OTHER}"),
  },
  {
    name: "bearertokenauth Token cleared removes the key",
    key: BEARER,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-token"), ""),
    from: "    token: ${env:TOKEN} # the token\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("token"),
  },
  {
    name: "bearertokenauth Tokens: one added",
    key: BEARER,
    form: bearer,
    edit: async (user) => {
      const staging = screen.getAllByPlaceholderText("e.g. ${env:OTLP_AUTH_TOKEN}")[1]!;
      await user.type(staging, "${{env:C}{Enter}");
    },
    from: "      - ${env:B}\n",
    to: "      - ${env:B}\n      - ${env:C}\n",
    check: (v) => expect(v.tokens).toEqual(["${env:A}", "${env:B}", "${env:C}"]),
  },
  {
    name: "bearertokenauth Tokens: one removed, by its lines",
    key: BEARER,
    form: bearer,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove" })[0]!),
    from: "      - ${env:A} # first\n",
    to: "",
    check: (v) => expect(v.tokens).toEqual(["${env:B}"]),
  },
  {
    name: "bearertokenauth Tokens: the last removed takes tokens with it",
    key: BARE,
    form: bearer,
    edit: (user) => user.click(screen.getByRole("button", { name: "Remove" })),
    from: "    tokens:\n      - ${env:OTLP_AUTH_TOKEN}\n",
    to: "",
    check: (v) => expect(v).toEqual({ scheme: "" }),
  },
  {
    name: "bearertokenauth Token File",
    key: BEARER,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-filename"), "/etc/otelcol/tokens"),
    from: "    filename: /etc/tokens\n",
    to: "    filename: /etc/otelcol/tokens\n",
    check: (v) => expect(v.filename).toBe("/etc/otelcol/tokens"),
  },
  {
    name: "bearertokenauth Scheme cleared keeps an empty scheme (the bare token)",
    key: BEARER,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-scheme"), ""),
    from: "    scheme: Bearer\n",
    to: '    scheme: ""\n',
    check: (v) => expect(v.scheme).toBe(""),
  },
  {
    name: "bearertokenauth Scheme typed over an empty one",
    key: BARE,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-scheme"), "Token"),
    from: '    scheme: "" # bare token\n',
    to: '    scheme: "Token" # bare token\n',
    check: (v) => expect(v.scheme).toBe("Token"),
  },
  {
    name: "bearertokenauth Header",
    key: BEARER,
    form: bearer,
    edit: (user) => retypeInto(user, byId("bearertokenauth-header"), "X-Auth"),
    from: "    header: Authorization\n",
    to: "    header: X-Auth\n",
    check: (v) => expect(v.header).toBe("X-Auth"),
  },
  // oidc
  {
    name: "oidc Auth Attribute",
    key: OIDC,
    form: oidc,
    edit: (user) => retypeInto(user, byId("oidc-attribute"), "x-token"),
    from: "    attribute: authorization # the header\n",
    to: "    attribute: x-token # the header\n",
    check: (v) => expect(v.attribute).toBe("x-token"),
  },
  {
    name: "oidc a provider's Issuer URL",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await retypeInto(user, byId("oidc-0-issuer"), "https://login.example.com");
    },
    from: "      - issuer_url: https://idp.example.com # main\n",
    to: "      - issuer_url: https://login.example.com # main\n",
    check: (v) => expect(at(v, "providers", 0, "issuer_url")).toBe("https://login.example.com"),
  },
  {
    name: "oidc a provider's Issuer URL cleared writes an empty value",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await retypeInto(user, byId("oidc-0-issuer"), "");
    },
    from: "      - issuer_url: https://idp.example.com # main\n",
    to: '      - issuer_url: "" # main\n',
    check: (v) => expect(at(v, "providers", 0, "issuer_url")).toBe(""),
  },
  {
    name: "oidc a provider's Audience",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await retypeInto(user, byId("oidc-0-audience"), "gateway");
    },
    from: "        audience: collector\n",
    to: "        audience: gateway\n",
    check: (v) => expect(at(v, "providers", 0, "audience")).toBe("gateway"),
  },
  {
    name: "oidc a provider's audience check skipped",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await user.click(byId("oidc-0-ignore-audience"));
    },
    from: "        username_claim: email\n",
    to: "        username_claim: email\n        ignore_audience: true\n",
    check: (v) => expect(at(v, "providers", 0, "ignore_audience")).toBe(true),
  },
  {
    name: "oidc a provider's skip unticked removes ignore_audience",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://other.example.com"));
      await user.click(byId("oidc-1-ignore-audience"));
    },
    from: "        ignore_audience: true\n",
    to: "",
    check: (v) => expect(at(v, "providers", 1)).toEqual({ issuer_url: "https://other.example.com" }),
  },
  {
    name: "oidc a provider's Username Claim",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await retypeInto(user, byId("oidc-0-username-claim"), "preferred_username");
    },
    from: "        username_claim: email\n",
    to: "        username_claim: preferred_username\n",
    check: (v) => expect(at(v, "providers", 0, "username_claim")).toBe("preferred_username"),
  },
  {
    name: "oidc a provider's Groups Claim",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://idp.example.com"));
      await retypeInto(user, byId("oidc-0-groups-claim"), "groups");
    },
    from: "        username_claim: email\n",
    to: "        username_claim: email\n        groups_claim: groups\n",
    check: (v) => expect(at(v, "providers", 0, "groups_claim")).toBe("groups"),
  },
  {
    name: "oidc a provider's Issuer CA Path",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://other.example.com"));
      await retypeInto(user, byId("oidc-1-ca-path"), "/etc/pki/ca.pem");
    },
    from: "        ignore_audience: true\n",
    to: "        ignore_audience: true\n        issuer_ca_path: /etc/pki/ca.pem\n",
    check: (v) => expect(at(v, "providers", 1, "issuer_ca_path")).toBe("/etc/pki/ca.pem"),
  },
  {
    name: "oidc a provider's Public Keys File",
    key: OIDC,
    form: oidc,
    edit: async (user) => {
      await user.click(screen.getByText("https://other.example.com"));
      await retypeInto(user, byId("oidc-1-keys-file"), "/etc/otelcol/jwks.json");
    },
    from: "        ignore_audience: true\n",
    to: "        ignore_audience: true\n        public_keys_file: /etc/otelcol/jwks.json\n",
    check: (v) => expect(at(v, "providers", 1, "public_keys_file")).toBe("/etc/otelcol/jwks.json"),
  },
  {
    name: "oidc Add Provider appends an empty provider",
    key: OIDC,
    form: oidc,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Provider" })),
    from: "        ignore_audience: true\n",
    to: "        ignore_audience: true\n      - {}\n",
    check: (v) => expect((v.providers as Map[])[2]).toEqual({}),
  },
  {
    name: "oidc a provider removed, by its lines",
    key: OIDC,
    form: oidc,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove provider" })[1]!),
    from: "      - issuer_url: https://other.example.com\n        ignore_audience: true\n",
    to: "",
    check: (v) => expect(v.providers).toHaveLength(1),
  },
];

describe("every field of each form writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(EXTENSIONS) : EXTENSIONS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, c.form, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(text(), c.key));
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("a merged component's field copies the merge first; the anchor and its owner don't change", async () => {
    const user = renderForm("extensions.file_storage/merged", fileStorage);
    // The merged keys show as the text holds them.
    expect(byId("file-storage-directory")).toHaveValue("/var/lib/shared");
    expect(box("Create Directory")).toHaveAttribute("data-state", "unchecked");

    await retypeInto(user, byId("file-storage-directory"), "/var/lib/mine");

    expect(valueOf(text(), "extensions.file_storage/merged")).toEqual({ directory: "/var/lib/mine", fsync: true, timeout: "2s" });
    expect(valueOf(text(), "extensions.file_storage/base")).toEqual({ directory: "/var/lib/shared", fsync: true });
    expect(text()).toContain("  file_storage/base: &storage\n    directory: /var/lib/shared\n    fsync: true\n");
    expect(entries()).toBe(1);
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(OPAMP, opamp);
    await pick(user, byId("opamp-transport"), "HTTP (polling)");
    expect(selectUndoDescription(builderStore())).toBe("Update OpAMP");
    expect(entries()).toBe(1);
  });

  it("opening each form, its sections and cards, writes nothing", async () => {
    for (const [key, form] of [
      [FILE_STORAGE, <FileStorageExtensionForm key="f" />],
      [OPAMP, <OpAMPExtensionForm key="o" />],
      [POLLING, <OpAMPExtensionForm key="p" />],
      [BEARER, <BearerTokenAuthExtensionForm key="b" />],
      [BARE, <BearerTokenAuthExtensionForm key="bb" />],
      [OIDC, <OIDCAuthExtensionForm key="i" />],
      [LEGACY, <OIDCAuthExtensionForm key="l" />],
    ] as const) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const header of screen.queryAllByText(/^https:\/\//)) await user.click(header);
      for (const element of screen.queryAllByRole("textbox")) {
        await user.click(element);
        await user.tab();
      }
      expect(text()).toBe(EXTENSIONS);
      expect(entries()).toBe(0);
    }
  });
});

describe("OpAMP's transport switch moves the block's keys across (decision 4)", () => {
  it("ws -> http keeps tls, headers, auth, the endpoint and their comments; the fields then write under http", async () => {
    const user = renderForm(OPAMP, opamp);
    expect(screen.queryByText("Polling Interval")).toBeNull();

    await pick(user, byId("opamp-transport"), "HTTP (polling)");

    expect(text()).toBe(EXTENSIONS.replace("      ws: # the websocket\n", "      http: # the websocket\n"));
    expect(text()).toContain("        tls:\n          insecure_skip_verify: true # lab only\n          ca_file: /etc/ca.pem\n");
    expect(text()).toContain("        headers:\n          X-Tenant: acme # tenant\n");
    expect(screen.getByRole("combobox", { name: "Transport" })).toHaveTextContent("HTTP (polling)");
    expect(byId("opamp-endpoint")).toHaveValue("wss://opamp.example.com:4320/v1/opamp");
    expect(byId("opamp-polling-interval")).toHaveValue("");
    expect(byId("opamp-polling-interval")).toHaveAttribute("placeholder", "30s");

    await retypeInto(user, byId("opamp-polling-interval"), "45s");
    expect(valueOf(text(), OPAMP).server).toMatchObject({ http: { polling_interval: "45s", auth: "bearertokenauth" } });
  });

  it("http -> ws removes polling_interval only; tls and headers stay", async () => {
    const user = renderForm(POLLING, opamp);
    await pick(user, byId("opamp-transport"), "WebSocket");
    const server = valueOf(text(), POLLING).server as Map;
    expect(server).toEqual({
      ws: { endpoint: "https://opamp.example.com/v1/opamp", tls: { insecure: true }, headers: { "X-Tenant": "acme" } },
    });
    expect(screen.queryByText("Polling Interval")).toBeNull();
  });

  it("a polling_interval a ws block held is kept going to http, where it applies", async () => {
    const held = EXTENSIONS.replace("        auth: bearertokenauth\n", "        auth: bearertokenauth\n        polling_interval: 10s # for http\n");
    const user = renderForm(OPAMP, opamp, held);
    await pick(user, byId("opamp-transport"), "HTTP (polling)");
    expect(text()).toBe(held.replace("      ws: # the websocket\n", "      http: # the websocket\n"));
    expect(byId("opamp-polling-interval")).toHaveValue("10s");
  });

  it("switching there and back leaves the ws block as it was, but for the polling interval it never had", async () => {
    const user = renderForm(OPAMP, opamp);
    await pick(user, byId("opamp-transport"), "HTTP (polling)");
    await pick(user, byId("opamp-transport"), "WebSocket");
    expect(text()).toBe(EXTENSIONS);
    expect(entries()).toBe(1);
  });

  it("with no server block, the endpoint is written under ws, and switching to http writes an http block", async () => {
    const bare = EXTENSIONS.replace("  opamp/polling:\n", "  opamp/empty: {}\n  opamp/polling:\n");
    const user = renderForm("extensions.opamp/empty", opamp, bare);
    expect(screen.getByRole("combobox", { name: "Transport" })).toHaveTextContent("WebSocket");

    await pick(user, byId("opamp-transport"), "HTTP (polling)");
    expect(valueOf(text(), "extensions.opamp/empty")).toEqual({ server: { http: {} } });

    await retypeInto(user, byId("opamp-endpoint"), "https://opamp:4320/v1/opamp");
    expect(valueOf(text(), "extensions.opamp/empty")).toEqual({ server: { http: { endpoint: "https://opamp:4320/v1/opamp" } } });
  });

  it("a text holding both transports shows http; switching to ws is refused (the names clash), with D9a's toast", async () => {
    const both = EXTENSIONS.replace("  opamp/polling:\n    server:\n", "  opamp/polling:\n    server:\n      ws: {endpoint: wss://x}\n");
    const user = renderForm(POLLING, opamp, both);
    expect(screen.getByRole("combobox", { name: "Transport" })).toHaveTextContent("HTTP (polling)");

    await pick(user, byId("opamp-transport"), "WebSocket");

    expect(text()).toBe(both);
    expect(entries()).toBe(0);
    expect(toast.error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
  });

  it("an edit under the transport touches only its key: a key beside the transport under server stays", async () => {
    const extra = EXTENSIONS.replace("      ws: # the websocket\n", "      note: kept # not the collector's\n      ws: # the websocket\n");
    const user = renderForm(OPAMP, opamp, extra);
    await retypeInto(user, byId("opamp-auth"), "");
    expect(text()).toBe(extra.replace("        auth: bearertokenauth\n", ""));
  });
});

describe("what the forms show (decision 3)", () => {
  it("file_storage: Create Directory shows off when unset (the collector's default); the defaults as placeholders and hints", async () => {
    const unset = "extensions:\n  file_storage: {}\nservice:\n  extensions: [file_storage]\n";
    const user = renderForm(FILE_STORAGE, fileStorage, unset);
    expect(box("Create Directory")).toHaveAttribute("data-state", "unchecked");
    expect(byId("file-storage-directory")).toHaveAttribute("placeholder", "/var/lib/otelcol/file_storage");
    expect(byId("file-storage-timeout")).toHaveValue("");
    expect(byId("file-storage-timeout")).toHaveAttribute("placeholder", "1s");
    expect(hint("Max time to wait acquiring a file lock. · Default 1s")).toBeInTheDocument();

    await openSection(user, "Compaction");
    expect(hint("Scratch space used while rewriting the database. · Default /var/lib/otelcol/file_storage")).toBeInTheDocument();
    expect(byId("file-storage-compaction-directory")).toHaveAttribute("placeholder", "/var/lib/otelcol/file_storage");
    expect(hint("Database size in MiB that triggers rebound compaction. · Default 100")).toBeInTheDocument();
    expect(hint("Free MiB required before another rebound compaction runs. · Default 10")).toBeInTheDocument();
    expect(hint("How often to check whether rebound compaction should run. · Default 5s")).toBeInTheDocument();
    expect(hint("Items per compaction transaction; 0 for unlimited. · Default 65536")).toBeInTheDocument();
    for (const name of ["Compact On Start", "Compact On Rebound", "Cleanup On Start"]) {
      expect(box(name)).toHaveAttribute("data-state", "unchecked");
    }
    await openSection(user, "Advanced: Durability");
    expect(box("Fsync")).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByText("Throughput cost")).toBeInTheDocument();
    expect(text()).toBe(unset);
  });

  it("file_storage: values as written (0750 elsewhere untouched), the Compaction count", () => {
    renderForm(FILE_STORAGE, fileStorage);
    expect(byId("file-storage-timeout")).toHaveValue("1s");
    expect(box("Create Directory")).toHaveAttribute("data-state", "checked");
    expect(screen.getByRole("button", { name: "Compaction 3" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opamp: the collector's capability defaults while unset; the Capabilities section opens only when some are set", async () => {
    const user = renderForm(POLLING, opamp);
    const section = screen.getByRole("button", { name: "Capabilities" });
    expect(section).toHaveAttribute("aria-expanded", "false");
    await user.click(section);
    expect(box("Report effective config to the server (collector default)")).toHaveAttribute("data-state", "checked");
    expect(box("Report health to the server (collector default)")).toHaveAttribute("data-state", "checked");
    expect(box("Report available components (collector default)")).toHaveAttribute("data-state", "checked");
    expect(box("Accept restart commands (SIGHUP; feature-gated, no Windows support)")).toHaveAttribute("data-state", "unchecked");
    expect(hint("How often the extension polls the OpAMP server. · Default 30s")).toBeInTheDocument();
    expect(byId("opamp-polling-interval")).toHaveValue("1m");
    expect(
      screen.getByText("TLS settings, agent_description, and the supervisor-managed ppid fields are available in the YAML editor."),
    ).toBeInTheDocument();
  });

  it("opamp: a capability deviation and back is two changes and leaves the text as it was", async () => {
    const user = renderForm(POLLING, opamp);
    await user.click(screen.getByRole("button", { name: "Capabilities" }));
    const restart = box("Accept restart commands (SIGHUP; feature-gated, no Windows support)");
    await user.click(restart);
    expect(valueOf(text(), POLLING).capabilities).toEqual({ accepts_restart_command: true });
    expect(screen.getByText(/invalid config leaves the collector down/)).toBeInTheDocument();
    await user.click(restart);
    expect(text()).toBe(EXTENSIONS);
  });

  it("bearertokenauth: the defaults as placeholders and hints; an empty scheme shows empty", () => {
    renderForm(BARE, bearer);
    expect(byId("bearertokenauth-scheme")).toHaveValue("");
    expect(byId("bearertokenauth-scheme")).toHaveAttribute("placeholder", "Bearer (collector default when unset)");
    expect(hint('Prepended to the credential ("Bearer <token>"). An explicitly empty scheme sends the bare token. · Default Bearer')).toBeInTheDocument();
    expect(byId("bearertokenauth-header")).toHaveAttribute("placeholder", "Authorization");
    expect(hint("Header (HTTP) or metadata key (gRPC) carrying the credential. · Default Authorization")).toBeInTheDocument();
    expect(input("${env:OTLP_AUTH_TOKEN}")).toHaveAttribute("readonly");
  });

  it("oidc: the attribute's default; a card's header shows its issuer, or asks for one", async () => {
    const user = renderForm(OIDC, oidc);
    expect(byId("oidc-attribute")).toHaveValue("authorization");
    expect(hint("Header (HTTP) or metadata key (gRPC) the bearer JWT is read from. · Default authorization")).toBeInTheDocument();
    // Two providers: both cards collapsed.
    expect(byId("oidc-0-issuer")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Provider" }));
    expect(screen.getByText("(configure issuer)")).toBeInTheDocument();
    // The new card is open, with the audience warning.
    expect(byId("oidc-2-issuer")).toHaveValue("");
    expect(screen.getByText(/audience is required unless the check/)).toBeInTheDocument();
  });

  it("oidc: removing a card keeps the others' open state, shifted", async () => {
    const user = renderForm(OIDC, oidc);
    await user.click(screen.getByText("https://other.example.com"));
    expect(byId("oidc-1-issuer")).toHaveValue("https://other.example.com");
    await user.click(screen.getAllByRole("button", { name: "Remove provider" })[0]!);
    expect(byId("oidc-0-issuer")).toHaveValue("https://other.example.com");
  });
});

describe("values the forms can't show (decision 3)", () => {
  it("opamp: a server that isn't a mapping, and capabilities that aren't, show the hint; the rest works", async () => {
    const odd = EXTENSIONS.replace(
      "  opamp/polling:\n    server:\n      http:\n",
      "  opamp/odd:\n    server: [a, b]\n    capabilities: yes-please\n  opamp/polling:\n    server:\n      http:\n",
    );
    const user = renderForm("extensions.opamp/odd", opamp, odd);
    await user.click(screen.getByRole("button", { name: "Capabilities" }));
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Transport" })).toBeDisabled();
    expect(byId("opamp-endpoint")).toBeNull();
    await openSection(user, "Identity");
    await retypeInto(user, byId("opamp-instance-uid"), "u");
    expect(valueOf(text(), "extensions.opamp/odd")).toMatchObject({ server: ["a", "b"], instance_uid: "u" });
  });

  it("oidc: providers that aren't a list, and an item that isn't a mapping, show the hint", async () => {
    const odd = EXTENSIONS.replace("  oidc/legacy:\n", "  oidc/odd:\n    providers: nope\n  oidc/list:\n    providers: [nope]\n  oidc/legacy:\n");
    renderForm("extensions.oidc/odd", oidc, odd);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Provider" })).toBeNull();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm("extensions.oidc/list", oidc, odd);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(text()).toBe(odd);
  });
});

describe("the deprecated OIDC form's keys are never touched", () => {
  it("editing the attribute and adding a provider leave the top-level issuer_url and audience as written", async () => {
    const user = renderForm(LEGACY, oidc);
    expect(screen.getByText(/deprecated single-provider form/)).toBeInTheDocument();
    await retypeInto(user, byId("oidc-attribute"), "x-token");
    await user.click(screen.getByRole("button", { name: "Add Provider" }));
    await retypeInto(user, byId("oidc-0-issuer"), "https://idp.example.com");
    expect(text()).toContain("  oidc/legacy:\n    issuer_url: ${env:OIDC_ISSUER_URL} # deprecated\n    audience: ${env:OIDC_AUDIENCE}\n");
    expect(valueOf(text(), LEGACY)).toEqual({
      issuer_url: "${env:OIDC_ISSUER_URL}",
      audience: "${env:OIDC_AUDIENCE}",
      attribute: "x-token",
      providers: [{ issuer_url: "https://idp.example.com" }],
    });
  });
});

// ── OpAMP and auth extension cases ──

/** A text holding `subType`'s palette default config, as a drop from the palette writes it. */
function paletteText(...paletteIds: string[]): string {
  openText(corpusText("starter.yaml"));
  for (const id of paletteIds) {
    expect(builderStore().dropComponent(id, { x: -5000, y: -5000 })).not.toBeNull();
  }
  return text();
}

describe("OpAMPExtensionForm cases", () => {
  it("renders the default websocket endpoint", () => {
    renderForm(OPAMP, opamp, paletteText("opamp-extension"));
    expect(input("wss://opamp-server:4320/v1/opamp")).toBeInTheDocument();
  });

  it("shows the polling interval only for the http transport", () => {
    renderForm(OPAMP, opamp, paletteText("opamp-extension"));
    expect(screen.queryByText("Polling Interval")).not.toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(OPAMP, opamp, "extensions:\n  opamp:\n    server:\n      http:\n        endpoint: https://opamp-server:4320/v1/opamp\n");
    expect(screen.getByText("Polling Interval")).toBeInTheDocument();
  });

  it("warns about remote restarts only when the capability is enabled", () => {
    renderForm(OPAMP, opamp, paletteText("opamp-extension"));
    expect(screen.queryByText(/invalid config leaves the collector down/)).toBeNull();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(OPAMP, opamp);
    expect(screen.getByText(/invalid config leaves the collector down/)).toBeInTheDocument();
  });

  it("writes both extensions and reads them back: opamp with its form, the memory_limiter extension keeping the fallback", () => {
    const written = paletteText("opamp-extension", "memory-limiter-extension");
    expect(written).toContain("opamp:");
    expect(written).toContain("memory_limiter:");

    // Read back, as a load does.
    useEditorStore.setState(initialState, true);
    openText(written);
    const opampNode = componentNamed(OPAMP);
    const memoryLimiter = componentNamed("extensions.memory_limiter");
    expect(opampNode.data.componentType).toBe("extension");
    expect(opampNode.data.config).toEqual({ server: { ws: { endpoint: "wss://opamp-server:4320/v1/opamp" } } });
    // The extension shares its type string with the memory_limiter processor; its type and config survive.
    expect(memoryLimiter.data.componentType).toBe("extension");
    expect(memoryLimiter.data.config).toMatchObject({ check_interval: "1s", limit_mib: 512 });

    render(<ConfigurationPanel />);
    act(() => builderStore().selectNode(memoryLimiter.id));
    expect(formFor("extension", "memory_limiter")).toBeUndefined();
    expect(screen.getByText("No form for this component yet. Edit its YAML directly.")).toBeInTheDocument();
    expect(screen.queryByText("Memory Limit")).toBeNull();

    act(() => builderStore().selectNode(opampNode.id));
    expect(input("wss://opamp-server:4320/v1/opamp")).toBeInTheDocument();
    expect(text()).toBe(written);
  });
});

describe("auth extension form cases", () => {
  it("bearertokenauth: renders the default env-referenced token", () => {
    renderForm(BEARER, bearer, paletteText("bearertokenauth-extension"));
    expect(input("${env:OTLP_AUTH_TOKEN}")).toBeInTheDocument();
  });

  it("bearertokenauth: warns when no credential source is configured", () => {
    renderForm(BEARER, bearer, "extensions:\n  bearertokenauth: {}\n");
    expect(screen.getByText(/fails collector validation without a credential/)).toBeInTheDocument();
  });

  it("bearertokenauth: warns when both token and filename are set", () => {
    renderForm(BEARER, bearer, "extensions:\n  bearertokenauth:\n    token: abc\n    filename: /etc/otelcol/tokens\n");
    expect(screen.getByText(/ignores token when a filename is configured/)).toBeInTheDocument();
  });

  it("oidc: renders the default provider expanded with its issuer", () => {
    renderForm(OIDC, oidc, paletteText("oidc-extension"));
    expect(input("${env:OIDC_ISSUER_URL}")).toBeInTheDocument();
  });

  it("oidc: flags the deprecated single-provider form", () => {
    renderForm(OIDC, oidc, "extensions:\n  oidc:\n    issuer_url: https://idp.example.com\n    audience: collector\n");
    expect(screen.getByText(/deprecated single-provider form/)).toBeInTheDocument();
  });

  it("oidc: warns when a provider has no audience and the check is not skipped", () => {
    renderForm(OIDC, oidc, "extensions:\n  oidc:\n    providers:\n      - issuer_url: https://idp.example.com\n");
    expect(screen.getByText(/audience is required unless the check/)).toBeInTheDocument();
  });

  it("carries both auth extensions through writing and reading", () => {
    const written = paletteText("bearertokenauth-extension", "oidc-extension");
    expect(written).toContain("bearertokenauth:");
    expect(written).toContain("oidc:");

    useEditorStore.setState(initialState, true);
    openText(written);
    expect(componentNamed(BEARER).data.config).toMatchObject({ tokens: ["${env:OTLP_AUTH_TOKEN}"] });
    expect((componentNamed(OIDC).data.config as { providers: Map[] }).providers[0]!.issuer_url).toBe("${env:OIDC_ISSUER_URL}");
  });

  it("reads ClickStack's shipped auth shapes (named instances, the legacy oidc form, an empty scheme), and editing keeps them", async () => {
    const clickstack = [
      "extensions:",
      "  bearertokenauth/hyperdx:",
      '    scheme: ""',
      "    tokens:",
      "      - ${env:OTLP_AUTH_TOKEN}",
      "  oidc/hyperdx:",
      "    issuer_url: ${env:OIDC_ISSUER_URL}",
      "    audience: ${env:OIDC_AUDIENCE}",
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc:",
      "        endpoint: localhost:4317",
      "exporters:",
      "  debug: {}",
      "service:",
      "  extensions: [bearertokenauth/hyperdx, oidc/hyperdx]",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const user = renderForm("extensions.bearertokenauth/hyperdx", bearer, clickstack);
    expect(byId("bearertokenauth-scheme")).toHaveValue("");
    expect(input("${env:OTLP_AUTH_TOKEN}")).toBeInTheDocument();
    await retypeInto(user, byId("bearertokenauth-header"), "x-api-key");
    expect(valueOf(text(), "extensions.bearertokenauth/hyperdx")).toEqual({
      scheme: "",
      tokens: ["${env:OTLP_AUTH_TOKEN}"],
      header: "x-api-key",
    });

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm("extensions.oidc/hyperdx", oidc, clickstack);
    expect(screen.getByText(/deprecated single-provider form/)).toBeInTheDocument();
    expect(text()).toBe(clickstack);
  });
});

describe("privacy (decision 10)", () => {
  it("puts no config value in any attribute: sections and cards open, the transport menu open, bearer tokens listed", async () => {
    const MARK = "zq-mark";
    const marked = [
      "extensions:",
      "  file_storage:",
      `    directory: /${MARK}-dir`,
      `    timeout: ${MARK}-timeout`,
      "    compaction:",
      `      directory: /${MARK}-scratch`,
      `      check_interval: ${MARK}-interval`,
      `      max_transaction_size: ${MARK}-max`,
      "  opamp:",
      "    server:",
      "      http:",
      `        endpoint: https://${MARK}-server`,
      `        polling_interval: ${MARK}-poll`,
      `        auth: ${MARK}-auth`,
      "        headers:",
      `          ${MARK}-header: ${MARK}-header-value`,
      `    instance_uid: ${MARK}-uid`,
      "    capabilities:",
      "      reports_health: false",
      "  bearertokenauth:",
      `    token: ${MARK}-token`,
      "    tokens:",
      `      - ${MARK}-token1`,
      `      - ${MARK}-token2`,
      `    filename: /${MARK}-file`,
      `    scheme: ${MARK}-scheme`,
      `    header: ${MARK}-hdr`,
      "  oidc:",
      `    attribute: ${MARK}-attribute`,
      `    issuer_url: https://${MARK}-legacy`,
      "    providers:",
      `      - issuer_url: https://${MARK}-issuer`,
      `        audience: ${MARK}-audience`,
      `        username_claim: ${MARK}-user`,
      `        groups_claim: ${MARK}-groups`,
      `        issuer_ca_path: /${MARK}-ca`,
      `        public_keys_file: /${MARK}-jwks`,
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) {
            leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
          }
        }
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    for (const [key, form] of [
      [FILE_STORAGE, <FileStorageExtensionForm key="f" />],
      [OPAMP, <OpAMPExtensionForm key="o" />],
      [BEARER, <BearerTokenAuthExtensionForm key="b" />],
      [OIDC, <OIDCAuthExtensionForm key="i" />],
    ] as const) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      expect(shown()).toContain(`${MARK}-`);
      scan(key);
    }

    // The bearer tokens: listed rows with their remove buttons.
    const removes = screen.queryAllByRole("button", { name: /^Remove/ });
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual(["Remove provider"]);
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(BEARER, bearer, marked);
    expect(input(`${MARK}-token1`)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Remove", "Remove"]);
    scan("bearer tokens");

    // The transport menu open.
    cleanup();
    useEditorStore.setState(initialState, true);
    const user = renderForm(OPAMP, opamp, marked);
    await user.click(byId("opamp-transport"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    scan("opamp (menu)");
    await user.keyboard("{Escape}");

    // An OIDC card open.
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(OIDC, oidc, marked);
    expect(byId("oidc-0-issuer")).toHaveValue(`https://${MARK}-issuer`);
    scan("oidc (card)");

    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
    expect(entries()).toBe(0);
  });
});
