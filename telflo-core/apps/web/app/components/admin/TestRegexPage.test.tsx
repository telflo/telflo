import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { TestRegex } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import { TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE, TestRegexPage } from "./TestRegexPage.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { RUNS_REQUEST_TIMEOUT_MS } from "~/lib/stores/testing-store.js";

/*
 * Product admin's Test Regex page (D15b Task 3: decisions 8, 9 and 12;
 * Preflight rulings 16 and 17), its dialog and its confirmation, with D14b's
 * admin-page conventions: the table in the API's order, the empty, loading
 * and failed states, create, edit and delete with each refusal where it
 * belongs (the evaluator's under Regex, the name's clash under Name, the
 * check's 429 and 503 in a toast), the re-read after each write, the way out
 * when the flag is cleared mid-visit, the focus as each dialog closes, and
 * replay's rules (everything inside `ph-no-capture`, no entry's text in an
 * attribute).
 *
 * The API is its client's functions, spied on; toasts are spied on. Every
 * entry's name, category, description and regex carries the private-text
 * marker "zq".
 */

function regexFixture(overrides: Partial<TestRegex> = {}): TestRegex {
  return {
    id: "0199f300-0000-7000-8000-000000000001",
    name: "zq-Email Address",
    category: "zq-PII",
    description: "zq-matches emails",
    regex: "zq[a-z]+@[a-z]+\\.com",
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

const EMAIL = regexFixture();
const AWS_KEY = regexFixture({
  id: "0199f300-0000-7000-8000-000000000002",
  name: "zq-AWS Access Key",
  category: "zq-Secrets",
  description: null,
  regex: "zq\\bAKIA[0-9A-Z]{16}\\b",
});
/** A long regex with spaces: shown in full, wrapped. */
const LONG = regexFixture({
  id: "0199f300-0000-7000-8000-000000000003",
  name: "zq-Long one",
  category: "zq-Network",
  description: "zq-long",
  regex: `zq ${"(?:[0-9]{1,3}\\.){3}[0-9]{1,3} ".repeat(12)}end`,
});
/** The API's order (category, then name); the page shows it as it comes, here deliberately not alphabetical by name. */
const LIBRARY = [EMAIL, LONG, AWS_KEY];

const FORBIDDEN = new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 });
const NOT_FOUND = new ApiError("test_regex_not_found", "Test regex not found", { status: 404 });
const SESSION_ENDED = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
const NAME_TAKEN = new ApiError("test_regex_name_taken", "A regex with that name already exists.", { status: 409 });
const INVALID_WORDS = "Invalid regex: error parsing regexp: missing closing ): `(zq`";
const INVALID = new ApiError("test_regex_invalid", INVALID_WORDS, {
  status: 400,
  details: { problems: [{ field: "regex", message: INVALID_WORDS }] },
});
const RATE_LIMITED = new ApiError("validation_rule_rate_limited", "Too many rule checks in the last minute. Try again shortly.", {
  status: 429,
  retryAfterSeconds: 30,
});
const UNAVAILABLE = new ApiError("rules_unavailable", "Rules can't be checked right now. Try again shortly.", { status: 503 });
const SERVER_ERROR = new ApiError("unexpected_response", "Unexpected response", { status: 500 });

/** A toast carrying an error's words: blocked from replay (Preflight ruling 17). */
const PRIVATE = { className: "ph-no-capture" };

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

/** The router's address as the page last rendered under it: path, query and hash. */
let pageAddress = "";

function TestRegexPageAt() {
  const location = useLocation();
  pageAddress = location.pathname + location.search + location.hash;
  return <TestRegexPage />;
}

