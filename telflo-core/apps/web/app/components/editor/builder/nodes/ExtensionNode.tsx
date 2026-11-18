import type { NodeProps } from "@xyflow/react";

import { componentIcon } from "../component-icons.js";
import { NodeCard } from "./NodeCard.js";
import type { OTelNode } from "~/lib/graph/types.js";

/**
 * An extension's node: no ports, and a dashed border, marking the
 * one kind of block that never connects.
 */
export function ExtensionNode({ data, selected }: NodeProps<OTelNode>) {
  return (
    <NodeCard
      accent="extension"
      icon={componentIcon("extension", data.componentSubType)}
      title={data.label}
      subtitle={data.componentSubType}
      selected={selected}
      className="min-w-[160px] border-dashed"
    />
  );
}
