import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FLUENT_FORWARD_ALERT, FluentForwardReceiverForm } from "./FluentForwardReceiverForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { NetflowReceiverForm, QUEUE_HINT, QUEUE_REPLACED, QUEUE_WARNING, SCHEME_HINT } from "./NetflowReceiverForm.js";
import { REMOVED_PARSER_TRAILER, REMOVED_TRAILER_FOR_OCTETS } from "./operators/forms/SyslogParserForm.js";
import { formFor } from "./registry.js";
import { ASYNC_OFF_HINT, REMOVED_FOR_UDP, REMOVED_TCP_BLOCK, SyslogReceiverForm } from "./SyslogReceiverForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The network logs receivers' forms: the syslog, fluentforward and netflow
 * forms over the form contract. Each field is driven as a person would on the
 * logs corpus (comments, an anchor and a merge, flow lists, `0750`), LF and
 * CRLF, and writes only its key: the text changes in that key's lines only, as
 * one undo entry, and parses to the value. The fixes each have a test that
 * fails if the bug returns: syslog's transport read from the text and renamed
 * in place, its removals with their toasts (no inline alert), Framing
 * Trailer's None, the Listen Address and Protocol without a default; netflow's
 * port kept on a scheme change and its queue warning; fluentforward's
 * `fluent.tag`. Six fluentforward cases close the file.
 *
 * Collector claims cite contrib v0.162.0.
 */

const CORPUS = corpusText("forms-logs-operators.yaml");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The info toasts shown so far: the adjustments toast their messages. */
const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const SYSLOG = "receivers.syslog";
const UDP = "receivers.syslog/udp";
const TLS = "receivers.syslog/tls";
const FLUENT = "receivers.fluentforward";
const NETFLOW = "receivers.netflow";
const SFLOW = "receivers.netflow/sflow";

const FORM_OF: Record<string, () => ReactNode> = {
  [SYSLOG]: () => <SyslogReceiverForm />,
  [UDP]: () => <SyslogReceiverForm />,
  [TLS]: () => <SyslogReceiverForm />,
  [FLUENT]: () => <FluentForwardReceiverForm />,
  [NETFLOW]: () => <NetflowReceiverForm />,
  [SFLOW]: () => <NetflowReceiverForm />,
};

function renderForm(key: string, text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{FORM_OF[key]!()}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
/** A hint line, by its whole text ("… · Default 2055" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

/** Opens every collapsed section and card, except the Add Operator dialog's trigger (its modal would hide the form). */
async function openEverything(user: UserEvent) {
  for (let round = 0; round < 4; round++) {
    const closed = screen.queryAllByRole("button", { expanded: false }).filter((button) => !button.textContent?.startsWith("Add Operator"));
    if (closed.length === 0) return;
    for (const button of closed) await user.click(button);
  }
}

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
/** Opens the Performance section without a user (synchronously). */
const fireOpen = () => act(() => screen.getByRole("button", { name: /^Performance/ }).click());

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
  /** A variant of the corpus text (LF), when the case needs one. */
  base?: string;
}

/** Each receiver's last lines, before the next: where a key it hasn't got is added. */
const SYSLOG_END = "      max_elapsed_time: 10m\n  fluentforward:\n";
const syslogEnd = (added: string) => `      max_elapsed_time: 10m\n${added}  fluentforward:\n`;
const TLS_END = "    non_transparent_framing_trailer: LF\n  netflow/sflow:\n";
const tlsEnd = (added: string) => `    non_transparent_framing_trailer: LF\n${added}  netflow/sflow:\n`;
const NETFLOW_END = "    queue_size: 1000\n  journald/source:\n";
const netflowEnd = (added: string) => `    queue_size: 1000\n${added}  journald/source:\n`;
const SFLOW_END = "    send_raw: true\n  # every transformer";
const sflowEnd = (added: string) => `    send_raw: true\n${added}  # every transformer`;

/** syslog's TCP block's lines (a unique anchor: recombine's `max_log_size: 1MiB` is deeper). */
const SYSLOG_TCP_LINES = "      listen_address: 0.0.0.0:54526 # the syslog port\n      max_log_size: 1MiB\n";
/** syslog's TCP block, and syslog/tls's whole value. */
const SYSLOG_TCP = "    tcp:\n      listen_address: 0.0.0.0:54526 # the syslog port\n      max_log_size: 1MiB\n";
const TLS_VALUE = [
  "    tcp:",
  "      listen_address: 0.0.0.0:6514",
  "      encoding: utf-16le # the relay's",
  "      add_attributes: true",
  "      tls:",
  "        cert_file: /etc/tls/syslog.crt",
  "      max_connections: 100",
  "    protocol: rfc5424",
  "    non_transparent_framing_trailer: LF",
  "",
].join("\n");
const UDP_VALUE = [
  "    udp:",
  "      listen_address: 0.0.0.0:5140 # the relay's port",
  "      encoding: utf-16le",
  "      add_attributes: true",
  "      async:",
  "        readers: 2",
  "    protocol: rfc3164",
  "    location: America/New_York",
  "",
].join("\n");

