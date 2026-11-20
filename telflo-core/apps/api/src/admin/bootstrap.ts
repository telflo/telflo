import { parseArgs } from "node:util";
import { emailSchema, isReservedEmail, OrganizationNameSchema } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import type { Kysely, Transaction } from "kysely";
import { setOrganizationContext, withAuthContext } from "../database/context.js";
import { AppError } from "../errors.js";
import type { IFileStore } from "../file-store/file-store.js";
import { createCollectingRunner } from "../http/after-response.js";
import type { IMailer } from "../mail/mailer.js";
import { createAuditRepository } from "../modules/identity/repositories/audit-repository.js";
import {
  createUserRepository,
  DuplicateEmailError,
  productAdminExists,
  ProductAdminExistsError,
  type Account,
} from "../modules/identity/repositories/user-repository.js";
import { createOpampRegistration } from "../modules/organizations/opamp-registration.js";
import { createInvitationRepository } from "../modules/organizations/repositories/invitation-repository.js";
import { createMemberRepository } from "../modules/organizations/repositories/member-repository.js";
import {
  createActiveOrganizationRepository,
  createOrganizationRepository,
} from "../modules/organizations/repositories/organization-repository.js";
import {
  createOrganizationService,
  type OrganizationRepositories,
  type WithOrganizationTransaction,
} from "../modules/organizations/service.js";
import { createPasswordResetTokenRepository } from "../modules/password-resets/repositories/password-reset-token-repository.js";
import {
  createPasswordResetService,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  type WithPasswordResetTransaction,
} from "../modules/password-resets/service.js";
import { createSessionRepository } from "../modules/sessions/repositories/session-repository.js";
import { readOrganizationCreation } from "../modules/site-settings/organization-creation.js";
import type { OpampServerClient } from "../opamp-server/client.js";
import type { AppSettings } from "../settings.js";

/*
 * `telflo-admin bootstrap --email <email> --organization <name>`: the site's
 * first product admin, on a site where nobody can register. Run in the
 * API's pod (`kubectl exec deploy/telflo-api -- telflo-admin bootstrap …`)
 * with the API's settings and its database role (telflo_platform); it sends
 * no email (its mailer refuses). In order:
 *   1. refused when a product admin exists, as migration 043's function
 *      answers it (the flag is never read here);
 *   2. refused when an account, live or deleted, has the email;
 *   3. in one transaction: the account (no password, the email unconfirmed,
 *      no Terms, its personal organization as every account gets one),
 *      registration's audit rows (`user.registered` via bootstrap), and the
 *      function's call, which sets the flag and audits it. A refusal there
 *      (a product admin made meanwhile) rolls the account back;
 *   4. the group organization, with the account as its admin, as "New
 *      organization" creates one;
 *   5. a set-password link, the password reset's token (stored hashed, 60
 *      minutes, used once; completing it sets the password and confirms the
 *      email), printed once as stdout's last line, after a fixed line;
 *      never mailed.
 * The opamp-server registers both organizations before the command ends
 * (best effort: a miss heals on first use).
 *
 * It works whatever the registration mode and the mail settings. It
 * prints fixed lines and the address only: never a token, the
 * organization's name or an error's message, and the link only as its one
 * last stdout line (never on stderr, in a log or an audit row). Exit codes:
 * 0 done; 1 refused, the address taken, or the organization or the link
 * failing after the account was made; 2 a usage error.
 */

export type ExitCode = 0 | 1 | 2;

export const BOOTSTRAP_USAGE = "Usage: telflo-admin bootstrap --email <email> --organization <name>";

/** The command's fixed lines (the address aside, which the operator typed). */
export const BOOTSTRAP_MESSAGES = {
  productAdminExists: "A product admin already exists: nothing was changed.",
  emailTaken: "An account already has that email address: nothing was changed.",
  created: (email: string) => `Created the account ${email} and made it the first product admin.`,
  organizationCreated: "Created the organization, with the account as its admin.",
  organizationNameTaken:
    "The organization wasn't created: an organization already has that name. Create it after signing in.",
  organizationFailed: "The organization wasn't created. Create it after signing in.",
  /** The link itself follows on stdout's next and last line (bootstrap's and reset-link's). */
  linkFollows: `Open this link within ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes to set the password (it works once):`,
  linkFailed: (email: string) =>
    `The link to set the password wasn't made. Make one with: telflo-admin reset-link --email ${email}`,
  opampServerMissed: "The opamp-server didn't register an organization yet: it registers it on first use.",
} as const;

