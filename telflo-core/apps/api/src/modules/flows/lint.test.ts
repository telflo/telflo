import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowLintFinding, FlowLintResponse } from "@telflo/contracts";
import { FlowLintResponseSchema } from "@telflo/contracts";
import { loadFlowsMigration } from "@telflo/db/testing";
import { lintFlowConfig, pythonRegExp, pythonStrip } from "./lint.js";

/*
 * The flows' security lint: each rule's cases (classes as describe blocks,
 * tests by their names), then the accepted differences, Python's semantics
 * kept, the exact messages, the seeded flows' answers and hostile input. Where
 * the answer differs from a YAML 1.1 reading (PyYAML 6.0.3), the test says so
 * and why.
 */

const CLEAN = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
  batch: {}
exporters:
  otlp_grpc:
    endpoint: \${env:OTLP_ENDPOINT}
    headers:
      Authorization: \${env:OTLP_TOKEN}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_grpc]
`;

/** The codes of the report's findings, of one severity or all. */
function codes(report: FlowLintResponse, severity?: FlowLintFinding["severity"]): Set<string> {
  return new Set(report.findings.filter((f) => severity === undefined || f.severity === severity).map((f) => f.code));
}

/** The findings as `severity:code@path`, in order. */
function summary(report: FlowLintResponse): string[] {
  return report.findings.map((f) => `${f.severity}:${f.code}@${f.path}`);
}

/**
 * Python's `str.replace(old, new, 1)`: the first `old` in `text` becomes
 * `new` exactly. A function as the replacement, since a string one reads
 * `$$` as `$`, and the provider cases are made of dollars.
 */
const replaceFirst = (text: string, old: string, replacement: string) => text.replace(old, () => replacement);

/** Inserts a receiver into CLEAN's `receivers:` block (appending would nest it under `service:`). */
const withReceiver = (snippet: string) => replaceFirst(CLEAN, "receivers:\n", `receivers:\n${snippet}`);

const withExporter = (snippet: string) => replaceFirst(CLEAN, "exporters:\n", `exporters:\n${snippet}`);

/** CLEAN with the exporter's endpoint replaced. */
const withEndpoint = (endpoint: string) => replaceFirst(CLEAN, "${env:OTLP_ENDPOINT}", endpoint);

/** CLEAN with the exporter's Authorization header replaced. */
const withAuthorization = (value: string) =>
  replaceFirst(CLEAN, "Authorization: ${env:OTLP_TOKEN}", `Authorization: ${value}`);

const lint = (yaml: string) => {
  const report = lintFlowConfig(yaml);
  // Every answer is one the endpoint can send.
  expect(FlowLintResponseSchema.parse(report)).toEqual(report);
  return report;
};

describe("lintFlowConfig: each rule's cases", () => {
  describe("TestCleanConfig", () => {
    it("test_a_correct_config_publishes", () => {
      expect(lint(CLEAN).blocked).toBe(false);
    });

    it("test_receiver_bind_address_is_not_a_destination", () => {
      const report = lint(CLEAN);
      expect(codes(report)).not.toContain("literal-endpoint");
      expect(report.destinations).toEqual([]);
    });
  });

  describe("TestConfmapProviders", () => {
    it("test_file_provider_is_blocked", () => {
      const report = lint(withAuthorization('"${file:/var/run/secrets/kubernetes.io/serviceaccount/token}"'));
      expect(report.blocked).toBe(true);
      expect(codes(report, "block")).toContain("provider-not-allowed");
    });

    it.each(["file", "http", "https", "yaml", "s3"])("test_every_non_env_provider_is_blocked[%s]", (scheme) => {
      expect(codes(lint(withEndpoint(`"\${${scheme}:/etc/passwd}"`)), "block")).toContain("provider-not-allowed");
    });

    it("test_triple_dollar_bypass_is_caught", () => {
      expect(codes(lint(withEndpoint('"$$${file:/etc/passwd}"')), "block")).toContain("provider-not-allowed");
    });

    it("test_genuinely_escaped_reference_is_allowed", () => {
      const report = lint(
        replaceFirst(CLEAN, "endpoint: ${env:OTLP_ENDPOINT}", 'endpoint: ${env:E}\n    x: "$${file:/etc/passwd}"'),
      );
      expect(codes(report)).not.toContain("provider-not-allowed");
    });

    it("test_provider_is_caught_even_when_yaml_is_invalid", () => {
      const report = lint("exporters:\n  otlp:\n    endpoint: ${file:/etc/passwd}\n  [bad");
      expect(codes(report, "block")).toContain("provider-not-allowed");
    });
  });

  describe("TestCredentials", () => {
    const datadogKey = withExporter("  datadog:\n    api:\n      key: abcdef0123456789abcdef0123456789\n");

    it("test_literal_api_key_is_blocked", () => {
      expect(codes(lint(datadogKey), "block")).toContain("hardcoded-credential");
    });

    it("test_literal_authorization_header_is_blocked", () => {
      expect(codes(lint(withAuthorization('"Bearer sk-live-abc123"')), "block")).toContain("hardcoded-credential");
    });

    it("test_env_referenced_credential_is_fine", () => {
      expect(codes(lint(CLEAN))).not.toContain("hardcoded-credential");
    });

    it("test_attribute_names_are_not_credentials", () => {
      const config = replaceFirst(
        CLEAN,
        "  batch: {}",
        "  batch: {}\n" +
          "  resource:\n" +
          "    attributes:\n" +
          "      - key: team\n" +
          "        value: platform\n" +
          "        action: upsert\n" +
          "      - key: cost.center\n" +
          "        value: eng\n" +
          "        action: upsert\n",
      );
      expect(codes(lint(config))).not.toContain("hardcoded-credential");
    });

    it("test_bare_key_under_a_credential_parent_still_blocks", () => {
      expect(codes(lint(datadogKey), "block")).toContain("hardcoded-credential");
    });

    it("test_angle_bracket_placeholder_is_reported_as_unusable_not_leaked", () => {
      const report = lint(withAuthorization('"Bearer <YOUR_API_KEY>"'));
      expect(codes(report, "block")).toContain("placeholder-credential");
      expect(codes(report)).not.toContain("hardcoded-credential");
    });

    it("test_bearer_prefix_with_env_token_is_fine", () => {
      const report = lint(withAuthorization('"Bearer ${env:OTLP_TOKEN}"'));
      expect(codes(report)).not.toContain("hardcoded-credential");
      expect(codes(report)).not.toContain("placeholder-credential");
    });

    it("test_bearer_prefix_with_literal_token_still_blocks", () => {
      expect(codes(lint(withAuthorization('"Bearer sk-live-9f3a2b"')), "block")).toContain("hardcoded-credential");
    });

    it("test_cloud_region_is_not_a_destination", () => {
      expect(codes(lint(withExporter("  awss3:\n    region: us-east-1\n")), "block")).not.toContain("literal-endpoint");
    });
  });

  describe("TestDestinations", () => {
    it("test_hardcoded_exporter_endpoint_is_blocked", () => {
      expect(codes(lint(withEndpoint("https://collector.attacker.example:4317")), "block")).toContain(
        "literal-endpoint",
      );
    });

    it("test_literal_default_inside_env_reference_is_blocked", () => {
      expect(codes(lint(withEndpoint("${env:BACKEND:-https://attacker.example}")), "block")).toContain(
        "literal-endpoint-default",
      );
    });

    it("test_destinations_are_reported_for_the_import_summary", () => {
      const report = lint(withEndpoint("https://otlp.vendor.example:4317"));
      expect(report.destinations.some((destination) => destination.includes("otlp.vendor.example"))).toBe(true);
    });

    it("test_in_cluster_target_warns_rather_than_blocks", () => {
      const report = lint(withEndpoint("gateway.observability.svc:4317"));
      expect(codes(report, "warn")).toContain("local-endpoint");
      expect(codes(report, "block")).not.toContain("literal-endpoint");
    });

    it("test_forwarding_extension_is_surfaced", () => {
      const report = lint(`${CLEAN}\nextensions:\n  http_forwarder:\n    ingress:\n      endpoint: \${env:IN}\n`);
      expect(report.destinations.some((destination) => destination.includes("http_forwarder"))).toBe(true);
    });
  });

  describe("TestSensitivePaths", () => {
    it.each([
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "/etc/shadow",
      "/root/.ssh/id_rsa",
      "/home/user/.aws/credentials",
      "/proc/1/environ",
    ])("test_reading_secrets_is_blocked[%s]", (path) => {
      expect(codes(lint(withReceiver(`  filelog:\n    include: ['${path}']\n`)), "block")).toContain("sensitive-path");
    });

    it("test_ordinary_log_paths_are_allowed", () => {
      const report = lint(withReceiver("  filelog:\n    include: ['/var/log/app/*.log']\n"));
      expect(codes(report)).not.toContain("sensitive-path");
    });
  });

  describe("TestOrgScopedTokens", () => {
    it("test_braced_org_token_is_blocked", () => {
      expect(codes(lint(withEndpoint("${org:PROD_ENDPOINT}")), "block")).toContain("org-scoped-reference");
    });

    it("test_braced_org_token_is_not_double_reported_as_a_provider", () => {
      expect(codes(lint(withEndpoint("${org:PROD_ENDPOINT}")))).not.toContain("provider-not-allowed");
    });

    it("test_legacy_org_token_is_plain_text", () => {
      // Nothing fills `$orgvar:NAME` in, so it is no token.
      expect(codes(lint(withEndpoint("$orgvar:PROD_ENDPOINT")))).not.toContain("org-scoped-reference");
    });

    it("test_escaped_org_token_is_not_blocked", () => {
      expect(codes(lint(withEndpoint("$${org:PROD_ENDPOINT}")))).not.toContain("org-scoped-reference");
    });

    it("test_real_foreign_provider_still_blocked", () => {
      expect(codes(lint(withEndpoint("${file:/etc/passwd}")), "block")).toContain("provider-not-allowed");
    });

    it("test_uppercase_org_scheme_is_still_blocked", () => {
      expect(codes(lint(withEndpoint("${ORG:PROD_ENDPOINT}")), "block")).toContain("provider-not-allowed");
    });
  });

  describe("TestWarnings", () => {
    it("test_missing_memory_limiter_warns", () => {
      const report = lint(replaceFirst(CLEAN, "  memory_limiter:\n    check_interval: 1s\n    limit_mib: 512\n", ""));
      expect(codes(report, "warn")).toContain("no-memory-limiter");
    });

    it("test_privileged_receiver_warns_but_does_not_block", () => {
      const report = lint(withReceiver("  hostmetrics:\n    scrapers:\n      cpu:\n"));
      expect(codes(report, "warn")).toContain("privileged-component");
      expect(report.blocked).toBe(false);
    });

    it("test_disabled_tls_verification_warns", () => {
      const report = lint(withExporter("  extra:\n    insecure_skip_verify: true\n"));
      expect(codes(report, "warn")).toContain("tls-verification-disabled");
    });
  });

  describe("TestMalformedInput", () => {
    it("test_empty_config_is_blocked", () => {
      expect(lint("   ").blocked).toBe(true);
    });

    it("test_non_mapping_config_is_blocked", () => {
      expect(lint("- just\n- a\n- list").blocked).toBe(true);
    });
  });
});

/** The rule messages' fixed parts. */
const ENV_ONLY_DESTINATION =
  "Shared flows must use ${env:...} so importers send data to their own backend, not one chosen by the publisher.";
const LOCAL_TOPOLOGY = "which assumes a specific local topology. Importers may need to change it.";
const NO_MEMORY_LIMITER: FlowLintFinding = {
  severity: "warn",
  code: "no-memory-limiter",
  message: "No memory_limiter processor. Under load the collector can be OOM-killed instead of applying backpressure.",
  path: "processors",
};

describe("lintFlowConfig: each rule's exact answer (messages, paths, destinations, order)", () => {
  it("provider-not-allowed: one finding per live scheme, sorted, on the whole config", () => {
    expect(lint(`${withEndpoint("${https:/x}")}# \${file:/etc/passwd} and $\${s3:x}\n`)).toEqual({
      blocked: true,
      findings: [
        {
          severity: "block",
          code: "provider-not-allowed",
          message:
            "Uses the ${file:...} config provider. Only ${env:...} is allowed in a shared flow — other providers " +
            "read the importer's files or network at config-load time.",
          path: "config",
        },
        {
          severity: "block",
          code: "provider-not-allowed",
          message:
            "Uses the ${https:...} config provider. Only ${env:...} is allowed in a shared flow — other providers " +
            "read the importer's files or network at config-load time.",
          path: "config",
        },
        {
          severity: "block",
          code: "literal-endpoint",
          message: `'endpoint' is the hardcoded destination '\${https:/x}'. ${ENV_ONLY_DESTINATION}`,
          path: "exporters.otlp_grpc.endpoint",
        },
      ],
      destinations: ["exporters.otlp_grpc.endpoint → ${https:/x}"],
    });
  });

  it("org-scoped-reference: each distinct token once, sorted, the legacy form none", () => {
    const report = lint(`${withEndpoint("${org:B}")}# \${org:A} \${org:B} $orgvar:C\n`);
    const tokenFinding = (token: string) => ({
      severity: "block",
      code: "org-scoped-reference",
      message: `Uses the Telflo-scoped token '${token}', which only resolves inside your organization. Inline the value before publishing.`,
      path: "config",
    });
    expect(report.findings.slice(0, 2)).toEqual([tokenFinding("${org:A}"), tokenFinding("${org:B}")]);
    expect(report.findings.filter((finding) => finding.message.includes("orgvar"))).toEqual([]);
  });

  it("hardcoded-credential and placeholder-credential: the key's path from the root, starting with '.'", () => {
    expect(
      lint(withExporter('  extra:\n    api_key: abc\n    headers:\n      x-api-key: "<API KEY>"\n')).findings,
    ).toEqual([
      {
        severity: "block",
        code: "hardcoded-credential",
        message:
          "'api_key' contains a literal value. Publishing this would share your own credential — replace it with ${env:...}.",
        path: ".exporters.extra.api_key",
      },
      {
        severity: "block",
        code: "placeholder-credential",
        message:
          "'x-api-key' uses the placeholder '<API KEY>'. Importers can't fill that in — use ${env:...} so it resolves at runtime.",
        path: ".exporters.extra.headers.x-api-key",
      },
    ]);
  });

  it("literal-endpoint-default: each default, then the value as a destination too", () => {
    expect(lint(withEndpoint("${env:BACKEND:-https://attacker.example}"))).toEqual({
      blocked: true,
      findings: [
        {
          severity: "block",
          code: "literal-endpoint-default",
          message:
            "'endpoint' falls back to the literal 'https://attacker.example'. An importer who does not set the variable " +
            "would send data there — remove the default.",
          path: "exporters.otlp_grpc.endpoint",
        },
        {
          severity: "block",
          code: "literal-endpoint",
          message: `'endpoint' is the hardcoded destination '\${env:BACKEND:-https://attacker.example}'. ${ENV_ONLY_DESTINATION}`,
          path: "exporters.otlp_grpc.endpoint",
        },
      ],
      destinations: ["exporters.otlp_grpc.endpoint → ${env:BACKEND:-https://attacker.example}"],
    });
  });

  it("literal-endpoint and local-endpoint: exporters' and extensions' addresses, in order, with a forwarding extension's", () => {
    const report = lint(
      withExporter("  kafka:\n    brokers: kafka.internal:9092\n    client_url: http://10.0.0.1\n") +
        "extensions:\n  oauth2client:\n    token_url: https://auth.example/token\n",
    );
    expect(report).toEqual({
      blocked: true,
      findings: [
        {
          severity: "warn",
          code: "local-endpoint",
          message: `'brokers' points at 'kafka.internal:9092', ${LOCAL_TOPOLOGY}`,
          path: "exporters.kafka.brokers",
        },
        {
          severity: "block",
          code: "literal-endpoint",
          message: `'client_url' is the hardcoded destination 'http://10.0.0.1'. ${ENV_ONLY_DESTINATION}`,
          path: "exporters.kafka.client_url",
        },
        {
          severity: "block",
          code: "literal-endpoint",
          message: `'token_url' is the hardcoded destination 'https://auth.example/token'. ${ENV_ONLY_DESTINATION}`,
          path: "extensions.oauth2client.token_url",
        },
      ],
      destinations: [
        "exporters.kafka.brokers → kafka.internal:9092",
        "exporters.kafka.client_url → http://10.0.0.1",
        "extensions.oauth2client.token_url → https://auth.example/token",
        "extensions.oauth2client (forwards traffic)",
      ],
    });
  });

  it("sensitive-path: a receiver's value or list item, at the key's path", () => {
    expect(
      lint(withReceiver("  filelog:\n    include: [/var/log/a.log, /ETC/SHADOW]\n    start_at: /root/x\n")),
    ).toEqual({
      blocked: true,
      findings: [
        {
          severity: "block",
          code: "sensitive-path",
          message:
            "Reads '/ETC/SHADOW', which holds credentials or host state. A flow that reads secrets and exports " +
            "telemetry is an exfiltration path.",
          path: "receivers.filelog.include",
        },
        {
          severity: "block",
          code: "sensitive-path",
          message:
            "Reads '/root/x', which holds credentials or host state. A flow that reads secrets and exports " +
            "telemetry is an exfiltration path.",
          path: "receivers.filelog.start_at",
        },
        {
          severity: "warn",
          code: "privileged-component",
          message: "'filelog' requires elevated access: reads files from the host filesystem.",
          path: "receivers.filelog",
        },
      ],
      destinations: [],
    });
  });

  it("privileged-component and tls-verification-disabled: a component's base name; insecure anywhere, from the root", () => {
    expect(
      lint(
        withReceiver("  k8sobjects/pods: {}\n") +
          "extensions:\n  journald: {}\nconnectors:\n  x:\n    tls:\n      insecure: true\n",
      ).findings,
    ).toEqual([
      {
        severity: "warn",
        code: "privileged-component",
        message: "'k8sobjects' requires elevated access: reads arbitrary Kubernetes objects.",
        path: "receivers.k8sobjects/pods",
      },
      {
        severity: "warn",
        code: "privileged-component",
        message: "'journald' requires elevated access: reads systemd journal (host mount).",
        path: "extensions.journald",
      },
      {
        severity: "warn",
        code: "tls-verification-disabled",
        message: "'insecure: true' disables certificate verification.",
        path: ".connectors.x.tls.insecure",
      },
    ]);
  });

  it("no-memory-limiter: a processor named memory_limiter, or memory_limiter/<name>, is enough", () => {
    expect(lint("processors:\n  batch: {}\n")).toEqual({
      blocked: false,
      findings: [NO_MEMORY_LIMITER],
      destinations: [],
    });
    expect(lint("processors:\n  memory_limiter/main: {}\n").findings).toEqual([]);
  });

  it("empty-config, invalid-yaml and invalid-config: one finding on the whole config", () => {
    expect(lint("")).toEqual({
      blocked: true,
      findings: [{ severity: "block", code: "empty-config", message: "The configuration is empty.", path: "config" }],
      destinations: [],
    });
    expect(lint("a: [1\n")).toEqual({
      blocked: true,
      findings: [
        {
          severity: "block",
          code: "invalid-yaml",
          message: expect.stringMatching(/^Configuration is not valid YAML: ./),
          path: "config",
        },
      ],
      destinations: [],
    });
    expect(lint("just a string\n")).toEqual({
      blocked: true,
      findings: [
        { severity: "block", code: "invalid-config", message: "Configuration must be a YAML mapping.", path: "config" },
      ],
      destinations: [],
    });
  });
});

