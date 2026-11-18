/**
 * The run dialog's Templates step (D14b decision 13; Preflight rulings 12, 17
 * and 19): the live templates read afresh each time the step shows, the
 * filters by receiver type (palette labels) and signal, the details, the
 * viewer, the download (bytes, the original file name, a detached anchor),
 * the pick for a one-off run (its head from `…/file/head`), a template
 * deleted after it was picked, a failed read, and replay's rule (no name in
 * an attribute or a URL).
 *
 * Rendered in the whole tab, as TestingTab.test.tsx does: Monaco is stubbed;
 * the API is its client's functions, spied on; toasts are spied on.
 */

import type { EditorProps } from "@monaco-editor/react";
import type { TestTemplate } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      // Once, as Monaco mounts once.
    }, []);
    return <pre data-monaco-stub="">{props.value}</pre>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, MINE, signedInMember, versionFixture } from "~/test/configurations.js";
import { testRunFixture } from "~/test/test-runs.js";
import { TestingTab } from "./TestingTab.js";

/** Two pipelines: logs fed by OTLP, logs/zqfile by filelog (a name carrying the private-text marker). */
const YAML = `receivers:
  otlp:
    protocols:
      http: {}
  filelog:
    include: [/var/log/app.log]
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
    logs/zqfile:
      receivers: [filelog]
      exporters: [debug]
`;
const VERSION = versionFixture({ yamlContent: YAML });

/** A template; names, descriptions and file names carry the private-text marker. */
function templateFixture(overrides: Partial<TestTemplate> = {}): TestTemplate {
  return {
    id: "0199f200-0000-7000-8000-000000000001",
    name: "zq-otlp-logs",
    description: "zq-template-description",
    receiverType: "otlp",
    signal: "logs",
    fileName: "zq-otlp-logs.json",
    contentType: "application/json",
    sizeBytes: 20,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

const OTLP_LOGS = templateFixture();
const FILELOG = templateFixture({
  id: "0199f200-0000-7000-8000-000000000002",
  name: "zq-app-lines",
  description: "",
  receiverType: "filelog",
  fileName: "zq-app-lines.log",
});
const HOST_METRICS = templateFixture({
  id: "0199f200-0000-7000-8000-000000000003",
  name: "zq-host-metrics",
  receiverType: "hostmetrics",
  signal: "metrics",
  fileName: "zq-host-metrics.json",
});

const encode = (text: string) => new TextEncoder().encode(text);
const OTLP_BYTES = encode('{"resourceLogs":[{"zq":"template"}]}');

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

let listTemplates: MockInstance<typeof apiClient.getTestTemplates>;
let readFile: MockInstance<typeof apiClient.getTestTemplateFile>;
let readHead: MockInstance<typeof apiClient.getTestTemplateFileHead>;
let queue: MockInstance<typeof apiClient.queueTestRun>;
let toastError: MockInstance<typeof toast.error>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useTestingStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: useTestingStore.getState().runs }));
  vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [] });
  listTemplates = vi.spyOn(apiClient, "getTestTemplates").mockResolvedValue({ templates: [OTLP_LOGS, FILELOG, HOST_METRICS] });
  readFile = vi.spyOn(apiClient, "getTestTemplateFile").mockResolvedValue(OTLP_BYTES);
  readHead = vi.spyOn(apiClient, "getTestTemplateFileHead").mockResolvedValue(OTLP_BYTES);
  queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async () => ({ run: testRunFixture() }));
  toastError = vi.spyOn(toast, "error");
});

async function openTemplates() {
  const user = userEvent.setup();
  render(<TestingTab />);
  await user.click(screen.getByRole("button", { name: "Configure and run" }));
  const dialog = await screen.findByRole("dialog", { name: "Select Test File" });
  await user.click(within(dialog).getByRole("button", { name: "Templates" }));
  await screen.findByText("zq-otlp-logs");
  return { user, dialog };
}

/** The templates' names, as the step lists them. */
const listed = () => screen.queryAllByRole("button", { pressed: false }).concat(screen.queryAllByRole("button", { pressed: true }));
const names = () =>
  listed()
    .map((row) => row.textContent)
    .filter((text): text is string => text !== null && text.startsWith("zq-"));

/** A filter's options, as its list shows them. */
async function optionsOf(user: ReturnType<typeof userEvent.setup>, filter: "Receiver Type" | "Signal Type") {
  await user.click(screen.getByRole("combobox", { name: filter }));
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  await user.keyboard("{Escape}");
  return options;
}

