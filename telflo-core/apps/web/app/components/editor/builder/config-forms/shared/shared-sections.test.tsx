import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../form-context.js";
import { CORSConfigSection } from "./CORSConfigSection.js";
import { HEADER_EXISTS_MESSAGE, HeadersConfigSection } from "./HeadersConfigSection.js";
import { RetryConfigSection } from "./RetryConfigSection.js";
import { SendingQueueSection } from "./SendingQueueSection.js";
import { StringListField } from "./StringListField.js";
import { CLIENT_TLS_HINT, TLSConfigSection } from "./TLSConfigSection.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The shared sections (D9b Task 4): what each toggle writes (its change,
 * as one undo entry; decision 4), what they show (decision 3), the
 * TLS variants (Preflight ruling 4), the headers' rename (decision 4), and
 * privacy (decision 10).
 */

const TEXT = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: localhost:4317 # the endpoint
      http:
        endpoint: localhost:4318
        cors:
          allowed_origins:
            - https://one.example.com # first
          max_age: 600
exporters:
  otlp:
    endpoint: backend:4317
    headers:
      X-First: one # first
      X-Second: two
      X-Third: three
    retry_on_failure:
      max_interval: 45s # longer
    sending_queue:
      enabled: false
    tokens:
      - alpha
      - beta
  otlp/tls:
    endpoint: backend:4317 # keep
    tls:
      ca_file: /etc/ca.crt # the CA
      insecure_skip_verify: true
    headers:
      X-Only: only
  otlp/off:
    endpoint: backend:4317
    retry_on_failure:
      enabled: false
    sending_queue:
      queue_size: 50 # small
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp, otlp/tls, otlp/off]
`;

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Records every change list a form sends the store, and passes it on. */
function spyWrites(): ValueChange[][] {
  const original = builderStore().setComponentValues;
  const calls: ValueChange[][] = [];
  useEditorStore.setState({
    setComponentValues: (nodeId, changes) => {
      calls.push([...changes]);
      return original(nodeId, changes);
    },
  });
  return calls;
}

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderIn(key: string, children: ReactNode, text = TEXT) {
  openText(text);
  return render(<ComponentForm nodeId={componentNamed(key).id}>{children}</ComponentForm>);
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const box = (name: string) => screen.getByRole("checkbox", { name });
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
/** A hint line, by its whole text ("… · Default 5s" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/**
 * Toggles `name` and checks the text became `expected`: one call, one
 * undo entry, and undo restores the text.
 */
async function toggleWrites(name: string, expected: string, change: ValueChange) {
  const user = userEvent.setup();
  const calls = spyWrites();
  const before = text();
  const past = entries();
  await user.click(box(name));
  expect(calls).toEqual([[change]]);
  expect(text()).toBe(expected);
  expect(entries()).toBe(past + 1);
  act(() => builderStore().undo());
  expect(text()).toBe(before);
}

describe("each toggle writes its change, as one entry (decision 4)", () => {
  it("TLS on writes min 1.2 and max 1.3 as the block; off removes the block", async () => {
    renderIn("receivers.otlp", <TLSConfigSection path={["protocols", "grpc", "tls"]} protocolLabel="gRPC" variant="server" />);
    expect(box("Enable TLS for gRPC")).not.toBeChecked();
    await toggleWrites(
      "Enable TLS for gRPC",
      TEXT.replace(
        "        endpoint: localhost:4317 # the endpoint\n",
        '        endpoint: localhost:4317 # the endpoint\n        tls:\n          min_version: "1.2"\n          max_version: "1.3"\n',
      ),
      { path: ["protocols", "grpc", "tls"], value: { min_version: "1.2", max_version: "1.3" } },
    );
  });

  it("TLS off removes the whole block (the client variant writes the same)", async () => {
    renderIn("exporters.otlp/tls", <TLSConfigSection path={["tls"]} protocolLabel="OTLP gRPC" variant="client" />);
    expect(box("Customize TLS for OTLP gRPC")).toBeChecked();
    await toggleWrites(
      "Customize TLS for OTLP gRPC",
      TEXT.replace("    tls:\n      ca_file: /etc/ca.crt # the CA\n      insecure_skip_verify: true\n", ""),
      { path: ["tls"], remove: true },
    );
  });

  it("CORS on writes empty lists and max_age 7200; off removes the block", async () => {
    const withoutCors = TEXT.replace(
      "        cors:\n          allowed_origins:\n            - https://one.example.com # first\n          max_age: 600\n",
      "",
    );
    renderIn("receivers.otlp", <CORSConfigSection path={["protocols", "http", "cors"]} />, withoutCors);
    expect(box("Enable CORS (HTTP only)")).not.toBeChecked();
    await toggleWrites(
      "Enable CORS (HTTP only)",
      withoutCors.replace(
        "        endpoint: localhost:4318\n",
        "        endpoint: localhost:4318\n        cors:\n          allowed_origins: []\n          allowed_headers: []\n          max_age: 7200\n",
      ),
      { path: ["protocols", "http", "cors"], value: { allowed_origins: [], allowed_headers: [], max_age: 7200 } },
    );
  });

  it("CORS Max Age unset shows the collector's default, 0: no header sent (v0.162.0; Ruling 75)", () => {
    const withoutMaxAge = TEXT.replace("          max_age: 600\n", "");
    renderIn("receivers.otlp", <CORSConfigSection path={["protocols", "http", "cors"]} />, withoutMaxAge);
    expect(field("Max Age")).toHaveValue("");
    expect(field("Max Age")).toHaveAttribute("placeholder", "0");
    expect(hint("How long browsers cache the preflight response, in seconds. · Default 0 (not sent)")).toBeInTheDocument();
    expect(text()).toBe(withoutMaxAge);
  });

  it("CORS off removes the block", async () => {
    renderIn("receivers.otlp", <CORSConfigSection path={["protocols", "http", "cors"]} />);
    expect(box("Enable CORS (HTTP only)")).toBeChecked();
    await toggleWrites(
      "Enable CORS (HTTP only)",
      TEXT.replace("        cors:\n          allowed_origins:\n            - https://one.example.com # first\n          max_age: 600\n", ""),
      { path: ["protocols", "http", "cors"], remove: true },
    );
  });

  it("Retry off writes enabled: false in place of the block", async () => {
    renderIn("exporters.otlp", <RetryConfigSection path={["retry_on_failure"]} />);
    await toggleWrites(
      "Enable Retry on Failure",
      TEXT.replace("    retry_on_failure:\n      max_interval: 45s # longer\n", "    retry_on_failure:\n      enabled: false\n"),
      { path: ["retry_on_failure"], value: { enabled: false } },
    );
  });

  it("Retry on writes its block", async () => {
    renderIn("exporters.otlp/off", <RetryConfigSection path={["retry_on_failure"]} />);
    expect(box("Enable Retry on Failure")).not.toBeChecked();
    expect(screen.getByText("Retry failed requests with exponential backoff.")).toBeInTheDocument();
    await toggleWrites(
      "Enable Retry on Failure",
      TEXT.replace(
        "    retry_on_failure:\n      enabled: false\n",
        "    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n      max_interval: 30s\n      max_elapsed_time: 300s\n      multiplier: 1.5\n",
      ),
      {
        path: ["retry_on_failure"],
        value: { enabled: true, initial_interval: "5s", max_interval: "30s", max_elapsed_time: "300s", multiplier: 1.5 },
      },
    );
  });

  it("the queue on writes enabled, 10 consumers and 1000; off writes enabled: false in place of the block", async () => {
    renderIn("exporters.otlp", <SendingQueueSection path={["sending_queue"]} />);
    expect(box("Enable Sending Queue")).not.toBeChecked();
    await toggleWrites(
      "Enable Sending Queue",
      TEXT.replace(
        "    sending_queue:\n      enabled: false\n",
        "    sending_queue:\n      enabled: true\n      num_consumers: 10\n      queue_size: 1000\n",
      ),
      { path: ["sending_queue"], value: { enabled: true, num_consumers: 10, queue_size: 1000 } },
    );
  });

  it("the queue off, from a block without enabled, writes enabled: false in its place", async () => {
    renderIn("exporters.otlp/off", <SendingQueueSection path={["sending_queue"]} />);
    expect(box("Enable Sending Queue")).toBeChecked();
    await toggleWrites(
      "Enable Sending Queue",
      TEXT.replace("    sending_queue:\n      queue_size: 50 # small\n", "    sending_queue:\n      enabled: false\n"),
      { path: ["sending_queue"], value: { enabled: false } },
    );
  });
});

describe("what the sections show (decisions 3 and 4)", () => {
  it("Retry shows on for a block without enabled, its unset fields as placeholders and hints", () => {
    renderIn("exporters.otlp", <RetryConfigSection path={["retry_on_failure"]} />);
    expect(box("Enable Retry on Failure")).toBeChecked();
    expect(field("Initial Interval")).toHaveValue("");
    expect(field("Initial Interval")).toHaveAttribute("placeholder", "5s");
    expect(field("Max Interval")).toHaveValue("45s");
    expect(field("Max Elapsed Time")).toHaveValue("");
    expect(field("Max Elapsed Time")).toHaveAttribute("placeholder", "300s");
    expect(field("Backoff Multiplier")).toHaveValue("");
    expect(field("Backoff Multiplier")).toHaveAttribute("placeholder", "1.5");
    expect(hint("Wait this long after the first failure. · Default 5s")).toBeInTheDocument();
  });

  it("Retry and the queue show on when their block is absent; a field's edit writes only its key", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.otlp/tls",
      <>
        <RetryConfigSection path={["retry_on_failure"]} />
        <SendingQueueSection path={["sending_queue"]} />
      </>,
    );
    expect(box("Enable Retry on Failure")).toBeChecked();
    expect(box("Enable Sending Queue")).toBeChecked();
    expect(field("Consumers")).toHaveValue("");
    expect(field("Consumers")).toHaveAttribute("placeholder", "10");
    expect(field("Queue Size")).toHaveAttribute("placeholder", "1000");

    await user.type(field("Queue Size"), "0");
    await user.tab();
    expect(calls).toEqual([[{ path: ["sending_queue", "queue_size"], plain: "0" }]]);
    expect(text()).toContain("    sending_queue:\n      queue_size: 0\n");
  });

  it("the queue's Advanced shows the sizer, wait-for-result and block-on-overflow, unset as the collector's", async () => {
    const user = userEvent.setup();
    renderIn("exporters.otlp/off", <SendingQueueSection path={["sending_queue"]} />);
    expect(field("Queue Size")).toHaveValue("50");
    expect(screen.getByText("Batching")).toBeInTheDocument();
    expect(field("Max Batch Size")).toHaveAttribute("placeholder", "0");
    expect(screen.queryByText("Wait for result (blocks until processed)")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("combobox", { name: "Sizer" })).toHaveTextContent("Requests");
    expect(box("Wait for result (blocks until processed)")).not.toBeChecked();
    expect(box("Block on overflow (instead of dropping data)")).not.toBeChecked();
  });

  it("the queue without batch settings hides Batching", () => {
    renderIn("exporters.otlp/off", <SendingQueueSection path={["sending_queue"]} showBatchSettings={false} />);
    expect(screen.queryByText("Batching")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Flush Timeout" })).toBeNull();
  });

  it("0 can be entered as CORS's max age", async () => {
    const user = userEvent.setup();
    renderIn("receivers.otlp", <CORSConfigSection path={["protocols", "http", "cors"]} />);
    expect(field("Max Age")).toHaveValue("600");
    await user.clear(field("Max Age"));
    await user.type(field("Max Age"), "0");
    await user.tab();
    expect(text()).toContain("          max_age: 0\n");
    expect(field("Max Age")).toHaveValue("0");
  });

  it("CORS's lists are written by item, their rows keeping their comments", async () => {
    const user = userEvent.setup();
    renderIn("receivers.otlp", <CORSConfigSection path={["protocols", "http", "cors"]} />);
    expect(screen.getByDisplayValue("https://one.example.com")).toBeInTheDocument();
    expect(screen.getByText("No headers configured")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Origin" }));
    const second = screen.getAllByPlaceholderText("e.g. https://*.example.com")[1] as HTMLInputElement;
    await user.type(second, "https://two.example.com");
    await user.tab();
    // The added item was written as "", and keeps its quoting.
    expect(text()).toBe(
      TEXT.replace(
        "            - https://one.example.com # first\n",
        '            - https://one.example.com # first\n            - "https://two.example.com"\n',
      ),
    );

    await user.click(screen.getAllByRole("button", { name: "Remove origin" })[1] as HTMLElement);
    expect(text()).toBe(TEXT);
  });
});

describe("the TLS variants (Preflight ruling 4)", () => {
  it("the client variant says Customize, with its hint, and has no Client CA fields", async () => {
    const user = userEvent.setup();
    renderIn("exporters.otlp/tls", <TLSConfigSection path={["tls"]} protocolLabel="OTLP gRPC" variant="client" />);
    expect(box("Customize TLS for OTLP gRPC")).toBeChecked();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(CLIENT_TLS_HINT).toBe("Off: the collector uses TLS with the system's CAs, as the endpoint allows.");
    expect(field("CA File")).toHaveValue("/etc/ca.crt");
    expect(screen.queryByText("Client CA File")).toBeNull();
    expect(screen.queryByText("Enable client CA file reload")).toBeNull();
    expect(screen.queryByText(/Enable TLS/)).toBeNull();

    // Off, the hint stays.
    await user.click(box("Customize TLS for OTLP gRPC"));
    expect(box("Customize TLS for OTLP gRPC")).not.toBeChecked();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "CA File" })).toBeNull();
  });

  it("the server variant: Enable TLS, Client CA fields, no client hint", async () => {
    const user = userEvent.setup();
    renderIn("receivers.otlp", <TLSConfigSection path={["protocols", "grpc", "tls"]} protocolLabel="gRPC" variant="server" />);
    expect(screen.queryByText(CLIENT_TLS_HINT)).toBeNull();
    await user.click(box("Enable TLS for gRPC"));
    expect(box("Enable TLS for gRPC")).toBeChecked();
    expect(box("Enable TLS for gRPC")).toHaveAttribute("id", "tls-enable-grpc");
    expect(field("Certificate File")).toHaveAttribute("placeholder", "e.g. /path/to/server.crt");
    expect(field("Key File")).toHaveAttribute("placeholder", "e.g. /path/to/server.key");
    expect(field("CA File")).toHaveAttribute("placeholder", "e.g. /path/to/ca.crt");
    expect(field("Client CA File")).toHaveAttribute("placeholder", "e.g. /path/to/client-ca.crt");
    expect(screen.getByText("CA for validating client certificates (mutual TLS).")).toBeInTheDocument();
    expect(box("Enable client CA file reload")).not.toBeChecked();
    expect(box("Include system CA certificates pool")).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Min TLS Version" })).toHaveTextContent("TLS 1.2");
    expect(screen.getByRole("combobox", { name: "Max TLS Version" })).toHaveTextContent("TLS 1.3");
    expect(field("Reload Interval")).toHaveAttribute("placeholder", "0s");
    expect(hint("How often to reload certificates, e.g. 1h or 30m. · Default 0s (disabled)")).toBeInTheDocument();
    expect(hint("Default 1.2")).toBeInTheDocument();
    expect(hint("Default 1.3")).toBeInTheDocument();
    expect(screen.queryByText(CLIENT_TLS_HINT)).toBeNull();
  });

  it("a field writes only its key under the block", async () => {
    const user = userEvent.setup();
    renderIn("exporters.otlp/tls", <TLSConfigSection path={["tls"]} protocolLabel="OTLP gRPC" variant="client" />);
    await user.type(field("Certificate File"), "/etc/cert.pem");
    await user.tab();
    expect(text()).toBe(
      TEXT.replace("      insecure_skip_verify: true\n", "      insecure_skip_verify: true\n      cert_file: /etc/cert.pem\n"),
    );
  });
});

describe("headers (decision 4)", () => {
  it("a rename keeps focus while typing, commits once on Enter, and keeps the header's place and comment", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const name = screen.getByDisplayValue("X-First");
    await user.click(name);
    await user.keyboard("{End}");
    for (const key of ["-", "R", "e", "n"]) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(name).toHaveValue("X-First-Ren");

    await user.keyboard("{Enter}");
    expect(calls).toEqual([[{ path: ["headers", "X-First"], renameTo: "X-First-Ren" }]]);
    expect(text()).toBe(TEXT.replace("      X-First: one # first\n", "      X-First-Ren: one # first\n"));
    expect(document.activeElement).toBe(name);
    expect(screen.getAllByPlaceholderText("Header name").map((input) => (input as HTMLInputElement).value)).toEqual([
      "X-First-Ren",
      "X-Second",
      "X-Third",
    ]);

    // Blur after the commit writes nothing more.
    await user.tab();
    expect(calls).toHaveLength(1);
  });

  it("a rename commits on blur", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const name = screen.getByDisplayValue("X-Third");
    await user.clear(name);
    await user.type(name, "X-Last");
    expect(calls).toEqual([]);
    await user.tab();
    expect(calls).toEqual([[{ path: ["headers", "X-Third"], renameTo: "X-Last" }]]);
    expect(text()).toBe(TEXT.replace("      X-Third: three\n", "      X-Last: three\n"));
  });

  it("a name another header has is refused with its message, and the row shows its name again", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const name = screen.getByDisplayValue("X-Second");
    await user.clear(name);
    await user.type(name, "X-First{Enter}");
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(screen.getByText(HEADER_EXISTS_MESSAGE)).toBeInTheDocument();
    expect(HEADER_EXISTS_MESSAGE).toBe("A header with this name already exists.");
    expect(name).toHaveValue("X-Second");

    // Typing again clears it.
    await user.type(name, "b");
    expect(screen.queryByText(HEADER_EXISTS_MESSAGE)).toBeNull();
  });

  it("two refused renames show a message under each row; each follows its row and clears with its own typing (D9c final review M3)", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const first = screen.getByDisplayValue("X-First");
    const third = screen.getByDisplayValue("X-Third");
    /** The message under a name's row, if any (the row's next sibling). */
    const messageUnder = (name: HTMLElement) => {
      const next = name.parentElement!.nextElementSibling;
      return next?.textContent === HEADER_EXISTS_MESSAGE ? next : null;
    };
    await user.clear(first);
    await user.type(first, "X-Second{Enter}");
    await user.clear(third);
    await user.type(third, "X-Second{Enter}");
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(screen.getAllByText(HEADER_EXISTS_MESSAGE)).toHaveLength(2);
    expect(messageUnder(first)).not.toBeNull();
    expect(messageUnder(third)).not.toBeNull();

    // Removing the row between them: each message stays under its own row.
    await user.click(screen.getAllByRole("button", { name: "Remove header" })[1]!);
    expect(text()).toBe(TEXT.replace("      X-Second: two\n", ""));
    expect(screen.getAllByText(HEADER_EXISTS_MESSAGE)).toHaveLength(2);
    expect(messageUnder(first)).not.toBeNull();
    expect(messageUnder(third)).not.toBeNull();

    // Typing in one row clears its message only.
    await user.type(third, "x");
    expect(messageUnder(third)).toBeNull();
    expect(messageUnder(first)).not.toBeNull();
  });

  it("a refused row's message goes when its name changes from outside, and shows again when undo brings the name back (D9b's rule)", async () => {
    const user = userEvent.setup();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    /** Each row's name, with "!" when the message is under it. */
    const rows = () =>
      (screen.getAllByPlaceholderText("Header name") as HTMLInputElement[])
        .map((name) => name.value + (name.parentElement!.nextElementSibling?.textContent === HEADER_EXISTS_MESSAGE ? "!" : ""))
        .join(",");
    for (const [from, to] of [["X-First", "X-Second"], ["X-Third", "X-Second"]] as const) {
      const name = screen.getByDisplayValue(from);
      await user.clear(name);
      await user.type(name, `${to}{Enter}`);
    }
    expect(rows()).toBe("X-First!,X-Second,X-Third!");

    // The YAML box renames X-First: its row is X-Zed's now, with no message; X-Third's stays.
    act(() => builderStore().setText(TEXT.replace("      X-First: one # first\n", "      X-Zed: one # first\n")));
    act(() => void builderStore().apply());
    expect(rows()).toBe("X-Zed,X-Second,X-Third!");

    // Undo brings X-First back: the row has the name it was refused on again, so its message shows, as D9b's.
    act(() => void builderStore().undo());
    expect(text()).toBe(TEXT);
    expect(rows()).toBe("X-First!,X-Second,X-Third!");
  });

  it("a renamed name is trimmed, and a clash is checked once trimmed (Ruling 76)", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const name = screen.getByDisplayValue("X-Second");
    // Another header's name with spaces around it is that name: refused.
    await user.clear(name);
    await user.type(name, " X-First {Enter}");
    expect(calls).toEqual([]);
    expect(screen.getByText(HEADER_EXISTS_MESSAGE)).toBeInTheDocument();
    expect(name).toHaveValue("X-Second");

    // Its own name with spaces is no rename.
    await user.clear(name);
    await user.type(name, "X-Second  ");
    await user.tab();
    expect(calls).toEqual([]);
    expect(name).toHaveValue("X-Second");

    // A new name is written trimmed.
    await user.clear(name);
    await user.type(name, "  X-New ");
    await user.tab();
    expect(calls).toEqual([[{ path: ["headers", "X-Second"], renameTo: "X-New" }]]);
    expect(text()).toBe(TEXT.replace("      X-Second:", "      X-New:"));
  });

  it("an empty name isn't a rename", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const name = screen.getByDisplayValue("X-Second");
    await user.clear(name);
    await user.tab();
    expect(calls).toEqual([]);
    expect(name).toHaveValue("X-Second");
  });

  it("a value is written to its header; clearing it writes an empty string", async () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} />);
    const value = screen.getByDisplayValue("two");
    fireEvent.change(value, { target: { value: "2" } });
    act(() => vi.advanceTimersByTime(300));
    expect(calls).toEqual([[{ path: ["headers", "X-Second"], value: "2" }]]);
    expect(text()).toBe(TEXT.replace("      X-Second: two\n", '      X-Second: "2"\n'));
    fireEvent.change(value, { target: { value: "" } });
    fireEvent.blur(value);
    expect(text()).toBe(TEXT.replace("      X-Second: two\n", '      X-Second: ""\n'));
  });

  it("the staging row adds a trimmed header on Enter, and refuses a name another header has", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.otlp", <HeadersConfigSection path={["headers"]} title="gRPC Metadata Headers" description="Sent." />);
    expect(screen.getByText("gRPC Metadata Headers")).toBeInTheDocument();
    expect(screen.getByText("Press Enter to add.")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. Authorization"), " X-Fourth ");
    await user.type(screen.getByPlaceholderText("e.g. Bearer token"), " four {Enter}");
    expect(calls).toEqual([[{ path: ["headers", "X-Fourth"], value: "four" }]]);
    expect(text()).toBe(TEXT.replace("      X-Third: three\n", "      X-Third: three\n      X-Fourth: four\n"));
    expect(screen.getByPlaceholderText("e.g. Authorization")).toHaveValue("");

    await user.type(screen.getByPlaceholderText("e.g. Authorization"), "X-First{Enter}");
    expect(calls).toHaveLength(1);
    expect(screen.getByText(HEADER_EXISTS_MESSAGE)).toBeInTheDocument();
  });

  it("removing a header removes its lines; removing the last removes headers", async () => {
    const user = userEvent.setup();
    renderIn(
      "exporters.otlp/tls",
      <HeadersConfigSection path={["headers"]} title={null} description="Sent on every request." />,
    );
    expect(screen.getByText("Sent on every request.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove header" }));
    expect(text()).toBe(TEXT.replace("    headers:\n      X-Only: only\n", ""));
    expect(screen.queryByDisplayValue("X-Only")).toBeNull();
  });

  it("adding to an absent mapping creates it", async () => {
    const user = userEvent.setup();
    renderIn("exporters.otlp/off", <HeadersConfigSection path={["headers"]} />);
    await user.type(screen.getByPlaceholderText("e.g. Authorization"), "Authorization");
    await user.click(screen.getByRole("button", { name: "Add header" }));
    expect(text()).toContain('    headers:\n      Authorization: ""\n');
  });

  it("a headers value that isn't a mapping can't be shown", () => {
    renderIn("exporters.otlp", <HeadersConfigSection path={["tokens"]} />);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. Authorization")).toBeNull();
  });
});

describe("StringListField", () => {
  it("adds a trimmed item, and each row's remove says Remove", async () => {
    const user = userEvent.setup();
    renderIn(
      "exporters.otlp",
      <StringListField path={["tokens"]} label="Tokens" description="Any listed token." placeholder="e.g. ${env:TOKEN}" />,
    );
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(screen.getByDisplayValue("alpha")).toHaveAttribute("readonly");
    await user.type(screen.getByPlaceholderText("e.g. ${env:TOKEN}"), " gamma {Enter}");
    expect(text()).toBe(TEXT.replace("      - beta\n", "      - beta\n      - gamma\n"));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
    expect(text()).toBe(TEXT.replace("      - alpha\n      - beta\n", "      - beta\n      - gamma\n"));
  });

  it("removing the last item leaves [] or, with emptyRemovesKey, removes the key", async () => {
    const user = userEvent.setup();
    const single = TEXT.replace("      - alpha\n      - beta\n", "      - alpha\n");
    const { unmount } = renderIn("exporters.otlp", <StringListField path={["tokens"]} label="Tokens" placeholder="t" />, single);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(text()).toBe(single.replace("    tokens:\n      - alpha\n", "    tokens: []\n"));
    unmount();

    renderIn("exporters.otlp", <StringListField path={["tokens"]} label="Tokens" placeholder="t" emptyRemovesKey />, single);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(text()).toBe(single.replace("    tokens:\n      - alpha\n", ""));
  });
});

describe("a disabled form", () => {
  it("disables every toggle and row", () => {
    openText(TEXT);
    const nodeId = componentNamed("exporters.otlp").id;
    act(() => useEditorStore.setState({ isYamlEditing: true }));
    render(
      <ComponentForm nodeId={nodeId}>
        <RetryConfigSection path={["retry_on_failure"]} />
        <SendingQueueSection path={["sending_queue"]} />
        <HeadersConfigSection path={["headers"]} />
        <StringListField path={["tokens"]} label="Tokens" placeholder="t" />
      </ComponentForm>,
    );
    expect(box("Enable Retry on Failure")).toBeDisabled();
    expect(box("Enable Sending Queue")).toBeDisabled();
    expect(screen.getByDisplayValue("X-First")).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /Remove/ })) expect(button).toBeDisabled();
  });
});

describe("privacy (decision 10)", () => {
  it("no attribute in the sections holds a value, and none sits inside a <form>", async () => {
    const user = userEvent.setup();
    const MARK = "MARKER";
    const marked = TEXT.replaceAll("X-First", `X-${MARK}-name`)
      .replace("one # first", `${MARK}-value # first`)
      .replace("/etc/ca.crt", `/etc/${MARK}.crt`)
      .replace("https://one.example.com", `https://${MARK}.example.com`)
      .replace("- alpha", `- ${MARK}-token`)
      .replace("max_interval: 45s", `max_interval: \${env:${MARK}}`)
      .replace("queue_size: 50", `queue_size: \${env:${MARK}_SIZE}`)
      .replace("    tls:\n", `    tls:\n      min_version: "${MARK}"\n`);
    openText(marked);
    render(
      <>
        <ComponentForm nodeId={componentNamed("exporters.otlp").id}>
          <HeadersConfigSection path={["headers"]} />
          <RetryConfigSection path={["retry_on_failure"]} />
          <StringListField path={["tokens"]} label="Tokens" placeholder="t" />
        </ComponentForm>
        <ComponentForm nodeId={componentNamed("exporters.otlp/tls").id}>
          <TLSConfigSection path={["tls"]} protocolLabel="OTLP gRPC" variant="client" />
        </ComponentForm>
        <ComponentForm nodeId={componentNamed("exporters.otlp/off").id}>
          <SendingQueueSection path={["sending_queue"]} />
        </ComponentForm>
        <ComponentForm nodeId={componentNamed("receivers.otlp").id}>
          <CORSConfigSection path={["protocols", "http", "cors"]} />
          <TLSConfigSection path={["protocols", "grpc", "tls"]} protocolLabel="gRPC" variant="server" />
        </ComponentForm>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("combobox", { name: "Min TLS Version" }));
    expect(screen.getByRole("option", { name: MARK })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // A clash message shows under the row, as text.
    const name = screen.getByDisplayValue("X-Second");
    await user.clear(name);
    await user.type(name, `X-${MARK}-name{Enter}`);
    expect(screen.getByText(HEADER_EXISTS_MESSAGE)).toBeInTheDocument();
    // The picker's rows are text.
    await user.type(screen.getByDisplayValue(`X-${MARK}-name`), "$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name === "value" && element instanceof HTMLInputElement) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});
