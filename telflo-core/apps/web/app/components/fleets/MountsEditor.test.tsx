import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { annotationsWithDockerMounts, DOCKER_MOUNT_CONTAINER_PATH_TWICE, DOCKER_MOUNTS_MAXIMUM } from "@telflo/contracts";
import { DATA_MOUNT, NGINX_MOUNT } from "~/test/fleets.js";
import {
  HOST_PATH_PLACEHOLDER,
  mountDetailKey,
  MOUNTS_FULL,
  MOUNTS_HINT,
  MOUNTS_UNREADABLE,
  MountsEditor,
  mountsOf,
  mountProblemsOf,
  newMountRow,
  NO_MOUNT_PROBLEMS,
  sameMounts,
  type MountField,
  type MountProblems,
  type MountRow,
} from "./MountsEditor.js";

/*
 * A server group's mounts editor; its dialog's cases are in
 * `GroupDialog.test.tsx`. This file covers the rules' words, the rows, and
 * where a path may be in the document.
 */

describe("mountsOf and sameMounts", () => {
  it("trims each path and keeps Read-only as it is", () => {
    expect(mountsOf([{ hostPath: " /var/log/nginx ", containerPath: "\t/logs\n", readOnly: false }])).toEqual([
      { hostPath: "/var/log/nginx", containerPath: "/logs", readOnly: false },
    ]);
  });

  it("compares every field, in order", () => {
    expect(sameMounts([NGINX_MOUNT, DATA_MOUNT], [NGINX_MOUNT, DATA_MOUNT])).toBe(true);
    expect(sameMounts([], [])).toBe(true);
    expect(sameMounts([NGINX_MOUNT, DATA_MOUNT], [DATA_MOUNT, NGINX_MOUNT])).toBe(false);
    expect(sameMounts([NGINX_MOUNT], [{ ...NGINX_MOUNT, readOnly: false }])).toBe(false);
    expect(sameMounts([NGINX_MOUNT], [{ ...NGINX_MOUNT, containerPath: "/logs" }])).toBe(false);
    expect(sameMounts([NGINX_MOUNT], [])).toBe(false);
  });
});

describe("mountProblemsOf (the contracts' words)", () => {
  const problemsOf = (mounts: Parameters<typeof mountProblemsOf>[0]) => mountProblemsOf(mounts, annotationsWithDockerMounts(null, mounts));

  it("finds nothing wrong with good mounts", () => {
    expect(problemsOf([NGINX_MOUNT, DATA_MOUNT])).toEqual(NO_MOUNT_PROBLEMS);
  });

  it.each([
    ["an empty host path", { hostPath: "", containerPath: "/logs", readOnly: true }, "0.hostPath", "Type a path."],
    ["a relative host path", { hostPath: "var/log", containerPath: "/logs", readOnly: true }, "0.hostPath", "Use an absolute path, starting with /."],
    ["a space in a path", { hostPath: "/var/my logs", containerPath: "/logs", readOnly: true }, "0.hostPath", "Use letters, digits, dots, dashes, underscores and /."],
    ["a .. segment", { hostPath: "/var/../etc", containerPath: "/logs", readOnly: true }, "0.hostPath", "Use no . or .. segment."],
    ["an empty container path", { hostPath: "/var/log", containerPath: "", readOnly: true }, "0.containerPath", "Type a path."],
    ["the container's root", { hostPath: "/var/log", containerPath: "//", readOnly: true }, "0.containerPath", "Use a directory, not the container's root."],
    ["the image's directory", { hostPath: "/var/log", containerPath: "/app", readOnly: true }, "0.containerPath", "Use a path outside /app: the image keeps its own files there."],
    ["under the image's directory", { hostPath: "/var/log", containerPath: "/app/opamp/x", readOnly: true }, "0.containerPath", "Use a path outside /app: the image keeps its own files there."],
  ])("says %s's problem under its field", (_why, mount, key, words) => {
    expect(problemsOf([mount])).toEqual({ fields: { [key]: words }, list: null });
  });

  it("says each container path once, on the second (as Docker reads it: a trailing / is the same path)", () => {
    expect(problemsOf([NGINX_MOUNT, { hostPath: "/srv/other", containerPath: "/var/log/nginx/", readOnly: true }])).toEqual({
      fields: { "1.containerPath": DOCKER_MOUNT_CONTAINER_PATH_TWICE },
      list: null,
    });
    expect(DOCKER_MOUNT_CONTAINER_PATH_TWICE).toBe("Each container path once.");
  });

  it("says each row's problems, the first on a field kept", () => {
    expect(problemsOf([{ hostPath: "", containerPath: "/app", readOnly: true }, NGINX_MOUNT, { hostPath: "x", containerPath: "", readOnly: false }])).toEqual({
      fields: {
        "0.hostPath": "Type a path.",
        "0.containerPath": "Use a path outside /app: the image keeps its own files there.",
        "2.hostPath": "Use an absolute path, starting with /.",
        "2.containerPath": "Type a path.",
      },
      list: null,
    });
  });

  it("says the list's own problems under the rows: too many mounts, or annotations past their bytes", () => {
    const many = Array.from({ length: DOCKER_MOUNTS_MAXIMUM + 1 }, (_, index) => ({ hostPath: `/h${index}`, containerPath: `/c${index}`, readOnly: true }));
    expect(problemsOf(many)).toEqual({ fields: {}, list: `At most ${DOCKER_MOUNTS_MAXIMUM} mounts.` });
    // 32 long paths: each one allowed, the whole too big (another client's keys count too).
    const long = Array.from({ length: DOCKER_MOUNTS_MAXIMUM }, (_, index) => ({
      hostPath: `/${"h".repeat(500)}${index}`,
      containerPath: `/${"c".repeat(500)}${index}`,
      readOnly: true,
    }));
    expect(problemsOf(long)).toEqual({
      fields: {},
      list: "Must be at most 16384 bytes as JSON, with no number written with an exponent and no U+0000.",
    });
  });

  it("checks the whole annotations the write sends: another client's keys count", () => {
    const annotations = annotationsWithDockerMounts({ other: "x".repeat(16_400) }, [NGINX_MOUNT]);
    expect(mountProblemsOf([NGINX_MOUNT], annotations).list).toMatch(/^Must be at most 16384 bytes/);
    expect(mountProblemsOf([], null)).toEqual(NO_MOUNT_PROBLEMS);
  });
});