function renderPage() {
  pageAddress = "";
  const Stub = createRoutesStub([
    { path: "/product-admin/test-regex", Component: TestRegexPageAt },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/test-regex"]} />);
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

let listRegexes: MockInstance<typeof apiClient.getTestRegexes>;
let create: MockInstance<typeof apiClient.createTestRegex>;
let update: MockInstance<typeof apiClient.updateTestRegex>;
let remove: MockInstance<typeof apiClient.deleteTestRegex>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

beforeEach(() => {
  vi.restoreAllMocks();
  listRegexes = vi.spyOn(apiClient, "getTestRegexes").mockResolvedValue({ testRegexes: LIBRARY });
  create = vi.spyOn(apiClient, "createTestRegex").mockResolvedValue({ testRegex: EMAIL });
  update = vi.spyOn(apiClient, "updateTestRegex").mockResolvedValue({ testRegex: EMAIL });
  remove = vi.spyOn(apiClient, "deleteTestRegex").mockResolvedValue(undefined);
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

type User = ReturnType<typeof userEvent.setup>;

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr")!;
}

/** The names, top to bottom. */
const shownNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

/** Every alert's words in `dialog`. */
const alertsIn = (dialog: HTMLElement) => within(dialog).queryAllByRole("alert").map((alert) => alert.textContent);

/** Opens New Regex and fills every field. */
async function fillNew(user: User, fields: { name?: string; category?: string; regex?: string; description?: string } = {}) {
  await user.click(await screen.findByRole("button", { name: "New Regex" }));
  const dialog = await screen.findByRole("dialog", { name: "New Test Regex" });
  await user.type(within(dialog).getByLabelText("Name"), fields.name ?? "  zq-new regex  ");
  await user.type(within(dialog).getByLabelText("Category"), fields.category ?? " zq-Network ");
  // userEvent's type reads `{` and `[` as keys: paste the regex as it is.
  await user.click(within(dialog).getByLabelText("Regex"));
  await user.paste(fields.regex ?? " zq\\d{3} ");
  await user.type(within(dialog).getByLabelText("Description"), fields.description ?? " zq-new description ");
  return dialog;
}

/** Opens the edit of `entry` from its name. */
async function openEdit(user: User, entry: TestRegex) {
  await user.click(await screen.findByRole("button", { name: entry.name }));
  return screen.findByRole("dialog", { name: "Edit Test Regex" });
}

/** Opens the confirmation from `entry`'s Delete. */
async function openDelete(user: User, entry: TestRegex) {
  await user.click(within(await waitFor(() => rowOf(entry.name))).getByRole("button", { name: "Delete" }));
  return screen.findByRole("dialog", { name: "Delete Test Regex" });
}

describe("the Test Regex page (D15b Task 3)", () => {
  it("shows the header and table, Name, Category, Regex and Actions, in the order the API answers (GET /api/v1/test-regexes)", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: EMAIL.name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Test Regex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Regex" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Category", "Regex", "Actions"]);
    const cells = (name: string) => within(rowOf(name)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells(EMAIL.name)).toEqual([EMAIL.name, EMAIL.category, EMAIL.regex, "Delete"]);
    expect(cells(AWS_KEY.name)).toEqual([AWS_KEY.name, AWS_KEY.category, AWS_KEY.regex, "Delete"]);
    // As the API ordered them, not re-sorted by the page.
    expect(shownNames()).toEqual([EMAIL.name, LONG.name, AWS_KEY.name]);
    expect(listRegexes).toHaveBeenCalledOnce();
    expect(listRegexes).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("shows each regex in full, wrapped, with no title and no disclosure (Preflight ruling 16)", async () => {
    renderPage();
    await screen.findByRole("button", { name: LONG.name });

    const regexCell = within(rowOf(LONG.name)).getAllByRole("cell")[2]!;
    expect(regexCell.textContent).toBe(LONG.regex);
    expect(regexCell).toHaveClass("font-mono", "whitespace-pre-wrap", "break-all");
    expect(regexCell).not.toHaveClass("truncate");
    expect(regexCell.attributes).toHaveLength(1);
    expect(regexCell.children).toHaveLength(0);
  });

  it("says 'Loading regexes...' until the first read answers, then 'No test regexes yet' when there are none", async () => {
    const answer = deferred<{ testRegexes: TestRegex[] }>();
    listRegexes.mockReturnValueOnce(answer.promise);
    renderPage();

    expect(await screen.findByText("Loading regexes...")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    answer.resolve({ testRegexes: [] });

    expect(await screen.findByRole("cell", { name: "No test regexes yet" })).toBeInTheDocument();
    expect(screen.queryByText("Loading regexes...")).toBeNull();
  });

  it("toasts 'Failed to load test regexes' when the read fails, the table empty", async () => {
    listRegexes.mockRejectedValueOnce(SERVER_ERROR);
    renderPage();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE));
    expect(TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE).toBe("Failed to load test regexes");
    expect(await screen.findByRole("cell", { name: "No test regexes yet" })).toBeInTheDocument();
  });

  it("toasts nothing for a read refused because the session has ended", async () => {
    listRegexes.mockRejectedValueOnce(SESSION_ENDED);
    renderPage();
    await screen.findByRole("cell", { name: "No test regexes yet" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("gives up on a read that never answers after 10 s: 'Failed to load test regexes', the loading line gone (D14b Ruling 50)", async () => {
    vi.useFakeTimers();
    try {
      // Answers only by its abort, as the client does.
      listRegexes.mockImplementation(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
          }),
      );
      renderPage();
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("Loading regexes...")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1));
      expect(toastError).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(toastError).toHaveBeenCalledWith(TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE);
      expect(screen.queryByText("Loading regexes...")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the latest read: an earlier one answering last doesn't overwrite it", async () => {
    const first = deferred<{ testRegexes: TestRegex[] }>();
    listRegexes.mockReturnValueOnce(first.promise).mockResolvedValue({ testRegexes: [EMAIL] });
    const { user } = renderPage();
    // The first read waits; a create reads again, and that one answers first.
    const dialog = await fillNew(user);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: EMAIL.name });

    first.resolve({ testRegexes: [AWS_KEY] });
    await waitFor(() => expect(listRegexes).toHaveBeenCalledTimes(2));
    await act(() => first.promise);
    expect(screen.queryByRole("button", { name: AWS_KEY.name })).toBeNull();
    expect(screen.getByRole("button", { name: EMAIL.name })).toBeInTheDocument();
  });

  it("toasts nothing for an earlier read failing after a later one succeeded: only the latest read speaks", async () => {
    const first = deferred<{ testRegexes: TestRegex[] }>();
    listRegexes.mockReturnValueOnce(first.promise).mockResolvedValue({ testRegexes: [EMAIL] });
    const { user } = renderPage();
    const dialog = await fillNew(user);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: EMAIL.name });

    await act(async () => {
      first.reject(SERVER_ERROR);
      await first.promise.catch(() => undefined);
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: EMAIL.name })).toBeInTheDocument();
  });
});

