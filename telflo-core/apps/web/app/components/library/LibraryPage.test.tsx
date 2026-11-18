import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { LibraryFile } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Outlet } from "react-router";
import { toast } from "sonner";
import { CURL_COPIED_MS, LIBRARY_LOAD_FAILED_MESSAGE, LibraryPage, matchesLibrarySearch } from "./LibraryPage.js";
import LibraryRoute, { meta } from "~/routes/library.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import * as clipboard from "~/lib/clipboard.js";
import * as download from "~/lib/download.js";
import { signedInMember } from "~/test/configurations.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

/*
 * The members' library (D23-2 Task 5: decisions 5, 10, 54, 58 and 59; Q160,
 * Q162), the page and its columns: the header, the description and its link,
 * the search, the empty states, the table and its sorting, Download (the
 * bytes saved under the list's file name) and Copy curl (the link's request
 * into the clipboard, the command built under the page's own origin), the
 * list read on each visit, and the secrets' rules: the link and the command
 * only on the clipboard, never in the DOM, a toast or storage.
 *
 * The API is its client's functions, spied on; the clipboard and the
 * download are their modules' functions, spied on. The link is a
 * hand-written fixture, visibly fake (`tll_FAKE…`, decision 59), so it may
 * be compared. Names, descriptions and file names carry the marker "zq".
 */

function fileFixture(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: "0199f400-0000-7000-8000-000000000001",
    name: "zq-Getting started",
    description: "zq-a PDF guide",
    fileName: "zq-getting-started.pdf",
    sizeBytes: 20,
    createdAt: "2026-10-24T12:00:00.000Z",
    updatedAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

const GUIDE = fileFixture();
const SAMPLE = fileFixture({
  id: "0199f400-0000-7000-8000-000000000002",
  name: "zq-Sample logs",
  description: "",
  fileName: "zq it's $(echo EXPANDED).json",
});
const BUNDLE = fileFixture({
  id: "0199f400-0000-7000-8000-000000000003",
  name: "zq-Agent bundle",
  description: "zq-binaries for Linux",
  fileName: "zq-bundle.tar.gz",
});
/** The API's order: newest first. */
const FILES = [GUIDE, SAMPLE, BUNDLE];

/** A visibly fake link's path (decision 59): the contract's shape, never signed. */
const FAKE_LINK_PATH = `/api/v1/library-links/tll_${"FAKE".repeat(17)}FAK`;
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });

function renderPage({ termsAcceptanceRequired = false, docsUrl }: { termsAcceptanceRequired?: boolean; docsUrl?: string } = {}) {
  const member = signedInMember(undefined, termsAcceptanceRequired);
  const layout = [
    {
      id: "routes/app-layout",
      Component: () => <Outlet />,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser: member }),
      HydrateFallback: () => null,
      children: [{ path: "/library", Component: LibraryPage }],
    },
  ];
  // With `docsUrl`, root's site data names it (D36-1 decision 34); without, the default docs.
  const Stub = createRoutesStub(docsUrl === undefined ? layout : underSite({ ...SAAS_SITE, docsUrl }, layout));
  const view = render(<Stub initialEntries={["/library"]} />);
  return { user: userEvent.setup(), unmount: view.unmount };
}

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let list: MockInstance<typeof apiClient.getLibraryFiles>;
let bytes: MockInstance<typeof apiClient.getLibraryFileBytes>;
let link: MockInstance<typeof apiClient.createLibraryFileLink>;
let copy: MockInstance<typeof clipboard.copyTextFromPromise>;
let saved: MockInstance<typeof download.downloadBlob>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;
/** Each text copyTextFromPromise was handed, as the clipboard would take it. */
let copied: Promise<string>[];

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  copied = [];
  list = vi.spyOn(apiClient, "getLibraryFiles").mockResolvedValue({ libraryFiles: FILES });
  bytes = vi.spyOn(apiClient, "getLibraryFileBytes").mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  link = vi.spyOn(apiClient, "createLibraryFileLink").mockResolvedValue({ path: FAKE_LINK_PATH });
  copy = vi.spyOn(clipboard, "copyTextFromPromise").mockImplementation((text) => {
    copied.push(text);
    return text.then(() => undefined);
  });
  saved = vi.spyOn(download, "downloadBlob").mockImplementation(() => {});
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

afterEach(() => {
  vi.useRealTimers();
});

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("tr")!;
}

