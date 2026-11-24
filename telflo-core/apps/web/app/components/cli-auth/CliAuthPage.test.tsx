import { createHmac } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub, MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE,
  PERSONAL_API_TOKEN_NAME_TAKEN_MESSAGE,
  type ApiToken,
  type CreatedApiTokenResponse,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { HANDOFF_WAIT_MS, PROOF_CONTEXT } from "~/lib/cli-auth.js";
import { API_TOKEN_CREATE_FAILED_MESSAGE } from "~/lib/service-accounts.js";
import { attributesHolding } from "~/test/fleets.js";
import { apiToken, buildApiToken, expectTokenOnlyInsideNoCapture, quietQueries, showsText } from "~/test/service-accounts.js";
import {
  CANCELLED_WORDS,
  CHECKING_WORDS,
  CliAuthPage,
  DONE_WORDS,
  FALLBACK_WORDS,
  INVALID_LINK_WORDS,
  REVOKE_FAILED_WARNING,
  WAITING_WORDS,
} from "./CliAuthPage.js";

/*
 * `/cli-auth`: the neutral first render, the fragment read once and removed,
 * each refusal, Approve's four calls in order, the 60 s wait and the fallback,
 * another status's fallback, a late 204, Cancel, the 409s. A token is built at
 * run time and checked with boolean canaries only; the host is visible text
 * inside ph-no-capture only.
 */

const STATE = `${"S".repeat(20)}-_${"t".repeat(21)}`;
const PORT = 54321;
const HOST = "ada-laptop.local";
const FRAGMENT = `#state=${STATE}&port=${PORT}&host=${HOST}`;
const NEW_ID = "5b000000-0000-4000-8000-0000000000a1";
const EARLIER_ID = "5b000000-0000-4000-8000-0000000000a2";
const EARLIER_EXPIRED_ID = "5b000000-0000-4000-8000-0000000000a3";
const LISTENER_URL = `http://127.0.0.1:${PORT}/callback`;
/** A second link's listener (a new link in the same tab). */
const NEW_STATE = `${"N".repeat(20)}-_${"m".repeat(21)}`;
const NEW_PORT = 54999;

let token: string;
let log: string[];
let unquiet: () => void;

/** The address bar as the CLI opened it. */
function arriveAt(hash: string): void {
  window.history.replaceState(null, "", `/cli-auth${hash}`);
}

function renderPage() {
  const Stub = createRoutesStub([
    { path: "/cli-auth", Component: CliAuthPage },
    { path: "/settings/account", Component: () => <p>landed on the Account page</p> },
  ]);
  return render(<Stub initialEntries={["/cli-auth"]} />);
}

function created(over: Partial<ApiToken> = {}): CreatedApiTokenResponse {
  return { apiToken: apiToken({ id: NEW_ID, name: "CLI — ada-laptop.local · 2026-10-26 07:08:09", access: "write", ...over }), token };
}

/** The CLI's listener's answer to a challenge (apps/cli/src/login-listener.ts): HMAC-SHA256 keyed by the state of the listener at `url`. */
function proved(url: string, challenge: string): Response {
  const state = url === `http://127.0.0.1:${NEW_PORT}/callback` ? NEW_STATE : STATE;
  const proof = createHmac("sha256", state).update(PROOF_CONTEXT + challenge, "utf8").digest("base64url");
  return new Response(JSON.stringify({ proof }), { status: 200, headers: { "content-type": "application/json" } });
}

