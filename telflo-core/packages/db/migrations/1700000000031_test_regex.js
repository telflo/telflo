/**
 * The regex library.
 *
 *   * test_regex: named regex patterns product admins keep for the
 *     validation-rule picker: a name, a category (free text), an optional
 *     description and the regex, one row per entry, hard-deleted (nothing
 *     references a row: a rule copies the regex, not the id). Global: no
 *     organization column and no row-level security, as test_templates.
 *     Migration 009's default privileges give telflo_platform_runtime select,
 *     insert, update and delete, which the API needs: members read the library
 *     through it, and only a product admin writes it, which the API decides.
 *   * The name is unique (uq_test_regex_name, case-sensitive, the seed's on
 *     conflict target); the name, category and description are trimmed of
 *     ASCII's whitespace and bounded (1 to 200, 1 to 100 and 1 to 2,000
 *     characters; a description is null for none), and the regex is at most
 *     8,192 bytes, a rule's bound, and refused when blank, but never trimmed,
 *     as a rule's pattern isn't (migration 030's
 *     ck_validation_rules_pattern_length). Unicode's whitespace is the API's
 *     check. It gains updated_at, and neither timestamp has a default: the API
 *     writes both from its clock, as flows' (migration 026).
 *   * The 35 seeded entries, as Postgres stores them, which is
 *     apps/web/app/lib/regex-library.ts's REGEX_LIBRARY (name, category,
 *     description, pattern), in its order. The migration inserts them once on
 *     every database, a developer's own included, on conflict (name) do
 *     nothing, as migration 026's flows: an admin's edits stand, and later
 *     changes go through the admin screen or a new migration. They are held
 *     below as `seededTestRegexes`, each text a JSON-escaped string, and
 *     written with dollar quoting (seededTestRegexesInsert), so no backslash
 *     is ever escaped for SQL. This migration reads no file. Their timestamps
 *     are the migration's time to the millisecond, as the API's clock would
 *     write them. `seededTestRegexes`, `testRegexesInsert` and
 *     `seededTestRegexesInsert` are exported for the tests and their fixtures
 *     (@telflo/db/testing's insertSeededTestRegexes;
 *     seeded-test-regexes-fixture.ts, the evaluator's RE2 check of every
 *     pattern and the web's check that the seed equals REGEX_LIBRARY), which
 *     reach them by a dynamic import of this module.
 *
 * down drops the table with its rows: exactly what up added.
 */

