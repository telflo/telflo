import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Collector, CollectorError, CollectorErrorsPage, CollectorGroup, EnrollmentTokenListed, FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_READ_TIMEOUT_MS } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { GROUP_ID } from "~/test/configurations.js";
import {
  CLUSTER_GROUP_ID,
  COLLECTOR_ID,
  collector,
  collectorError,
  collectorGroup,
  DEFAULT_TOKEN_ID,
  expectNoAttributeHolds,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  INSTANCE_UID,
  kubernetesGroups,
  listedToken,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  ROTATE_TOKEN_ID,
  sha256Of,
} from "~/test/fleets.js";
import { COLLECTOR_NOT_FOUND_MESSAGE, CollectorDetailsDialog } from "./CollectorDetailsDialog.js";
import { VERSION_MEANINGS } from "./CollectorsTable.js";
import { ERROR_HISTORY_FAILED_MESSAGE } from "./CollectorErrorHistory.js";
import { TOKENS_FAILED_WORDS } from "./CollectorTokenRow.js";

// A collector's details (D17b-1 decisions 22, 24, 25 and 32; Preflight
// rulings 4, 11 and 17): every row's label, in order, with its value (Status
// the liveness and Configuration the drift, as the grid's columns: D17d-2
// Ruling 55; the configuration's name in "Configuration name"); the IP
// precedence; "Edit collector" in the footer closing the details for the edit
// dialog. Its Node row is a Kubernetes fleet's (D17d-1, below); Variable
// Group (D20's), the collector-version drift colour (D19's), the nested error
// dialog and the read-only grids' missing footer don't apply.

const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const DAY_MS = 86_400_000;

const aborted = () => new ApiError(REQUEST_ABORTED, "The request was cancelled.");

/** A read that answers only by failing when its signal aborts, as the browser's client does. */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(aborted()));
  });
}

/** A read held until released, whatever its signal does: a late answer. */
function held<Value>() {
  let release!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => (release = resolve));
  return { promise, release };
}

const TOKENS: EnrollmentTokenListed[] = [listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" }), listedToken()];

/** The row the details were opened with: the refresh answers it unless a test says otherwise. */
let openedRow: Collector = collector();

function serve() {
  return {
    getCollector: vi.spyOn(apiClient, "getCollector").mockImplementation(async () => openedRow),
    getEnrollmentTokens: vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: TOKENS }),
    getCollectorErrors: vi
      .spyOn(apiClient, "getCollectorErrors")
      .mockResolvedValue({ errors: [], nextCursor: null } satisfies CollectorErrorsPage),
  };
}

let api: ReturnType<typeof serve>;
const onOpenChange = vi.fn();
const onCollectorGone = vi.fn();
const onEdit = vi.fn();

interface RenderOptions {
  groups?: CollectorGroup[] | null;
  /** A route loader, to count the layout's revalidations. */
  loader?: () => null;
  /** Leaves `onEdit` out, as the grid does until Task 6 wires it. */
  withoutEdit?: boolean;
  /** The fleet's type; left out, the dialog's default (a server fleet). */
  fleetType?: FleetType;
}

