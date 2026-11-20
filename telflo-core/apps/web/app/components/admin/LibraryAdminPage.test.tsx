import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as contracts from "@telflo/contracts";
import type { LibraryFile } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import { LibraryAdminPage } from "./LibraryAdminPage.js";
import { LIBRARY_FILE_TOO_LARGE_MESSAGE, libraryFileRefusal } from "./LibraryFileDialog.js";
import { LIBRARY_LOAD_FAILED_MESSAGE, LIBRARY_REQUEST_TIMEOUT_MS } from "~/components/library/LibraryPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";

/*
 * Product admin's Library page, its dialog and its confirmation: the table,
 * the empty and loading states, create (each validation message, the
 * browser's own refusals, the API's), edit (name and description only, the
 * changed fields), delete (the confirmation), the toasts, the way out when
 * the flag is cleared mid-visit, and replay's rules (the hidden file input
 * and the chosen name blocked; no name in an attribute or a URL).
 *
 * The API is its client's functions, spied on; toasts are spied on. Names,
 * descriptions and file names carry the private-text marker "zq".
 */

function fileFixture(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: "0199f400-0000-7000-8000-000000000001",
    name: "zq-getting-started",
    description: "zq-getting-started-description",
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
  name: "zq-sample-logs",
  description: "",
  fileName: "zq-sample-logs.json",
});
const FILES = [GUIDE, SAMPLE];

const FORBIDDEN = new ApiError("product_admin_required", "Only product admins can do that.", { status: 403 });
const NOT_FOUND = new ApiError("library_file_not_found", "Library file not found", { status: 404 });
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
const API_TOO_LARGE = "The file must be 10 MB or smaller.";

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

/** The router's address as the page last rendered under it: path, query and hash. */
let pageAddress = "";

function LibraryAdminPageAt() {
  const location = useLocation();
  pageAddress = location.pathname + location.search + location.hash;
  return <LibraryAdminPage />;
}

