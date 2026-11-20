import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { TEST_TEMPLATE_RECEIVER_TYPES, type TestTemplate } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import { TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE, TestTemplatesPage } from "./TestTemplatesPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { RUNS_REQUEST_TIMEOUT_MS } from "~/lib/stores/testing-store.js";
import { receiverTypeLabel } from "~/lib/test-templates/labels.js";

/*
 * Product admin's Test Templates page, its dialog and its confirmation: the
 * table and its labels, the empty state, create (each validation message, the
 * file's checks, the API's refusals), edit (metadata only, the changed
 * fields), delete (the confirmation), the toasts, the way out when the flag is
 * cleared mid-visit, and replay's rules (the hidden file input and the chosen
 * name blocked; no name in an attribute or a URL).
 *
 * The API is its client's functions, spied on; toasts are spied on. Names,
 * descriptions and file names carry the private-text marker "zq".
 */

function templateFixture(overrides: Partial<TestTemplate> = {}): TestTemplate {
  return {
    id: "0199f200-0000-7000-8000-000000000001",
    name: "zq-otlp-traces",
    description: "zq-template-description",
    receiverType: "otlp",
    signal: "traces",
    fileName: "zq-otlp-traces.json",
    contentType: "application/json",
    sizeBytes: 20,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

const OTLP_TRACES = templateFixture();
const FILE_LINES = templateFixture({
  id: "0199f200-0000-7000-8000-000000000002",
  name: "zq-app-lines",
  description: "",
  receiverType: "filelog",
  signal: "logs",
  fileName: "zq-app-lines.log",
});
/** A stored type the list lacks (the table checks only its shape) and a signal by its words. */
const UNLISTED = templateFixture({
  id: "0199f200-0000-7000-8000-000000000003",
  name: "zq-unlisted",
  receiverType: "kubelet_zz",
  signal: "metrics",
  fileName: "zq-unlisted.json",
});
const TEMPLATES = [OTLP_TRACES, FILE_LINES, UNLISTED];

const FORBIDDEN = new ApiError("product_admin_required", "Only product admins can do that.", { status: 403 });
const NOT_FOUND = new ApiError("test_template_not_found", "Test template not found", { status: 404 });
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
const TOO_LARGE = "The file is larger than 10 MiB.";
const TYPE_UNSUPPORTED = "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.";

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

/** The router's address as the page last rendered under it: path, query and hash. */
let pageAddress = "";

function TestTemplatesPageAt() {
  const location = useLocation();
  pageAddress = location.pathname + location.search + location.hash;
  return <TestTemplatesPage />;
}

function renderPage() {
  pageAddress = "";
  const Stub = createRoutesStub([
    { path: "/product-admin/test-templates", Component: TestTemplatesPageAt },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/test-templates"]} />);
  // The file checks are the page's own, so the picker's filter mustn't drop a file first.
  return { user: userEvent.setup({ applyAccept: false }) };
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

let listTemplates: MockInstance<typeof apiClient.getTestTemplates>;
let create: MockInstance<typeof apiClient.createTestTemplate>;
let update: MockInstance<typeof apiClient.updateTestTemplate>;
let remove: MockInstance<typeof apiClient.deleteTestTemplate>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

beforeEach(() => {
  vi.restoreAllMocks();
  listTemplates = vi.spyOn(apiClient, "getTestTemplates").mockResolvedValue({ templates: TEMPLATES });
  create = vi.spyOn(apiClient, "createTestTemplate").mockResolvedValue({ template: OTLP_TRACES });
  update = vi.spyOn(apiClient, "updateTestTemplate").mockResolvedValue({ template: OTLP_TRACES });
  remove = vi.spyOn(apiClient, "deleteTestTemplate").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr")!;
}

/** The hidden file input. */
const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

async function choose(user: ReturnType<typeof userEvent.setup>, field: "Receiver type" | "Signal type", option: string) {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens New Template and fills every field, the file `file`. */
async function fillNew(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.click(await screen.findByRole("button", { name: "New Template" }));
  const dialog = await screen.findByRole("dialog", { name: "New Test Template" });
  await user.type(within(dialog).getByLabelText("Name"), "  zq-new-template  ");
  await choose(user, "Receiver type", "File Log");
  await choose(user, "Signal type", "Logs");
  await user.type(within(dialog).getByLabelText("Description"), " zq-new-description ");
  await user.upload(picker(), file);
  return dialog;
}

describe("the Test Templates page", () => {
  it("shows the header and table: Name, Receiver Type and Signal Type by their labels (raw as a fallback), Delete; the list from GET /api/v1/test-templates", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: OTLP_TRACES.name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Test Templates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Template" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Receiver Type",
      "Signal Type",
      "Actions",
    ]);
    const cells = (name: string) => within(rowOf(name)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells(OTLP_TRACES.name)).toEqual([OTLP_TRACES.name, "OTLP", "Traces", "Delete"]);
    expect(cells(FILE_LINES.name)).toEqual([FILE_LINES.name, "File Log", "Logs", "Delete"]);
    expect(cells(UNLISTED.name)).toEqual([UNLISTED.name, "kubelet_zz", "Metrics", "Delete"]);
    expect(listTemplates).toHaveBeenCalledOnce();
  });

  it("says 'Loading templates...' until the first read answers, then 'No test templates yet' when there are none", async () => {
    const answer = deferred<{ templates: TestTemplate[] }>();
    listTemplates.mockReturnValueOnce(answer.promise);
    renderPage();

    expect(await screen.findByText("Loading templates...")).toBeInTheDocument();
    answer.resolve({ templates: [] });

    expect(await screen.findByRole("cell", { name: "No test templates yet" })).toBeInTheDocument();
    expect(screen.queryByText("Loading templates...")).toBeNull();
  });

  it("toasts 'Failed to load test template files' when the read fails, and nothing when the session has ended", async () => {
    listTemplates.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    renderPage();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE));
    expect(TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE).toBe("Failed to load test template files");
  });

  it("gives up on a read that never answers after 10 s, as the Testing tab's reads do: 'Failed to load test template files', the loading line gone", async () => {
    vi.useFakeTimers();
    try {
      // Answers only by its abort, as the client does.
      listTemplates.mockImplementation(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
          }),
      );
      renderPage();
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("Loading templates...")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1));
      expect(toastError).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(toastError).toHaveBeenCalledWith(TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE);
      expect(screen.queryByText("Loading templates...")).toBeNull();
      expect(listTemplates).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("toasts nothing for a read refused because the session has ended", async () => {
    listTemplates.mockRejectedValueOnce(SESSION_ENDED);
    renderPage();
    await waitFor(() => expect(listTemplates).toHaveBeenCalledOnce());
    await screen.findByRole("cell", { name: "No test templates yet" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows only the latest read: an earlier one answering last doesn't overwrite it", async () => {
    const first = deferred<{ templates: TestTemplate[] }>();
    listTemplates.mockReturnValueOnce(first.promise).mockResolvedValue({ templates: [OTLP_TRACES] });
    const { user } = renderPage();
    // The first read waits; a create reads again, and that one answers first.
    await user.click(await screen.findByRole("button", { name: "New Template" }));
    await user.type(screen.getByLabelText("Name"), "zq-x");
    await choose(user, "Receiver type", "OTLP");
    await choose(user, "Signal type", "Traces");
    await user.upload(picker(), new File(["{}"], "zq-x.json"));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: OTLP_TRACES.name });

    first.resolve({ templates: [FILE_LINES] });
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: FILE_LINES.name })).toBeNull();
    expect(screen.getByRole("button", { name: OTLP_TRACES.name })).toBeInTheDocument();
  });

  it("toasts nothing for an earlier read failing after a later one succeeded: only the latest read speaks", async () => {
    const first = deferred<{ templates: TestTemplate[] }>();
    listTemplates.mockReturnValueOnce(first.promise).mockResolvedValue({ templates: [OTLP_TRACES] });
    const { user } = renderPage();
    // The first read waits; a create reads again, and that one answers first.
    await user.click(await screen.findByRole("button", { name: "New Template" }));
    await user.type(screen.getByLabelText("Name"), "zq-x");
    await choose(user, "Receiver type", "OTLP");
    await choose(user, "Signal type", "Traces");
    await user.upload(picker(), new File(["{}"], "zq-x.json"));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: OTLP_TRACES.name });

    // The earlier read fails now: its failure is handled once the rejection has been seen.
    await act(async () => {
      first.reject(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
      await first.promise.catch(() => undefined);
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: OTLP_TRACES.name })).toBeInTheDocument();
  });
});

