import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigurationPanel } from "../ConfigurationPanel.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import {
  ALLOWED_VALUES_DESCRIPTION,
  FAIL_CLOSED_TEXT,
  HASH_FUNCTIONS,
  HMAC_HINT,
  RedactionProcessorForm,
  SPAN_NAMES_HINT,
  templateNameFor,
  URL_ATTRIBUTES_DESCRIPTION,
  VALUE_MASKING_TEMPLATES,
} from "./RedactionProcessorForm.js";
import { formFor } from "./registry.js";
import { PatternListField } from "./shared/PatternListField.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPattern } from "~/lib/regex-library.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The redaction processor: its form over the form contract, and
 * `PatternListField`. Each field is driven as a person would on the OTTL
 * corpus text (comments, flow and block lists, regexes written as typed in
 * every quote style, an anchor and its merges elsewhere, a bare `0750` the
 * collector reads as a number), LF and CRLF, and writes only its key.
 *
 * Collector claims cite contrib v0.162.0's `processor/redactionprocessor`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The OTTL corpus (LF): its `redaction` has every list, a hash, a summary and a URL sanitizer. */
const CORPUS = LF(corpusText("forms-ottl.yaml"));
/** The complex config: `allow_all_keys: true` and the SSN template's pattern single-quoted. */
const COMPLEX = LF(corpusText("complex-config.yaml"));

const RD = "processors.redaction";

/** A text holding only `redaction` (its lines at four spaces), in a traces pipeline. */
function ownText(lines: string): string {
  const body = lines.trimEnd() === "" ? ["  redaction: {}"] : ["  redaction:", lines.trimEnd()];
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "processors:",
    ...body,
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      processors: [redaction]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "warning").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const toasts = (kind: "error" | "success" | "warning" | "info") => vi.mocked(toast[kind]).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(text = CORPUS, key = RD) {
  openText(text);
  const user = userEvent.setup();
  render(
    <ComponentForm nodeId={componentNamed(key).id}>
      <RedactionProcessorForm />
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const valueOf = (written = text()): Value =>
  (parseYaml(written, { merge: true }) as { processors: Record<string, Value> }).processors.redaction!;
/** A line of text, by its whole text. */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) => screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }));
}

