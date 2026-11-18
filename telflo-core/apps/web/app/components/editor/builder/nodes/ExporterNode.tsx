import type { NodeProps } from "@xyflow/react";

import { componentIcon } from "../component-icons.js";
import { NodeCard } from "./NodeCard.js";
import { useSharedCount } from "~/hooks/useSharedCount.js";
import type { OTelNode } from "~/lib/graph/types.js";

/** An exporter's node: an incoming port only; its icon from the one map (D9a decision 8). */
export function ExporterNode({ data, selected, isConnectable }: NodeProps<OTelNode>) {
  const sharedCount = useSharedCount(data.sharedConfigId);
  return (
    <NodeCard
      accent="exporter"
      icon={componentIcon("exporter", data.componentSubType)}
      title={data.label}
      subtitle={data.componentSubType}
      selected={selected}
      connectable={isConnectable}
      targetHandle
      sharedCount={sharedCount}
    />
  );
}