/** Usage errors' fixed lines (exit 2). */
export const BOOTSTRAP_USAGE_PROBLEMS = {
  arguments: "telflo-admin bootstrap takes --email and --organization, each once, and nothing else.",
  email: "--email must be an email address.",
  reservedEmail: "--email can't be at a domain reserved for service and deleted accounts.",
  organization: "--organization must be 1 to 100 characters.",
} as const;

export interface BootstrapInput {
  /** As registration reads an address: trimmed and lowercased. */
  email: string;
  /** Trimmed, as "New organization" reads a name. */
  organization: string;
}

export type ParsedBootstrapArguments =
  | { kind: "bootstrap"; input: BootstrapInput }
  | { kind: "usage"; problem: string };

/**
 * The commands' shared option reading: `parseArgs`, strict (an unknown
 * option, a missing value or a value given to a flag is refused), no
 * positional argument, and each option at most once (parseArgs keeps the
 * last of a repeated one). `undefined` when refused; the values otherwise.
 */
function readOptions(
  args: readonly string[],
  options: Record<string, { type: "string" | "boolean" }>,
): Record<string, string | boolean | undefined> | undefined {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: [...args], options, strict: true, allowPositionals: false }));
  } catch {
    return undefined;
  }
  const count = (name: string) => args.filter((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)).length;
  if (Object.keys(options).some((name) => count(name) > 1)) return undefined;
  return values as Record<string, string | boolean | undefined>;
}

/**
 * `bootstrap`'s options (`--email`, `--organization`); a refusal names the
 * problem in fixed words, never the value. Any other option is refused,
 * `--print-link` among them (the link is always printed).
 */
export function parseBootstrapArguments(args: readonly string[]): ParsedBootstrapArguments {
  const values = readOptions(args, { email: { type: "string" }, organization: { type: "string" } });
  if (values === undefined || values.email === undefined || values.organization === undefined) {
    return { kind: "usage", problem: BOOTSTRAP_USAGE_PROBLEMS.arguments };
  }
  const email = emailSchema.safeParse(values.email);
  if (!email.success) return { kind: "usage", problem: BOOTSTRAP_USAGE_PROBLEMS.email };
  if (isReservedEmail(email.data)) return { kind: "usage", problem: BOOTSTRAP_USAGE_PROBLEMS.reservedEmail };
  const organization = OrganizationNameSchema.safeParse(values.organization);
  if (!organization.success) return { kind: "usage", problem: BOOTSTRAP_USAGE_PROBLEMS.organization };
  return {
    kind: "bootstrap",
    input: { email: email.data, organization: organization.data },
  };
}

export const RESET_LINK_USAGE = "Usage: telflo-admin reset-link --email <email>";

/** `reset-link`'s fixed lines: never the address, nor whether an account of another kind has it. */
export const RESET_LINK_MESSAGES = {
  noAccount: "No live account has that email address: nothing was changed.",
} as const;

/** `reset-link`'s usage errors (exit 2). */
export const RESET_LINK_USAGE_PROBLEMS = {
  arguments: "telflo-admin reset-link takes --email, once, and nothing else.",
  email: BOOTSTRAP_USAGE_PROBLEMS.email,
} as const;

export type ParsedResetLinkArguments = { kind: "reset-link"; input: { email: string } } | { kind: "usage"; problem: string };

/**
 * `reset-link`'s one option, `--email`, read as bootstrap reads it. A
 * reserved domain's address isn't refused here: it reaches the lookup and
 * gets "no live account", as an unknown address does.
 */