/** The names in the table, top to bottom. */
function shownNames(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

describe("the members' library page (D23-2 decision 54)", () => {
  it("is titled with fixed words", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([
      { title: "Library - Telflo" },
      { name: "description", content: "Download resources provided by Telflo" },
    ]);
    expect(LibraryRoute).toBeTypeOf("function");
  });

  it("links Learning Telflo under the site's docs, and leaves it plain text with TELFLO_DOCS_URL empty (D36-1 decision 34)", async () => {
    const first = renderPage({ docsUrl: "https://docs.example.org/telflo" });
    expect(await screen.findByRole("link", { name: "Learning Telflo" })).toHaveAttribute("href", "https://docs.example.org/telflo/docs/learning/about");
    first.unmount();

    renderPage({ docsUrl: "" });
    expect(await screen.findByText(GUIDE.name)).toBeInTheDocument();
    expect(screen.getByText(/Helper files used in the/)).toHaveTextContent("Helper files used in the Learning Telflo tutorials.");
    expect(screen.queryByRole("link", { name: "Learning Telflo" })).not.toBeInTheDocument();
  });

  it("shows the header, the description with its link (a new tab, no referrer), the search and the table from GET /api/v1/library-files", async () => {
    renderPage();

    expect(await screen.findByText(GUIDE.name)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.getByText(/Helper files used in the/)).toHaveTextContent("Helper files used in the Learning Telflo tutorials.");
    const learning = screen.getByRole("link", { name: "Learning Telflo" });
    expect(learning).toHaveAttribute("href", "https://docs.telflo.com/docs/learning/about");
    expect(learning).toHaveAttribute("target", "_blank");
    expect(learning).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search library by name or description...");
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Description", "Actions"]);
    const cells = (name: string) => within(rowOf(name)).getAllByRole("cell").slice(0, 2).map((cell) => cell.textContent);
    expect(cells(GUIDE.name)).toEqual([GUIDE.name, GUIDE.description]);
    expect(within(rowOf(GUIDE.name)).getAllByRole("button")).toEqual([
      within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }),
      within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" }),
    ]);
    // An empty description shows a dash.
    expect(cells(SAMPLE.name)).toEqual([SAMPLE.name, "—"]);
    expect(shownNames()).toEqual([GUIDE.name, SAMPLE.name, BUNDLE.name]);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" })).toHaveAttribute(
      "title",
      "Copy a curl command that downloads this file",
    );
    expect(list).toHaveBeenCalledOnce();
  });

  it("shows 'Untitled' for a file without a name", async () => {
    list.mockResolvedValueOnce({ libraryFiles: [fileFixture({ name: "" })] });
    renderPage();

    expect(await screen.findByText("Untitled")).toBeInTheDocument();
  });

  it("shows the spinner until the first read answers, then 'No files in the library yet.' when there are none", async () => {
    const answer = deferred<{ libraryFiles: LibraryFile[] }>();
    list.mockReturnValueOnce(answer.promise);
    renderPage();

    expect(await screen.findByRole("status", { name: "Loading library files" })).toBeInTheDocument();
    answer.resolve({ libraryFiles: [] });

    expect(await screen.findByText("No files in the library yet.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("toasts 'Failed to load library files' when the read fails, and nothing when the session has ended", async () => {
    list.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    const first = renderPage();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(LIBRARY_LOAD_FAILED_MESSAGE));
    first.unmount();

    toastError.mockClear();
    list.mockRejectedValueOnce(SESSION_ENDED);
    renderPage();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reads nothing while the layout says the current terms need accepting", async () => {
    renderPage({ termsAcceptanceRequired: true });

    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
  });

  it("reads the list on each visit: nothing kept between them", async () => {
    const first = renderPage();
    await screen.findByText(GUIDE.name);
    first.unmount();

    list.mockResolvedValueOnce({ libraryFiles: [BUNDLE] });
    renderPage();

    expect(await screen.findByText(BUNDLE.name)).toBeInTheDocument();
    expect(screen.queryByText(GUIDE.name)).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("searching (client-side, by name or description, case aside)", () => {
  it("filters by name and by description as typed, case aside, without asking the API again", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);
    const search = screen.getByRole("searchbox");

    await user.type(search, "GETTING");
    expect(shownNames()).toEqual([GUIDE.name]);

    await user.clear(search);
    await user.type(search, "  linux ");
    expect(shownNames()).toEqual([BUNDLE.name]);

    await user.clear(search);
    expect(shownNames()).toEqual([GUIDE.name, SAMPLE.name, BUNDLE.name]);
    expect(list).toHaveBeenCalledOnce();
  });

  it("says 'No files match your search.' when nothing matches", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    await user.type(screen.getByRole("searchbox"), "nothing like it");

    expect(screen.getByText("No files match your search.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("matches the name and the description, never the file's own name", () => {
    expect(matchesLibrarySearch(GUIDE, "pdf guide")).toBe(true);
    expect(matchesLibrarySearch(GUIDE, "zq-getting-started.pdf")).toBe(false);
    expect(matchesLibrarySearch(GUIDE, "   ")).toBe(true);
  });
});

describe("sorting (Name and Description)", () => {
  it("sorts by Name ascending first, then toggles; aria-sort on the sorted header only", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);
    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    const descriptionHeader = screen.getByRole("columnheader", { name: "Description" });
    expect(nameHeader).not.toHaveAttribute("aria-sort");

    await user.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(shownNames()).toEqual([BUNDLE.name, GUIDE.name, SAMPLE.name]);
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(descriptionHeader).not.toHaveAttribute("aria-sort");

    await user.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(shownNames()).toEqual([SAMPLE.name, GUIDE.name, BUNDLE.name]);
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  });

  it("sorts by Description ascending first, an empty one first", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);
    const descriptionHeader = screen.getByRole("columnheader", { name: "Description" });

    await user.click(within(descriptionHeader).getByRole("button", { name: "Description" }));

    expect(shownNames()).toEqual([SAMPLE.name, GUIDE.name, BUNDLE.name]);
    expect(descriptionHeader).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute("aria-sort");
  });
});

