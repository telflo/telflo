import {
  AGENT_ENDPOINT_PATTERN,
  INSTALL_ARCHES,
  INSTALL_ENV_NAME_PATTERN,
  installEnvValueProblem,
  installPathProblem,
  type InstallArch,
  type InstallMethod,
} from "@telflo/contracts";

/*
 * Rendering a Linux bundle's templates. The server fills every placeholder
 * from validated fields and the catalog only, in one pass: a value is
 * never read again for placeholders, so a typed `${ROOT_PATH}` stays text
 * (a sequential replace would substitute it).
 *
 * A placeholder is `${UPPER_SNAKE}` (exactly `\$\{([A-Z_][A-Z0-9_]*)\}`), so
 * the scripts' own `${OPAMP_TOKEN:-}`, `${server_name}` and the YAML's
 * `${env:…}` are left as they are. Each method has its own known set; a
 * template naming any other is refused when it is loaded (templates.ts).
 *
 * Each value is encoded for where it lands, by the file's kind:
 *   - a script (`*.sh`): a value is the right side of an assignment line,
 *     `name=${ROOT_PATH}` (placeholders and the letters, digits and
 *     `._/:@+-` around them form one word), written as one single-quoted
 *     shell word (`'` as `'\''`); a block (`COLLECTOR_ENV_EXPORTS`,
 *     `SUPERVISOR_VERSION_CASES`, shell lines the server builds with the same
 *     quoting) stands alone on its line;
 *   - YAML (`*.yaml`, `*.yml`): a value is a mapping's or a sequence item's
 *     whole value on its line, written as one double-quoted scalar, a
 *     boolean as `true` or `false` alone (yamlQuoted: a value holding `"`,
 *     `\`, `$` or a control character is refused, never escaped);
 *   - anything else (the README): the value as it is.
 * Anywhere else a placeholder is refused when the template is loaded, so a
 * value never lands where its quoting would be wrong; in a script, that
 * includes a line inside a quote or a heredoc opened on an earlier line, or
 * continued by a trailing backslash (shellLineStates, a small scanner).
 *
 * The templates themselves are trusted: an operator's own code, run as root
 * on the hosts that install from them. These rules keep the values Telflo
 * writes (which a member types) where their quoting holds; they don't make a
 * template's own commands safe.
 *
 * The values are checked again here before they reach a script run as root:
 * paths by the contract's rule, the catalog's version, URLs and sha256 by
 * its own allow-lists (catalogue.ts's), the group's id a UUID, and nothing
 * written into YAML holds a control character, a Unicode line break, `"`,
 * `\` or `$` (yamlQuoted). A template's text and a render's output are
 * never logged.
 */

export type PlaceholderKind = "string" | "boolean" | "shell-lines";

const SHARED: Record<string, PlaceholderKind> = {
  OPAMP_ENDPOINT: "string",
  OPAMP_ALLOW_INSECURE_CONNECTIONS: "boolean",
  COLLECTOR_GROUP_ID: "string",
  ARCH: "string",
  ROOT_PATH: "string",
  OTELCOL_VERSION: "string",
  OPAMPSUPERVISOR_DOWNLOAD_URL: "string",
  OPAMPSUPERVISOR_SHA256: "string",
  COLLECTOR_ENV_EXPORTS: "shell-lines",
};

/** Each method's placeholders: the arch through ARCH and the binaries' own. */
export const METHOD_PLACEHOLDERS: Readonly<Record<InstallMethod, Readonly<Record<string, PlaceholderKind>>>> = {
  "all-in-one": {
    ...SHARED,
    OTELCOL_CONTRIB_DOWNLOAD_URL: "string",
    OTELCOL_CONTRIB_SHA256: "string",
  },
  "own-binary": {
    ...SHARED,
    EXECUTABLE_PATH: "string",
    CONFIG_PATH: "string",
    STORAGE_DIRECTORY: "string",
    SUPERVISOR_VERSION_CASES: "shell-lines",
  },
};

export const PLACEHOLDER_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export type TemplateKind = "shell" | "yaml" | "text";

export function templateKindOf(fileName: string): TemplateKind {
  if (fileName.endsWith(".sh")) return "shell";
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) return "yaml";
  return "text";
}

/** One word of placeholders and the plain characters around them. */
const WORD = String.raw`(?:\$\{[A-Z_][A-Z0-9_]*\}|[A-Za-z0-9._/:@+-])+`;
const SHELL_ASSIGNMENT = new RegExp(String.raw`^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=)(${WORD})([ \t\r]*)$`);
const SHELL_BLOCK = /^[ \t]*\$\{([A-Z_][A-Z0-9_]*)\}([ \t\r]*)$/;
const YAML_VALUE = new RegExp(String.raw`^([ \t]*(?:- |[A-Za-z0-9_.-]+:[ \t]+))(${WORD})([ \t\r]*)$`);
const ONE_PLACEHOLDER = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] as string);
}

