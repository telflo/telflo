import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import routes from "../routes.js";
import FlowDetailRoute, {
  FLOW_VARIABLE_DEFINED,
  FLOW_VARIABLE_NOT_DEFINED,
  clientLoader,
  loader,
  meta,
  type FlowPageData,
} from "./app.flows.$slug.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchFlow } from "~/lib/api-client.server.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { CATALOGUE } from "~/test/collector-distributions.js";
import { MINE, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { TAIL_SAMPLING, makeFlow } from "~/test/flows.js";
import { metaArgs } from "~/test/meta.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchFlow: vi.fn() }));

/*
 * `/app/flows/:slug`: the flow's own distribution and version (on Contrib
 * 0.162.0; no ClickStack coercion), the JSON-LD, the canonical link, "Before
 * you use this", the paragraphs, the 404, the loaders.
 */

function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/** The page, its loader answering `flow`, with the member signed in (the layout seeds the store), unless `seeded` is false. */
function renderPage(flow: Flow = TAIL_SAMPLING, { seeded = true }: { seeded?: boolean } = {}) {
  if (seeded) useUserStore.getState().setCurrent(signedInMember());
  const Stub = createRoutesStub([
    {
      path: "/app/flows/:slug",
      Component: FlowDetailRoute as unknown as React.ComponentType,
      loader: (): FlowPageData => ({ status: "loaded", flow }),
      HydrateFallback: () => null,
    },
    { path: "/app/flows", Component: () => <p>the gallery</p> },
    { path: "/editor/:configurationId", Component: Landed },
  ]);
  render(<Stub initialEntries={[`/app/flows/${flow.slug}`]} />);
  return { user: userEvent.setup() };
}

function loaderArgs(slug: string, url = `http://localhost/app/flows/${slug}`): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: { slug }, context: {} } as unknown as Parameters<typeof loader>[0];
}

function clientLoaderArgs(slug: string, serverLoader: () => Promise<FlowPageData>): Parameters<typeof clientLoader>[0] {
  return {
    request: new Request(`http://localhost/app/flows/${slug}`),
    params: { slug },
    context: {},
    serverLoader,
  } as unknown as Parameters<typeof clientLoader>[0];
}