export function parseResetLinkArguments(args: readonly string[]): ParsedResetLinkArguments {
  const values = readOptions(args, { email: { type: "string" } });
  if (values === undefined || values.email === undefined) {
    return { kind: "usage", problem: RESET_LINK_USAGE_PROBLEMS.arguments };
  }
  const email = emailSchema.safeParse(values.email);
  if (!email.success) return { kind: "usage", problem: RESET_LINK_USAGE_PROBLEMS.email };
  return { kind: "reset-link", input: { email: email.data } };
}

export interface BootstrapDependencies {
  /** The API's own pool, as telflo_platform. */
  db: Kysely<Database>;
  /** Where the set-password link points. */
  settings: Pick<AppSettings, "publicWebUrl">;
  opampServer: OpampServerClient;
  now: () => Date;
  /** A line for the operator: what was done. */
  out: (line: string) => void;
  /** A line for the operator: what was refused or failed. */
  err: (line: string) => void;
}

/**
 * The only mailer the commands have: they print their link and send nothing,
 * so a site without a reachable relay still gets it. The organization and
 * reset services take a mailer; this one refuses every send, so no email can
 * leave even if something tried to send one.
 */
export const REFUSING_MAILER: IMailer = {
  send: async () => {
    throw new Error("a command that prints its link sends no email");
  },
};

/** A create without a logo touches no file: a store that refuses everything, so nothing could be written by mistake. */
const NO_FILE_STORE: IFileStore = {
  write: async () => {
    throw new Error("the bootstrap stores no file");
  },
  read: async () => {
    throw new Error("the bootstrap reads no file");
  },
  copy: async () => {
    throw new Error("the bootstrap copies no file");
  },
  remove: async () => {
    throw new Error("the bootstrap removes no file");
  },
};

function organizationTransactions(db: Kysely<Database>): WithOrganizationTransaction {
  const repositories = (transaction: Transaction<Database>, organizationId: string): OrganizationRepositories => ({
    organization: createActiveOrganizationRepository(transaction, { organizationId }),
    members: createMemberRepository(transaction, { organizationId }),
    invitations: createInvitationRepository(transaction, { organizationId }),
  });
  // As the organization routes' (createOrganizationServices): the caller's context, then the organization entered.
  return (context, work) =>
    withAuthContext(db, context, (transaction) =>
      work({
        organizations: createOrganizationRepository(transaction),
        audit: createAuditRepository(transaction),
        active: repositories(transaction, context.organizationId),
        enterOrganization: async (organizationId) => {
          await setOrganizationContext(transaction, organizationId);
          return repositories(transaction, organizationId);
        },
      }),
    );
}

/** The password reset's service as the commands use it: its mailer refuses. */
function passwordResets(deps: Pick<BootstrapDependencies, "db" | "settings" | "now">, users: ReturnType<typeof createUserRepository>) {
  return createPasswordResetService({
    users,
    audit: createAuditRepository(deps.db),
    mailer: REFUSING_MAILER,
    settings: deps.settings,
    now: deps.now,
    withTransaction: passwordResetTransactions(deps.db),
  });
}

function passwordResetTransactions(db: Kysely<Database>): WithPasswordResetTransaction {
  // As the password reset routes': every repository bound to one transaction.
  return (work) =>
    db.transaction().execute((transaction) =>
      work({
        users: createUserRepository(transaction),
        passwordResetTokens: createPasswordResetTokenRepository(transaction),
        sessions: createSessionRepository(transaction),
      }),
    );
}