/** Opens a database sanitizer's row by its label (its name may hold the "enabled" chip). */
async function openSanitizer(user: UserEvent, label: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${label}( enabled)?$`) }));
}

/** A labeled field's block (its ConfigField), by its label. */
function fieldOf(label: string): HTMLElement {
  return screen.getByText(label, { selector: "label" }).closest("div.space-y-1\\.5") as HTMLElement;
}

const hashSelect = () => screen.getByRole("combobox", { name: "Hash Function" });
const templateSelect = () => screen.getByRole("combobox", { name: "Quick Add Template" });
const addPatternButton = () => screen.getByRole("button", { name: "Add Pattern" });

// ── Every field writes only its key ──

const ALLOWED = "    allowed_keys: [description, group, id, name]\n";
const BLOCKED = '      - "4[0-9]{12}(?:[0-9]{3})?" # Visa\n      - "(5[1-5][0-9]{14})" # MasterCard\n';
const KEY_PATTERNS = '    blocked_key_patterns: [".*token.*", ".*api_key.*"]\n';
const URL_BLOCK = "    url_sanitizer:\n      enabled: true\n      attributes: [http.url, url.full]\n";

interface FieldCase {
  name: string;
  /** The text the case runs on (LF); the corpus by default. */
  base?: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  check: (value: Value) => void;
}

const CASES: FieldCase[] = [
  {
    name: "Allow All Keys ticked writes true",
    edit: (user) => user.click(screen.getByRole("checkbox", { name: "Allow All Keys" })),
    from: "    allow_all_keys: false\n",
    to: "    allow_all_keys: true\n",
    check: (v) => expect(v.allow_all_keys).toBe(true),
  },
  {
    name: "an Allowed Keys item, in its flow list",
    edit: (user) => retypeInto(user, within(fieldOf("Allowed Keys")).getAllByRole("textbox")[1]!, "team"),
    from: ALLOWED,
    to: "    allowed_keys: [description, team, id, name]\n",
    check: (v) => expect(v.allowed_keys).toEqual(["description", "team", "id", "name"]),
  },
  {
    name: "Allowed Keys' Add (held until typed)",
    edit: async (user) => {
      await user.click(within(fieldOf("Allowed Keys")).getByRole("button", { name: "Add" }));
      await typeInto(user, within(fieldOf("Allowed Keys")).getAllByRole("textbox").at(-1)!, "region");
    },
    from: ALLOWED,
    to: "    allowed_keys: [description, group, id, name, region]\n",
    check: (v) => expect(v.allowed_keys).toEqual(["description", "group", "id", "name", "region"]),
  },
  {
    name: "an Ignored Keys item",
    edit: (user) => retypeInto(user, byId("ignored-keys"), "safe_attr"),
    from: "      - safe_attribute\n",
    to: "      - safe_attr\n",
    check: (v) => expect(v.ignored_keys).toEqual(["safe_attr"]),
  },
  {
    name: "a Blocked Key Patterns item removed from its flow list",
    edit: (user) => user.click(within(fieldOf("Blocked Key Patterns")).getAllByRole("button", { name: "Remove" })[0]!),
    from: KEY_PATTERNS,
    to: '    blocked_key_patterns: [".*api_key.*"]\n',
    check: (v) => expect(v.blocked_key_patterns).toEqual([".*api_key.*"]),
  },
  {
    name: "Blocked Key Patterns' Add (held until typed), written as typed",
    edit: async (user) => {
      await user.click(within(fieldOf("Blocked Key Patterns")).getByRole("button", { name: "Add" }));
      await typeInto(user, within(fieldOf("Blocked Key Patterns")).getAllByRole("textbox").at(-1)!, ".*pass\\w*.*");
    },
    from: KEY_PATTERNS,
    to: '    blocked_key_patterns: [".*token.*", ".*api_key.*", .*pass\\w*.*]\n',
    check: (v) => expect(v.blocked_key_patterns).toEqual([".*token.*", ".*api_key.*", ".*pass\\w*.*"]),
  },
  {
    name: "Blocked Values' Remove pattern takes the item's lines and its comment",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await user.click(screen.getAllByRole("button", { name: "Remove pattern" })[0]!);
    },
    from: BLOCKED,
    to: '      - "(5[1-5][0-9]{14})" # MasterCard\n',
    check: (v) => expect(v.blocked_values).toEqual(["(5[1-5][0-9]{14})"]),
  },
  {
    name: "Blocked Values' staged pattern, trimmed, appended as a string on Enter",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await user.click(byId("blocked-values"));
      await user.keyboard("  \\d{{16}  {Enter}");
    },
    from: BLOCKED,
    to: `${BLOCKED}      - \\d{16}\n`,
    check: (v) => expect(v.blocked_values).toEqual(["4[0-9]{12}(?:[0-9]{3})?", "(5[1-5][0-9]{14})", "\\d{16}"]),
  },
  {
    name: "a Quick Add Template appends its pattern string",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await pickIn(user, templateSelect(), "AWS Access Key");
      await user.click(addPatternButton());
    },
    from: BLOCKED,
    to: `${BLOCKED}      - AKIA[0-9A-Z]{16}\n`,
    check: (v) => expect((v.blocked_values as unknown[]).at(-1)).toBe("AKIA[0-9A-Z]{16}"),
  },
  {
    name: "an Allowed Values item keeps its quotes and its escape",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await retypeInto(user, byId("allowed-values"), ".+@example\\.com");
    },
    from: "      - '.+@mycompany\\.com'\n",
    to: "      - '.+@example\\.com'\n",
    check: (v) => expect(v.allowed_values).toEqual([".+@example\\.com"]),
  },
  {
    name: "Redact All Types (unset) ticked",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await user.click(screen.getByRole("checkbox", { name: "Redact All Types" }));
    },
    from: URL_BLOCK,
    to: `${URL_BLOCK}    redact_all_types: true\n`,
    check: (v) => expect(v.redact_all_types).toBe(true),
  },
  {
    name: "Hash Function: SHA-3",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await pickIn(user, hashSelect(), "SHA-3");
    },
    from: "    hash_function: md5\n",
    to: "    hash_function: sha3\n",
    check: (v) => expect(v.hash_function).toBe("sha3"),
  },
  {
    name: "Hash Function: None removes the key",
    edit: async (user) => {
      await openSection(user, "Value Masking");
      await pickIn(user, hashSelect(), "None (asterisk masking)");
    },
    from: "    hash_function: md5\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("hash_function"),
  },
  {
    name: "URL Sanitization unticked writes false",
    edit: async (user) => {
      await openSection(user, "Sanitization");
      await user.click(screen.getByRole("checkbox", { name: "Enable URL Sanitization" }));
    },
    from: "      enabled: true\n",
    to: "      enabled: false\n",
    check: (v) => expect(v.url_sanitizer).toEqual({ enabled: false, attributes: ["http.url", "url.full"] }),
  },
  {
    name: "a URL Attributes item, in its flow list",
    edit: async (user) => {
      await openSection(user, "Sanitization");
      await retypeInto(user, within(fieldOf("URL Attributes")).getAllByRole("textbox")[1]!, "url.original");
    },
    from: "      attributes: [http.url, url.full]\n",
    to: "      attributes: [http.url, url.original]\n",
    check: (v) => expect((v.url_sanitizer as Value).attributes).toEqual(["http.url", "url.original"]),
  },
  {
    name: "a database sanitizer's Enable (unset) writes its block",
    edit: async (user) => {
      await openSection(user, "Sanitization");
      await openSanitizer(user, "SQL");
      await user.click(screen.getByRole("checkbox", { name: "Enable SQL Sanitization" }));
    },
    from: URL_BLOCK,
    to: `${URL_BLOCK}    db_sanitizer:\n      sql:\n        enabled: true\n`,
    check: (v) => expect(v.db_sanitizer).toEqual({ sql: { enabled: true } }),
  },
  {
    name: "Summary Mode: info",
    edit: async (user) => {
      await openSection(user, "Diagnostics");
      await pickIn(user, screen.getByRole("combobox", { name: "Summary Mode" }), "Info (counts only)");
    },
    from: "    summary: debug\n",
    to: "    summary: info\n",
    check: (v) => expect(v.summary).toBe("info"),
  },
  {
    name: "Valkey's first attribute (held until typed)",
    base: ownText("    db_sanitizer:\n      valkey:\n        enabled: true # cache"),
    edit: async (user) => {
      await openSection(user, "Sanitization");
      await openSanitizer(user, "Valkey");
      await user.click(within(fieldOf("Valkey Attributes")).getByRole("button", { name: "Add" }));
      await typeInto(user, byId("valkey-attributes"), "db.query.text");
    },
    from: "        enabled: true # cache\n",
    to: "        enabled: true # cache\n        attributes:\n          - db.query.text\n",
    check: (v) => expect(v.db_sanitizer).toEqual({ valkey: { enabled: true, attributes: ["db.query.text"] } }),
  },
];

describe("every field writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const base = c.base ?? CORPUS;
      const before = crlf ? CRLF(base) : base;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf());
      expect(toasts("error")).toEqual([]);
      expect(toasts("warning")).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

// ── Opening writes nothing ──

/** Every key the form shows, every database sanitizer enabled with attributes (opensearch's and es' never read). */
const EVERYTHING = ownText(
  [
    "    allow_all_keys: false",
    "    allowed_keys: [a]",
    "    ignored_keys: [b]",
    "    blocked_key_patterns: ['.*c.*']",
    "    blocked_values: ['\\d{3}-\\d{2}-\\d{4}', 'x+']",
    "    allowed_values: ['y']",
    "    redact_all_types: true",
    "    hash_function: hmac-sha512",
    "    hmac_key: ${env:REDACTION_HMAC_KEY}",
    "    summary: silent",
    "    url_sanitizer: {enabled: true, attributes: [url.full]}",
    "    db_sanitizer:",
    ...["sql", "redis", "valkey", "memcached", "mongo", "opensearch", "es"].flatMap((key) => [
      `      ${key}:`,
      "        enabled: true",
      `        attributes: [${key}.attr]`,
    ]),
  ].join("\n"),
);

describe("opening writes nothing", () => {
  async function openEverything(user: UserEvent) {
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
  }

  // One test per text, each with its own time limit.
  it.each([
    // Allow All Keys; the four lists' rows; the template select, the staging input, Redact All Types, Hash; URL box and
    // its attributes; seven sanitizer boxes; Summary.
    ["the OTTL corpus", CORPUS, 22],
    ["the OTTL corpus, CRLF", CRLF(CORPUS), 22],
    ["the complex config", COMPLEX, 14],
    ["every key, every sanitizer", EVERYTHING, 24],
    ["an empty redaction", ownText(""), 14],
  ] as const)(
    "opening %s, every section and row, focusing every field, writes nothing and leaves the editor clean",
    async (_name, base, minimum) => {
      const user = renderForm(base);
      await openEverything(user);
      expect(screen.queryAllByRole("button", { expanded: false })).toEqual([]);
      const { textboxes, all } = formControls();
      expect(all).toBeGreaterThanOrEqual(minimum);
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );

  it("the form is redaction's (metadata.yaml:2), from the registry", () => {
    expect(formFor("processor", "redaction")).toBe(RedactionProcessorForm);
  });
});

// ── Hash Function ──

describe("Hash Function: the collector's set", () => {
  const OFFERED = ["None (asterisk masking)", "MD5", "SHA-1", "SHA-3", "HMAC-SHA256", "HMAC-SHA512"];

  it("offers None, MD5, SHA-1, SHA-3, HMAC-SHA256 and HMAC-SHA512, never sha256 (config.go:20-29, 97-124 refuses it)", async () => {
    const user = renderForm(ownText(""));
    await openSection(user, "Value Masking");
    expect(hashSelect()).toHaveTextContent("None (asterisk masking)");
    expect(fieldOf("Hash Function")).toHaveTextContent("Replace masked values with a hash instead of asterisks. · Default none");
    await user.click(hashSelect());
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(OFFERED);
    // No "SHA-256 (recommended)" option: sha256 is refused by UnmarshalText.
    expect(HASH_FUNCTIONS.map((option) => option.value)).toEqual(["md5", "sha1", "sha3", "hmac-sha256", "hmac-sha512"]);
    for (const option of options) {
      expect(option.textContent).not.toMatch(/256 \(recommended\)|^SHA-256$/);
      for (const attribute of option.attributes) expect(attribute.value).not.toMatch(/^sha256$/i);
    }
    expect(document.body.innerHTML).not.toContain("sha256");
  });

  it("None while unset writes nothing; a hash chosen writes only hash_function", async () => {
    const base = ownText("    summary: info");
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    await pickIn(user, hashSelect(), "None (asterisk masking)");
    expect(text()).toBe(base);
    await pickIn(user, hashSelect(), "SHA-1");
    expect(text()).toBe(base.replace("    summary: info\n", "    summary: info\n    hash_function: sha1\n"));
  });

  it("a value the collector refuses (sha256) shows as written, an extra option; choosing a hash replaces it", async () => {
    const base = ownText("    hash_function: sha256 # old form");
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    expect(hashSelect()).toHaveTextContent("sha256");
    await user.click(hashSelect());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([...OFFERED, "sha256"]);
    await user.click(screen.getByRole("option", { name: "MD5" }));
    expect(text()).toBe(base.replace("sha256 # old form", "md5 # old form"));
  });

  it("a value in another case (SHA1) matches its option, as the collector reads it (strings.ToLower, config.go:102)", async () => {
    const base = ownText("    hash_function: SHA1");
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    expect(hashSelect()).toHaveTextContent("SHA-1");
    await user.click(hashSelect());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(OFFERED);
    await user.click(screen.getByRole("option", { name: "SHA-1" }));
    expect(text()).toBe(base);
    await pickIn(user, hashSelect(), "MD5");
    expect(text()).toBe(base.replace("SHA1", "md5"));
  });

  it("without an hmac_key, the HMAC options are disabled, with the hint (config.go:126-147); choosing one writes nothing", async () => {
    const base = ownText("    hash_function: md5");
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    expect(hint(HMAC_HINT)).toBeInTheDocument();
    await user.click(hashSelect());
    for (const name of ["HMAC-SHA256", "HMAC-SHA512"]) expect(screen.getByRole("option", { name })).toHaveAttribute("aria-disabled", "true");
    for (const name of ["MD5", "SHA-1", "SHA-3"]) expect(screen.getByRole("option", { name })).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("option", { name: "HMAC-SHA256" }));
    expect(text()).toBe(base);
  });

  it("an HMAC hash in the text without a key still shows as chosen, the hint under it", async () => {
    const user = renderForm(ownText("    hash_function: hmac-sha256"));
    await openSection(user, "Value Masking");
    expect(hashSelect()).toHaveTextContent("HMAC-SHA256");
    expect(hint(HMAC_HINT)).toBeInTheDocument();
  });

  it("once the text has an hmac_key, the HMAC options are enabled and the hint goes; the key's value is never in the page", async () => {
    const SECRET = "zq-secret-0123456789abcdef0123456789abcdef";
    const base = ownText(`    hmac_key: ${SECRET}\n    hash_function: md5`);
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    expect(queryHint(HMAC_HINT)).toBeNull();
    await user.click(hashSelect());
    for (const name of ["HMAC-SHA256", "HMAC-SHA512"]) expect(screen.getByRole("option", { name })).not.toHaveAttribute("aria-disabled");
    expect(document.body.innerHTML).not.toContain(SECRET);
    await user.click(screen.getByRole("option", { name: "HMAC-SHA512" }));
    expect(text()).toBe(base.replace("hash_function: md5", "hash_function: hmac-sha512"));
    for (const row of ["Sanitization", "Diagnostics"]) await openSection(user, row);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect([...document.querySelectorAll("input")].map((input) => input.value).join()).not.toContain(SECRET);
  });

  it("an empty hmac_key counts as none (config.go:131-132): HMAC disabled, the hint shown", async () => {
    for (const empty of ['""', "''"]) {
      const user = renderForm(ownText(`    hmac_key: ${empty}\n    hash_function: md5`));
      await openSection(user, "Value Masking");
      expect(hint(HMAC_HINT)).toBeInTheDocument();
      await user.click(hashSelect());
      for (const name of ["HMAC-SHA256", "HMAC-SHA512"]) expect(screen.getByRole("option", { name })).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Escape}");
      cleanup();
    }
  });

  it("a reference counts as a key: presence is all the form reads", async () => {
    const user = renderForm(ownText("    hmac_key: ${env:HMAC_KEY}"));
    await openSection(user, "Value Masking");
    expect(queryHint(HMAC_HINT)).toBeNull();
    expect(document.body.innerHTML).not.toContain("HMAC_KEY");
  });
});

// ── Quick Add Template and Blocked Values ──

describe("Quick Add Template and Blocked Values", () => {
  it("lists the PII, PCI, PHI and Secrets templates by category; the preview shows the chosen one", async () => {
    const user = renderForm(ownText(""));
    await openSection(user, "Value Masking");
    expect(fieldOf("Quick Add Template")).toHaveTextContent("18 ready-made PII, PCI, PHI, and secret patterns.");
    expect(VALUE_MASKING_TEMPLATES).toHaveLength(18);
    expect(templateSelect()).toHaveTextContent("Select pattern template");
    expect(addPatternButton()).toBeDisabled();
    await user.click(templateSelect());
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(VALUE_MASKING_TEMPLATES.map((t) => t.name));
    for (const category of ["PII / GDPR", "PCI", "PHI / HIPAA", "Secrets"]) expect(within(listbox).getByText(category)).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "JWT Token" }));
    const jwt = findPattern("JWT Token");
    expect(screen.getByText(jwt.description)).toBeInTheDocument();
    expect(screen.getByText(`· ${jwt.category}`)).toBeInTheDocument();
    expect(screen.getByText(jwt.pattern, { selector: "code" })).toBeInTheDocument();
    expect(text()).toBe(ownText(""));
  });

  it("Add writes the pattern string, not {pattern, name}, with the toast; the selection resets; the badge is derived", async () => {
    const base = ownText("    summary: info");
    const user = renderForm(base);
    await openSection(user, "Value Masking");
    expect(screen.getByText("No patterns configured")).toBeInTheDocument();
    await pickIn(user, templateSelect(), "US Social Security Number");
    await user.click(addPatternButton());
    const ssn = findPattern("US Social Security Number").pattern;
    expect(valueOf().blocked_values).toEqual([ssn]);
    expect(text()).toBe(base.replace("    summary: info\n", "    summary: info\n    blocked_values:\n      - \\d{3}-\\d{2}-\\d{4}\n"));
    expect(toasts("success")).toEqual(['Added "US Social Security Number" pattern']);
    expect(templateSelect()).toHaveTextContent("Select pattern template");
    expect(addPatternButton()).toBeDisabled();
    // The row: the pattern as code, the badge from the library, no Remove name.
    expect(screen.getByText(ssn, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("US Social Security Number", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove name" })).toBeNull();
    expect(screen.queryByText("No patterns configured")).toBeNull();
  });

  it("a template already in the list (by its string, in any quote style) is refused with a warning; nothing is written", async () => {
    // complex-config.yaml holds the SSN pattern single-quoted.
    const user = renderForm(COMPLEX);
    await openSection(user, "Value Masking");
    await pickIn(user, templateSelect(), "US Social Security Number");
    await user.click(addPatternButton());
    expect(toasts("warning")).toEqual(['Pattern "US Social Security Number" is already in Blocked Values']);
    expect(toasts("success")).toEqual([]);
    expect(text()).toBe(COMPLEX);
    expect(entries()).toBe(0);
  });

  it("Add reads the list when it is clicked, after the held edits are written: the Raw YAML box's waiting edit is counted, not overwritten", async () => {
    const ssn = findPattern("US Social Security Number").pattern;
    const base = ownText("    summary: info");
    const renderPanel = async () => {
      openText(base);
      const user = userEvent.setup();
      render(<ConfigurationPanel />);
      act(() => builderStore().selectNode(componentNamed(RD).id));
      await openSection(user, "Value Masking");
      await user.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
      await pickIn(user, templateSelect(), "US Social Security Number");
      return user;
    };
    const box = () => screen.getByRole("textbox", { name: "Raw YAML" });

    // The box's edit waits for its pause; Add is clicked without leaving it.
    await renderPanel();
    fireEvent.change(box(), { target: { value: "summary: info\nblocked_values:\n  - other+\n" } });
    expect(text()).toBe(base);
    fireEvent.click(addPatternButton());
    expect(valueOf().blocked_values).toEqual(["other+", ssn]);
    expect(toasts("success")).toEqual(['Added "US Social Security Number" pattern']);
    cleanup();
    vi.mocked(toast.success).mockClear();

    // The box's edit holds the template's pattern: a duplicate, refused with the warning.
    await renderPanel();
    fireEvent.change(box(), { target: { value: `summary: info\nblocked_values:\n  - '${ssn}'\n` } });
    fireEvent.click(addPatternButton());
    expect(valueOf().blocked_values).toEqual([ssn]);
    expect(toasts("warning")).toEqual(['Pattern "US Social Security Number" is already in Blocked Values']);
    expect(toasts("success")).toEqual([]);
  });

  it("Add after an Instance Name typed and not left: the rename is written, and the list is the renamed component's, its first item kept", async () => {
    const ssn = findPattern("US Social Security Number").pattern;
    openText(ownText("    blocked_values:\n      - keep+"));
    const user = userEvent.setup();
    render(<ConfigurationPanel />);
    act(() => builderStore().selectNode(componentNamed(RD).id));
    await openSection(user, "Value Masking");
    await user.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
    await pickIn(user, templateSelect(), "US Social Security Number");
    // Typed, not left: the rename waits for its pause, and Add's flush writes it.
    fireEvent.change(byId("instance-name"), { target: { value: "x" } });
    fireEvent.click(addPatternButton());
    const processors = (parseYaml(text()) as { processors: Record<string, Value> }).processors;
    expect(Object.keys(processors)).toEqual(["redaction/x"]);
    expect(processors["redaction/x"]!.blocked_values).toEqual(["keep+", ssn]);
    expect(toasts("success")).toEqual(['Added "US Social Security Number" pattern']);
  });

  it("the badge is derived by exact pattern: the SSN item gets its name, the corpus's card patterns none", async () => {
    let user = renderForm(COMPLEX);
    await openSection(user, "Value Masking");
    expect(screen.getByText("US Social Security Number", { selector: "span" })).toBeInTheDocument();
    cleanup();
    user = renderForm(CORPUS);
    await openSection(user, "Value Masking");
    const rows = screen.getAllByRole("button", { name: "Remove pattern" }).map((button) => button.parentElement!);
    expect(rows.map((row) => row.textContent)).toEqual(["4[0-9]{12}(?:[0-9]{3})?", "(5[1-5][0-9]{14})"]);
    expect(templateNameFor("4[0-9]{12}(?:[0-9]{3})?")).toBeUndefined();
    // Exact: a pattern with a space more is not the template.
    expect(templateNameFor(`${findPattern("UUID").pattern} `)).toBeUndefined();
    expect(templateNameFor(findPattern("UUID").pattern)).toBe("UUID");
  });
});

describe("PatternListField", () => {
  function renderField(base: string) {
    openText(base);
    const user = userEvent.setup();
    render(
      <ComponentForm nodeId={componentNamed(RD).id}>
        <PatternListField path={["blocked_values"]} id="blocked-values" nameFor={templateNameFor} />
      </ComponentForm>,
    );
    return user;
  }

  it("shows the empty state, placeholder and help; + is disabled while the trimmed text is empty", async () => {
    const base = ownText("");
    const user = renderField(base);
    expect(screen.getByText("No patterns configured")).toBeInTheDocument();
    expect(screen.getByText("Press Enter to add.")).toBeInTheDocument();
    expect(byId("blocked-values")).toHaveAttribute("placeholder", "e.g. \\d{3}-\\d{2}-\\d{4}");
    const plus = screen.getByRole("button", { name: "Add pattern" });
    expect(plus).toBeDisabled();
    await user.type(byId("blocked-values"), "   ");
    expect(plus).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(text()).toBe(base);
  });

  it("+ appends the trimmed pattern as a string and clears the input; no duplicate check", async () => {
    const base = ownText("    blocked_values: [abc]");
    const user = renderField(base);
    await user.type(byId("blocked-values"), " abc ");
    await user.click(screen.getByRole("button", { name: "Add pattern" }));
    expect(text()).toBe(base.replace("[abc]", "[abc, abc]"));
    expect(byId("blocked-values")).toHaveValue("");
  });

  it("Remove pattern removes the item by its lines; the last removed leaves []", async () => {
    const base = ownText("    blocked_values:\n      - a+ # first\n      - b+");
    const user = renderField(base);
    await user.click(screen.getAllByRole("button", { name: "Remove pattern" })[0]!);
    expect(text()).toBe(base.replace("      - a+ # first\n", ""));
    expect(screen.getAllByRole("button", { name: "Remove pattern" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Remove pattern" }));
    expect(valueOf().blocked_values).toEqual([]);
    expect(screen.getByText("No patterns configured")).toBeInTheDocument();
  });

  it("rows are keyed by their items: removing the first leaves the second's row in place", async () => {
    const user = renderField(ownText("    blocked_values: [a+, b+, c+]"));
    const second = screen.getByText("b+", { selector: "code" }).parentElement;
    await user.click(screen.getAllByRole("button", { name: "Remove pattern" })[0]!);
    expect(screen.getByText("b+", { selector: "code" }).parentElement).toBe(second);
  });

  it("a list it can't show (a mapping item, or not a list) is read-only with the unshowable-value hint", () => {
    renderField(ownText("    blocked_values:\n      - {pattern: a+, name: A}"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add pattern" })).toBeNull();
    cleanup();
    renderField(ownText("    blocked_values: a+"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

// ── The lists hold empty rows ──

describe("the lists' Add holds a row (never \"\")", () => {
  it.each([
    ["Allowed Keys", "allowed_keys"],
    ["Ignored Keys", "ignored_keys"],
    ["Blocked Key Patterns", "blocked_key_patterns"],
    ["Allowed Values", "allowed_values"],
    ["URL Attributes", "url_sanitizer"],
  ] as const)("%s: Add writes nothing; left empty the row goes; an item emptied and left is removed, never \"\"", async (label, key) => {
    const base = ownText(
      [
        "    allowed_keys: [k1]",
        "    ignored_keys: [k2]",
        "    blocked_key_patterns: [k3]",
        "    allowed_values: [k4]",
        "    url_sanitizer:",
        "      enabled: true",
        "      attributes: [k5]",
      ].join("\n"),
    );
    const user = renderForm(base);
    if (label === "Allowed Values") await openSection(user, "Value Masking");
    if (label === "URL Attributes") await openSection(user, "Sanitization");
    const field = () => fieldOf(label);
    await user.click(within(field()).getByRole("button", { name: "Add" }));
    expect(within(field()).getAllByRole("textbox")).toHaveLength(2);
    await user.click(within(field()).getAllByRole("textbox")[1]!);
    await user.tab();
    expect(within(field()).getAllByRole("textbox")).toHaveLength(1);
    expect(text()).toBe(base);
    await retypeInto(user, within(field()).getAllByRole("textbox")[0]!, "");
    expect(text()).not.toContain('""');
    expect(text()).not.toContain("''");
    const after = valueOf();
    const list = key === "url_sanitizer" ? (after.url_sanitizer as Value).attributes : after[key];
    expect(list).toEqual([]);
  });
});

// ── Allow All Keys and the fail-closed alert ──

describe("Allow All Keys and the fail-closed alert", () => {
  const alertText = () => screen.queryByText("Fail-closed mode")?.parentElement?.querySelector("div")?.textContent;

  it("unset: unticked, the corrected alert, Allowed Keys shown", () => {
    renderForm(ownText(""));
    expect(screen.getByRole("checkbox", { name: "Allow All Keys" })).not.toBeChecked();
    expect(alertText()).toBe(FAIL_CLOSED_TEXT);
    expect(fieldOf("Allowed Keys")).toBeInTheDocument();
  });

  it("no alert while allowed_keys has items; ticking Allow All Keys hides Allowed Keys and keeps its list", async () => {
    const base = ownText("    allowed_keys: [id]");
    const user = renderForm(base);
    expect(screen.queryByText("Fail-closed mode")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Allow All Keys" }));
    expect(text()).toBe(base.replace("    allowed_keys: [id]\n", "    allowed_keys: [id]\n    allow_all_keys: true\n"));
    expect(screen.queryByText("Allowed Keys", { selector: "label" })).toBeNull();
  });

  it("allow_all_keys: true (complex-config.yaml): ticked, no alert, Allowed Keys hidden; unticking writes false and shows the alert", async () => {
    const user = renderForm(COMPLEX);
    expect(screen.getByRole("checkbox", { name: "Allow All Keys" })).toBeChecked();
    expect(screen.queryByText("Fail-closed mode")).toBeNull();
    expect(screen.queryByText("Allowed Keys", { selector: "label" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Allow All Keys" }));
    expect(text()).toBe(COMPLEX.replace("    allow_all_keys: true\n", "    allow_all_keys: false\n"));
    expect(alertText()).toBe(FAIL_CLOSED_TEXT);
  });

  it("Blocked Key Patterns keeps its help from the library's Keys category", async () => {
    const user = renderForm(ownText(""));
    expect(hint("Common: .*api[_-]?key.*, .*token.*, .*password.*, .*secret.*")).toBeInTheDocument();
    // Its placeholder is the library's "Auth Token (key match)".
    await user.click(within(fieldOf("Blocked Key Patterns")).getByRole("button", { name: "Add" }));
    expect(within(fieldOf("Blocked Key Patterns")).getByRole("textbox")).toHaveAttribute("placeholder", "e.g. .*token.*");
  });
});

// ── Sanitization and Diagnostics ──

describe("Sanitization", () => {
  it("URL Sanitization unset shows unticked (factory.go:31-33), URL Attributes hidden, uncounted; ticking writes enabled: true", async () => {
    const base = ownText("    summary: info");
    const user = renderForm(base);
    expect(screen.getByRole("button", { name: "Sanitization" })).toBeInTheDocument();
    await openSection(user, "Sanitization");
    expect(screen.getByRole("checkbox", { name: "Enable URL Sanitization" })).not.toBeChecked();
    expect(screen.queryByText("URL Attributes")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable URL Sanitization" }));
    expect(text()).toBe(base.replace("    summary: info\n", "    summary: info\n    url_sanitizer:\n      enabled: true\n"));
    expect(screen.getByRole("button", { name: /^Sanitization\s*1$/ })).toBeInTheDocument();
    // No default list (internal/url/sanitizer.go:17-44): the corrected description, no "Default".
    expect(within(fieldOf("URL Attributes")).getByText(URL_ATTRIBUTES_DESCRIPTION)).toBeInTheDocument();
    expect(fieldOf("URL Attributes")).not.toHaveTextContent("Default");
  });

  it("the database sanitizers are SQL, Redis, Valkey (internal/db/config.go:9), Memcached, MongoDB, OpenSearch, Elasticsearch", async () => {
    const user = renderForm(ownText(""));
    await openSection(user, "Sanitization");
    const rows = within(fieldOf("Database Sanitizers")).getAllByRole("button", { expanded: false });
    expect(rows.map((row) => row.textContent)).toEqual(["SQL", "Redis", "Valkey", "Memcached", "MongoDB", "OpenSearch", "Elasticsearch"]);
  });

  it("OpenSearch and Elasticsearch have no Attributes (db.go:138-169), and say what they sanitize while enabled; a key in the text is left alone", async () => {
    const base = ownText("    db_sanitizer:\n      es:\n        enabled: true\n        attributes: [db.statement]");
    const user = renderForm(base);
    await openSection(user, "Sanitization");
    expect(screen.getByRole("button", { name: /^Sanitization\s*1$/ })).toBeInTheDocument();
    await openSanitizer(user, "Elasticsearch");
    await openSanitizer(user, "OpenSearch");
    expect(screen.getByRole("checkbox", { name: "Enable Elasticsearch Sanitization" })).toBeChecked();
    expect(screen.getAllByText(SPAN_NAMES_HINT)).toHaveLength(1);
    expect(screen.queryByText("Elasticsearch Attributes")).toBeNull();
    expect(screen.queryByText("OpenSearch Attributes")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable OpenSearch Sanitization" }));
    expect(screen.getAllByText(SPAN_NAMES_HINT)).toHaveLength(2);
    expect(screen.queryByText("OpenSearch Attributes")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable Elasticsearch Sanitization" }));
    expect(valueOf().db_sanitizer).toEqual({ es: { enabled: false, attributes: ["db.statement"] }, opensearch: { enabled: true } });
  });

  it("SQL's Attributes show while it is enabled, with its copy", async () => {
    const user = renderForm(ownText("    db_sanitizer:\n      sql:\n        enabled: true"));
    await openSection(user, "Sanitization");
    expect(screen.getByRole("button", { name: "SQL enabled" })).toBeInTheDocument();
    await openSanitizer(user, "SQL");
    expect(within(fieldOf("SQL Attributes")).getByText("Attributes containing queries to sanitize.")).toBeInTheDocument();
    expect(screen.queryByText(SPAN_NAMES_HINT)).toBeNull();
  });
});

describe("Diagnostics and copy", () => {
  it("Summary unset shows Silent (no summary) and Default silent (processor.go:423-443); never info", async () => {
    const user = renderForm(ownText(""));
    await openSection(user, "Diagnostics");
    const summary = screen.getByRole("combobox", { name: "Summary Mode" });
    expect(summary).toHaveTextContent("Silent (no summary)");
    expect(fieldOf("Summary Mode")).toHaveTextContent("Diagnostic attributes added when redacting; use silent in production. · Default silent");
    await user.click(summary);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Debug (counts + names of redacted keys)",
      "Info (counts only)",
      "Silent (no summary)",
    ]);
  });

  it("Allowed Values reads as the collector does (processor.go:362-371, 502-510)", async () => {
    const user = renderForm(ownText(""));
    await openSection(user, "Value Masking");
    expect(within(fieldOf("Allowed Values")).getByText(ALLOWED_VALUES_DESCRIPTION)).toBeInTheDocument();
  });

  it("the copy's words, exactly", () => {
    expect(HMAC_HINT).toBe("HMAC needs an hmac_key (32+ bytes; 64+ for HMAC-SHA512). Add it in the YAML below.");
    expect(FAIL_CLOSED_TEXT).toBe(
      'With allow_all_keys off and an empty allowed_keys list, every attribute (and every field of a map log body) not in Ignored Keys is removed. Enable "Allow All Keys" or add allowed keys.',
    );
    expect(ALLOWED_VALUES_DESCRIPTION).toBe(
      "Values matching any of these regexes aren't masked, even under a blocked key pattern (attributes; in a map log body a blocked key pattern masks first).",
    );
    expect(URL_ATTRIBUTES_DESCRIPTION).toBe(
      "Attributes containing URLs to sanitize. Span names and log bodies are sanitized either way (unless sanitize_span_name is false).",
    );
    expect(SPAN_NAMES_HINT).toBe("Sanitizes span names and log bodies.");
  });
});

// ── Privacy ──

describe("privacy", () => {
  it("puts no key, pattern, value or hmac_key in any attribute: every section and row open, the template select open, a staged pattern", async () => {
    const MARK = "zq-mark";
    const marked = ownText(
      [
        `    allowed_keys: [${MARK}-ak]`,
        `    ignored_keys: [${MARK}-ik]`,
        `    blocked_key_patterns: [${MARK}-kp]`,
        `    blocked_values: [${MARK}-bv, '${findPattern("UUID").pattern}']`,
        `    allowed_values: [${MARK}-av]`,
        `    hash_function: ${MARK}-hash`,
        `    hmac_key: ${MARK}-secret`,
        `    summary: ${MARK}-summary`,
        `    url_sanitizer: {enabled: true, attributes: [${MARK}-url]}`,
        `    db_sanitizer: {sql: {enabled: true, attributes: [${MARK}-sql]}, es: {enabled: true, attributes: [${MARK}-es]}}`,
      ].join("\n"),
    );
    const user = renderForm(marked);
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
    await user.type(byId("blocked-values"), `${MARK}-staged`);
    await user.click(hashSelect());
    const shown =
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();
    for (const what of ["ak", "ik", "kp", "bv", "av", "hash", "summary", "url", "sql", "staged"]) expect(shown).toContain(`${MARK}-${what}`);
    // The hmac_key's value is never read into the page; es' attributes aren't shown.
    expect(document.body.innerHTML).not.toContain(`${MARK}-secret`);
    expect(document.body.innerHTML).not.toContain(`${MARK}-es`);
    const leaks: string[] = [];
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
        }
        if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push("option value");
      }
    };
    scan();
    await user.keyboard("{Escape}");
    await user.click(templateSelect());
    scan();
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
  });
});
