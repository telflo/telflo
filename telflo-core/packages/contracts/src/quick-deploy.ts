import { z } from "zod";
import {
  FleetActorSchema,
  FLEETS_CURSOR_MAXIMUM_LENGTH,
  FLEETS_PAGE_DEFAULT_LIMIT,
  FLEETS_PAGE_MAXIMUM_LIMIT,
  KUBERNETES_ROLES,
} from "./fleets.js";
import { bundleRequestIssues, InstallArchSchema, InstallBundleFieldsSchema, InstallMethodSchema } from "./install.js";

/*
 * Quick-deploy links, under
 * /api/v1/organizations/{organizationId}/fleets/{fleetId}:
 *
 *   POST …/groups/{groupId}/quick-deploy-links   CreateQuickDeployLinkRequestSchema
 *        → 201 `no-store` CreateQuickDeployLinkResponseSchema
 *   GET  …/quick-deploy-links?limit&cursor        → QuickDeployLinksPageSchema
 *   POST …/quick-deploy-links/{linkId}/extend     ExtendQuickDeployLinkRequestSchema
 *        → QuickDeployLinkResponseSchema
 *   POST …/quick-deploy-links/{linkId}/revoke     → QuickDeployLinkResponseSchema
 *
 * and the public download, GET /api/v1/quick-deploy/{secret}, with no
 * session. Every member may use the links' routes.
 *
 * A link is of one of two kinds: a Linux link (its choices and its create's
 * body without `kind`, or `kind: "linux"`), whose download is a tokenless
 * bundle, and a Helm values link (`kind: "helm"`), whose download is a
 * `values.yaml` holding the fleet's default token's bearer. Both are made
 * only while the organization's "Public install links" switch is on.
 *
 * A link's secret is a credential (whoever holds it downloads the install):
 * it crosses the platform only inside the create's `url`, once, `no-store`,
 * and is stored only as its hash. A list item, a link and its choices hold
 * no secret, no hash and no value: the values typed for the variables are
 * sealed with the link, and only their names are listed. The paths and the
 * names are configuration text: never logged, audited or put in
 * a URL.
 */

/** A link's secret: `tqd_` (so secret scanners can match it) and 32 random bytes in base64url. */
export const QUICK_DEPLOY_SECRET_PATTERN = /^tqd_[A-Za-z0-9_-]{43}$/;

/** The secret as a masked preview shows it: never a character of it. */
export const QUICK_DEPLOY_MASKED_SECRET = "tqd_••••••••";

/** The public download's path, before the secret. */
export const QUICK_DEPLOY_PATH_PREFIX = "/api/v1/quick-deploy/";

/**
 * TELFLO_PUBLIC_API_URL's form once its trailing `/` is removed: `http` or
 * `https`, a host name or a bracketed address, an optional port, a path of
 * plain segments; no user name, query, fragment or `%`. Nothing in it is
 * special inside a curl config's `"…"` or a shell's `'…'`, where the
 * command puts the link.
 */
const PUBLIC_API_URL_SOURCE =
  String.raw`https?://(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~+-]+)*`;
export const QUICK_DEPLOY_PUBLIC_API_URL_PATTERN = new RegExp(`^${PUBLIC_API_URL_SOURCE}$`);

/**
 * A link as the create answers it, which the web checks before it builds a
 * command: the API's base URL and `/api/v1/quick-deploy/{secret}`.
 */
export const QUICK_DEPLOY_URL_PATTERN = new RegExp(`^${PUBLIC_API_URL_SOURCE}/api/v1/quick-deploy/tqd_[A-Za-z0-9_-]{43}$`);

/** How long a new link lasts. */
export const QUICK_DEPLOY_LINK_LIFETIME_HOURS = 24;

/** The most links a fleet holds neither expired nor revoked. */
export const QUICK_DEPLOY_LINKS_ACTIVE_MAXIMUM = 100;

/**
 * A Linux link's request's fields (strict): a Linux bundle's request's
 * fields, plus whether the command installs the systemd service; `kind`
 * absent or `"linux"`. Its checks across fields are the union's (below).
 */