/** The details, open for `row`, with a button to open them again once closed. */
function renderDetails(
  row: Collector = collector(),
  { groups = [collectorGroup(), gatewaysGroup()], withoutEdit = false, loader, fleetType }: RenderOptions = {},
) {
  openedRow = row;
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open again
        </button>
        <CollectorDetailsDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collector={row}
          organizationId={GROUP_ID}
          fleetId={FLEET_ID}
          groups={groups}
          {...(fleetType === undefined ? {} : { fleetType })}
          onCollectorGone={onCollectorGone}
          onEdit={withoutEdit ? undefined : onEdit}
        />
      </>
    );
  }
  const Stub = createRoutesStub([
    loader === undefined ? { path: "/", Component: Host } : { path: "/", Component: Host, loader, HydrateFallback: () => null },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

/** Waits for the three reads of the opening to be in. */
async function settled() {
  await waitFor(() => expect(screen.queryByText("Loading errors…")).toBeNull());
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
}

const dialog = () => screen.getByRole("dialog");

/** The value cell of the row labelled `label`. */
function rowValue(label: string): HTMLElement {
  const labelCell = within(dialog()).getByText(label, { selector: "div" });
  return labelCell.nextElementSibling as HTMLElement;
}

/** Every row's label, in order. */
function rowLabels(): string[] {
  const grid = within(dialog()).getByText("IP Address", { selector: "div" }).parentElement!;
  return [...grid.children].filter((_, index) => index % 2 === 0).map((cell) => cell.textContent ?? "");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  onOpenChange.mockClear();
  onCollectorGone.mockClear();
  onEdit.mockClear();
  api = serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CollectorDetailsDialog's rows (decision 24)", () => {
  it("lists every row in its order, with its value", async () => {
    renderDetails();
    await settled();

    expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();
    expect(within(dialog()).getByText("Collector details")).toBeInTheDocument();
    expect(rowLabels()).toEqual([
      "IP Address",
      "Name",
      "UID",
      "Group",
      "Status",
      "Configuration",
      "Token",
      "Configuration name",
      "Pin",
      "Pinned variable group",
      "Variable group",
      "Target Version",
      "Effective Version",
      "Applied",
      "Collector",
      "Error",
      "Last Seen",
      "Created",
    ]);
    expect(rowValue("IP Address")).toHaveTextContent("192.168.1.17");
    expect(rowValue("Name")).toHaveTextContent("web-01");
    expect(rowValue("UID")).toHaveTextContent(INSTANCE_UID);
    expect(rowValue("Group")).toHaveTextContent("Default");
    expect(rowValue("Status")).toHaveTextContent(/^OnlineSeen in the last minute\.$/);
    expect(rowValue("Configuration")).toHaveTextContent(/^In syncRunning its configuration\.$/);
    expect(rowValue("Token")).toHaveTextContent("Rotate token (current)");
    expect(rowValue("Configuration name")).toHaveTextContent("checkout-otel");
    expect(rowValue("Pin")).toHaveTextContent("None: follows its group");
    expect(rowValue("Pinned variable group")).toHaveTextContent(/^None: follows its group$/);
    expect(within(rowValue("Variable group")).getByRole("button", { name: "Organization values" })).toBeInTheDocument();
    const editorPath = `/editor/${publishedVersion().configurationId}/${publishedVersion().versionId}`;
    // D17c-1 decision 46: "{configurationName} @v{n}", the whole name, no tooltip.
    expect(within(rowValue("Target Version")).getByRole("link", { name: "checkout-otel @v4" })).toHaveAttribute("href", editorPath);
    expect(within(rowValue("Effective Version")).getByRole("link", { name: "checkout-otel @v4" })).toHaveAttribute("href", editorPath);
    expect(rowValue("Target Version")).toHaveTextContent(/^checkout-otel @v4$/);
    expect(rowValue("Effective Version")).toHaveTextContent(/^checkout-otel @v4Running: the last published version it was sent\.$/);
    expect(rowValue("Applied")).toHaveTextContent("Applied 59 minutes ago");
    expect(rowValue("Collector")).toHaveTextContent("v0.162.0");
    expect(rowValue("Error")).toHaveTextContent(/^—$/);
    // How long ago and the full time, no dot and no window (Ruling 55: the liveness is Status's).
    expect(rowValue("Last Seen")).toHaveTextContent(new RegExp(`^5 seconds ago${formatDateTime("2026-10-14T09:59:55.000Z")}$`));
    expect(rowValue("Last Seen").querySelector("[aria-hidden='true']")).toBeNull();
    expect(rowValue("Created")).toHaveTextContent(formatDateTime("2026-10-13T09:00:00.000Z"));
    // No title anywhere, the dialog's own element included: the IP, the
    // instance id and the version descriptions are text.
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("prefers the host's address, falls back to the collector's own, and shows a dash for none", async () => {
    renderDetails(collector({ reported: { collectorVersion: null, ip: "203.0.113.7", hostIp: "10.0.0.5", attributes: null } }));
    await settled();
    expect(rowValue("IP Address")).toHaveTextContent("10.0.0.5");
    expect(within(dialog()).queryByText("203.0.113.7")).toBeNull();
    // Collector: a dash with no version reported.
    expect(rowValue("Collector")).toHaveTextContent("—");
  });

  it.each([
    [{ ip: "203.0.113.7", hostIp: null }, "203.0.113.7"],
    [{ ip: null, hostIp: null }, "—"],
  ])("shows the address %o as %s", async (addresses, shown) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ reported: { collectorVersion: "0.162.0", attributes: null, ...addresses } }));
    await settled();
    expect(rowValue("IP Address")).toHaveTextContent(shown);
  });

  it("shows the group's name, or a dash when the groups aren't read or don't hold it", async () => {
    renderDetails(collector({ groupId: GATEWAYS_GROUP_ID }));
    await settled();
    expect(rowValue("Group")).toHaveTextContent("gateways");
  });

  it("shows a dash for the group while the fleet's groups aren't read", async () => {
    renderDetails(collector({ groupId: GATEWAYS_GROUP_ID }), { groups: null });
    await settled();
    expect(rowValue("Group")).toHaveTextContent("—");
  });

  it.each([
    ["inSync", "In sync", "Running its configuration."],
    ["pending", "Pending pickup", "Not running its configuration yet."],
    ["failed", "Apply failed", "Failed to apply its configuration."],
    ["drifted", "Drifted", "Running another configuration."],
    [
      "unassigned",
      "Nothing assigned",
      "No pin, and no published version on its group; it keeps running what it has: its own file, or the last published version it was sent.",
    ],
  ] as const)("shows the %s drift's words and its meaning as text in the Configuration row (Ruling 55)", async (drift, words, meaning) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ drift }));
    await settled();
    const configuration = rowValue("Configuration");
    expect(configuration).toHaveTextContent(`${words}${meaning}`);
    expect(within(configuration).getByText(meaning).tagName).toBe("P");
    // Its dot, decoration: the words say the same.
    expect(configuration.querySelector("[aria-hidden='true']")).not.toBeNull();
    // Status stays the liveness, whatever the drift.
    expect(rowValue("Status")).toHaveTextContent(/^Online/);
  });

  it.each([
    ["online", "Online", "Seen in the last minute.", "bg-ok"],
    ["warning", "Warning", "Last seen 1–2 minutes ago.", "bg-warn"],
    ["unknown", "Unknown", "Last seen 2–5 minutes ago.", "bg-muted-foreground/40"],
    ["offline", "Offline", "Not seen for over 5 minutes.", "bg-fail"],
  ] as const)("shows the %s liveness's words, its dot and its window as text in the Status row (Ruling 55)", async (liveness, words, meaning, dot) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ liveness }));
    await settled();
    const status = rowValue("Status");
    expect(status.textContent).toBe(`${words}${meaning}`);
    expect(within(status).getByText(meaning).tagName).toBe("P");
    expect(status.querySelector(`[aria-hidden='true'].${CSS.escape(dot)}`)).not.toBeNull();
    // Configuration stays the drift, whatever the liveness.
    expect(rowValue("Configuration")).toHaveTextContent(/^In sync/);
  });

  it.each([
    ["no pin", null, "None: follows its group"],
    [
      "a published version",
      { kind: "version", versionId: publishedVersion().versionId, publishedVersionId: PUBLISHED_VERSION_ID, version: publishedVersion() },
      "checkout-otel @v4",
    ],
    [
      "a deleted configuration's version",
      { kind: "version", versionId: null, publishedVersionId: PUBLISHED_VERSION_ID, version: null },
      "A deleted configuration's version",
    ],
  ] as const)("reads the Pin row for %s", async (_name, pin, words) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ pin }));
    await settled();
    expect(rowValue("Pin")).toHaveTextContent(words);
  });

  it("reads the version rows for a deleted configuration's version targeted, and nothing served", async () => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(
      collector({
        resolution: { from: "pinnedVersion", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), version: null },
        served: null,
      }),
    );
    await settled();
    expect(rowValue("Configuration name")).toHaveTextContent("—");
    expect(rowValue("Target Version")).toHaveTextContent("A deleted configuration's version");
    expect(rowValue("Effective Version")).toHaveTextContent(/^—Nothing sent yet: it runs its own file\.$/);
  });

  it("reads the version rows for nothing targeted and a deleted version served", async () => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(
      collector({
        resolution: null,
        served: { kind: "version", publishedVersionId: null, sha256: sha256Of("a"), at: null, version: null },
      }),
    );
    await settled();
    expect(rowValue("Configuration name")).toHaveTextContent("—");
    expect(rowValue("Target Version")).toHaveTextContent(/^—$/);
    expect(rowValue("Effective Version")).toHaveTextContent(
      /^A deleted configuration's versionRunning a version of a configuration since deleted\.$/,
    );
  });

  it("shows dashes for a collector with nothing resolved, served or applied", async () => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ resolution: null, served: null, effective: null, drift: "unassigned" }));
    await settled();
    for (const label of ["Configuration name", "Target Version", "Applied"]) {
      expect(rowValue(label)).toHaveTextContent(/^—$/);
    }
    // Effective Version's dash, its meaning under it (D16c Ruling 21).
    expect(rowValue("Effective Version")).toHaveTextContent(/^—Nothing sent yet: it runs its own file\.$/);
  });

  // D16c Ruling 21: the grid's Version tooltip's meaning, as text under the value (a touch user sees no tooltip), as Status's.
  it.each([
    ["a published version served", collector().served, "checkout-otel @v4", "Running: the last published version it was sent."],
    [
      "a deleted configuration's version served",
      { kind: "version", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), at: null, version: null },
      "A deleted configuration's version",
      "Running a version of a configuration since deleted.",
    ],
    [
      "a deleted published version served",
      { kind: "version", publishedVersionId: null, sha256: sha256Of("a"), at: null, version: null },
      "A deleted configuration's version",
      "Running a version of a configuration since deleted.",
    ],
    ["nothing served", null, "—", "Nothing sent yet: it runs its own file."],
  ] as const)("says what the Effective Version means for %s, as text under it", async (_why, served, words, meaning) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ served }));
    await settled();
    const row = rowValue("Effective Version");
    expect(row.textContent).toBe(`${words}${meaning}`);
    const shown = within(row).getByText(meaning);
    expect(shown.tagName).toBe("P");
    expect(shown).toHaveClass("text-xs", "text-muted-foreground");
    expect(shown).toBeVisible();
    expect(meaning).toBe(VERSION_MEANINGS[served === null ? "nothing" : served.version === null ? "deleted" : "version"]);
  });

  // D16c (decision 9): no imported section and no "View YAML", whatever the collector runs.
  it.each([
    ["following its group", collector()],
    ["pinned to a published version", collector({ pin: { kind: "version", versionId: publishedVersion().versionId, publishedVersionId: PUBLISHED_VERSION_ID, version: publishedVersion() } })],
    ["with nothing assigned", collector({ resolution: null, served: null, effective: null, drift: "unassigned" })],
  ])("shows no imported configuration and no View YAML for a collector %s", async (_name, row) => {
    renderDetails(row);
    await settled();
    expect(within(dialog()).queryByText(/import/i)).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "View YAML" })).toBeNull();
    expect(within(dialog()).queryAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      row.name,
      "Error history",
      "Reported attributes",
    ]);
  });

  it.each([
    ["applying", "Applying 2 minutes ago"],
    ["failed", "Failed 2 minutes ago"],
  ] as const)("reads the Applied row for %s", async (status, words) => {
    api.getCollector.mockReturnValue(new Promise(() => undefined));
    renderDetails(collector({ effective: { sha256: sha256Of("a"), status, error: null, at: new Date(NOW - 120_000).toISOString() } }));
    await settled();
    expect(rowValue("Applied")).toHaveTextContent(words);
  });
});