describe("creating a template (the dialog)", () => {
  it("shows 'New Test Template' with its fields, placeholders and limits; the receiver types are the API's list by palette label; the signals Traces, Logs, Metrics", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New Template" }));
    const dialog = await screen.findByRole("dialog", { name: "New Test Template" });

    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "e.g., OTLP trace sample");
    expect(name).toHaveAttribute("maxlength", "200");
    expect(name).toHaveFocus();
    const description = within(dialog).getByLabelText("Description");
    expect(description).toHaveAttribute("placeholder", "Optional — describe what this template contains");
    expect(description).toHaveAttribute("maxlength", "2000");
    expect(within(dialog).getByRole("combobox", { name: "Receiver type" })).toHaveTextContent("Select receiver type…");
    expect(within(dialog).getByRole("combobox", { name: "Signal type" })).toHaveTextContent("Select signal type…");
    expect(within(dialog).getByText("No file selected")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose file" })).toHaveAttribute("title", "Choose file");
    expect(picker()).toHaveAttribute(
      "accept",
      ".json,.ndjson,.yaml,.yml,.txt,.log,application/json,application/x-ndjson,application/ndjson,application/x-yaml,text/yaml,text/plain",
    );
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "Receiver type" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(
      TEST_TEMPLATE_RECEIVER_TYPES.map(receiverTypeLabel),
    );
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("combobox", { name: "Signal type" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Traces", "Logs", "Metrics"]);
  });

  it("shows every validation message at once on Create, sending nothing; each goes as its field is filled", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New Template" }));
    const dialog = await screen.findByRole("dialog", { name: "New Test Template" });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    const messages = () => within(dialog).queryAllByRole("alert").map((alert) => alert.textContent);
    expect(messages()).toEqual([
      "Please enter a name.",
      "Please select a receiver type.",
      "Please select a signal type.",
      "Please choose a file.",
    ]);
    expect(create).not.toHaveBeenCalled();

    // A name of spaces isn't one.
    await user.type(within(dialog).getByLabelText("Name"), "   ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(messages()).toContain("Please enter a name.");

    await user.type(within(dialog).getByLabelText("Name"), "zq-a");
    expect(messages()).toEqual(["Please select a receiver type.", "Please select a signal type.", "Please choose a file."]);
    await choose(user, "Receiver type", "OTLP");
    expect(messages()).toEqual(["Please select a signal type.", "Please choose a file."]);
    await choose(user, "Signal type", "Traces");
    expect(messages()).toEqual(["Please choose a file."]);
    await user.upload(picker(), new File(["{}"], "zq-a.json"));
    expect(messages()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates it from the trimmed fields and the file (its name shown as text), 'Creating…' and not closable meanwhile; 'Template created', the list read again, the dialog closed", async () => {
    const answer = deferred<{ template: TestTemplate }>();
    create.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    const file = new File(['{"resourceLogs":[]}'], "zq-chosen.json", { type: "application/json" });
    const dialog = await fillNew(user, file);
    expect(within(dialog).getByText("zq-chosen.json")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(create).toHaveBeenCalledWith({
      name: "zq-new-template",
      description: "zq-new-description",
      receiverType: "filelog",
      signal: "logs",
      file,
    });
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New Test Template" })).toBeInTheDocument();

    answer.resolve({ template: OTLP_TRACES });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Template created");
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a type it doesn't take", new File(["a,b"], "zq-table.csv"), TYPE_UNSUPPORTED],
    ["a file over 10 MiB", Object.defineProperty(new File(["{}"], "zq-huge.json"), "size", { value: 10 * 1024 * 1024 + 1 }), TOO_LARGE],
  ])("checks the file as it is picked (%s): the API's words under the field, and Create sends nothing", async (_what, file, words) => {
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
    [new ApiError("test_file_too_large", TOO_LARGE, { status: 413 }), TOO_LARGE],
    [new ApiError("test_file_type_unsupported", TYPE_UNSUPPORTED, { status: 415 }), TYPE_UNSUPPORTED],
    [new ApiError("invalid_request", "The request was not valid.", { status: 400 }), "Failed to create template"],
    [new ApiError("unexpected_response", "Unexpected response", { status: 500 }), "Failed to create template"],
  ])("shows a refusal by the API's words, else 'Failed to create template' (%s), staying open with Create pressable", async (error, words) => {
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

    await user.click(screen.getByRole("button", { name: "New Template" }));
    const again = await screen.findByRole("dialog", { name: "New Test Template" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
    expect(within(again).getByText("No file selected")).toBeInTheDocument();
    expect(picker().value).toBe("");
  });
});

describe("editing a template (metadata only)", () => {
  it("opens 'Edit Test Template' from the name, filled from the row, without a file; Save sends only the changed fields, by id; 'Saving…'; 'Template updated'", async () => {
    const answer = deferred<{ template: TestTemplate }>();
    update.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();

    await user.click(await screen.findByRole("button", { name: FILE_LINES.name }));

    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue(FILE_LINES.name);
    expect(within(dialog).getByRole("combobox", { name: "Receiver type" })).toHaveTextContent("File Log");
    expect(within(dialog).getByRole("combobox", { name: "Signal type" })).toHaveTextContent("Logs");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("");
    expect(within(dialog).queryByText("File")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), " zq-renamed ");
    await choose(user, "Signal type", "Metrics");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(update).toHaveBeenCalledWith(FILE_LINES.id, { name: "zq-renamed", signal: "metrics" });
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    answer.resolve({ template: FILE_LINES });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Template updated");
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it("shows a name cleared out as 'Please enter a name.', sending nothing", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: OTLP_TRACES.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(within(dialog).getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["Please enter a name."]);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a stored receiver type the list lacks, shown as it is, and doesn't send it back", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: UNLISTED.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });
    expect(within(dialog).getByRole("combobox", { name: "Receiver type" })).toHaveTextContent("kubelet_zz");

    await user.type(within(dialog).getByLabelText("Description"), "-more");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(UNLISTED.id, { description: "zq-template-description-more" }));
  });

  it("shows 'Failed to update template' for a failure the API's words don't explain, staying open", async () => {
    update.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: OTLP_TRACES.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to update template"));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "Edit Test Template" })).toBe(dialog);
    expect(listTemplates).toHaveBeenCalledOnce();
  });

  it("closes the edit of a template deleted meanwhile (404, another admin's doing) on the API's words, and reads the list again, its row gone", async () => {
    update.mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: OTLP_TRACES.name }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });
    listTemplates.mockResolvedValue({ templates: [FILE_LINES, UNLISTED] });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Test template not found");
    expect(toastError).toHaveBeenCalledOnce();
    expect(listTemplates).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: OTLP_TRACES.name })).toBeNull();
    expect(screen.getByRole("button", { name: FILE_LINES.name })).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    // The name that opened it went with its row: the focus goes to "New Template", not the body.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Template" }));
  });
});

