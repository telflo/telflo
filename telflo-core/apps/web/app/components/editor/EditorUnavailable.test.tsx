import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { createRoutesStub, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { EditorUnavailable } from "./EditorUnavailable.js";

function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

const CONFIGURATION_ID = "0199a000-0000-7000-8000-000000000001";

function renderUnavailable(props: ComponentProps<typeof EditorUnavailable>) {
  const Stub = createRoutesStub([
    { path: "/editor/:configurationId/:versionId?", Component: () => <EditorUnavailable {...props} /> },
    { path: "/app", Component: Landed },
    { path: `/editor/${CONFIGURATION_ID}`, Component: Landed },
  ]);
  render(<Stub initialEntries={["/editor/gone/gone"]} />);
  return userEvent.setup();
}

describe("EditorUnavailable", () => {
  it('says "Configuration not found" and links back to /app, with no "Try again"', async () => {
    const user = renderUnavailable({ reason: "not_found" });

    expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load configuration")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open the latest version" })).toBeNull();
    const back = screen.getByRole("link", { name: "Back to configurations" });
    expect(back).toHaveAttribute("href", "/app");

    await user.click(back);
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
  });

  it('says "Version not found" with "Open the latest version" linking to /editor/{id}, and the link back', async () => {
    const user = renderUnavailable({ reason: "version_not_found", configurationId: CONFIGURATION_ID });

    expect(await screen.findByText("Version not found")).toBeInTheDocument();
    expect(screen.queryByText("Configuration not found")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to configurations" })).toHaveAttribute("href", "/app");
    const latest = screen.getByRole("link", { name: "Open the latest version" });
    expect(latest).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}`);

    await user.click(latest);
    expect(await screen.findByText(`landed on /editor/${CONFIGURATION_ID}`)).toBeInTheDocument();
  });

  it('says "Failed to load configuration" for a failed load, with "Try again" and the link back', async () => {
    const onRetry = vi.fn();
    const user = renderUnavailable({ reason: "failed", onRetry });

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Failed to load configuration")).toBeInTheDocument();
    expect(screen.queryByText("Configuration not found")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to configurations" })).toHaveAttribute("href", "/app");
  });
});