describe("CollectorDetailsDialog's Error row (the controller's ruling)", () => {
  it("shows the current apply's error in a <pre> inside ph-no-capture, in no attribute", async () => {
    const message = "canary-apply-error-6d\n  at the otlp receiver";
    const row = collector({ drift: "failed", effective: { sha256: sha256Of("a"), status: "failed", error: message, at: new Date(NOW - 60_000).toISOString() } });
    api.getCollector.mockResolvedValue(row);
    renderDetails(row);
    await settled();
    const shown = within(rowValue("Error")).getByText(/canary-apply-error-6d/);
    expect(shown.tagName).toBe("PRE");
    expect(shown.textContent).toBe(message);
    expect(shown.className).toBe("max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs");
    // A scrollable region a keyboard can reach (Ruling 26: an 8 KiB error made the dialog three viewports tall),
    // named by fixed words, never the error's text (the final fix wave).
    expect(shown).toHaveAttribute("tabindex", "0");
    expect(shown).toHaveAttribute("aria-label", "Error message");
    // A group, so the fixed name counts (ARIA 1.2 names no role-less <pre>), and no landmark (axe's landmark-unique).
    expect(within(rowValue("Error")).getByRole("group", { name: "Error message" })).toBe(shown);
    expect(within(rowValue("Error")).queryByRole("region")).toBeNull();
    expect(shown.closest(".ph-no-capture")).not.toBeNull();
    expectNoAttributeHolds("canary-apply-error-6d");
  });

  it.each([
    ["no error", collector()],
    ["nothing applied", collector({ effective: null })],
  ])("shows a dash for %s", async (_why, row) => {
    api.getCollector.mockResolvedValue(row);
    renderDetails(row);
    await settled();
    expect(rowValue("Error")).toHaveTextContent(/^—$/);
    expect(rowValue("Error").querySelector("pre")).toBeNull();
  });
});

