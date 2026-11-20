import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow, FlowLintResponse } from "@telflo/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowAdminDialog } from "./FlowAdminDialog.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import type { FlowFields } from "~/lib/flows/flow-admin.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { ACME, CONTRIB, RETIRED_VERSION, seedCatalogue } from "~/test/collector-distributions.js";
import { PII_REDACTION, TAIL_SAMPLING, TAIL_SAMPLING_YAML, makeFlow } from "~/test/flows.js";

/*
 * Product admin's flow dialog: the fields and their limits, the slug
 * following the name until edited, the signals from the pipelines, its
 * validation messages, the version select, the security check, and the
 * configuration text kept inside `ph-no-capture`.
 */

/** A secret a product admin might paste, which the check exists to find. */
const PASTED_SECRET = "sk_live_51Hq9PastedSecretValue";
const SECRET_YAML = `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlphttp:
    endpoint: https://ingest.vendor.example
    headers:
      authorization: Bearer ${PASTED_SECRET}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
`;

const FINDINGS: FlowLintResponse = {
  blocked: true,
  findings: [
    { severity: "warn", code: "no-memory-limiter", message: "No memory_limiter processor.", path: "processors" },
    {
      severity: "block",
      code: "hardcoded-credential",
      message: `A credential is written into the config: Bearer ${PASTED_SECRET}`,
      path: ".exporters.otlphttp.headers.authorization",
    },
  ],
  destinations: ["exporters.otlphttp.endpoint → https://ingest.vendor.example"],
};

function renderDialog(flow: Flow | null = null) {
  const onSave = vi.fn<(fields: FlowFields) => Promise<void>>().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onProductAdminLost = vi.fn();
  render(
    <FlowAdminDialog open flow={flow} onClose={onClose} onSave={onSave} onProductAdminLost={onProductAdminLost} />,
  );
  return { user: userEvent.setup(), onSave, onClose, onProductAdminLost };
}

const field = (label: string) => screen.getByLabelText(label);

/** Fills the fields a new flow needs, the YAML pasted (typing treats its brackets as keys). */
async function fillNewFlow(user: ReturnType<typeof userEvent.setup>, yaml = PII_REDACTION.yaml) {
  await user.type(field("Name"), "PII Gateway");
  await user.type(field("Summary"), "Strips emails.");
  await user.click(field("Configuration YAML"));
  await user.paste(yaml);
}

