/*
 * The `telflo` command (D27 decisions 11, 18 and 30): the root's `--json`
 * and `-V, --cli-version` (not `--version`: `config pull`, `deploy` and
 * `test` own a `--version <n>`), every area's commands, and how a run ends.
 *
 * Program.ts creates the `config` command and hands it to Task 4a's
 * `registerConfigCommands` and Task 4c's `registerConfigRulesCommand`
 * (Preflight ruling 22), so no two areas edit one file.
 *
 * Commander's own messages (a usage error) go through `withoutTokens`: the
 * CLI takes no token on argv, and one typed there anyway is not echoed.
 * With `--json` (Ruling 254) commander writes nothing itself: its usage
 * error is the CLI's `{ "error": { "code": "usage_error", … } }` on stderr,
 * so stderr stays JSON only even when the parse fails before any action.
 */

import { Command, CommanderError } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerConfigRulesCommand } from "./commands/config-rules.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerFleetCommands } from "./commands/fleet.js";
import { registerFlowsCommands } from "./commands/flows.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerOttlCommands } from "./commands/ottl.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { registerTestCommand } from "./commands/test.js";
import { registerValidateCommand } from "./commands/validate.js";
import { EXIT, ExitError, getIo, guardOutputStreams, reportError, setIo, setJsonMode, withoutTokens, type ExitCode, type Io } from "./output.js";
import { VERSION } from "./version.js";

/** The words a `--json` usage error carries when commander gave none (no command: it would print the help). */
export const COMMAND_NEEDED_MESSAGE = "Give a command: telflo --help lists them.";

/** Whether `--json` is on argv (node's: runtime and script first), before any `--`: known before commander parses. */
export function jsonRequested(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes("--json");
}

/** Commander's usage error as the CLI's fixed words: its message without the "error: " prefix, tokens out. */
export function usageErrorOf(error: CommanderError): ExitError {
  const message = error.message.startsWith("error: ") ? error.message.slice("error: ".length) : COMMAND_NEEDED_MESSAGE;
  return new ExitError(withoutTokens(message.trim()), EXIT.USAGE);
}

/**
 * The root command with every area registered. `json`: commander's own
 * error output (its usage error, and the help it prints with one) is held
 * back for `run` to report as JSON.
 */
export function createProgram(options: { json?: boolean } = {}): Command {
  const quiet = options.json === true;
  const program = new Command("telflo")
    .description("The Telflo CLI: validate, test, push and deploy OpenTelemetry Collector configurations")
    .version(VERSION, "-V, --cli-version", "print the CLI's version")
    .option("--json", "machine-readable JSON output (errors as JSON on stderr)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => getIo().stdout(text),
      writeErr: (text) => {
        if (!quiet) getIo().stderr(withoutTokens(text));
      },
      outputError: (text, write) => {
        if (!quiet) write(withoutTokens(text));
      },
    })
    .hook("preAction", (_program, action) => {
      setJsonMode(action.optsWithGlobals<{ json?: boolean }>().json === true);
    });

  registerAuthCommands(program);
  registerOrgCommands(program);
  const config = program.command("config").description("Work with the organization's configurations");
  registerConfigCommands(config);
  registerConfigRulesCommand(config);
  registerValidateCommand(program);
  registerOttlCommands(program);
  registerFlowsCommands(program);
  registerFleetCommands(program);
  registerDeployCommand(program);
  registerTestCommand(program);
  registerSkillsCommands(program);
  return program;
}

/**
 * One run of the CLI on `argv` (node's: the first two are the runtime and
 * the script), answering its exit code. Help and the version are 0; a usage
 * error commander finds is 2; an error is reported (fixed words, `--json`
 * aware) with its own code.
 */
export async function run(argv: readonly string[], io?: Partial<Io>): Promise<ExitCode> {
  setJsonMode(false);
  if (io !== undefined) setIo(io);
  const json = jsonRequested(argv);
  try {
    await createProgram({ json }).parseAsync([...argv]);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return EXIT.OK;
      if (!json) return EXIT.USAGE;
      setJsonMode(true);
      return reportError(usageErrorOf(error));
    }
    return reportError(error);
  } finally {
    if (io !== undefined) setIo();
  }
}

/**
 * The bin's entry (`index.ts`): its streams guarded (a closed pipe ends it
 * quietly, Ruling 247), then the run's code as the process's exit code, its
 * streams left to drain.
 */
let guarded = false;

export async function main(argv: readonly string[]): Promise<void> {
  if (!guarded) guardOutputStreams();
  guarded = true;
  process.exitCode = await run(argv);
}