/*
 * The accepted differences: the text is read as YAML 1.2 (the collector's
 * reading, through the `yaml` package), where PyYAML reads YAML 1.1. Each
 * test names PyYAML's answer.
 */
describe("lintFlowConfig: the accepted differences (YAML 1.2, not 1.1)", () => {
  it("`yes` is a string, so `insecure: yes` disables nothing (PyYAML: true, a tls-verification-disabled warning)", () => {
    // The collector reads `yes` as YAML 1.2 does: the string "yes".
    expect(codes(lint(withExporter("  extra:\n    insecure: yes\n")))).not.toContain("tls-verification-disabled");
    expect(codes(lint(withExporter("  extra:\n    insecure: true\n")))).toContain("tls-verification-disabled");
  });

  it("`on` is a string too (PyYAML: true, a warning)", () => {
    expect(codes(lint(withExporter("  extra:\n    insecure_skip_verify: on\n")))).not.toContain(
      "tls-verification-disabled",
    );
  });

  it("`0o755` is a number, so it is no literal password (PyYAML: the string '0o755', hardcoded-credential)", () => {
    // YAML 1.2's octal is 0o755; YAML 1.1's was 0755, a number in both.
    expect(codes(lint(withExporter("  extra:\n    password: 0o755\n")))).not.toContain("hardcoded-credential");
    expect(codes(lint(withExporter("  extra:\n    password: 0755\n")))).not.toContain("hardcoded-credential");
  });

  it("`1e3` is a number (PyYAML: the string '1e3', since 1.1's floats need a dot; hardcoded-credential)", () => {
    expect(codes(lint(withExporter("  extra:\n    password: 1e3\n")))).not.toContain("hardcoded-credential");
  });

  it("`2024-01-01` is a string, so it is a literal password (PyYAML: a date, no finding)", () => {
    // YAML 1.2's core schema has no timestamps; the collector reads the string.
    expect(summary(lint(withExporter("  extra:\n    password: 2024-01-01\n")))).toEqual([
      "block:hardcoded-credential@.exporters.extra.password",
    ]);
  });

  it("`1_000` and `1:20` are strings, so each is a literal endpoint (PyYAML: the numbers 1000 and 80, no finding)", () => {
    expect(summary(lint(withExporter("  extra:\n    endpoint: 1_000\n")))).toEqual([
      "block:literal-endpoint@exporters.extra.endpoint",
    ]);
    expect(lint(withExporter("  extra:\n    endpoint: 1:20\n")).destinations).toEqual([
      "exporters.extra.endpoint → 1:20",
    ]);
  });

  it("a duplicate key is invalid-yaml (PyYAML: the last one won, so an endpoint could hide behind a second)", () => {
    // The collector's parser refuses a mapping key defined twice too.
    for (const extra of [
      "  extra:\n    endpoint: https://a.example\n    endpoint: ${env:X}\n",
      "  extra:\n    endpoint: ${env:X}\n    endpoint: https://a.example\n",
    ]) {
      expect(summary(lint(withExporter(extra)))).toEqual(["block:invalid-yaml@config"]);
    }
    expect(summary(lint(`${CLEAN}exporters:\n  e2:\n    endpoint: https://evil.example\n`))).toEqual([
      "block:invalid-yaml@config",
    ]);
  });

  it("a key read as null, a boolean or a number is named as written (PyYAML: None, True, 1)", () => {
    expect(summary(lint(withExporter("  extra:\n    yes:\n      password: abc\n")))).toEqual([
      "block:hardcoded-credential@.exporters.extra.yes.password",
    ]);
    expect(summary(lint(withExporter("  extra:\n    ~:\n      password: abc\n")))).toEqual([
      "block:hardcoded-credential@.exporters.extra.~.password",
    ]);
    expect(
      summary(
        lint(withExporter("  extra:\n    true: {password: a}\n    0x1F: {password: b}\n    null: {password: c}\n")),
      ),
    ).toEqual([
      "block:hardcoded-credential@.exporters.extra.true.password",
      "block:hardcoded-credential@.exporters.extra.0x1F.password",
      "block:hardcoded-credential@.exporters.extra.null.password",
    ]);
  });

  it("a number key and the same digits quoted stay two keys, in the text's order", () => {
    expect(
      summary(lint(withExporter("  extra:\n    1: {password: a}\n    '1': {password: b}\n    0: {api_key: c}\n"))),
    ).toEqual([
      "block:hardcoded-credential@.exporters.extra.1.password",
      "block:hardcoded-credential@.exporters.extra.1.password",
      "block:hardcoded-credential@.exporters.extra.0.api_key",
    ]);
  });

  it("a custom tag proceeds, its value read as a string (PyYAML: no constructor for '!foo', invalid-yaml)", () => {
    // A YAML 1.2 parser keeps an unknown local tag's value; the `yaml` package warns, and the warning isn't logged.
    expect(summary(lint(withExporter("  extra:\n    password: !foo abc\n")))).toEqual([
      "block:hardcoded-credential@.exporters.extra.password",
    ]);
  });

  it("a complex key proceeds, named in flow style (PyYAML: an unhashable key, invalid-yaml)", () => {
    expect(summary(lint(withExporter("  extra:\n    ? [a, b]\n    : {password: abc}\n")))).toEqual([
      "block:hardcoded-credential@.exporters.extra.[a, b].password",
    ]);
  });

  it("more than 100 aliases is invalid-yaml, an alias bomb (PyYAML: no limit, it built the whole tree)", () => {
    const bomb =
      "a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n" +
      "d: [*c,*c]\nprocessors: {memory_limiter: {}}\n";
    expect(lint(bomb).findings).toEqual([
      {
        severity: "block",
        code: "invalid-yaml",
        message: "Configuration is not valid YAML: Excessive alias count indicates a resource exhaustion attack",
        path: "config",
      },
    ]);
  });

  it("invalid-yaml's message is the `yaml` package's, not PyYAML's (the code and path are fixed)", () => {
    // PyYAML: "while parsing a block mapping … expected <block end>, but found '['".
    expect(lint("exporters:\n  otlp:\n    endpoint: x\n  [bad").findings).toEqual([
      {
        severity: "block",
        code: "invalid-yaml",
        message:
          "Configuration is not valid YAML: Flow sequence in block collection must be sufficiently indented and end with a ]",
        path: "config",
      },
    ]);
    expect(lint(`${CLEAN}---\na: 1\n`).findings[0]?.message).toBe(
      "Configuration is not valid YAML: Source contains multiple documents; please use YAML.parseAllDocuments()",
    );
  });
});