/** The 35 seeded entries, in regex-library.ts's order. */
export const seededTestRegexes = Object.freeze([
  // PII / GDPR
  Object.freeze({
    name: "Email Address",
    category: "PII / GDPR",
    description: "Matches email addresses (e.g., user@example.com)",
    regex: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
  }),
  Object.freeze({
    name: "Phone Number (International)",
    category: "PII / GDPR",
    description: "10-15 digit phone numbers with optional + prefix",
    regex: "\\+?[0-9]{10,15}",
  }),
  Object.freeze({
    name: "US Social Security Number",
    category: "PII / GDPR",
    description: "SSN format: 123-45-6789",
    regex: "\\d{3}-\\d{2}-\\d{4}",
  }),
  Object.freeze({
    name: "EU Passport Number",
    category: "PII / GDPR",
    description: "1-2 letters followed by 6-9 digits",
    regex: "[A-Z]{1,2}[0-9]{6,9}",
  }),
  Object.freeze({
    name: "IPv4 Address",
    category: "PII / GDPR",
    description: "Standard IPv4 format (e.g., 192.168.1.1)",
    regex: "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}",
  }),
  Object.freeze({
    name: "IPv6 Address",
    category: "PII / GDPR",
    description: "Full IPv6 format",
    regex: "([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}",
  }),

  // PCI
  Object.freeze({
    name: "Credit Card",
    category: "PCI",
    description: "Visa, Mastercard, Amex, and Discover card numbers, with optional space or dash separators",
    regex: "\\b(?:4\\d{3}(?:[- ]?\\d{4}){3}|4\\d{12}|5[1-5]\\d{2}(?:[- ]?\\d{4}){3}|3[47]\\d{2}[- ]?\\d{6}[- ]?\\d{5}|(?:6011|65\\d{2})(?:[- ]?\\d{4}){3})\\b",
  }),
  Object.freeze({
    name: "CVV Code",
    category: "PCI",
    description: "3 or 4 digit CVV/CVC codes",
    regex: "\\b\\d{3,4}\\b",
  }),

  // PHI / HIPAA
  Object.freeze({
    name: "US National Provider ID (NPI)",
    category: "PHI / HIPAA",
    description: "10-digit NPI numbers",
    regex: "\\b[0-9]{10}\\b",
  }),
  Object.freeze({
    name: "Medical Record Number",
    category: "PHI / HIPAA",
    description: "MRN prefix with 6-12 digits",
    regex: "MRN[:\\s-]?[0-9]{6,12}",
  }),
  Object.freeze({
    name: "Health Insurance ID",
    category: "PHI / HIPAA",
    description: "2-3 letters followed by 8-12 digits",
    regex: "[A-Z]{2,3}[0-9]{8,12}",
  }),
  Object.freeze({
    name: "Date of Birth (US)",
    category: "PHI / HIPAA",
    description: "MM/DD/YYYY format (e.g., 01/15/1990)",
    regex: "\\b(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/(19|20)\\d{2}\\b",
  }),
  Object.freeze({
    name: "ICD-10 Code",
    category: "PHI / HIPAA",
    description: "Medical diagnosis codes (e.g., E11.9)",
    regex: "[A-Z][0-9]{2}\\.?[0-9A-Z]{0,4}",
  }),

  // Secrets
  Object.freeze({
    name: "API Key (Generic)",
    category: "Secrets",
    description: "Generic API key patterns with key/value structure",
    regex: "(api[_-]?key|apikey)[\\s:=\"']+[a-zA-Z0-9_\\-]{16,}",
  }),
  Object.freeze({
    name: "JWT Token",
    category: "Secrets",
    description: "JSON Web Tokens (starts with eyJ)",
    regex: "eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*",
  }),
  Object.freeze({
    name: "UUID",
    category: "Secrets",
    description: "UUID v4 format",
    regex: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
  }),
  Object.freeze({
    name: "AWS Access Key",
    category: "Secrets",
    description: "AWS access key ID pattern",
    regex: "AKIA[0-9A-Z]{16}",
  }),
  Object.freeze({
    name: "Private Key Header",
    category: "Secrets",
    description: "PEM private key headers",
    regex: "-----BEGIN (RSA |EC )?PRIVATE KEY-----",
  }),

  // Keys
  Object.freeze({
    name: "API Key (key match)",
    category: "Keys",
    description: "Matches attribute keys containing 'api_key', 'api-key', or 'apikey'",
    regex: ".*api[_-]?key.*",
  }),
  Object.freeze({
    name: "Auth Token (key match)",
    category: "Keys",
    description: "Matches attribute keys containing 'token'",
    regex: ".*token.*",
  }),
  Object.freeze({
    name: "Password (key match)",
    category: "Keys",
    description: "Matches attribute keys containing 'password'",
    regex: ".*password.*",
  }),
  Object.freeze({
    name: "Secret (key match)",
    category: "Keys",
    description: "Matches attribute keys containing 'secret'",
    regex: ".*secret.*",
  }),

  // URL Routes
  Object.freeze({
    name: "Admin/Internal Routes",
    category: "URL Routes",
    description: "Matches request paths under /admin/ or /internal/",
    regex: "^/(admin|internal)/.*",
  }),
  Object.freeze({
    name: "Health Check Routes",
    category: "URL Routes",
    description: "Matches health, readiness, and liveness probe paths",
    regex: "^/(health|ready|live).*",
  }),
  Object.freeze({
    name: "API Routes",
    category: "URL Routes",
    description: "Matches any request path under /api/",
    regex: "^/api/.*",
  }),

  // Value Extraction
  Object.freeze({
    name: "Password in URL Query",
    category: "Value Extraction",
    description: "Captures the password value from a URL query string parameter",
    regex: "password=([^&]+)",
  }),
  Object.freeze({
    name: "Password in Command Line",
    category: "Value Extraction",
    description: "Captures the password value from a command-line argument",
    regex: "password\\=([^\\s]*)",
  }),

  // URL Parsing
  Object.freeze({
    name: "URL Protocol + Domain + Path",
    category: "URL Parsing",
    description: "Captures protocol and domain from a URL into named groups http_protocol and http_domain",
    regex: "^(?P<http_protocol>.*?)://(?P<http_domain>.*?)/",
  }),
  Object.freeze({
    name: "URL Protocol + Domain",
    category: "URL Parsing",
    description: "Captures protocol (http/https) and domain from a URL into named groups protocol and domain",
    regex: "^(?P<protocol>https?)://(?P<domain>[^/]+)",
  }),

  // Log Parsing
  Object.freeze({
    name: "Generic Log Line (timestamp/level/message)",
    category: "Log Parsing",
    description: "Splits a whitespace-delimited log line into timestamp, level, and message named groups",
    regex: "^(?P<timestamp>\\S+) (?P<level>\\w+) (?P<message>.*)$",
  }),
  Object.freeze({
    name: "Date-Prefixed Log Line",
    category: "Log Parsing",
    description: "Splits a log line beginning with an ISO date into time and msg named groups",
    regex: "^(?P<time>\\d{4}-\\d{2}-\\d{2}) (?P<msg>.*)$",
  }),

  // Attribute Key Prefixes
  Object.freeze({
    name: "Generic Prefix",
    category: "Attribute Key Prefixes",
    description: "Matches attribute keys starting with 'prefix_'",
    regex: "^prefix_.*",
  }),
  Object.freeze({
    name: "Temp Prefix",
    category: "Attribute Key Prefixes",
    description: "Matches attribute keys starting with 'temp_'",
    regex: "^temp_.*",
  }),
  Object.freeze({
    name: "PII Prefix",
    category: "Attribute Key Prefixes",
    description: "Matches attribute keys starting with 'pii_'",
    regex: "^pii_.*",
  }),

  // Date Formats
  Object.freeze({
    name: "ISO Date (YYYY-MM-DD)",
    category: "Date Formats",
    description: "Generic ISO-style date in YYYY-MM-DD form",
    regex: "\\d{4}-\\d{2}-\\d{2}",
  }),
]);

