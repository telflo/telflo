import { z } from "zod";
import { DockerMountSchema } from "./fleets.js";

/*
 * Installing collectors into a `server` fleet's group: the install's
 * facts, read by the install dialog (no bearer), and the Linux bundle's
 * request, which the API renders from these validated fields only.
 *
 *   GET  …/fleets/{fleetId}/groups/{groupId}/install         InstallFactsSchema
 *   POST …/fleets/{fleetId}/groups/{groupId}/install-bundle  InstallBundleRequestSchema
 *        → 200 application/gzip, `attachment; filename="{installBundleFileName}"`
 *
 * The facts' environment variable names, a bundle request's paths and
 * values are configuration text: never logged, audited or put in
 * a URL. A Kubernetes group's facts and its Helm install are `helm.ts`'s.
 */

/** The Linux bundles: one that downloads its own collector and supervisor, and one for a host's own otelcol-contrib. */
export const INSTALL_METHODS = ["all-in-one", "own-binary"] as const;
export const INSTALL_ARCHES = ["amd64", "arm64"] as const;

export type InstallMethod = (typeof INSTALL_METHODS)[number];
export type InstallArch = (typeof INSTALL_ARCHES)[number];

/**
 * The bundle's file name, the API's Content-Disposition and the web's save
 * alike: the method and the arch, never the fleet's label or the group's
 * name.
 */
export function installBundleFileName(method: InstallMethod, arch: InstallArch): string {
  return `telflo-collector-${method}-${arch}.tar.gz`;
}

/**
 * The environment variables an install sets itself (five):
 * never offered as a configuration's variable, even when its YAML reads one.
 */
export const RESERVED_INSTALL_ENV_NAMES = [
  "OPAMP_ENDPOINT",
  "OPAMP_TOKEN",
  "OPAMP_SERVER_NAME",
  "OPAMP_ALLOW_INSECURE_CONNECTIONS",
  "COLLECTOR_GROUP_ID",
] as const;

/** A configuration's environment variable's name, as `${env:NAME}` spells it. */
export const INSTALL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const INSTALL_ENV_NAME_MAXIMUM_LENGTH = 256;
/** A bundle's most variables, and a value's characters. */
export const INSTALL_ENV_MAXIMUM = 50;
export const INSTALL_ENV_VALUE_MAXIMUM_LENGTH = 4096;
/** A root path's or an executable path's most characters, its trailing `/` removed. */
export const INSTALL_PATH_MAXIMUM_LENGTH = 200;

/** The dialog's defaults. */
export const DEFAULT_INSTALL_ROOT_PATH = "/etc/otelcol";
export const DEFAULT_INSTALL_EXECUTABLE_PATH = "/usr/bin/otelcol-contrib";

const INSTALL_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/;

/** A path with its trailing `/` (any run of them) removed: `/etc/otelcol/` is `/etc/otelcol`, `/` is "". */
export function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * A bundle path's problem, or null: absolute, of letters, digits, dots,
 * dashes, underscores and `/`, no `.` or `..` segment, at most 200 characters
 * once its trailing `/` is removed, and not the root (`/`, empty once its
 * trailing `/` goes). Such a path is one shell word and one YAML scalar with
 * nothing to escape.
 */
export function installPathProblem(path: string): string | null {
  if (path === "") return "Type a path.";
  if (!path.startsWith("/")) return "Use an absolute path, starting with /.";
  if (!INSTALL_PATH_PATTERN.test(path)) return "Use letters, digits, dots, dashes, underscores and /.";
  const trimmed = withoutTrailingSlash(path);
  if (trimmed === "") return "Use a directory, not the root.";
  if (trimmed.length > INSTALL_PATH_MAXIMUM_LENGTH) return `At most ${INSTALL_PATH_MAXIMUM_LENGTH} characters.`;
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) return "Use no . or .. segment.";
  return null;
}

// eslint-disable-next-line no-control-regex -- the rule is "no control character"
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
/** A UTF-16 surrogate not in a pair (the `u` flag matches a pair as one code point, never this class). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * An environment variable's value's problem, or null: 1 to 4,096 characters
 * (code points), no control character, no lone surrogate (half of a pair: no
 * UTF-8 file, YAML parser or shell carries it, so neither the bundle nor
 * Helm's values could). The words never hold the value.
 */