describe("mountDetailKey (a 400's details)", () => {
  it("keys a mount's field by its row, anything else under annotations as the list's, and nothing else", () => {
    expect(mountDetailKey("annotations.telflo.dockerMounts.3.hostPath")).toBe("3.hostPath");
    expect(mountDetailKey("annotations.telflo.dockerMounts.0.containerPath")).toBe("0.containerPath");
    expect(mountDetailKey("annotations.telflo.dockerMounts.1.readOnly")).toBe("1.readOnly");
    expect(mountDetailKey("annotations")).toBe("annotations");
    expect(mountDetailKey("annotations.telflo.dockerMounts")).toBe("annotations");
    expect(mountDetailKey("annotations.telflo.other")).toBe("annotations");
    expect(mountDetailKey("name")).toBeUndefined();
    expect(mountDetailKey("annotationsx")).toBeUndefined();
  });
});

/** The editor over its own state, as the group dialog holds it. */
function renderEditor(initial: MountRow[] = [], options: { problems?: MountProblems; unreadable?: boolean; disabled?: boolean } = {}) {
  const edits = vi.fn<(index: number, field: MountField, value: string | boolean) => void>();
  function Host() {
    const [rows, setRows] = useState(initial);
    return (
      <MountsEditor
        rows={rows}
        onEdit={(index, field, value) => {
          edits(index, field, value);
          setRows((previous) => previous.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
        }}
        onAdd={() => setRows((previous) => [...previous, newMountRow()])}
        onRemove={(index) => setRows((previous) => previous.filter((_row, at) => at !== index))}
        problems={options.problems ?? NO_MOUNT_PROBLEMS}
        unreadable={options.unreadable ?? false}
        disabled={options.disabled ?? false}
      />
    );
  }
  render(<Host />);
  return { user: userEvent.setup(), edits };
}

const hostPaths = () => screen.queryAllByRole("textbox", { name: "Host path" });
const containerPaths = () => screen.queryAllByRole("textbox", { name: "Container path" });
const readOnlies = () => screen.queryAllByRole("checkbox", { name: "Read-only" });

describe("MountsEditor's rows", () => {
  it("shows no row, the hint and Add mount for a group with none", () => {
    renderEditor();
    expect(hostPaths()).toEqual([]);
    expect(screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === MOUNTS_HINT)).toBeInTheDocument();
    expect(MOUNTS_HINT).toBe("Each mount is a -v line in this group's container install command. Linux installs read the host's files directly.");
    expect(screen.getByText("-v").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Add mount" })).toBeEnabled();
    expect(screen.queryByText(MOUNTS_UNREADABLE)).toBeNull();
  });

  it("adds a row: Host path (its placeholder), Container path, Read-only ticked, Remove mount 1; the focus on its Host path", async () => {
    const { user } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Add mount" }));
    const row = screen.getByRole("group", { name: "Mount 1" });
    expect(within(row).getByRole("textbox", { name: "Host path" })).toHaveAttribute("placeholder", HOST_PATH_PLACEHOLDER);
    expect(HOST_PATH_PLACEHOLDER).toBe("/var/log/nginx");
    expect(within(row).getByRole("textbox", { name: "Container path" })).not.toHaveAttribute("placeholder");
    expect(within(row).getByRole("checkbox", { name: "Read-only" })).toBeChecked();
    expect(within(row).getByRole("button", { name: "Remove mount 1" })).toBeInTheDocument();
    expect(document.activeElement).toBe(hostPaths()[0]);
  });

  it("shows the rows it is given, edits each field, and removes a row by its number, the focus then on Add mount", async () => {
    const { user, edits } = renderEditor([{ ...NGINX_MOUNT }, { ...DATA_MOUNT }]);
    expect(hostPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/var/log/nginx", "/srv/data"]);
    expect(containerPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/var/log/nginx", "/var/lib/otelcol"]);
    expect(readOnlies().map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    await user.type(containerPaths()[1]!, "/x");
    expect(edits).toHaveBeenLastCalledWith(1, "containerPath", "/var/lib/otelcol/x");
    await user.click(readOnlies()[0]!);
    expect(edits).toHaveBeenLastCalledWith(0, "readOnly", false);
    expect(readOnlies()[0]).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Remove mount 1" }));
    expect(hostPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/srv/data"]);
    expect(screen.getByRole("button", { name: "Remove mount 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove mount 2" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add mount" }));
  });

  it("offers no Add mount past 32 mounts, with its reason beside it and describing it", async () => {
    const full = Array.from({ length: DOCKER_MOUNTS_MAXIMUM }, (_, index) => ({ hostPath: `/h${index}`, containerPath: `/c${index}`, readOnly: true }));
    const { user } = renderEditor(full);
    expect(screen.getByRole("button", { name: "Add mount" })).toBeDisabled();
    expect(MOUNTS_FULL).toBe("A group holds at most 32 mounts.");
    expect(screen.getByText(MOUNTS_FULL)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add mount" })).toHaveAccessibleDescription(MOUNTS_FULL);
    await user.click(screen.getByRole("button", { name: `Remove mount ${DOCKER_MOUNTS_MAXIMUM}` }));
    expect(screen.getByRole("button", { name: "Add mount" })).toBeEnabled();
    expect(screen.queryByText(MOUNTS_FULL)).toBeNull();
    expect(screen.getByRole("button", { name: "Add mount" })).not.toHaveAccessibleDescription();
  });

  it("shows each field's problem under it, describing it, and the list's under the rows", () => {
    renderEditor([{ hostPath: "", containerPath: "/app", readOnly: true }, { ...NGINX_MOUNT }], {
      problems: {
        fields: { "0.hostPath": "Type a path.", "0.containerPath": "Use a path outside /app: the image keeps its own files there.", "1.readOnly": "Expected boolean." },
        list: "At most 32 mounts.",
      },
    });
    expect(hostPaths()[0]).toHaveAttribute("aria-invalid", "true");
    expect(hostPaths()[0]).toHaveAccessibleDescription("Type a path.");
    expect(containerPaths()[0]).toHaveAccessibleDescription("Use a path outside /app: the image keeps its own files there.");
    expect(hostPaths()[1]).not.toHaveAttribute("aria-invalid");
    expect(hostPaths()[1]).not.toHaveAttribute("aria-describedby");
    expect(readOnlies()[1]).toHaveAccessibleDescription("Expected boolean.");
    expect(screen.getByText("At most 32 mounts.")).toBeInTheDocument();
  });

  it("says a group's unreadable mounts are replaced by one added here", () => {
    renderEditor([], { unreadable: true });
    expect(screen.getByText(MOUNTS_UNREADABLE)).toBeInTheDocument();
    expect(MOUNTS_UNREADABLE).toBe("This group's mounts were saved in a form Telflo can't read. Adding a mount here replaces them.");
  });

  it("disables every field and button while saving", () => {
    renderEditor([{ ...NGINX_MOUNT }], { disabled: true });
    for (const control of [...hostPaths(), ...containerPaths(), ...readOnlies()]) expect(control).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove mount 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add mount" })).toBeDisabled();
  });
});

describe("MountsEditor's privacy", () => {
  it("keeps the paths inside ph-no-capture, in no attribute but their inputs' value", async () => {
    const host = "/srv/canary-host-6a1e";
    const container = "/canary-container-b47d";
    const { user } = renderEditor([{ hostPath: host, containerPath: container, readOnly: true }], {
      problems: { fields: { "0.containerPath": "Each container path once." }, list: null },
    });
    await user.click(screen.getByRole("button", { name: "Add mount" }));
    await user.type(hostPaths()[1]!, `${host}-typed`);
    for (const path of [host, container]) {
      const holders: string[] = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (!attribute.value.includes(path)) continue;
          holders.push(`${element.tagName} ${attribute.name}`);
          expect(element.tagName).toBe("INPUT");
          expect(attribute.name).toBe("value");
          expect(element.closest(".ph-no-capture"), path).not.toBeNull();
        }
      }
      expect(holders.length, path).toBeGreaterThan(0);
    }
    // Every input is inside ph-no-capture.
    for (const input of document.querySelectorAll("input, button[role='checkbox']")) expect(input.closest(".ph-no-capture")).not.toBeNull();
  });
});