async function choose(user: ReturnType<typeof userEvent.setup>, filter: "Receiver Type" | "Signal Type", option: string) {
  await user.click(screen.getByRole("combobox", { name: filter }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("the Templates step (Preflight ruling 17)", () => {
  it("lists the live templates, read afresh each time the step shows", async () => {
    const { user, dialog } = await openTemplates();
    expect(names()).toEqual(["zq-otlp-logs", "zq-app-lines", "zq-host-metrics"]);
    expect(listTemplates).toHaveBeenCalledOnce();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    listTemplates.mockResolvedValueOnce({ templates: [FILELOG] });
    await user.click(within(dialog).getByRole("button", { name: "Templates" }));

    await waitFor(() => expect(names()).toEqual(["zq-app-lines"]));
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it("filters by 'Receiver Type' and 'Signal Type': 'Any' at first, the values present sorted by their labels (the palette's; 'Logs', 'Metrics': Ruling 40), each filter labelled", async () => {
    const { user } = await openTemplates();

    expect(screen.getByRole("combobox", { name: "Receiver Type" })).toHaveTextContent("Any");
    expect(screen.getByRole("combobox", { name: "Signal Type" })).toHaveTextContent("Any");
    // Labelled from the palette (the next test shows the order is the labels').
    expect(await optionsOf(user, "Receiver Type")).toEqual(["Any", "File Log", "Host Metrics", "OTLP"]);
    expect(await optionsOf(user, "Signal Type")).toEqual(["Any", "Logs", "Metrics"]);

    await choose(user, "Receiver Type", "OTLP");
    expect(names()).toEqual(["zq-otlp-logs"]);
    await choose(user, "Signal Type", "Metrics");
    expect(screen.getByRole("combobox", { name: "Signal Type" })).toHaveTextContent("Metrics");
    expect(screen.getByText("No templates match the selected filters.")).toBeInTheDocument();
    await choose(user, "Receiver Type", "Any");
    expect(names()).toEqual(["zq-host-metrics"]);
  });

  it("forgets the highlight of a template a filter hides: it doesn't come back highlighted when the filter widens, and OK holds (D14b Ruling 42)", async () => {
    const { user, dialog } = await openTemplates();
    await user.click(screen.getByRole("button", { name: "zq-otlp-logs", pressed: false }));
    expect(screen.getByRole("button", { name: "zq-otlp-logs", pressed: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeEnabled();

    await choose(user, "Receiver Type", "File Log");
    expect(names()).toEqual(["zq-app-lines"]);
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();
    await choose(user, "Receiver Type", "Any");

    expect(screen.getByRole("button", { name: "zq-otlp-logs", pressed: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();
  });

  it("sorts the receiver types by label, the raw value as a fallback (ruling 12): by value they would sort the other way", async () => {
    listTemplates.mockResolvedValue({
      templates: [
        templateFixture({ id: "0199f200-0000-7000-8000-000000000011", receiverType: "kubelet_zz", name: "zq-a" }),
        templateFixture({ id: "0199f200-0000-7000-8000-000000000012", receiverType: "kubeletstats", name: "zq-b" }),
      ],
    });
    const user = userEvent.setup();
    render(<TestingTab />);
    await user.click(screen.getByRole("button", { name: "Configure and run" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Templates" }));
    await screen.findByText("zq-a");

    // By value: kubelet_zz, kubeletstats. By label: Kubelet Stats, then the unlabelled kubelet_zz.
    expect(await optionsOf(user, "Receiver Type")).toEqual(["Any", "Kubelet Stats", "kubelet_zz"]);
  });

  it("says 'No templates available.' when there are none", async () => {
    listTemplates.mockResolvedValue({ templates: [] });
    const user = userEvent.setup();
    render(<TestingTab />);
    await user.click(screen.getByRole("button", { name: "Configure and run" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Templates" }));

    expect(await screen.findByText("No templates available.")).toBeInTheDocument();
  });

  it("toasts 'Failed to load templates' when the read fails, and nothing once the session has ended", async () => {
    listTemplates.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    const user = userEvent.setup();
    render(<TestingTab />);
    await user.click(screen.getByRole("button", { name: "Configure and run" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Templates" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to load templates"));

    toastError.mockClear();
    listTemplates.mockRejectedValueOnce(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Templates" }));
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows a template's details: its name, its receiver by label, its signal by its words, its description or 'No description.'; the buttons named by hidden text, titled with fixed words", async () => {
    const { user } = await openTemplates();

    const details = screen.getByRole("button", { name: "Show details for zq-otlp-logs" });
    expect(details).toHaveAttribute("title", "Show details");
    expect(screen.getByRole("button", { name: "Download zq-otlp-logs" })).toHaveAttribute("title", "Download");
    expect(screen.getByRole("button", { name: "View contents of zq-otlp-logs" })).toHaveAttribute("title", "View contents");
    await user.click(details);
    // The popover's content: the description's paragraph's parent.
    const popover = (await screen.findByText("zq-template-description")).parentElement!;
    expect(within(popover).getByText("OTLP")).toBeInTheDocument();
    expect(within(popover).getByText("Logs")).toBeInTheDocument();
    expect(within(popover).queryByText("logs")).toBeNull();
    expect(within(popover).getByText("zq-template-description")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Show details for zq-app-lines" }));
    expect(await screen.findByText("No description.")).toBeInTheDocument();
    expect(screen.getByText("File Log")).toBeInTheDocument();
  });

  it("views a template's contents in the viewer, inside ph-no-capture, its name the title", async () => {
    const { user } = await openTemplates();

    await user.click(screen.getByRole("button", { name: "View contents of zq-otlp-logs" }));

    const viewer = await screen.findByRole("dialog", { name: "zq-otlp-logs" });
    expect(viewer).toHaveClass("ph-no-capture");
    expect(await within(viewer).findByText(/"zq": "template"/)).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith(OTLP_LOGS.id);
  });

  it("downloads a template's bytes under its original file name through a detached anchor: no name in a URL or an attribute; 'Failed to download {name}'", async () => {
    const created: Blob[] = [];
    const clicked: { connected: boolean; download: string; href: string }[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob);
        return `blob:stub-${created.length}`;
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ connected: this.isConnected, download: this.download, href: this.href });
    });
    const { user } = await openTemplates();

    await user.click(screen.getByRole("button", { name: "Download zq-otlp-logs" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toEqual({ connected: false, download: "zq-otlp-logs.json", href: "blob:stub-1" });
    const bytes = await new Promise<number[]>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
      reader.readAsArrayBuffer(created[0]!);
    });
    expect(bytes).toEqual([...OTLP_BYTES]);
    // The request names the template by its id alone.
    expect(readFile).toHaveBeenCalledWith(OTLP_LOGS.id);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);

    readFile.mockRejectedValueOnce(new ApiError("test_template_not_found", "Test template not found", { status: 404 }));
    await user.click(screen.getByRole("button", { name: "Download zq-app-lines" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to download zq-app-lines", { className: "ph-no-capture" }));
  });

  it("picks a template for a run: OK, 'Selected File:' its name; Run queues it by id, its head read from …/file/head; it is remembered", async () => {
    const { user, dialog } = await openTemplates();

    expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "zq-otlp-logs", pressed: false }));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(await within(dialog).findByText("zq-otlp-logs", { selector: "span.font-mono" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      templateId: OTLP_LOGS.id,
      pipeline: "logs",
      signal: "logs",
      durationSeconds: 5,
      yaml: YAML,
      collectorVersion: "0.162.0",
    });
    expect(readHead).toHaveBeenCalledWith(OTLP_LOGS.id, { signal: expect.any(AbortSignal) });
    expect(useTestingStore.getState().selectedTemplate).toEqual({ id: OTLP_LOGS.id, name: OTLP_LOGS.name });
    expect(useTestingStore.getState().selectedFile).toBeNull();

    // It opens with the template next time.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Select Test File" })).toBeNull());
    act(() => useTestingStore.setState({ runs: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Configure and run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Configure and run" }));
    const again = await screen.findByRole("dialog", { name: "Select Test File" });
    expect(within(again).getByText("Selected File:")).toHaveTextContent("Selected File: zq-otlp-logs");
  });

  it("asks the fixture-shape question from the template's head when it doesn't suit the pipeline", async () => {
    // Raw lines on the OTLP pipeline.
    readHead.mockResolvedValue(encode("zq raw line one\nzq raw line two\n"));
    const { user, dialog } = await openTemplates();
    await user.click(screen.getByRole("button", { name: "zq-app-lines", pressed: false }));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("dialog", { name: "Fixture may not match the receiver" })).toBeInTheDocument();
    expect(queue).not.toHaveBeenCalled();
  });

  it("a template deleted after it was picked: the API's words, the selection cleared, the list read again", async () => {
    const { user, dialog } = await openTemplates();
    await user.click(screen.getByRole("button", { name: "zq-otlp-logs", pressed: false }));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    queue.mockRejectedValueOnce(new ApiError("test_template_not_found", "Test template not found", { status: 404 }));
    listTemplates.mockResolvedValue({ templates: [FILELOG, HOST_METRICS] });

    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test template not found"));
    expect(within(dialog).getByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(within(dialog).getByRole("button", { name: "Run" })).toBeDisabled();
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(useTestingStore.getState().selectedTemplate).toBeNull();
  });
});

describe("a template deleted after it was picked, the list's read failing (D14b Ruling 42)", () => {
  it("clears the selection all the same: the dialog's and the remembered one (Run remembers it before it queues)", async () => {
    const { user, dialog } = await openTemplates();
    await user.click(screen.getByRole("button", { name: "zq-otlp-logs", pressed: false }));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    queue.mockRejectedValueOnce(new ApiError("test_template_not_found", "Test template not found", { status: 404 }));
    // The list can't be read again: only the 404 says it's gone.
    listTemplates.mockRejectedValue(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));

    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test template not found"));
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(within(dialog).getByRole("button", { name: "Run" })).toBeDisabled();
    expect(useTestingStore.getState().selectedTemplate).toBeNull();
  });
});

describe("replay (Preflight ruling 19; ADR 0024)", () => {
  it("puts no template name, description or file name in any attribute, with the list, the details and the viewer shown", async () => {
    const { user } = await openTemplates();
    await user.click(screen.getByRole("button", { name: "Show details for zq-otlp-logs" }));
    await screen.findByText("zq-template-description");
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toMatch(/zq/);
        }
      }
    };
    scan();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "View contents of zq-otlp-logs" }));
    await screen.findByRole("dialog", { name: "zq-otlp-logs" });
    scan();
  });
});