/** Makes the first product admin; answers the exit code. Throws only on something unexpected (the database unreachable). */
export async function bootstrapFirstProductAdmin(input: BootstrapInput, deps: BootstrapDependencies): Promise<ExitCode> {
  const { db, settings, now, out, err } = deps;
  const users = createUserRepository(db);
  // The opamp-server's registrations queue here and are awaited before the end, not dropped with the process.
  const runner = createCollectingRunner();
  let opampMissed = false;
  const opampRegistration = createOpampRegistration({
    opampServer: deps.opampServer,
    runAfterResponse: runner.run,
    // Its lines name ids and results; the operator gets one fixed line instead.
    log: {
      warn: () => {
        opampMissed = true;
      },
      error: () => {
        opampMissed = true;
      },
    },
  });

  // The probe: the definer called with a random uuid in a transaction that
  // always rolls back, briefly holding its global advisory lock and leaving
  // no lock, audit row or change; the answer comes from the refusal's HINT,
  // so the flag is never read.
  if (await productAdminExists(db, now())) {
    err(BOOTSTRAP_MESSAGES.productAdminExists);
    return 1;
  }
  if (await users.findByEmailIncludingDeleted(input.email)) {
    err(BOOTSTRAP_MESSAGES.emailTaken);
    return 1;
  }

  const createdAt = now();
  let account: Account;
  try {
    account = await users.createAccount(
      { email: input.email, passwordHash: null, terms: null, emailVerifiedAt: null, createdAt, origin: {} },
      // In the account's transaction: registration's audit rows, then the
      // function. Its refusal rolls the account back with them.
      async ({ user, organization, membership }, writes) => {
        const actor = { actorUserId: user.id, actorEmail: user.email, organizationId: organization.id };
        await writes.audit.record({
          ...actor,
          action: "user.registered",
          subjectType: "user",
          subjectId: user.id,
          metadata: { via: "bootstrap" },
        });
        await writes.audit.record({
          ...actor,
          action: "organization.created",
          subjectType: "organization",
          subjectId: organization.id,
          metadata: { type: organization.type },
        });
        await writes.audit.record({
          ...actor,
          action: "organization_member.added",
          subjectType: "organization_member",
          subjectId: membership.id,
          metadata: { role: membership.role },
        });
        if (!writes.bootstrapFirstProductAdmin) throw new Error("the account's transaction can't make a product admin");
        await writes.bootstrapFirstProductAdmin(user.id, createdAt);
      },
    );
  } catch (error) {
    // A product admin, or the address, committed by someone else since the checks above.
    if (error instanceof ProductAdminExistsError) {
      err(BOOTSTRAP_MESSAGES.productAdminExists);
      return 1;
    }
    if (error instanceof DuplicateEmailError) {
      err(BOOTSTRAP_MESSAGES.emailTaken);
      return 1;
    }
    throw error;
  }
  const { user, organization: personal } = account;
  opampRegistration.created(personal);
  out(BOOTSTRAP_MESSAGES.created(input.email));
  let code: ExitCode = 0;

  // The group organization, as "New organization" makes one: the account as
  // its admin, acting from its personal organization.
  const organizations = createOrganizationService({
    withTransaction: organizationTransactions(db),
    now,
    mailer: REFUSING_MAILER,
    publicWebUrl: settings.publicWebUrl,
    // Neither is used by a create without a logo.
    consumeInvitationEmail: () => {
      throw new Error("the bootstrap sends no invitation");
    },
    log: { error: () => {}, warn: () => {} },
    opampRegistration,
    fileStore: NO_FILE_STORE,
    nextId: () => createOrganizationRepository(db).nextId(),
    organizationCreation: () => readOrganizationCreation(db),
    // Unread: only an invite or a resend reads it, and the bootstrap sends
    // no invitation (consumeInvitationEmail above throws first).
    registration: "closed",
  });
  try {
    await organizations.create(
      {
        context: { userId: user.id, organizationId: personal.id, role: "admin" },
        email: user.email,
        // The function above made the account the first product admin, committed:
        // the product admins' switch never refuses it.
        isProductAdmin: true,
      },
      input.organization,
    );
    out(BOOTSTRAP_MESSAGES.organizationCreated);
  } catch (error) {
    err(
      error instanceof AppError && error.code === "organization_name_taken"
        ? BOOTSTRAP_MESSAGES.organizationNameTaken
        : BOOTSTRAP_MESSAGES.organizationFailed,
    );
    code = 1;
  }

  // The password reset's token: its link, its 60 minutes, its single use
  // and its audit row (`returned`).
  // Never mailed: held here, printed last, and goes nowhere else.
  let link: string | undefined;
  try {
    link = await passwordResets(deps, users).issueResetLink({ email: user.email });
  } catch {
    link = undefined;
  }
  if (link === undefined) {
    err(BOOTSTRAP_MESSAGES.linkFailed(input.email));
    code = 1;
  }

  try {
    await runner.settle();
  } catch {
    opampMissed = true;
  }
  if (opampMissed) err(BOOTSTRAP_MESSAGES.opampServerMissed);
  // Last, once, on stdout only: the link the operator opens or hands on.
  if (link !== undefined) {
    out(BOOTSTRAP_MESSAGES.linkFollows);
    out(link);
  }
  return code;
}

