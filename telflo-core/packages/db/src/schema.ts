import type { ColumnType, Generated, JSONColumnType } from "kysely";

/** Set by the database on insert, never written by the application. */
type CreatedAt = ColumnType<Date, never, never>;
/** Set by the database on insert; the application may update it. */
type UpdatedAt = ColumnType<Date, never, Date>;

/**
 * A person or a service account (migration 1700000000035). Set at the insert,
 * human when none is named, and never changed but by an operator: a trigger
 * (users_kind_immutable) refuses the API's role any update that changes it
 * (42501).
 */
export type UserKind = "human" | "service";

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  /** Null for a user who has accepted no terms yet. */
  accepted_terms_version: string | null;
  /** Null exactly when accepted_terms_version is (chk_users_terms_accepted_together). */
  terms_accepted_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: Date | null;
  /**
   * A product admin (migration 1700000000026): false by default. Set and
   * cleared only by an operator's SQL as the tables' owner: a trigger
   * (users_product_admin_owner_only) refuses the API's role any insert with
   * it true and any update that changes it (42501).
   */
  is_product_admin: Generated<boolean>;
  /**
   * human by default (migration 1700000000035). A service account
   * (kind service) holds an address at @service-accounts.telflo.invalid, no
   * password and a verified email, and has no identity and no session (the
   * migration's checks and triggers); nobody else holds such an address.
   */
  kind: Generated<UserKind>;
}

export interface EmailVerificationTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: CreatedAt;
}

export interface AuditEventsTable {
  id: Generated<string>;
  occurred_at: Generated<Date>;
  actor_user_id: string | null;
  actor_email: string | null;
  organization_id: string | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  metadata: JSONColumnType<Record<string, unknown>, string | undefined, string | undefined>;
  ip_address: string | null;
  user_agent: string | null;
}

/** Postgres enum organization_type. */
export type OrganizationType = "personal" | "group";

/** Postgres enum organization_role. viewer was retired in migration 014. */
export type OrganizationRole = "admin" | "contributor";

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  type: OrganizationType;
  /** Set exactly when `type` is personal (ck_organizations_owner_only_personal). */
  owner_user_id: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: Date | null;
  /**
   * The "Public install links" switch (migration 1700000000033): whether
   * the organization's Linux Quick Deploy and Helm values links work. True
   * by default; only an admin changes it.
   */
  public_install_links_enabled: Generated<boolean>;
  /**
   * The logo's id (migration 1700000000036): a new one per upload; its
   * bytes are the file store's (`organizations/<id>/logos/<logo_id>`).
   * Null: no logo. Set exactly when `logo_content_type` is
   * (ck_organizations_logo).
   */
  logo_id: string | null;
  /** The logo's type, read from its first bytes at upload (ck_organizations_logo). */
  logo_content_type: OrganizationLogoContentType | null;
}

/** A logo's stored type: PNG, JPEG or WebP, never SVG. */
export type OrganizationLogoContentType = "image/png" | "image/jpeg" | "image/webp";

export interface OrganizationMembersTable {
  id: Generated<string>;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  /** Set when the member is removed; a removed membership grants nothing. */
  deleted_at: Date | null;
}

/**
 * An admin's invitation of an email address. Pending while `accepted_at` and
 * `revoked_at` are both null; expired once past `expires_at`, which the API
 * compares with its own clock.
 */
export interface OrganizationInvitationsTable {
  id: Generated<string>;
  organization_id: string;
  /** Lowercased (ck_organization_invitations_email_lowercase). */
  email: string;
  role: OrganizationRole;
  /** sha-256 of the link's token; the plaintext is never stored. */
  token_hash: string;
  /** Null once the inviter's account is hard-deleted. */
  invited_by_user_id: string | null;
  expires_at: Date;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  accepted_at: Date | null;
  /** Set with `accepted_at`; null for an accepted invitation only once the acceptor is hard-deleted. */
  accepted_by_user_id: string | null;
  /** Set when an admin cancels it; never together with `accepted_at`. */
  revoked_at: Date | null;
}

/**
 * A quick-deploy link (migration 1700000000032): a member's install for one
 * of the organization's fleets, whose secret (stored only as its sha-256)
 * downloads it without signing in. Active while neither revoked nor past
 * `expires_at`, which the API compares with its own clock. Timestamps have
 * no default: the API writes them from its clock. The columns fixed at the
 * insert can't be updated (a compile error).
 */
export interface QuickDeployLinksTable {
  /** Picked by the API before the insert (select uuidv7()): the sealed values' associated data names it. */
  id: ColumnType<string, string | undefined, never>;
  organization_id: string;
  /** The opamp-server's fleet, group and default token (no foreign key: they live there). */
  fleet_id: ColumnType<string, string, never>;
  group_id: ColumnType<string, string, never>;
  default_token_id: ColumnType<string, string, never>;
  /** Null once the member's account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  /** sha-256 (lowercase hex) of the secret; the secret is never stored. */
  secret_hash: ColumnType<string, string, never>;
  /** The bundle request's validated fields: never a value, a display name or the secret. */
  choices: JSONColumnType<QuickDeployLinkChoicesColumn, string, never>;
  /** The typed values, sealed (AES-256-GCM); null when none was typed. */
  env_ciphertext: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  /** Which of the API's keys sealed them (16 hex characters); set exactly when env_ciphertext is. */
  env_key_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date, never>;
  /** Null: never expires. */
  expires_at: Date | null;
  /** Set once; a revoked link is never re-enabled. */
  revoked_at: Date | null;
  /** Only a revoked link names its revoker; null too once their account is hard-deleted. */
  revoked_by_user_id: string | null;
  download_count: Generated<number>;
  /** Null exactly while download_count is 0. */
  last_downloaded_at: Date | null;
}