function renderPage() {
  pageAddress = "";
  const Stub = createRoutesStub([
    { path: "/product-admin/library", Component: LibraryAdminPageAt },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/library"]} />);
  return { user: userEvent.setup() };
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
let create: MockInstance<typeof apiClient.createLibraryFile>;
let update: MockInstance<typeof apiClient.updateLibraryFile>;
let remove: MockInstance<typeof apiClient.deleteLibraryFile>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

beforeEach(() => {
  vi.restoreAllMocks();
  list = vi.spyOn(apiClient, "getLibraryFiles").mockResolvedValue({ libraryFiles: FILES });
  create = vi.spyOn(apiClient, "createLibraryFile").mockResolvedValue({ libraryFile: GUIDE });
  update = vi.spyOn(apiClient, "updateLibraryFile").mockResolvedValue({ libraryFile: GUIDE });
  remove = vi.spyOn(apiClient, "deleteLibraryFile").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr")!;
}

/** The hidden file input. */
const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

/** A file of `size` bytes, its content a few bytes (jsdom reads `size` as given). */
function sized(name: string, size: number): File {
  return Object.defineProperty(new File(["x"], name), "size", { value: size });
}

/** Opens New File and fills every field, the file `file`. */
async function fillNew(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.click(await screen.findByRole("button", { name: "New File" }));
  const dialog = await screen.findByRole("dialog", { name: "New Library File" });
  await user.type(within(dialog).getByLabelText("Name"), "  zq-new-file  ");
  await user.type(within(dialog).getByLabelText("Description"), " zq-new-description ");
  await user.upload(picker(), file);
  return dialog;
}

describe("the Library page", () => {
  it("shows the header and table: Name (a button), Description, File, Delete; the list from GET /api/v1/library-files", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: GUIDE.name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New File" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Description", "File", "Actions"]);
    const cells = (name: string) => within(rowOf(name)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells(GUIDE.name)).toEqual([GUIDE.name, GUIDE.description, GUIDE.fileName, "Delete"]);
    expect(cells(SAMPLE.name)).toEqual([SAMPLE.name, "", SAMPLE.fileName, "Delete"]);
    expect(list).toHaveBeenCalledOnce();
  });

  it("says 'Loading library files...' until the first read answers, then 'No library files yet' when there are none", async () => {
    const answer = deferred<{ libraryFiles: LibraryFile[] }>();
    list.mockReturnValueOnce(answer.promise);
    renderPage();

    expect(await screen.findByText("Loading library files...")).toBeInTheDocument();
    answer.resolve({ libraryFiles: [] });

    expect(await screen.findByRole("cell", { name: "No library files yet" })).toBeInTheDocument();
    expect(screen.queryByText("Loading library files...")).toBeNull();
  });

  it("toasts 'Failed to load library files' when the read fails, and nothing when the session has ended", async () => {
    list.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    renderPage();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(LIBRARY_LOAD_FAILED_MESSAGE));
    expect(LIBRARY_LOAD_FAILED_MESSAGE).toBe("Failed to load library files");

    toastError.mockClear();
    list.mockRejectedValueOnce(SESSION_ENDED);
    renderPage();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(toastError).not.toHaveBeenCalled();
  });

  it("gives up on a read that never answers after 10 s: 'Failed to load library files', the loading line gone", async () => {
    vi.useFakeTimers();
    try {
      list.mockImplementation(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
          }),
      );
      renderPage();
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("Loading library files...")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(LIBRARY_REQUEST_TIMEOUT_MS));

      expect(toastError).toHaveBeenCalledWith(LIBRARY_LOAD_FAILED_MESSAGE);
      expect(screen.queryByText("Loading library files...")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes to /app when the read is refused for the flag, replacing the page", async () => {
    list.mockRejectedValueOnce(FORBIDDEN);
    renderPage();

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("adding a library file (the dialog)", () => {
  it("shows 'New Library File' with its fields, placeholders and limits", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New File" }));
    const dialog = await screen.findByRole("dialog", { name: "New Library File" });

    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "e.g., Getting started guide");
    expect(name).toHaveAttribute("maxlength", "200");
    const description = within(dialog).getByLabelText("Description");
    expect(description).toHaveAttribute("placeholder", "Optional — describe what this file contains");
    expect(description).toHaveAttribute("maxlength", "2000");
    expect(within(dialog).getByText("File")).toBeInTheDocument();
    expect(within(dialog).getByText("No file selected")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose file" })).toHaveAttribute("title", "Choose file");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("shows every validation message at once on Create, sending nothing; each goes as its field is filled", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New File" }));
    const dialog = await screen.findByRole("dialog", { name: "New Library File" });
    const messages = () => within(dialog).queryAllByRole("alert").map((alert) => alert.textContent);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(messages()).toEqual(["Please enter a name.", "Please choose a file."]);

    await user.type(within(dialog).getByLabelText("Name"), "zq-a");
    expect(messages()).toEqual(["Please choose a file."]);
    await user.upload(picker(), new File(["{}"], "zq-a.json"));
    expect(messages()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates it from the trimmed fields and the file (its name shown as text), 'Creating…' and not closable meanwhile; 'Library file created', the list read again, the dialog closed", async () => {
    const answer = deferred<{ libraryFile: LibraryFile }>();
    create.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    const file = new File(["%PDF-1.7"], "zq-chosen.pdf", { type: "application/pdf" });
    const dialog = await fillNew(user, file);
    expect(within(dialog).getByText("zq-chosen.pdf")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(create).toHaveBeenCalledWith({ name: "zq-new-file", description: "zq-new-description", file });
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New Library File" })).toBeInTheDocument();

    answer.resolve({ libraryFile: GUIDE });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Library file created");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("sends an empty description as '' (none), and takes any type of file", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New File" }));
    const dialog = await screen.findByRole("dialog", { name: "New Library File" });
    await user.type(within(dialog).getByLabelText("Name"), "zq-bare");
    const file = new File([new Uint8Array([0, 1, 2])], "zq-tool.tar.gz", { type: "application/gzip" });
    await user.upload(picker(), file);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "zq-bare", description: "", file }));
  });

  it.each([
    ["a file over 10 MiB", sized("zq-huge.bin", 10 * 1024 * 1024 + 1), LIBRARY_FILE_TOO_LARGE_MESSAGE],
    ["a name starting with -", new File(["x"], "-zq-option"), 'File name can\'t start with "-".'],
    ["a name with a backslash", new File(["x"], "zq\\a.txt"), 'File name can\'t contain "/" or "\\".'],
    ["a name with a control character", new File(["x"], "zq\u0007.txt"), "File name can't contain control or formatting characters."],
    ["a name with U+202E", new File(["x"], "zq\u202Etxt.exe"), "File name can't contain control or formatting characters."],
    ["a name with U+200F", new File(["x"], "zq\u200Fa.txt"), "File name can't contain control or formatting characters."],
    ["a name of 256 characters", new File(["x"], `zq${"a".repeat(254)}`), "File name must be 1 to 255 characters."],
    ["a name with a slash", new File(["x"], "zq/a.txt"), 'File name can\'t contain "/" or "\\".'],
    ["the name .", new File(["x"], "."), 'File name can\'t be "." or "..".'],
    ["the name ..", new File(["x"], ".."), 'File name can\'t be "." or "..".'],
    // A File's name is a USVString (a lone surrogate becomes U+FFFD), so the name is set on the object itself.
    [
      "a name with a lone surrogate",
      Object.defineProperty(new File(["x"], "zq.txt"), "name", { value: "zq\uD800.txt" }),
      "File name contains a character that can't be stored.",
    ],
  ])("refuses %s as it is picked: fixed words under the field, and Create sends nothing", async (_what, file, words) => {
    const { user } = renderPage();
    const dialog = await fillNew(user, file);

    expect(within(dialog).getByRole("alert")).toHaveTextContent(words);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(create).not.toHaveBeenCalled();

    // Another file, one it takes: the words go, and Create sends it.
    await user.upload(picker(), new File(["{}"], "zq-fine.json"));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
  });

  it.each([
    ["a Persian name with a zero-width non-joiner", "zq-\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt"],
    ["an emoji ZWJ sequence", "zq-\u{1F469}\u200D\u{1F4BB}.txt"],
    ["a soft hyphen", "zq-re\u00ADsume.pdf"],
  ])("takes %s: no words under the field, and Create sends it", async (_what, name) => {
    const { user } = renderPage();
    const file = new File(["x"], name);
    const dialog = await fillNew(user, file);

    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "zq-new-file", description: "zq-new-description", file }));
  });

  it("names any other reason the contract may give in fixed words, never the name (FILE_NAME_REFUSED)", () => {
    vi.spyOn(contracts, "libraryFileFileNameProblem").mockReturnValueOnce("a reason added later");

    expect(libraryFileRefusal(new File(["x"], "zq-name.txt"))).toBe("This file's name can't be used. Rename it and choose it again.");
  });

  it("takes a file of exactly 10 MiB", () => {
    expect(LIBRARY_FILE_TOO_LARGE_MESSAGE).toBe("File must be 10 MB or smaller.");
    expect(libraryFileRefusal(sized("zq-edge.bin", 10 * 1024 * 1024))).toBeNull();
    expect(libraryFileRefusal(sized("zq-edge.bin", 10 * 1024 * 1024 + 1))).toBe(LIBRARY_FILE_TOO_LARGE_MESSAGE);
    // The file's name, never in the words.
    expect(libraryFileRefusal(new File(["x"], "-zq"))).not.toContain("zq");
  });

  it.each([
    [new ApiError("library_file_too_large", API_TOO_LARGE, { status: 413 }), API_TOO_LARGE],
    [new ApiError("invalid_request", "The request was not valid.", { status: 400 }), "Failed to create library file"],
    [new ApiError("unexpected_response", "Unexpected response", { status: 500 }), "Failed to create library file"],
  ])("shows a refusal by the API's words, else 'Failed to create library file' (%s), staying open with Create pressable", async (error, words) => {
    create.mockRejectedValueOnce(error);
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-a.json"));

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    create.mockRejectedValueOnce(SESSION_ENDED);
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-a.json"));

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
  });

  it("starts empty each time it opens, the last file forgotten", async () => {
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-a.json"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "New File" }));
    const again = await screen.findByRole("dialog", { name: "New Library File" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
    expect(within(again).getByText("No file selected")).toBeInTheDocument();
    expect(picker().value).toBe("");
  });
});