/** The dollar-quoting tag every seeded text is written between. */
const textTag = "$seeded_test_regex$";

/** The columns `testRegexesInsert` writes, in its order. */
const insertColumns = ["name", "category", "description", "regex"];

/**
 * `value` dollar-quoted. Refuses a text the tag would end early: one that
 * holds the tag, or ends with all of it but its last `$` (the tag's closing
 * `$` would then complete it one character early).
 */
function quotedText(value) {
  if (typeof value !== "string") throw new Error(`a seeded test regex's text must be a string, not ${typeof value}`);
  if ((value + textTag).indexOf(textTag) !== value.length) {
    throw new Error(`a seeded test regex's text holds the quoting tag ${textTag}`);
  }
  return `${textTag}${value}${textTag}`;
}

/** One column's value as SQL: a description may be null. */
function sqlValue(column, value) {
  if (value === null && column === "description") return "null";
  return quotedText(value);
}

/**
 * The insert of `rows` into test_regex, on conflict (name) do nothing, so a
 * second run inserts no entry whose name is there and changes none: an
 * admin's edit stands. A deleted one comes back. created_at and updated_at
 * are the transaction's time to the millisecond.
 */
export function testRegexesInsert(rows) {
  const values = rows.map(
    (row) =>
      `  (${insertColumns.map((column) => sqlValue(column, row[column])).join(", ")}, ` +
      "date_trunc('milliseconds', now()), date_trunc('milliseconds', now()))",
  );
  return (
    `insert into test_regex\n  (${insertColumns.join(", ")}, created_at, updated_at)\nvalues\n` +
    `${values.join(",\n")}\non conflict (name) do nothing`
  );
}

/** The seeded entries' insert, as up runs it. */
export const seededTestRegexesInsert = () => testRegexesInsert(seededTestRegexes);

/**
 * The characters a blank text holds nothing but, as migration 030's:
 * ASCII's whitespace (space, tab, newline, vertical tab, form feed, return).
 * Unicode's is the API's check.
 */
const blank = `E' \\t\\n\\x0B\\f\\r'`;

