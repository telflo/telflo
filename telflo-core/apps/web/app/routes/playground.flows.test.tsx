import { createRoutesStub, useLocation } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow, PublishedFlow } from "@telflo/contracts";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { PII_REDACTION, TAIL_SAMPLING } from "~/test/flows.js";
import PlaygroundLayout from "./playground.js";
import * as flowPage from "./playground.flows.$slug.js";
import * as gallery from "./playground.flows.js";

/*
 * The playground's flows (D31-1 decisions 5, 6 and 33): the gallery and a
 * flow's page on the open flow read, read in the browser only (no loader),
 * through the platform's FlowPicker; "Use this flow" opens the sign-up
 * prompt; a slug the read doesn't answer is "Flow not found."; nothing else
 * of the API client is called.
 */

/** A flow as the open read answers it: in full but its id, published, sortOrder and createdAt. */
function published(flow: Flow): PublishedFlow {
  const { id: _id, published: _published, sortOrder: _sortOrder, createdAt: _createdAt, ...rest } = flow;
  return rest;
}

const FLOWS = [published(TAIL_SAMPLING), published(PII_REDACTION)];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderFlows(path: string, { slugPage = true }: { slugPage?: boolean } = {}) {
  const Stub = createRoutesStub([
    {
      path: "/playground",
      Component: PlaygroundLayout,
      children: [
        { path: "flows", Component: gallery.default },
        { path: "flows/:slug", Component: slugPage ? flowPage.default : Where },
      ],
    },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

/** Every client function spied on (calling through), and the two open reads answering as given. */
function serveOpenReads({
  list = () => Promise.resolve({ flows: FLOWS }),
  one = (slug: string) => {
    const flow = FLOWS.find((candidate) => candidate.slug === slug);
    return flow ? Promise.resolve({ flow }) : Promise.reject(new ApiError("flow_not_found", "Flow not found", { status: 404 }));
  },
}: {
  list?: () => Promise<{ flows: PublishedFlow[] }>;
  one?: (slug: string) => Promise<{ flow: PublishedFlow }>;
} = {}) {
  const spies = spyOnTheClient();
  const getPublishedFlows = vi.spyOn(apiClient, "getPublishedFlows").mockImplementation(list);
  const getPublishedFlow = vi.spyOn(apiClient, "getPublishedFlow").mockImplementation(one);
  /** No client function but the two open reads was called. */
  const othersCalled = () =>
    spies.filter((spy) => !["getPublishedFlows", "getPublishedFlow"].includes(spy.getMockName()) && spy.mock.calls.length > 0).map((spy) => spy.getMockName());
  return { getPublishedFlows, getPublishedFlow, othersCalled };
}

const cardNames = () => screen.queryAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  document.body.className = "";
});

describe("the read (decision 5): in the browser only", () => {
  it("neither page has a loader: nothing is read on the server", () => {
    for (const module of [gallery, flowPage] as Record<string, unknown>[]) {
      expect(module.loader).toBeUndefined();
      expect(module.clientLoader).toBeUndefined();
    }
  });
});

describe("the gallery (decision 33)", () => {
  it("lists the open read's flows through the platform's FlowPicker, and calls nothing else of the client", async () => {
    const reads = serveOpenReads();
    renderFlows("/playground/flows");
    expect(screen.getByRole("heading", { level: 1, name: "Flows" })).toBeInTheDocument();
    await waitFor(() => expect(cardNames()).toEqual([TAIL_SAMPLING.name, PII_REDACTION.name]));
    expect(reads.getPublishedFlows).toHaveBeenCalledTimes(1);
    expect(reads.getPublishedFlow).not.toHaveBeenCalled();
    expect(reads.othersCalled()).toEqual([]);
    expect(screen.getByText("You're in the playground")).toBeInTheDocument();
  });

  it("filters in the browser with the signed-in gallery's search", async () => {
    const user = userEvent.setup();
    serveOpenReads();
    renderFlows("/playground/flows");
    await waitFor(() => expect(cardNames()).toHaveLength(2));
    await user.type(screen.getByRole("searchbox"), "privacy");
    expect(cardNames()).toEqual([PII_REDACTION.name]);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nothing like this");
    expect(screen.getByText("No flows match your search or filter.")).toBeInTheDocument();
  });

  it("opens a card's flow page at /playground/flows/:slug", async () => {
    const user = userEvent.setup();
    serveOpenReads();
    renderFlows("/playground/flows", { slugPage: false });
    await waitFor(() => expect(cardNames()).toHaveLength(2));
    await user.click(screen.getByRole("heading", { level: 3, name: PII_REDACTION.name }));
    expect(await screen.findByTestId("where")).toHaveTextContent(`/playground/flows/${PII_REDACTION.slug}`);
  });

  it("says so when the read fails, with fixed words, and Try again reads again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    serveOpenReads({
      list: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError("network_error", "The server couldn't be reached."))
          : Promise.resolve({ flows: FLOWS });
      },
    });
    renderFlows("/playground/flows");
    expect(await screen.findByText(gallery.FLOWS_UNAVAILABLE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cardNames()).toHaveLength(2));
  });

  it("says a 429 is a moment's wait", async () => {
    serveOpenReads({
      list: () => Promise.reject(new ApiError("rate_limited", "Too many attempts.", { status: 429, retryAfterSeconds: 30 })),
    });
    renderFlows("/playground/flows");
    expect(await screen.findByText(gallery.FLOWS_RATE_LIMITED)).toBeInTheDocument();
  });

  it("says when no flow is published", async () => {
    serveOpenReads({ list: () => Promise.resolve({ flows: [] }) });
    renderFlows("/playground/flows");
    expect(await screen.findByText("No flows published yet.")).toBeInTheDocument();
  });
});