describe("creating an entry (the dialog)", () => {
  it("shows 'New Test Regex' with its fields, placeholders and limits, the name focused; Cancel and Create", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New Regex" }));
    const dialog = await screen.findByRole("dialog", { name: "New Test Regex" });

    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "e.g., IPv4 address");
    expect(name).toHaveAttribute("maxlength", "200");
    expect(name).toHaveFocus();
    const category = within(dialog).getByLabelText("Category");
    expect(category).toHaveAttribute("placeholder", "e.g., Network");
    expect(category).toHaveAttribute("maxlength", "100");
    const regex = within(dialog).getByLabelText("Regex");
    expect(regex).toHaveAttribute("placeholder", "e.g., \\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b");
    expect(regex).toHaveClass("font-mono");
    expect(regex).not.toHaveAttribute("maxlength");
    const description = within(dialog).getByLabelText("Description");
    expect(description).toHaveAttribute("placeholder", "Optional — describe what this pattern matches");
    expect(description).toHaveAttribute("maxlength", "2000");
    expect(description).toHaveAttribute("rows", "3");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Cancel", "Create"]),
    );
  });

  it("shows every validation message at once on Create, sending nothing; whitespace alone (Go's included) is none; each goes as its field changes", async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "New Regex" }));
    const dialog = await screen.findByRole("dialog", { name: "New Test Regex" });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(alertsIn(dialog)).toEqual(["Please enter a name.", "Please enter a category.", "Please enter a regex pattern."]);
    for (const label of ["Name", "Category", "Regex"]) {
      expect(within(dialog).getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
    }
    expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription("Please enter a name.");
    expect(within(dialog).getByLabelText("Regex")).toHaveAccessibleDescription("Please enter a regex pattern.");

    // Whitespace alone: JavaScript's for the name, Go's (U+0085) for the category, and the regex (never trimmed, but blank).
    await user.type(within(dialog).getByLabelText("Name"), "   ");
    await user.click(within(dialog).getByLabelText("Category"));
    await user.paste("\u0085");
    await user.click(within(dialog).getByLabelText("Regex"));
    await user.paste(" \t ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(alertsIn(dialog)).toEqual(["Please enter a name.", "Please enter a category.", "Please enter a regex pattern."]);

    await user.type(within(dialog).getByLabelText("Name"), "zq-a");
    expect(alertsIn(dialog)).toEqual(["Please enter a category.", "Please enter a regex pattern."]);
    expect(within(dialog).getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    await user.type(within(dialog).getByLabelText("Category"), "zq-b");
    expect(alertsIn(dialog)).toEqual(["Please enter a regex pattern."]);
    await user.type(within(dialog).getByLabelText("Regex"), "x");
    expect(alertsIn(dialog)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("trims as the API does (Ruling 22): a name of U+0085, U+FEFF, U+0085 is none; the text sent, and an edit's comparison, is the API's trimmed text", async () => {
    const { user } = renderPage();
    const dialog = await fillNew(user, { name: "x" });
    // One JavaScript trim, then one of Go's, leaves U+FEFF: the API trims again and finds nothing.
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.click(within(dialog).getByLabelText("Name"));
    await user.paste("\u0085\ufeff\u0085");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(alertsIn(dialog)).toEqual(["Please enter a name."]);
    expect(create).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.click(within(dialog).getByLabelText("Name"));
    await user.paste("\u0085\ufeffzq-new regex\ufeff\u0085");
    await user.click(within(dialog).getByLabelText("Category"));
    await user.paste("\ufeff\u0085");
    await user.click(within(dialog).getByLabelText("Description"));
    await user.paste("\u0085\ufeff");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "zq-new regex",
        category: "zq-Network",
        regex: " zq\\d{3} ",
        description: "zq-new description",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // An edit whose name differs only by what the API trims sends nothing changed.
    const edit = await openEdit(user, LONG);
    await user.click(within(edit).getByLabelText("Name"));
    await user.paste("\ufeff\u0085");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(LONG.id, {}));
  });

  it("refuses a regex past the API's 8,192 bytes in the API's words under Regex, sending nothing", async () => {
    const { user } = renderPage();
    // 4,097 two-byte characters: 8,194 bytes in 4,097 characters.
    const dialog = await fillNew(user, { regex: "é".repeat(4_097) });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(alertsIn(dialog)).toEqual(["The regex is longer than 8,192 bytes."]);
    expect(within(dialog).getByLabelText("Regex")).toHaveAccessibleDescription("The regex is longer than 8,192 bytes.");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates it from the trimmed name, category and description and the regex as typed; 'Creating…' and not closable meanwhile; 'Regex created', the list read again in the API's new order, the dialog closed", async () => {
    const answer = deferred<{ testRegex: TestRegex }>();
    create.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    const dialog = await fillNew(user);
    const created = regexFixture({ id: "0199f300-0000-7000-8000-000000000009", name: "zq-new regex", category: "zq-Network" });
    // The API places the new entry by its category, then name: between the two it already had.
    listRegexes.mockResolvedValue({ testRegexes: [EMAIL, created, LONG, AWS_KEY] });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(create).toHaveBeenCalledWith({
      name: "zq-new regex",
      category: "zq-Network",
      regex: " zq\\d{3} ",
      description: "zq-new description",
    });
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    for (const label of ["Name", "Category", "Regex", "Description"]) expect(within(dialog).getByLabelText(label)).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New Test Regex" })).toBeInTheDocument();

    answer.resolve({ testRegex: created });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Regex created");
    expect(listRegexes).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(shownNames()).toEqual([EMAIL.name, created.name, LONG.name, AWS_KEY.name]));
  });

  it("sends a description left empty, or of whitespace alone, as none (null)", async () => {
    const { user } = renderPage();
    const dialog = await fillNew(user, { description: "   " });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ description: null })));
  });

  it("shows the evaluator's refusal (400 test_regex_invalid) under Regex, an alert the field is described by, the dialog open with the text; it goes as the regex changes", async () => {
    create.mockRejectedValueOnce(INVALID);
    const { user } = renderPage();
    const dialog = await fillNew(user, { regex: "(zq" });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(alertsIn(dialog)).toEqual([INVALID_WORDS]));
    const regex = within(dialog).getByLabelText("Regex");
    expect(regex).toHaveAccessibleDescription(INVALID_WORDS);
    expect(regex).toHaveAttribute("aria-invalid", "true");
    expect(regex).toHaveValue("(zq");
    expect(within(dialog).getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    // Under Regex: the alert sits in the Regex field's group.
    expect(within(dialog).getByRole("alert").parentElement).toBe(regex.parentElement);
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(listRegexes).toHaveBeenCalledOnce();

    await user.type(regex, ")");
    expect(alertsIn(dialog)).toEqual([]);
    expect(regex).not.toHaveAttribute("aria-invalid");
  });

  it("shows each of the evaluator's problems, and its message alone when it lists none", async () => {
    create
      .mockRejectedValueOnce(
        new ApiError("test_regex_invalid", "zq-first", {
          status: 400,
          details: { problems: [{ field: "regex", message: "zq-first" }, { field: "regex", message: "zq-second" }] },
        }),
      )
      .mockRejectedValueOnce(new ApiError("test_regex_invalid", "zq-bare", { status: 400 }));
    const { user } = renderPage();
    const dialog = await fillNew(user);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["zq-first", "zq-second"]));
    expect(within(dialog).getByLabelText("Regex")).toHaveAccessibleDescription("zq-first zq-second");

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["zq-bare"]));
  });

  it("shows a name another entry has (409 test_regex_name_taken) under Name in the API's words, the dialog open with the text; it goes as the name changes", async () => {
    create.mockRejectedValueOnce(NAME_TAKEN);
    const { user } = renderPage();
    const dialog = await fillNew(user, { name: EMAIL.name });

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(alertsIn(dialog)).toEqual(["A regex with that name already exists."]));
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAccessibleDescription("A regex with that name already exists.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveValue(EMAIL.name);
    expect(within(dialog).getByRole("alert").parentElement).toBe(name.parentElement);
    expect(within(dialog).getByLabelText("Regex")).not.toHaveAttribute("aria-invalid");
    expect(toastError).not.toHaveBeenCalled();

    await user.type(name, "-2");
    expect(alertsIn(dialog)).toEqual([]);
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it.each([
    ["429 validation_rule_rate_limited", RATE_LIMITED, RATE_LIMITED.message],
    ["503 rules_unavailable", UNAVAILABLE, UNAVAILABLE.message],
    ["400 invalid_request", new ApiError("invalid_request", "The request was not valid.", { status: 400 }), "Failed to create regex"],
    ["500", SERVER_ERROR, "Failed to create regex"],
  ])("toasts %s by the API's words, else 'Failed to create regex', blocked from replay, staying open with Create pressable", async (_what, error, words) => {
    create.mockRejectedValueOnce(error);
    const { user } = renderPage();
    const dialog = await fillNew(user);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words, PRIVATE));
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
    expect(alertsIn(dialog)).toEqual([]);
    expect(within(dialog).getByLabelText("Regex")).toHaveValue(" zq\\d{3} ");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    create.mockRejectedValueOnce(SESSION_ENDED);
    const { user } = renderPage();
    const dialog = await fillNew(user);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
  });

  it("starts empty each time it opens, the last refusal forgotten", async () => {
    create.mockRejectedValueOnce(NAME_TAKEN);
    const { user } = renderPage();
    const dialog = await fillNew(user);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(alertsIn(dialog)).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "New Regex" }));
    const again = await screen.findByRole("dialog", { name: "New Test Regex" });
    for (const label of ["Name", "Category", "Regex", "Description"]) expect(within(again).getByLabelText(label)).toHaveValue("");
    expect(alertsIn(again)).toEqual([]);
  });
});