export function installEnvValueProblem(value: string): string | null {
  if (value === "") return "Type a value or untick it.";
  if ([...value].length > INSTALL_ENV_VALUE_MAXIMUM_LENGTH) return `At most ${INSTALL_ENV_VALUE_MAXIMUM_LENGTH.toLocaleString("en-US")} characters.`;
  if (CONTROL_CHARACTER.test(value)) return "Use no control characters (a line break or a tab, say).";
  if (LONE_SURROGATE.test(value)) return "Use only whole characters (not half of an emoji, say).";
  return null;
}

/*
 * The install commands' shared pieces: the web's commands and the Quick Deploy
 * command (`quick-deploy-command.ts`) quote with them, check the display name
 * with them and mask the bearer with them.
 */

/** POSIX single-quoting: any string as one shell word, nothing in it expanded (a `'` written `'\''`). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What a command's preview shows in place of the bearer (16 bullets). */
export const INSTALL_MASKED_TOKEN = "••••••••••••••••";

export const INSTALL_DISPLAY_NAME_MAXIMUM_LENGTH = 80;
const INSTALL_DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 ._-]+$/;
export const INSTALL_DISPLAY_NAME_RULE = "Use letters, digits, spaces, dots, dashes and underscores.";

/**
 * The display name's problem, or null: trimmed, empty is no name (an
 * automatic one), else 1 to 80 letters, digits, spaces, dots, dashes and
 * underscores (a `'` is refused, never stripped). The name used is the
 * trimmed one. Nothing in it is special to a shell's `'…'`, a systemd unit's
 * `"…"` or its specifiers (no `%`, no `$`).
 */
export function installDisplayNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === "") return null;
  if (name.length > INSTALL_DISPLAY_NAME_MAXIMUM_LENGTH) return `At most ${INSTALL_DISPLAY_NAME_MAXIMUM_LENGTH} characters.`;
  return INSTALL_DISPLAY_NAME_PATTERN.test(name) ? null : INSTALL_DISPLAY_NAME_RULE;
}

