/*
 * The `config` commands: `list`, `get`, `pull`, `create`, `publish`, `push`,
 * added to the `config` command `program.ts` creates (`config rules` is
 * `config-rules.ts`'). They print the public API's fields: `versionNumber`,
 * `publishedVersionNumber` (the highest published), the pin (`distribution`,
 * `collectorVersion`) and a version's `label`.
 *
 * A configuration's YAML is printed only where it's asked for (`pull`, byte
 * for byte: data, not a message), and the collector's errors only as
 * `push`'s output: never in an error's message. Every other server string
 * in a human line goes through `terminalText` (tables strip their cells
 * themselves).
 */

import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { PublicConfiguration } from "@telflo/contracts";
import { requireClient } from "../context.js";
import { requireId } from "../ids.js";
import { readInput } from "../input.js";
import {
  createConfiguration,
  getConfigurationWithVersions,
  listConfigurations,
  parseVersionNumber,
  publishVersion,
  pullConfiguration,
  pushConfiguration,
} from "../ops/configurations.js";
import { renderValidationErrors } from "../ops/validate.js";
import { emit, EXIT, ExitError, isJsonMode, printTable, terminalText, writeErr, writeNote, writeYaml } from "../output.js";
import { describePin } from "../pin.js";

export const NO_CONFIGURATIONS_MESSAGE = "No configurations.";
export const CANNOT_WRITE_MESSAGE = (path: string): string => `Can't write the file ${path}.`;
export const PUSH_INVALID_MESSAGE = "The configuration failed validation: nothing was saved.";
export const LABEL_AND_DESCRIPTION_MESSAGE = "Give --label or --description (its alias), not both.";
/** A version's label's most characters (the contracts' `CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH`; a drift test holds them equal). */
export const LABEL_MAXIMUM_LENGTH = 80;
export const LABEL_LENGTH_MESSAGE = `--label must be 1 to ${LABEL_MAXIMUM_LENGTH} characters.`;
export const LABEL_NOT_APPLIED_NOTE =
  "The latest version is a draft, so it was updated in place: --label names a new version only, and wasn't applied.";

function published(configuration: Pick<PublicConfiguration, "publishedVersionNumber">): string | null {
  return configuration.publishedVersionNumber === null ? null : `v${configuration.publishedVersionNumber}`;
}

/** Writes a file the command was asked to (`-o`): a failure is fixed words naming the path given, exit 2. */
export function writeOutputFile(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch {
    throw new ExitError(CANNOT_WRITE_MESSAGE(path), EXIT.USAGE);
  }
}

/** `telflo config list`: every page of route 4. */
export async function configList(): Promise<void> {
  const rows = await listConfigurations(requireClient());
  emit(rows, () =>
    rows.length === 0
      ? NO_CONFIGURATIONS_MESSAGE
      : printTable(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            published: published(row) ?? "-",
            latest: `v${row.versionNumber}`,
            collector: describePin(row),
          })),
          ["id", "name", "published", "latest", "collector"],
        ),
  );
}

/** `telflo config get <id>`: the configuration (routes 5) and its versions (route 8). */
export async function configGet(id: string): Promise<void> {
  const configurationId = requireId(id, "configuration");
  const { configuration, versions } = await getConfigurationWithVersions(requireClient(), configurationId);
  emit({ ...configuration, versions }, () =>
    [
      `${terminalText(configuration.name)} (${configuration.id})`,
      `published: ${published(configuration) ?? "no"}`,
      `collector: ${terminalText(describePin(configuration))} (v${configuration.versionNumber}'s pin)`,
      "",
      printTable(
        versions.map((version) => ({
          version: `v${version.versionNumber}`,
          status: version.status,
          label: version.label,
          collector: describePin(version),
          created: version.createdAt,
        })),
        ["version", "status", "label", "collector", "created"],
      ),
    ].join("\n"),
  );
}

/** `telflo config pull <id> [--version <n>] [-o <file>]`: the YAML exactly as stored, its pin on stderr. */
export async function configPull(id: string, options: { version?: number; out?: string }): Promise<void> {
  const configurationId = requireId(id, "configuration");
  const pulled = await pullConfiguration(requireClient(), configurationId, options.version);
  const pin = { distribution: pulled.distribution, collectorVersion: pulled.collectorVersion };
  // The pin every time: whoever edits the file next validates and tests it on that collector (`--config <id>`).
  const pinned = `pinned to ${terminalText(describePin(pin))}`;
  if (options.out !== undefined) {
    const out = options.out;
    writeOutputFile(out, pulled.yaml);
    emit(
      { id: pulled.id, versionNumber: pulled.versionNumber, out, ...pin },
      () => `Wrote v${pulled.versionNumber} to ${out} (${pinned}). Validate or test it on that collector with --config ${pulled.id}.`,
    );
  } else if (isJsonMode()) {
    emit({ id: pulled.id, versionNumber: pulled.versionNumber, yaml: pulled.yaml, ...pin }, () => "");
  } else {
    writeYaml(pulled.yaml);
    writeErr(`# v${pulled.versionNumber}, ${pinned}`);
  }
}