/**
 * quick_deploy_links.choices as stored, by kind (migration 1700000000033's
 * comment): a Linux link's (no `kind`, or kind linux) or a Helm values link's.
 * Never a value, a display name or the secret.
 */
export type QuickDeployLinkChoicesColumn = QuickDeployLinuxChoicesColumn | QuickDeployHelmChoicesColumn;

/** A Linux link's choices: the bundle request's validated fields. */
export interface QuickDeployLinuxChoicesColumn {
  /** Absent on every row the platform writes; "linux" is read alike. */
  kind?: "linux";
  method: "all-in-one" | "own-binary";
  arch: "amd64" | "arm64";
  /** Its trailing `/` removed. */
  rootPath: string;
  /** Null for all-in-one. */
  executablePath: string | null;
  /** Whether the command installs telflo-supervisor.service. */
  systemd: boolean;
  /** The variables whose values are sealed in env_ciphertext, in the request's order. */
  envNames: string[];
}

/** A Helm values link's choices, from the server's state at the link's making. */
export interface QuickDeployHelmChoicesColumn {
  kind: "helm";
  /** The group's role on its fleet: Install Links names the Agent and the Cluster by it. */
  role: "node" | "cluster" | "gateway";
  /** The group's Helm release and namespace at the making, for View. */
  release: string;
  namespace: string;
  /** The variables whose values are sealed in env_ciphertext, in the request's order. */
  envNames: string[];
}

/**
 * An organization's collector configuration. Deleted softly: the repository
 * ignores a row once `deleted_at` is set.
 *
 * Both timestamps have no default: the API writes them from its injected
 * clock, never `now()`, so they hold whole milliseconds and the list's cursor
 * round-trips. The insert type requires them, so a write that forgets the
 * clock is a compile error before it is a 23502.
 */
export interface ConfigurationsTable {
  id: Generated<string>;
  organization_id: string;
  /** Trimmed, 1 to 200 characters; not unique. */
  name: string;
  /** Trimmed, at most 500 characters; `''` when there is none. */
  description: ColumnType<string, string | undefined, string>;
  /** Null once the creator's account is hard-deleted. */
  created_by_user_id: string | null;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change and delete. */
  updated_at: Date;
  deleted_at: Date | null;
  /**
   * The distribution it is built for: written on create (the catalogue's
   * default when none is named), never changed. The update type is `never`,
   * and a trigger refuses a change for every role.
   */
  collector_distribution: ColumnType<string, string, never>;
  /**
   * The slug of the flow it was created from, or null for one created
   * blank: written on create, never changed, returned nowhere. No foreign
   * key: a flow may be deleted, and the configuration keeps its copy. Null
   * when left out on insert.
   */
  source_flow_slug: ColumnType<string | null, string | null | undefined, never>;
}

/**
 * A configuration's content, by version. No `deleted_at`: a version is
 * reachable only through a live configuration, and the repository joins it on
 * `(configuration_id, organization_id)`, the composite foreign key, to check.
 *
 * `yaml_content` and both timestamps have no default: the API writes the
 * timestamps from its injected clock, never `now()`, and always the YAML.
 * The insert type requires them, so a write that forgets one is a compile
 * error before it is a 23502.
 */
export interface ConfigurationVersionsTable {
  id: Generated<string>;
  configuration_id: string;
  organization_id: string;
  /** From 1, unique within the configuration: the highest plus one, under the configuration's lock. */
  version_number: number;
  /**
   * The version's name: null, shown as "Version N", or 1 to 80 characters,
   * trimmed by the contract (ck_configuration_versions_label_length). Null
   * when left out on insert.
   */
  label: string | null;
  /** Exactly as sent, `''` included; at most 262,144 characters. Private: never logged. */
  yaml_content: string;
  /** Null once the creator's account is hard-deleted. */
  created_by_user_id: string | null;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every save. */
  updated_at: Date;
  /**
   * The builder's layout, jsonb arrays defaulting to `'[]'`: the text wins,
   * and each node's config is a copy of it, so private too. Written as
   * `JSON.stringify(array)`: node-postgres would send a bare array as a
   * Postgres array literal. Read as parsed JSON; the API's contract shapes
   * it.
   */
  nodes: JSONColumnType<unknown[], string | undefined, string>;
  edges: JSONColumnType<unknown[], string | undefined, string>;
  pipelines: JSONColumnType<unknown[], string | undefined, string>;
  /**
   * When the version was published, from the API's clock; null on a draft.
   * Set together with `publication_id`
   * (ck_configuration_versions_published_at_publication_id). Once set, a
   * trigger refuses every change to the version but `updated_at`,
   * `created_by_user_id` and `published_by_user_id` becoming null.
   */
  published_at: Date | null;
  /** The publisher; null on a draft, and once their account is hard-deleted. */
  published_by_user_id: string | null;
  /** The opamp-server's id for the snapshot, chosen by the platform; unique, null on a draft. */
  publication_id: string | null;
  /**
   * The configuration's distribution (fk_configuration_versions_configuration_distribution
   * keeps them equal), written on insert only.
   */
  collector_distribution: ColumnType<string, string, never>;
  /**
   * The collector version it is pinned to, a version of
   * `collector_distribution` in the catalogue. A first version gets the
   * distribution's default, a new one its source's. The published-version
   * trigger refuses changing it once published.
   */
  collector_version: string;
}

