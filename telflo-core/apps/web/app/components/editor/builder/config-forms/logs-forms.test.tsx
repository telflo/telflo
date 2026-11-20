import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  ATTRIBUTE_NOUNS,
  DELETE_HINT,
  DELETE_UNTICKED,
  ENCODING_RESET,
  FilelogReceiverForm,
  MULTILINE_REMOVED,
  START_AT_SET,
} from "./FilelogReceiverForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { FILES_HINT, JOURNALCTL_ABSOLUTE, JournaldReceiverForm, MATCH_NOUNS } from "./JournaldReceiverForm.js";
import { formFor } from "./registry.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The file and journal receivers' forms: the filelog and journald forms over
 * the form contract. Each field is driven as a person would (typing, clicking,
 * picking) on the logs corpus (comments, an anchor and an alias, a merge, flow
 * lists, `0750`), LF and CRLF, and writes only its key: the text changes in
 * that key's lines only, as one undo entry, and parses to the value. The fixes
 * each have a test that fails if the bug returns: filelog's adjustments with
 * their toasts (no inline alert), its attribute maps' held rows and clash, a
 * YAML edit kept by the next form edit; journald's held match, its fields'
 * held rows, renames and clash, and the corrected copy. The journald cases
 * cover the seed and the lists' shapes.
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

const FILELOG = "receivers.filelog";
const JOURNALD = "receivers.journald";
const SOURCE = "receivers.journald/source";