const CASES: FieldCase[] = [
  // syslog: the transport's fields
  {
    name: "syslog Listen Address (TCP) retyped keeps its comment",
    key: SYSLOG,
    edit: (user) => retypeInto(user, byId("listen_address"), "0.0.0.0:514"),
    from: "      listen_address: 0.0.0.0:54526 # the syslog port\n",
    to: "      listen_address: 0.0.0.0:514 # the syslog port\n",
    check: (v) => expect(v.tcp).toEqual({ listen_address: "0.0.0.0:514", max_log_size: "1MiB" }),
  },
  {
    name: "syslog Listen Address (UDP) retyped",
    key: UDP,
    edit: (user) => retypeInto(user, byId("listen_address"), "0.0.0.0:514"),
    from: "      listen_address: 0.0.0.0:5140 # the relay's port\n",
    to: "      listen_address: 0.0.0.0:514 # the relay's port\n",
    check: (v) => expect((v.udp as Value).listen_address).toBe("0.0.0.0:514"),
  },
  {
    name: "syslog Protocol: RFC 3164",
    key: SYSLOG,
    edit: (user) => user.click(radio("RFC 3164 (BSD-syslog)")),
    from: "      max_log_size: 1MiB\n    protocol: rfc5424\n",
    to: "      max_log_size: 1MiB\n    protocol: rfc3164\n",
    check: (v) => expect(v.protocol).toBe("rfc3164"),
  },
  {
    name: "syslog Timezone (RFC 3164) retyped",
    key: UDP,
    edit: (user) => retypeInto(user, byId("location"), "Europe/Paris"),
    from: "    protocol: rfc3164\n    location: America/New_York\n",
    to: "    protocol: rfc3164\n    location: Europe/Paris\n",
    check: (v) => expect(v.location).toBe("Europe/Paris"),
  },
  {
    name: "syslog Encoding (TCP) picked where none is set: under tcp",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.selectOptions(byId("encoding"), "utf-16le");
    },
    from: SYSLOG_TCP_LINES,
    to: `${SYSLOG_TCP_LINES}      encoding: utf-16le\n`,
    check: (v) => expect((v.tcp as Value).encoding).toBe("utf-16le"),
  },
  {
    name: "syslog Encoding (UDP) picked",
    key: UDP,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.selectOptions(byId("encoding"), "big5");
    },
    from: "      encoding: utf-16le\n      add_attributes: true\n      async:",
    to: "      encoding: big5\n      add_attributes: true\n      async:",
    check: (v) => expect((v.udp as Value).encoding).toBe("big5"),
  },
  {
    name: "syslog Enable Octet Counting unticked writes false",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.click(byId("enable_octet_counting"));
    },
    from: "    enable_octet_counting: true\n",
    to: "    enable_octet_counting: false\n",
    check: (v) => expect(v.enable_octet_counting).toBe(false),
  },
  {
    name: "syslog Max Octets typed (octet counting on)",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await retypeInto(user, byId("max_octets"), "4096");
    },
    from: SYSLOG_END,
    to: syslogEnd("    max_octets: 4096\n"),
    check: (v) => expect(v.max_octets).toBe(4096),
  },
  {
    name: "syslog Framing Trailer picked",
    key: TLS,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.selectOptions(byId("framing_trailer"), "NUL");
    },
    from: "    non_transparent_framing_trailer: LF\n",
    to: "    non_transparent_framing_trailer: NUL\n",
    check: (v) => expect(v.non_transparent_framing_trailer).toBe("NUL"),
  },
  {
    name: "syslog Framing Trailer None removes the key (never '', which config.go:92-95 refuses)",
    key: TLS,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.selectOptions(byId("framing_trailer"), "");
    },
    from: "    non_transparent_framing_trailer: LF\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("non_transparent_framing_trailer"),
  },
  {
    name: "syslog Allow Skip PRI Header ticked (octet counting off)",
    key: TLS,
    edit: async (user) => {
      await openSection(user, "Parsing");
      await user.click(byId("allow_skip_pri_header"));
    },
    from: TLS_END,
    to: tlsEnd("    allow_skip_pri_header: true\n"),
    check: (v) => expect(v.allow_skip_pri_header).toBe(true),
  },
  ...(
    [
      ["preserve_leading_whitespaces", "Parsing"],
      ["preserve_trailing_whitespaces", "Parsing"],
      ["one_log_per_packet", "Advanced"],
    ] as const
  ).map(
    ([key, section]): FieldCase => ({
      name: `syslog ${key} (TCP) ticked, under tcp`,
      key: SYSLOG,
      edit: async (user) => {
        await openSection(user, section);
        await user.click(byId(key));
      },
      from: SYSLOG_TCP_LINES,
      to: `${SYSLOG_TCP_LINES}      ${key}: true\n`,
      check: (v) => expect((v.tcp as Value)[key]).toBe(true),
    }),
  ),
  {
    name: "syslog Max Log Size (TCP) retyped, a size with a unit",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("max_log_size"), "2MiB");
    },
    from: SYSLOG_TCP_LINES,
    to: SYSLOG_TCP_LINES.replace("1MiB", "2MiB"),
    check: (v) => expect((v.tcp as Value).max_log_size).toBe("2MiB"),
  },
  {
    name: "syslog Add Network Attributes (UDP) unticked in place",
    key: UDP,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await user.click(byId("add_attributes"));
    },
    from: "      add_attributes: true\n      async:",
    to: "      add_attributes: false\n      async:",
    check: (v) => expect((v.udp as Value).add_attributes).toBe(false),
  },
  {
    name: "syslog Async Readers retyped",
    key: UDP,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("readers"), "4");
    },
    from: "        readers: 2\n",
    to: "        readers: 4\n",
    check: (v) => expect((v.udp as Value).async).toEqual({ readers: 4 }),
  },
  {
    name: "syslog Async Processors typed, under async",
    key: UDP,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("processors"), "2");
    },
    from: "        readers: 2\n",
    to: "        readers: 2\n        processors: 2\n",
    check: (v) => expect((v.udp as Value).async).toEqual({ readers: 2, processors: 2 }),
  },
  {
    name: "syslog Max Queue Length typed, under async",
    key: UDP,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("max_queue_length"), "500");
    },
    from: "        readers: 2\n",
    to: "        readers: 2\n        max_queue_length: 500\n",
    check: (v) => expect((v.udp as Value).async).toEqual({ readers: 2, max_queue_length: 500 }),
  },
  // syslog: TLS, Operators, Retry
  {
    name: "syslog Enable TLS for TCP writes the TLS versions under tcp.tls",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(byId("tls-enable-tcp"));
    },
    from: SYSLOG_TCP_LINES,
    to: `${SYSLOG_TCP_LINES}      tls:\n        min_version: "1.2"\n        max_version: "1.3"\n`,
    check: (v) => expect((v.tcp as Value).tls).toEqual({ min_version: "1.2", max_version: "1.3" }),
  },
  {
    name: "syslog a TLS certificate file retyped",
    key: TLS,
    edit: async (user) => {
      await openSection(user, "TLS");
      await retypeInto(user, byId("tls-cert-file-tcp"), "/etc/tls/new.crt");
    },
    from: "        cert_file: /etc/tls/syslog.crt\n",
    to: "        cert_file: /etc/tls/new.crt\n",
    check: (v) => expect((v.tcp as Value).tls).toEqual({ cert_file: "/etc/tls/new.crt" }),
  },
  {
    name: "syslog Add Operator appends the type's seed",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Operators");
      await user.click(screen.getByRole("button", { name: "Add Operator" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^No-Op / }));
    },
    from: SYSLOG_END,
    to: syslogEnd("    operators:\n      - type: noop\n"),
    check: (v) => expect(v.operators).toEqual([{ type: "noop" }]),
  },
  {
    name: "syslog a retry interval (from the merge) retyped as its own key",
    key: SYSLOG,
    edit: async (user) => {
      await openSection(user, "Retry on Failure");
      await retypeInto(user, byId("stanza-retry-max-elapsed-time"), "20m");
    },
    from: "      max_elapsed_time: 10m\n",
    to: "      max_elapsed_time: 20m\n",
    check: (v) => expect(v.retry_on_failure).toEqual({ enabled: true, initial_interval: "2s", max_elapsed_time: "20m" }),
  },

  // fluentforward
  {
    name: "fluentforward Endpoint retyped",
    key: FLUENT,
    edit: (user) => retypeInto(user, byId("fluentforward-endpoint"), "unix:///var/run/fluent.sock"),
    from: "    endpoint: 0.0.0.0:8006\n",
    to: "    endpoint: unix:///var/run/fluent.sock\n",
    check: (v) => expect(v.endpoint).toBe("unix:///var/run/fluent.sock"),
  },
  {
    name: "fluentforward Endpoint cleared writes \"\" (keepEmpty)",
    key: FLUENT,
    edit: (user) => retypeInto(user, byId("fluentforward-endpoint"), ""),
    from: "    endpoint: 0.0.0.0:8006\n",
    to: '    endpoint: ""\n',
    check: (v) => expect(v.endpoint).toBe(""),
  },

  // netflow
  {
    name: "netflow sFlow picked: the port moves from NetFlow's 2055 to 6343 in the same change",
    key: NETFLOW,
    edit: (user) => user.click(radio("sFlow (v5)")),
    from: "    scheme: netflow\n    port: 2055\n",
    to: "    scheme: sflow\n    port: 6343\n",
    check: (v) => expect(v).toMatchObject({ scheme: "sflow", port: 6343 }),
  },
  {
    name: "netflow NetFlow picked: the port moves back from 6343 to 2055",
    key: SFLOW,
    edit: (user) => user.click(radio("NetFlow (v5/v9/IPFIX)")),
    from: "    scheme: sflow\n    hostname: 10.0.0.1\n    port: 6343\n",
    to: "    scheme: netflow\n    hostname: 10.0.0.1\n    port: 2055\n",
    check: (v) => expect(v).toMatchObject({ scheme: "netflow", port: 2055 }),
  },
  {
    name: "netflow Hostname typed",
    key: NETFLOW,
    edit: (user) => retypeInto(user, byId("hostname"), "10.0.0.2"),
    from: NETFLOW_END,
    to: netflowEnd("    hostname: 10.0.0.2\n"),
    check: (v) => expect(v.hostname).toBe("10.0.0.2"),
  },
  {
    name: "netflow Port retyped",
    key: NETFLOW,
    edit: (user) => retypeInto(user, byId("port"), "9995"),
    from: "    port: 2055\n",
    to: "    port: 9995\n",
    check: (v) => expect(v.port).toBe(9995),
  },
  {
    name: "netflow Listening Sockets retyped",
    key: NETFLOW,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retypeInto(user, byId("sockets"), "4");
    },
    from: "    sockets: 2\n",
    to: "    sockets: 4\n",
    check: (v) => expect(v.sockets).toBe(4),
  },
  {
    name: "netflow Worker Threads retyped keeps its comment",
    key: SFLOW,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retypeInto(user, byId("workers"), "8");
    },
    from: "    workers: 4 # one per core\n",
    to: "    workers: 8 # one per core\n",
    check: (v) => expect(v.workers).toBe(8),
  },
  {
    name: "netflow Queue Size retyped",
    key: NETFLOW,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retypeInto(user, byId("queue_size"), "5000");
    },
    from: "    queue_size: 1000\n",
    to: "    queue_size: 5000\n",
    check: (v) => expect(v.queue_size).toBe(5000),
  },
  {
    name: "netflow Send Raw Messages ticked writes true",
    key: NETFLOW,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await user.click(byId("send_raw"));
    },
    from: NETFLOW_END,
    to: netflowEnd("    send_raw: true\n"),
    check: (v) => expect(v.send_raw).toBe(true),
  },
  {
    name: "netflow Send Raw Messages unticked writes false (the box's checked state)",
    key: SFLOW,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await user.click(byId("send_raw"));
    },
    from: SFLOW_END,
    to: sflowEnd("").replace("send_raw: true", "send_raw: false"),
    check: (v) => expect(v.send_raw).toBe(false),
  },
];

