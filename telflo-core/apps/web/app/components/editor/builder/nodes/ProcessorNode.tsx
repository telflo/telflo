import type { NodeProps } from "@xyflow/react";

import { componentIcon } from "../component-icons.js";
import { NodeCard } from "./NodeCard.js";
import { useSharedCount } from "~/hooks/useSharedCount.js";
import type { OTelNode } from "~/lib/graph/types.js";

/** A processor's node: both ports; its icon from the one map. */
export function ProcessorNode({ data, selected, isConnectable }: NodeProps<OTelNode>) {
  const sharedCount = useSharedCount(data.sharedConfigId);
  return (
    <NodeCard
      accent="processor"
      icon={componentIcon("processor", data.componentSubType)}
      title={data.label}
      subtitle={data.componentSubType}
      selected={selected}
      connectable={isConnectable}
      targetHandle
      sourceHandle
      sharedCount={sharedCount}
    />
  );
}
