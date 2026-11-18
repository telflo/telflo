import { opampServerSettings } from "../settings.js";
import { createOpampServerClient } from "./client.js";
import { runStackSmokeCommand } from "./smoke.js";

// The compose stack's smoke test runs this inside the API container
// (D11a Preflight ruling 12), from /app/apps/api, compiled as the image
// ships it (D36-1 Preflight ruling 27):
//
//   node dist/opamp-server/stack-smoke.js <personal organization id>
//   node dist/opamp-server/stack-smoke.js group-registered <id> <name>
//   node dist/opamp-server/stack-smoke.js group-renamed <id> <name>
//   node dist/opamp-server/stack-smoke.js group-gone <id>
//   node dist/opamp-server/stack-smoke.js publications <organization id> <configuration id> <count> [version number]
//   node dist/opamp-server/stack-smoke.js publication <organization id> <configuration id> <version number> <version id> <sha256> <distribution> <collector version>
//
// It drives the platform's real client against the real opamp-server with
// TELFLO_OPAMP_MANAGEMENT_URL and TELFLO_OPAMP_MANAGEMENT_SECRET. With a
// personal organization's id, the one the smoke test's account got at
// sign-up through the gateway, it runs the publication sequence, then
// checks that organization was registered there (D11a decision 20). The
// group-* modes check a group organization the smoke test created, renamed
// or deleted through the gateway, the publications mode the snapshots of a
// configuration it published, then deleted, through the gateway (D11b), and
// the publication mode the one snapshot of a version it published: its
// version's id, its YAML by the SHA-256 the smoke test computed from the
// YAML it saved (D11b Ruling 29), and its collector, the configuration's
// distribution and the version's pin as the platform reported them (D13a
// decision 7).
// It exits non-zero with a message (never the secret, the YAML or a name)
// on any surprise. The sequences are runStackSmokeCommand's, tested
// against the fake; this file is only their entry point, and is left out
// of coverage.

try {
  const settings = opampServerSettings(process.env);
  const client = createOpampServerClient(settings);
  await runStackSmokeCommand(client, process.argv.slice(2), (line) => console.log(`stack smoke: ${line}`));
  console.log("stack smoke: ok");
} catch (error) {
  console.error(`stack smoke failed: ${error instanceof Error ? error.message : "an unknown error"}`);
  process.exit(1);
}
