import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@telflo/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, createRoutesStub, useParams } from "react-router";
import routes from "../routes.js";
import FlowsGalleryRoute, { clientLoader, loader, meta, type FlowsGalleryData } from "./app.flows.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchFlows } from "~/lib/api-client.server.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { signedInMember } from "~/test/configurations.js";
import { HIDDEN, PII_REDACTION, TAIL_SAMPLING, makeFlow } from "~/test/flows.js";
import { metaArgs } from "~/test/meta.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchFlows: vi.fn() }));

/*
 * `/app/flows`, the gallery with its FlowPicker (D12 Preflight rulings 12
 * and 18).
 */

function FlowPage() {
  return (
    <>
      <p>the page of {useParams().slug}</p>
      <Link to="/app/flows">Back to the gallery</Link>
    </>
  );
}

/** The signed-in user, a product admin or not (D12 decision 3). */
function signIn({ productAdmin }: { productAdmin: boolean }) {
  useUserStore.getState().setCurrent({ ...signedInMember(), isProductAdmin: productAdmin });
}

/** The product admin's "Show hidden flows" switch (Ruling 42). */
function showHiddenSwitch() {
  return screen.queryByRole("switch", { name: "Show hidden flows" });
}

function renderGallery(flows: Flow[]) {
  const Stub = createRoutesStub([
    {
      path: "/app/flows",
      Component: FlowsGalleryRoute as unknown as React.ComponentType,
      loader: (): FlowsGalleryData => ({ status: "loaded", flows }),
      HydrateFallback: () => null,
    },
    { path: "/app/flows/:slug", Component: FlowPage },
  ]);
  render(<Stub initialEntries={["/app/flows"]} />);
  return { user: userEvent.setup() };
}

function loaderArgs(url = "http://localhost/app/flows"): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

function clientLoaderArgs(serverLoader: () => Promise<FlowsGalleryData>): Parameters<typeof clientLoader>[0] {
  return {
    request: new Request("http://localhost/app/flows"),
    params: {},
    context: {},
    serverLoader,
  } as unknown as Parameters<typeof clientLoader>[0];
}

async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("resolved instead of throwing");
    },
    (caught: unknown) => caught,
  );
}

/** The cards' names, in order. */
function shownNames(): string[] {
  return screen.queryAllByRole("heading", { level: 3 }).map((heading) => heading.textContent ?? "");
}

const COMMUNITY = makeFlow({
  id: "0199b000-0000-7000-8000-000000000004",
  slug: "community-logs",
  name: "Community Logs",
  summary: "Someone else's.",
  source: "community",
  signals: ["logs"],
  tags: ["shared"],
});

describe("the gallery's loaders (D12 Preflight rulings 5 and 18)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchFlows).mockReset();
  });

  it("is /app/flows under the signed-in layout, beside /app", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    expect(layout?.children?.find((route) => route.path === "app/flows")?.file).toBe("routes/app.flows.tsx");
  });

  it("reads the flows with the visitor's request, as the API lists them", async () => {
    vi.mocked(fetchFlows).mockResolvedValue({ status: "loaded", data: [TAIL_SAMPLING, HIDDEN] });
    const args = loaderArgs();

    await expect(loader(args)).resolves.toEqual({ status: "loaded", flows: [TAIL_SAMPLING, HIDDEN] });
    expect(fetchFlows).toHaveBeenCalledWith(args.request);
  });

  it("says a refresh is needed when the access token has expired", async () => {
    vi.mocked(fetchFlows).mockResolvedValue({ status: "refresh_needed" });

    await expect(loader(loaderArgs())).resolves.toEqual({ status: "refresh_needed" });
  });

  it("sends a session that is over to sign in, and back, as the layout does", async () => {
    vi.mocked(fetchFlows).mockResolvedValue({ status: "signed_out" });

    const thrown = await rejectionOf(loader(loaderArgs("http://localhost/app/flows?q=1")));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%2Fflows%3Fq%3D1");
  });

  it("lets a failure reach the error boundary", async () => {
    const outage = new ApiError("network_error", "Could not reach the API.");
    vi.mocked(fetchFlows).mockRejectedValue(outage);

    await expect(loader(loaderArgs())).rejects.toBe(outage);
  });

  it("runs its client loader on hydration, passing the server's flows through", async () => {
    const getFlows = vi.spyOn(apiClient, "getFlows");
    expect(clientLoader.hydrate).toBe(true);

    await expect(clientLoader(clientLoaderArgs(async () => ({ status: "loaded", flows: [TAIL_SAMPLING] })))).resolves.toEqual({
      status: "loaded",
      flows: [TAIL_SAMPLING],
    });
    expect(getFlows).not.toHaveBeenCalled();
  });

  it("reads through the browser client when a refresh is needed", async () => {
    vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [PII_REDACTION] });

    await expect(clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" })))).resolves.toEqual({
      status: "loaded",
      flows: [PII_REDACTION],
    });
  });

  it("sends the browser to sign in when the browser client finds the session over", async () => {
    vi.spyOn(apiClient, "getFlows").mockRejectedValue(new ApiError("unauthenticated", "Sign in."));
    window.history.replaceState(null, "", "/app/flows");

    const thrown = await rejectionOf(clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" }))));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%2Fflows");
  });
});

