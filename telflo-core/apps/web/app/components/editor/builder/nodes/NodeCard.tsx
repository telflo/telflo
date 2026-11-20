import { Handle, Position } from "@xyflow/react";
import { Link2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { nodeAccentVar, type ComponentIcon } from "../component-icons.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { cn } from "~/lib/utils.js";

/*
 * The node card: the quiet card every component node
 * shares. A neutral card with a hairline border; the component's type reads
 * through a 3 px left rail, a tinted 24 px icon chip and the handle rings,
 * all in the type's colour (`--color-node-*`); selection is a ring in the
 * same hue.
 *
 * The title and subtitle are text (masked by the app shell's replay
 * masking); nothing a person wrote goes into an attribute.
 */

const handleClass = "!w-2.5 !h-2.5 !rounded-full !border-2 !bg-card transition-transform hover:!scale-125";

/** An anchor-only port: edges attach, but no connection can be dragged from it (routing, failover). */
const staticHandleClass = "!w-2.5 !h-2.5 !rounded-full !border-2 !bg-card !cursor-default opacity-60";

interface NodeCardProps {
  accent: ComponentType;
  icon: ComponentIcon;
  title: string;
  /** The mono caption under the title: the component's type, or a connector's signals. */
  subtitle: ReactNode;
  selected?: boolean;
  /** The incoming (left) and outgoing (right) ports. */
  targetHandle?: boolean;
  sourceHandle?: boolean;
  /** The outgoing port only anchors derived edges; it can't be dragged from. */
  sourceHandleStatic?: boolean;
  /**
   * Whether connections can be drawn from and to the ports: React Flow's
   * `isConnectable` for the node, false in manual edit mode, so its ports
   * aren't live under the lock.
   */
  connectable?: boolean;
  /** How many nodes share the component; the "N pipelines" line shows above one. */
  sharedCount?: number;
  className?: string;
}

export function NodeCard({
  accent,
  icon: Icon,
  title,
  subtitle,
  selected,
  targetHandle,
  sourceHandle,
  sourceHandleStatic,
  connectable = true,
  sharedCount = 0,
  className,
}: NodeCardProps) {
  const accentColor = nodeAccentVar[accent];

  return (
    <div
      className={cn(
        "relative min-w-[200px] rounded-lg border bg-card px-3.5 py-2.5",
        selected ? "ring-2" : "border-border hover:border-gray-300 dark:hover:border-gray-600",
        className,
      )}
      style={
        selected
          ? ({
              borderColor: accentColor,
              "--tw-ring-color": `color-mix(in srgb, ${accentColor} 30%, transparent)`,
            } as CSSProperties)
          : undefined
      }
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] rounded-l-[7px]" style={{ background: accentColor }} />
      {targetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={connectable}
          className={handleClass}
          style={{ borderColor: accentColor }}
        />
      )}
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px]"
          style={{ background: `color-mix(in srgb, ${accentColor} 12%, transparent)`, color: accentColor }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="truncate text-[13px] font-semibold leading-5 text-foreground">{title}</div>
          <div className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{subtitle}</div>
        </div>
      </div>
      {sharedCount > 1 && (
        <div className="mt-1 flex items-center gap-1 pl-[34px] font-mono text-[11px] text-muted-foreground">
          <Link2 className="h-3 w-3" />
          <span>{sharedCount} pipelines</span>
        </div>
      )}
      {sourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={connectable && !sourceHandleStatic}
          className={sourceHandleStatic ? staticHandleClass : handleClass}
          style={{ borderColor: accentColor }}
        />
      )}
    </div>
  );
}