/** `telflo config create --name <name> -f <file>`: route 6. */
export async function configCreate(options: { name: string; file: string }): Promise<void> {
  const yaml = await readInput(options.file);
  const created = await createConfiguration(requireClient(), options.name, yaml);
  emit(
    created,
    () =>
      `Created configuration "${terminalText(created.name)}" (${created.id}) with draft v${created.versionNumber}. ` +
      `Publish it with: telflo config publish ${created.id} --version ${created.versionNumber}`,
  );
}

/** `telflo config publish <id> --version <n>`: route 12. */
export async function configPublish(id: string, options: { version: number }): Promise<void> {
  const configurationId = requireId(id, "configuration");
  const configuration = await publishVersion(requireClient(), configurationId, options.version);
  emit(configuration, () => `Published v${options.version} of "${terminalText(configuration.name)}" (${configuration.id}).`);
}

/**
 * `--label`, or `--description` (its alias): both is a usage error, and so
 * is a label the API would refuse (trimmed, 1 to 80 characters: the
 * contracts' `ConfigurationVersionLabelSchema`).
 */
export function labelOf(options: { label?: string; description?: string }): string | undefined {
  if (options.label !== undefined && options.description !== undefined) throw new ExitError(LABEL_AND_DESCRIPTION_MESSAGE, EXIT.USAGE);
  const label = options.label ?? options.description;
  if (label === undefined) return undefined;
  const length = label.trim().length;
  if (length < 1 || length > LABEL_MAXIMUM_LENGTH) throw new ExitError(LABEL_LENGTH_MESSAGE, EXIT.USAGE);
  return label;
}

/**
 * `telflo config push <id> -f <file> [--publish] [--label <text>]`. Invalid
 * YAML prints the collector's errors (stdout, or the JSON) and exits 4;
 * nothing is saved.
 */
export async function configPush(
  id: string,
  options: { file: string; publish?: boolean; label?: string; description?: string },
): Promise<void> {
  // Every usage check before the login: the label, the id, the file.
  const label = labelOf(options);
  const configurationId = requireId(id, "configuration");
  const yaml = await readInput(options.file);
  const result = await pushConfiguration(requireClient(), configurationId, yaml, {
    ...(options.publish === true && { publish: true }),
    ...(label !== undefined && { label }),
  });
  if (result.status === "invalid") {
    emit({ status: result.status, errors: result.errors }, () => ["Invalid:", ...renderValidationErrors(result.errors)].join("\n"));
    throw new ExitError(PUSH_INVALID_MESSAGE, EXIT.FAILED);
  }
  if (label !== undefined && result.action === "patched") writeNote(LABEL_NOT_APPLIED_NOTE);
  const { action, versionNumber } = result;
  emit(
    { action, versionNumber, published: result.published },
    () =>
      `${action === "patched" ? "Updated draft" : "Created"} v${versionNumber}` +
      (result.published ? " and published it." : `. Publish it with: telflo config publish ${configurationId} --version ${versionNumber}`),
  );
}

export function registerConfigCommands(config: Command): void {
  config
    .command("list")
    .description("List the configurations")
    .action(() => configList());

  config
    .command("get")
    .description("Show a configuration and its versions")
    .argument("<id>", "the configuration's id")
    .action((id: string) => configGet(id));

  config
    .command("pull")
    .description("Print or save a configuration's YAML (the latest version, or --version)")
    .argument("<id>", "the configuration's id")
    .option("--version <n>", "a version's number", parseVersionNumber)
    .option("-o, --out <file>", "write the YAML to a file instead of stdout")
    .action((id: string, options: { version?: number; out?: string }) => configPull(id, options));

  config
    .command("create")
    .description("Create a configuration (and its draft v1) from a YAML file")
    .requiredOption("--name <name>", "the configuration's name")
    .requiredOption("-f, --file <file>", "the YAML file, or - for stdin")
    .action((options: { name: string; file: string }) => configCreate(options));

  config
    .command("publish")
    .description("Publish a version")
    .argument("<id>", "the configuration's id")
    .requiredOption("--version <n>", "the version's number", parseVersionNumber)
    .action((id: string, options: { version: number }) => configPublish(id, options));

  config
    .command("push")
    .description("Push a YAML file: updates the latest draft in place, or adds a new version when the latest is published")
    .argument("<id>", "the configuration's id")
    .requiredOption("-f, --file <file>", "the YAML file, or - for stdin")
    .option("--publish", "publish the version pushed")
    .option("--label <text>", "the new version's label (when one is added)")
    .option("--description <text>", "the same as --label")
    .action((id: string, options: { file: string; publish?: boolean; label?: string; description?: string }) =>
      configPush(id, options),
    );
}