/** What `run` threw, or a failure if it resolved. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("resolved instead of throwing");
    },
    (caught: unknown) => caught,
  );
}

function metaFor(flow: Flow | undefined, publicWebUrl: string | null, status: FlowPageData["status"] = "loaded") {
  const loaderData: FlowPageData | undefined =
    flow === undefined ? undefined : status === "loaded" ? { status, flow } : { status };
  return meta({ ...metaArgs<typeof meta>(publicWebUrl), loaderData } as unknown as Parameters<typeof meta>[0]);
}

function jsonLd(tags: ReturnType<typeof meta>): unknown {
  return (tags.find((tag) => "script:ld+json" in tag) as { "script:ld+json": unknown } | undefined)?.[
    "script:ld+json"
  ];
}

describe("the flow page's loaders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchFlow).mockReset();
  });

  it("is /app/flows/:slug under the signed-in layout, beside /app", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    expect(layout?.children?.find((route) => route.path === "app/flows/:slug")?.file).toBe(
      "routes/app.flows.$slug.tsx",
    );
  });

  it("reads the flow with the visitor's request, and returns it", async () => {
    vi.mocked(fetchFlow).mockResolvedValue({ status: "loaded", data: TAIL_SAMPLING });
    const args = loaderArgs(TAIL_SAMPLING.slug);

    await expect(loader(args)).resolves.toEqual({ status: "loaded", flow: TAIL_SAMPLING });
    expect(fetchFlow).toHaveBeenCalledWith(args.request, TAIL_SAMPLING.slug);
  });

  it("is a 404 for a flow the visitor may not see (none by that slug, or a hidden one)", async () => {
    vi.mocked(fetchFlow).mockRejectedValue(new ApiError("flow_not_found", "Flow not found"));

    const thrown = await rejectionOf(loader(loaderArgs("hidden-draft-flow")));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(404);
  });

  it("says a refresh is needed when the access token has expired", async () => {
    vi.mocked(fetchFlow).mockResolvedValue({ status: "refresh_needed" });

    await expect(loader(loaderArgs(TAIL_SAMPLING.slug))).resolves.toEqual({ status: "refresh_needed" });
  });

  it("sends a session that is over to sign in, and back, as the layout does", async () => {
    vi.mocked(fetchFlow).mockResolvedValue({ status: "signed_out" });

    const thrown = await rejectionOf(loader(loaderArgs("pii-redaction-gateway", "http://localhost/app/flows/pii-redaction-gateway?x=1")));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%2Fflows%2Fpii-redaction-gateway%3Fx%3D1");
  });

  it("lets any other failure reach the error boundary", async () => {
    const outage = new ApiError("network_error", "Could not reach the API.");
    vi.mocked(fetchFlow).mockRejectedValue(outage);

    await expect(loader(loaderArgs(TAIL_SAMPLING.slug))).rejects.toBe(outage);
  });

  it("runs its client loader on hydration", () => {
    expect(clientLoader.hydrate).toBe(true);
  });

  it("passes the server's flow through without asking the browser client", async () => {
    const getFlow = vi.spyOn(apiClient, "getFlow");

    await expect(
      clientLoader(clientLoaderArgs(TAIL_SAMPLING.slug, async () => ({ status: "loaded", flow: TAIL_SAMPLING }))),
    ).resolves.toEqual({ status: "loaded", flow: TAIL_SAMPLING });
    expect(getFlow).not.toHaveBeenCalled();
  });

  it("reads the flow through the browser client when a refresh is needed", async () => {
    const getFlow = vi.spyOn(apiClient, "getFlow").mockResolvedValue({ flow: TAIL_SAMPLING });

    await expect(
      clientLoader(clientLoaderArgs(TAIL_SAMPLING.slug, async () => ({ status: "refresh_needed" }))),
    ).resolves.toEqual({ status: "loaded", flow: TAIL_SAMPLING });
    expect(getFlow).toHaveBeenCalledWith(TAIL_SAMPLING.slug);
  });

  it("is a 404 when the browser client's read finds no flow it may see", async () => {
    vi.spyOn(apiClient, "getFlow").mockRejectedValue(new ApiError("flow_not_found", "Flow not found"));

    const thrown = await rejectionOf(clientLoader(clientLoaderArgs("gone", async () => ({ status: "refresh_needed" }))));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(404);
  });

  it("sends the browser to sign in, and back to this page, when the session is over", async () => {
    vi.spyOn(apiClient, "getFlow").mockRejectedValue(new ApiError("unauthenticated", "Sign in."));
    window.history.replaceState(null, "", "/app/flows/tail-sampling-keep-errors?x=1");

    const thrown = await rejectionOf(
      clientLoader(clientLoaderArgs(TAIL_SAMPLING.slug, async () => ({ status: "refresh_needed" }))),
    );

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%2Fflows%2Ftail-sampling-keep-errors%3Fx%3D1");
  });

  it("lets the browser client's other failures reach the error boundary", async () => {
    const outage = new ApiError("network_error", "Could not reach the server. Check your connection.");
    vi.spyOn(apiClient, "getFlow").mockRejectedValue(outage);

    await expect(
      clientLoader(clientLoaderArgs(TAIL_SAMPLING.slug, async () => ({ status: "refresh_needed" }))),
    ).rejects.toBe(outage);
  });
});

describe("the flow page's meta", () => {
  it("has the flow's title and description, with the canonical link and og:url under the public URL", () => {
    const tags = metaFor(TAIL_SAMPLING, "https://telflo.example");
    const url = "https://telflo.example/app/flows/tail-sampling-keep-errors";

    expect(tags).toEqual(
      expect.arrayContaining([
        { title: "Tail Sampling: Keep Every Error - Telflo Flows" },
        { name: "description", content: TAIL_SAMPLING.summary },
        { property: "og:title", content: TAIL_SAMPLING.name },
        { property: "og:description", content: TAIL_SAMPLING.summary },
        { property: "og:type", content: "article" },
        { property: "og:url", content: url },
        { tagName: "link", rel: "canonical", href: url },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: TAIL_SAMPLING.name },
        { name: "twitter:description", content: TAIL_SAMPLING.summary },
      ]),
    );
  });

  it("has the TechArticle JSON-LD, its URL and publisher logo under the public URL", () => {
    expect(jsonLd(metaFor(makeFlow({ authorName: "ClickStack" }), "https://telflo.example"))).toEqual({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: TAIL_SAMPLING.name,
      description: TAIL_SAMPLING.summary,
      url: "https://telflo.example/app/flows/tail-sampling-keep-errors",
      author: { "@type": "Person", name: "ClickStack" },
      publisher: {
        "@type": "Organization",
        name: "Telflo",
        logo: { "@type": "ImageObject", url: "https://telflo.example/telflo-logo-full.svg" },
      },
    });
  });

  it("leaves out every URL without TELFLO_PUBLIC_WEB_URL, and the author when the flow has none", () => {
    const tags = metaFor(TAIL_SAMPLING, null);

    expect(tags.find((tag) => "property" in tag && tag.property === "og:url")).toBeUndefined();
    expect(tags.find((tag) => "rel" in tag && tag.rel === "canonical")).toBeUndefined();
    expect(jsonLd(tags)).toEqual({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: TAIL_SAMPLING.name,
      description: TAIL_SAMPLING.summary,
      publisher: { "@type": "Organization", name: "Telflo" },
    });
  });

  it("says Flow not found for the 404, and the gallery's title while the flow is still to be read", () => {
    expect(metaFor(undefined, "https://telflo.example")).toEqual([{ title: "Flow not found - Telflo" }]);
    expect(metaFor(TAIL_SAMPLING, "https://telflo.example", "refresh_needed")).toEqual([
      { title: "Flows — prebuilt OpenTelemetry Collector configs - Telflo" },
    ]);
  });
});

describe("the flow page (/app/flows/:slug)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCollectorCatalogue();
    useUserStore.getState().clear();
    forgetOrgVariableNames();
    vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
    vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([]);
  });

  it("names the flow's own distribution and version", async () => {
    renderPage();

    expect(await screen.findByText("collector v0.162.0")).toBeInTheDocument();
    expect(screen.getByText(/validated against opentelemetry collector contrib v0\.162\.0/i)).toHaveTextContent(
      "Validated against OpenTelemetry Collector Contrib v0.162.0. Fill in the ${env:…} placeholders before running it.",
    );
  });

  it("names the distribution with the catalog's label once it is read", async () => {
    vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({
      distributions: [{ ...CATALOGUE[0]!, label: "The catalogue's own label" }],
    });
    renderPage();

    expect(await screen.findByText(/Validated against The catalogue's own label v0\.162\.0\./)).toBeInTheDocument();
  });

  it("shows the header: the badges, the name, the summary, Use this flow, and All flows back to the gallery", async () => {
    const { user } = renderPage(makeFlow({ authorName: "ClickStack", sourceUrl: "https://github.com/acme/flows" }));

    const heading = await screen.findByRole("heading", { level: 1, name: TAIL_SAMPLING.name });
    const header = heading.closest("header") as HTMLElement;
    expect(within(header).getByText("traces")).toBeInTheDocument();
    expect(within(header).getByText("metrics")).toBeInTheDocument();
    expect(within(header).getByText("Built by ClickStack")).toBeInTheDocument();
    expect(within(header).getByText(TAIL_SAMPLING.summary)).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Use this flow" })).toBeInTheDocument();
    const source = within(header).getByRole("link", { name: "View on GitHub" });
    expect(source).toHaveAttribute("href", "https://github.com/acme/flows");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noreferrer noopener");

    await user.click(screen.getByRole("link", { name: "All flows" }));
    expect(await screen.findByText("the gallery")).toBeInTheDocument();
  });

  it("labels another host's source link View source, and shows none without one", async () => {
    renderPage(makeFlow({ sourceUrl: "https://example.com/flow" }));
    expect(await screen.findByRole("link", { name: "View source" })).toBeInTheDocument();
  });

  it("shows no source link for a flow without one, and Built by Telflo", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1, name: TAIL_SAMPLING.name });
    expect(screen.queryByRole("link", { name: /View/ })).toBeNull();
    expect(screen.getByText("Built by Telflo")).toBeInTheDocument();
  });

  it("shows the description as plain paragraphs, split on blank lines", async () => {
    renderPage();

    const first = await screen.findByText("Sampling at the head throws away the errors.");
    expect(first.tagName).toBe("P");
    const second = screen.getByText("This flow decides after the trace is complete.");
    expect(second.tagName).toBe("P");
    expect(first.parentElement).toBe(second.parentElement);
  });

  it("says what to know before using it: the backends, the variables to set, and the organization's", async () => {
    renderPage();

    const box = (await screen.findByRole("heading", { level: 2, name: "Before you use this" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(box).getByText("Sends data to").nextElementSibling).toHaveTextContent(
      /^otlp_grpcprometheusremotewrite$/,
    );
    expect(within(box).getByText("You'll need to set these before it runs").nextElementSibling).toHaveTextContent(
      /^PROM_REMOTE_WRITE_URLTRACES_BACKEND_ENDPOINT$/,
    );
    expect(
      within(box).getByText(
        "Define these in your organization's variables — an unset one is delivered to the collector as-is, not as an error",
      ).nextElementSibling,
    ).toHaveTextContent(/^TENANT_IDnot defined$/);
  });

  // Each name marked from the organization's variables' one shared read.
  it("marks each organization variable defined or not, and says nothing while the names are read or when they can't be", async () => {
    const yaml = "exporters:\n  otlp:\n    endpoint: ${org:OTLP_EP}\n    headers:\n      x-tenant: ${org:TENANT_ID}\n";
    const label = "Define these in your organization's variables — an unset one is delivered to the collector as-is, not as an error";
    const read = vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([
      { id: "7a000000-0000-4000-8000-000000000001", name: "OTLP_EP", value: "value-canary", description: null, changedBy: null, changedAt: "2026-10-20T10:00:00.000Z" },
    ]);
    renderPage(makeFlow({ yaml }));
    const names = () => screen.getByText(label).nextElementSibling as HTMLElement;
    await waitFor(() => expect(names()).toHaveTextContent(`OTLP_EP${FLOW_VARIABLE_DEFINED}TENANT_ID${FLOW_VARIABLE_NOT_DEFINED}`));
    expect(FLOW_VARIABLE_DEFINED).toBe("defined");
    expect(FLOW_VARIABLE_NOT_DEFINED).toBe("not defined");
    expect(read).toHaveBeenCalledWith(PERSONAL_ID, expect.anything());
    expect(document.body.innerHTML).not.toContain("value-canary");
  });

  it("marks nothing before the user store has the organization (a full page load's first render), then marks once read", async () => {
    const yaml = "exporters:\n  otlp:\n    endpoint: ${org:OTLP_EP}\n    headers:\n      x-tenant: ${org:TENANT_ID}\n";
    const label = "Define these in your organization's variables — an unset one is delivered to the collector as-is, not as an error";
    const read = vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([
      { id: "7a000000-0000-4000-8000-000000000001", name: "OTLP_EP", value: "value-canary", description: null, changedBy: null, changedAt: "2026-10-20T10:00:00.000Z" },
    ]);
    // The layout seeds the store in an effect: the page's first render has no organization yet.
    renderPage(makeFlow({ yaml }), { seeded: false });
    const names = (await screen.findByText(label)).nextElementSibling as HTMLElement;
    expect(names).toHaveTextContent(/^OTLP_EPTENANT_ID$/);
    expect(read).not.toHaveBeenCalled();

    act(() => useUserStore.getState().setCurrent(signedInMember()));
    expect(names).toHaveTextContent(/^OTLP_EPTENANT_ID$/);
    await waitFor(() => expect(names).toHaveTextContent(`OTLP_EP${FLOW_VARIABLE_DEFINED}TENANT_ID${FLOW_VARIABLE_NOT_DEFINED}`));
    expect(read).toHaveBeenCalledWith(PERSONAL_ID, expect.anything());
  });

  it("leaves the names unmarked when the organization's variables can't be read", async () => {
    vi.spyOn(apiClient, "getOrganizationVariables").mockRejectedValue(new ApiError("variables_unavailable", "unavailable", { status: 503 }));
    renderPage();
    const label = "Define these in your organization's variables — an unset one is delivered to the collector as-is, not as an error";
    const names = await screen.findByText(label);
    await waitFor(() => expect(apiClient.getOrganizationVariables).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(names.nextElementSibling).toHaveTextContent(/^TENANT_ID$/);
  });

  it("leaves out the box, and each part of it, when there is nothing to say", async () => {
    renderPage(makeFlow({ yaml: "receivers:\n  otlp:\n" }));
    await screen.findByRole("heading", { level: 2, name: "The configuration" });
    expect(screen.queryByText("Before you use this")).toBeNull();
  });

  it("shows the configuration's text inside the replay-blocked container, and the tags", async () => {
    renderPage();

    const code = (await screen.findByRole("heading", { level: 2, name: "The configuration" }))
      .closest("section")!
      .querySelector("pre code") as HTMLElement;
    expect(code.textContent).toBe(TAIL_SAMPLING.yaml);
    expect(code.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText("sampling")).toBeInTheDocument();
    expect(screen.getByText("cost")).toBeInTheDocument();
  });

  it("puts nothing of the flow in any attribute", async () => {
    const { user } = renderPage();
    await screen.findByRole("heading", { level: 1, name: TAIL_SAMPLING.name });
    await user.click(screen.getByRole("button", { name: "Use this flow" }));
    await screen.findByRole("dialog", { name: "Use this flow" });

    const words = [TAIL_SAMPLING.name, TAIL_SAMPLING.summary, "TRACES_BACKEND_ENDPOINT", "keep-all-errors"];
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        // An input's value, which React mirrors into the attribute, is masked
        // by replay (maskAllInputs) and autocapture alike: the prefilled name
        // is an input's, as any typed name is.
        if (element.tagName === "INPUT" && attribute.name === "value") continue;
        for (const word of words) expect(`${attribute.name}=${attribute.value}`).not.toContain(word);
      }
    }
  });

  it("opens Use this flow, prefilled, and lands in the editor on the copy", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const { user } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Use this flow" }));
    const dialog = await screen.findByRole("dialog", { name: "Use this flow" });
    expect(within(dialog).getByLabelText("Configuration name")).toHaveValue(TAIL_SAMPLING.name);
    await user.click(within(dialog).getByRole("button", { name: "Create configuration" }));

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    await waitFor(() => expect(createConfiguration).toHaveBeenCalledTimes(1));
    expect(createConfiguration.mock.calls[0]![0]).toBe(PERSONAL_ID);
    expect(createConfiguration.mock.calls[0]![1]).toMatchObject({
      yamlContent: TAIL_SAMPLING.yaml,
      collectorVersion: "0.162.0",
      sourceFlowSlug: TAIL_SAMPLING.slug,
    });
  });
});
