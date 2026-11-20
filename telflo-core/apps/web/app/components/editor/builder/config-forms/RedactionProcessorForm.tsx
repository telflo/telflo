import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, MultiValueField, readLatest, SelectField, useForm, type SelectOption } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { listLength } from "./shared/counts.js";
import { PatternListField } from "./shared/PatternListField.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import {
  findPattern,
  getPatternsByCategory,
  groupPatternsByCategory,
  type RegexPattern,
  type RegexPatternCategory,
} from "~/lib/regex-library.js";

/*
 * The redaction processor's form, over the form's fields. Collector claims
 * are contrib v0.162.0's `processor/redactionprocessor`.
 *
 * - Hash Function offers the collector's set: None (asterisk masking) removes
 *   the key, MD5, SHA-1, SHA-3, HMAC-SHA256 and HMAC-SHA512
 *   (`config.go:20-29, 97-124`; not `sha256`, which `UnmarshalText` refuses).
 *   The HMAC options are disabled unless the text has a non-empty `hmac_key`
 *   (`config.go:126-147` refuses an HMAC hash without one, `""` included,
 *   `config.go:131-132`), with `HMAC_HINT`. Only the key's presence is read;
 *   its value never reaches the page. The collector reads the value in any
 *   case (`strings.ToLower`, `config.go:102`), so `SHA1` shows as SHA-1; a
 *   value it refuses (`sha256`, `none`) shows as an extra option, as written.
 * - Quick Add Template's Add writes the pattern string
 *   (`BlockedValues []string`, `config.go:72`). A duplicate is found by its
 *   string in the text, read when Add is clicked, after the fields' held
 *   edits are written (a row's typing is counted, not overwritten). Blocked
 *   Values is `PatternListField`: the name badge is derived from the
 *   templates by exact pattern, with no Remove name.
 * - The lists' Add holds a row (never `""`: an empty blocked key pattern
 *   masks every value, an empty allowed value turns masking off; Go's
 *   `regexp` matches `""` everywhere, `processor.go:362-371, 642-653`).
 * - Summary unset shows "Silent (no summary)" and "Default silent" (anything
 *   but `debug` or `info` adds nothing, `processor.go:423-443`); URL
 *   Sanitization shows unticked when unset (off by default,
 *   `factory.go:31-33`; created only when enabled, `processor.go:89-95`) and
 *   URL Attributes has no default (`internal/url/sanitizer.go:17-44`) and
 *   says span names and log bodies are sanitized either way
 *   (`processor.go:468-485, 566-575`); Allowed Values says a matching value
 *   isn't masked at all, even under a blocked key pattern
 *   (`processor.go:362-371, 502-510`); the fail-closed alert says ignored
 *   keys are kept and a map log body's fields go too
 *   (`processor.go:191-242, 334-389`).
 * - A Valkey row after Redis (`internal/db/config.go:9`).
 * - OpenSearch and Elasticsearch have no Attributes field: the collector
 *   never reads one (`internal/db/db.go:138-169`); while either is enabled,
 *   the hint `SPAN_NAMES_HINT`. A key already in the text is left alone.
 *
 * Ids are fixed per field; the template select's values are the library's
 * names, constants.
 */

export const HMAC_HINT = "HMAC needs an hmac_key (32+ bytes; 64+ for HMAC-SHA512). Add it in the YAML below.";
export const FAIL_CLOSED_TEXT =
  'With allow_all_keys off and an empty allowed_keys list, every attribute (and every field of a map log body) not in Ignored Keys is removed. Enable "Allow All Keys" or add allowed keys.';
export const ALLOWED_VALUES_DESCRIPTION =
  "Values matching any of these regexes aren't masked, even under a blocked key pattern (attributes; in a map log body a blocked key pattern masks first).";
export const URL_ATTRIBUTES_DESCRIPTION =
  "Attributes containing URLs to sanitize. Span names and log bodies are sanitized either way (unless sanitize_span_name is false).";
export const SPAN_NAMES_HINT = "Sanitizes span names and log bodies.";