/** A string `problemOf` finds no problem in, its message the problem's words. */
function checked(problemOf: (value: string) => string | null) {
  return z.string().superRefine((value, context) => {
    const problem = problemOf(value);
    if (problem !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
}

/** A bundle path, checked, then its trailing `/` removed. */
const InstallPathSchema = checked(installPathProblem).transform(withoutTrailingSlash);

export const InstallMethodSchema = z.enum(INSTALL_METHODS);
export const InstallArchSchema = z.enum(INSTALL_ARCHES);

const InstallEnvVarSchema = z
  .object({
    name: z
      .string()
      .max(INSTALL_ENV_NAME_MAXIMUM_LENGTH)
      .regex(INSTALL_ENV_NAME_PATTERN, "Not an environment variable's name."),
    value: checked(installEnvValueProblem),
  })
  .strict();

/** A Linux bundle's request's fields (strict), before the checks across them (`bundleRequestIssues`). */
export const InstallBundleFieldsSchema = z
  .object({
    method: InstallMethodSchema,
    arch: InstallArchSchema,
    rootPath: InstallPathSchema,
    executablePath: InstallPathSchema.optional(),
    env: z.array(InstallEnvVarSchema).max(INSTALL_ENV_MAXIMUM, `At most ${INSTALL_ENV_MAXIMUM} variables.`),
  })
  .strict();

/**
 * The checks across a bundle request's fields: the executable path for
 * own-binary only, each variable named once. A quick-deploy link's request
 * (quick-deploy.ts) has them too.
 */
export function bundleRequestIssues(
  request: Pick<z.infer<typeof InstallBundleFieldsSchema>, "method" | "executablePath" | "env">,
  context: z.RefinementCtx,
): void {
  if (request.method === "own-binary" && request.executablePath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Type the path to otelcol-contrib.", path: ["executablePath"] });
  }
  if (request.method === "all-in-one" && request.executablePath !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "All In One installs its own collector: no executable path.",
      path: ["executablePath"],
    });
  }
  const seen = new Set<string>();
  for (const [index, variable] of request.env.entries()) {
    if (seen.has(variable.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each variable once.", path: ["env", index, "name"] });
    }
    seen.add(variable.name);
  }
}

/**
 * A Linux bundle's request (strict): the method and arch, the root path,
 * the executable path for own-binary only (refused for All In One), and
 * up to 50 variables, each named once. The API also refuses a name the
 * facts don't offer (400, at `env.N.name`).
 */
export const InstallBundleRequestSchema = InstallBundleFieldsSchema.superRefine(bundleRequestIssues);

export type InstallBundleRequest = z.infer<typeof InstallBundleRequestSchema>;
/** What a client sends: a path may end in `/`. */
export type InstallBundleRequestInput = z.input<typeof InstallBundleRequestSchema>;

/**
 * The install's facts (`no-store`, no bearer): the image the
 * group's published version's collector version picks, the agent endpoint
 * and whether insecure connections are allowed, the collector, the
 * variables the version's YAML reads with `${env:NAME}` (no default, not
 * one of the five reserved), the group's mounts, whether those mounts
 * could be read (false when the group's "telflo" annotation holds
 * what the platform can't read; `mounts` is then empty and the dialog says
 * the mounts are left out), and its id.
 */
export const InstallFactsSchema = z
  .object({
    imageTag: z.string(),
    endpoint: z.string(),
    allowInsecureConnections: z.boolean(),
    collector: z.object({ distribution: z.string(), version: z.string() }).strict(),
    // Shell names, none reserved, each once (the server's scan finds no other): a reply holding another is
    // `unexpected_response`, never a name the install command would have to refuse while the dialog renders.
    envVarNames: z
      .array(
        z
          .string()
          .max(INSTALL_ENV_NAME_MAXIMUM_LENGTH)
          .regex(INSTALL_ENV_NAME_PATTERN)
          .refine((name) => !(RESERVED_INSTALL_ENV_NAMES as readonly string[]).includes(name)),
      )
      .refine((names) => new Set(names).size === names.length),
    mounts: z.array(DockerMountSchema),
    mountsReadable: z.boolean(),
    groupId: z.string().uuid(),
  })
  .strict();

export type InstallFacts = z.infer<typeof InstallFactsSchema>;

/**
 * The words of the install's refusals. The retired version's names its
 * version.
 */
export const INSTALL_UNAVAILABLE_MESSAGE =
  "Installing isn't available right now: the install templates can't be read. Ask your administrator.";
export const COLLECTOR_GROUP_UNASSIGNED_MESSAGE =
  "Assign a published version to this group first: its collector version picks what to install.";
export const COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE =
  "This group's published version belongs to a deleted configuration. Assign another first.";
/**
 * `fleet_type_not_installable`'s words, per direction: a
 * Kubernetes-supervisor fleet asked for a Linux bundle or a Linux link, and a
 * server fleet's group asked for a Helm install.
 */
export const FLEET_TYPE_NOT_INSTALLABLE_MESSAGE = "A Kubernetes-supervisor fleet's collectors are installed with Helm: use Install with Helm.";
export const FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE = "A server fleet's groups have no Helm install: use Install collector.";

/** The distribution the collector image and the Linux bundles hold (telflo's image is otelcol-contrib's). */
export const INSTALL_DISTRIBUTION = "otelcol-contrib";

/** A published version built for another distribution (`collector_version_not_offered`). */
export function collectorDistributionNotInstallableMessage(distribution: string): string {
  return `Collector distribution ${distribution} can't be installed here. Publish a version built for ${INSTALL_DISTRIBUTION}, then assign it.`;
}

/** A version the catalog holds no binaries of for the arch (`collector_version_not_offered`). */
export function collectorBinariesMissingMessage(version: string, arch: string): string {
  return `Collector v${version} has no ${arch} binaries to install. Choose the other arch, or publish a version that has them.`;
}

export function collectorVersionNotOfferedMessage(version: string): string {
  return `Collector v${version} is no longer offered. Publish a version that uses an offered collector, then assign it.`;
}
