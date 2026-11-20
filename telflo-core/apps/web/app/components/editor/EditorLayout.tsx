import { PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs.js";
import { useResizablePanel } from "~/hooks/useResizablePanel.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/** The panel's drag bounds. */
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 800;
/** Smallest the centre may be squeezed to by the panel on its right. */
const MIN_CENTRE_WIDTH = 320;

/**
 * One tab of the right-hand panel. Its label names it in the tab list and,
 * as the icon button's label, in the collapsed rail: fixed text, never
 * private data.
 */
export type EditorPanelTab = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Rendered only while the tab is active (or always, with `keepMounted`), inside a flex column. */
  content: ReactNode;
  disabled?: boolean;
  /**
   * Kept mounted while another tab shows, hidden (the `hidden` attribute:
   * not displayed, not in the accessibility tree), so what it holds
   * survives a switch: its scroll, open sections, expanded cards and held
   * rows. The Configuration tab (`forceMount`).
   */
  keepMounted?: boolean;
};

type EditorLayoutProps = {
  /** Toolbar rendered above the centre and the panel */
  toolbar: ReactNode;
  /** The column left of the centre: the builder's toolbox */
  toolbox?: ReactNode;
  /** The centre: the canvas column */
  main: ReactNode;
  /** The panel's tabs, in order */
  panelTabs: readonly EditorPanelTab[];
  /** Dialog components rendered outside the layout */
  dialogs?: ReactNode;
};

/**
 * The editor's layout, composed: the page passes the toolbar, the toolbox,
 * the centre and the panel's tabs, and the tab list and the collapsed rail
 * are built from `panelTabs`. The columns are toolbox | canvas | panel.
 *
 * The active tab, the collapse and the width live in the editor's store, the
 * editor's shared memory. The active tab is the store's `activeTab` when it
 * names one of `panelTabs` that isn't disabled, else the first that isn't.
 * A disabled tab is never shown: when the store names one (or names none
 * and the first is disabled), the store is pointed at the tab shown, so the
 * panel stays there when the tab is enabled again (manual edit mode's
 * Configuration tab).
 *
 * A tab kept mounted (`keepMounted`) doesn't write its fields' held edits by
 * unmounting when another tab shows, so every held edit is written
 * (`flushHeldEdits`) before the tab changes (the store's `setActiveTab` does
 * it, for every caller), the panel collapses, or the rail expands it, once
 * each: the YAML tab never shows text missing an edit a field holds. A flush
 * that throws holds the change, as a click elsewhere that flushes does; the
 * field that threw is released, so the next click goes through.
 */
