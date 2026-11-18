/*
 * The regex catalog (ADR 0018; D9b plan Task 7): named regex patterns used
 * across the config forms (the attributes processor's placeholders and seeds,
 * the filter processor's examples). `findPattern` throws on a name the
 * catalog lacks, so a mistyped lookup fails loudly rather than rendering
 * "undefined".
 *
 * Two lists (D15b decision 11): this file is the config
 * forms', and the `test_regex` table is the validation picker's ("Add from
 * regex library") and the Test Regex page's, which product admins edit.
 * Migration 1700000000031 seeds the table with these 35 entries, and
 * regex-library.test.ts pins this catalog's name, category, description and
 * pattern, in order, to the seed's fixture
 * (services/ottl-evaluator/internal/rules/testdata/seeded-test-regexes.json),
 * so the two start equal; an admin's edits to the table never reach this
 * file.
 */

export type RegexPatternCategory =
  | "PII / GDPR"
  | "PCI"
  | "PHI / HIPAA"
  | "Secrets"
  | "Keys"
  | "URL Routes"
  | "Value Extraction"
  | "URL Parsing"
  | "Log Parsing"
  | "Attribute Key Prefixes"
  | "Date Formats";

export interface RegexPattern {
  name: string;
  description: string;
  pattern: string;
  category: RegexPatternCategory;
  // Optional terse caption (1–3 words) for compact UI surfaces like inline help
  // bullets. Falls back to `description` at the call site when absent.
  shortDescription?: string;
}