describe("FlowAdminDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCollectorCatalogue();
    seedCatalogue([CONTRIB, ACME]);
  });

  it("shows the title, description and fields, with their limits", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "New flow" });
    expect(dialog).toHaveTextContent(
      "Published as Built by Telflo and visible to every user.",
    );
    expect(field("Name")).toHaveAttribute("maxLength", "120");
    expect(field("URL slug")).toHaveAttribute("maxLength", "80");
    expect(field("Summary")).toHaveAttribute("maxLength", "300");
    expect(field("Author (optional)")).toHaveAttribute("maxLength", "80");
    for (const label of ["Description", "Tags", "Sort order", "Source link (optional)", "Configuration YAML"]) {
      expect(field(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Create flow" })).toBeInTheDocument();
    expect(screen.getByText("no pipelines detected")).toBeInTheDocument();
  });

  it("slugifies the name into the slug until the slug is edited; the description names no public page", async () => {
    const { user } = renderDialog();

    await user.type(field("Name"), "Hello, World 2!");
    expect(field("URL slug")).toHaveValue("hello-world-2");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("/flows/");

    await user.clear(field("URL slug"));
    await user.type(field("URL slug"), "custom");
    await user.type(field("Name"), " more");
    expect(field("URL slug")).toHaveValue("custom");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("/flows/");
  });

  it("names the author in the description when one is given", async () => {
    const { user } = renderDialog();
    await user.type(field("Author (optional)"), "ClickStack");
    expect(screen.getByRole("dialog")).toHaveTextContent("Published as Built by ClickStack");
  });

  it("derives the signals from the YAML's pipelines", async () => {
    const { user } = renderDialog();
    await user.click(field("Configuration YAML"));
    await user.paste(TAIL_SAMPLING_YAML);

    expect(screen.queryByText("no pipelines detected")).toBeNull();
    expect(screen.getByText("traces")).toBeInTheDocument();
    expect(screen.getByText("metrics")).toBeInTheDocument();
    expect(screen.queryByText("logs")).toBeNull();
  });

  describe("the validation messages, nothing saved", () => {
    it("asks for the name, slug, summary and YAML", async () => {
      const { user, onSave } = renderDialog();
      await user.click(screen.getByRole("button", { name: "Create flow" }));

      expect(screen.getByText("Name, slug, summary and YAML are all required.")).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("refuses a configuration without pipelines, or one that can't be read", async () => {
      const { user, onSave } = renderDialog();
      await fillNewFlow(user, "receivers:\n  otlp:\n");
      await user.click(screen.getByRole("button", { name: "Create flow" }));
      expect(screen.getByText("This config has no pipelines, so it would appear under no signal.")).toBeInTheDocument();

      await user.clear(field("Configuration YAML"));
      await user.paste("service:\n  pipelines:\n    logs: [\n");
      await user.click(screen.getByRole("button", { name: "Create flow" }));
      expect(screen.getByText("This config has no pipelines, so it would appear under no signal.")).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("refuses a source link that isn't http(s)", async () => {
      const { user, onSave } = renderDialog();
      await fillNewFlow(user);
      await user.type(field("Source link (optional)"), "javascript:alert(1)");
      await user.click(screen.getByRole("button", { name: "Create flow" }));

      expect(screen.getByText("Source URL must start with http:// or https://")).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("refuses a slug the API would, with the contract's sentence", async () => {
      const { user, onSave } = renderDialog();
      await fillNewFlow(user);
      await user.clear(field("URL slug"));
      await user.type(field("URL slug"), "Bad Slug");
      await user.click(screen.getByRole("button", { name: "Create flow" }));

      expect(screen.getByText("Slug must be lowercase letters and digits joined by single hyphens.")).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  it("saves every field trimmed, the summary standing in for a blank description, the tags split", async () => {
    const { user, onSave, onClose } = renderDialog();
    await fillNewFlow(user);
    await user.type(field("Tags"), " privacy, , logs ");
    await user.clear(field("Sort order"));
    await user.type(field("Sort order"), "15");
    await user.type(field("Source link (optional)"), "  https://example.com/c.yaml ");
    await user.click(screen.getByRole("button", { name: "Create flow" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      slug: "pii-gateway",
      name: "PII Gateway",
      summary: "Strips emails.",
      description: "Strips emails.",
      signals: ["logs"],
      tags: ["privacy", "logs"],
      yaml: PII_REDACTION.yaml,
      collectorDistribution: "otelcol-contrib",
      collectorVersion: "0.162.0",
      sourceUrl: "https://example.com/c.yaml",
      authorName: null,
      sortOrder: 15,
    });
  });

  it("shows the API's refusal and stays open", async () => {
    const { user, onSave, onClose } = renderDialog();
    onSave.mockRejectedValue(new ApiError("flow_slug_taken", "Another flow already has that slug.", { status: 409 }));
    await fillNewFlow(user);
    await user.click(screen.getByRole("button", { name: "Create flow" }));

    expect(await screen.findByText("Another flow already has that slug.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands a 403 product_admin_required to the page, which leaves", async () => {
    const { user, onSave, onProductAdminLost } = renderDialog();
    onSave.mockRejectedValue(new ApiError("product_admin_required", "Only product admins can do that.", { status: 403 }));
    await fillNewFlow(user);
    await user.click(screen.getByRole("button", { name: "Create flow" }));

    await waitFor(() => expect(onProductAdminLost).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Only product admins can do that.")).toBeNull();
  });

  describe("the distribution and the version", () => {
    it("offers the catalogue's distributions, and the distribution's versions newest first, the default chosen", async () => {
      const { user } = renderDialog();

      expect(screen.getByRole("combobox", { name: "Distribution" })).toHaveTextContent(CONTRIB.label);
      expect(screen.getByRole("combobox", { name: "Collector version" })).toHaveTextContent("0.162.0");
      await user.click(screen.getByRole("combobox", { name: "Collector version" }));
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "0.162.0",
        "0.161.0",
        "0.160.0",
      ]);
    });

    it("moves the version to the new distribution's default when the distribution changes", async () => {
      const { user, onSave } = renderDialog();
      await user.click(screen.getByRole("combobox", { name: "Distribution" }));
      await user.click(await screen.findByRole("option", { name: ACME.label }));

      expect(screen.getByRole("combobox", { name: "Collector version" })).toHaveTextContent("2.36.0");
      await fillNewFlow(user);
      await user.click(screen.getByRole("button", { name: "Create flow" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0]![0]).toMatchObject({ collectorDistribution: ACME.id, collectorVersion: "2.36.0" });
    });

    it("keeps an edited flow's pin, and marks one the catalogue no longer offers", async () => {
      const { user } = renderDialog(makeFlow({ collectorVersion: RETIRED_VERSION }));

      const version = screen.getByRole("combobox", { name: "Collector version" });
      expect(version).toHaveTextContent(`${RETIRED_VERSION} · no longer offered`);
      await user.click(version);
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "0.162.0",
        "0.161.0",
        "0.160.0",
        `${RETIRED_VERSION} · no longer offered`,
      ]);
    });

    it("shows an edited flow's pin unmarked while the catalogue can't say", () => {
      resetCollectorCatalogue();
      vi.spyOn(apiClient, "getCollectorDistributions").mockReturnValue(new Promise(() => {}));
      renderDialog(makeFlow({ collectorVersion: RETIRED_VERSION }));

      const version = screen.getByRole("combobox", { name: "Collector version" });
      expect(version).toHaveTextContent(RETIRED_VERSION);
      expect(version).not.toHaveTextContent("no longer offered");
    });
  });

  it("re-seeds from the flow being edited", () => {
    renderDialog(TAIL_SAMPLING);

    expect(screen.getByRole("dialog", { name: "Edit flow" })).toBeInTheDocument();
    expect(field("Name")).toHaveValue(TAIL_SAMPLING.name);
    expect(field("URL slug")).toHaveValue(TAIL_SAMPLING.slug);
    expect(field("Tags")).toHaveValue("sampling, cost");
    expect(field("Configuration YAML")).toHaveValue(TAIL_SAMPLING.yaml);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  describe("Run security check", () => {
    it("is disabled while the YAML is blank", () => {
      renderDialog();
      expect(screen.getByRole("button", { name: "Run security check" })).toBeDisabled();
    });

    it("lists the blocking findings, then the warnings, each with its path", async () => {
      const lintFlow = vi.spyOn(apiClient, "lintFlow").mockResolvedValue(FINDINGS);
      const { user } = renderDialog();
      await user.click(field("Configuration YAML"));
      await user.paste(SECRET_YAML);
      await user.click(screen.getByRole("button", { name: "Run security check" }));

      const block = await screen.findByText(FINDINGS.findings[1]!.message);
      expect(lintFlow).toHaveBeenCalledWith(SECRET_YAML);
      const rows = block.closest("div.space-y-1\\.5")!.children;
      expect([...rows].map((row) => row.textContent)).toEqual([
        `${FINDINGS.findings[1]!.path} ${FINDINGS.findings[1]!.message}`,
        `${FINDINGS.findings[0]!.path} ${FINDINGS.findings[0]!.message}`,
      ]);
      expect(screen.queryByText("No blocking issues.")).toBeNull();
    });

    it("says No blocking issues. when nothing blocks, listing any warnings", async () => {
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue({
        blocked: false,
        findings: [FINDINGS.findings[0]!],
        destinations: [],
      });
      const { user } = renderDialog(TAIL_SAMPLING);
      await user.click(screen.getByRole("button", { name: "Run security check" }));

      expect(await screen.findByText("No blocking issues.")).toBeInTheDocument();
      expect(screen.getByText(FINDINGS.findings[0]!.message)).toBeInTheDocument();
    });

    it("says No blocking issues. alone when there are no findings, and forgets it when the YAML changes", async () => {
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue({ blocked: false, findings: [], destinations: [] });
      const { user } = renderDialog(TAIL_SAMPLING);
      await user.click(screen.getByRole("button", { name: "Run security check" }));
      expect(await screen.findByText("No blocking issues.")).toBeInTheDocument();

      await user.type(field("Configuration YAML"), "#");
      expect(screen.queryByText("No blocking issues.")).toBeNull();
    });

    it("shows the API's message when the check is refused for going too fast (429)", async () => {
      vi.spyOn(apiClient, "lintFlow").mockRejectedValue(
        new ApiError("rate_limited", "Too many attempts. Please wait and try again.", { status: 429 }),
      );
      const { user } = renderDialog(TAIL_SAMPLING);
      await user.click(screen.getByRole("button", { name: "Run security check" }));

      expect(await screen.findByText("Too many attempts. Please wait and try again.")).toBeInTheDocument();
    });

    it("hands a 403 product_admin_required to the page", async () => {
      vi.spyOn(apiClient, "lintFlow").mockRejectedValue(
        new ApiError("product_admin_required", "Only product admins can do that.", { status: 403 }),
      );
      const { user, onProductAdminLost } = renderDialog(TAIL_SAMPLING);
      await user.click(screen.getByRole("button", { name: "Run security check" }));

      await waitFor(() => expect(onProductAdminLost).toHaveBeenCalledTimes(1));
    });

    it("never gates Save: a blocked configuration still saves", async () => {
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue(FINDINGS);
      const { user, onSave } = renderDialog();
      await user.type(field("Name"), "Secret Flow");
      await user.type(field("Summary"), "Ships traces.");
      await user.click(field("Configuration YAML"));
      await user.paste(SECRET_YAML);
      await user.click(screen.getByRole("button", { name: "Run security check" }));
      await screen.findByText(FINDINGS.findings[1]!.message);
      await user.click(screen.getByRole("button", { name: "Create flow" }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    });
  });

  describe("privacy", () => {
    it("keeps the YAML textarea and the findings inside ph-no-capture", async () => {
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue(FINDINGS);
      const { user } = renderDialog();
      await user.click(field("Configuration YAML"));
      await user.paste(SECRET_YAML);
      await user.click(screen.getByRole("button", { name: "Run security check" }));
      const finding = await screen.findByText(FINDINGS.findings[1]!.message);

      expect(field("Configuration YAML").closest(".ph-no-capture")).not.toBeNull();
      expect(finding.closest(".ph-no-capture")).not.toBeNull();
      expect(screen.getByText(FINDINGS.findings[0]!.path).closest(".ph-no-capture")).not.toBeNull();
      // Everything the secret appears in, as text, is inside the block.
      for (const element of within(document.body).getAllByText((_, node) => node?.childElementCount === 0 && (node.textContent ?? "").includes(PASTED_SECRET))) {
        expect(element.closest(".ph-no-capture")).not.toBeNull();
      }
    });

    it("puts no configuration text and no flow text in any attribute", async () => {
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue(FINDINGS);
      const { user } = renderDialog(makeFlow({ yaml: SECRET_YAML }));
      await user.click(screen.getByRole("button", { name: "Run security check" }));
      await screen.findByText(FINDINGS.findings[1]!.message);

      const words = [PASTED_SECRET, "ingest.vendor.example", TAIL_SAMPLING.name, TAIL_SAMPLING.summary];
      for (const element of document.body.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          // An input's value, which React mirrors into the attribute, is
          // masked by replay (maskAllInputs) and autocapture alike.
          if (element.tagName === "INPUT" && attribute.name === "value") continue;
          for (const word of words) expect(`${attribute.name}=${attribute.value}`).not.toContain(word);
        }
      }
    });

    it("sends no analytics event, whatever the dialog does", async () => {
      const captureEvent = vi.spyOn(analytics, "captureEvent");
      vi.spyOn(apiClient, "lintFlow").mockResolvedValue(FINDINGS);
      const { user, onSave } = renderDialog();
      await fillNewFlow(user, SECRET_YAML);
      await user.click(screen.getByRole("button", { name: "Run security check" }));
      await screen.findByText(FINDINGS.findings[1]!.message);
      await user.click(screen.getByRole("button", { name: "Create flow" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());

      expect(captureEvent).not.toHaveBeenCalled();
    });
  });
});