/** Why a template can't be used, at a line (1-based): the reason is the platform's words, never the template's text. */
export interface TemplateProblem {
  line: number;
  reason: string;
}

/**
 * A template's problem, or null: a placeholder its method doesn't fill, or
 * one where its quoting can't be right (see above).
 */
export function templateProblem(method: InstallMethod, fileName: string, text: string): TemplateProblem | null {
  const known = METHOD_PLACEHOLDERS[method];
  const kind = templateKindOf(fileName);
  const lines = text.split("\n");
  const opened = kind === "shell" ? shellLineStates(lines) : [];
  for (const [index, line] of lines.entries()) {
    const names = placeholdersOf(line);
    if (names.length === 0) continue;
    const at = index + 1;
    if (names.some((name) => known[name] === undefined)) return { line: at, reason: "a placeholder Telflo doesn't fill" };
    if (opened[index] === true) return { line: at, reason: "a placeholder inside a quote, a heredoc or a continued line" };
    const isBlock = names.some((name) => known[name] === "shell-lines");
    if (isBlock) {
      if (kind !== "shell") return { line: at, reason: "a block of shell lines outside a script" };
      if (!SHELL_BLOCK.test(line)) return { line: at, reason: "a block of shell lines not alone on its line" };
      continue;
    }
    if (kind === "shell" && !SHELL_ASSIGNMENT.test(line)) {
      return { line: at, reason: "a value not on the right of an assignment line" };
    }
    if (kind === "yaml") {
      const matched = YAML_VALUE.exec(line);
      if (matched === null) return { line: at, reason: "a value not the whole value of its line" };
      const isBoolean = names.some((name) => known[name] === "boolean");
      if (isBoolean && !ONE_PLACEHOLDER.test(matched[2] as string)) return { line: at, reason: "a boolean not alone" };
    }
  }
  return null;
}

interface Heredoc {
  delimiter: string;
  /** `<<-`: the closing line's leading tabs are stripped. */
  strip: boolean;
}

/**
 * For each line of a script, whether it begins inside something an earlier
 * line opened: a single, double, `$'…'` or backtick quote, a heredoc (until
 * its delimiter's line), or a line continued by a trailing backslash. A
 * small scanner, not bash's parser: what it can't tell apart (`$((1 << 2))`
 * read as a heredoc, say) only ever refuses more.
 */
export function shellLineStates(lines: readonly string[]): boolean[] {
  const states: boolean[] = [];
  let quote: "'" | '"' | "$'" | "`" | null = null;
  let heredoc: Heredoc | null = null;
  const pending: Heredoc[] = [];
  let continued = false;
  for (const line of lines) {
    states.push(quote !== null || heredoc !== null || continued);
    continued = false;
    if (heredoc !== null) {
      const closing = (heredoc.strip ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
      if (closing === heredoc.delimiter) heredoc = pending.shift() ?? null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        continue;
      }
      if (quote !== null) {
        if (c === "\\") i += 1;
        else if ((quote === "$'" && c === "'") || c === quote) quote = null;
        continue;
      }
      if (c === "\\") {
        if (i === line.replace(/\r$/, "").length - 1) continued = true;
        i += 1;
      } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(line[i - 1] as string))) break;
      else if (c === "'") quote = i > 0 && line[i - 1] === "$" ? "$'" : "'";
      else if (c === '"' || c === "`") quote = c;
      else if (c === "<" && line[i + 1] === "<") {
        if (line[i + 2] === "<") {
          i += 2;
          continue;
        }
        let j = i + 2;
        const strip = line[j] === "-";
        if (strip) j += 1;
        while (line[j] === " " || line[j] === "\t") j += 1;
        const word = /^(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_.-]+))/.exec(line.slice(j));
        if (word !== null) {
          pending.push({ delimiter: (word[1] ?? word[2] ?? word[3]) as string, strip });
          i = j + word[0].length - 1;
        } else i += 1;
      }
    }
    if (pending.length > 0) heredoc = pending.shift() ?? null;
  }
  return states;
}

/** A value the server fills: a string, a boolean, or shell lines it built. */
export type PlaceholderValue = string | boolean;

export function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// eslint-disable-next-line no-control-regex -- the rule is "no control character"
const NOT_FOR_YAML = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\$]/;

/**
 * A YAML double-quoted scalar. A value holding a control character, a
 * Unicode line break, `"`, `\` or `$` is never written: the supervisor
 * copies the agent's attributes unescaped into its own telemetry's
 * configuration and into the collector's, where otelcol-contrib expands
 * `${env:…}` again (a `$$` doubling isn't enough there). None of the
 * server's values can hold one (a UUID, paths, the endpoint, the
 * catalog's URLs); the ServerName header, the one free text, is the
 * script's to write (start_supervisor.sh's yaml_quoted).
 */