describe("Download", () => {
  it("reads the bytes with the session, by id, and saves them under the list's file name; 'Downloading…' and disabled meanwhile", async () => {
    const answer = deferred<Uint8Array>();
    bytes.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" }));

    expect(bytes).toHaveBeenCalledWith(GUIDE.id);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(within(rowOf(SAMPLE.name)).getByRole("button", { name: "Download" })).toBeEnabled();
    answer.resolve(new Uint8Array([1, 2, 3]));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const [blob, name] = saved.mock.calls[0]!;
    expect(name).toBe(GUIDE.fileName);
    expect(blob.size).toBe(3);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" })).toBeEnabled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts 'Failed to download file' when it fails, and nothing when the session has ended", async () => {
    bytes.mockRejectedValueOnce(new ApiError("library_file_not_found", "Library file not found", { status: 404 }));
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to download file"));
    expect(saved).not.toHaveBeenCalled();

    toastError.mockClear();
    bytes.mockRejectedValueOnce(SESSION_ENDED);
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(bytes).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("Copy curl (decision 10; Q160, Q162)", () => {
  it("hands the link's request to the clipboard inside the click, before it answers; the command is single-quoted, under the page's own origin", async () => {
    const answer = deferred<{ path: string }>();
    link.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));

    // The clipboard has the promise while the link is still on its way (Safari's gesture).
    expect(link).toHaveBeenCalledWith(GUIDE.id);
    expect(copy).toHaveBeenCalledOnce();
    await act(async () => answer.resolve({ path: FAKE_LINK_PATH }));
    await expect(copied[0]).resolves.toBe(`curl -fL '${window.location.origin}${FAKE_LINK_PATH}' -o 'zq-getting-started.pdf'`);
    expect(await within(rowOf(GUIDE.name)).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("quotes a file name holding a quote and a command substitution, so nothing in it expands", async () => {
    const { user } = renderPage();
    await screen.findByText(SAMPLE.name);

    await user.click(within(rowOf(SAMPLE.name)).getByRole("button", { name: "Curl" }));

    await expect(copied[0]).resolves.toBe(`curl -fL '${window.location.origin}${FAKE_LINK_PATH}' -o 'zq it'\\''s $(echo EXPANDED).json'`);
    expect(await within(rowOf(SAMPLE.name)).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says 'Copied' with a check for 1.5 s, then 'Curl' again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByText(GUIDE.name);

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));

    expect(await within(rowOf(GUIDE.name)).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(within(rowOf(SAMPLE.name)).getByRole("button", { name: "Curl" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(CURL_COPIED_MS - 100));
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" })).toBeInTheDocument();
    expect(CURL_COPIED_MS).toBe(1500);
  });

  it("toasts 'Failed to copy curl command' when the link is refused or the clipboard says no, and nothing when the session has ended", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    link.mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests.", { status: 429 }));
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to copy curl command"));

    toastError.mockClear();
    copy.mockImplementationOnce((text) => text.then(() => Promise.reject(new DOMException("No", "NotAllowedError"))));
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to copy curl command"));

    toastError.mockClear();
    link.mockRejectedValueOnce(SESSION_ENDED);
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));
    await waitFor(() => expect(link).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(toastError).not.toHaveBeenCalled();
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" })).toBeInTheDocument();
  });

  it("keeps the link and the command out of the DOM, browser storage and every toast (decision 4)", async () => {
    const { user } = renderPage();
    await screen.findByText(GUIDE.name);

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" }));
    await within(rowOf(GUIDE.name)).findByRole("button", { name: "Copied" });
    await expect(copied[0]).resolves.toBeTypeOf("string");

    const page = document.documentElement.outerHTML;
    expect(page.includes("tll_"), "the DOM holds no link").toBe(false);
    expect(page.includes("library-links"), "the DOM holds no link's route").toBe(false);
    expect(page.includes("curl -fL"), "the DOM holds no command").toBe(false);
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored.includes("tll_"), "storage holds no link").toBe(false);
    const toasts = JSON.stringify([...toastError.mock.calls, ...toastSuccess.mock.calls]);
    expect(toasts.includes("tll_") || toasts.includes("curl"), "no toast holds the link or the command").toBe(false);
  });
});

describe("replay's rules (decision 58)", () => {
  it("puts no name, description or file name in any attribute; each row's buttons are described by the name's text", async () => {
    renderPage();
    await screen.findByText(GUIDE.name);

    const markers: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
        if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}`);
      }
    }
    expect(markers).toEqual([]);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Curl" })).toHaveAccessibleDescription(GUIDE.name);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Download" })).toHaveAccessibleDescription(GUIDE.name);
  });
});