describe("every field of each form writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const lf = c.base ?? CORPUS;
      const before = crlf ? CRLF(lf) : lf;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
      c.check(valueOf(text(), c.key));
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

// ── syslog's transport ──

describe("syslog's transport: read from the text, renamed in place", () => {
  // input/tcp/config.go:66-79 against input/udp/config.go:69-77: UDP takes no tls or
  // max_connections; syslogreceiver/syslog.go:64-76 decodes strictly.
  it("TCP → UDP renames the block in place: encoding and add_attributes kept, tls and max_connections dropped, the trailer removed", async () => {
    const user = renderForm(TLS);
    await user.click(radio("UDP"));
    const renamed = ["    udp:", "      listen_address: 0.0.0.0:6514", "      encoding: utf-16le # the relay's", "      add_attributes: true", "    protocol: rfc5424", ""].join("\n");
    expect(text()).toBe(CORPUS.replace(TLS_VALUE, renamed));
    expect(valueOf(text(), TLS).udp).toEqual({ listen_address: "0.0.0.0:6514", encoding: "utf-16le", add_attributes: true });
    expect(entries()).toBe(1);
    expect(screen.queryByText(REMOVED_FOR_UDP)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_FOR_UDP]);
    expect(radio("UDP")).toBeChecked();
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  // input/syslog/config.go:96-99: "octet_counting and non_transparent_framing is not compatible with UDP".
  it("TCP → UDP drops max_log_size and enable_octet_counting, with the toast and no inline alert; the block's comment stays", async () => {
    const user = renderForm(SYSLOG);
    await user.click(radio("UDP"));
    expect(text()).toBe(
      CORPUS.replace(`${SYSLOG_TCP}    protocol: rfc5424\n    enable_octet_counting: true\n`, "    udp:\n      listen_address: 0.0.0.0:54526 # the syslog port\n    protocol: rfc5424\n"),
    );
    expect(screen.queryByText(REMOVED_FOR_UDP)).toBeNull();
    // What went stays gone on a switch back; the toast names Undo, which restores it.
    expect(REMOVED_FOR_UDP).toBe("Removed settings UDP can't take. Undo to restore them.");
    expect(infoToasts()).toEqual([REMOVED_FOR_UDP]);
    expect(entries()).toBe(1);
  });

  it("with enable_octet_counting false and nothing TCP-only, TCP → UDP renames alone, with no toast", async () => {
    const base = CORPUS.replace(SYSLOG_TCP, "    tcp:\n      listen_address: 0.0.0.0:54526 # the syslog port\n").replace(
      "    enable_octet_counting: true\n",
      "    enable_octet_counting: false\n",
    );
    const user = renderForm(SYSLOG, base);
    await user.click(radio("UDP"));
    expect(text()).toBe(base.replace("    tcp:\n      listen_address: 0.0.0.0:54526", "    udp:\n      listen_address: 0.0.0.0:54526"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("UDP → TCP renames in place and drops async (TCP's block refuses it), silently", async () => {
    const user = renderForm(UDP);
    await user.click(radio("TCP"));
    expect(text()).toBe(CORPUS.replace(UDP_VALUE, UDP_VALUE.replace("    udp:\n", "    tcp:\n").replace("      async:\n        readers: 2\n", "")));
    expect(valueOf(text(), UDP).tcp).toEqual({ listen_address: "0.0.0.0:5140", encoding: "utf-16le", add_attributes: true });
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // input/syslog/config.go:118: "need tcp config or udp config".
  it("with neither block, neither radio is checked and the transport's fields are disabled; a pick seeds the transport's block", async () => {
    const base = CORPUS.replace(SYSLOG_TCP, "");
    const user = renderForm(SYSLOG, base);
    expect(radio("TCP")).not.toBeChecked();
    expect(radio("UDP")).not.toBeChecked();
    expect(byId("listen_address")).toBeDisabled();
    expect(byId("listen_address")).toHaveValue("");
    await openSection(user, "Parsing");
    expect(byId("encoding")).toBeDisabled();
    expect(byId("enable_octet_counting")).toBeNull();

    await user.click(radio("TCP"));
    expect(text()).toBe(base.replace(SYSLOG_END, syslogEnd("    tcp:\n      listen_address: 0.0.0.0:54526\n      max_log_size: 1048576\n")));
    expect(byId("listen_address")).toBeEnabled();
    expect(entries()).toBe(1);
  });

  it("with neither block, picking UDP seeds its block and removes octet counting, with the toast and no inline alert", async () => {
    const base = CORPUS.replace(SYSLOG_TCP, "");
    const user = renderForm(SYSLOG, base);
    await user.click(radio("UDP"));
    expect(text()).toBe(
      base.replace("    enable_octet_counting: true\n", "").replace(SYSLOG_END, syslogEnd("    udp:\n      listen_address: 0.0.0.0:54526\n")),
    );
    expect(screen.queryByText(REMOVED_FOR_UDP)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_FOR_UDP]);
    expect(entries()).toBe(1);
  });

  // input/syslog/config.go:64-88: with both, the collector builds TCP.
  it("with both blocks TCP shows; switching to UDP removes the TCP block, with the toast and no inline alert", async () => {
    const both = CORPUS.replace(SYSLOG_TCP, `${SYSLOG_TCP}    udp:\n      listen_address: 0.0.0.0:5514\n`);
    const user = renderForm(SYSLOG, both);
    expect(radio("TCP")).toBeChecked();
    expect(byId("listen_address")).toHaveValue("0.0.0.0:54526");
    await user.click(radio("UDP"));
    expect(text()).toBe(both.replace(SYSLOG_TCP, "").replace("    enable_octet_counting: true\n", ""));
    expect(screen.queryByText(REMOVED_TCP_BLOCK)).toBeNull();
    expect(screen.queryByText(REMOVED_FOR_UDP)).toBeNull();
    expect(infoToasts()).toEqual([`${REMOVED_TCP_BLOCK} ${REMOVED_FOR_UDP}`]);
    expect(byId("listen_address")).toHaveValue("0.0.0.0:5514");
    expect(entries()).toBe(1);
  });

  it("the transport follows a YAML edit", () => {
    renderForm(SYSLOG);
    expect(radio("TCP")).toBeChecked();
    act(() => builderStore().setText(CORPUS.replace(SYSLOG_TCP, SYSLOG_TCP.replace("    tcp:\n", "    udp:\n"))));
    act(() => void builderStore().apply());
    expect(radio("UDP")).toBeChecked();
    expect(byId("listen_address")).toHaveValue("0.0.0.0:54526");
  });

  it("a transport block that isn't a mapping: its fields show the hint; the radios still switch", () => {
    renderForm(SYSLOG, CORPUS.replace(SYSLOG_TCP, "    tcp: on\n"));
    expect(radio("TCP")).toBeChecked();
    expect(byId("listen_address")).toBeNull();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(radio("UDP")).toBeEnabled();
  });
});

describe("syslog: the framing removals and the display", () => {
  // parser/syslog/config.go:88-91: the trailer is refused with none and with anything but rfc5424.
  it.each([
    ["RFC 3164 (BSD-syslog)", "rfc3164"],
    ["None (message kept as-is)", "none"],
  ])("switching Protocol to %s removes the framing trailer, in one change, with the toast and no inline alert", async (label, value) => {
    const user = renderForm(TLS);
    await user.click(radio(label));
    expect(text()).toBe(CORPUS.replace("    protocol: rfc5424\n    non_transparent_framing_trailer: LF\n", `    protocol: ${value}\n`));
    expect(screen.queryByText(REMOVED_PARSER_TRAILER)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_PARSER_TRAILER]);
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("switching Protocol without a trailer writes it alone, with no toast", async () => {
    const user = renderForm(SYSLOG);
    await user.click(radio("None (message kept as-is)"));
    expect(text()).toBe(CORPUS.replace("    protocol: rfc5424\n    enable_octet_counting", "    protocol: none\n    enable_octet_counting"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // parser/syslog/config.go:86-87: "only one of octet_counting or non_transparent_framing can be enabled".
  it("ticking Enable Octet Counting removes the framing trailer, in one change, with the toast and no inline alert", async () => {
    const user = renderForm(TLS);
    await openSection(user, "Parsing");
    await user.click(byId("enable_octet_counting"));
    expect(text()).toBe(CORPUS.replace("    non_transparent_framing_trailer: LF\n", "    enable_octet_counting: true\n"));
    expect(screen.queryByText(REMOVED_TRAILER_FOR_OCTETS)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_TRAILER_FOR_OCTETS]);
    expect(entries()).toBe(1);
    expect(byId("framing_trailer")).toBeNull();
    expect(byId("max_octets")).toBeInTheDocument();
  });

  // parser/syslog/parser.go:169-173, 199-209: octet counting frames every protocol.
  it("Enable Octet Counting shows for any protocol on TCP, and not on UDP", async () => {
    const user = renderForm(SYSLOG, CORPUS.replace("    protocol: rfc5424\n    enable_octet_counting", "    protocol: rfc3164\n    enable_octet_counting"));
    await openSection(user, "Parsing");
    expect(byId("enable_octet_counting")).toBeChecked();

    cleanup();
    useEditorStore.setState(initialState, true);
    const udp = renderForm(UDP);
    await openSection(udp, "Parsing");
    expect(byId("enable_octet_counting")).toBeNull();
  });

  it("Allow Skip PRI Header is disabled while octet counting is on (parser.go:83, 122, 218)", async () => {
    const user = renderForm(SYSLOG);
    await openSection(user, "Parsing");
    expect(byId("allow_skip_pri_header")).toBeDisabled();
    expect(document.querySelector('label[for="allow_skip_pri_header"]')).toHaveClass("text-muted-foreground");
  });

  // input/tcp/config.go:103-105, input/udp/config.go:86-88: listen_address is required.
  it("Listen Address is required, with an example and no Default; Protocol unset checks none and has no hint", () => {
    renderForm(SYSLOG, CORPUS.replace(SYSLOG_TCP, "    tcp:\n").replace("    protocol: rfc5424\n", ""));
    expect(byId("listen_address")).toHaveValue("");
    expect(byId("listen_address")).toHaveAttribute("placeholder", "e.g. 0.0.0.0:54526");
    expect(hint("host:port (standard syslog port 514 requires root).")).toBeInTheDocument();
    expect(screen.getByText("Listen Address").textContent).toContain("*");
    for (const name of ["RFC 3164 (BSD-syslog)", "RFC 5424", "None (message kept as-is)"]) expect(radio(name)).not.toBeChecked();
    expect(screen.queryByText("Structured format with better timestamp precision.")).toBeNull();
    expect(screen.queryByText(/^Legacy BSD-syslog/)).toBeNull();
  });

  // input/udp/config.go:62-66, 112-145: synchronous until an async block exists.
  it("UDP's async fields show unset with the hint until an async block exists; then the Default hints", async () => {
    const user = renderForm(UDP, CORPUS.replace("      async:\n        readers: 2\n", ""));
    await openSection(user, "Advanced");
    expect(byId("readers")).toHaveValue("");
    expect(byId("readers")).not.toHaveAttribute("placeholder", "1");
    expect(screen.getByText(ASYNC_OFF_HINT)).toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    const again = renderForm(UDP);
    await openSection(again, "Advanced");
    expect(byId("readers")).toHaveValue("2");
    expect(hint("Default 100")).toBeInTheDocument();
    expect(screen.queryByText(ASYNC_OFF_HINT)).toBeNull();
  });

  it("an encoding outside the list shows as written; its option's value attribute is a fixed token, never the value", async () => {
    const user = renderForm(SYSLOG, CORPUS.replace("      max_log_size: 1MiB\n", "      max_log_size: 1MiB\n      encoding: shift_jis\n"));
    await openSection(user, "Parsing");
    const select = byId("encoding") as unknown as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("shift_jis");
    expect(select.selectedOptions[0]?.getAttribute("value")).toBe("written-value");
    await user.selectOptions(select, "utf-8");
    expect(valueOf(text(), SYSLOG).tcp).toMatchObject({ encoding: "utf-8" });
  });

  it("unset Encoding shows UTF-8, the collector's (input/tcp/config.go:54); UDP's TLS section says TCP only", async () => {
    const user = renderForm(UDP, CORPUS.replace("      encoding: utf-16le\n      add_attributes: true\n      async:", "      add_attributes: true\n      async:"));
    await openSection(user, "Parsing");
    expect((byId("encoding") as unknown as HTMLSelectElement).value).toBe("utf-8");
    await openSection(user, "TLS");
    expect(screen.getByText("TCP only")).toBeInTheDocument();
    expect(screen.getByText("Switch to TCP to configure TLS.")).toBeInTheDocument();
  });

  // parser/syslog/config.go:64 lower-cases the protocol.
  it("the protocol matches in any case: RFC3164 shows RFC 3164 checked and Timezone; a choice writes lower case", async () => {
    const base = CORPUS.replace("    protocol: rfc3164\n", "    protocol: RFC3164\n");
    const user = renderForm(UDP, base);
    expect(byId("location")).toHaveValue("America/New_York");
    expect(radio("RFC 3164 (BSD-syslog)")).toBeChecked();
    expect(radio("RFC 5424")).toBeEnabled();
    expect(screen.queryByText(UNSHOWABLE_VALUE_MESSAGE)).toBeNull();
    await user.click(radio("RFC 5424"));
    expect(text()).toBe(base.replace("    protocol: RFC3164\n", "    protocol: rfc5424\n"));
  });

  // input/udp/config.go:112-145 reads async on while the block exists.
  it("clearing the last async key removes the async block, so the collector reads synchronously and the hint shows again", async () => {
    const user = renderForm(UDP);
    await openSection(user, "Advanced");
    await retypeInto(user, byId("readers"), "");
    expect(text()).toBe(CORPUS.replace("      async:\n        readers: 2\n", ""));
    expect(entries()).toBe(1);
    expect(screen.getByText(ASYNC_OFF_HINT)).toBeInTheDocument();
  });

  it("clearing an async key beside another removes that key alone", async () => {
    const base = CORPUS.replace("        readers: 2\n", "        readers: 2\n        processors: 3\n");
    const user = renderForm(UDP, base);
    await openSection(user, "Advanced");
    await retypeInto(user, byId("readers"), "");
    expect(text()).toBe(base.replace("        readers: 2\n", ""));
  });

  // A TCP block the form can't show isn't "TCP only".
  it("a TCP block that isn't a mapping shows the hint in the TLS section, not TCP only", async () => {
    const user = renderForm(SYSLOG, CORPUS.replace(SYSLOG_TCP, "    tcp: on\n"));
    await openSection(user, "TLS");
    expect(screen.queryByText("TCP only")).toBeNull();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE).length).toBeGreaterThan(1);
  });

  // input/syslog/config.go:96-99 refuses either framing key with UDP.
  it("on UDP, octet counting and the framing trailer show while set, so they can be removed", async () => {
    const base = CORPUS.replace("    location: America/New_York\n", "    location: America/New_York\n    enable_octet_counting: true\n    non_transparent_framing_trailer: LF\n");
    const user = renderForm(UDP, base);
    await openSection(user, "Parsing");
    expect(byId("enable_octet_counting")).toBeChecked();
    expect(byId("max_octets")).toBeNull();
    await user.click(byId("enable_octet_counting"));
    expect(text()).toBe(base.replace("    enable_octet_counting: true\n    non_transparent_framing_trailer", "    non_transparent_framing_trailer"));
    expect(byId("enable_octet_counting")).toBeNull();
    await user.selectOptions(byId("framing_trailer"), "");
    expect(text()).toBe(CORPUS);
    expect(byId("framing_trailer")).toBeNull();
  });

  it("on UDP with neither framing key, neither shows", async () => {
    const user = renderForm(UDP);
    await openSection(user, "Parsing");
    expect(byId("enable_octet_counting")).toBeNull();
    expect(byId("framing_trailer")).toBeNull();
  });

  // The collector decodes ascii as UTF-8 (textutils/encoding.go:23-24), as filelog's.
  it('Encoding offers "ASCII (read as UTF-8)"', async () => {
    const user = renderForm(SYSLOG);
    await openSection(user, "Parsing");
    expect([...(byId("encoding") as unknown as HTMLSelectElement).options].map((o) => o.textContent)).toContain("ASCII (read as UTF-8)");
  });
});

// ── netflow ──

describe("netflow: the scheme and the queue", () => {
  // receiver/netflowreceiver/factory.go:29-37: scheme netflow and port 2055 by default.
  it("an unset scheme shows NetFlow checked; Port's default is 2055 for both schemes", () => {
    renderForm(NETFLOW, CORPUS.replace("    scheme: netflow\n    port: 2055\n", ""));
    expect(radio("NetFlow (v5/v9/IPFIX)")).toBeChecked();
    expect(hint("UDP port to listen on. · Default 2055")).toBeInTheDocument();
    expect(byId("port")).toHaveAttribute("placeholder", "2055");
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(SFLOW);
    expect(hint("UDP port to listen on. · Default 2055")).toBeInTheDocument();
  });

  it("a port of the person's own is kept on a scheme change (never overwritten)", async () => {
    const base = CORPUS.replace("    port: 2055\n", "    port: 9995\n");
    const user = renderForm(NETFLOW, base);
    await user.click(radio("sFlow (v5)"));
    expect(text()).toBe(base.replace("    scheme: netflow\n", "    scheme: sflow\n"));
  });

  it("with the port unset, a scheme change writes the scheme's port", async () => {
    const base = CORPUS.replace("    port: 2055\n", "");
    const user = renderForm(NETFLOW, base);
    await user.click(radio("sFlow (v5)"));
    expect(text()).toBe(base.replace("    scheme: netflow\n", "    scheme: sflow\n").replace(NETFLOW_END, netflowEnd("    port: 6343\n")));
    expect(entries()).toBe(1);
  });

  // config.go:70-72: only a queue of 0 or less is replaced; 1-999 is kept.
  // config.go:70-72 replaces 0 or less with 1000.
  it.each(["0", "-5"])("a queue of %s isn't warned: the collector uses 1000, which a hint says", (queue) => {
    renderForm(NETFLOW, CORPUS.replace("    queue_size: 1000\n", `    queue_size: ${queue}\n`));
    fireOpen();
    expect(screen.queryByText(QUEUE_WARNING)).toBeNull();
    expect(screen.getByText(QUEUE_REPLACED)).toBeInTheDocument();
  });

  // The copy says what the form and the collector do.
  it("Flow Protocol's and Queue Size's hints say the port is kept and 1000 is recommended", async () => {
    const user = renderForm(NETFLOW);
    expect(hint(`${SCHEME_HINT} · Default netflow`)).toBeInTheDocument();
    expect(SCHEME_HINT).toBe("Switching protocol changes the port only while it is a protocol's default.");
    await openSection(user, "Performance");
    expect(hint(`${QUEUE_HINT} · Default 1000`)).toBeInTheDocument();
    expect(QUEUE_HINT).toBe("Buffer for incoming packets; 1000 or more is recommended.");
  });

  it("a queue below 1000 is a warning, not an error: the warn alert, the section open", async () => {
    const user = renderForm(NETFLOW);
    await openSection(user, "Performance");
    expect(screen.queryByText(QUEUE_WARNING)).toBeNull();
    await retypeInto(user, byId("queue_size"), "500");
    expect(valueOf(text(), NETFLOW).queue_size).toBe(500);
    expect(screen.getByText(QUEUE_WARNING)).toBeInTheDocument();
    expect(QUEUE_WARNING).toBe("Below the recommended minimum of 1000.");
    expect(screen.getByText(QUEUE_WARNING).parentElement).toHaveClass("bg-warn-soft");
    expect(screen.queryByText("Queue size must be at least 1000.")).toBeNull();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(NETFLOW, CORPUS.replace("    queue_size: 1000\n", "    queue_size: 500\n"));
    // Forced open by the warning.
    expect(screen.getByText(QUEUE_WARNING)).toBeInTheDocument();
  });

  it("unset shows the collector's defaults as placeholders and hints (config.go:10-17)", async () => {
    const user = renderForm(NETFLOW, "receivers:\n  netflow:\n");
    expect(byId("hostname")).toHaveAttribute("placeholder", "0.0.0.0");
    await openSection(user, "Performance");
    expect(byId("sockets")).toHaveAttribute("placeholder", "1");
    expect(byId("workers")).toHaveAttribute("placeholder", "2");
    expect(byId("queue_size")).toHaveAttribute("placeholder", "1000");
    expect(text()).toBe("receivers:\n  netflow:\n");
  });

  it("a scheme outside the two checks neither and is read-only with the hint (config.go:49-60 refuses flow)", () => {
    renderForm(NETFLOW, CORPUS.replace("    scheme: netflow\n", "    scheme: flow\n"));
    expect(radio("NetFlow (v5/v9/IPFIX)")).not.toBeChecked();
    expect(radio("sFlow (v5)")).not.toBeChecked();
    expect(radio("sFlow (v5)")).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

// ── Opening writes nothing ──

describe("opening writes nothing", () => {
  // One test per form and text, each with its own time limit.
  const TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["every key unset", "receivers:\n  syslog:\n  syslog/udp:\n  syslog/tls:\n  fluentforward:\n  netflow:\n  netflow/sflow:\n"],
  ] as const;
  /** What each form shows once opened, at least, on the least of its texts: its text fields, every control, and a field each of its texts shows. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [SYSLOG]: { textboxes: 1, all: 13, field: "encoding" },
    [UDP]: { textboxes: 1, all: 13, field: "encoding" },
    [TLS]: { textboxes: 1, all: 13, field: "encoding" },
    [FLUENT]: { textboxes: 1, all: 1, field: "fluentforward-endpoint" },
    [NETFLOW]: { textboxes: 5, all: 8, field: "workers" },
    [SFLOW]: { textboxes: 5, all: 8, field: "workers" },
  };
  it.each([SYSLOG, UDP, TLS, FLUENT, NETFLOW, SFLOW].flatMap((key) => TEXTS.map(([name, base]) => [key, name, base] as const)))(
    "opening %s on %s, every section and operator card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      await openEverything(user);
      expect(screen.queryByRole("dialog")).toBeNull();
      // Opened, it shows the form's fields.
      const { textboxes, all } = formControls();
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      // Native selects, focused and left (a Radix select's click opens its menu).
      for (const select of document.querySelectorAll("select")) {
        act(() => select.focus());
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── Privacy ──

describe("privacy", () => {
  const MARK = "zq-mark";
  const MARKED = [
    "receivers:",
    "  syslog:",
    "    tcp:",
    `      listen_address: ${MARK}-listen`,
    `      encoding: ${MARK}-enc`,
    `      max_log_size: ${MARK}-mls`,
    "      tls:",
    `        cert_file: ${MARK}-cert`,
    `        min_version: ${MARK}-min`,
    `    protocol: ${MARK}-protocol`,
    `    location: ${MARK}-location`,
    `    max_octets: ${MARK}-octets`,
    "    enable_octet_counting: true",
    `    non_transparent_framing_trailer: ${MARK}-trailer`,
    "    operators:",
    "      - type: noop",
    `        id: ${MARK}-op`,
    "    retry_on_failure:",
    "      enabled: true",
    `      initial_interval: ${MARK}-retry`,
    "  syslog/udp:",
    "    udp:",
    `      listen_address: ${MARK}-listen`,
    `      encoding: ${MARK}-enc`,
    "      async:",
    `        readers: ${MARK}-readers`,
    "    protocol: rfc5424",
    `    non_transparent_framing_trailer: ${MARK}-trailer`,
    "  fluentforward:",
    `    endpoint: ${MARK}-endpoint`,
    "  netflow:",
    `    scheme: ${MARK}-scheme`,
    `    hostname: ${MARK}-host`,
    `    port: ${MARK}-port`,
    `    sockets: ${MARK}-sockets`,
    `    workers: ${MARK}-workers`,
    `    queue_size: ${MARK}-queue`,
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [syslog, syslog/udp, fluentforward, netflow]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  const leaks: string[] = [];
  const scan = (where: string) => {
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
      }
      // A native option's value attribute is an attribute: it carries a fixed token, never the value.
      if (element.tagName === "OPTION" && element.getAttribute("value")?.includes(MARK)) leaks.push(`${where}: OPTION[value]`);
      if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "radio" && element.getAttribute("value")?.includes(MARK)) {
        leaks.push(`${where}: radio[value]`);
      }
    }
  };
  const shown = () =>
    document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

  // Its own time limit.
  it.each([
    ["receivers.syslog", ["tls-min-version-tcp"]],
    ["receivers.syslog/udp", []],
    [FLUENT, []],
    [NETFLOW, []],
  ] as const)("%s puts no config value in any attribute: every section open, the menus open", async (key, menus) => {
    leaks.length = 0;
    const user = renderForm(key, MARKED);
    await openEverything(user);
    expect(shown()).toContain(`${MARK}-`);
    scan(key);
    for (const menu of menus) {
      await user.click(byId(menu));
      expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
      scan(`${key} (${menu} menu)`);
      await user.keyboard("{Escape}");
    }
    expect(document.querySelector("form")).toBeNull();
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── FluentForwardReceiverForm cases ──

describe("FluentForwardReceiverForm cases", () => {
  /** The palette's fluentforward, as a generator writes it (strings single-quoted). */
  const PALETTE = [
    "receivers:",
    "  fluentforward:",
    "    endpoint: '0.0.0.0:8006'",
    "exporters:",
    "  otlp:",
    "    endpoint: 'localhost:4317'",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [fluentforward]",
    "      exporters: [otlp]",
    "",
  ].join("\n");
  const input = (value: string) => [...document.querySelectorAll("input")].find((i) => i.value === value);

  it("the palette text is the palette's defaults", () => {
    expect(valueOf(PALETTE, FLUENT)).toEqual(findPaletteEntry("receiver", "fluentforward")?.defaultConfig);
  });

  it("renders endpoint value from config", () => {
    renderForm(FLUENT, PALETTE);
    expect(input("0.0.0.0:8006")).toBeInTheDocument();
  });

  it("renders the no-TLS guidance, with the collector's tag attribute, fluent.tag (conversion.go:22)", () => {
    renderForm(FLUENT, PALETTE);
    expect(screen.getByText(/does not support TLS or the Forward protocol handshake/)).toBeInTheDocument();
    expect(screen.getByText(FLUENT_FORWARD_ALERT)).toBeInTheDocument();
    expect(FLUENT_FORWARD_ALERT).toContain("stored in the fluent.tag log attribute");
    expect(screen.queryByText(/fluentd\.tag/)).toBeNull();
  });

  it("renders a custom unix socket endpoint", () => {
    renderForm(FLUENT, PALETTE.replace("'0.0.0.0:8006'", "'unix:///var/run/fluent.sock'"));
    expect(input("unix:///var/run/fluent.sock")).toBeInTheDocument();
  });

  it("generates valid YAML: an edit changes only its line, and the text parses", async () => {
    const user = renderForm(FLUENT, PALETTE);
    await retypeInto(user, byId("fluentforward-endpoint"), "0.0.0.0:24224");
    expect(text()).toBe(PALETTE.replace("    endpoint: '0.0.0.0:8006'\n", "    endpoint: '0.0.0.0:24224'\n"));
    expect(parse(text()).ok).toBe(true);
    expect(text()).toContain("receivers:\n  fluentforward:\n");
  });

  it("survives a round trip", async () => {
    const user = renderForm(FLUENT, PALETTE);
    await retypeInto(user, byId("fluentforward-endpoint"), "unix:///var/run/fluent.sock");
    const written = text();
    expect(valueOf(written, FLUENT).endpoint).toBe("unix:///var/run/fluent.sock");
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(FLUENT, written);
    expect(input("unix:///var/run/fluent.sock")).toBeInTheDocument();
    expect(text()).toBe(written);
  });

  // fluentforwardreceiver/metadata.yaml:2-3 (v0.162.0): `fluent_forward` is the type.
  it("maps the renamed fluent_forward YAML key back to the palette subType, and its form", () => {
    const renamed = PALETTE.replace("  fluentforward:\n", "  fluent_forward:\n").replace("[fluentforward]", "[fluent_forward]");
    openText(renamed);
    const node = componentNamed("receivers.fluent_forward");
    expect(node.data.componentSubType).toBe("fluentforward");
    const Form = formFor("receiver", node.data.componentSubType)!;
    expect(Form).toBe(FluentForwardReceiverForm);
    render(
      <ComponentForm nodeId={node.id}>
        <Form />
      </ComponentForm>,
    );
    expect(input("0.0.0.0:8006")).toBeInTheDocument();
    expect(text()).toBe(renamed);
  });
});