const VALUE_MASKING_CATEGORIES: RegexPatternCategory[] = ["PII / GDPR", "PCI", "PHI / HIPAA", "Secrets"];

export const VALUE_MASKING_TEMPLATES: RegexPattern[] = VALUE_MASKING_CATEGORIES.flatMap((category) => getPatternsByCategory(category));

const KEY_PATTERN_HINTS = getPatternsByCategory("Keys");

/** A Blocked Values badge: the template whose pattern is exactly this one (display only). */
export const templateNameFor = (pattern: string): string | undefined =>
  VALUE_MASKING_TEMPLATES.find((template) => template.pattern === pattern)?.name;

/** The collector's hash functions (`config.go:20-29`), None being the unset option; `sha256` is not one. */
export const HASH_FUNCTIONS: readonly SelectOption[] = [
  { value: "md5", label: "MD5" },
  { value: "sha1", label: "SHA-1" },
  { value: "sha3", label: "SHA-3" },
  { value: "hmac-sha256", label: "HMAC-SHA256" },
  { value: "hmac-sha512", label: "HMAC-SHA512" },
];

const HMAC_FUNCTIONS = new Set(["hmac-sha256", "hmac-sha512"]);

const DB_SANITIZERS = [
  { key: "sql", label: "SQL", attributes: true },
  { key: "redis", label: "Redis", attributes: true },
  { key: "valkey", label: "Valkey", attributes: true },
  { key: "memcached", label: "Memcached", attributes: true },
  { key: "mongo", label: "MongoDB", attributes: true },
  { key: "opensearch", label: "OpenSearch", attributes: false },
  { key: "es", label: "Elasticsearch", attributes: false },
] as const;