/**
 * `telflo-admin reset-link --email <email>`: a fresh set-password link for a
 * live person's account, printed as `bootstrap` prints one: the password
 * reset's token (hashed, 60 minutes, used once, the account's earlier links
 * consumed), the fixed line, then the link as stdout's last line; no email
 * (its mailer refuses), whatever the registration mode or the mail settings.
 * The way back when the bootstrap's printed link was lost or expired; it
 * works for any person's account, as anyone who can run it (exec in the API's
 * pod) can already reach the database as the API's role.
 *
 * An address with no live person's account, a service account's or a
 * deleted account's included, is refused (exit 1) in fixed words before
 * anything is written: no token, no audit row. Its request is audited as
 * `bootstrap`'s is, with `via: "admin_command"`. The link reaches no log
 * line, error, audit row or stderr.
 */
export async function printResetLink(input: { email: string }, deps: BootstrapDependencies): Promise<ExitCode> {
  const users = createUserRepository(deps.db);
  // `findByEmail` finds a live person only (no service account, no deleted account): the same refusal for all.
  if (!(await users.findByEmail(input.email))) {
    deps.err(RESET_LINK_MESSAGES.noAccount);
    return 1;
  }
  // `undefined` only if the account was deleted since the lookup (its request then audited no_account).
  const link = await passwordResets(deps, users).issueResetLink({ email: input.email, via: "admin_command" });
  if (link === undefined) {
    deps.err(RESET_LINK_MESSAGES.noAccount);
    return 1;
  }
  deps.out(BOOTSTRAP_MESSAGES.linkFollows);
  deps.out(link);
  return 0;
}

/** The settings' refusal of a missing variable: its name only, never a value (settings.ts's `required`). */
const MISSING_VARIABLE = /^Missing required environment variable: [A-Z][A-Z0-9_]{0,127}$/;

/**
 * The one line an unexpected failure prints (exit 1): the error's name and
 * code when they are plain tokens, never its message (which may quote a
 * value, a host or a query), except the settings' "Missing required
 * environment variable: NAME", which names a variable only.
 */
export function describeFailure(error: unknown): string {
  const { name, code, message } = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const token = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined);
  const facts = [token(name), token(code)].filter((part) => part !== undefined).join(" ") || "unknown";
  const missing = typeof message === "string" && MISSING_VARIABLE.test(message) ? ` ${message}.` : "";
  return `The command failed (${facts}).${missing} Nothing after the failure was done.`;
}

export interface AdminCommandResources {
  deps: BootstrapDependencies;
  /** Ends the pool. */
  close: () => Promise<void>;
}

/**
 * `telflo-admin <command> …`: `bootstrap` and `reset-link`, with the same
 * exit codes (0 done, 1 refused or failed, 2 usage). Usage errors are
 * answered before anything is opened (no settings, no database). `open`
 * builds the API's settings, pool and opamp-server client.
 */
export async function runAdminCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  open: () => Promise<AdminCommandResources>,
): Promise<ExitCode> {
  const [command, ...rest] = argv;
  const parsed =
    command === "bootstrap"
      ? { usage: BOOTSTRAP_USAGE, arguments: parseBootstrapArguments(rest) }
      : command === "reset-link"
        ? { usage: RESET_LINK_USAGE, arguments: parseResetLinkArguments(rest) }
        : undefined;
  if (parsed === undefined) {
    io.err(BOOTSTRAP_USAGE);
    io.err(RESET_LINK_USAGE);
    return 2;
  }
  const { usage, arguments: args } = parsed;
  if (args.kind === "usage") {
    io.err(args.problem);
    io.err(usage);
    return 2;
  }
  const resources = await open();
  try {
    return args.kind === "bootstrap"
      ? await bootstrapFirstProductAdmin(args.input, resources.deps)
      : await printResetLink(args.input, resources.deps);
  } finally {
    await resources.close();
  }
}