const FORM_OF: Record<string, () => ReactNode> = {
  [FILELOG]: () => <FilelogReceiverForm />,
  [JOURNALD]: () => <JournaldReceiverForm />,
  [SOURCE]: () => <JournaldReceiverForm />,
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
/** A hint line, by its whole text ("… · Default 200ms" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};
/** `typed` as user-event types it: `[` and `{` are its key descriptors, doubled to type them. */
const literal = (typed: string) => typed.replace(/[[{]/g, "$&$&");

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, literal(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title.replace(/[&]/g, "\\$&")}`) }));
}

/**
 * Opens every collapsed section and card, again until none is left (a card
 * holds sections). The Add Operator button (a dialog's trigger, also
 * `aria-expanded`) isn't one: its modal would hide the form.
 */
async function openEverything(user: UserEvent) {
  for (let round = 0; round < 4; round++) {
    const closed = screen.queryAllByRole("button", { expanded: false }).filter((button) => !button.textContent?.startsWith("Add Operator"));
    if (closed.length === 0) return;
    for (const button of closed) await user.click(button);
  }
}

/** The inputs showing a placeholder, in order. */
const byPlaceholder = (placeholder: string) => screen.getAllByPlaceholderText(placeholder) as HTMLInputElement[];

/** The Metadata section's map, by its title's block. */
const mapBlock = (title: string) => screen.getByText(title).closest(".space-y-2") as HTMLElement;

/** The match cards, in order. */
const matchCards = () => [...document.querySelectorAll<HTMLElement>(".rounded-md.border.p-2")];

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

/** filelog's last lines, before journald: where a key filelog hasn't got is added. */
const FILELOG_END = '          - resource["service.name"]\n  journald:\n';
const filelogEnd = (added: string) => `          - resource["service.name"]\n${added}  journald:\n`;
/** journald's last lines, before syslog. */
const JOURNALD_END = "      - noop # not a mapping\n  syslog:\n";
const journaldEnd = (added: string) => `      - noop # not a mapping\n${added}  syslog:\n`;
/** journald/source's last lines, before syslog/udp. */
const SOURCE_END = "    storage: file_storage\n  syslog/udp:\n";
const sourceEnd = (added: string) => `    storage: file_storage\n${added}  syslog/udp:\n`;

const MULTILINE = "    multiline:\n      line_start_pattern: ^\\d{4}-\n";
/** filelog with the multiline box just ticked (the seed). */
const SEEDED_MULTILINE = CORPUS.replace(MULTILINE, '    multiline:\n      line_start_pattern: ""\n');
const NO_MULTILINE = CORPUS.replace(MULTILINE, "");

const MATCHES = '    matches:\n      - _SYSTEMD_UNIT: ssh.service\n        _UID: "1000"\n      - _TRANSPORT: kernel\n';

const CASES: FieldCase[] = [
  // filelog: the path lists
  {
    name: "filelog an include path retyped keeps its comment",
    key: FILELOG,
    edit: (user) => retypeInto(user, byPlaceholder("e.g. /var/log/*.log")[0]!, "/var/log/web/*.log"),
    from: "      - /var/log/app/*.log # the app\n",
    to: "      - /var/log/web/*.log # the app\n",
    check: (v) => expect(v.include).toEqual(["/var/log/web/*.log", "/var/log/sys/*.log"]),
  },
  {
    name: "filelog Add Path appends the seed",
    key: FILELOG,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Path" })),
    from: "      - /var/log/sys/*.log\n",
    to: "      - /var/log/sys/*.log\n      - /var/log/*.log\n",
    check: (v) => expect(v.include).toEqual(["/var/log/app/*.log", "/var/log/sys/*.log", "/var/log/*.log"]),
  },
  {
    name: "filelog an include path removed",
    key: FILELOG,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove" })[1]!),
    from: "      - /var/log/sys/*.log\n",
    to: "",
    check: (v) => expect(v.include).toEqual(["/var/log/app/*.log"]),
  },
  {
    name: "filelog an exclude path retyped in the flow list",
    key: FILELOG,
    edit: (user) => retypeInto(user, byPlaceholder("e.g. /var/log/debug*.log")[0]!, "/var/log/app/trace.log"),
    from: "    exclude: [/var/log/app/debug.log]\n",
    to: "    exclude: [/var/log/app/trace.log]\n",
    check: (v) => expect(v.exclude).toEqual(["/var/log/app/trace.log"]),
  },
  {
    name: "filelog Add Exclusion appends the seed",
    key: FILELOG,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Exclusion" })),
    from: "    exclude: [/var/log/app/debug.log]\n",
    to: "    exclude: [/var/log/app/debug.log, /var/log/excluded/*.log]\n",
    check: (v) => expect(v.exclude).toEqual(["/var/log/app/debug.log", "/var/log/excluded/*.log"]),
  },
  {
    name: "filelog the last exclude path removed removes the key",
    key: FILELOG,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove" })[2]!),
    from: "    exclude: [/var/log/app/debug.log]\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("exclude"),
  },
  // filelog: the top fields
  {
    name: "filelog Start Position picked",
    key: FILELOG,
    edit: (user) => pickIn(user, byId("start-at"), "End"),
    from: "    start_at: beginning\n",
    to: "    start_at: end\n",
    check: (v) => expect(v.start_at).toBe("end"),
  },
  {
    name: "filelog Encoding picked where none is set",
    key: FILELOG,
    edit: (user) => pickIn(user, byId("encoding"), "UTF-16 LE"),
    from: FILELOG_END,
    to: filelogEnd("    encoding: utf-16le\n"),
    check: (v) => expect(v.encoding).toBe("utf-16le"),
  },
  {
    name: "filelog Poll Interval retyped keeps its comment",
    key: FILELOG,
    edit: (user) => retypeInto(user, byId("poll-interval"), "1s"),
    from: "    poll_interval: 500ms # a busy disk\n",
    to: "    poll_interval: 1s # a busy disk\n",
    check: (v) => expect(v.poll_interval).toBe("1s"),
  },
  {
    name: "filelog Poll Interval cleared removes the key",
    key: FILELOG,
    edit: (user) => retypeInto(user, byId("poll-interval"), ""),
    from: "    poll_interval: 500ms # a busy disk\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("poll_interval"),
  },
  {
    name: "filelog Max Concurrent Files takes 0 (not hidden as \"\")",
    key: FILELOG,
    edit: (user) => retypeInto(user, byId("max-concurrent"), "0"),
    from: FILELOG_END,
    to: filelogEnd("    max_concurrent_files: 0\n"),
    check: (v) => expect(v.max_concurrent_files).toBe(0),
  },
  {
    name: "filelog Exclude Older Than",
    key: FILELOG,
    edit: (user) => retypeInto(user, byId("exclude-older"), "24h"),
    from: FILELOG_END,
    to: filelogEnd("    exclude_older_than: 24h\n"),
    check: (v) => expect(v.exclude_older_than).toBe("24h"),
  },
  // filelog: Operators
  {
    name: "filelog Add Operator appends the type's seed",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Operators");
      await user.click(screen.getByRole("button", { name: "Add Operator" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^No-Op / }));
    },
    from: FILELOG_END,
    to: '          - resource["service.name"]\n      - type: noop\n  journald:\n',
    check: (v) => expect((v.operators as Value[]).at(-1)).toEqual({ type: "noop" }),
  },
  // filelog: Multiline Parsing
  {
    name: "filelog the multiline box unticked removes the block",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Multiline Parsing");
      await user.click(byId("multiline-enable"));
    },
    from: MULTILINE,
    to: "",
    check: (v) => expect(v).not.toHaveProperty("multiline"),
  },
  {
    name: "filelog the multiline box ticked writes {line_start_pattern: \"\"}",
    key: FILELOG,
    base: NO_MULTILINE,
    edit: async (user) => {
      await openSection(user, "Multiline Parsing");
      await user.click(byId("multiline-enable"));
    },
    from: FILELOG_END,
    to: filelogEnd('    multiline:\n      line_start_pattern: ""\n'),
    check: (v) => expect(v.multiline).toEqual({ line_start_pattern: "" }),
  },
  {
    name: "filelog Line Start Pattern retyped",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Multiline Parsing");
      await retypeInto(user, byId("line-start"), "^INFO");
    },
    from: "      line_start_pattern: ^\\d{4}-\n",
    to: "      line_start_pattern: ^INFO\n",
    check: (v) => expect(v.multiline).toEqual({ line_start_pattern: "^INFO" }),
  },
  {
    name: "filelog Line End Pattern typed removes the start pattern in the same change (split.go:77)",
    key: FILELOG,
    base: SEEDED_MULTILINE,
    edit: async (user) => {
      await openSection(user, "Multiline Parsing");
      await retypeInto(user, byId("line-end"), "^END");
    },
    from: '    multiline:\n      line_start_pattern: ""\n',
    to: "    multiline:\n      line_end_pattern: ^END\n",
    check: (v) => expect(v.multiline).toEqual({ line_end_pattern: "^END" }),
  },
  {
    name: "filelog Omit pattern ticked",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Multiline Parsing");
      await user.click(byId("omit-pattern"));
    },
    from: MULTILINE,
    to: `${MULTILINE}      omit_pattern: true\n`,
    check: (v) => expect(v.multiline).toEqual({ line_start_pattern: "^\\d{4}-", omit_pattern: true }),
  },
  // filelog: Performance & Limits
  ...(
    [
      ["max-log-size", "max_log_size", "2MiB", "2MiB"],
      ["fingerprint-size", "fingerprint_size", "2kb", "2kb"],
      ["flush-period", "force_flush_period", "1s", "1s"],
      ["max-batches", "max_batches", "10", 10],
      ["buffer-size", "initial_buffer_size", "32KiB", "32KiB"],
    ] as const
  ).map(
    ([id, key, typed, parsed]): FieldCase => ({
      name: `filelog ${key}`,
      key: FILELOG,
      edit: async (user) => {
        await openSection(user, "Performance & Limits");
        await retypeInto(user, byId(id), typed);
      },
      from: FILELOG_END,
      to: filelogEnd(`    ${key}: ${typed}\n`),
      check: (v) => expect(v[key]).toBe(parsed),
    }),
  ),
  ...(
    [
      ["preserve-leading", "preserve_leading_whitespaces"],
      ["preserve-trailing", "preserve_trailing_whitespaces"],
    ] as const
  ).map(
    ([id, key]): FieldCase => ({
      name: `filelog ${key} ticked`,
      key: FILELOG,
      edit: async (user) => {
        await openSection(user, "Performance & Limits");
        await user.click(byId(id));
      },
      from: FILELOG_END,
      to: filelogEnd(`    ${key}: true\n`),
      check: (v) => expect(v[key]).toBe(true),
    }),
  ),
  // filelog: Storage & File Handling
  {
    name: "filelog Storage Extension ID retyped",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Storage & File Handling");
      await retypeInto(user, byId("storage"), "db_storage");
    },
    from: "    storage: file_storage\n    multiline:",
    to: "    storage: db_storage\n    multiline:",
    check: (v) => expect(v.storage).toBe("db_storage"),
  },
  {
    name: "filelog Compression picked",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Storage & File Handling");
      await pickIn(user, byId("compression"), "Auto-detect");
    },
    from: "    compression: gzip\n",
    to: "    compression: auto\n",
    check: (v) => expect(v.compression).toBe("auto"),
  },
  {
    name: "filelog Compression None removes the key",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Storage & File Handling");
      await pickIn(user, byId("compression"), "None");
    },
    from: "    compression: gzip\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("compression"),
  },
  {
    name: "filelog Delete file after reading ticked (Start Position already Beginning)",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Storage & File Handling");
      await user.click(byId("delete-after-read"));
    },
    from: FILELOG_END,
    to: filelogEnd("    delete_after_read: true\n"),
    check: (v) => expect(v.delete_after_read).toBe(true),
  },
  {
    name: "filelog Acquire filesystem lock ticked",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Storage & File Handling");
      await user.click(byId("fs-lock"));
    },
    from: FILELOG_END,
    to: filelogEnd("    acquire_fs_lock: true\n"),
    check: (v) => expect(v.acquire_fs_lock).toBe(true),
  },
  // filelog: Metadata
  {
    name: "filelog File name unticked (ticked while unset: IncludeFileName, config.go:73-75)",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      await user.click(byId("attr-file-name"));
    },
    from: FILELOG_END,
    to: filelogEnd("    include_file_name: false\n"),
    check: (v) => expect(v.include_file_name).toBe(false),
  },
  {
    name: "filelog File path unticked in place",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      await user.click(byId("attr-file-path"));
    },
    from: "    include_file_path: true\n",
    to: "    include_file_path: false\n",
    check: (v) => expect(v.include_file_path).toBe(false),
  },
  ...(
    [
      ["attr-name-resolved", "include_file_name_resolved"],
      ["attr-path-resolved", "include_file_path_resolved"],
      ["attr-owner", "include_file_owner_name"],
      ["attr-group", "include_file_owner_group_name"],
      ["attr-record-num", "include_file_record_number"],
      ["attr-record-offset", "include_file_record_offset"],
    ] as const
  ).map(
    ([id, key]): FieldCase => ({
      name: `filelog ${key} ticked`,
      key: FILELOG,
      edit: async (user) => {
        await openSection(user, "Metadata");
        await user.click(byId(id));
      },
      from: FILELOG_END,
      to: filelogEnd(`    ${key}: true\n`),
      check: (v) => expect(v[key]).toBe(true),
    }),
  ),
  {
    name: "filelog a resource attribute's value retyped",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      await retypeInto(user, within(mapBlock("Resource Attributes")).getByDisplayValue("checkout"), "payments");
    },
    from: "      service.name: checkout\n",
    to: "      service.name: payments\n",
    check: (v) => expect(v.resource).toEqual({ "service.name": "payments" }),
  },
  {
    name: "filelog a resource attribute renamed in place",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      await retypeInto(user, within(mapBlock("Resource Attributes")).getByDisplayValue("service.name"), "service.namespace");
    },
    from: "      service.name: checkout\n",
    to: "      service.namespace: checkout\n",
    check: (v) => expect(v.resource).toEqual({ "service.namespace": "checkout" }),
  },
  {
    name: "filelog Add Attribute holds a row; its key committed writes it with the value it holds",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      const block = mapBlock("Log Attributes");
      await user.click(within(block).getByRole("button", { name: "Add Attribute" }));
      expect(entries()).toBe(0);
      await user.type(within(block).getAllByPlaceholderText(ATTRIBUTE_NOUNS.value).at(-1)!, "prod");
      await user.type(within(block).getAllByPlaceholderText(ATTRIBUTE_NOUNS.key).at(-1)!, "env{Enter}");
    },
    from: "      team: platform # who owns it\n",
    to: "      team: platform # who owns it\n      env: prod\n",
    check: (v) => expect(v.attributes).toEqual({ team: "platform", env: "prod" }),
  },
  {
    name: "filelog the last log attribute removed removes the map",
    key: FILELOG,
    edit: async (user) => {
      await openSection(user, "Metadata");
      await user.click(within(mapBlock("Log Attributes")).getByRole("button", { name: "Remove" }));
    },
    from: "    attributes:\n      team: platform # who owns it\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("attributes"),
  },

  // journald: the top fields
  {
    name: "journald Start At: Beginning",
    key: JOURNALD,
    edit: (user) => user.click(screen.getByRole("radio", { name: "Beginning" })),
    from: "    start_at: end\n",
    to: "    start_at: beginning\n",
    check: (v) => expect(v.start_at).toBe("beginning"),
  },
  {
    name: "journald Priority retyped",
    key: JOURNALD,
    edit: (user) => retypeInto(user, byId("priority"), "err"),
    from: "    priority: info\n",
    to: "    priority: err\n",
    check: (v) => expect(v.priority).toBe("err"),
  },
  // journald: Filtering
  {
    name: "journald a unit retyped in the flow list",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, byPlaceholder("e.g. ssh")[1]!, "cron");
    },
    from: "    units: [ssh, sudo]\n",
    to: "    units: [ssh, cron]\n",
    check: (v) => expect(v.units).toEqual(["ssh", "cron"]),
  },
  {
    name: "journald Add unit appends the seed",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getByRole("button", { name: "Add unit" }));
    },
    from: "    units: [ssh, sudo]\n",
    to: "    units: [ssh, sudo, ssh]\n",
    check: (v) => expect(v.units).toEqual(["ssh", "sudo", "ssh"]),
  },
  {
    name: "journald a unit removed",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getAllByRole("button", { name: "Remove Units entry" })[0]!);
    },
    from: "    units: [ssh, sudo]\n",
    to: "    units: [sudo]\n",
    check: (v) => expect(v.units).toEqual(["sudo"]),
  },
  {
    name: "journald Add identifier appends the seed",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getByRole("button", { name: "Add identifier" }));
    },
    from: "    identifiers: [sudo]\n",
    to: "    identifiers: [sudo, sudo]\n",
    check: (v) => expect(v.identifiers).toEqual(["sudo", "sudo"]),
  },
  {
    name: "journald the last identifier removed removes the key",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getByRole("button", { name: "Remove Identifiers entry" }));
    },
    from: "    identifiers: [sudo]\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("identifiers"),
  },
  {
    name: "journald a match field's value retyped",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, screen.getByDisplayValue("ssh.service"), "cron.service");
    },
    from: "      - _SYSTEMD_UNIT: ssh.service\n",
    to: "      - _SYSTEMD_UNIT: cron.service\n",
    check: (v) => expect((v.matches as Value[])[0]).toEqual({ _SYSTEMD_UNIT: "cron.service", _UID: "1000" }),
  },
  {
    name: "journald a match field renamed in place",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, screen.getByDisplayValue("_UID"), "_PID");
    },
    from: '        _UID: "1000"\n',
    to: '        _PID: "1000"\n',
    check: (v) => expect((v.matches as Value[])[0]).toEqual({ _SYSTEMD_UNIT: "ssh.service", _PID: "1000" }),
  },
  {
    name: "journald Add field holds a row; its name committed writes it with its value",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      const card = matchCards()[1]!;
      await user.click(within(card).getByRole("button", { name: "Add field" }));
      expect(entries()).toBe(0);
      await user.type(within(card).getAllByPlaceholderText(MATCH_NOUNS.value).at(-1)!, "10");
      await user.type(within(card).getAllByPlaceholderText(MATCH_NOUNS.key).at(-1)!, "_PRIORITY{Enter}");
    },
    from: "      - _TRANSPORT: kernel\n",
    to: '      - _TRANSPORT: kernel\n        _PRIORITY: "10"\n',
    check: (v) => expect((v.matches as Value[])[1]).toEqual({ _TRANSPORT: "kernel", _PRIORITY: "10" }),
  },
  {
    name: "journald a match field removed",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(within(matchCards()[0]!).getAllByRole("button", { name: "Remove field" })[1]!);
    },
    from: '        _UID: "1000"\n',
    to: "",
    check: (v) => expect((v.matches as Value[])[0]).toEqual({ _SYSTEMD_UNIT: "ssh.service" }),
  },
  {
    name: "journald a match removed",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getByRole("button", { name: "Remove match 2" }));
    },
    from: "      - _TRANSPORT: kernel\n",
    to: "",
    check: (v) => expect(v.matches).toEqual([{ _SYSTEMD_UNIT: "ssh.service", _UID: "1000" }]),
  },
  {
    name: "journald Add match holds a match; its value typed appends it",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getByRole("button", { name: "Add match" }));
      expect(entries()).toBe(0);
      await user.type(within(matchCards()[2]!).getByPlaceholderText(MATCH_NOUNS.value), "cron.service");
      await user.tab();
    },
    from: "      - _TRANSPORT: kernel\n",
    to: "      - _TRANSPORT: kernel\n      - _SYSTEMD_UNIT: cron.service\n",
    check: (v) => expect((v.matches as Value[])[2]).toEqual({ _SYSTEMD_UNIT: "cron.service" }),
  },
  {
    name: "journald Grep typed",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, byId("grep"), "denied");
    },
    from: JOURNALD_END,
    to: journaldEnd("    grep: denied\n"),
    check: (v) => expect(v.grep).toBe("denied"),
  },
  {
    name: "journald Kernel Messages Only unticked removes the key (true or removed)",
    key: JOURNALD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(byId("dmesg"));
    },
    from: "    dmesg: true\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("dmesg"),
  },
  // journald: Journal Source
  ...(
    [
      ["directory", "directory", "    directory: /var/log/journal # the host's\n", "    directory: /run/log/journal # the host's\n", "/run/log/journal"],
      ["root_path", "root_path", "    root_path: /host\n", "    root_path: /rootfs\n", "/rootfs"],
      ["namespace", "namespace", "    namespace: audit\n", "    namespace: app\n", "app"],
      ["journalctl_path", "journalctl_path", "    journalctl_path: /usr/bin/journalctl\n", "    journalctl_path: /bin/journalctl\n", "/bin/journalctl"],
    ] as const
  ).map(
    ([id, key, from, to, typed]): FieldCase => ({
      name: `journald ${key} retyped`,
      key: SOURCE,
      edit: async (user) => {
        await openSection(user, "Journal Source");
        await retypeInto(user, byId(id), typed);
      },
      from,
      to,
      check: (v) => expect(v[key]).toBe(typed),
    }),
  ),
  {
    name: "journald Root Path cleared removes the key",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Journal Source");
      await retypeInto(user, byId("root_path"), "");
    },
    from: "    root_path: /host\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("root_path"),
  },
  {
    name: "journald Add file appends the seed",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Journal Source");
      await user.click(screen.getByRole("button", { name: "Add file" }));
    },
    from: "      - /var/log/journal/a.journal\n",
    to: "      - /var/log/journal/a.journal\n      - /var/log/journal/system.journal\n",
    check: (v) => expect(v.files).toEqual(["/var/log/journal/a.journal", "/var/log/journal/system.journal"]),
  },
  {
    name: "journald Merge Journals unticked removes the key",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Journal Source");
      await user.click(byId("merge"));
    },
    from: "    merge: true\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("merge"),
  },
  // journald: Operators, Record Shaping, Storage, Retry
  {
    name: "journald Add Operator appends the type's seed",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Operators");
      await user.click(screen.getByRole("button", { name: "Add Operator" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^No-Op / }));
    },
    from: SOURCE_END,
    to: sourceEnd("    operators:\n      - type: noop\n"),
    check: (v) => expect(v.operators).toEqual([{ type: "noop" }]),
  },
  {
    name: "journald Include All Entries unticked removes the key",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Record Shaping");
      await user.click(byId("all"));
    },
    from: "    all: true\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("all"),
  },
  {
    name: "journald Convert Message Bytes ticked writes true",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Record Shaping");
      await user.click(byId("convert_message_bytes"));
    },
    from: SOURCE_END,
    to: sourceEnd("    convert_message_bytes: true\n"),
    check: (v) => expect(v.convert_message_bytes).toBe(true),
  },
  {
    name: "journald Storage Extension ID retyped",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Storage");
      await retypeInto(user, byId("storage"), "db_storage");
    },
    from: "    storage: file_storage\n  syslog/udp:",
    to: "    storage: db_storage\n  syslog/udp:",
    check: (v) => expect(v.storage).toBe("db_storage"),
  },
  {
    name: "journald Enable Retry ticked writes enabled: true, no multiplier",
    key: SOURCE,
    edit: async (user) => {
      await openSection(user, "Retry on Failure");
      await user.click(byId("stanza-retry-enabled"));
    },
    from: SOURCE_END,
    to: sourceEnd("    retry_on_failure:\n      enabled: true\n"),
    check: (v) => expect(v.retry_on_failure).toEqual({ enabled: true }),
  },
];

