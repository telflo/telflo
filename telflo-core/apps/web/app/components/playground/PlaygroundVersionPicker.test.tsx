import { createRoutesStub } from "react-router";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectorDistributionsResponseSchema } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { SCHEMA_CATALOGUE } from "~/lib/editor/collector-schema.js";
import { PLAYGROUND_CATALOGUE } from "~/lib/playground/catalogue.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { resetCollectorCatalogue, useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { MINE, versionFixture } from "~/test/configurations.js";
import { OTHER_VERSION_LOCKED_ACTION, PlaygroundVersionPicker } from "./PlaygroundVersionPicker.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "./SignupPromptDialog.js";

/*
 * The fixed picker and the catalogue the web was built with (D31-1
 * decision 11, Q210, Ruling 277, Preflight ruling 20): the pin shows; the
 * build-time catalogue's offered versions are listed, the same ones the
 * schemas cover; a pick of another opens the sign-up prompt and changes
 * nothing. Inside the playground no catalogue request is made.
 */

const initial = useEditorStore.getState();

function renderPicker() {
  const Stub = createRoutesStub([
    {
      path: "/playground/editor",
      Component: () => (
        <PlaygroundProvider>
          <PlaygroundVersionPicker />
        </PlaygroundProvider>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/playground/editor"]} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initial, true);
  resetCollectorCatalogue();
  act(() =>
    useEditorStore.getState().load({
      organizationId: SAMPLE_ORGANIZATION_ID,
      configuration: MINE,
      version: versionFixture({ yamlContent: "receivers: {}\n", collectorVersion: "0.161.0" }),
    }),
  );
});
afterEach(() => {
  useEditorStore.setState(initial, true);
  resetCollectorCatalogue();
});

describe("the build-time catalogue", () => {
  it("is the API's shape, its deprecated versions left out: exactly the versions the schemas cover", () => {
    expect(CollectorDistributionsResponseSchema.parse({ distributions: PLAYGROUND_CATALOGUE })).toBeTruthy();
    const contrib = PLAYGROUND_CATALOGUE.find((distribution) => distribution.id === "otelcol-contrib")!;
    const schemaOffered = SCHEMA_CATALOGUE["otelcol-contrib"]!.filter((entry) => !entry.deprecated).map((entry) => entry.version);
    expect(contrib.versions.map((offer) => offer.version)).toEqual(schemaOffered);
    expect(contrib.versions.map((offer) => offer.version)).toEqual(["0.162.0", "0.161.0", "0.160.0", "0.159.0"]);
    expect(contrib.versions.filter((offer) => offer.isDefault).map((offer) => offer.version)).toEqual(["0.162.0"]);
  });

  it("is what useCollectorDistributions answers inside the playground, with no catalogue request", async () => {
    const read = vi.spyOn(apiClient, "getCollectorDistributions");
    const Inside = () => {
      const { distributions } = useCollectorDistributions();
      return <p data-testid="inside">{String(distributions === PLAYGROUND_CATALOGUE)}</p>;
    };
    const Page = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <PlaygroundProvider>
            <Inside />
          </PlaygroundProvider>
        ),
      },
    ]);
    render(<Page initialEntries={["/"]} />);
    expect(await screen.findByTestId("inside")).toHaveTextContent("true");
    expect(read).not.toHaveBeenCalled();
  });

  it("outside the playground, the hook reads the API's catalogue as before", async () => {
    const read = vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: [] });
    renderHook(() => useCollectorDistributions());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });
});

describe("the fixed picker", () => {
  it("shows the pin and the distribution, locked, and lists the offered versions", async () => {
    const user = userEvent.setup();
    renderPicker();
    expect(screen.getByRole("img", { name: /^Distribution: .* \(locked at creation\)$/ })).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Collector version v0.161.0" });
    await user.click(picker);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.replace(/Default$/, "").trim().slice(0, 8))).toEqual([
      "v0.162.0",
      "v0.161.0",
      "v0.160.0",
      "v0.159.0",
    ]);
  });

  it("opens the sign-up prompt on a pick of another version, and keeps the pin", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("combobox", { name: "Collector version v0.161.0" }));
    await user.click(await screen.findByRole("option", { name: /v0\.160\.0/ }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(OTHER_VERSION_LOCKED_ACTION))).toBeInTheDocument();
    expect(useEditorStore.getState().collectorVersion).toBe("0.161.0");
  });

  it("opens the prompt once the list has closed, and its close gives the focus back to the picker (Ruling 299)", async () => {
    const user = userEvent.setup();
    renderPicker();
    const picker = screen.getByRole("combobox", { name: "Collector version v0.161.0" });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /v0\.160\.0/ }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: SIGNUP_PROMPT_TITLE })).toBeNull());
    expect(picker).toHaveFocus();
  });
});