/**
 * The version each person last opened of each configuration: one row per
 * `(organization_id, user_id, configuration_id)`, replaced on every open. Two
 * composite foreign keys keep it to a version of its own configuration in its
 * own organization; it goes with its configuration, its version or its person.
 *
 * `selected_at` has no default: the API writes it from its injected clock,
 * never `now()`. The insert type requires it, so a write that forgets it is
 * a compile error before it is a 23502.
 */
export interface ConfigurationVersionSelectionsTable {
  id: Generated<string>;
  organization_id: string;
  configuration_id: string;
  /** A version of `configuration_id`, in `organization_id` (fk_configuration_version_selections_version). */
  version_id: string;
  user_id: string;
  /** From the API's clock, on every record. */
  selected_at: Date;
}

/**
 * A collector distribution of the catalogue, global. Written only by the
 * migration step's sync, as the tables' owner; the API's role may only read
 * it.
 */
export interface CollectorDistributionsTable {
  /** `otelcol-contrib`: the catalogue file's name. */
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  /** Exactly one distribution is the default (uq_collector_distributions_one_default). */
  is_default: boolean;
  /**
   * The collector's renames, the catalogue file's `renamedTypes` in its order
   * (migration 1700000000025). Defaults to `[]`, so an insert may leave it
   * out.
   */
  renamed_types: ColumnType<CollectorRenamedType[], string | undefined, string>;
}

/**
 * One of the collector's renames: from upstream's `since` on, the `kind` of
 * component `deprecatedName` is called `name`.
 */
export interface CollectorRenamedType {
  kind: "receiver" | "processor" | "exporter" | "connector" | "extension";
  name: string;
  deprecatedName: string;
  since: string;
}

/** One platform's download of a binary, as the catalogue's file holds it. */
export interface CollectorBinaryDownload {
  downloadUrl: string;
  sha256: string;
}

/** A version's components by section. */
export interface CollectorSupportedComponents {
  receivers: string[];
  processors: string[];
  exporters: string[];
  connectors: string[];
  extensions: string[];
}

/**
 * A version of a collector distribution, global. Written only by the
 * migration step's sync; the API's role may only read it. Never deleted, only
 * deprecated.
 */
export interface CollectorVersionsTable {
  distribution: string;
  /** major.minor.patch. */
  version: string;
  label: string;
  description: string | null;
  /** `YYYY-MM-DD`: pool.ts reads a `date` as its text, never as a local-midnight Date. */
  released_at: string;
  /** Exactly one per distribution, never a deprecated one. */
  is_default: boolean;
  deprecated: boolean;
  /** Required when deprecated (ck_collector_versions_deprecated_note); may be set otherwise. */
  deprecated_note: string | null;
  container_image: string;
  otelcol_contrib_version: string | null;
  /** Null: the full palette. */
  supported_components: JSONColumnType<CollectorSupportedComponents | null, string | null, string | null>;
  /** By platform; `{}` for a container-only distribution. */
  otelcol_contrib: JSONColumnType<Partial<Record<string, CollectorBinaryDownload>>, string, string>;
  opamp_supervisor: JSONColumnType<Partial<Record<string, CollectorBinaryDownload>>, string, string>;
}

/** Postgres check ck_flows_source: the two sources. */
export type FlowSource = "telflo" | "community";

/**
 * A prebuilt collector configuration (migration 1700000000026), global: one
 * row per flow, no history. Anyone reads the published ones through the API;
 * only a product admin writes them, which the API decides.
 *
 * Both timestamps have no default: the API writes them from its injected
 * clock, never `now()`, as configurations' (the seeded flows' are the
 * migration's time to the millisecond). The insert type requires them, so a
 * write that forgets the clock is a compile error before it is a 23502. So
 * does `collector_distribution`: the catalogue's is the only default.
 */
export interface FlowsTable {
  id: Generated<string>;
  /** Kebab-case, at most 80 characters, unique: the public URL segment. */
  slug: string;
  name: string;
  summary: string;
  description: string;
  source: FlowSource;
  /** Null for Telflo. */
  author_name: string | null;
  author_url: string | null;
  /**
   * `'{}'` when left out on insert. traces, metrics and logs, each at most
   * once (ck_flows_signals, migration 1700000000027): the contract's FLOW_SIGNALS.
   */
  signals: ColumnType<string[], string[] | undefined, string[]>;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  /** Public content: copied byte for byte into a configuration created from the flow. */
  yaml_content: string;
  /** A distribution of the catalogue (fk_flows_collector_distribution). */
  collector_distribution: string;
  /** Not blank; no foreign key: the API checks it against the catalogue. */
  collector_version: string;
  /** Null, or an http(s) URL (ck_flows_source_url_scheme). */
  source_url: string | null;
  /** True when left out on insert. */
  published: Generated<boolean>;
  /** 0 when left out on insert; the gallery's order, the name breaking ties. */
  sort_order: Generated<number>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change. */
  updated_at: Date;
}

/**
 * A person's test file in one organization, "My Files" (migration
 * 1700000000028). The bytes are in the FileStore; this is what the list
 * shows. Row-level security admits only its owner, in its organization;
 * nothing updates a row.
 */