/*
 * Where Python's string and regex semantics decide an answer, the
 * lint keeps them. Each case's answer is what Python gives.
 */
describe("lintFlowConfig: Python's string and regex semantics, kept", () => {
  it("`$` matches before one final newline: a key ending in a newline is still a secret's or an address's", () => {
    expect(
      summary(lint(withExporter('  extra:\n    "token\\n": abc\n    "endpoint\\n": https://a.example\n'))),
    ).toEqual([
      "block:hardcoded-credential@.exporters.extra.token\n",
      "block:literal-endpoint@exporters.extra.endpoint\n",
    ]);
    expect(summary(lint(withExporter('  extra:\n    headers:\n      "Authorization\\n": abc\n')))).toEqual([
      "block:hardcoded-credential@.exporters.extra.headers.Authorization\n",
    ]);
    // Only one: two newlines, or text after one, end no match.
    expect(summary(lint(withExporter('  extra:\n    "token\\n\\n": abc\n    "token\\nx": abc\n')))).toEqual([]);
  });

  it("case-insensitive matching is Python's: the Kelvin sign and the long s fold, and so do the dotless ı and dotted İ", () => {
    expect(
      summary(
        lint(
          withExporter(
            "  extra:\n    api_\u212aey: a\n    \u017fecret: b\n    ap\u0131_key: c\n    AP\u0130KEY: d\n    endpo\u0130nt: x.example\n",
          ),
        ),
      ),
    ).toEqual([
      "block:hardcoded-credential@.exporters.extra.api_\u212aey",
      "block:hardcoded-credential@.exporters.extra.\u017fecret",
      "block:hardcoded-credential@.exporters.extra.ap\u0131_key",
      "block:hardcoded-credential@.exporters.extra.AP\u0130KEY",
      "block:literal-endpoint@exporters.extra.endpo\u0130nt",
    ]);
    // A host under `.\u0130nternal`, or with a dotless ı, is local, as `[a-z]` with IGNORECASE reads it.
    expect(summary(lint(withEndpoint("gate\u0131way.\u0130NTERNAL:4317")))).toEqual([
      "warn:local-endpoint@exporters.otlp_grpc.endpoint",
    ]);
    // `KEY` under a credential parent, by Python's lower(): the Kelvin sign lowers to k.
    expect(summary(lint(withExporter("  datadog:\n    API:\n      \u212aEY: abc\n")))).toEqual([
      "block:hardcoded-credential@.exporters.datadog.API.\u212aEY",
    ]);
  });

  it("`\\d` is any Unicode decimal digit: an address in Arabic-Indic digits is local", () => {
    expect(summary(lint(withEndpoint("127.\u0660.\u0660.\u0661:\u0664\u0663\u0661\u0667")))).toEqual([
      "warn:local-endpoint@exporters.otlp_grpc.endpoint",
    ]);
    // Superscript two is a digit to Python's isdigit() but not decimal, so not `\\d`.
    expect(summary(lint(withEndpoint("localhost:\u00b2")))).toEqual([
      "block:literal-endpoint@exporters.otlp_grpc.endpoint",
    ]);
  });

  it("strip() is Python's: U+001C–U+001F and U+0085 are whitespace, U+FEFF is not", () => {
    // Python strips them, so nothing literal is left; JavaScript's trim() would leave them.
    expect(
      summary(lint(withExporter('  extra:\n    password: "\\x1c\\x1d\\x1e\\x1f"\n    api_key: "\\N${env:K}"\n'))),
    ).toEqual([]);
    // Python keeps U+FEFF, a literal; trim() would strip it.
    expect(summary(lint(withExporter('  extra:\n    password: "\\uFEFF"\n')))).toEqual([
      "block:hardcoded-credential@.exporters.extra.password",
    ]);
    // A text of Python's whitespace is empty; one of U+FEFF is not (an empty document, so not a mapping).
    expect(summary(lint("\u001c\u001d\u001e\u001f\u0085\n"))).toEqual(["block:empty-config@config"]);
    expect(summary(lint("\ufeff"))).toEqual(["block:invalid-config@config"]);
  });

  it("a character YAML doesn't allow in a stream is invalid-yaml, as PyYAML's reader refused it (and the collector's)", () => {
    for (const [character, codePoint] of [
      ["\u0007", "0007"],
      ["\u0000", "0000"],
      ["\u007f", "007f"],
      ["\ud800", "d800"],
      ["\uffff", "ffff"],
    ] as const) {
      // PyYAML's message exactly, its position in code points.
      expect(lint(`${CLEAN}# \u{1F600}${character}\n`).findings).toEqual([
        {
          severity: "block",
          code: "invalid-yaml",
          message:
            `Configuration is not valid YAML: unacceptable character #x${codePoint}: special characters are not allowed\n` +
            `  in "<unicode string>", position ${CLEAN.length + 3}`,
          path: "config",
        },
      ]);
    }
    // Tabs, U+FEFF and astral characters are allowed.
    expect(lint(`${CLEAN}#\t\ufeff\u{1F600}\n`).findings).toEqual([]);
    // The raw-text rules still run first.
    expect(summary(lint(`${CLEAN}# \${file:x} \u0007\n`))).toEqual([
      "block:provider-not-allowed@config",
      "block:invalid-yaml@config",
    ]);
  });
});