export function EditorLayout({ toolbar, toolbox, main, panelTabs, dialogs }: EditorLayoutProps) {
  const activeTab = useEditorStore((state) => state.activeTab);
  const setActiveTab = useEditorStore((state) => state.setActiveTab);
  const panelCollapsed = useEditorStore((state) => state.panelCollapsed);
  const setPanelCollapsed = useEditorStore((state) => state.setPanelCollapsed);
  const storedPanelWidth = useEditorStore((state) => state.panelWidth);
  const setStoredPanelWidth = useEditorStore((state) => state.setPanelWidth);

  const named = panelTabs.find((tab) => tab.id === activeTab);
  const firstEnabled = panelTabs.find((tab) => !tab.disabled) ?? panelTabs[0];
  const currentTab = named !== undefined && !named.disabled ? named.id : firstEnabled?.id;
  const fellBack = named !== undefined ? named.disabled === true : panelTabs[0]?.disabled === true;
  useEffect(() => {
    if (fellBack && currentTab !== undefined) setActiveTab(currentTab);
  }, [fellBack, currentTab, setActiveTab]);

  // Measure the centre column's live left edge so the panel's max drag width
  // accounts for everything to its left (the sidebar), keeping the centre at
  // least MIN_CENTRE_WIDTH wide.
  const centreColRef = useRef<HTMLDivElement>(null);

  const { panelWidth, isResizing, startResizing } = useResizablePanel(
    storedPanelWidth,
    setStoredPanelWidth,
    MIN_PANEL_WIDTH,
    MAX_PANEL_WIDTH,
    MIN_CENTRE_WIDTH,
    centreColRef,
  );

  return (
    <div className="flex flex-col h-screen bg-gray-100 dark:bg-gray-900">
      {toolbar}

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        {toolbox}

        {/* Center - Canvas */}
        <div
          ref={centreColRef}
          className="@container flex-1 flex flex-col relative min-w-0"
          data-tour-step="canvas"
        >
          {main}
        </div>

        {/* Right Panel */}
        <div
          data-tour-step="editor-right-panel"
          className={`bg-card border-l border-border flex flex-col relative shrink-0 ${
            isResizing ? "" : "transition-all duration-300"
          } ${panelCollapsed ? "w-11" : ""}`}
          style={panelCollapsed ? undefined : { width: `${panelWidth}px` }}
        >
          {panelCollapsed ? (
            <CollapsedRightPanel
              panelTabs={panelTabs}
              currentTab={currentTab}
              onExpand={(tab) => {
                // A tab switch writes held edits itself (the store's setActiveTab); otherwise write them here, once.
                if (tab !== undefined && tab !== activeTab) setActiveTab(tab);
                else flushHeldEdits();
                setPanelCollapsed(false);
              }}
            />
          ) : (
            <>
              {/* Resize Handle */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1 z-10 cursor-col-resize hover:bg-brand/70 transition-colors group"
                onMouseDown={startResizing}
              >
                <div className="absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] bg-border transition-colors group-hover:bg-brand" />
              </div>

              <Tabs
                value={currentTab ?? ""}
                className="flex-1 flex flex-col overflow-hidden"
                onValueChange={(value) => {
                  // The store writes every held edit first.
                  setActiveTab(value);
                }}
              >
                <div className="flex items-center border-b border-border" data-tour-step="right-panel">
                  <TabsList className="flex-1 rounded-none border-b-0">
                    {panelTabs.map((tab) => (
                      <TabsTrigger key={tab.id} value={tab.id} className="flex-1" disabled={tab.disabled}>
                        {tab.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <button
                    onClick={() => {
                      flushHeldEdits();
                      setPanelCollapsed(true);
                    }}
                    className="p-1.5 mr-1.5 rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    aria-label="Collapse panel"
                    title="Collapse panel"
                  >
                    <PanelRightClose className="w-3.5 h-3.5" />
                  </button>
                </div>

                {panelTabs.map((tab) => (
                  <TabsContent
                    key={tab.id}
                    value={tab.id}
                    className="flex-1 m-0 flex flex-col overflow-hidden"
                    {...(tab.keepMounted ? { forceMount: true, hidden: currentTab !== tab.id } : {})}
                  >
                    {tab.content}
                  </TabsContent>
                ))}
              </Tabs>
            </>
          )}
        </div>
      </div>

      {dialogs}
    </div>
  );
}

/** Collapsed right panel with icon buttons, one per tab */
function CollapsedRightPanel({
  panelTabs,
  currentTab,
  onExpand,
}: {
  panelTabs: readonly EditorPanelTab[];
  currentTab: string | undefined;
  onExpand: (tab?: string) => void;
}) {
  const iconBtnClass = (tab: string) =>
    `p-1.5 rounded-[5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
      currentTab === tab
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    }`;

  return (
    <div className="flex flex-col items-center py-2 gap-1">
      <button
        onClick={() => onExpand()}
        className="p-1.5 rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        aria-label="Expand panel"
        title="Expand panel"
      >
        <PanelRightOpen className="w-4 h-4" />
      </button>
      <div className="h-px w-5 bg-border my-1" />
      {panelTabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            onClick={() => onExpand(tab.id)}
            className={iconBtnClass(tab.id)}
            disabled={tab.disabled}
            aria-label={tab.label}
            title={tab.label}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}