export interface TestInputFilesTable {
  id: Generated<string>;
  organization_id: ColumnType<string, string, never>;
  owner_user_id: ColumnType<string, string, never>;
  /** Trimmed, 1 to 200 characters. Private text. */
  display_name: ColumnType<string, string, never>;
  /** The upload's or sample's own name, 1 to 255 characters. Private text. */
  file_name: ColumnType<string, string, never>;
  /** At most 2,000 characters; `''` when there is none. */
  description: ColumnType<string, string | undefined, never>;
  /** From the name's last extension. */
  content_type: ColumnType<string, string, never>;
  /** At most 10,485,760. */
  size_bytes: ColumnType<number, number, never>;
  /** The bytes' SHA-256, 32 bytes. */
  sha256: ColumnType<Buffer, Buffer, never>;
  /** The database's clock, on insert. */
  created_at: CreatedAt;
}

/**
 * A configuration version's test suite (migration 1700000000029). Visible
 * to whoever can see its configuration; the insert policy names the
 * context's user as its creator, and a trigger keeps its identity (its
 * version above all) for every role.
 *
 * Both timestamps have no default: the API writes them from its clock, as
 * configurations', and a version copy writes the version's time.
 */
export interface TestSuitesTable {
  /** uuidv7 by default; a version copy names its own, in the source's order. */
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  configuration_id: ColumnType<string, string, never>;
  configuration_version_id: ColumnType<string, string, never>;
  /** Trimmed, 1 to 200 characters. Configuration text. */
  name: string;
  /** At most 2,000 characters; `''` when there is none. Configuration text. */
  description: ColumnType<string, string | undefined, string>;
  /** The context's user on insert (the policy); null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every rename or new description. */
  updated_at: Date;
}

/**
 * A test definition's input (migration 1700000000029): a copy made when a
 * definition is created, shared by its version copies' definitions, its
 * bytes in the FileStore. Visible to whoever can see its configuration;
 * never changed. It is removed, row then bytes, once no definition names
 * it, under the configuration's lock.
 */
export interface TestDefinitionInputsTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  configuration_id: ColumnType<string, string, never>;
  /** The original file's name, 1 to 255 characters. Configuration text. */
  file_name: ColumnType<string, string, never>;
  content_type: ColumnType<string, string, never>;
  /** At most 10,485,760. */
  size_bytes: ColumnType<number, number, never>;
  /** The bytes' SHA-256, 32 bytes. */
  sha256: ColumnType<Buffer, Buffer, never>;
  /** The database's clock, on insert. */
  created_at: CreatedAt;
}

/**
 * A suite's test configuration (migration 1700000000029): created and
 * deleted, never changed, so every column's update type is `never`. The
 * insert policy names the context's user as its creator; composite keys tie
 * it to a suite of its own version and an input of its own configuration.
 */
export interface TestDefinitionsTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  configuration_id: ColumnType<string, string, never>;
  configuration_version_id: ColumnType<string, string, never>;
  test_suite_id: ColumnType<string, string, never>;
  input_id: ColumnType<string, string, never>;
  /** Trimmed, 1 to 200 characters. Configuration text. */
  name: ColumnType<string, string, never>;
  /** At most 2,000 characters; `''` when there is none. */
  description: ColumnType<string, string | undefined, never>;
  /** Begins with its signal (ck_test_definitions_pipeline_signal). */
  target_pipeline: ColumnType<string, string, never>;
  signal: ColumnType<TestRunSignal, TestRunSignal, never>;
  /** 1 to 60; no default. */
  duration_seconds: ColumnType<number, number, never>;
  /** The context's user on insert (the policy); null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert. */
  created_at: ColumnType<Date, Date, never>;
}

/**
 * A test template (migration 1700000000029): a product-wide sample input,
 * global as flows. Members read the live ones; only a product admin
 * writes them, which the API decides. Deletes are soft: the API's role
 * has no DELETE, and a trigger keeps the file's columns and lets
 * `deleted_at` be set once.
 */
export interface TestTemplatesTable {
  id: ColumnType<string, string | undefined, never>;
  /** Trimmed, 1 to 200 characters. Configuration text. */
  name: string;
  /** At most 2,000 characters; `''` when there is none. */
  description: ColumnType<string, string | undefined, string>;
  /** A palette receiver's value; the API checks its list. */
  receiver_type: string;
  signal: TestRunSignal;
  /** The upload's own name, 1 to 255 characters; never changed. */
  file_name: ColumnType<string, string, never>;
  content_type: ColumnType<string, string, never>;
  /** At most 10,485,760; never changed. */
  size_bytes: ColumnType<number, number, never>;
  /** The bytes' SHA-256, 32 bytes; never changed. */
  sha256: ColumnType<Buffer, Buffer, never>;
  /** The product admin who uploaded it; null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change. */
  updated_at: Date;
  /** Null while live; set once, from the API's clock, when deleted. */
  deleted_at: ColumnType<Date | null, never, Date>;
}

/**
 * A library file (migration 1700000000037): a helper file the Learning
 * Telflo tutorials use, global as test templates. Members read the files;
 * only a product admin writes them, which the API decides. Hard-deleted; a
 * trigger keeps the file's columns. The bytes are the file store's
 * (`global/library-files/<id>`).
 */