const CreateLinuxQuickDeployLinkFieldsSchema = InstallBundleFieldsSchema.extend({
  kind: z.literal("linux").optional(),
  systemd: z.boolean(),
}).strict();

/**
 * A Helm values link's request's fields (strict): the kind and up to 50
 * typed variables, as a bundle's. The API refuses a name the chart sets
 * itself (`HELM_CHART_ENV_NAMES`, in `HELM_CHART_ENV_NAME_MESSAGE`'s words)
 * or one the group's Helm facts don't offer (400, at `env.N.name`); a YAML
 * 1.1 word is a name like any other (the platform's chart quotes
 * `collectorEnv`'s keys).
 */
const CreateHelmQuickDeployLinkFieldsSchema = z
  .object({ kind: z.literal("helm"), env: InstallBundleFieldsSchema.shape.env })
  .strict();

/** Each variable once (a Helm request's check; a Linux request's is bundleRequestIssues's). */
function eachVariableOnce(request: { env: readonly { name: string }[] }, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, variable] of request.env.entries()) {
    if (seen.has(variable.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each variable once.", path: ["env", index, "name"] });
    }
    seen.add(variable.name);
  }
}

/**
 * A Linux link's request alone (its checks across fields). The API's route
 * takes the union, `CreateQuickDeployLinkRequestSchema`; this is the Linux
 * half on its own, for a caller that knows the kind.
 */
export const CreateLinuxQuickDeployLinkRequestSchema = CreateLinuxQuickDeployLinkFieldsSchema.superRefine(bundleRequestIssues);

/** A Helm values link's request alone. */
export const CreateHelmQuickDeployLinkRequestSchema = CreateHelmQuickDeployLinkFieldsSchema.superRefine(eachVariableOnce);

/**
 * A quick-deploy link's request: by `kind`, a Linux link's (`kind`
 * absent or `"linux"`, with the bundle's checks across fields) or a Helm
 * values link's (`kind: "helm"`, its variables each once). An unknown kind
 * is refused at `kind`.
 */
export const CreateQuickDeployLinkRequestSchema = z
  .discriminatedUnion("kind", [CreateLinuxQuickDeployLinkFieldsSchema, CreateHelmQuickDeployLinkFieldsSchema])
  .superRefine((request, context) => {
    if (request.kind === "helm") eachVariableOnce(request, context);
    else bundleRequestIssues(request, context);
  });

export type CreateQuickDeployLinkRequest = z.infer<typeof CreateQuickDeployLinkRequestSchema>;
/** What a client sends: a path may end in `/`. */
export type CreateQuickDeployLinkRequestInput = z.input<typeof CreateQuickDeployLinkRequestSchema>;
export type CreateLinuxQuickDeployLinkRequest = z.infer<typeof CreateLinuxQuickDeployLinkRequestSchema>;
export type CreateLinuxQuickDeployLinkRequestInput = z.input<typeof CreateLinuxQuickDeployLinkRequestSchema>;
export type CreateHelmQuickDeployLinkRequest = z.infer<typeof CreateHelmQuickDeployLinkRequestSchema>;

/** A link's state, by the API's clock: revoked wins over expired. */
export const QUICK_DEPLOY_LINK_STATUSES = ["active", "expired", "revoked"] as const;
export type QuickDeployLinkStatus = (typeof QUICK_DEPLOY_LINK_STATUSES)[number];

const uuid = z.string().uuid();
const instant = z.string().datetime();

/**
 * What a Linux link installs: the request's validated fields, the variables
 * by name only. A stored row and a reply carry no `kind`; `"linux"` is
 * taken too.
 */
export const QuickDeployLinuxChoicesSchema = z
  .object({
    kind: z.literal("linux").optional(),
    method: InstallMethodSchema,
    arch: InstallArchSchema,
    rootPath: z.string(),
    /** Null for All In One. */
    executablePath: z.string().nullable(),
    systemd: z.boolean(),
    /** The variables whose typed values the link holds, sealed, in the request's order. */
    envNames: z.array(z.string()),
  })
  .strict();