export const REGEX_LIBRARY: readonly RegexPattern[] = [
  // PII / GDPR
  {
    name: "Email Address",
    description: "Matches email addresses (e.g., user@example.com)",
    pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    category: "PII / GDPR",
  },
  {
    name: "Phone Number (International)",
    description: "10-15 digit phone numbers with optional + prefix",
    pattern: "\\+?[0-9]{10,15}",
    category: "PII / GDPR",
  },
  {
    name: "US Social Security Number",
    description: "SSN format: 123-45-6789",
    pattern: "\\d{3}-\\d{2}-\\d{4}",
    category: "PII / GDPR",
  },
  {
    name: "EU Passport Number",
    description: "1-2 letters followed by 6-9 digits",
    pattern: "[A-Z]{1,2}[0-9]{6,9}",
    category: "PII / GDPR",
  },
  {
    name: "IPv4 Address",
    description: "Standard IPv4 format (e.g., 192.168.1.1)",
    pattern: "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}",
    category: "PII / GDPR",
  },
  {
    name: "IPv6 Address",
    description: "Full IPv6 format",
    pattern: "([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}",
    category: "PII / GDPR",
  },

  // PCI
  {
    name: "Credit Card",
    description: "Visa, Mastercard, Amex, and Discover card numbers, with optional space or dash separators",
    pattern: "\\b(?:4\\d{3}(?:[- ]?\\d{4}){3}|4\\d{12}|5[1-5]\\d{2}(?:[- ]?\\d{4}){3}|3[47]\\d{2}[- ]?\\d{6}[- ]?\\d{5}|(?:6011|65\\d{2})(?:[- ]?\\d{4}){3})\\b",
    category: "PCI",
  },
  {
    name: "CVV Code",
    description: "3 or 4 digit CVV/CVC codes",
    pattern: "\\b\\d{3,4}\\b",
    category: "PCI",
  },

  // PHI / HIPAA
  {
    name: "US National Provider ID (NPI)",
    description: "10-digit NPI numbers",
    pattern: "\\b[0-9]{10}\\b",
    category: "PHI / HIPAA",
  },
  {
    name: "Medical Record Number",
    description: "MRN prefix with 6-12 digits",
    pattern: "MRN[:\\s-]?[0-9]{6,12}",
    category: "PHI / HIPAA",
  },
  {
    name: "Health Insurance ID",
    description: "2-3 letters followed by 8-12 digits",
    pattern: "[A-Z]{2,3}[0-9]{8,12}",
    category: "PHI / HIPAA",
  },
  {
    name: "Date of Birth (US)",
    description: "MM/DD/YYYY format (e.g., 01/15/1990)",
    pattern: "\\b(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/(19|20)\\d{2}\\b",
    category: "PHI / HIPAA",
  },
  {
    name: "ICD-10 Code",
    description: "Medical diagnosis codes (e.g., E11.9)",
    pattern: "[A-Z][0-9]{2}\\.?[0-9A-Z]{0,4}",
    category: "PHI / HIPAA",
  },

  // Secrets
  {
    name: "API Key (Generic)",
    description: "Generic API key patterns with key/value structure",
    pattern: "(api[_-]?key|apikey)[\\s:=\"']+[a-zA-Z0-9_\\-]{16,}",
    category: "Secrets",
  },
  {
    name: "JWT Token",
    description: "JSON Web Tokens (starts with eyJ)",
    pattern: "eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*",
    category: "Secrets",
  },
  {
    name: "UUID",
    description: "UUID v4 format",
    pattern:
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    category: "Secrets",
  },
  {
    name: "AWS Access Key",
    description: "AWS access key ID pattern",
    pattern: "AKIA[0-9A-Z]{16}",
    category: "Secrets",
  },
  {
    name: "Private Key Header",
    description: "PEM private key headers",
    pattern: "-----BEGIN (RSA |EC )?PRIVATE KEY-----",
    category: "Secrets",
  },

  // Keys (attribute key matching)
  {
    name: "API Key (key match)",
    description: "Matches attribute keys containing 'api_key', 'api-key', or 'apikey'",
    pattern: ".*api[_-]?key.*",
    category: "Keys",
    shortDescription: "API keys",
  },
  {
    name: "Auth Token (key match)",
    description: "Matches attribute keys containing 'token'",
    pattern: ".*token.*",
    category: "Keys",
    shortDescription: "Auth tokens",
  },
  {
    name: "Password (key match)",
    description: "Matches attribute keys containing 'password'",
    pattern: ".*password.*",
    category: "Keys",
    shortDescription: "Passwords",
  },
  {
    name: "Secret (key match)",
    description: "Matches attribute keys containing 'secret'",
    pattern: ".*secret.*",
    category: "Keys",
    shortDescription: "Secrets",
  },

  // URL Routes
  {
    name: "Admin/Internal Routes",
    description: "Matches request paths under /admin/ or /internal/",
    pattern: "^/(admin|internal)/.*",
    category: "URL Routes",
  },
  {
    name: "Health Check Routes",
    description: "Matches health, readiness, and liveness probe paths",
    pattern: "^/(health|ready|live).*",
    category: "URL Routes",
  },
  {
    name: "API Routes",
    description: "Matches any request path under /api/",
    pattern: "^/api/.*",
    category: "URL Routes",
  },

  // Value Extraction
  {
    name: "Password in URL Query",
    description: "Captures the password value from a URL query string parameter",
    pattern: "password=([^&]+)",
    category: "Value Extraction",
  },
  {
    name: "Password in Command Line",
    description: "Captures the password value from a command-line argument",
    pattern: "password\\=([^\\s]*)",
    category: "Value Extraction",
  },

  // URL Parsing
  {
    name: "URL Protocol + Domain + Path",
    description:
      "Captures protocol and domain from a URL into named groups http_protocol and http_domain",
    pattern: "^(?P<http_protocol>.*?)://(?P<http_domain>.*?)/",
    category: "URL Parsing",
  },
  {
    name: "URL Protocol + Domain",
    description:
      "Captures protocol (http/https) and domain from a URL into named groups protocol and domain",
    pattern: "^(?P<protocol>https?)://(?P<domain>[^/]+)",
    category: "URL Parsing",
  },

  // Log Parsing
  {
    name: "Generic Log Line (timestamp/level/message)",
    description:
      "Splits a whitespace-delimited log line into timestamp, level, and message named groups",
    pattern: "^(?P<timestamp>\\S+) (?P<level>\\w+) (?P<message>.*)$",
    category: "Log Parsing",
  },
  {
    name: "Date-Prefixed Log Line",
    description: "Splits a log line beginning with an ISO date into time and msg named groups",
    pattern: "^(?P<time>\\d{4}-\\d{2}-\\d{2}) (?P<msg>.*)$",
    category: "Log Parsing",
  },

  // Attribute Key Prefixes
  {
    name: "Generic Prefix",
    description: "Matches attribute keys starting with 'prefix_'",
    pattern: "^prefix_.*",
    category: "Attribute Key Prefixes",
  },
  {
    name: "Temp Prefix",
    description: "Matches attribute keys starting with 'temp_'",
    pattern: "^temp_.*",
    category: "Attribute Key Prefixes",
  },
  {
    name: "PII Prefix",
    description: "Matches attribute keys starting with 'pii_'",
    pattern: "^pii_.*",
    category: "Attribute Key Prefixes",
  },

  // Date Formats
  {
    name: "ISO Date (YYYY-MM-DD)",
    description: "Generic ISO-style date in YYYY-MM-DD form",
    pattern: "\\d{4}-\\d{2}-\\d{2}",
    category: "Date Formats",
  },
];

export function findPattern(name: string): RegexPattern {
  const entry = REGEX_LIBRARY.find((p) => p.name === name);
  if (!entry) {
    throw new Error(
      `regex-library: no pattern named "${name}". Check the lookup string against REGEX_LIBRARY.`,
    );
  }
  return entry;
}

export function tryFindPattern(name: string): RegexPattern | undefined {
  return REGEX_LIBRARY.find((p) => p.name === name);
}

export function getPatternsByCategory(
  category: RegexPatternCategory,
): RegexPattern[] {
  return REGEX_LIBRARY.filter((p) => p.category === category);
}

export function groupPatternsByCategory(
  patterns: readonly RegexPattern[] = REGEX_LIBRARY,
): Record<RegexPatternCategory, RegexPattern[]> {
  const grouped = {} as Record<RegexPatternCategory, RegexPattern[]>;
  for (const pattern of patterns) {
    if (!grouped[pattern.category]) {
      grouped[pattern.category] = [];
    }
    grouped[pattern.category].push(pattern);
  }
  return grouped;
}