describe("every field of each form writes only its key", () => {
  // Its own time limit.
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
    20_000,
  );
});

// ── filelog: the adjustments ──

describe("filelog: a control that would leave a refused combination adjusts the other", () => {
  /** filelog reading from the end, and one deleting (which the collector refuses). */
  const AT_END = CORPUS.replace("    start_at: beginning\n", "    start_at: end\n");
  const DELETING = CORPUS.replace("    start_at: beginning\n", "    start_at: beginning\n    delete_after_read: true\n");

  // fileconsumer/config.go:246-253: "'delete_after_read' cannot be used with 'start_at: end'".
  it("ticking Delete file after reading sets Start Position to Beginning, in one change, toasted once, with no inline alert", async () => {
    const user = renderForm(FILELOG, AT_END);
    await openSection(user, "Storage & File Handling");
    await user.click(byId("delete-after-read"));

    expect(text()).toBe(AT_END.replace("    start_at: end\n", "    start_at: beginning\n").replace(FILELOG_END, filelogEnd("    delete_after_read: true\n")));
    expect(entries()).toBe(1);
    expect(screen.queryByText(START_AT_SET)).toBeNull();
    expect(infoToasts()).toEqual([START_AT_SET]);
    expect(byId("start-at")).toHaveTextContent("Beginning");

    // The next change toasts nothing more.
    await retypeInto(user, byId("poll-interval"), "2s");
    expect(infoToasts()).toEqual([START_AT_SET]);

    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(AT_END);
  });

  it("with Start Position unset (the collector's end), ticking it writes start_at: beginning too", async () => {
    const base = CORPUS.replace("    start_at: beginning\n", "");
    const user = renderForm(FILELOG, base);
    await openSection(user, "Storage & File Handling");
    await user.click(byId("delete-after-read"));
    expect(valueOf(text(), FILELOG)).toMatchObject({ start_at: "beginning", delete_after_read: true });
    expect(entries()).toBe(1);
    expect(screen.queryByText(START_AT_SET)).toBeNull();
    expect(infoToasts()).toEqual([START_AT_SET]);
  });

  it("with Start Position already Beginning, ticking it writes it alone, with no toast", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Storage & File Handling");
    await user.click(byId("delete-after-read"));
    expect(valueOf(text(), FILELOG).start_at).toBe("beginning");
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("choosing End while deleting unticks Delete file after reading (writes false), in one change, with the toast and no inline alert", async () => {
    const user = renderForm(FILELOG, DELETING);
    await pickIn(user, byId("start-at"), "End");
    expect(text()).toBe(DELETING.replace("    start_at: beginning\n    delete_after_read: true\n", "    start_at: end\n    delete_after_read: false\n"));
    expect(entries()).toBe(1);
    expect(screen.queryByText(DELETE_UNTICKED)).toBeNull();
    expect(infoToasts()).toEqual([DELETE_UNTICKED]);
    act(() => void builderStore().undo());
    expect(text()).toBe(DELETING);
  });

  it("choosing End while not deleting writes Start Position alone, with no toast", async () => {
    const user = renderForm(FILELOG);
    await pickIn(user, byId("start-at"), "End");
    expect(valueOf(text(), FILELOG)).not.toHaveProperty("delete_after_read");
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // pkg/stanza/split/split.go:47-55: "line_start_pattern should not be set when using nop encoding".
  it('choosing "No validation (raw bytes)" removes the multiline block, in one change, with the toast and no inline alert', async () => {
    const user = renderForm(FILELOG);
    await pickIn(user, byId("encoding"), "No validation (raw bytes)");
    expect(text()).toBe(CORPUS.replace(MULTILINE, "").replace(FILELOG_END, filelogEnd("    encoding: nop\n")));
    expect(entries()).toBe(1);
    expect(screen.queryByText(MULTILINE_REMOVED)).toBeNull();
    expect(infoToasts()).toEqual([MULTILINE_REMOVED]);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("with no multiline block, raw bytes is written alone, with no toast", async () => {
    const user = renderForm(FILELOG, NO_MULTILINE);
    await pickIn(user, byId("encoding"), "No validation (raw bytes)");
    expect(text()).toBe(NO_MULTILINE.replace(FILELOG_END, filelogEnd("    encoding: nop\n")));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // An empty pattern splits nothing, so raw bytes can take it (split/split.go:47-59).
  it('"No validation (raw bytes)" keeps a multiline block with no pattern, with no toast', async () => {
    const user = renderForm(FILELOG, SEEDED_MULTILINE);
    await pickIn(user, byId("encoding"), "No validation (raw bytes)");
    expect(text()).toBe(SEEDED_MULTILINE.replace(FILELOG_END, filelogEnd("    encoding: nop\n")));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // split/split.go:47-55 refuses a pattern with raw bytes; the encoding goes, the collector's utf-8 then.
  const RAW = NO_MULTILINE.replace("    compression: gzip\n", "    compression: gzip\n    encoding: nop\n");
  it("ticking Enable multiline parsing while the encoding is raw bytes removes the encoding, in one change, with the toast and no inline alert", async () => {
    const user = renderForm(FILELOG, RAW);
    await openSection(user, "Multiline Parsing");
    await user.click(byId("multiline-enable"));
    expect(text()).toBe(NO_MULTILINE.replace(FILELOG_END, filelogEnd('    multiline:\n      line_start_pattern: ""\n')));
    expect(entries()).toBe(1);
    expect(screen.queryByText(ENCODING_RESET)).toBeNull();
    expect(infoToasts()).toEqual([ENCODING_RESET]);
    expect(byId("encoding")).toHaveTextContent("UTF-8");
    act(() => void builderStore().undo());
    expect(text()).toBe(RAW);
  });

  it("typing a pattern while the encoding is raw bytes removes the encoding in the same change, with the toast and no inline alert", async () => {
    const base = RAW.replace(FILELOG_END, filelogEnd('    multiline:\n      line_start_pattern: ""\n'));
    const user = renderForm(FILELOG, base);
    await openSection(user, "Multiline Parsing");
    await retypeInto(user, byId("line-end"), "^END");
    expect(text()).toBe(
      NO_MULTILINE.replace(FILELOG_END, filelogEnd("    multiline:\n      line_end_pattern: ^END\n")),
    );
    expect(entries()).toBe(1);
    expect(screen.queryByText(ENCODING_RESET)).toBeNull();
    expect(infoToasts()).toEqual([ENCODING_RESET]);
  });

  it("with another encoding, ticking multiline or typing a pattern writes it alone, with no toast", async () => {
    const user = renderForm(FILELOG, NO_MULTILINE);
    await openSection(user, "Multiline Parsing");
    await user.click(byId("multiline-enable"));
    await retypeInto(user, byId("line-start"), "^x");
    expect(valueOf(text(), FILELOG)).not.toHaveProperty("encoding");
    expect(infoToasts()).toEqual([]);
  });

  // The "Deletes source files" alert is a hint under the box, always shown;
  // the gate filelog.allowFileDeletion is at stage beta, on by default
  // (pkg/stanza/fileconsumer/internal/metadata/generated_feature_gates.go).
  it("the delete hint shows under the box whether or not it's ticked; the old alert is gone", async () => {
    expect(DELETE_HINT).toBe("Deletes each file once it's read. Needs the filelog.allowFileDeletion feature gate (on by default).");
    const user = renderForm(FILELOG, DELETING);
    await openSection(user, "Storage & File Handling");
    expect(byId("delete-after-read")).toBeChecked();
    expect(screen.getByText(DELETE_HINT)).toBeInTheDocument();
    expect(screen.queryByText("Deletes source files")).toBeNull();
    await user.click(byId("delete-after-read"));
    expect(valueOf(text(), FILELOG).delete_after_read).toBe(false);
    expect(byId("delete-after-read")).not.toBeChecked();
    expect(screen.getByText(DELETE_HINT)).toBeInTheDocument();
  });

  it("the delete hint shows while the key is unset", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Storage & File Handling");
    expect(valueOf(text(), FILELOG)).not.toHaveProperty("delete_after_read");
    expect(byId("delete-after-read")).not.toBeChecked();
    expect(screen.getByText(DELETE_HINT)).toBeInTheDocument();
  });
});

// ── filelog: the rest of its fixes ──

describe("filelog: read from the text", () => {
  it("a YAML edit of resource is kept by the next form edit (no stale map written back)", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Metadata");
    const edited = CORPUS.replace("      service.name: checkout\n", "      service.name: checkout\n      deployment.environment: prod # typed in the YAML\n");
    act(() => builderStore().setText(edited));
    act(() => void builderStore().apply());
    expect(text()).toBe(edited);
    expect(within(mapBlock("Resource Attributes")).getByDisplayValue("prod")).toBeInTheDocument();

    await retypeInto(user, within(mapBlock("Resource Attributes")).getByDisplayValue("checkout"), "payments");
    expect(text()).toBe(edited.replace("      service.name: checkout\n", "      service.name: payments\n"));
    expect(valueOf(text(), FILELOG).resource).toEqual({ "service.name": "payments", "deployment.environment": "prod" });
  });

  it("the multiline box follows the text: a block removed in the YAML unticks it", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Multiline Parsing");
    expect(byId("multiline-enable")).toBeChecked();
    act(() => builderStore().setText(NO_MULTILINE));
    act(() => void builderStore().apply());
    expect(byId("multiline-enable")).not.toBeChecked();
    expect(byId("line-start")).toBeNull();
  });

  it("an attribute renamed to another row's key is refused under the row; the row shows its key again", async () => {
    const base = CORPUS.replace("      service.name: checkout\n", "      service.name: checkout\n      host.name: web-1\n");
    const user = renderForm(FILELOG, base);
    await openSection(user, "Metadata");
    await retypeInto(user, within(mapBlock("Resource Attributes")).getByDisplayValue("host.name"), "service.name");
    expect(text()).toBe(base);
    expect(screen.getByText(ATTRIBUTE_NOUNS.exists)).toBeInTheDocument();
    expect(within(mapBlock("Resource Attributes")).getByDisplayValue("host.name")).toBeInTheDocument();
  });

  it("Add Attribute writes nothing until a key is typed (never \"\": \"\"); a held row removed goes", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Metadata");
    const block = mapBlock("Resource Attributes");
    await user.click(within(block).getByRole("button", { name: "Add Attribute" }));
    await user.type(within(block).getAllByPlaceholderText(ATTRIBUTE_NOUNS.value).at(-1)!, "orphan");
    await user.tab();
    expect(text()).toBe(CORPUS);
    await user.click(within(block).getAllByRole("button", { name: "Remove" }).at(-1)!);
    expect(within(block).getAllByPlaceholderText(ATTRIBUTE_NOUNS.key)).toHaveLength(1);
    expect(text()).toBe(CORPUS);
  });

  it("the patterns: one is disabled while the other is set and it isn't; the seed's empty start disables nothing; with both, both edit", async () => {
    const user = renderForm(FILELOG);
    await openSection(user, "Multiline Parsing");
    expect(byId("line-start")).toBeEnabled();
    expect(byId("line-end")).toBeDisabled();

    cleanup();
    useEditorStore.setState(initialState, true);
    const seeded = renderForm(FILELOG, SEEDED_MULTILINE);
    await openSection(seeded, "Multiline Parsing");
    expect(byId("line-start")).toBeEnabled();
    expect(byId("line-end")).toBeEnabled();

    cleanup();
    useEditorStore.setState(initialState, true);
    const both = CORPUS.replace(MULTILINE, `${MULTILINE}      line_end_pattern: $\n`);
    const again = renderForm(FILELOG, both);
    await openSection(again, "Multiline Parsing");
    expect(byId("line-start")).toBeEnabled();
    expect(byId("line-end")).toBeEnabled();
    await retypeInto(again, byId("line-end"), "^END");
    expect(valueOf(text(), FILELOG).multiline).toEqual({ line_end_pattern: "^END" });
  });

  it("a multiline that isn't a mapping is read-only with the hint", async () => {
    const user = renderForm(FILELOG, CORPUS.replace(MULTILINE, "    multiline: yes please\n"));
    await openSection(user, "Multiline Parsing");
    expect(byId("multiline-enable")).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("unset shows the collector's defaults as placeholders and hints; the empty states and the required mark", async () => {
    const user = renderForm(FILELOG, "receivers:\n  filelog:\n");
    expect(screen.getByText("No include paths configured")).toBeInTheDocument();
    expect(screen.getByText("No exclusions configured")).toBeInTheDocument();
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden");
    expect(byId("start-at")).toHaveTextContent("End");
    expect(hint("End reads only new lines; beginning reads whole files. · Default end")).toBeInTheDocument();
    expect(byId("encoding")).toHaveTextContent("UTF-8");
    expect(byId("poll-interval")).toHaveAttribute("placeholder", "200ms");
    expect(byId("max-concurrent")).toHaveAttribute("placeholder", "1024");
    await openSection(user, "Storage & File Handling");
    expect(byId("compression")).toHaveTextContent("None");
    await openSection(user, "Metadata");
    expect(byId("attr-file-name")).toBeChecked();
    expect(byId("attr-file-path")).not.toBeChecked();
    expect(screen.getByText("No resource attributes configured")).toBeInTheDocument();
    expect(screen.getByText("No log attributes configured")).toBeInTheDocument();
    expect(text()).toBe("receivers:\n  filelog:\n");
  });

  it('"ASCII (read as UTF-8)": the collector decodes ascii as UTF-8 (textutils/encoding.go:23-24)', async () => {
    const user = renderForm(FILELOG);
    await user.click(byId("encoding"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "UTF-8",
      "UTF-16 LE",
      "UTF-16 BE",
      "ASCII (read as UTF-8)",
      "Big5",
      "No validation (raw bytes)",
    ]);
  });

  it("0 shows as written (not hidden as \"\"); an encoding outside the list shows as an extra option", async () => {
    renderForm(FILELOG, CORPUS.replace("    compression: gzip\n", "    compression: gzip\n    max_batches: 0\n    encoding: utf-16\n"));
    expect(byId("encoding")).toHaveTextContent("utf-16");
  });
});

// ── journald ──

describe("journald: the held match (config_linux.go:155-192)", () => {
  it("Add match writes nothing: the held match reads _SYSTEMD_UNIT with no value, until one is typed", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    expect(matchCards()).toHaveLength(3);
    expect(within(matchCards()[2]!).getByText("Match 3")).toBeInTheDocument();
    expect(within(matchCards()[2]!).getByDisplayValue("_SYSTEMD_UNIT")).toBeInTheDocument();
    // Leaving it empty writes nothing.
    await user.click(within(matchCards()[2]!).getByPlaceholderText(MATCH_NOUNS.value));
    await user.tab();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
  });

  it("Remove match on the held match drops it, writing nothing", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    await user.click(screen.getByRole("button", { name: "Remove match 3" }));
    expect(matchCards()).toHaveLength(2);
    expect(text()).toBe(CORPUS);
  });

  // Its own time limit.
  it("typing slowly: the first pause writes the match, and the same input keeps focus and takes the rest", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    const input = within(matchCards()[2]!).getByPlaceholderText(MATCH_NOUNS.value);
    await user.click(input);
    for (const key of ["c", "r"]) {
      await user.keyboard(key);
      // Past the 300 ms pause: each key is written as it's typed.
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 350))));
    }
    expect((valueOf(text(), JOURNALD).matches as Value[])[2]).toEqual({ _SYSTEMD_UNIT: "cr" });
    expect(document.activeElement).toBe(input);
    expect(within(matchCards()[2]!).getByPlaceholderText(MATCH_NOUNS.value)).toBe(input);
    expect(entries()).toBe(1);
  }, 20_000);

  // A field is held until both its name and its value are typed; `_UID: ""` matches entries whose field is empty.
  it("a field renamed in the held match is written with its value; a field added with a name only stays held, then is written with its value", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    const card = () => matchCards()[2]!;
    await retypeInto(user, within(card()).getByDisplayValue("_SYSTEMD_UNIT"), "_COMM");
    await user.click(within(card()).getByRole("button", { name: "Add field" }));
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.key).at(-1)!, "_UID{Enter}");
    expect(text()).toBe(CORPUS);
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.value)[0]!, "sshd");
    await user.tab();
    expect(text()).toBe(CORPUS.replace("      - _TRANSPORT: kernel\n", "      - _TRANSPORT: kernel\n      - _COMM: sshd\n"));
    expect(entries()).toBe(1);
    // The field with a name only is still the card's held row, now the written match's.
    expect(within(card()).getByDisplayValue("_UID")).toBeInTheDocument();
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.value).at(-1)!, "0");
    await user.tab();
    expect(text()).toBe(CORPUS.replace("      - _TRANSPORT: kernel\n", '      - _TRANSPORT: kernel\n      - _COMM: sshd\n        _UID: "0"\n'));
  });

  it("Add field in a match: a name committed with no value writes nothing; its value typed writes the pair", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    const card = () => matchCards()[1]!;
    await user.click(within(card()).getByRole("button", { name: "Add field" }));
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.key).at(-1)!, "_PID{Enter}");
    await user.tab();
    expect(text()).toBe(CORPUS);
    expect(within(card()).getByDisplayValue("_PID")).toBeInTheDocument();
    const value = within(card()).getAllByPlaceholderText(MATCH_NOUNS.value).at(-1)!;
    await user.type(value, "42");
    await user.tab();
    expect(text()).toBe(CORPUS.replace("      - _TRANSPORT: kernel\n", '      - _TRANSPORT: kernel\n        _PID: "42"\n'));
    expect(entries()).toBe(1);
  });

  it("a held field's name clashing with another field of its match is refused under the row, and nothing is written", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    const card = () => matchCards()[0]!;
    await user.click(within(card()).getByRole("button", { name: "Add field" }));
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.key).at(-1)!, "_UID{Enter}");
    expect(screen.getByText(MATCH_NOUNS.exists)).toBeInTheDocument();
    await user.type(within(card()).getAllByPlaceholderText(MATCH_NOUNS.value).at(-1)!, "7");
    await user.tab();
    expect(text()).toBe(CORPUS);
  });

  it("with no matches, the held match's value writes a block list of maps", async () => {
    const user = renderForm(SOURCE);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    await user.type(within(matchCards()[0]!).getByPlaceholderText(MATCH_NOUNS.value), "ssh.service");
    await user.tab();
    expect(text()).toBe(CORPUS.replace(SOURCE_END, sourceEnd("    matches:\n      - _SYSTEMD_UNIT: ssh.service\n")));
  });

  it("the last match removed removes the key; a match's last field removed leaves {}", async () => {
    const one = CORPUS.replace(MATCHES, "    matches:\n      - _TRANSPORT: kernel\n");
    const user = renderForm(JOURNALD, one);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Remove field" }));
    expect(text()).toBe(one.replace("      - _TRANSPORT: kernel\n", "      - {}\n"));
    await user.click(screen.getByRole("button", { name: "Remove match 1" }));
    expect(valueOf(text(), JOURNALD)).not.toHaveProperty("matches");
  });

  it("a field renamed to another of its match's is refused under the row, with journald's words", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await retypeInto(user, screen.getByDisplayValue("_UID"), "_SYSTEMD_UNIT");
    expect(text()).toBe(CORPUS);
    expect(screen.getByText("A field with this name already exists.")).toBeInTheDocument();
    // Another match may have the same field.
    await retypeInto(user, screen.getByDisplayValue("_TRANSPORT"), "_SYSTEMD_UNIT");
    expect((valueOf(text(), JOURNALD).matches as Value[])[1]).toEqual({ _SYSTEMD_UNIT: "kernel" });
  });

  it("a match that isn't a mapping is read-only in its card; matches that isn't a list, with no cards", async () => {
    const user = renderForm(JOURNALD, CORPUS.replace("      - _TRANSPORT: kernel\n", "      - kernel\n"));
    await openSection(user, "Filtering");
    expect(within(matchCards()[1]!).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    const again = renderForm(JOURNALD, CORPUS.replace(MATCHES, "    matches: none\n"));
    await openSection(again, "Filtering");
    expect(matchCards()).toHaveLength(0);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("a held match stays with its place when a match above is removed, until the list's length changes", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add match" }));
    await user.click(screen.getByRole("button", { name: "Remove match 1" }));
    // The list's length changed: the held match goes (a held row belongs to the list as it was).
    expect(matchCards()).toHaveLength(1);
    expect(valueOf(text(), JOURNALD).matches).toEqual([{ _TRANSPORT: "kernel" }]);
  });
});