/**
 * What a Helm values link installs, from the server's state at the link's
 * making: the group's role (so Install Links names the Agent and the
 * Cluster), its release and namespace (for View), and the variables by name
 * only. Strict.
 */
export const QuickDeployHelmChoicesSchema = z
  .object({
    kind: z.literal("helm"),
    role: z.enum(KUBERNETES_ROLES),
    release: z.string(),
    namespace: z.string(),
    /** The variables whose typed values the link holds, sealed, in the request's order. */
    envNames: z.array(z.string()),
  })
  .strict();

/** What a link installs, by `kind`: a Linux link's (no `kind`, or `"linux"`) or a Helm values link's. */
export const QuickDeployLinkChoicesSchema = z.discriminatedUnion("kind", [QuickDeployLinuxChoicesSchema, QuickDeployHelmChoicesSchema]);

/**
 * A link, as the list, the create, an extend and a revoke answer it: ids, its
 * group's name (null once the group is gone: "A deleted group"), its default
 * token's id (the web marks a link whose token is revoked), who made it, its
 * choices, its times, its downloads and its status. Never a secret, a hash or
 * a value.
 */
export const QuickDeployLinkSchema = z
  .object({
    id: uuid,
    groupId: uuid,
    groupName: z.string().nullable(),
    defaultTokenId: uuid,
    createdBy: FleetActorSchema.nullable(),
    choices: QuickDeployLinkChoicesSchema,
    createdAt: instant,
    /** Null: never expires. */
    expiresAt: instant.nullable(),
    revokedAt: instant.nullable(),
    downloadCount: z.number().int().min(0),
    lastDownloadedAt: instant.nullable(),
    status: z.enum(QUICK_DEPLOY_LINK_STATUSES),
  })
  .strict();

/**
 * The create's reply (`no-store`): the link, and its `url`, the one copy of
 * the secret, shown once in the command and never again.
 */
export const CreateQuickDeployLinkResponseSchema = z
  .object({ link: QuickDeployLinkSchema, url: z.string().regex(QUICK_DEPLOY_URL_PATTERN) })
  .strict();

/** An extend's or a revoke's reply: the link as it now is. */
export const QuickDeployLinkResponseSchema = z.object({ link: QuickDeployLinkSchema }).strict();

/** A page of a fleet's links, newest first. Not `no-store`: ids, times, emails, paths, names (as the token history). */
export const QuickDeployLinksPageSchema = z
  .object({ links: z.array(QuickDeployLinkSchema), nextCursor: z.string().nullable() })
  .strict();

export type QuickDeployLinkChoices = z.infer<typeof QuickDeployLinkChoicesSchema>;
export type QuickDeployLinuxChoices = z.infer<typeof QuickDeployLinuxChoicesSchema>;
export type QuickDeployHelmChoices = z.infer<typeof QuickDeployHelmChoicesSchema>;
export type QuickDeployLink = z.infer<typeof QuickDeployLinkSchema>;
export type CreateQuickDeployLinkResponse = z.infer<typeof CreateQuickDeployLinkResponseSchema>;
export type QuickDeployLinkResponse = z.infer<typeof QuickDeployLinkResponseSchema>;
export type QuickDeployLinksPage = z.infer<typeof QuickDeployLinksPageSchema>;

