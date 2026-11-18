import { create } from "zustand";

type UiState = {
  /** Whether the sidebar is collapsed to its icon rail. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

/**
 * Client-only UI chrome, with no AI-panel state (ADR 0007). Deliberately
 * not persisted: the collapse flags stay out of localStorage, because a
 * persisted collapsed rail would hydrate into markup the server rendered
 * expanded.
 */
export const useUiStateStore = create<UiState>()((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