describe("CollectorDetailsDialog's refresh (Preflight ruling 11)", () => {
  it("shows the row at once, then the collector as the read answers it", async () => {
    const read = held<Collector>();
    api.getCollector.mockReturnValue(read.promise);
    renderDetails();
    await settled();
    expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();
    expect(api.getCollector).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, COLLECTOR_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await act(async () => read.release(collector({ name: "web-01-renamed", drift: "pending", liveness: "offline" })));
    expect(await screen.findByRole("heading", { name: "web-01-renamed" })).toBeInTheDocument();
    expect(rowValue("Status")).toHaveTextContent("Offline");
    expect(rowValue("Configuration")).toHaveTextContent("Pending pickup");
  });

  it('toasts "Collector not found", closes and reloads the grid when the collector is gone', async () => {
    const error = vi.spyOn(toast, "error");
    api.getCollector.mockRejectedValue(new ApiError("collector_not_found", "Collector not found.", { status: 404 }));
    renderDetails();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith(COLLECTOR_NOT_FOUND_MESSAGE);
    expect(error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCollectorGone).toHaveBeenCalledTimes(1);
  });

  it("closes and reloads the grid, without a toast, when the fleet is gone", async () => {
    const error = vi.spyOn(toast, "error");
    api.getCollector.mockRejectedValue(new ApiError("fleet_not_found", "Fleet not found.", { status: 404 }));
    renderDetails();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).not.toHaveBeenCalled();
    expect(onCollectorGone).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 503", () => new ApiError("fleets_unavailable", "The fleet service is unavailable.", { status: 503 })],
    ["a 429", () => new ApiError("rate_limited", "Too many requests.", { status: 429, retryAfterSeconds: 5 })],
    ["no connection", () => new ApiError("network_error", "Network error.")],
  ])("keeps the row's data on %s, silently, revalidating nothing", async (_name, failure) => {
    const error = vi.spyOn(toast, "error");
    const loader = vi.fn(() => null);
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let failed = false;
    api.getCollector.mockImplementation(async () => {
      await answered;
      failed = true;
      throw failure();
    });
    renderDetails(collector(), { loader });
    await screen.findByRole("dialog");
    await settled();
    const loads = loader.mock.calls.length;
    release();
    await waitFor(() => expect(failed).toBe(true));
    // Past the failure's handling: a revalidation, had there been one, would have run the loader by now.
    await act(async () => {});
    await act(async () => {});
    expect(loader.mock.calls.length).toBe(loads);
    expect(api.getCollector).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();
    expect(rowValue("Status")).toHaveTextContent("Online");
    expect(rowValue("Configuration")).toHaveTextContent("In sync");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(onCollectorGone).not.toHaveBeenCalled();
  });

  it.each([
    ["the organization is gone", () => new ApiError("organization_not_found", "Organization not found.", { status: 404 })],
    [
      "the terms need accepting",
      () => new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.", { status: 403 }),
    ],
  ])("closes and revalidates the layout when %s, with no toast", async (_why, failure) => {
    const error = vi.spyOn(toast, "error");
    const loader = vi.fn(() => null);
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    api.getCollector.mockImplementation(async () => {
      await answered;
      throw failure();
    });
    renderDetails(collector(), { loader });
    await screen.findByRole("dialog");
    const loads = loader.mock.calls.length;
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(error).not.toHaveBeenCalled();
    expect(onCollectorGone).not.toHaveBeenCalled();
  });
});