export function RedactionProcessorForm() {
  const form = useForm();
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [openSanitizers, setOpenSanitizers] = useState<Record<string, boolean>>({});

  const allowAllKeys = form.read(["allow_all_keys"]).value === true;
  const blockedValues = form.read(["blocked_values"]);
  const urlEnabled = form.read(["url_sanitizer", "enabled"]).value === true;
  const enabledOf = (key: string) => form.read(["db_sanitizer", key, "enabled"]).value === true;
  // Presence only: the key's value is never read into the page. An empty key is none: the collector
  // refuses an HMAC hash with `hmac_key: ""` (`config.go:131-132`).
  const hmacKey = form.read(["hmac_key"]);
  const hasHmacKey = hmacKey.kind !== "absent" && !(hmacKey.kind === "scalar" && hmacKey.value === "");

  const hasEmptyAllowedKeysWarning = !allowAllKeys && listLength(form.read(["allowed_keys"])) === 0;

  const selectedTemplateData = VALUE_MASKING_TEMPLATES.find((t) => t.name === selectedTemplate);

  /** The Blocked Values items as strings, as the text holds them now, or null when the list can't take an item (not a list). */
  const blockedStrings = (): string[] | null => {
    const view = readLatest(form, ["blocked_values"]);
    if (view.kind === "absent") return [];
    if (view.kind !== "list") return null;
    return view.value.map((_item, index) => {
      const item = readLatest(form, ["blocked_values", index]);
      return item.kind === "scalar" ? (item.source ?? String(item.value)) : "";
    });
  };
  const canAddTemplate = blockedValues.kind === "absent" || blockedValues.kind === "list";

  const handleAddTemplate = () => {
    if (!selectedTemplate || !selectedTemplateData) {
      toast.error("Select a template pattern first");
      return;
    }

    // A row's typing is written first, and the list read as that left it.
    flushHeldEdits();
    const current = blockedStrings();
    if (current === null) return;

    // The text holds strings: a duplicate is the same string.
    if (current.includes(selectedTemplateData.pattern)) {
      toast.warning(`Pattern "${selectedTemplateData.name}" is already in Blocked Values`);
      return;
    }

    if (form.set(["blocked_values", current.length], selectedTemplateData.pattern) === "refused") return;

    toast.success(`Added "${selectedTemplateData.name}" pattern`);
    setSelectedTemplate("");
  };

  const templatesByCategory = groupPatternsByCategory(VALUE_MASKING_TEMPLATES);

  const enabledSanitizerCount = (urlEnabled ? 1 : 0) + DB_SANITIZERS.filter((s) => enabledOf(s.key)).length;

  return (
    <div className="space-y-4">
      <CheckboxField
        path={["allow_all_keys"]}
        id="allow-all-keys"
        label="Allow All Keys"
        defaultChecked={false}
        description="Skips the allow-list; blocked key and value patterns still apply."
      />

      {hasEmptyAllowedKeysWarning && (
        <InlineAlert variant="warn" title="Fail-closed mode">
          With <span className="font-mono">allow_all_keys</span> off and an empty <span className="font-mono">allowed_keys</span>{" "}
          list, every attribute (and every field of a map log body) not in Ignored Keys is removed. Enable "Allow All Keys" or
          add allowed keys.
        </InlineAlert>
      )}

      {!allowAllKeys && (
        <ConfigField label="Allowed Keys" htmlFor="allowed-keys" description="Attribute keys to retain; all others are removed.">
          <MultiValueField path={["allowed_keys"]} id="allowed-keys" placeholder="e.g. http.method" holdEmpty />
        </ConfigField>
      )}

      <ConfigField label="Ignored Keys" htmlFor="ignored-keys" description="Bypass redaction entirely; only for provably safe data.">
        <MultiValueField path={["ignored_keys"]} id="ignored-keys" placeholder="e.g. trace.id" holdEmpty />
      </ConfigField>

      <ConfigField label="Blocked Key Patterns" htmlFor="blocked-key-patterns" description="Keys matching these regexes are masked.">
        <MultiValueField
          path={["blocked_key_patterns"]}
          id="blocked-key-patterns"
          placeholder={`e.g. ${findPattern("Auth Token (key match)").pattern}`}
          helpText={`Common: ${KEY_PATTERN_HINTS.map((h) => h.pattern).join(", ")}`}
          holdEmpty
        />
      </ConfigField>

      <ConfigSection title="Value Masking" count={listLength(blockedValues)}>
        <ConfigField
          label="Quick Add Template"
          htmlFor="template-select"
          description={`${VALUE_MASKING_TEMPLATES.length} ready-made PII, PCI, PHI, and secret patterns.`}
        >
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1">
                <Select value={selectedTemplate} onValueChange={setSelectedTemplate} disabled={form.disabled}>
                  <SelectTrigger id="template-select">
                    <SelectValue placeholder="Select pattern template" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(templatesByCategory).map(([category, templates]) => (
                      <SelectGroup key={category}>
                        <SelectLabel>{category}</SelectLabel>
                        {templates.map((template) => (
                          <SelectItem key={template.name} value={template.name}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={handleAddTemplate}
                disabled={!selectedTemplate || form.disabled || !canAddTemplate}
                className="shrink-0"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Pattern
              </Button>
            </div>

            {selectedTemplateData && (
              <div className="rounded-md border border-border bg-muted/50 p-2.5 space-y-1">
                <p className="text-xs">
                  <span className="font-medium">{selectedTemplateData.name}</span>{" "}
                  <span className="text-muted-foreground">· {selectedTemplateData.category}</span>
                </p>
                <p className="text-xs text-muted-foreground">{selectedTemplateData.description}</p>
                <code className="block rounded-[4px] bg-muted p-1.5 font-mono text-xs break-all">{selectedTemplateData.pattern}</code>
              </div>
            )}
          </div>
        </ConfigField>

        <ConfigField label="Blocked Values" htmlFor="blocked-values" description="Regexes for values to mask in allowed attributes.">
          <PatternListField
            path={["blocked_values"]}
            id="blocked-values"
            placeholder="e.g. 4[0-9]{12}(?:[0-9]{3})?"
            nameFor={templateNameFor}
          />
        </ConfigField>

        <ConfigField label="Allowed Values" htmlFor="allowed-values" description={ALLOWED_VALUES_DESCRIPTION}>
          <MultiValueField path={["allowed_values"]} id="allowed-values" placeholder="e.g. .+@mycompany.com" holdEmpty />
        </ConfigField>

        <CheckboxField
          path={["redact_all_types"]}
          id="redact-all-types"
          label="Redact All Types"
          defaultChecked={false}
          description="Also scan non-string values."
        />

        <div className="space-y-1.5">
          <SelectField
            path={["hash_function"]}
            id="hash-function"
            label="Hash Function"
            defaultValue="none"
            placeholder="None (asterisk masking)"
            description="Replace masked values with a hash instead of asterisks."
            unsetOption={{ label: "None (asterisk masking)" }}
            options={HASH_FUNCTIONS.map((option) => (HMAC_FUNCTIONS.has(option.value) && !hasHmacKey ? { ...option, disabled: true } : option))}
            ignoreCase
          />
          {!hasHmacKey && <p className="text-[11px] leading-4 text-muted-foreground">{HMAC_HINT}</p>}
        </div>
      </ConfigSection>

      <ConfigSection title="Sanitization" count={enabledSanitizerCount}>
        <CheckboxField
          path={["url_sanitizer", "enabled"]}
          id="url-sanitizer-enabled"
          label="Enable URL Sanitization"
          defaultChecked={false}
          description="Strips UUIDs, timestamps, and other high-cardinality URL parts."
        />

        {urlEnabled && (
          <ConfigField label="URL Attributes" htmlFor="url-attributes" description={URL_ATTRIBUTES_DESCRIPTION}>
            <MultiValueField path={["url_sanitizer", "attributes"]} id="url-attributes" placeholder="http.url" holdEmpty />
          </ConfigField>
        )}

        <ConfigField label="Database Sanitizers" description="Strip literal values from queries while preserving structure.">
          <div className="space-y-2">
            {DB_SANITIZERS.map(({ key, label, attributes }) => {
              const enabled = enabledOf(key);
              const isOpen = openSanitizers[key] ?? false;
              return (
                <div key={key} className="rounded-md border border-border bg-muted/50">
                  <button
                    type="button"
                    onClick={() => setOpenSanitizers((prev) => ({ ...prev, [key]: !isOpen }))}
                    aria-expanded={isOpen}
                    className="w-full flex items-center justify-between p-2.5 hover:bg-accent transition-colors"
                  >
                    <span className="text-sm font-medium">{label}</span>
                    <span className="flex items-center gap-2">
                      {enabled && <span className="font-mono text-[10px] text-muted-foreground">enabled</span>}
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="p-2.5 pt-0 space-y-2">
                      <CheckboxField
                        path={["db_sanitizer", key, "enabled"]}
                        id={`${key}-enabled`}
                        label={`Enable ${label} Sanitization`}
                        defaultChecked={false}
                        labelClassName="text-sm font-normal cursor-pointer"
                        {...(!attributes && enabled ? { description: SPAN_NAMES_HINT } : {})}
                      />
                      {attributes && enabled && (
                        <ConfigField
                          label={`${label} Attributes`}
                          htmlFor={`${key}-attributes`}
                          description="Attributes containing queries to sanitize."
                        >
                          <MultiValueField
                            path={["db_sanitizer", key, "attributes"]}
                            id={`${key}-attributes`}
                            placeholder="e.g. db.statement"
                            holdEmpty
                          />
                        </ConfigField>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ConfigField>
      </ConfigSection>

      <ConfigSection title="Diagnostics">
        <SelectField
          path={["summary"]}
          id="summary"
          label="Summary Mode"
          defaultValue="silent"
          description="Diagnostic attributes added when redacting; use silent in production."
          options={[
            { value: "debug", label: "Debug (counts + names of redacted keys)" },
            { value: "info", label: "Info (counts only)" },
            { value: "silent", label: "Silent (no summary)" },
          ]}
        />
      </ConfigSection>
    </div>
  );
}
