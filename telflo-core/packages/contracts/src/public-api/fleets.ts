import { z } from "zod";
import { FLEETS_CURSOR_MAXIMUM_LENGTH, FLEETS_PAGE_DEFAULT_LIMIT, FLEETS_PAGE_MAXIMUM_LIMIT, FLEET_STATUSES, FLEET_TYPES, KUBERNETES_ROLES } from "../fleets.js";
import {
  CollectorGroupNameSchema,
  CollectorGroupNamespaceSchema,
  CollectorGroupReplicasSchema,
  FleetLabelSchema,
  FleetTypeSchema,
} from "../fleets.js";
import {
  INSTALL_ENV_MAXIMUM,
  INSTALL_ENV_NAME_MAXIMUM_LENGTH,
  INSTALL_ENV_NAME_PATTERN,
  InstallArchSchema,
  InstallBundleFieldsSchema,
  installDisplayNameProblem,
  installEnvValueProblem,
} from "../install.js";

/*
 * The public surface's request and response shapes for fleets, their groups
 * and install (routes 17–23) (D25 decisions 17, 18, 19 and 35–38; Preflight
 * rulings 10 and 11): strict Zod schemas, camelCase, reusing the platform's contracts where they
 * already hold a field (the label, the type, a group's name, namespace and
 * replicas, the install's arch, root path and variables).
 *
 * A fleet's deployments are its collector groups (`/groups`); an install's
 * variables are `[{ name, value }]`. Fleet types are the platform's.
 *
 * A fleet's label and a group's name are organization content; a bearer,
 * a quick-deploy link's secret and a Helm link's secret are secrets: only
 * install's reply carries one, inside `command` (decision 38), and no
 * other reply here holds any.
 */

const uuid = z.string().uuid();
const instant = z.string().datetime();

// ---------------------------------------------------------------------------
// Fleets (routes 17 and 18).

/** A new fleet's rotate token's lifetime (days of 86,400,000 ms, not calendar years), `never` the default. */
export const PUBLIC_FLEET_TOKEN_EXPIRIES = ["180d", "1y", "2y", "never"] as const;

export type PublicFleetTokenExpiry = (typeof PUBLIC_FLEET_TOKEN_EXPIRIES)[number];

/** Each preset's days, or null for never (the web's Token expiry presets'). */
export const PUBLIC_FLEET_TOKEN_EXPIRY_DAYS: Readonly<Record<PublicFleetTokenExpiry, number | null>> = {
  "180d": 180,
  "1y": 365,
  "2y": 730,
  never: null,
};

/**
 * `POST /fleets` (decision 35): the label (unique in the organization: a
 * taken one is 409 `fleet_label_taken`), the type, and the rotate token's
 * lifetime (`never` when left out).
 */
export const PublicCreateFleetRequestSchema = z
  .object({
    label: FleetLabelSchema,
    type: FleetTypeSchema,
    expiresIn: z.enum(PUBLIC_FLEET_TOKEN_EXPIRIES).optional(),
  })
  .strict();

export type PublicCreateFleetRequest = z.input<typeof PublicCreateFleetRequestSchema>;

/**
 * A fleet's create, 201: the fleet and its rotate token's id
 * and expiry (null for never). NO bearer (decision 15): a fleet's tokens are
 * revealed in the browser, and install answers a ready command.
 */
export const PublicFleetCreatedSchema = z
  .object({
    id: uuid,
    label: z.string(),
    type: z.enum(FLEET_TYPES),
    tokenId: uuid,
    tokenExpiresAt: instant.nullable(),
  })
  .strict();

export type PublicFleetCreated = z.infer<typeof PublicFleetCreatedSchema>;

/** A fleet as the list answers it (a summary). */
export const PublicFleetSchema = z
  .object({
    id: uuid,
    label: z.string(),
    type: z.enum(FLEET_TYPES),
    status: z.enum(FLEET_STATUSES),
    createdAt: instant,
  })
  .strict();

export type PublicFleet = z.infer<typeof PublicFleetSchema>;

/** `GET /fleets`: a page, newest first (decision 19); `nextCursor` null on the last. */
export const PublicFleetsPageSchema = z.object({ items: z.array(PublicFleetSchema), nextCursor: z.string().nullable() }).strict();

export type PublicFleetsPage = z.infer<typeof PublicFleetsPageSchema>;

/**
 * `GET /fleets`' query (decision 19, Preflight ruling 11): `limit` 1–100
 * (50 when left out) and `cursor` a previous page's `nextCursor`. Strict:
 * anything else is 400 `invalid_request`.
 */