describe("a flow's page (decisions 6 and 33)", () => {
  it("shows the flow read by its slug: the description, the requirements, the signals, the pin and the YAML read-only inside ph-no-capture", async () => {
    const reads = serveOpenReads();
    renderFlows(`/playground/flows/${TAIL_SAMPLING.slug}`);
    expect(await screen.findByRole("heading", { level: 1, name: TAIL_SAMPLING.name })).toBeInTheDocument();
    expect(reads.getPublishedFlow).toHaveBeenCalledWith(TAIL_SAMPLING.slug);
    expect(reads.getPublishedFlows).not.toHaveBeenCalled();
    expect(reads.othersCalled()).toEqual([]);

    expect(screen.getByText(TAIL_SAMPLING.summary)).toBeInTheDocument();
    expect(screen.getByText("This flow decides after the trace is complete.")).toBeInTheDocument();
    const before = screen.getByRole("heading", { level: 2, name: "Before you use this" }).closest("section")!;
    expect(within(before).getByText("otlp_grpc")).toBeInTheDocument();
    expect(within(before).getByText("TRACES_BACKEND_ENDPOINT")).toBeInTheDocument();
    expect(screen.getByText("traces")).toBeInTheDocument();
    expect(screen.getByText("collector v0.162.0")).toBeInTheDocument();
    const code = document.querySelector("pre code")!;
    expect(code.textContent).toBe(TAIL_SAMPLING.yaml);
    expect(code.closest(".ph-no-capture")).not.toBeNull();
    // Read-only: nothing on the page edits it.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: "All flows" })).toHaveAttribute("href", "/playground/flows");
  });

  it("locks Use this flow: the sign-up prompt with its words, and nothing is created", async () => {
    const user = userEvent.setup();
    const reads = serveOpenReads();
    renderFlows(`/playground/flows/${TAIL_SAMPLING.slug}`);
    await user.click(await screen.findByRole("button", { name: "Use this flow" }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(flowPage.USE_FLOW_LOCKED_ACTION))).toBeInTheDocument();
    expect(signupPromptText(flowPage.USE_FLOW_LOCKED_ACTION)).toContain("To start from this flow, create a free account.");
    expect(reads.othersCalled()).toEqual([]);
  });

  it("says Flow not found for a slug the read answers 404 (unknown or hidden), with a way back", async () => {
    serveOpenReads();
    renderFlows("/playground/flows/no-such-flow");
    expect(await screen.findByText(flowPage.FLOW_NOT_FOUND)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to flows" })).toHaveAttribute("href", "/playground/flows");
    expect(screen.queryByRole("button", { name: "Use this flow" })).toBeNull();
  });

  it("says another failure in fixed words, a 429 as a moment's wait, and Try again reads again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    serveOpenReads({
      one: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError("rate_limited", "Too many attempts.", { status: 429, retryAfterSeconds: 30 }))
          : Promise.resolve({ flow: FLOWS[0]! });
      },
    });
    renderFlows(`/playground/flows/${TAIL_SAMPLING.slug}`);
    expect(await screen.findByText(flowPage.FLOW_RATE_LIMITED)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: TAIL_SAMPLING.name })).toBeInTheDocument();
  });
});