describe("editing a library file (name and description only)", () => {
  it("opens 'Edit Library File' from the name, filled from the row, without a file; Save sends only the changed fields, by id; 'Saving…'; 'Library file updated'", async () => {
    const answer = deferred<{ libraryFile: LibraryFile }>();
    update.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue(GUIDE.name);
    expect(within(dialog).getByLabelText("Description")).toHaveValue(GUIDE.description);
    expect(picker()).toBeNull();
    expect(within(dialog).queryByText("File")).toBeNull();

    await user.clear(within(dialog).getByLabelText("Description"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(update).toHaveBeenCalledWith(GUIDE.id, { description: "" });
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    answer.resolve({ libraryFile: GUIDE });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Library file updated");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("sends a trimmed new name alone", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), " zq-renamed ");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(GUIDE.id, { name: "zq-renamed" }));
  });

  it("closes without a request when nothing changed: the API asks for a change", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a name cleared out as 'Please enter a name.', sending nothing", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    await user.clear(within(dialog).getByLabelText("Name"));

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Please enter a name.");
    expect(update).not.toHaveBeenCalled();
  });

  it("shows 'Failed to update library file' for a failure the API's words don't explain, staying open", async () => {
    update.mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400 }));
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    await user.type(within(dialog).getByLabelText("Name"), "x");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to update library file"));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("closes the edit of a file deleted meanwhile (404) on the API's words, and reads the list again, its row gone", async () => {
    update.mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    await user.type(within(dialog).getByLabelText("Name"), "x");
    list.mockResolvedValueOnce({ libraryFiles: [SAMPLE] });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Library file not found");
    expect(screen.queryByRole("button", { name: GUIDE.name })).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("deleting a library file (the confirmation)", () => {
  it("asks 'Delete Library File' by the file's name; Cancel deletes nothing", async () => {
    const { user } = renderPage();
    await screen.findByRole("button", { name: GUIDE.name });
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Library File" });

    expect(dialog).toHaveTextContent(`Are you sure you want to delete "${GUIDE.name}"? This action cannot be undone.`);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes it by id, 'Deleting…' and not closable meanwhile; 'Library file deleted', the list read again, the focus on New File", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    await screen.findByRole("button", { name: GUIDE.name });
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Library File" });

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(remove).toHaveBeenCalledWith(GUIDE.id);
    expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    list.mockResolvedValueOnce({ libraryFiles: [SAMPLE] });
    answer.resolve(undefined);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Library file deleted");
    expect(screen.queryByRole("button", { name: GUIDE.name })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "New File" })).toHaveFocus());
  });

  it("counts a file deleted meanwhile (404) as deleted, and shows 'Failed to delete library file' for a failure, staying open", async () => {
    remove.mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    await screen.findByRole("button", { name: GUIDE.name });
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete Library File" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Library file deleted"));

    remove.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await user.click(within(rowOf(SAMPLE.name)).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Library File" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete library file"));
    expect(screen.getByRole("dialog", { name: "Delete Library File" })).toBeInTheDocument();
  });
});

