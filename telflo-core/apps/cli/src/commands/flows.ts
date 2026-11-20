/*
 * `telflo flows list|get|pull`: Telflo's prebuilt collector configurations, on
 * routes 24-25 (`authorName`, `distribution`, `sourceUrl`). Every server
 * string in a human line goes through `terminalText`, line by line for the
 * description and the YAML `get` shows; `pull` writes the YAML byte for byte
 * (data, not a message).
 */

import type { Command } from "commander";
import { requireClient } from "../context.js";
import { flowPath, getFlow, getFlowYaml, listFlows } from "../ops/flows.js";
import { emit, getIo, isJsonMode, printTable, terminalText } from "../output.js";
import { describePin } from "../pin.js";
import { writeOutputFile } from "./config.js";

export const NO_FLOWS_MESSAGE = "No flows.";
/** A text of several lines, each through `terminalText`, its newlines and tabs kept (YAML and Markdown indent with them). */
function terminalLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\t").map(terminalText).join("\t"))
    .join("\n");
}

/** A flow with no author is Telflo's own. */
const TELFLO = "Telflo";

/** `telflo flows list`. */
export async function flowsList(): Promise<void> {
  const rows = await listFlows(requireClient());
  emit(rows, () =>
    rows.length === 0
      ? NO_FLOWS_MESSAGE
      : printTable(
          rows.map((flow) => ({
            slug: flow.slug,
            name: flow.name,
            signals: flow.signals.join(","),
            collector: describePin(flow),
            by: flow.authorName ?? TELFLO,
          })),
          ["slug", "name", "signals", "collector", "by"],
        ),
  );
}

/** `telflo flows get <slug>`: the flow, its description and its YAML. */
export async function flowsGet(slug: string): Promise<void> {
  flowPath(slug); // A slug refused is exit 2 before the login is read.
  const flow = await getFlow(requireClient(), slug);
  emit(flow, () =>
    [
      `${terminalText(flow.name)} (${terminalText(flow.slug)})`,
      terminalText(flow.summary),
      terminalText(`signals: ${flow.signals.join(", ") || "-"}   tags: ${flow.tags.join(", ") || "-"}`),
      terminalText(`collector: ${describePin(flow)}   by: ${flow.authorName ?? TELFLO}`),
      ...(flow.sourceUrl === null ? [] : [`source: ${terminalText(flow.sourceUrl)}`]),
      "",
      terminalLines(flow.description.trim()),
      "",
      "--- yaml ---",
      terminalLines(flow.yaml.trimEnd()),
      "",
      terminalText(`Start from it: telflo flows pull ${flow.slug} -o config.yaml && telflo config create --name "${flow.name}" -f config.yaml`),
    ].join("\n"),
  );
}

/** `telflo flows pull <slug> [-o <file>]`: the YAML to stdout, a file, or the JSON. */
export async function flowsPull(slug: string, options: { out?: string }): Promise<void> {
  flowPath(slug); // A slug refused is exit 2 before the login is read.
  const flow = await getFlowYaml(requireClient(), slug);
  const pin = { distribution: flow.distribution, collectorVersion: flow.collectorVersion };
  if (options.out !== undefined) {
    const out = options.out;
    writeOutputFile(out, flow.yaml);
    emit({ slug: flow.slug, ...pin, out }, () => `Wrote ${terminalText(flow.slug)} to ${out} (validated on ${terminalText(describePin(pin))}).`);
  } else if (isJsonMode()) {
    emit({ slug: flow.slug, ...pin, yaml: flow.yaml }, () => "");
  } else {
    getIo().stdout(flow.yaml);
  }
}

export function registerFlowsCommands(program: Command): void {
  const flows = program.command("flows").description("Browse Telflo's prebuilt collector configurations (flows)");
  flows
    .command("list")
    .description("List the flows")
    .action(() => flowsList());
  flows
    .command("get")
    .description("Show a flow, its YAML included")
    .argument("<slug>", "the flow's slug")
    .action((slug: string) => flowsGet(slug));
  flows
    .command("pull")
    .description("Write a flow's YAML to stdout or a file")
    .argument("<slug>", "the flow's slug")
    .option("-o, --out <file>", "write the YAML to a file instead of stdout")
    .action((slug: string, options: { out?: string }) => flowsPull(slug, options));
}