/** The list's query: a page's size (1 to 100, default 50) and cursor. */
export const ListQuickDeployLinksQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(FLEETS_PAGE_MAXIMUM_LIMIT).default(FLEETS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(FLEETS_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

/** What a client puts in the query string. */
export type ListQuickDeployLinksQuery = z.input<typeof ListQuickDeployLinksQuerySchema>;

/** Extend's presets: a day, a week, a month, 180 days, a year, or never. */
export const QUICK_DEPLOY_LINK_EXTENSIONS = ["1d", "1w", "1mo", "180d", "1y", "never"] as const;
export type QuickDeployLinkExtension = (typeof QUICK_DEPLOY_LINK_EXTENSIONS)[number];

/** The presets' words in the Extend dialog, in their order. */
export const QUICK_DEPLOY_LINK_EXTENSION_LABELS: Readonly<Record<QuickDeployLinkExtension, string>> = {
  "1d": "1 day",
  "1w": "1 week",
  "1mo": "1 month",
  "180d": "180 days",
  "1y": "1 year",
  never: "Never",
};

/** An extend's request (strict): one preset. */
export const ExtendQuickDeployLinkRequestSchema = z.object({ by: z.enum(QUICK_DEPLOY_LINK_EXTENSIONS) }).strict();
export type ExtendQuickDeployLinkRequest = z.infer<typeof ExtendQuickDeployLinkRequestSchema>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `at` plus `months` calendar months in UTC, the day kept, or the month's last when it has fewer (Jan 31 + 1 month is Feb 28 or 29). */
function addUtcMonths(at: Date, months: number): Date {
  const target = new Date(at.getTime());
  const day = at.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * A new expiry for an extended link, counted from `now` (in UTC): `1d` 24
 * hours, `1w` 7 days, `1mo` one calendar month, `180d` 180 days, `1y` one
 * calendar year (Feb 29 + 1 year is Feb 28), `never` null.
 */
export function quickDeployLinkExpiryAfter(by: QuickDeployLinkExtension, now: Date): Date | null {
  switch (by) {
    case "1d":
      return new Date(now.getTime() + DAY_MS);
    case "1w":
      return new Date(now.getTime() + 7 * DAY_MS);
    case "1mo":
      return addUtcMonths(now, 1);
    case "180d":
      return new Date(now.getTime() + 180 * DAY_MS);
    case "1y":
      return addUtcMonths(now, 12);
    case "never":
      return null;
  }
}

/** A new link's expiry: 24 hours after its making. */
export function quickDeployLinkFirstExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + QUICK_DEPLOY_LINK_LIFETIME_HOURS * HOUR_MS);
}

/**
 * The links' own refusals: `quick_deploy_link_not_found` (404: another
 * organization's or fleet's link too), `quick_deploy_link_revoked` (409,
 * an extend), `quick_deploy_link_limit_reached` (409: a create, or any
 * extend, in a fleet whose other active links are at the cap, normally an
 * expired link's extend), `enrollment_token_default_missing` (409, a
 * create with no valid default token),
 * `collector_group_variables_changed` (409, the public download: a stored
 * name the group's version no longer offers) and
 * `public_install_links_disabled` (409 a create while the organization's
 * switch is off; the public download's 403 says
 * PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE). The links' routes also
 * answer the fleet routes' codes (FLEET_ERROR_CODES).
 */
export const QUICK_DEPLOY_LINK_ERROR_CODES = [
  "quick_deploy_link_not_found",
  "quick_deploy_link_revoked",
  "quick_deploy_link_limit_reached",
  "enrollment_token_default_missing",
  "collector_group_variables_changed",
  "public_install_links_disabled",
] as const;

export type QuickDeployLinkErrorCode = (typeof QUICK_DEPLOY_LINK_ERROR_CODES)[number];

/** Each code's words, as the API answers them and the web shows them. */
export const QUICK_DEPLOY_LINK_ERROR_MESSAGES: Readonly<Record<QuickDeployLinkErrorCode, string>> = {
  quick_deploy_link_not_found: "Install link not found.",
  quick_deploy_link_revoked: "This install link is revoked: make a new one.",
  quick_deploy_link_limit_reached: `Revoke an install link first: a fleet holds at most ${QUICK_DEPLOY_LINKS_ACTIVE_MAXIMUM} active links.`,
  enrollment_token_default_missing: "The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.",
  collector_group_variables_changed:
    "This group's published version no longer reads the variables this link was made with: make a new link.",
  public_install_links_disabled:
    "Public install links are turned off for this organization: an admin can turn them on in Settings → Organization.",
};

/**
 * The public download's words while the organization's switch is off: `403`
 * `public_install_links_disabled`, plain text.
 */
export const PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE = "Install links are turned off for this organization.";
