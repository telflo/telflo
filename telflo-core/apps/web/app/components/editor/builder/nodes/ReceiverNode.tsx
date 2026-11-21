import type { NodeProps } from "@xyflow/react";

import { componentIcon } from "../component-icons.js";
import { NodeCard } from "./NodeCard.js";
import { useSharedCount } from "~/hooks/useSharedCount.js";
import type { OTelNode } from "~/lib/graph/types.js";

/** A receiver's node: an outgoing port only; its icon from the one map. */
export function ReceiverNode({ data, selected, isConnectable }: NodeProps<OTelNode>) {
  const sharedCount = useSharedCount(data.sharedConfigId);
  return (
    <NodeCard
      accent="receiver"
      icon={componentIcon("receiver", data.componentSubType)}
      title={data.label}
      subtitle={data.componentSubType}
      selected={selected}
      connectable={isConnectable}
      sourceHandle
      sharedCount={sharedCount}
    />
  );
}
