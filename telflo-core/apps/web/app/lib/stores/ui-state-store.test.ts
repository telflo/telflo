import { beforeEach, describe, expect, it } from "vitest";
import { useUiStateStore } from "./ui-state-store.js";

beforeEach(() => {
  useUiStateStore.setState({ sidebarCollapsed: false });
  window.localStorage.clear();
});

describe("useUiStateStore", () => {
  it("starts expanded and toggles the sidebar both ways", () => {
    expect(useUiStateStore.getState().sidebarCollapsed).toBe(false);

    useUiStateStore.getState().toggleSidebar();
    expect(useUiStateStore.getState().sidebarCollapsed).toBe(true);

    useUiStateStore.getState().toggleSidebar();
    expect(useUiStateStore.getState().sidebarCollapsed).toBe(false);
  });

  it("does not persist the collapsed state", () => {
    // The panel flags stay out of persisted storage: a persisted collapsed
    // rail would hydrate into markup the server rendered expanded.
    useUiStateStore.getState().toggleSidebar();

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(useUiStateStore).not.toHaveProperty("persist");
  });
});