/** The API's three calls and the listener's fetch, each logged in order; the listener answers `listener`. */
function stubCalls(listener: () => Promise<Response> = async () => new Response(null, { status: 204 })) {
  const create = vi.spyOn(apiClient, "createPersonalApiToken").mockImplementation(async (request) => {
    log.push(`create ${request.access} ${request.expiresInDays}`);
    return created();
  });
  const list = vi.spyOn(apiClient, "getPersonalApiTokens").mockImplementation(async () => {
    log.push("list");
    return {
      items: [
        apiToken({ id: NEW_ID, name: "CLI — ada-laptop.local · 2026-10-26 07:08:09" }),
        apiToken({ id: EARLIER_ID, name: "CLI — ada-laptop.local · 2026-10-01 10:00:00" }),
        apiToken({ id: EARLIER_EXPIRED_ID, name: "CLI — ada-laptop.local · 2026-09-01 10:00:00", isExpired: true }),
        apiToken({ id: "5b000000-0000-4000-8000-0000000000b1", name: "CLI — ada-laptop.localx · 2026-10-01 10:00:00" }),
        apiToken({ id: "5b000000-0000-4000-8000-0000000000b2", name: "CLI — ada-laptop · 2026-10-01 10:00:00" }),
        apiToken({ id: "5b000000-0000-4000-8000-0000000000b3", name: "cli — ada-laptop.local · 2026-10-01 10:00:00" }),
        apiToken({ id: "5b000000-0000-4000-8000-0000000000b4", name: "My CLI — ada-laptop.local · 1" }),
        apiToken({ id: "5b000000-0000-4000-8000-0000000000b5", name: "deploy" }),
      ],
    };
  });
  const revoke = vi.spyOn(apiClient, "revokePersonalApiToken").mockImplementation(async (id) => {
    log.push(`revoke ${id}`);
    return undefined;
  });
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The listener's proof that it knows the state, asked before every answer (lib/cli-auth.ts): the CLI's, made here.
    if (Object.keys(body).join(",") === "challenge") return proved(url, String(body.challenge));
    log.push(`listener ${url} ${Object.keys(body).sort().join(",")} ${body.state === STATE} ${body.token === token}`);
    return listener();
  });
  vi.stubGlobal("fetch", fetch);
  return { create, list, revoke, fetch };
}

/** Whether the token is anywhere in the page's text, attributes or title. */
function pageHoldsToken(): boolean {
  return document.documentElement.outerHTML.includes(token) || document.title.includes(token);
}

/**
 * Whether the page's own hooks hold the token: each hook's state, a ref's
 * `current`, an array's items (anyStateHolds, which follows every object,
 * reaches a stale alternate fiber's props through the router's elements).
 */