describe("editing an entry", () => {
  it("opens 'Edit Test Regex' from the name, filled from the row; Save sends only the changed fields, by id; 'Saving…'; 'Regex updated', the list read again in the API's new order", async () => {
    const answer = deferred<{ testRegex: TestRegex }>();
    update.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();

    const dialog = await openEdit(user, AWS_KEY);
    expect(within(dialog).getByLabelText("Name")).toHaveValue(AWS_KEY.name);
    expect(within(dialog).getByLabelText("Category")).toHaveValue(AWS_KEY.category);
    expect(within(dialog).getByLabelText("Regex")).toHaveValue(AWS_KEY.regex);
    expect(within(dialog).getByLabelText("Description")).toHaveValue("");

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), " zq-AAA renamed ");
    await user.type(within(dialog).getByLabelText("Description"), "zq-now described");
    const renamed = { ...AWS_KEY, name: "zq-AAA renamed", description: "zq-now described" };
    listRegexes.mockResolvedValue({ testRegexes: [renamed, EMAIL, LONG] });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(update).toHaveBeenCalledWith(AWS_KEY.id, { name: "zq-AAA renamed", description: "zq-now described" });
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Edit Test Regex" })).toBeInTheDocument();

    answer.resolve({ testRegex: renamed });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Regex updated");
    expect(listRegexes).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(shownNames()).toEqual([renamed.name, EMAIL.name, LONG.name]));
  });

  it("sends a new regex as typed and a description cleared as none (null); a Save changing nothing sends {}", async () => {
    const { user } = renderPage();
    let dialog = await openEdit(user, EMAIL);
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.clear(within(dialog).getByLabelText("Regex"));
    await user.click(within(dialog).getByLabelText("Regex"));
    await user.paste("zq\\w+ ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(EMAIL.id, { description: null, regex: "zq\\w+ " }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openEdit(user, EMAIL);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(EMAIL.id, {}));
  });

  it("shows the evaluator's refusal under Regex and a clashing name under Name, staying open; 'Failed to update regex' for a failure the API's words don't explain", async () => {
    update.mockRejectedValueOnce(INVALID).mockRejectedValueOnce(NAME_TAKEN).mockRejectedValueOnce(SERVER_ERROR);
    const { user } = renderPage();
    const dialog = await openEdit(user, EMAIL);

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByLabelText("Regex")).toHaveAccessibleDescription(INVALID_WORDS));

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(NAME_TAKEN.message));
    // A new attempt clears the last one's words.
    expect(alertsIn(dialog)).toEqual([NAME_TAKEN.message]);

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to update regex", PRIVATE));
    expect(screen.getByRole("dialog", { name: "Edit Test Regex" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(listRegexes).toHaveBeenCalledOnce();
  });

  it("closes the edit of an entry deleted meanwhile (404) on the API's words, blocked from replay, and reads the list again, its row gone, the focus on 'New Regex' (D14b Rulings 43 and 45)", async () => {
    update.mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    const dialog = await openEdit(user, EMAIL);
    listRegexes.mockResolvedValue({ testRegexes: [LONG, AWS_KEY] });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Test regex not found", PRIVATE);
    expect(toastError).toHaveBeenCalledOnce();
    expect(listRegexes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: EMAIL.name })).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Regex" }));
  });
});