export interface LibraryFilesTable {
  id: ColumnType<string, string | undefined, never>;
  /** Trimmed, 1 to 200 characters. Telflo's own content. */
  name: string;
  /** At most 2,000 characters; `''` when there is none. */
  description: ColumnType<string, string | undefined, string>;
  /** The upload's own name, 1 to 255 characters; never changed. */
  file_name: ColumnType<string, string, never>;
  /** At most 10,485,760; never changed. */
  size_bytes: ColumnType<number, number, never>;
  /** The bytes' SHA-256, 32 bytes; never changed. */
  sha256: ColumnType<Buffer, Buffer, never>;
  /** The product admin who added it; null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change. */
  updated_at: Date;
}

/**
 * A regex library entry (migration 1700000000031): a named pattern the
 * validation-rule picker offers, global as test templates. Members read the
 * library; only a product admin writes it, which the API decides.
 * Hard-deleted. Seeded with 35 patterns.
 *
 * Both timestamps have no default: the API writes them from its injected
 * clock, as flows' (the seeded entries' are the migration's time to the
 * millisecond).
 */
export interface TestRegexTable {
  id: ColumnType<string, string | undefined, never>;
  /** Trimmed, 1 to 200 characters, unique (case-sensitive). Configuration text. */
  name: string;
  /** Free text, trimmed, 1 to 100 characters. Configuration text. */
  category: string;
  /** Trimmed, 1 to 2,000 characters, or null for none. Configuration text. */
  description: string | null;
  /** Never trimmed, not blank, at most 8,192 bytes. Configuration text. */
  regex: string;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change. */
  updated_at: Date;
}

/**
 * Postgres check ck_test_runs_status: a run's statuses, and "Validation
 * Failed" (migration 1700000000030): the collector ran and at least one of
 * the run's rules failed.
 */
export type TestRunStatus = "queued" | "running" | "succeeded" | "failed" | "validation_failed";

/** Postgres check ck_test_runs_signal. */
export type TestRunSignal = "traces" | "metrics" | "logs";

/** Written by a member's insert, never changed. */
type Snapshot<Value> = ColumnType<Value, Value, never>;

/** Written only by the dispatcher's functions (or the database's default): never by the API's own insert or update. */
type DispatcherOnly<Value> = ColumnType<Value, never, never>;

/**
 * A test run (migration 1700000000028): the queue's entry and the run's
 * record. A member inserts it queued, with its snapshot, and nothing else;
 * the API's role updates and deletes no row (policies `using (false)`): its
 * status, lease and results change only through the dispatcher's SECURITY
 * DEFINER functions (test_runs_claim, _finish, _release, _reap,
 * _fail_waiting), and a trigger refuses any change to the snapshot for every
 * role. So every column's update type is `never`, and the ones the API never
 * writes have an insert type `never` too: `queued_at` above all, whose
 * insert policy admits only `now()`.
 */
export interface TestRunsTable {
  /** Chosen by the API (uuidv7) before the insert: the input is copied into the run's folder first. */
  id: ColumnType<string, string | undefined, never>;
  organization_id: Snapshot<string>;
  /**
   * The configuration and the version run; both null for a YAML run (migration
   * 1700000000040: the public API's run of a text with no configuration,
   * visible to its creator alone), both set otherwise
   * (ck_test_runs_configuration_together).
   */
  configuration_id: Snapshot<string | null>;
  configuration_version_id: Snapshot<string | null>;
  /** The member who queued it, as the insert policy requires; null once their account is hard-deleted. */
  queued_by_user_id: ColumnType<string | null, string, never>;
  /** For a re-run, the run whose input it copied. */
  source_run_id: ColumnType<string | null, string | null | undefined, never>;
  /** The text run, organization-variable defaults substituted; at most 262,144 characters. Private. */
  yaml: Snapshot<string>;
  target_pipeline: Snapshot<string>;
  signal: Snapshot<TestRunSignal>;
  /** 1 to 60. */
  duration_seconds: Snapshot<number>;
  /** The configuration's distribution (fk_test_runs_configuration_distribution); a YAML run's, from the catalogue. */
  collector_distribution: Snapshot<string>;
  collector_version: Snapshot<string>;
  /** The input's name when it was queued. Private text. */
  input_name: Snapshot<string>;
  input_size_bytes: Snapshot<number>;
  /**
   * The "Suite › Configuration" breadcrumb (migration 1700000000029): for a
   * run queued from a definition, or a re-run of one, the suite and
   * definition it came from, with their names when it was queued; all four
   * set or all null (ck_test_runs_breadcrumb_together). The ids have no
   * foreign key. The names are configuration text.
   */
  test_suite_id: ColumnType<string | null, string | null | undefined, never>;
  test_suite_name: ColumnType<string | null, string | null | undefined, never>;
  test_definition_id: ColumnType<string | null, string | null | undefined, never>;
  test_definition_name: ColumnType<string | null, string | null | undefined, never>;
  /**
   * The rules' snapshot (migration 1700000000030): the validation pipeline
   * whose rules the run copied when it was queued (no foreign key; null
   * when there was none), and the rules, a JSON array of at most 200 in
   * position order, `'[]'` for none (the table's default). Frozen by the
   * guard trigger. A JSON text on insert, as the repository writes jsonb.
   * The rules are configuration text.
   */
  validation_pipeline_id: ColumnType<string | null, string | null | undefined, never>;
  validation_rules: ColumnType<unknown[], string | undefined, never>;
  /** `queued` on insert (the table's default; the insert policy admits nothing else). */
  status: ColumnType<TestRunStatus, never, never>;
  /** `now()` on insert: the insert policy admits nothing else, so it is never written. */
  queued_at: DispatcherOnly<Date>;
  started_at: DispatcherOnly<Date | null>;
  finished_at: DispatcherOnly<Date | null>;
  lease_id: DispatcherOnly<string | null>;
  lease_expires_at: DispatcherOnly<Date | null>;
  strategy: DispatcherOnly<string | null>;
  kwok_enabled: DispatcherOnly<boolean | null>;
  /** The text after the tester's mutations, scrubbed. Private. */
  mutated_yaml: DispatcherOnly<string | null>;
  /** The tester's mutations, a JSON array; the API's contract shapes it. */
  mutations: DispatcherOnly<unknown[] | null>;
  /** The tester's compatibility findings, a JSON array. */
  compatibility: DispatcherOnly<unknown[] | null>;
  /** The collector's scrubbed logs. Private. */
  logs: DispatcherOnly<string | null>;
  /** The run's phases in milliseconds. */
  timings: DispatcherOnly<Record<string, unknown> | null>;
  /** The stored output's size; null when there is none. */
  output_size_bytes: DispatcherOnly<number | null>;
  /** Null exactly when output_size_bytes is. */
  output_truncated: DispatcherOnly<boolean | null>;
  decoded_input_size_bytes: DispatcherOnly<number | null>;
  /** Null exactly when decoded_input_size_bytes is. */
  decoded_input_truncated: DispatcherOnly<boolean | null>;
  error_code: DispatcherOnly<string | null>;
  error_message: DispatcherOnly<string | null>;
  /**
   * The rules' results, one per rule of `validation_rules` in its order,
   * written by test_runs_finish; null until the run finishes, and on a run
   * whose rules weren't checked.
   */
  validation_results: DispatcherOnly<unknown[] | null>;
}