describe("journald: the rest", () => {
  it("Add unit on a receiver with none writes a block list, and the last removed removes the key", async () => {
    const user = renderForm(SOURCE);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add unit" }));
    expect(text()).toBe(CORPUS.replace(SOURCE_END, sourceEnd("    units:\n      - ssh\n")));
    await user.click(screen.getByRole("button", { name: "Remove Units entry" }));
    expect(text()).toBe(CORPUS);
  });

  it("Kernel Messages Only ticked writes true", async () => {
    const user = renderForm(SOURCE);
    await openSection(user, "Filtering");
    await user.click(byId("dmesg"));
    expect(text()).toBe(CORPUS.replace(SOURCE_END, sourceEnd("    dmesg: true\n")));
  });

  it("the Linux-only alert says journalctl Path must be absolute with root_path (config_linux.go:65-68)", () => {
    renderForm(JOURNALD);
    expect(screen.getByText("Linux only")).toBeInTheDocument();
    const alert = screen.getByText("Linux only").nextElementSibling!;
    expect(alert.textContent).toBe(
      `The receiver shells out to journalctl, so the collector needs that binary and read access to the journal. In a container, mount /var/log/journal and /run/log/journal and point root_path at the host mount, ${JOURNALCTL_ABSOLUTE}`,
    );
  });

  it("Files says it's ignored while Directory is set (config_linux.go:127-134)", async () => {
    const user = renderForm(SOURCE);
    await openSection(user, "Journal Source");
    expect(screen.getByText(FILES_HINT)).toBeInTheDocument();
    expect(FILES_HINT).toBe("Read specific journal files instead of a directory. Ignored while Directory is set.");
  });

  it("unset shows the collector's defaults (config_all.go:19-24): End checked, info and journalctl as placeholders", async () => {
    const user = renderForm(SOURCE);
    expect(screen.getByRole("radio", { name: "End" })).toBeChecked();
    expect(byId("priority")).toHaveAttribute("placeholder", "info");
    expect(hint("Keep entries at this level or more severe. Accepts a range like info..err. · Default info")).toBeInTheDocument();
    await openSection(user, "Retry on Failure");
    expect(byId("stanza-retry-enabled")).not.toBeChecked();
    expect(text()).toBe(CORPUS);
  });

  it("Priority offers journalctl's priorities in a datalist under a fixed id", () => {
    renderForm(JOURNALD);
    expect(byId("priority")).toHaveAttribute("list", "priority-options");
    expect([...byId("priority-options").querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "emerg",
      "alert",
      "crit",
      "err",
      "warning",
      "notice",
      "info",
      "debug",
    ]);
  });

  it("a Start At outside the two checks neither and is read-only with the hint", () => {
    renderForm(JOURNALD, CORPUS.replace("    start_at: end\n", "    start_at: middle\n"));
    expect(screen.getByRole("radio", { name: "End" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Beginning" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "End" })).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("the Retry section reads a merge: its intervals as the text gives them, an edit the syslog-style own key", async () => {
    const base = CORPUS.replace("    retry_on_failure: *retry\n", "    retry_on_failure:\n      <<: *retry\n");
    const user = renderForm(JOURNALD, base);
    await openSection(user, "Retry on Failure");
    expect(byId("stanza-retry-enabled")).toBeChecked();
    expect(byId("stanza-retry-initial-interval")).toHaveValue("2s");
    await retypeInto(user, byId("stanza-retry-max-interval"), "1m");
    expect(text()).toBe(base.replace("      <<: *retry\n", "      <<: *retry\n      max_interval: 1m\n"));
  });

  it("the Filtering count is units, identifiers, matches, and grep and dmesg when set", () => {
    renderForm(JOURNALD);
    expect(screen.getByRole("button", { name: /^Filtering/ })).toHaveTextContent(/5$/);
  });

  it("journald's rows keep their classes: flex gap-2 match rows, icon remove buttons, a small Add field, mono list rows", async () => {
    const user = renderForm(JOURNALD);
    await openSection(user, "Filtering");
    const row = screen.getByDisplayValue("_UID").parentElement!;
    expect(row).toHaveClass("flex", "gap-2");
    expect(row).not.toHaveClass("grid");
    expect(within(row).getByRole("button", { name: "Remove field" })).toHaveClass("shrink-0");
    expect(screen.getAllByRole("button", { name: "Add field" })[0]).not.toHaveClass("w-full");
    expect(screen.getByRole("button", { name: "Add unit" })).not.toHaveClass("w-full");
    expect(byPlaceholder("e.g. ssh")[0]).toHaveClass("font-mono", "text-xs");
    expect(byId("dmesg").closest(".space-y-1\\.5")).not.toBeNull();
    expect(screen.getByText("Equivalent to", { exact: false })).not.toHaveClass("ml-6");
  });
});

// ── Opening writes nothing ──

describe("opening writes nothing", () => {
  // One test per form and text, each with its own time limit.
  const TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["every key unset", "receivers:\n  filelog:\n  journald:\n  journald/source:\n"],
  ] as const;
  it.each([FILELOG, JOURNALD, SOURCE].flatMap((key) => TEXTS.map(([name, base]) => [key, name, base] as const)))(
    "opening %s on %s, every section and operator card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      await openEverything(user);
      expect(screen.queryByRole("dialog")).toBeNull();
      const fields = screen.queryAllByRole("textbox");
      expect(fields.length).toBeGreaterThan(5);
      for (const field of fields) {
        await user.click(field);
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
    "  filelog:",
    `    include: [/var/log/${MARK}-inc.log]`,
    `    exclude: [/var/log/${MARK}-exc.log]`,
    `    start_at: ${MARK}-start`,
    `    encoding: ${MARK}-enc`,
    `    poll_interval: ${MARK}-poll`,
    `    max_concurrent_files: ${MARK}-max`,
    `    exclude_older_than: ${MARK}-older`,
    "    multiline:",
    `      line_start_pattern: ${MARK}-start-pattern`,
    `    max_log_size: ${MARK}-mls`,
    `    fingerprint_size: ${MARK}-fp`,
    `    force_flush_period: ${MARK}-ffp`,
    `    max_batches: ${MARK}-mb`,
    `    initial_buffer_size: ${MARK}-ibs`,
    `    storage: ${MARK}-storage`,
    `    compression: ${MARK}-compression`,
    "    resource:",
    `      ${MARK}-rkey: ${MARK}-rvalue`,
    "    attributes:",
    `      ${MARK}-akey: ${MARK}-avalue`,
    "    operators:",
    "      - type: json_parser",
    `        id: ${MARK}-op`,
    "  journald:",
    `    start_at: ${MARK}-start`,
    `    priority: ${MARK}-priority`,
    `    units: [${MARK}-unit]`,
    `    identifiers: [${MARK}-ident]`,
    "    matches:",
    `      - _${MARK}_FIELD: ${MARK}-match`,
    `    grep: ${MARK}-grep`,
    `    directory: ${MARK}-dir`,
    `    files: [${MARK}-file]`,
    `    root_path: ${MARK}-root`,
    `    namespace: ${MARK}-ns`,
    `    journalctl_path: ${MARK}-jpath`,
    `    storage: ${MARK}-storage`,
    "    retry_on_failure:",
    "      enabled: true",
    `      initial_interval: ${MARK}-retry`,
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [filelog, journald]",
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
      // An option's or a radio's value attribute is an attribute: it carries a fixed name, never the value.
      if (element.tagName === "OPTION" && element.getAttribute("value")?.includes(MARK)) leaks.push(`${where}: OPTION[value]`);
      if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "radio" && element.getAttribute("value")?.includes(MARK)) {
        leaks.push(`${where}: radio[value]`);
      }
    }
  };
  const shown = () =>
    document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

  // Its own time limit.
  it.each([FILELOG, JOURNALD])("%s puts no config value in any attribute: every section open, the menus open, held rows typed", async (key) => {
    leaks.length = 0;
    const user = renderForm(key, MARKED);
    await openEverything(user);
    expect(shown()).toContain(`${MARK}-`);
    scan(key);
    if (key === FILELOG) {
      for (const menu of ["start-at", "encoding", "compression"]) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }
      const block = mapBlock("Resource Attributes");
      await user.click(within(block).getByRole("button", { name: "Add Attribute" }));
      await user.type(within(block).getAllByPlaceholderText(ATTRIBUTE_NOUNS.value).at(-1)!, `${MARK}-held`);
      scan(`${key} (held row)`);
    } else {
      await user.click(screen.getByRole("button", { name: "Add match" }));
      await retypeInto(user, within(matchCards().at(-1)!).getByDisplayValue("_SYSTEMD_UNIT"), `_${MARK}_HELD`);
      scan(`${key} (held match)`);
      // Its value typed: written, and the card is the match's.
      await user.type(within(matchCards().at(-1)!).getAllByPlaceholderText(MATCH_NOUNS.value)[0]!, `${MARK}-held`);
      await user.tab();
      expect(text()).toContain(`${MARK}-held`);
      scan(`${key} (written match)`);
    }
    expect(document.querySelector("form")).toBeNull();
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── Dispatch and journald cases ──

describe("dispatch", () => {
  // receiver/filelogreceiver/metadata.yaml:2-3 (v0.162.0): `file_log` is the type, `filelog` its deprecated alias.
  it("the collector's file_log gets the filelog form", () => {
    const renamed = CORPUS.replace("  filelog:\n", "  file_log:\n").replace("receivers: [filelog,", "receivers: [file_log,");
    openText(renamed);
    const node = componentNamed("receivers.file_log");
    const Form = formFor("receiver", node.data.componentSubType)!;
    expect(Form).toBe(FilelogReceiverForm);
    render(
      <ComponentForm nodeId={node.id}>
        <Form />
      </ComponentForm>,
    );
    expect(byPlaceholder("e.g. /var/log/*.log")[0]).toHaveValue("/var/log/app/*.log");
    expect(text()).toBe(renamed);
  });
});

describe("journald cases (registration, round trip, list shapes)", () => {
  const entry = findPaletteEntry("receiver", "journald");

  it("is registered as a receiver, \"Journald\"", () => {
    expect(entry?.label).toBe("Journald");
  });

  it("seeds only the upstream defaults", () => {
    expect(entry?.defaultConfig).toEqual({ start_at: "end", priority: "info" });
  });

  /** A round-trip config, as a generator writes it (strings single-quoted). */
  const ROUND_TRIP = [
    "receivers:",
    "  journald:",
    "    start_at: 'beginning'",
    "    priority: 'err'",
    "    units:",
    "      - 'ssh'",
    "    matches:",
    "      - _SYSTEMD_UNIT: 'ssh.service'",
    "        _UID: '1000'",
    "    grep: '(failed|denied)'",
    "    dmesg: true",
    "    root_path: '/host'",
    "    journalctl_path: '/usr/bin/journalctl'",
    "    storage: 'file_storage'",
    "    operators:",
    "      - type: 'json_parser'",
    "    retry_on_failure:",
    "      enabled: true",
    "      initial_interval: '1s'",
    "      max_interval: '30s'",
    "      max_elapsed_time: '5m'",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [journald]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  it("shows every configured field of the round-trip config, and opening it writes nothing", async () => {
    expect(parse(ROUND_TRIP).ok).toBe(true);
    const user = renderForm(JOURNALD, ROUND_TRIP);
    await openEverything(user);
    expect(screen.getByRole("radio", { name: "Beginning" })).toBeChecked();
    expect(byId("priority")).toHaveValue("err");
    expect(byPlaceholder("e.g. ssh")[0]).toHaveValue("ssh");
    expect(screen.getByDisplayValue("ssh.service")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1000")).toBeInTheDocument();
    expect(byId("grep")).toHaveValue("(failed|denied)");
    expect(byId("dmesg")).toBeChecked();
    expect(byId("root_path")).toHaveValue("/host");
    expect(byId("journalctl_path")).toHaveValue("/usr/bin/journalctl");
    expect(byId("storage")).toHaveValue("file_storage");
    expect(screen.getByText("1 operator")).toBeInTheDocument();
    expect(byId("stanza-retry-enabled")).toBeChecked();
    expect(byId("stanza-retry-max-elapsed-time")).toHaveValue("5m");
    expect(text()).toBe(ROUND_TRIP);
  });

  it("the form's edits keep units a block list and matches a list of maps", async () => {
    const user = renderForm(JOURNALD, ROUND_TRIP);
    await openSection(user, "Filtering");
    await user.click(screen.getByRole("button", { name: "Add unit" }));
    await user.click(screen.getByRole("button", { name: "Add match" }));
    await user.type(within(matchCards()[1]!).getByPlaceholderText(MATCH_NOUNS.value), "kubelet.service");
    await user.tab();
    expect(text()).toContain("    units:\n      - 'ssh'\n      - ssh\n");
    expect(text()).toContain("    matches:\n      - _SYSTEMD_UNIT: 'ssh.service'\n        _UID: '1000'\n      - _SYSTEMD_UNIT: kubelet.service\n");
  });
});
