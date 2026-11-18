import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { EmptyFleets } from "./EmptyFleets.js";

// The fleet list's first-run card (D17a decision 23).

describe("EmptyFleets", () => {
  it("teaches the three-step journey and renders the supplied action", () => {
    render(
      <MemoryRouter>
        <EmptyFleets action={<button type="button">New Fleet</button>} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Create your first fleet" })).toBeInTheDocument();
    expect(screen.getByText("Manage every OpenTelemetry Collector you run from one place.")).toBeInTheDocument();
    expect(screen.getByText("Build and publish a configuration")).toBeInTheDocument();
    // A published version before installing (D17c-1 Preflight ruling 22): its collector version picks what to install.
    expect(screen.getAllByRole("listitem").map((step) => step.querySelector("p")?.textContent)).toEqual([
      "Build and publish a configuration",
      "Create a fleet and assign a published version",
      "Install collectors and roll out changes",
    ]);
    expect(screen.getByRole("button", { name: "New Fleet" })).toBeInTheDocument();
  });

  it("links the editor to the configurations list, /app", () => {
    render(
      <MemoryRouter>
        <EmptyFleets />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "editor" })).toHaveAttribute("href", "/app");
  });

  it('says "group" and "served", never "deploy group" or "deployed" (decision 6)', () => {
    const { container } = render(
      <MemoryRouter>
        <EmptyFleets />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent("only published versions can be served.");
    expect(container).toHaveTextContent("Each group in a fleet ties a published version to its collectors;");
    expect(container.textContent).not.toMatch(/deploy/i);
  });
});
