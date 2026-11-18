// The kind smoke's collector values (scripts/smoke-kind.sh; D33-1
// spec decision 35, Preflight ruling 19): the values file the Helm dialog's
// download gives for a group, built by the contracts' own builders
// (helmValuesInputOf, helmValuesYaml), as the browser builds it, from the
// group's install facts and the fleet's default token's bearer.
//
// The smoke runs it as the text of `node --import tsx --input-type=module -e`
// in a telflo-core with its node_modules (where @telflo/contracts resolves),
// with the facts file's path as its one argument and the bearer on its
// standard input (never on a command line or in the environment), and writes
// the values to its standard output, which the smoke sends to a file of mode
// 0600. Its errors name a field only (HelmBuildError), never a value.
import { readFileSync } from "node:fs";
import { HelmInstallFactsSchema, helmValuesInputOf, helmValuesYaml } from "@telflo/contracts";

const factsPath = process.argv[1];
if (!factsPath) {
  process.stderr.write("collector-values: the facts file's path is missing\n");
  process.exit(2);
}
const facts = HelmInstallFactsSchema.parse(JSON.parse(readFileSync(factsPath, "utf8")));
const bearer = readFileSync(0, "utf8").replace(/\n$/, "");
process.stdout.write(helmValuesYaml(helmValuesInputOf(facts, bearer, [])));