export const up = (pgm) => {
  pgm.sql(`
    create table test_regex (
      id           uuid         primary key default uuidv7(),
      name         text         not null,
      category     text         not null,
      description  text,
      regex        text         not null,
      created_at   timestamptz  not null,
      updated_at   timestamptz  not null,
      constraint uq_test_regex_name unique (name),
      constraint ck_test_regex_name_trimmed check (name = btrim(name, ${blank})),
      constraint ck_test_regex_name_length check (char_length(name) between 1 and 200),
      constraint ck_test_regex_category_trimmed check (category = btrim(category, ${blank})),
      constraint ck_test_regex_category_length check (char_length(category) between 1 and 100),
      constraint ck_test_regex_description_trimmed check (description = btrim(description, ${blank})),
      constraint ck_test_regex_description_length check (char_length(description) between 1 and 2000),
      constraint ck_test_regex_regex_length check (octet_length(regex) <= 8192 and btrim(regex, ${blank}) <> '')
    );

    comment on table test_regex is
      'the regex library: named regex patterns the validation-rule picker
       offers, one row per entry, hard-deleted (a rule copies the regex, never
       the id). Global: no organization column, no row-level security.
       Members read it through the API; only a product admin
       (users.is_product_admin) writes it, which the API decides. Seeded with
       35 patterns by migration 1700000000031.';
    comment on column test_regex.id is
      'the entry''s id (uuidv7), which the admin''s writes address: its name
       may change.';
    comment on column test_regex.name is
      'the entry''s name in the picker and the admin table: trimmed, 1 to
       200 characters, unique (uq_test_regex_name). Configuration text:
       never in a log line, an attribute, an audit row or a URL.';
    comment on column test_regex.category is
      'free text grouping entries in the picker (PII / GDPR, Secrets):
       trimmed, 1 to 100 characters. Configuration text.';
    comment on column test_regex.description is
      'what the pattern matches, trimmed, 1 to 2,000 characters, or null for
       none. Configuration text.';
    comment on column test_regex.regex is
      'the pattern a picked rule copies, byte for byte: never trimmed, not
       blank, at most 8,192 bytes as a rule''s pattern. The API checks it
       under the evaluator''s RE2 on every create and on an edit that changes
       it. Configuration text.';
    comment on column test_regex.created_at is
      'written by the API from its clock, never now(), so that it holds whole
       milliseconds as a JavaScript Date does (migration 015''s rule). No
       default, so a write that forgets the clock fails. The seeded
       entries'' is the migration''s time to the millisecond.';
    comment on column test_regex.updated_at is
      'written by the API from its clock on create and on every change. No
       default, as created_at.';
    comment on constraint test_regex_pkey on test_regex is
      'one row per entry, by its id, which the admin''s writes address.';
    comment on constraint uq_test_regex_name on test_regex is
      'a name names one entry (23505; the API answers test_regex_name_taken),
       compared exactly, case and all. The seed''s on conflict target.';
    comment on constraint ck_test_regex_name_trimmed on test_regex is
      'the name has no leading or trailing ASCII whitespace, which the API''s
       contract trims first.';
    comment on constraint ck_test_regex_name_length on test_regex is
      'the name is 1 to 200 characters.';
    comment on constraint ck_test_regex_category_trimmed on test_regex is
      'the category has no leading or trailing ASCII whitespace, which the
       API''s contract trims first.';
    comment on constraint ck_test_regex_category_length on test_regex is
      'the category is 1 to 100 characters.';
    comment on constraint ck_test_regex_description_trimmed on test_regex is
      'a description has no leading or trailing ASCII whitespace, which the
       API''s contract trims first (an empty one becomes null).';
    comment on constraint ck_test_regex_description_length on test_regex is
      'a description is 1 to 2,000 characters, or null.';
    comment on constraint ck_test_regex_regex_length on test_regex is
      'the regex is at most 8,192 bytes (octet_length, as the evaluator
       counts, and a rule''s pattern''s bound) and not blank. Never trimmed.';
  `);
  pgm.sql(seededTestRegexesInsert());
};

export const down = (pgm) => {
  pgm.sql(`
    drop table test_regex;
  `);
};