export function yamlQuoted(value: string): string {
  // The operator's: what YAML takes passed its rule first, and a person's paths (installPathProblem) can't hold
  // these characters, so a value refused here is the server's own (the settings', the catalog's).
  if (NOT_FOR_YAML.test(value)) throw new InstallRenderError("a value for the supervisor's configuration holds a character it can't take", "operator");
  return `"${value}"`;
}

/**
 * Whose a refused value is: `choices` for what the install was asked for
 * (the method, the arch, the root and executable paths, the variables' names
 * and values: a person's request, a quick-deploy link's stored choices),
 * `operator` for the rest (the catalog's binaries and their allow-lists,
 * the templates, the agent endpoint, the group's id, the version's collector
 * version: the operator's to fix).
 */
export type InstallRenderSource = "choices" | "operator";

/**
 * A value the render refuses, by `source`. Its message is fixed words naming
 * the rule, never the value. The signed-in bundle's request passed the
 * contract first, so a refusal there is a broken contract: a 500. A
 * quick-deploy link's download answers 503, logged at warn for `choices` (a
 * value stored before a rule tightened) and at error for `operator`.
 */
export class InstallRenderError extends Error {
  readonly source: InstallRenderSource;

  constructor(message: string, source: InstallRenderSource) {
    super(message);
    this.name = "InstallRenderError";
    this.source = source;
  }
}

function valueOf(values: Readonly<Record<string, PlaceholderValue>>, name: string): PlaceholderValue {
  const value = values[name];
  if (value === undefined) throw new InstallRenderError("a known placeholder has no value", "operator");
  return value;
}

/** The word's placeholders replaced by their values (strings as they are), in one pass. */
function filled(word: string, values: Readonly<Record<string, PlaceholderValue>>): string {
  return word.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => String(valueOf(values, name)));
}

/**
 * One template rendered with `values` (the method's, every known one), in
 * one pass over its lines. The template passed templateProblem when it was
 * loaded; a line that no longer fits throws.
 */
export function renderTemplate(fileName: string, text: string, values: Readonly<Record<string, PlaceholderValue>>): string {
  const kind = templateKindOf(fileName);
  return text
    .split("\n")
    .map((line) => {
      PLACEHOLDER_PATTERN.lastIndex = 0;
      if (!PLACEHOLDER_PATTERN.test(line)) return line;
      PLACEHOLDER_PATTERN.lastIndex = 0;
      if (kind === "text") return filled(line, values);
      if (kind === "shell") {
        const block = SHELL_BLOCK.exec(line);
        if (block !== null && typeof values[block[1] as string] === "string" && isShellLines(block[1] as string)) {
          return valueOf(values, block[1] as string) as string;
        }
        const assignment = SHELL_ASSIGNMENT.exec(line);
        if (assignment === null) throw new InstallRenderError("a script's line no longer fits its placeholder", "operator");
        return `${assignment[1]}${shellQuoted(filled(assignment[2] as string, values))}${assignment[3]}`;
      }
      const matched = YAML_VALUE.exec(line);
      if (matched === null) throw new InstallRenderError("a YAML line no longer fits its placeholder", "operator");
      const word = matched[2] as string;
      const alone = ONE_PLACEHOLDER.exec(word);
      const value = alone === null ? undefined : valueOf(values, alone[1] as string);
      const encoded = typeof value === "boolean" ? String(value) : yamlQuoted(filled(word, values));
      return `${matched[1]}${encoded}${matched[3]}`;
    })
    .join("\n");
}

const SHELL_LINES: ReadonlySet<string> = new Set(["COLLECTOR_ENV_EXPORTS", "SUPERVISOR_VERSION_CASES"]);

function isShellLines(name: string): boolean {
  return SHELL_LINES.has(name);
}

// ---------------------------------------------------------------------------
// The values.

