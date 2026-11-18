import { GROUP_ID, MINE, versionFixture } from "./configurations.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The editor store with a configuration open, for the builder's component
 * tests: the text loaded as a version without a stored graph, so the store
 * parses and lays it out as it would on opening.
 */

export const BUILDER_VERSION_ID = "0199c000-0000-7000-8000-000000000001";

export const builderStore = () => useEditorStore.getState();

/** Opens `yamlContent` in the editor store, as a load does. */
export function openText(yamlContent: string, id = BUILDER_VERSION_ID): void {
  const version = versionFixture({ id, yamlContent });
  builderStore().load({ organizationId: GROUP_ID, configuration: MINE, version });
}

/** The group of the pipeline named `name`. */
export function groupNamed(name: string): OTelNode {
  const found = builderStore().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === name);
  if (!found) throw new Error(`no group ${name}`);
  return found;
}

/** The components in a group, by their keys in the text. */
export function componentsIn(group: OTelNode): string[] {
  return builderStore()
    .graph.nodes.filter((n) => n.parentId === group.id)
    .map((n) => componentKey(n.data) ?? "")
    .sort();
}

/** A component node, by its key in the text and, when it is in several, its pipeline's name. */
export function componentNamed(key: string, pipeline?: string): OTelNode {
  const { nodes } = builderStore().graph;
  const found = nodes.find(
    (n) =>
      n.type !== "pipelineGroup" &&
      componentKey(n.data) === key &&
      (pipeline === undefined || nodes.find((g) => g.id === n.parentId)?.data.label === pipeline),
  );
  if (!found) throw new Error(`no component ${key}`);
  return found;
}