/**
 * The tester's health as every API process sees it (migration 1700000000028):
 * one row, global. The API's role reads it and changes it only through
 * otelcol_testing_mark.
 */
export interface OtelcolTestingStateTable {
  id: ColumnType<true, never, never>;
  /** When a monitor counted the tester down; null while it is up. */
  down_since: ColumnType<Date | null, never, never>;
}

/**
 * The OTTL evaluator's health as every API process sees it (migration
 * 1700000000030), as otelcol_testing_state: one row, global. The API's role
 * reads it and changes it only through ottl_evaluator_mark.
 */
export interface OttlEvaluatorStateTable {
  id: ColumnType<true, never, never>;
  /** When a monitor counted the evaluator down; null while it is up. */
  down_since: ColumnType<Date | null, never, never>;
}

/** Postgres check ck_validation_rules_kind: a rule's kinds. */
export type ValidationRuleKind = "contains_text" | "not_contains_text" | "contains_regex" | "not_contains_regex" | "ottl";

/** Postgres check ck_validation_rules_target: what a rule searches; an OTTL rule the output only. */
export type ValidationRuleTarget = "output" | "stderr";

/** Postgres check ck_validation_rules_ottl_context: the seven OTTL contexts; the signal's are the API's check. */
export type ValidationRuleOttlContext = "log" | "span" | "spanevent" | "metric" | "datapoint" | "resource" | "scope";

/** Postgres check ck_validation_rules_ottl_quantifier. */
export type ValidationRuleOttlQuantifier = "all" | "any" | "none" | "count" | "distinct";

/** Postgres check ck_validation_rules_ottl_count: a count's comparison. */
export type ValidationRuleOttlCountOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between";

/**
 * A configuration version's validation pipeline (migration 1700000000030):
 * one per YAML pipeline, holding its rules. Visible to whoever can see its
 * configuration; the insert policy names the context's user as its creator.
 * Created and deleted, never changed, so every column's update type is
 * `never`.
 */
export interface ValidationPipelinesTable {
  /** uuidv7 by default; a version copy names its own, in the source's order. */
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  configuration_id: ColumnType<string, string, never>;
  configuration_version_id: ColumnType<string, string, never>;
  /** The YAML pipeline (logs/default), 1 to 200 characters; unique per version. Configuration text. */
  pipeline_name: ColumnType<string, string, never>;
  /** The name's first part (ck_validation_pipelines_pipeline_signal). */
  signal: ColumnType<TestRunSignal, TestRunSignal, never>;
  /** The context's user on insert (the policy); null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert; a version copy writes the version's time. */
  created_at: ColumnType<Date, Date, never>;
}

/**
 * A validation pipeline's rule (migration 1700000000030), in its position. A
 * text or regex rule carries a pattern; an OTTL rule its OTTL columns.
 * Patterns, conditions and expressions are at most 8,192 bytes. A trigger
 * keeps its pipeline, place and creator for every role; its kind, target,
 * pattern, OTTL, name and description may change. The insert policy names
 * the context's user as its creator.
 */