function pageStateHolds(): boolean {
  type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedState: unknown; type: unknown; stateNode: { current?: Fiber } | null };
  const holds = (value: unknown): boolean => {
    if (typeof value === "string") return value.includes(token);
    if (Array.isArray(value)) return value.some((each) => typeof each === "string" && each.includes(token));
    if (value !== null && typeof value === "object" && "current" in value) return holds((value as { current: unknown }).current);
    return false;
  };
  let pages = 0;
  for (const container of [document.body, ...document.body.querySelectorAll("*")]) {
    const key = Object.keys(container).find((each) => each.startsWith("__reactContainer$"));
    if (key === undefined) continue;
    const stack: Fiber[] = [(container as unknown as Record<string, Fiber>)[key]!.stateNode!.current!];
    while (stack.length > 0) {
      const fiber = stack.pop()!;
      // The page and its session (CliAuthSession, the page's own component, not exported).
      if (fiber.type === CliAuthPage || (typeof fiber.type === "function" && fiber.type.name === "CliAuthSession")) {
        pages += 1;
        for (let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null; hook !== null; hook = hook.next as typeof hook) {
          if (holds(hook.memoizedState)) return true;
        }
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }
  expect(pages, "the page and its session rendered").toBe(2);
  return false;
}

beforeEach(() => {
  vi.restoreAllMocks();
  token = buildApiToken();
  log = [];
  unquiet = quietQueries();
  arriveAt(FRAGMENT);
});

afterEach(() => {
  unquiet();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("the fragment", () => {
  it("renders neutral words on the server, hydrates without a mismatch, then reads the fragment and takes it out of the address bar", async () => {
    const page = (
      <MemoryRouter initialEntries={["/cli-auth"]}>
        <CliAuthPage />
      </MemoryRouter>
    );
    const html = renderToString(page);
    expect(html.includes(CHECKING_WORDS)).toBe(true);
    expect(html.includes(HOST)).toBe(false);
    expect(html.includes(STATE)).toBe(false);

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    const routerState = { idx: 0 };
    window.history.replaceState(routerState, "", `/cli-auth${FRAGMENT}`);
    const root = await act(async () => hydrateRoot(container, page, { onRecoverableError: recoverable }));
    try {
      expect(recoverable).not.toHaveBeenCalled();
      expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
      expect(window.location.hash).toBe("");
      expect(window.location.pathname).toBe("/cli-auth");
      // The router's state is kept.
      expect(window.history.state).toBe(routerState);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("shows the host as visible text inside ph-no-capture only, never in an attribute or the title", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${HOST}` });
    const hostText = [...heading.querySelectorAll(".ph-no-capture")].map((each) => each.textContent);
    expect(hostText).toEqual([HOST]);
    expect(attributesHolding(HOST)).toEqual([]);
    expect(attributesHolding(STATE)).toEqual([]);
    expect(document.title.includes(HOST)).toBe(false);
    const outside = document.body.cloneNode(true) as HTMLElement;
    for (const each of outside.querySelectorAll(".ph-no-capture")) each.remove();
    expect((outside.textContent ?? "").includes(HOST)).toBe(false);
    expect(screen.getByRole("radio", { name: "Write" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
    expect(screen.getAllByRole("radio").map((each) => each.parentElement?.textContent)).toEqual(["Write", "Read", "1 day", "7 days", "30 days", "90 days"]);
  });

  it.each([
    ["no fragment (a reload)", ""],
    ["a fragment missing the state", `#port=${PORT}&host=${HOST}`],
    ["a malformed state", `#state=short&port=${PORT}&host=${HOST}`],
    ["a port below 1024", `#state=${STATE}&port=80&host=${HOST}`],
    ["a host with a space", `#state=${STATE}&port=${PORT}&host=ada%20laptop`],
    ["another parameter", `${FRAGMENT}&token=x`],
  ])("says only that the link isn't valid for %s, the fragment removed", async (_kind, hash) => {
    arriveAt(hash);
    const calls = stubCalls();
    renderPage();
    expect(await screen.findByText(INVALID_LINK_WORDS)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(window.location.hash).toBe("");
    expect(calls.create).not.toHaveBeenCalled();
  });
});

describe("Approve", () => {
  it("creates, lists, revokes this machine's earlier CLI tokens (never the new one), then hands the token to the listener: Done", async () => {
    const calls = stubCalls();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(DONE_WORDS)).toBeInTheDocument();
    expect(log).toEqual([
      "create write 30",
      "list",
      `revoke ${EARLIER_ID}`,
      `revoke ${EARLIER_EXPIRED_ID}`,
      `listener ${LISTENER_URL} state,token true true`,
    ]);
    const name = (calls.create.mock.calls[0]?.[0] as { name: string }).name;
    expect(/^CLI — ada-laptop\.local · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(name)).toBe(true);
    expect(calls.fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
    // The token is dropped: not in the page, not in its state.
    expect(pageHoldsToken()).toBe(false);
    expect(pageStateHolds()).toBe(false);
  });

  it("sends the access and expiry chosen", async () => {
    stubCalls();
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: "Read" }));
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(DONE_WORDS);
    expect(log[0]).toBe("create read 7");
  });

  it("makes one create for a double click: Approve is disabled while it runs", async () => {
    let finish!: (value: CreatedApiTokenResponse) => void;
    const calls = stubCalls();
    calls.create.mockImplementation(() => new Promise<CreatedApiTokenResponse>((resolve) => (finish = resolve)));
    renderPage();
    const approve = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(calls.create).toHaveBeenCalledTimes(1);
    await act(async () => finish(created()));
    await screen.findByText(DONE_WORDS);
  });

  it("warns in fixed words when a revoke fails, and still hands the token over", async () => {
    const calls = stubCalls();
    calls.revoke.mockRejectedValueOnce(new ApiError("internal_error", "Something went wrong.", { status: 500 }));
    const warning = vi.spyOn(toast, "warning");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(DONE_WORDS);
    expect(warning).toHaveBeenCalledWith(REVOKE_FAILED_WARNING);
    expect(log.at(-1)?.startsWith("listener")).toBe(true);
  });

  it("warns when the list fails, and still hands the token over", async () => {
    const calls = stubCalls();
    calls.list.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const warning = vi.spyOn(toast, "warning");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(DONE_WORDS);
    expect(warning).toHaveBeenCalledWith(REVOKE_FAILED_WARNING);
    expect(calls.revoke).not.toHaveBeenCalled();
  });

  it("says the browser may ask while it waits, then after 60 s shows the token once inside ph-no-capture; a late 204 is Done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let answer!: (response: Response) => void;
    stubCalls(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(WAITING_WORDS)).toBeInTheDocument();
    expect(pageHoldsToken()).toBe(false);

    // The clock also moves with real time (shouldAdvanceTime): a second short of the wait is still waiting.
    act(() => vi.advanceTimersByTime(HANDOFF_WAIT_MS - 1000));
    expect(showsText(WAITING_WORDS)).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(await screen.findByText(FALLBACK_WORDS)).toBeInTheDocument();
    expectTokenOnlyInsideNoCapture(token);
    // The check below sees the token while the fallback holds it.
    expect(pageStateHolds()).toBe(true);
    expect(screen.getByRole("button", { name: "Copy token" })).toBeInTheDocument();
    expect(log.filter((each) => each.startsWith("listener"))).toHaveLength(1);

    await act(async () => answer(new Response(null, { status: 204 })));
    expect(await screen.findByText(DONE_WORDS)).toBeInTheDocument();
    expect(pageHoldsToken()).toBe(false);
    expect(pageStateHolds()).toBe(false);
  });

  it.each([
    ["a TypeError (blocked, refused)", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 403 (another process)", async () => new Response(null, { status: 403 })],
    ["a 404 (a stale port)", async () => new Response(null, { status: 404 })],
    ["a 500", async () => new Response(null, { status: 500 })],
  ])("shows the fallback at once after %s", async (_kind, listener) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    stubCalls(listener);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(FALLBACK_WORDS)).toBeInTheDocument();
    expectTokenOnlyInsideNoCapture(token);
    // The 60 s timer was cleared: nothing changes when it would have fired.
    act(() => vi.advanceTimersByTime(HANDOFF_WAIT_MS));
    expect(showsText(FALLBACK_WORDS)).toBe(true);
  });

  it("puts the token in no storage and no toast", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const toasts = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error"), vi.spyOn(toast, "warning"), vi.spyOn(toast, "message")];
    stubCalls(async () => new Response(null, { status: 403 }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(FALLBACK_WORDS);
    const stored = setItem.mock.calls.some((call) => call.join(" ").includes(token));
    const toasted = toasts.some((spy) => JSON.stringify(spy.mock.calls).includes(token));
    expect(stored).toBe(false);
    expect(toasted).toBe(false);
  });
});

describe("a new link in the same tab", () => {
  const NEW_HOST = "second-box";
  const NEW_FRAGMENT = `#state=${NEW_STATE}&port=${NEW_PORT}&host=${NEW_HOST}`;

  /** A same-document fragment navigation, as pasting the CLI's second address into this tab is. */
  async function arriveAgain(hash: string): Promise<void> {
    await act(async () => {
      window.location.hash = hash;
    });
  }

  it("after Done, a new fragment is read: the form for the new host, the fragment removed, Approve for the new listener", async () => {
    const calls = stubCalls();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(DONE_WORDS);

    await arriveAgain(NEW_FRAGMENT);
    expect(await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(showsText(DONE_WORDS)).toBe(false);
    expect(screen.getByRole("radio", { name: "Write" })).toBeChecked();

    log = [];
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(DONE_WORDS);
    const [url, init] = calls.fetch.mock.calls.at(-1) ?? [];
    expect(url).toBe(`http://127.0.0.1:${NEW_PORT}/callback`);
    expect(JSON.parse(String(init?.body)).state).toBe(NEW_STATE);
    const names = vi.mocked(apiClient.createPersonalApiToken).mock.calls.map(([request]) => request.name);
    expect(names.map((name) => name.startsWith(`CLI — ${NEW_HOST} · `))).toEqual([false, true]);
  });

  it("after Cancelled, a new fragment is read: the form again", async () => {
    stubCalls();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByText(CANCELLED_WORDS);

    await arriveAgain(NEW_FRAGMENT);
    expect(await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(showsText(CANCELLED_WORDS)).toBe(false);
    expect(window.location.hash).toBe("");
  });

  it("a malformed new fragment shows only the invalid link's words, and is removed too", async () => {
    stubCalls();
    renderPage();
    await screen.findByRole("button", { name: "Approve" });

    await arriveAgain("#state=short&port=1&host=box");
    expect(await screen.findByText(INVALID_LINK_WORDS)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("revokes a token whose create answers after a new fragment arrived, keeping it nowhere", async () => {
    let finish!: (value: CreatedApiTokenResponse) => void;
    const calls = stubCalls();
    calls.create.mockImplementationOnce(() => new Promise<CreatedApiTokenResponse>((resolve) => (finish = resolve)));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(calls.create).toHaveBeenCalledTimes(1);

    await arriveAgain(NEW_FRAGMENT);
    expect(await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` })).toBeInTheDocument();
    await act(async () => finish(created()));

    await waitFor(() => expect(calls.revoke).toHaveBeenCalledWith(NEW_ID));
    expect(calls.revoke).toHaveBeenCalledTimes(1);
    expect(calls.list).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(pageHoldsToken()).toBe(false);
    expect(pageStateHolds()).toBe(false);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("revokes the token when the session is left while the earlier tokens are revoked, and never hands it off", async () => {
    let listed!: (value: { items: ApiToken[] }) => void;
    const calls = stubCalls();
    calls.list.mockImplementationOnce(() => new Promise<{ items: ApiToken[] }>((resolve) => (listed = resolve)));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.list).toHaveBeenCalledTimes(1));

    await arriveAgain(NEW_FRAGMENT);
    await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` });
    await act(async () => listed({ items: [] }));

    await waitFor(() => expect(calls.revoke).toHaveBeenCalledWith(NEW_ID));
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(pageHoldsToken()).toBe(false);
    expect(pageStateHolds()).toBe(false);
  });

  it("ignores a failed revoke of the abandoned token: no words shown", async () => {
    let finish!: (value: CreatedApiTokenResponse) => void;
    const calls = stubCalls();
    calls.create.mockImplementationOnce(() => new Promise<CreatedApiTokenResponse>((resolve) => (finish = resolve)));
    calls.revoke.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const warning = vi.spyOn(toast, "warning");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await arriveAgain(NEW_FRAGMENT);
    await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` });
    await act(async () => finish(created()));
    await waitFor(() => expect(calls.revoke).toHaveBeenCalledWith(NEW_ID));
    expect(warning).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the earlier link's token shown to paste, and its late answer changes nothing", async () => {
    let answer!: (response: Response) => void;
    stubCalls(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(WAITING_WORDS);
    act(() => vi.advanceTimersByTime(HANDOFF_WAIT_MS));
    await screen.findByText(FALLBACK_WORDS);
    expect(pageHoldsToken()).toBe(true);

    await arriveAgain(NEW_FRAGMENT);
    expect(await screen.findByRole("heading", { name: `Sign in the Telflo CLI on ${NEW_HOST}` })).toBeInTheDocument();
    expect(pageHoldsToken()).toBe(false);
    expect(pageStateHolds()).toBe(false);
    // The earlier listener's late 204 belongs to the earlier session: the new one's form stays.
    await act(async () => answer(new Response(null, { status: 204 })));
    expect(showsText(DONE_WORDS)).toBe(false);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

describe("Cancel and refusals", () => {
  it("Cancel posts the denial and says Cancelled, with no token made", async () => {
    const calls = stubCalls();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(CANCELLED_WORDS)).toBeInTheDocument();
    await waitFor(() => expect(log).toEqual([`listener ${LISTENER_URL} error,state true false`]));
    // The second request: the first was the challenge.
    expect(JSON.parse(String(calls.fetch.mock.calls[1]?.[1]?.body))).toEqual({ state: STATE, error: "denied" });
    expect(calls.create).not.toHaveBeenCalled();
  });

  it("Cancel says Cancelled even when the listener can't be reached", async () => {
    stubCalls(async () => Promise.reject(new TypeError("Failed to fetch")));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(CANCELLED_WORDS)).toBeInTheDocument();
  });

  it("shows the API's limit message with a link to the Account page, and nothing after the create", async () => {
    const calls = stubCalls();
    calls.create.mockRejectedValue(new ApiError("api_token_limit_reached", PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE, { status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Account page" }).getAttribute("href")).toBe("/settings/account");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(calls.list).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Go to the Account page" }));
    expect(await screen.findByText("landed on the Account page")).toBeInTheDocument();
  });

  it("shows the API's name-taken message (a second tab in the same second), without the link", async () => {
    const calls = stubCalls();
    calls.create.mockRejectedValue(new ApiError("api_token_name_taken", PERSONAL_API_TOKEN_NAME_TAKEN_MESSAGE, { status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(PERSONAL_API_TOKEN_NAME_TAKEN_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to the Account page" })).toBeNull();
  });

  it("says the create failed in fixed words for anything else, never the error's own", async () => {
    const calls = stubCalls();
    calls.create.mockRejectedValue(new TypeError("Failed to fetch: something private"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(API_TOKEN_CREATE_FAILED_MESSAGE)).toBeInTheDocument();
    expect(showsText("something private")).toBe(false);
  });

  it("shows nothing for an ended session (its handler takes the page to sign-in)", async () => {
    const calls = stubCalls();
    calls.create.mockRejectedValue(new ApiError("unauthenticated", "Not signed in.", { status: 401 }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