describe("deleting an entry (the confirmation)", () => {
  it("asks 'Delete Test Regex' by the entry's name; Cancel deletes nothing", async () => {
    const { user } = renderPage();
    const confirmation = await openDelete(user, AWS_KEY);

    expect(confirmation).toHaveAccessibleDescription(`Are you sure you want to delete "${AWS_KEY.name}"? This action cannot be undone.`);
    expect(within(confirmation).getAllByRole("button").map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Cancel", "Delete"]),
    );
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes it by id, 'Deleting…' and not closable meanwhile; 'Regex deleted', the list read again, the focus on 'New Regex'", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValueOnce(answer.promise);
    const { user } = renderPage();
    const confirmation = await openDelete(user, EMAIL);
    listRegexes.mockResolvedValue({ testRegexes: [LONG, AWS_KEY] });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(remove).toHaveBeenCalledWith(EMAIL.id);
    expect(within(confirmation).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Delete Test Regex" })).toBeInTheDocument();

    answer.resolve(undefined);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Regex deleted");
    expect(listRegexes).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: EMAIL.name })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Regex" }));
  });

  it("counts an entry deleted meanwhile (404) as deleted, and toasts 'Failed to delete regex' for a failure, blocked from replay, staying open", async () => {
    remove.mockRejectedValueOnce(SERVER_ERROR).mockRejectedValueOnce(NOT_FOUND);
    const { user } = renderPage();
    const confirmation = await openDelete(user, EMAIL);

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete regex", PRIVATE));
    expect(screen.getByRole("dialog", { name: "Delete Test Regex" })).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "Delete" })).toBeEnabled();

    listRegexes.mockResolvedValue({ testRegexes: [LONG, AWS_KEY] });
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Regex deleted"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: EMAIL.name })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New Regex" }));
  });

  it("shows a refusal by the API's own words, blocked from replay; and nothing for a session that has ended", async () => {
    remove.mockRejectedValueOnce(new ApiError("rate_limited", "zq-the API's own words.", { status: 429 })).mockRejectedValueOnce(SESSION_ENDED);
    const { user } = renderPage();
    const confirmation = await openDelete(user, EMAIL);

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("zq-the API's own words.", PRIVATE));
    toastError.mockClear();

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Delete" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the focus as a dialog closes (D14b Ruling 46: no Radix trigger, so not the body)", () => {
  const newRegex = () => screen.getByRole("button", { name: "New Regex" });

  it("goes back to 'New Regex' from the new entry's dialog: Cancel, Escape and a create", async () => {
    const { user } = renderPage();
    await screen.findByRole("button", { name: EMAIL.name });

    await user.click(newRegex());
    await user.click(within(await screen.findByRole("dialog", { name: "New Test Regex" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(newRegex()));

    await user.click(newRegex());
    await screen.findByRole("dialog", { name: "New Test Regex" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(newRegex()));

    const dialog = await fillNew(user);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(newRegex()));
  });

  it("goes back to the row's name from the edit dialog: Cancel, Escape and a save", async () => {
    const { user } = renderPage();
    const name = () => screen.getByRole("button", { name: AWS_KEY.name });

    await openEdit(user, AWS_KEY);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name()));

    await openEdit(user, AWS_KEY);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name()));

    const dialog = await openEdit(user, AWS_KEY);
    await user.type(within(dialog).getByLabelText("Description"), "zq-more");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(name()));
  });

  it("goes back to the row's Delete from the confirmation: Cancel and Escape", async () => {
    const { user } = renderPage();
    const remover = () => within(rowOf(AWS_KEY.name)).getByRole("button", { name: "Delete" });

    await user.click(within(await openDelete(user, AWS_KEY)).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remover()));

    await openDelete(user, AWS_KEY);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remover()));
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("the flag cleared mid-visit (403 product_admin_required): the admin leaves for /app", () => {
  it("from a create, replacing the page, with no toast", async () => {
    create.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    const dialog = await fillNew(user);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("from an edit", async () => {
    update.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    const dialog = await openEdit(user, EMAIL);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("from a delete", async () => {
    remove.mockRejectedValueOnce(FORBIDDEN);
    const { user } = renderPage();
    const confirmation = await openDelete(user, EMAIL);
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("replay's rules (ADR 0024; Preflight rulings 16 and 17)", () => {
  /** Whether `element` is inside a block replay drops. */
  const blocked = (element: Element) => element.closest(".ph-no-capture") !== null;

  /**
   * Every attribute carrying the marker: outside `ph-no-capture` any at all,
   * an input's value included; inside it any but a visible field's value
   * (which maskAllInputs masks too).
   */
  const markedAttributes = () => {
    const markers: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        const isFieldValue =
          (element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
          attribute.name === "value" &&
          element.getAttribute("type") !== "hidden";
        if (isFieldValue && blocked(element)) continue;
        if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
      }
    }
    return markers;
  };

  /** Every text node carrying the marker outside `ph-no-capture`. */
  const unblockedText = () => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").includes("zq") && !blocked(node.parentElement!)) found.push(node.textContent ?? "");
    }
    return found;
  };

  it("puts the page and both dialogs inside ph-no-capture, and no entry's text in any attribute, with the table, each dialog, its refusals and the confirmation shown; each button is named by text, the API asked by id", async () => {
    create.mockRejectedValueOnce(INVALID).mockRejectedValueOnce(NAME_TAKEN);
    const { user } = renderPage();
    await screen.findByRole("button", { name: EMAIL.name });
    expect(screen.getByRole("heading", { level: 1, name: "Test Regex" }).closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByRole("table").closest(".ph-no-capture")).not.toBeNull();
    expect(markedAttributes()).toEqual([]);
    expect(unblockedText()).toEqual([]);
    // Each Delete is described by its row's name, from text.
    expect(within(rowOf(EMAIL.name)).getByRole("button", { name: "Delete" })).toHaveAccessibleDescription(EMAIL.name);

    // A new entry's dialog, with the evaluator's words (which quote the regex) under Regex, then the name's clash under Name.
    const dialog = await fillNew(user, { regex: "(zq" });
    expect(dialog).toHaveClass("ph-no-capture");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual([INVALID_WORDS]));
    expect(markedAttributes()).toEqual([]);
    expect(unblockedText()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual([NAME_TAKEN.message]));
    expect(markedAttributes()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const edit = await openEdit(user, LONG);
    expect(edit).toHaveClass("ph-no-capture");
    expect(markedAttributes()).toEqual([]);
    expect(unblockedText()).toEqual([]);
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledWith(LONG.id, {});

    const confirmation = await openDelete(user, LONG);
    expect(confirmation).toHaveClass("ph-no-capture");
    expect(markedAttributes()).toEqual([]);
    expect(unblockedText()).toEqual([]);
    // Nothing of it in the router's address: the page never moved.
    expect(pageAddress).toBe("/product-admin/test-regex");
  });
});