export interface ValidationRulesTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  configuration_id: ColumnType<string, string, never>;
  configuration_version_id: ColumnType<string, string, never>;
  validation_pipeline_id: ColumnType<string, string, never>;
  /** From 1, unique per pipeline: max + 1 under the configuration's lock. Never changed. */
  position: ColumnType<number, number, never>;
  kind: ValidationRuleKind;
  target: ValidationRuleTarget;
  /** A text or regex rule's; null for an OTTL rule. Configuration text. */
  pattern: ColumnType<string | null, string | null | undefined, string | null>;
  ottl_context: ColumnType<ValidationRuleOttlContext | null, ValidationRuleOttlContext | null | undefined, ValidationRuleOttlContext | null>;
  /** Configuration text. */
  ottl_condition: ColumnType<string | null, string | null | undefined, string | null>;
  ottl_quantifier: ColumnType<
    ValidationRuleOttlQuantifier | null,
    ValidationRuleOttlQuantifier | null | undefined,
    ValidationRuleOttlQuantifier | null
  >;
  ottl_count_operator: ColumnType<
    ValidationRuleOttlCountOperator | null,
    ValidationRuleOttlCountOperator | null | undefined,
    ValidationRuleOttlCountOperator | null
  >;
  /** Never negative. */
  ottl_count_value: ColumnType<number | null, number | null | undefined, number | null>;
  /** Between's upper bound, at least its lower. */
  ottl_count_value2: ColumnType<number | null, number | null | undefined, number | null>;
  /** Distinct's value expression. Configuration text. */
  ottl_expression: ColumnType<string | null, string | null | undefined, string | null>;
  /** Trimmed, at most 200 characters; `''` when there is none. Configuration text. */
  name: ColumnType<string, string | undefined, string>;
  /** At most 2,000 characters; `''` when there is none. Configuration text. */
  description: ColumnType<string, string | undefined, string>;
  /**
   * Written by the public API's PUT of its validation pipeline (migration
   * 1700000000039), which the next PUT replaces; false for a person's.
   * Set on insert; a person's edit leaves it as it is.
   */
  is_api_owned: ColumnType<boolean, boolean | undefined, boolean>;
  /** The context's user on insert (the policy); null once their account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string, never>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every change. */
  updated_at: Date;
}

/** Why a session was revoked; see the sessions.revoked_reason column comment. */
export type SessionRevokedReason =
  | "logout"
  | "sign_out_everywhere"
  | "refresh_token_reused"
  | "password_reset"
  | "account_taken_over"
  | "organization_access_lost"
  | "signed_out_elsewhere"
  /** A product admin deleted the person, or the organization the session acted in with them (migration 1700000000042). */
  | "account_deleted";

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  active_organization_id: string;
  created_at: CreatedAt;
  last_refreshed_at: ColumnType<Date, Date | undefined, Date>;
  revoked_at: Date | null;
  revoked_reason: SessionRevokedReason | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: CreatedAt;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: CreatedAt;
}

export interface UserIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string;
  linked_at: Generated<Date>;
}

/**
 * A person's own settings (migration 1700000000034): lazy, no row means the
 * defaults; the first save inserts it. No row-level security: it belongs to
 * the user, not to an organization.
 */
export interface UserSettingsTable {
  user_id: ColumnType<string, string, never>;
  /** light, dark or navy (the check); dark by default. */
  theme: ColumnType<"light" | "dark" | "navy", string | undefined, string>;
  /**
   * Only the editor and email keys ever saved, a JSON object of at most
   * 4 KiB (the check). Read through the API's schema, which fills in the
   * defaults and reads a bad key as its default.
   */
  preferences: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  /** From the API's clock, on insert; never changed. */
  created_at: ColumnType<Date, Date, never>;
  /** From the API's clock, on insert and on every save. */
  updated_at: Date;
}

/**
 * A service account's name beside its user (migration 1700000000035): its
 * id is the user's id. Live while `deleted_at` is null here and on the
 * user, both set in one transaction. The name is unique, case aside,
 * among the organization's live accounts. Timestamps have no default: the
 * API writes them from its clock. The columns fixed at the insert can't
 * be updated (a compile error).
 */
export interface ServiceAccountsTable {
  user_id: ColumnType<string, string, never>;
  organization_id: ColumnType<string, string, never>;
  /** 1 to 64 characters. Organization content: never logged or audited. */
  name: string;
  /** Null once the admin's account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date, never>;
  updated_at: Date;
  deleted_at: Date | null;
}

/** What a token may do: read, or read and write. */
export type ApiTokenAccess = "read" | "write";

/**
 * A service account's API token (migration 1700000000035), stored only as
 * the SHA-256 of the token and its first 11 characters. Live while neither
 * revoked nor past `expires_at`, which the API compares with its own
 * clock. Revoked, never deleted by the API. Timestamps have no default:
 * the API writes them from its clock. The columns fixed at the insert
 * can't be updated (a compile error).
 */
export interface ApiTokensTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: ColumnType<string, string, never>;
  /** The account, in `organization_id` (the composite foreign key). */
  service_account_user_id: ColumnType<string, string, never>;
  /** 1 to 64 characters; unique among the account's tokens not revoked. Never logged or audited. */
  name: ColumnType<string, string, never>;
  /** SHA-256 (lowercase hex) of the whole token; the token is never stored. */
  token_hash: ColumnType<string, string, never>;
  /** The token's first 11 characters (tf_ and 8). Never logged or audited. */
  token_prefix: ColumnType<string, string, never>;
  access: ColumnType<ApiTokenAccess, ApiTokenAccess, never>;
  /** Null: never expires. */
  expires_at: ColumnType<Date | null, Date | null | undefined, never>;
  /** Written at most once a minute by the token check; null until the first use. */
  last_used_at: Date | null;
  /** Null once the admin's account is hard-deleted. */
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date, never>;
  /** Set once; a revoked token never works again. */
  revoked_at: Date | null;
  /** Only a revoked token names its revoker; null too once their account is hard-deleted. */
  revoked_by_user_id: string | null;
}