export const PublicListFleetsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(FLEETS_PAGE_MAXIMUM_LIMIT).default(FLEETS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(FLEETS_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

export type PublicListFleetsQuery = z.input<typeof PublicListFleetsQuerySchema>;

// ---------------------------------------------------------------------------
// Collector groups (routes 20–23).

/**
 * A collector group: its role on its fleet (null
 * on a server fleet; the Default group of a Kubernetes fleet is the Agent,
 * `node`, the group named `cluster` the Cluster, any other a gateway pool),
 * a Kubernetes group's namespace and a gateway's replicas (null where none
 * applies, or where its settings can't be read), and the configuration and
 * version number assigned it (null when unassigned, or when the platform
 * holds no live version recording the published one).
 */
export const PublicCollectorGroupSchema = z
  .object({
    id: uuid,
    fleetId: uuid,
    name: z.string(),
    isDefault: z.boolean(),
    role: z.enum(KUBERNETES_ROLES).nullable(),
    namespace: z.string().nullable(),
    replicas: z.number().int().min(1).nullable(),
    assignedPublishedVersionId: uuid.nullable(),
    configurationId: uuid.nullable(),
    versionNumber: z.number().int().min(1).nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

export type PublicCollectorGroup = z.infer<typeof PublicCollectorGroupSchema>;

/** `GET /fleets/{fleetId}/groups`: every group, the Default group first, in one page (decision 19). */
export const PublicCollectorGroupsSchema = z.object({ items: z.array(PublicCollectorGroupSchema), nextCursor: z.null() }).strict();

export type PublicCollectorGroups = z.infer<typeof PublicCollectorGroupsSchema>;

/** A version's number in a body: a positive integer (a path's is a string: PublicVersionNumberSchema). */
const VersionNumberSchema = z.number().int().min(1).max(999_999_999);

/**
 * `POST /fleets/{fleetId}/groups` (decision 35): a name,
 * and the configuration's version to assign, which must be published (422
 * `configuration_version_not_published`). On a Kubernetes-supervisor fleet
 * the group is the Cluster (named `cluster`) or a gateway pool (any other
 * name, a DNS-1035 label): `role`, when sent, must be that; `namespace`
 * (`telflo-collectors` when left out) and a gateway's `replicas` (1 when
 * left out) are its settings. A server fleet's group takes none of the
 * three (400 at the field).
 */
export const PublicCreateCollectorGroupRequestSchema = z
  .object({
    name: CollectorGroupNameSchema,
    configurationId: z.string().max(64),
    versionNumber: VersionNumberSchema,
    role: z.enum(KUBERNETES_ROLES).optional(),
    replicas: CollectorGroupReplicasSchema.optional(),
    namespace: CollectorGroupNamespaceSchema.optional(),
  })
  .strict();

export type PublicCreateCollectorGroupRequest = z.infer<typeof PublicCreateCollectorGroupRequestSchema>;

/**
 * `PATCH /fleets/{fleetId}/groups/{groupId}` (decision 35, Preflight ruling
 * 11), a merge: `configurationId` with `versionNumber` reassigns,
 * `versionNumber` alone moves to another version of the configuration
 * assigned, `configurationId: null` clears the assignment (with no
 * `versionNumber`), and `configurationId` without `versionNumber` is 400
 * `invalid_request`. A Kubernetes group's `namespace` (null: the default)
 * and a gateway's `replicas` (null: 1) are merged into its settings; a
 * Kubernetes group is never renamed (409 `collector_group_name_fixed`).
 * `role` isn't patchable. At least one field.
 */
export const PublicUpdateCollectorGroupRequestSchema = z
  .object({
    name: CollectorGroupNameSchema.optional(),
    configurationId: z.string().max(64).nullable().optional(),
    versionNumber: VersionNumberSchema.optional(),
    replicas: CollectorGroupReplicasSchema.nullable().optional(),
    namespace: CollectorGroupNamespaceSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.values(value).every((field) => field === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Give at least one field." });
    }
    if (typeof value.configurationId === "string" && value.versionNumber === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Give the version's number with its configuration.", path: ["versionNumber"] });
    }
    if (value.configurationId === null && value.versionNumber !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "No version's number when clearing the assignment.", path: ["versionNumber"] });
    }
  });

export type PublicUpdateCollectorGroupRequest = z.infer<typeof PublicUpdateCollectorGroupRequestSchema>;

// ---------------------------------------------------------------------------
// Install (route 19; decisions 37 and 38).

/**
 * `collector_group_required`'s words (422; D25 decision 37): the public
 * install named no group, and the Kubernetes-supervisor fleet holds more
 * than one. The ids are in `details.groupIds`; the words name no group.
 */
export const COLLECTOR_GROUP_REQUIRED_MESSAGE = "This fleet has several groups: name the group to install in groupId.";

/**
 * The public install's platform that doesn't suit the fleet's type (422
 * `fleet_type_not_installable`; D25 decision 37): the words of the API,
 * not the dialogs' (FLEET_TYPE_NOT_INSTALLABLE_MESSAGE names their buttons).
 */
export const INSTALL_PLATFORM_NOT_SUITED_MESSAGE =
  "This platform doesn't suit the fleet's type: a server fleet installs with docker or linux, a kubernetes-supervisor fleet with kubernetes.";

/** The platforms an install answers a command for: `docker` and `linux` on a server fleet, `kubernetes` on a Kubernetes-supervisor fleet. */
export const PUBLIC_INSTALL_PLATFORMS = ["docker", "linux", "kubernetes"] as const;

export type PublicInstallPlatform = (typeof PUBLIC_INSTALL_PLATFORMS)[number];

/**
 * The variables to set (D25 Ruling 174): at most 50, each named once, each
 * value TRIMMED, as the install dialog trims it (InstallDialog's `included`),
 * then the platform's rule on the trimmed value (1 to 4,096 characters, no
 * control character, no lone surrogate: a blank one is 400), so the command
 * and a link's sealed values are the dialog's for the same typing.
 */
const InstallEnvSchema = z
  .array(
    z
      .object({
        name: z.string().max(INSTALL_ENV_NAME_MAXIMUM_LENGTH).regex(INSTALL_ENV_NAME_PATTERN, "Not an environment variable's name."),
        value: z
          .string()
          .transform((value) => value.trim())
          .superRefine((value, context) => {
            const problem = installEnvValueProblem(value);
            if (problem !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
          }),
      })
      .strict(),
  )
  .max(INSTALL_ENV_MAXIMUM, `At most ${INSTALL_ENV_MAXIMUM} variables.`);

/** The collector's display name (D17c-1 decision 41): trimmed; empty is none; else 1 to 80 letters, digits, spaces, dots, dashes and underscores. */
const InstallDisplayNameSchema = z
  .string()
  .max(1000)
  .superRefine((value, context) => {
    const problem = installDisplayNameProblem(value);
    if (problem !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .transform((value) => value.trim());

/** Each variable named once (the bundle's and the links' rule). */
function eachVariableOnce(request: { env?: readonly { name: string }[] | undefined }, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, variable] of (request.env ?? []).entries()) {
    if (seen.has(variable.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Each variable once.", path: ["env", index, "name"] });
    seen.add(variable.name);
  }
}

/**
 * `POST /fleets/{fleetId}/install` (decision 37): a strict union on
 * `platform`. `groupId` left out is a server fleet's Default group, or a
 * Kubernetes fleet's only group (422 `collector_group_required` with
 * `details.groupIds` when it has several). Only the variables the group's
 * published version reads can be set (400 at `env.N.name`).
 *   - docker: the container command (`docker run`), the display name
 *     optional;
 *   - linux: an All In One Quick Deploy command for the arch, installed
 *     under `rootPath`, as a systemd service or in the foreground;
 *   - kubernetes: the Helm Quick Deploy command (the values link's
 *     download, then `helm upgrade --install`).
 */
export const PublicInstallRequestSchema = z
  .discriminatedUnion("platform", [
    z
      .object({
        platform: z.literal("docker"),
        groupId: z.string().max(64).optional(),
        displayName: InstallDisplayNameSchema.optional(),
        env: InstallEnvSchema.optional(),
      })
      .strict(),
    z
      .object({
        platform: z.literal("linux"),
        groupId: z.string().max(64).optional(),
        displayName: InstallDisplayNameSchema.optional(),
        arch: InstallArchSchema,
        rootPath: InstallBundleFieldsSchema.shape.rootPath,
        systemd: z.boolean(),
        env: InstallEnvSchema.optional(),
      })
      .strict(),
    z
      .object({
        platform: z.literal("kubernetes"),
        groupId: z.string().max(64).optional(),
        env: InstallEnvSchema.optional(),
      })
      .strict(),
  ])
  .superRefine(eachVariableOnce);

export type PublicInstallRequest = z.infer<typeof PublicInstallRequestSchema>;
export type PublicInstallRequestInput = z.input<typeof PublicInstallRequestSchema>;

/**
 * Install's reply (decisions 37 and 38), `no-store`: the command the web's
 * dialog shows for the same choices, built by the shared builders. It is a
 * SECRET: docker's holds the fleet's default token's bearer, linux's the
 * bearer and a quick-deploy link's secret, kubernetes' a Helm values link's
 * secret, whose download answers the bearer. `notes` are fixed words (and
 * the names of the variables the version reads that weren't given);
 * `expiresAt` is the link's expiry (linux, kubernetes: 24 hours), null for
 * docker.
 */
export const PublicInstallReplySchema = z
  .object({
    fleetId: uuid,
    fleetType: z.enum(FLEET_TYPES),
    platform: z.enum(PUBLIC_INSTALL_PLATFORMS),
    groupId: uuid,
    groupName: z.string(),
    command: z.string(),
    notes: z.array(z.string()),
    expiresAt: instant.nullable(),
  })
  .strict();

export type PublicInstallReply = z.infer<typeof PublicInstallReplySchema>;
