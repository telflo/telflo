import { useEditorStore } from "~/lib/stores/editor-store.js";

/**
 * How many nodes share `sharedConfigId`: one component linked into several
 * pipelines, for the node card's "N pipelines" line (it counts nodes).
 */
export function useSharedCount(sharedConfigId: string | undefined): number {
  return useEditorStore((state) =>
    sharedConfigId
      ? state.graph.nodes.filter((n) => n.type !== "pipelineGroup" && n.data.sharedConfigId === sharedConfigId).length
      : 0,
  );
}
