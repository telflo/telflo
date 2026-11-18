import { assertApplicationRole, createDb, createPool } from "@telflo/db";
import { createOpampServerClient } from "../opamp-server/client.js";
import { loadSettings } from "../settings.js";
import { describeFailure, runAdminCommand, type AdminCommandResources } from "./bootstrap.js";

/*
 * `telflo-admin`: the operator's commands, run beside the API with its
 * settings (D36-1 decision 37). In the API's image a shim runs this file's
 * build (`node /app/apps/api/dist/admin/telflo-admin.js`); in development,
 * from telflo-core: `npx tsx apps/api/src/admin/telflo-admin.ts bootstrap
 * --email <email> --organization <name>`; `reset-link --email <email>`
 * prints a fresh set-password link for a person's account (Q258).
 *
 * Everything it prints is a fixed line (or the address typed), except the
 * set-password link of `bootstrap` and `reset-link`, stdout's one last line
 * (D36-1 decision 54, Q266; neither sends email): an unexpected failure is
 * reported by its error's name and code only, never its message.
 */

const out = (line: string) => void process.stdout.write(`${line}\n`);
const err = (line: string) => void process.stderr.write(`${line}\n`);

/** The API's settings, its pool as telflo_platform (refused as a superuser or the tables' owner, as the API is) and opamp-server client. */
async function open(): Promise<AdminCommandResources> {
  // A refusal's message may quote the value it refused: describeFailure lets only a missing variable's name through.
  const settings = loadSettings(process.env);
  const db = createDb(createPool(settings.databaseUrl));
  try {
    await assertApplicationRole(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return {
    deps: {
      db,
      settings,
      opampServer: createOpampServerClient(settings.opampServer),
      now: () => new Date(),
      out,
      err,
    },
    close: () => db.destroy(),
  };
}

try {
  process.exitCode = await runAdminCommand(process.argv.slice(2), { out, err }, open);
} catch (error) {
  err(describeFailure(error));
  process.exitCode = 1;
}