describe("deleting a template (the confirmation)", () => {
  it("asks 'Delete Test Template' by the template's name; Cancel deletes nothing", async () => {
    const { user } = renderPage();
    await screen.findByRole("button", { name: FILE_LINES.name });
    await user.click(within(rowOf(FILE_LINES.name)).getByRole("button", { name: "Delete" }));

    const confirmation = await screen.findByRole("dialog", { name: "Delete Test Template" });
    expect(confirmation).toHaveAccessibleDescription(
      `Are you sure you want to delete "${FILE_LINES.name}"? This action cannot be undone.`,
    );
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes it by id, 'Deleting…' and not closable meanwhile; 'Template deleted', the list read again", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    await user.click(within(await waitFor(() => rowOf(OTLP_TRACES.name))).getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Test Template" });
    listTemplates.mockResolvedValue({ templates: [FILE_LINES, UNLISTED] });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(remove).toHaveBeenCalledWith(OTLP_TRACES.id);
    expect(within(confirmation).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Delete Test Template" })).toBeInTheDocument();

    answer.resolve(undefined);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Template deleted");
    await waitFor(() => expect(screen.queryByRole("button", { name: OTLP_TRACES.name })).toBeNull());
    // The Delete that opened it went with its row: the focus goes to "New Template", not the body.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Template" }));
  });

  it("shows a refusal by the API's own words, staying open; and nothing for a session that has ended", async () => {
    remove
      .mockRejectedValueOnce(new ApiError("test_template_in_use", "The API's own words.", { status: 409 }))
      .mockRejectedValueOnce(SESSION_ENDED);
    const { user } = renderPage();
    await user.click(within(await waitFor(() => rowOf(OTLP_TRACES.name))).getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Test Template" });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The API's own words."));
    expect(screen.getByRole("dialog", { name: "Delete Test Template" })).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "Delete" })).toBeEnabled();

    toastError.mockClear();
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    // Settled: the button back from "Deleting…".
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Delete" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("counts a template deleted meanwhile (404) as deleted, and shows 'Failed to delete template' for a failure, staying open", async () => {
    remove.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 })).mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    await user.click(within(await waitFor(() => rowOf(OTLP_TRACES.name))).getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Test Template" });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete template"));
    expect(screen.getByRole("dialog", { name: "Delete Test Template" })).toBeInTheDocument();

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Template deleted"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves the focus to 'New Template' after a delete answered 404, the row gone on the re-read, not to the body", async () => {
    remove.mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    await user.click(within(await waitFor(() => rowOf(OTLP_TRACES.name))).getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Test Template" });
    listTemplates.mockResolvedValue({ templates: [FILE_LINES, UNLISTED] });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Template deleted");
    expect(screen.queryByRole("button", { name: OTLP_TRACES.name })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Template" }));
  });
});