/**
 * A person's own API token (migration 1700000000038), stored, as a service
 * account's, only as the SHA-256 of the token and its first 11 characters.
 * It belongs to the user, not to an organization: the organization is
 * named per request (`X-Telflo-Org`). Row-level security shows the
 * context's user their own rows only. Live while neither revoked nor past
 * `expires_at` (the API's clock) and its user a live person. Revoked,
 * never deleted by the API. Timestamps have no default: the API writes
 * them from its clock. The columns fixed at the insert can't be updated (a
 * compile error).
 */
export interface PersonalApiTokensTable {
  id: ColumnType<string, string | undefined, never>;
  /** The person the token acts as; a hard delete of the user takes it with it. */
  user_id: ColumnType<string, string, never>;
  /** 1 to 64 characters; unique among the person's tokens not revoked. The person's content: never logged or audited. */
  name: ColumnType<string, string, never>;
  /** SHA-256 (lowercase hex) of the whole token; the token is never stored. */
  token_hash: ColumnType<string, string, never>;
  /** The token's first 11 characters (tf_ and 8). Never logged or audited. */
  token_prefix: ColumnType<string, string, never>;
  access: ColumnType<ApiTokenAccess, ApiTokenAccess, never>;
  /** Null: never expires. */
  expires_at: ColumnType<Date | null, Date | null | undefined, never>;
  /** Written at most once a minute by the token check; null until the first use. */
  last_used_at: Date | null;
  created_at: ColumnType<Date, Date, never>;
  /** Set once; a revoked token never works again. */
  revoked_at: Date | null;
}

/** How a product admin handled a feedback item. */
export type UserFeedbackOutcome = "acknowledged" | "dismissed";

/**
 * A person's message from "Contact us" (migration 1700000000041): pending
 * while `handled_at` is null. A system resource: the API's role may only
 * insert it, with an id it sends (`select uuidv7()`, never RETURNING); every
 * read and change goes through the product-admin functions. Its text is
 * personal data: never logged or audited.
 */
export interface UserFeedbackTable {
  id: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  /** The organization the person was acting in: context only, never shown. */
  organization_id: ColumnType<string, string, never>;
  /** Trimmed, 1 to 5,000 characters (the check). */
  text: ColumnType<string, string, never>;
  /** From the API's clock. */
  created_at: ColumnType<Date, Date, never>;
  /** The API's role never writes these: the handling function does (fixtures may). */
  handled_at: ColumnType<Date | null, Date | null | undefined, never>;
  handled_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  outcome: ColumnType<UserFeedbackOutcome | null, UserFeedbackOutcome | null | undefined, never>;
}

/**
 * Who a deleted person was (migration 1700000000041): written only by the
 * delete function, read only by an operator's SQL. The API's role holds
 * nothing on it.
 */
export interface UserDeletionRecordsTable {
  /** The API's role never writes these: the delete function does (fixtures may). */
  user_id: ColumnType<string, string, never>;
  original_email: ColumnType<string, string, never>;
  deleted_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  deleted_at: ColumnType<Date, Date, never>;
}

/** Postgres check ck_site_settings_organization_creation: who may create a group organization. */
export type StoredOrganizationCreation = "everyone" | "product_admins";

/**
 * The site's settings a product admin changes (migration 1700000000044): one
 * row, global, as otelcol_testing_state. The API's role reads it and changes
 * it only through the migration's product-admin definer (the
 * SystemRepository's call).
 */
export interface SiteSettingsTable {
  id: ColumnType<true, never, never>;
  /** product_admins (the default) or everyone. */
  organization_creation: ColumnType<StoredOrganizationCreation, never, never>;
}

/**
 * The Kysely view of the database. Hand-written rather than generated: the
 * schema is small enough that codegen would add a build step without adding
 * safety, and hand-writing forces a deliberate look at every column.
 *
 * Tables are added here by the migration that creates them.
 */
export interface Database {
  users: UsersTable;
  email_verification_tokens: EmailVerificationTokensTable;
  audit_events: AuditEventsTable;
  organizations: OrganizationsTable;
  organization_members: OrganizationMembersTable;
  organization_invitations: OrganizationInvitationsTable;
  quick_deploy_links: QuickDeployLinksTable;
  configurations: ConfigurationsTable;
  configuration_versions: ConfigurationVersionsTable;
  configuration_version_selections: ConfigurationVersionSelectionsTable;
  collector_distributions: CollectorDistributionsTable;
  collector_versions: CollectorVersionsTable;
  flows: FlowsTable;
  test_input_files: TestInputFilesTable;
  test_runs: TestRunsTable;
  test_suites: TestSuitesTable;
  test_definition_inputs: TestDefinitionInputsTable;
  test_definitions: TestDefinitionsTable;
  test_templates: TestTemplatesTable;
  library_files: LibraryFilesTable;
  test_regex: TestRegexTable;
  otelcol_testing_state: OtelcolTestingStateTable;
  validation_pipelines: ValidationPipelinesTable;
  validation_rules: ValidationRulesTable;
  ottl_evaluator_state: OttlEvaluatorStateTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_identities: UserIdentitiesTable;
  user_settings: UserSettingsTable;
  service_accounts: ServiceAccountsTable;
  api_tokens: ApiTokensTable;
  personal_api_tokens: PersonalApiTokensTable;
  user_feedback: UserFeedbackTable;
  user_deletion_records: UserDeletionRecordsTable;
  site_settings: SiteSettingsTable;
}
