import type { NodeProps } from "@xyflow/react";

import { componentIcon } from "../component-icons.js";
import { NodeCard } from "./NodeCard.js";
import type { OTelNode } from "~/lib/graph/types.js";

/** The connectors that pass a signal on as it is, whichever it is. */
const SAME_SIGNAL = new Set(["forward", "routing", "failover"]);
/** The connectors that name their targets in config: their outgoing port only anchors route edges. */
const CONFIG_TARGETED = new Set(["routing", "failover"]);

/**
 * A connector's node: both ports; the subtitle is its signals
 * ("traces → metrics") or "(same signal)" for the signal-agnostic ones.
 */
export function ConnectorNode({ data, selected, isConnectable }: NodeProps<OTelNode>) {
  const subType = data.componentSubType;
  const inputSignal = data.connectorSignals?.inputSignal ?? "traces";
  const outputSignal = data.connectorSignals?.outputSignal ?? "metrics";
  return (
    <NodeCard
      accent="connector"
      icon={componentIcon("connector", subType)}
      title={data.label}
      subtitle={SAME_SIGNAL.has(subType) ? `${subType} (same signal)` : `${inputSignal} → ${outputSignal}`}
      selected={selected}
      connectable={isConnectable}
      targetHandle
      sourceHandle
      sourceHandleStatic={CONFIG_TARGETED.has(subType)}
    />
  );
}