describe("the flag cleared mid-visit (403 product_admin_required)", () => {
  it("goes to /app from a create, replacing the page", async () => {
    create.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-a.json"));

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("goes to /app from an edit", async () => {
    update.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: GUIDE.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Library File" });
    await user.type(within(dialog).getByLabelText("Name"), "x");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
  });

  it("goes to /app from a delete", async () => {
    remove.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    await screen.findByRole("button", { name: GUIDE.name });
    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete Library File" })).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
  });
});

describe("replay's rules", () => {
  it("keeps the hidden file input and the chosen file's name inside ph-no-capture, the name as text, never an input's value", async () => {
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-chosen-name.json"));

    expect(picker().closest(".ph-no-capture")).not.toBeNull();
    const shown = within(dialog).getByText("zq-chosen-name.json");
    expect(shown.tagName).not.toBe("INPUT");
    expect(shown.closest(".ph-no-capture")).not.toBeNull();
    for (const input of dialog.querySelectorAll('input:not([type="file"]), textarea')) {
      expect((input as HTMLInputElement).value).not.toContain("zq-chosen-name");
    }
  });

  it("puts no file's name, file name or description in any attribute, with the table, both dialogs and the confirmation shown; names each button by text, and the API by id", async () => {
    /** Every attribute in the document carrying a marker; an input's value is masked by replay (maskAllInputs). */
    const markedAttributes = () => {
      const markers: string[] = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
      return markers;
    };
    const { user } = renderPage();
    await screen.findByRole("button", { name: GUIDE.name });
    expect(markedAttributes()).toEqual([]);
    expect(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" })).toHaveAccessibleDescription(GUIDE.name);

    await fillNew(user, new File(["{}"], "zq-chosen-name.json"));
    expect(markedAttributes()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: GUIDE.name }));
    await screen.findByRole("dialog", { name: "Edit Library File" });
    expect(markedAttributes()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(rowOf(GUIDE.name)).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete Library File" });
    expect(markedAttributes()).toEqual([]);
    expect(pageAddress).toBe("/product-admin/library");
  });

  it("toasts fixed words only, never a name", async () => {
    const { user } = renderPage();
    const dialog = await fillNew(user, new File(["{}"], "zq-a.json"));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    for (const [message] of [...toastSuccess.mock.calls, ...toastError.mock.calls]) expect(String(message)).not.toContain("zq");
  });
});