describe("the gallery's meta", () => {
  it("has the gallery's title and description, with the canonical link and og:url under the public URL", () => {
    const tags = meta(metaArgs<typeof meta>("https://telflo.example"));
    const description =
      "Ready-to-run OpenTelemetry Collector configurations for cost control, sampling, Kubernetes, PII redaction, and migration. Open any flow in Telflo's visual editor.";

    expect(tags).toEqual([
      { title: "Flows — prebuilt OpenTelemetry Collector configs - Telflo" },
      { name: "description", content: description },
      { property: "og:title", content: "Flows — prebuilt OpenTelemetry Collector configs" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://telflo.example/app/flows" },
      { tagName: "link", rel: "canonical", href: "https://telflo.example/app/flows" },
      { name: "twitter:card", content: "summary_large_image" },
    ]);
  });

  it("leaves the URLs out without TELFLO_PUBLIC_WEB_URL", () => {
    const tags = meta(metaArgs<typeof meta>(null));
    expect(tags.some((tag) => "rel" in tag || ("property" in tag && tag.property === "og:url"))).toBe(false);
  });
});

describe("the gallery (/app/flows)", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("shows the header and a card per flow, in the API's order, each opening the flow's page", async () => {
    const { user } = renderGallery([TAIL_SAMPLING, PII_REDACTION]);

    expect(await screen.findByRole("heading", { level: 1, name: "Flows" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Prebuilt collector configurations, each solving one problem. Researched against the component docs, validated with the real collector binary, and ready to open in the editor.",
      ),
    ).toBeInTheDocument();
    expect(shownNames()).toEqual([TAIL_SAMPLING.name, PII_REDACTION.name]);
    const card = screen.getByRole("heading", { level: 3, name: PII_REDACTION.name }).closest("[role=button]") as HTMLElement;
    expect(card).toHaveTextContent(PII_REDACTION.summary);
    expect(card).toHaveTextContent("Built by Telflo");
    expect(card).toHaveTextContent("logs");
    expect(card).toHaveTextContent("View");
    expect(card).not.toHaveAttribute("aria-pressed");

    await user.click(card);
    expect(await screen.findByText("the page of pii-redaction-gateway")).toBeInTheDocument();
  });

  it("opens a flow's page from the keyboard", async () => {
    const { user } = renderGallery([TAIL_SAMPLING]);
    const card = (await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name })).closest(
      "[role=button]",
    ) as HTMLElement;

    card.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("the page of tail-sampling-keep-errors")).toBeInTheDocument();
  });

  it("says No flows published yet. when there are none", async () => {
    renderGallery([]);
    expect(await screen.findByText("No flows published yet.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search flows…")).toBeNull();
  });

  describe("hidden flows and the product admin's switch (Ruling 42)", () => {
    it("has no Show hidden flows switch for a signed-in user who isn't a product admin, and lists published flows only", async () => {
      signIn({ productAdmin: false });
      // The API never lists a hidden flow to them; were one there, it would stay out.
      renderGallery([TAIL_SAMPLING, HIDDEN, PII_REDACTION]);

      await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });
      expect(shownNames()).toEqual([TAIL_SAMPLING.name, PII_REDACTION.name]);
      expect(showHiddenSwitch()).toBeNull();
      expect(screen.queryByText("Show hidden flows")).toBeNull();
    });

    it("gives a product admin the switch, off, and their gallery is everyone's: the hidden flows the API lists them are not shown", async () => {
      signIn({ productAdmin: true });
      renderGallery([TAIL_SAMPLING, HIDDEN, PII_REDACTION]);

      await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });
      const toggle = showHiddenSwitch();
      expect(toggle).not.toBeNull();
      expect(toggle).not.toBeChecked();
      expect(shownNames()).toEqual([TAIL_SAMPLING.name, PII_REDACTION.name]);
      // The switch's name is its static text, not an attribute holding flow text (ADR 0024).
      expect(toggle).not.toHaveAttribute("aria-label");
      expect(toggle).toHaveAttribute("aria-labelledby");
    });

    it("lists the hidden flows, in the API's order, once a product admin switches it on, and leaves them out again when switched off", async () => {
      signIn({ productAdmin: true });
      const { user } = renderGallery([TAIL_SAMPLING, HIDDEN, PII_REDACTION]);
      await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });

      await user.click(showHiddenSwitch()!);
      expect(showHiddenSwitch()).toBeChecked();
      expect(shownNames()).toEqual([TAIL_SAMPLING.name, HIDDEN.name, PII_REDACTION.name]);

      await user.click(showHiddenSwitch()!);
      expect(showHiddenSwitch()).not.toBeChecked();
      expect(shownNames()).toEqual([TAIL_SAMPLING.name, PII_REDACTION.name]);
    });

    it("switches from its visible label too, and keeps the search and filters as it switches", async () => {
      signIn({ productAdmin: true });
      const { user } = renderGallery([TAIL_SAMPLING, HIDDEN, PII_REDACTION]);
      const search = await screen.findByPlaceholderText("Search flows…");
      await user.type(search, "draft");
      expect(shownNames()).toEqual([]);

      await user.click(screen.getByText("Show hidden flows"));
      expect(showHiddenSwitch()).toBeChecked();
      expect(screen.getByPlaceholderText("Search flows…")).toHaveValue("draft");
      expect(shownNames()).toEqual([HIDDEN.name]);
    });

    it("is off again on the next visit to the gallery, and a hidden flow's card opens its page", async () => {
      signIn({ productAdmin: true });
      const { user } = renderGallery([TAIL_SAMPLING, HIDDEN]);
      await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });
      await user.click(showHiddenSwitch()!);

      await user.click(screen.getByRole("heading", { level: 3, name: HIDDEN.name }));
      expect(await screen.findByText("the page of hidden-draft-flow")).toBeInTheDocument();
      await user.click(screen.getByRole("link", { name: "Back to the gallery" }));

      await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });
      expect(showHiddenSwitch()).not.toBeChecked();
      expect(shownNames()).toEqual([TAIL_SAMPLING.name]);
    });

    it("says No flows published yet. to a product admin whose flows are all hidden, beside the switch that lists them", async () => {
      signIn({ productAdmin: true });
      const { user } = renderGallery([HIDDEN]);

      expect(await screen.findByText("No flows published yet.")).toBeInTheDocument();
      expect(shownNames()).toEqual([]);
      await user.click(showHiddenSwitch()!);

      expect(shownNames()).toEqual([HIDDEN.name]);
      expect(screen.queryByText("No flows published yet.")).toBeNull();
      expect(showHiddenSwitch()).toBeChecked();
    });
  });

  it("searches the names, summaries and tags, and says when nothing matches", async () => {
    const { user } = renderGallery([TAIL_SAMPLING, PII_REDACTION]);
    const search = await screen.findByPlaceholderText("Search flows…");

    await user.type(search, "PRIVACY");
    expect(shownNames()).toEqual([PII_REDACTION.name]);

    await user.clear(search);
    await user.type(search, "slow traces");
    expect(shownNames()).toEqual([TAIL_SAMPLING.name]);

    await user.clear(search);
    await user.type(search, "nothing like it");
    expect(shownNames()).toEqual([]);
    expect(screen.getByText("No flows match your search or filter.")).toBeInTheDocument();
  });

  it("filters by signal", async () => {
    const { user } = renderGallery([TAIL_SAMPLING, PII_REDACTION]);
    const signal = await screen.findByRole("combobox");
    expect(signal).toHaveTextContent("All signals");

    await user.click(signal);
    await user.click(await screen.findByRole("option", { name: "Logs" }));
    expect(shownNames()).toEqual([PII_REDACTION.name]);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Metrics" }));
    expect(shownNames()).toEqual([TAIL_SAMPLING.name]);
  });

  it("offers the source filter only once a community flow exists", async () => {
    const { user } = renderGallery([TAIL_SAMPLING, COMMUNITY]);
    const [, source] = await screen.findAllByRole("combobox");
    expect(source).toHaveTextContent("All sources");
    expect(
      within(screen.getByRole("heading", { level: 3, name: COMMUNITY.name }).closest("[role=button]") as HTMLElement).getByText(
        "Community",
      ),
    ).toBeInTheDocument();

    await user.click(source!);
    await user.click(await screen.findByRole("option", { name: "Community" }));
    expect(shownNames()).toEqual([COMMUNITY.name]);
    await user.click(screen.getAllByRole("combobox")[1]!);
    await user.click(await screen.findByRole("option", { name: "Built by Telflo" }));
    expect(shownNames()).toEqual([TAIL_SAMPLING.name]);
  });

  it("has no source filter without a community flow", async () => {
    renderGallery([TAIL_SAMPLING, PII_REDACTION]);
    expect(await screen.findAllByRole("combobox")).toHaveLength(1);
  });

  it("renders nothing of its own while a refresh is needed", async () => {
    const props = { loaderData: { status: "refresh_needed" } } as unknown as Parameters<typeof FlowsGalleryRoute>[0];
    // In a data router, which the current user's hook reads; the wrapper shows it rendered.
    const Stub = createRoutesStub([
      {
        path: "/app/flows",
        Component: () => (
          <section aria-label="the route">
            <FlowsGalleryRoute {...props} />
          </section>
        ),
      },
    ]);
    render(<Stub initialEntries={["/app/flows"]} />);
    expect(await screen.findByRole("region", { name: "the route" })).toBeEmptyDOMElement();
  });
});