describe("lintFlowConfig: a line break only YAML 1.1 has (beyond the accepted differences)", () => {
  it("refuses a lone CR, U+0085, U+2028 or U+2029 as invalid-yaml: after a comment, the `yaml` package would read past one", () => {
    // PyYAML and the collector's parser (libyaml's) start a new line at each,
    // so `exporters:` here is a section to them; the `yaml` package would
    // read it as the comment's, and lint nothing.
    for (const [lineBreak, codePoint] of [
      ["\r", "000d"],
      ["\u0085", "0085"],
      ["\u2028", "2028"],
      ["\u2029", "2029"],
    ] as const) {
      expect(lint(`${CLEAN}# note${lineBreak}exporters: {x: {endpoint: https://evil.example}}\n`)).toEqual({
        blocked: true,
        findings: [
          {
            severity: "block",
            code: "invalid-yaml",
            message: `Configuration is not valid YAML: unsupported line break #x${codePoint}: the collector reads it as a new line; use \\n`,
            path: "config",
          },
        ],
        destinations: [],
      });
    }
  });

  it("reads CRLF line endings as lines, as everyone does", () => {
    expect(lint(CLEAN.replaceAll("\n", "\r\n"))).toEqual({ blocked: false, findings: [], destinations: [] });
  });
});

