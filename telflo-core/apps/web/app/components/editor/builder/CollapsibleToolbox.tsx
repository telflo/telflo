import { Boxes, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";

import { ComponentPalette } from "./ComponentPalette.js";

/*
 * The collapsible toolbox (D9a decision 10): 240 px, collapsing to a 44 px
 * rail whose two buttons both expand it. The collapse isn't remembered.
 * There is no distribution allowlist override here, and the palette reads the
 * open version's distribution itself (D13a decision 6), so it sits here
 * directly.
 */
export function CollapsibleToolbox() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      data-tour-step="toolbox"
      className={`bg-card border-r border-border flex flex-col transition-all duration-200 ${collapsed ? "w-11" : "w-60"}`}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 py-2">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="rounded-[5px] p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Expand panel"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <div className="h-px w-5 bg-border" />
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="rounded-[5px] p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Components"
          >
            <Boxes className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex h-9 items-center justify-between border-b border-border pl-3 pr-1.5">
            <span className="tf-label">Components</span>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Collapse panel"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-hidden">
            <ComponentPalette />
          </div>
        </div>
      )}
    </div>
  );
}