/** catalogue.ts's allow-lists, checked again before a script holds them. */
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9._%/+-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The agent endpoint's form is the contracts' AGENT_ENDPOINT_PATTERN (the Helm values' rule too).

/** One platform's binary, as the catalog holds it. */
export interface BinaryDownload {
  downloadUrl: string;
  sha256: string;
}

export interface BundleInputs {
  method: InstallMethod;
  arch: InstallArch;
  endpoint: string;
  allowInsecureConnections: boolean;
  groupId: string;
  /** Checked by the contract, its trailing `/` removed. */
  rootPath: string;
  /** Own-binary's only. */
  executablePath?: string;
  /** Names the facts offer, values the contract checked. */
  env: readonly { name: string; value: string }[];
  /** The group's published version's collector version, and its binaries for the arch. */
  collectorVersion: string;
  otelcolContrib: BinaryDownload | undefined;
  opampSupervisor: BinaryDownload | undefined;
  /** Own-binary's table: every offered version's supervisor for the arch (none for All In One). */
  offeredSupervisors: readonly { version: string; opampSupervisor: BinaryDownload | undefined }[];
}

function checkedBinary(binary: BinaryDownload | undefined, what: string): BinaryDownload {
  if (binary === undefined) throw new InstallRenderError(`the catalogue has no ${what} for the version and arch`, "operator");
  if (!GITHUB_URL.test(binary.downloadUrl) || !SHA256.test(binary.sha256)) {
    throw new InstallRenderError(`the catalogue's ${what} fails its allow-list`, "operator");
  }
  return binary;
}

function checkedPath(path: string, what: string): string {
  if (installPathProblem(path) !== null || path.endsWith("/")) throw new InstallRenderError(`the ${what} fails its rule`, "choices");
  return path;
}

/** The export lines of the configuration's variables, each value one single-quoted word. */
export function envExports(env: BundleInputs["env"]): string {
  return env
    .map(({ name, value }) => {
      if (!INSTALL_ENV_NAME_PATTERN.test(name) || installEnvValueProblem(value) !== null) {
        throw new InstallRenderError("an environment variable fails its rule", "choices");
      }
      return `export ${name}=${shellQuoted(value)}`;
    })
    .join("\n");
}

/**
 * Own-binary's `case` arms: one per offered collector version with a
 * supervisor for the arch, each assignment one single-quoted word. A version
 * with no supervisor for the arch, or one failing the allow-lists, is left
 * to the `*)` arm.
 */
export function supervisorVersionCases(offered: BundleInputs["offeredSupervisors"]): string {
  const arms: string[] = [];
  for (const { version, opampSupervisor } of offered) {
    if (opampSupervisor === undefined || !VERSION.test(version)) continue;
    if (!GITHUB_URL.test(opampSupervisor.downloadUrl) || !SHA256.test(opampSupervisor.sha256)) continue;
    arms.push(
      [
        `  ${shellQuoted(version)})`,
        `    sup_ver=${shellQuoted(version)}`,
        `    sup_url=${shellQuoted(opampSupervisor.downloadUrl)}`,
        `    sup_sha=${shellQuoted(opampSupervisor.sha256)}`,
        "    ;;",
      ].join("\n"),
    );
  }
  return arms.join("\n");
}

/** Every value of the method's placeholders, each checked. */
export function bundleValues(inputs: BundleInputs): Record<string, PlaceholderValue> {
  if (!(INSTALL_ARCHES as readonly string[]).includes(inputs.arch)) throw new InstallRenderError("an arch that isn't offered", "choices");
  if (!AGENT_ENDPOINT_PATTERN.test(inputs.endpoint)) throw new InstallRenderError("the agent endpoint fails its rule", "operator");
  if (!UUID.test(inputs.groupId)) throw new InstallRenderError("the group's id isn't a UUID", "operator");
  if (!VERSION.test(inputs.collectorVersion)) throw new InstallRenderError("the collector version fails its allow-list", "operator");
  const rootPath = checkedPath(inputs.rootPath, "root path");
  const supervisor = checkedBinary(inputs.opampSupervisor, "supervisor");
  const shared: Record<string, PlaceholderValue> = {
    OPAMP_ENDPOINT: inputs.endpoint,
    OPAMP_ALLOW_INSECURE_CONNECTIONS: inputs.allowInsecureConnections,
    COLLECTOR_GROUP_ID: inputs.groupId,
    ARCH: inputs.arch,
    ROOT_PATH: rootPath,
    OTELCOL_VERSION: inputs.collectorVersion,
    OPAMPSUPERVISOR_DOWNLOAD_URL: supervisor.downloadUrl,
    OPAMPSUPERVISOR_SHA256: supervisor.sha256,
    COLLECTOR_ENV_EXPORTS: envExports(inputs.env),
  };
  if (inputs.method === "all-in-one") {
    if (inputs.executablePath !== undefined) throw new InstallRenderError("All In One takes no executable path", "choices");
    const contrib = checkedBinary(inputs.otelcolContrib, "otelcol-contrib");
    return { ...shared, OTELCOL_CONTRIB_DOWNLOAD_URL: contrib.downloadUrl, OTELCOL_CONTRIB_SHA256: contrib.sha256 };
  }
  if (inputs.executablePath === undefined) throw new InstallRenderError("own-binary needs its executable path", "choices");
  return {
    ...shared,
    EXECUTABLE_PATH: checkedPath(inputs.executablePath, "executable path"),
    CONFIG_PATH: `${rootPath}/otelcol-config.yaml`,
    STORAGE_DIRECTORY: `${rootPath}/opamp`,
    SUPERVISOR_VERSION_CASES: supervisorVersionCases(inputs.offeredSupervisors),
  };
}