describe("the focus as a dialog closes (no Radix trigger, so not the body)", () => {
  const newTemplate = () => screen.getByRole("button", { name: "New Template" });

  it("goes back to 'New Template' from the new template's dialog: Cancel, Escape and a create", async () => {
    const { user } = renderPage();
    await screen.findByRole("button", { name: OTLP_TRACES.name });

    await user.click(newTemplate());
    await user.click(within(await screen.findByRole("dialog", { name: "New Test Template" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(newTemplate()));

    await user.click(newTemplate());
    await screen.findByRole("dialog", { name: "New Test Template" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(newTemplate()));

    const dialog = await fillNew(user, new File(["{}"], "zq-new.json", { type: "application/json" }));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(newTemplate()));
  });

  it("goes back to the row's name from the edit dialog: Cancel, Escape and a save", async () => {
    const { user } = renderPage();
    const name = () => screen.getByRole("button", { name: FILE_LINES.name });
    await screen.findByRole("button", { name: FILE_LINES.name });

    await user.click(name());
    await user.click(within(await screen.findByRole("dialog", { name: "Edit Test Template" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name()));

    await user.click(name());
    await screen.findByRole("dialog", { name: "Edit Test Template" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name()));

    await user.click(name());
    const dialog = await screen.findByRole("dialog", { name: "Edit Test Template" });
    await user.type(within(dialog).getByLabelText("Description"), "zq-more");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(name()));
  });

  it("goes back to the row's Delete from the confirmation: Cancel and Escape", async () => {
    const { user } = renderPage();
    await screen.findByRole("button", { name: FILE_LINES.name });
    const remover = () => within(rowOf(FILE_LINES.name)).getByRole("button", { name: "Delete" });

    await user.click(remover());
    await user.click(within(await screen.findByRole("dialog", { name: "Delete Test Template" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remover()));

    await user.click(remover());
    await screen.findByRole("dialog", { name: "Delete Test Template" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remover()));
    expect(remove).not.toHaveBeenCalled();
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
    await user.click(await screen.findByRole("button", { name: OTLP_TRACES.name }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
  });

  it("goes to /app from a delete", async () => {
    remove.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    await user.click(within(await waitFor(() => rowOf(OTLP_TRACES.name))).getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
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
    // Only the file input holds it ("C:\fakepath\…", which is why it is blocked); no field shows it as a value.
    for (const input of dialog.querySelectorAll('input:not([type="file"]), textarea')) {
      expect((input as HTMLInputElement).value).not.toContain("zq-chosen-name");
    }
  });

  it("puts no template or file name, nor a description, in any attribute, with the table, both dialogs and the confirmation shown; names each button by text, and the API by id", async () => {
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
    await screen.findByRole("button", { name: OTLP_TRACES.name });
    expect(markedAttributes()).toEqual([]);
    // Each Delete is described by its row's name, from text.
    expect(within(rowOf(OTLP_TRACES.name)).getByRole("button", { name: "Delete" })).toHaveAccessibleDescription(OTLP_TRACES.name);

    await fillNew(user, new File(["{}"], "zq-chosen-name.json"));
    expect(markedAttributes()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: OTLP_TRACES.name }));
    await screen.findByRole("dialog", { name: "Edit Test Template" });
    expect(markedAttributes()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledWith(OTLP_TRACES.id, {});

    await user.click(within(rowOf(OTLP_TRACES.name)).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete Test Template" });
    expect(markedAttributes()).toEqual([]);
    // Nothing of it in the router's address: the page never moved.
    expect(pageAddress).toBe("/product-admin/test-templates");
  });
});