describe("pythonRegExp and pythonStrip (Python's semantics, checked against Python's re)", () => {
  it("`$` matches at the end or before one final newline", () => {
    const end = pythonRegExp("^a$");
    expect(["a", "a\n", "a\n\n", "a\nb"].map((text) => end.test(text))).toEqual([true, true, false, false]);
  });

  it("`\\d` is a Unicode decimal digit (category Nd)", () => {
    const digits = pythonRegExp("^\\d+$");
    expect(["123", "\u0661\u0662\u0663", "\u00b2", "x"].map((text) => digits.test(text))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("`\\s` is Python's whitespace", () => {
    const space = pythonRegExp("^\\s$");
    expect(["\x1c", "\x85", "\u3000", "\ufeff", "x"].map((text) => space.test(text))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("`\\b` after a word: a Unicode letter or number continues the word, a combining mark or punctuation doesn't", () => {
    const scheme = pythonRegExp("^(bearer)\\b", { ignoreCase: true });
    expect(
      ["Bearer x", "bearer", "bearer-", "bearer\u0301", "bearer\u00df", "bearer\u00b2", "bearer_", "bearerx"].map(
        (text) => scheme.test(text),
      ),
    ).toEqual([true, true, true, true, false, false, false, false]);
  });

  it("ignoreCase folds as Python's: `i` matches İ and ı, in a class's a-z too", () => {
    expect(
      ["API", "AP\u0130", "ap\u0131", "apj"].map((text) => pythonRegExp("^api$", { ignoreCase: true }).test(text)),
    ).toEqual([true, true, true, false]);
    expect(pythonRegExp("^[a-z]+$", { ignoreCase: true }).test("\u0131\u0130\u212a\u017f")).toBe(true);
    expect(pythonRegExp("^[a-z]+$").test("\u0131")).toBe(false);
  });

  it("names groups as Python's `(?P<name>` does", () => {
    expect(pythonRegExp("(?P<word>[a-z]+)").exec("--abc--")?.groups).toEqual({ word: "abc" });
  });

  it("pythonStrip strips Python's whitespace, or the characters it is given, from both ends only", () => {
    expect(pythonStrip(" \x1c\ufeffa \x1c b\ufeff\x85 ")).toBe("\ufeffa \x1c b\ufeff");
    expect(pythonStrip(`"'x'"`, (character) => character === '"' || character === "'")).toBe("x");
    expect(pythonStrip("")).toBe("");
  });
});

/** A seeded flow's health check on 0.0.0.0:13133, the local-endpoint warning eight of them carry. */
const HEALTH_CHECK_ANY: FlowLintFinding = {
  severity: "warn",
  code: "local-endpoint",
  message: `'endpoint' points at '0.0.0.0:13133', ${LOCAL_TOPOLOGY}`,
  path: "extensions.health_check.endpoint",
};
const HEALTH_CHECK_ANY_DESTINATION = "extensions.health_check.endpoint → 0.0.0.0:13133";

const privileged = (component: string, access: string): FlowLintFinding => ({
  severity: "warn",
  code: "privileged-component",
  message: `'${component}' requires elevated access: ${access}.`,
  path: `receivers.${component}`,
});

/**
 * Each seeded flow's answer (five blocked). Advisory: a blocked seeded flow
 * is published all the same.
 */
const SEEDED_ANSWERS: Record<string, FlowLintResponse> = {
  "log-volume-cost-control": {
    blocked: true,
    findings: [
      {
        severity: "block",
        code: "placeholder-credential",
        message:
          "'Authorization' uses the placeholder 'Bearer <YOUR_API_KEY>'. Importers can't fill that in — use ${env:...} so it resolves at runtime.",
        path: ".exporters.otlp_http.headers.Authorization",
      },
      HEALTH_CHECK_ANY,
      privileged("filelog", "reads files from the host filesystem"),
    ],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "kubernetes-telemetry-stack": {
    blocked: false,
    findings: [
      HEALTH_CHECK_ANY,
      privileged("filelog", "reads files from the host filesystem"),
      privileged("kubeletstats", "kubelet API access"),
      privileged("k8s_cluster", "cluster-wide read RBAC"),
      privileged("k8s_events", "cluster-wide event read RBAC"),
      {
        severity: "warn",
        code: "tls-verification-disabled",
        message: "'insecure_skip_verify: true' disables certificate verification.",
        path: ".receivers.kubeletstats.insecure_skip_verify",
      },
    ],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "tail-sampling-keep-errors": { blocked: false, findings: [], destinations: [] },
  "metric-cardinality-firewall": { blocked: false, findings: [], destinations: [] },
  "host-fleet-monitoring": {
    blocked: false,
    findings: [
      {
        severity: "warn",
        code: "local-endpoint",
        message: `'endpoint' points at 'localhost:13133', ${LOCAL_TOPOLOGY}`,
        path: "extensions.health_check.endpoint",
      },
      privileged("hostmetrics", "reads host CPU, memory, disk and network"),
      privileged("filelog", "reads files from the host filesystem"),
      privileged("journald", "reads systemd journal (host mount)"),
    ],
    destinations: ["extensions.health_check.endpoint → localhost:13133"],
  },
  "dual-ship-migration-bridge": {
    blocked: true,
    findings: [
      {
        severity: "block",
        code: "literal-endpoint",
        message: `'site' is the hardcoded destination 'datadoghq.com'. ${ENV_ONLY_DESTINATION}`,
        path: "exporters.datadog.api.site",
      },
      HEALTH_CHECK_ANY,
    ],
    destinations: ["exporters.datadog.api.site → datadoghq.com", HEALTH_CHECK_ANY_DESTINATION],
  },
  "pii-redaction-gateway": {
    blocked: true,
    findings: [
      {
        severity: "block",
        code: "placeholder-credential",
        message:
          "'authorization' uses the placeholder '<YOUR_API_KEY>'. Importers can't fill that in — use ${env:...} so it resolves at runtime.",
        path: ".exporters.otlp_grpc.headers.authorization",
      },
      HEALTH_CHECK_ANY,
    ],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "outage-proof-pipeline": {
    blocked: false,
    findings: [HEALTH_CHECK_ANY],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "otel-to-clickstack": {
    blocked: true,
    findings: [
      {
        severity: "block",
        code: "literal-endpoint",
        message: `'endpoint' is the hardcoded destination ':13133'. ${ENV_ONLY_DESTINATION}`,
        path: "extensions.health_check.endpoint",
      },
    ],
    destinations: ["extensions.health_check.endpoint → :13133"],
  },
  "llm-telemetry-gateway": {
    blocked: true,
    findings: [
      {
        severity: "block",
        code: "literal-endpoint",
        message: `'endpoint' is the hardcoded destination 'https://cloud.langfuse.com/api/public/otel'. ${ENV_ONLY_DESTINATION}`,
        path: "exporters.otlp_http/langfuse.endpoint",
      },
    ],
    destinations: ["exporters.otlp_http/langfuse.endpoint → https://cloud.langfuse.com/api/public/otel"],
  },
  "datadog-to-elastic-migration-bridge": {
    blocked: false,
    findings: [HEALTH_CHECK_ANY],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "datadog-to-clickstack-migration-bridge": {
    blocked: false,
    findings: [HEALTH_CHECK_ANY],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
  "clickhouse-failover-gateway-s3-overflow": {
    blocked: false,
    findings: [HEALTH_CHECK_ANY],
    destinations: [HEALTH_CHECK_ANY_DESTINATION],
  },
};

describe("lintFlowConfig: the 13 seeded flows", () => {
  it("answers each exactly; five are blocked", async () => {
    const { seededFlows } = await loadFlowsMigration();
    expect(seededFlows.map((flow) => flow.slug).sort()).toEqual(Object.keys(SEEDED_ANSWERS).sort());
    for (const flow of seededFlows) {
      expect({ slug: flow.slug, ...lint(flow.yaml_content) }).toEqual({
        slug: flow.slug,
        ...SEEDED_ANSWERS[flow.slug],
      });
    }
    expect(
      seededFlows
        .filter((flow) => lint(flow.yaml_content).blocked)
        .map((flow) => flow.slug)
        .sort(),
    ).toEqual([
      "dual-ship-migration-bridge",
      "llm-telemetry-gateway",
      "log-volume-cost-control",
      "otel-to-clickstack",
      "pii-redaction-gateway",
    ]);
  });
});

describe("lintFlowConfig: merges, sets, odd sections and hostile input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows merge keys and aliases: a merged secret is the merging mapping's, an aliased one is found twice", () => {
    expect(
      summary(lint(withExporter("  extra:\n    <<: &base\n      api_key: hunter2\n    endpoint: ${env:X}\n"))),
    ).toEqual(["block:hardcoded-credential@.exporters.extra.api_key"]);
    expect(summary(lint(`x-base: &b\n  api_key: hunter2\n${withExporter("  extra:\n    <<: *b\n")}`))).toEqual([
      "block:hardcoded-credential@.x-base.api_key",
      "block:hardcoded-credential@.exporters.extra.api_key",
    ]);
    expect(
      summary(lint(withExporter("  a:\n    headers: &h\n      Authorization: Bearer abc\n  b:\n    headers: *h\n"))),
    ).toEqual([
      "block:hardcoded-credential@.exporters.a.headers.Authorization",
      "block:hardcoded-credential@.exporters.b.headers.Authorization",
    ]);
  });

  it("names a section's components as Python iterated it: a list's items, a set's, a string's characters", () => {
    // A list and a set of names are names; a string is its characters, so `processors: memory_limiter` has none.
    expect(
      summary(lint("receivers: [hostmetrics]\nextensions: !!set {oauth2client}\nprocessors: [memory_limiter]\n")),
    ).toEqual(["warn:privileged-component@receivers.hostmetrics"]);
    expect(
      lint("receivers: [hostmetrics]\nextensions: !!set {oauth2client}\nprocessors: [memory_limiter]\n").destinations,
    ).toEqual(["extensions.oauth2client (forwards traffic)"]);
    expect(summary(lint("processors: memory_limiter\n"))).toEqual(["warn:no-memory-limiter@processors"]);
    // A list of exporters is walked by index.
    expect(summary(lint("exporters:\n  - endpoint: https://evil.example\nprocessors: {memory_limiter: {}}\n"))).toEqual(
      ["block:literal-endpoint@exporters[0].endpoint"],
    );
  });

  it("lints a section that is a number or a boolean as having no components", () => {
    expect(summary(lint("receivers: 5\nextensions: true\nprocessors: 1.5\nexporters: 7\n"))).toEqual([
      "warn:no-memory-limiter@processors",
    ]);
  });

  it("refuses an alias inside the node it names as invalid-yaml (a walk would never end)", () => {
    for (const text of ["a: &a [1, *a]\n", "a: &a {b: *a}\n", "exporters: &e\n  x:\n    y: *e\n"]) {
      expect(lint(text).findings).toEqual([
        {
          severity: "block",
          code: "invalid-yaml",
          message: "Configuration is not valid YAML: An alias refers to a node that contains it.",
          path: "config",
        },
      ]);
    }
    // An alias used twice side by side is no cycle.
    expect(summary(lint("a: &a [1]\nb: [*a, *a]\nprocessors: {memory_limiter: {}}\n"))).toEqual([]);
  });

  it("refuses nesting deeper than the parser goes as invalid-yaml, and walks deep nesting it accepts without running out of stack", () => {
    expect(summary(lint(`a: ${"[".repeat(5000)}${"]".repeat(5000)}\n`))).toEqual(["block:invalid-yaml@config"]);
    const depth = 200;
    const deep = `exporters:\n  x: ${"{a: ".repeat(depth)}{api_key: abc}${"}".repeat(depth)}\nprocessors: {memory_limiter: {}}\n`;
    expect(summary(lint(deep))).toEqual([`block:hardcoded-credential@.exporters.x${".a".repeat(depth)}.api_key`]);
  });

  it("never passes a warning to the process or the console, a complex key and an unknown tag included", () => {
    const emitWarning = vi.spyOn(process, "emitWarning");
    const consoleMethods = (["log", "warn", "error", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    lint(withExporter("  extra:\n    ? [a, b]\n    : {password: !foo abc}\n    ? {c: d}\n    : !!binary aGVsbG8=\n"));
    lint("a: [1\n");
    expect(emitWarning).not.toHaveBeenCalled();
    for (const method of consoleMethods) expect(method).not.toHaveBeenCalled();
  });

  it("does not change the text it is given or hold state between calls", () => {
    const text = withExporter("  extra:\n    ~: {password: a}\n");
    const first = lint(text);
    expect(lint(text)).toEqual(first);
    expect(lint(CLEAN)).toEqual({ blocked: false, findings: [], destinations: [] });
  });
});