describe("CollectorDetailsDialog's Token row (decision 25)", () => {
  async function tokenWordsFor(tokenId: string | null, tokens: EnrollmentTokenListed[]): Promise<string> {
    api.getEnrollmentTokens.mockResolvedValue({ tokens });
    renderDetails(collector({ enrollmentTokenId: tokenId }));
    await settled();
    return rowValue("Token").textContent ?? "";
  }

  it("says the default token", async () => {
    expect(await tokenWordsFor(DEFAULT_TOKEN_ID, TOKENS)).toBe("Default token");
  });

  it("says the current rotate token", async () => {
    expect(await tokenWordsFor(ROTATE_TOKEN_ID, TOKENS)).toBe("Rotate token (current)");
  });

  it("says a rotate token being replaced, until its expiry", async () => {
    const graceEnd = new Date(NOW + 2 * DAY_MS).toISOString();
    const successor = listedToken({ id: "d7e8f90a-1b2c-4d3e-84f5-a6b7c8d9e0f1", createdAt: "2026-10-14T08:00:00.000Z" });
    const replaced = listedToken({ doRefresh: true, expiresAt: graceEnd });
    expect(await tokenWordsFor(ROTATE_TOKEN_ID, [successor, replaced])).toBe(`Rotate token (being replaced until ${formatDateTime(graceEnd)})`);
  });

  it("says a revoked or expired token is refused on its next poll", async () => {
    const revoked = listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", revokedAt: "2026-10-14T09:00:00.000Z" });
    expect(await tokenWordsFor(DEFAULT_TOKEN_ID, [revoked])).toBe("Revoked or expired: refused on its next poll");
  });

  it("says a token the list doesn't hold is unknown", async () => {
    expect(await tokenWordsFor("e8f90a1b-2c3d-4e4f-95a6-b7c8d9e0f1a2", TOKENS)).toBe("Unknown token");
  });

  it("shows a dash for a collector with no token", async () => {
    expect(await tokenWordsFor(null, TOKENS)).toBe("—");
  });

  it("reads the fleet's tokens with the details, and says so when the read fails", async () => {
    api.getEnrollmentTokens.mockRejectedValue(new ApiError("fleets_unavailable", "The fleet service is unavailable.", { status: 503 }));
    renderDetails();
    expect(rowValue("Token")).toHaveTextContent("Loading…");
    expect(await within(rowValue("Token")).findByText(TOKENS_FAILED_WORDS)).toBeInTheDocument();
    await settled();
    expect(api.getEnrollmentTokens).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

/** `count` errors, newest first, numbered from `from`. */
function errorsFrom(from: number, count: number): CollectorError[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    return collectorError({
      id: `00000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`,
      reportedAt: new Date(NOW - n * 60_000).toISOString(),
      message: `error number ${n}`,
    });
  });
}

const errorSection = () => within(dialog()).getByRole("heading", { name: "Error history" }).parentElement!;

describe("CollectorDetailsDialog's error history (decision 24)", () => {
  it("reads 20 a page, newest first, each its time and its message in a <pre>, with Load more until the last", async () => {
    api.getCollectorErrors.mockImplementation(async (_organizationId, _fleetId, _collectorId, query = {}) =>
      query.cursor === undefined ? { errors: errorsFrom(1, 20), nextCursor: "page-2" } : { errors: errorsFrom(21, 5), nextCursor: null },
    );
    renderDetails();
    const user = userEvent.setup();
    expect(await within(dialog()).findByText("error number 1")).toBeInTheDocument();
    expect(api.getCollectorErrors).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, COLLECTOR_ID, { limit: 20 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const messages = () => [...errorSection().querySelectorAll("pre")].map((pre) => pre.textContent);
    expect(messages()).toHaveLength(20);
    expect(messages()[0]).toBe("error number 1");
    const first = within(errorSection()).getByText("error number 1");
    expect(first.tagName).toBe("PRE");
    expect(first).toHaveClass("max-h-48", "overflow-y-auto", "whitespace-pre-wrap", "break-words", "font-mono", "text-xs");
    // Each message is bounded and scrolls, and a keyboard can reach it to scroll it.
    // Each named by fixed words, never the error's text (the final fix wave).
    for (const pre of errorSection().querySelectorAll("pre")) {
      expect(pre).toHaveAttribute("tabindex", "0");
      expect(pre).toHaveAttribute("aria-label", "Error message");
    }
    // Each a group, so the fixed name counts (ARIA 1.2 names no role-less <pre>), and none a landmark: 20 to 100 duplicates (axe's landmark-unique).
    expect(within(errorSection()).getAllByRole("group", { name: "Error message" })).toEqual([...errorSection().querySelectorAll("pre")]);
    expect(within(errorSection()).queryAllByRole("region")).toEqual([]);
    expect(first.previousElementSibling).toHaveTextContent(formatDateTime(new Date(NOW - 60_000).toISOString()));

    await user.click(within(errorSection()).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(messages()).toHaveLength(25));
    expect(api.getCollectorErrors).toHaveBeenLastCalledWith(
      GROUP_ID,
      FLEET_ID,
      COLLECTOR_ID,
      { limit: 20, cursor: "page-2" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(messages()[24]).toBe("error number 25");
    expect(within(errorSection()).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it('says "No errors reported." for none', async () => {
    renderDetails();
    expect(await within(dialog()).findByText("No errors reported.")).toBeInTheDocument();
    expect(within(errorSection()).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says a first read failed, with Try again, which reads it again", async () => {
    api.getCollectorErrors.mockRejectedValueOnce(new ApiError("fleets_unavailable", "The fleet service is unavailable.", { status: 503 }));
    api.getCollectorErrors.mockResolvedValueOnce({ errors: errorsFrom(1, 1), nextCursor: null });
    const error = vi.spyOn(toast, "error");
    renderDetails();
    const user = userEvent.setup();
    expect(await within(dialog()).findByText(ERROR_HISTORY_FAILED_MESSAGE)).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
    await user.click(within(errorSection()).getByRole("button", { name: "Try again" }));
    expect(await within(dialog()).findByText("error number 1")).toBeInTheDocument();
    expect(api.getCollectorErrors).toHaveBeenCalledTimes(2);
  });

  it("toasts a failed Load more and keeps the errors shown", async () => {
    api.getCollectorErrors.mockResolvedValueOnce({ errors: errorsFrom(1, 20), nextCursor: "page-2" });
    api.getCollectorErrors.mockRejectedValueOnce(new ApiError("network_error", "Network error."));
    const error = vi.spyOn(toast, "error");
    renderDetails();
    const user = userEvent.setup();
    await within(dialog()).findByText("error number 1");
    await user.click(within(errorSection()).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(ERROR_HISTORY_FAILED_MESSAGE));
    expect(error).toHaveBeenCalledTimes(1);
    expect(within(errorSection()).getByText("error number 20")).toBeInTheDocument();
    expect(within(errorSection()).getByRole("button", { name: "Load more" })).toBeEnabled();
  });
});

const attributesSection = () => within(dialog()).getByRole("heading", { name: "Reported attributes" }).parentElement!;

describe("CollectorDetailsDialog's reported attributes (decision 24)", () => {
  it("lists them sorted by key in code units, not by locale", async () => {
    const attributes = { "b.key": "2", "B.key": "1", "\u00e9.key": "4", "a.key": "3", "Z.key": "0" };
    renderDetails(collector({ reported: { collectorVersion: null, ip: null, hostIp: null, attributes } }));
    await settled();
    const keys = [...attributesSection().querySelectorAll("dt")].map((term) => term.textContent);
    expect(keys).toEqual(["B.key", "Z.key", "a.key", "b.key", "\u00e9.key"]);
    const values = [...attributesSection().querySelectorAll("dd")].map((value) => value.textContent);
    expect(values).toEqual(["1", "0", "3", "2", "4"]);
  });

  it.each([
    ["null", null],
    ["empty", {}],
  ])('says "None reported." when they are %s', async (_name, attributes) => {
    renderDetails(collector({ reported: { collectorVersion: null, ip: null, hostIp: null, attributes } }));
    await settled();
    expect(within(attributesSection()).getByText("None reported.")).toBeInTheDocument();
  });
});

describe("CollectorDetailsDialog's reads: aborted on close, hang guards, one opening's at a time", () => {
  /** Every read hangs until aborted; each signal kept. */
  function hangEverything() {
    api.getCollector.mockImplementation((_o, _f, _c, options = {}) => hang(options.signal));
    api.getEnrollmentTokens.mockImplementation((_o, _f, options = {}) => hang(options.signal));
    api.getCollectorErrors.mockImplementation((_o, _f, _c, _q, options = {}) => hang(options.signal));
  }

  const signalOf = (spy: { mock: { calls: unknown[][] } }, call = 0): AbortSignal => {
    const args = spy.mock.calls[call]!;
    return (args.at(-1) as { signal: AbortSignal }).signal;
  };

  it("aborts the collector's, the tokens' and the errors' reads when the dialog closes", async () => {
    hangEverything();
    renderDetails();
    const user = userEvent.setup();
    const signals = [signalOf(api.getCollector), signalOf(api.getEnrollmentTokens), signalOf(api.getCollectorErrors)];
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
  });

  it("aborts a Load more when the dialog closes", async () => {
    api.getCollectorErrors.mockResolvedValueOnce({ errors: errorsFrom(1, 20), nextCursor: "page-2" });
    api.getCollectorErrors.mockImplementation((_o, _f, _c, _q, options = {}) => hang(options.signal));
    const error = vi.spyOn(toast, "error");
    renderDetails();
    const user = userEvent.setup();
    await within(dialog()).findByText("error number 1");
    await user.click(within(errorSection()).getByRole("button", { name: "Load more" }));
    const loadMore = signalOf(api.getCollectorErrors, 1);
    expect(loadMore.aborted).toBe(false);
    await user.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadMore.aborted).toBe(true);
    // The aborted Load more's failure, after the close, toasts nothing.
    await act(async () => {});
    expect(error).not.toHaveBeenCalled();
  });

  it("ends the opening's reads that never answer at 10 s: the row's data kept, the tokens and errors failed", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: NOW });
    hangEverything();
    renderDetails();
    await act(() => vi.advanceTimersByTimeAsync(FLEET_READ_TIMEOUT_MS - 1));
    const signals = [signalOf(api.getCollector), signalOf(api.getEnrollmentTokens), signalOf(api.getCollectorErrors)];
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();
    expect(rowValue("Token")).toHaveTextContent(TOKENS_FAILED_WORDS);
    expect(within(errorSection()).getByText(ERROR_HISTORY_FAILED_MESSAGE)).toBeInTheDocument();
  });

  it("drops an earlier opening's late answers: a new opening shows only its own reads", async () => {
    const first = {
      collector: held<Collector>(),
      errors: held<CollectorErrorsPage>(),
    };
    api.getCollector.mockReturnValueOnce(first.collector.promise);
    api.getCollectorErrors.mockReturnValueOnce(first.errors.promise);
    renderDetails();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Open again" }));
    expect(await within(dialog()).findByText("No errors reported.")).toBeInTheDocument();

    await act(async () => {
      first.collector.release(collector({ name: "late-name" }));
      first.errors.release({ errors: [collectorError({ message: "late error" })], nextCursor: null });
    });
    expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();
    expect(within(dialog()).queryByText("late error")).toBeNull();
    expect(within(dialog()).getByText("No errors reported.")).toBeInTheDocument();
    expect(api.getCollector).toHaveBeenCalledTimes(2);
  });
});

describe("CollectorDetailsDialog's footer (the edit hand-off; Preflight ruling 17)", () => {
  it('"Edit collector" closes the details and hands the collector to the edit dialog', async () => {
    renderDetails();
    await settled();
    const user = userEvent.setup();
    await user.click(within(dialog()).getByRole("button", { name: "Edit collector" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onEdit).toHaveBeenCalledWith(collector());
  });

  it('renders "Edit collector" inert until the edit dialog is wired', async () => {
    renderDetails(collector(), { withoutEdit: true });
    await settled();
    const user = userEvent.setup();
    await user.click(within(dialog()).getByRole("button", { name: "Edit collector" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("CollectorDetailsDialog's privacy (decisions 13 and 32)", () => {
  it("holds no name, address, attribute or error text in any attribute, and the private text only inside ph-no-capture", async () => {
    const name = "canary-collector-7e1d";
    const groupName = "canary-group-04af";
    const configurationName = "canary-configuration-b2c9";
    const address = "198.51.100.77";
    const attributeKey = "canary.attribute.key-3f";
    const attributeValue = "canary-attribute-value-8a";
    const errorText = "canary-error-message-5c";
    const version = publishedVersion({ configurationName });
    const row = collector({
      name,
      groupId: GATEWAYS_GROUP_ID,
      pin: { kind: "version", versionId: version.versionId, publishedVersionId: PUBLISHED_VERSION_ID, version },
      resolution: { from: "pinnedVersion", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), version },
      effective: { sha256: sha256Of("b"), status: "failed", error: errorText, at: "2026-10-14T09:58:00.000Z" },
      reported: { collectorVersion: "0.162.0", ip: address, hostIp: null, attributes: { [attributeKey]: attributeValue } },
    });
    api.getCollector.mockResolvedValue(row);
    api.getCollectorErrors.mockResolvedValue({ errors: [collectorError({ message: errorText })], nextCursor: null });
    renderDetails(row, { groups: [collectorGroup(), gatewaysGroup({ name: groupName })] });
    // Both places the error shows, the Error row and the history: a wait on one alone resolves on the row before the history is read.
    await waitFor(() => expect(within(dialog()).getAllByText(errorText)).toHaveLength(2));

    // Shown, as text.
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    expect(rowValue("Token")).toHaveTextContent("Rotate token (current)");
    expect(rowValue("Error")).toHaveTextContent(errorText);
    expect(rowValue("Group")).toHaveTextContent(groupName);
    expect(rowValue("Configuration name")).toHaveTextContent(configurationName);
    expect(rowValue("Pin")).toHaveTextContent(`${configurationName} @v4`);
    expect(rowValue("Target Version")).toHaveTextContent(`${configurationName} @v4`);
    expect(rowValue("IP Address")).toHaveTextContent(address);
    for (const text of [name, groupName, configurationName, address, attributeKey, attributeValue, errorText, "Rotate token"]) {
      expectNoAttributeHolds(text);
    }
    // The private text only inside ph-no-capture.
    for (const text of [attributeKey, attributeValue, errorText]) {
      const shown = within(dialog()).getAllByText(text);
      for (const element of shown) expect(element.closest(".ph-no-capture"), text).not.toBeNull();
    }
    for (const heading of ["Error history", "Reported attributes"]) {
      expect(within(dialog()).getByRole("heading", { name: heading }).closest(".ph-no-capture"), heading).not.toBeNull();
    }
    // Every text node holding private text sits inside ph-no-capture.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if ([attributeKey, attributeValue, errorText].some((canary) => text.includes(canary))) {
        expect(node.parentElement!.closest(".ph-no-capture"), text).not.toBeNull();
      }
    }
  });
});

// D17d-1 decision 23; Preflight ruling 26: a Kubernetes fleet's collector's Node, and its group by role.
describe("CollectorDetailsDialog on a Kubernetes-supervisor fleet", () => {
  const withAttributes = (attributes: Record<string, string> | null) => collector({ reported: { ...collector().reported, attributes } });

  it("adds a Node row after UID, the reported k8s.node.name, inside ph-no-capture and in no attribute", async () => {
    const node = "canary-node-6b2e";
    renderDetails(withAttributes({ "k8s.node.name": node, "k8s.pod.name": "agent-xyz" }), { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" });
    await settled();
    expect(rowLabels().slice(0, 7)).toEqual(["IP Address", "Name", "UID", "Node", "Group", "Status", "Configuration"]);
    expect(rowValue("Node")).toHaveTextContent(new RegExp(`^${node}$`));
    expect(rowValue("Node").querySelector(".ph-no-capture")).not.toBeNull();
    // The Node row's and the reported attributes' copies, each inside ph-no-capture; no attribute, no title.
    expect(expectTextOnlyInsideNoCapture(node)).toBe(2);
    expectNoAttributeHolds(node);
  });

  it.each([
    ["no attributes reported", null],
    ["attributes without k8s.node.name", { "k8s.pod.name": "agent-xyz" }],
    ["an empty k8s.node.name", { "k8s.node.name": "" }],
  ])("shows a dash for the Node with %s", async (_why, attributes) => {
    renderDetails(withAttributes(attributes), { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" });
    await settled();
    expect(rowValue("Node")).toHaveTextContent(/^—$/);
    expect(rowValue("Node").querySelector(".ph-no-capture")).not.toBeNull();
  });

  it("reads k8s.node.name as an own key only, never an inherited one", async () => {
    const inherited = Object.assign(Object.create({ "k8s.node.name": "inherited-node" }) as Record<string, string>, { "k8s.pod.name": "agent-xyz" });
    renderDetails(withAttributes(inherited), { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" });
    await settled();
    expect(rowValue("Node")).toHaveTextContent(/^—$/);
    expect(dialog()).not.toHaveTextContent("inherited-node");
  });

  it.each([
    ["the Default group", collector().groupId, "Agent"],
    ["cluster", CLUSTER_GROUP_ID, "Cluster"],
    ["a gateway", GATEWAYS_GROUP_ID, "gateways"],
  ])("names %s's group as the screens do: %s", async (_which, groupId, shown) => {
    renderDetails(collector({ groupId }), { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" });
    await settled();
    expect(rowValue("Group")).toHaveTextContent(new RegExp(`^${shown}$`));
  });

  it("has no Node row on a server fleet, even with k8s.node.name reported", async () => {
    renderDetails(withAttributes({ "k8s.node.name": "node-a" }));
    await settled();
    expect(rowLabels()).not.toContain("Node");
    expect(rowValue("Group")).toHaveTextContent(/^Default$/);
  });
});
