import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KUBERNETES_VOLUMES_MAXIMUM, KUBERNETES_VOLUMES_MAXIMUM_MESSAGE, type KubernetesRole } from "@telflo/contracts";
import { NO_MOUNT_PROBLEMS, type MountProblems } from "./MountsEditor.js";
import {
  AGENT_LOG_MOUNT_HINT,
  newVolumeRow,
  READ_WRITE_WARNING,
  RISKY_PATH_AFTER,
  VOLUME_HOST_PATH_PLACEHOLDER,
  VOLUME_RECIPES_LABEL,
  VolumesEditor,
  volumesOf,
  type VolumeField,
  type VolumeRow,
} from "./VolumesEditor.js";

/*
 * A Kubernetes group's volumes editor: its recipes (the list, the safe paths
 * only) and its warnings, on `MountsEditor.test.tsx`'s patterns: the rows,
 * the focus, the problems under each field, and where a path may be in the
 * document. The rules' words are the contracts' (`settingsProblemsOf` in
 * `KubernetesGroupDialog.test.tsx`).
 */

const VAR_LOG_APP: VolumeRow = { hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/var/log/app", readOnly: true };
const SOCKET: VolumeRow = { hostPath: "/run/app.sock", hostPathType: "Socket", mountPath: "/run/app.sock", readOnly: false };

/** The editor over its own state, as the group dialog holds it; `setSaving` turns its `disabled` on or off, its state kept. */
function renderEditor(
  initial: VolumeRow[] = [],
  options: { problems?: MountProblems; role?: KubernetesRole; disabled?: boolean } = {},
) {
  const edits = vi.fn<(index: number, field: VolumeField, value: string | boolean) => void>();
  function Host({ disabled }: { disabled: boolean }) {
    const [rows, setRows] = useState(initial);
    return (
      <VolumesEditor
        rows={rows}
        onEdit={(index, field, value) => {
          edits(index, field, value);
          setRows((previous) => previous.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
        }}
        onAdd={(row) => setRows((previous) => [...previous, row])}
        onRemove={(index) => setRows((previous) => previous.filter((_row, at) => at !== index))}
        problems={options.problems ?? NO_MOUNT_PROBLEMS}
        role={options.role ?? "gateway"}
        disabled={disabled}
      />
    );
  }
  const { rerender } = render(<Host disabled={options.disabled ?? false} />);
  return { user: userEvent.setup(), edits, setSaving: (saving: boolean) => rerender(<Host disabled={saving} />) };
}

const hostPaths = () => screen.queryAllByRole("textbox", { name: "Host path" }) as HTMLInputElement[];
const mountPaths = () => screen.queryAllByRole("textbox", { name: "Mount path" }) as HTMLInputElement[];
const types = () => screen.queryAllByRole("combobox", { name: "Type" });
const readOnlies = () => screen.queryAllByRole("checkbox", { name: "Read-only" });
const recipesToggle = () => screen.getByRole("button", { name: VOLUME_RECIPES_LABEL });
/** Opens the recipes' disclosure (closed at each opening). */
const openRecipes = () => fireEvent.click(recipesToggle());
const recipes = () => within(screen.getByRole("group", { name: VOLUME_RECIPES_LABEL })).getAllByRole("button");
const recipe = (path: string) => recipes().find((each) => each.querySelector("span")?.textContent === path)!;

describe("volumesOf", () => {
  it("trims each path and keeps the type and Read-only as they are", () => {
    expect(volumesOf([{ hostPath: " /var/log/app ", hostPathType: "File", mountPath: "\t/logs\n", readOnly: false }])).toEqual([
      { hostPath: "/var/log/app", hostPathType: "File", mountPath: "/logs", readOnly: false },
    ]);
    expect(newVolumeRow()).toEqual({ hostPath: "", hostPathType: "Directory", mountPath: "", readOnly: true });
  });
});

describe("VolumesEditor's rows", () => {
  it('shows no row, "Volumes", Add volume and the recipes for a group with none', () => {
    renderEditor();
    expect(screen.getByRole("group", { name: "Volumes" })).toBeInTheDocument();
    expect(hostPaths()).toEqual([]);
    expect(screen.getByRole("button", { name: "Add volume" })).toBeEnabled();
    openRecipes();
    expect(recipes().length).toBeGreaterThan(0);
  });

  it("adds a row: Host path (its placeholder), Mount path, Type Directory, Read-only ticked, Remove volume 1; the focus on its Host path", async () => {
    const { user } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Add volume" }));
    const row = screen.getByRole("group", { name: "Volume 1" });
    expect(within(row).getByRole("textbox", { name: "Host path" })).toHaveAttribute("placeholder", VOLUME_HOST_PATH_PLACEHOLDER);
    expect(within(row).getByRole("textbox", { name: "Mount path" })).not.toHaveAttribute("placeholder");
    expect(within(row).getByRole("combobox", { name: "Type" })).toHaveTextContent("Directory");
    expect(within(row).getByRole("checkbox", { name: "Read-only" })).toBeChecked();
    expect(within(row).getByRole("button", { name: "Remove volume 1" })).toBeInTheDocument();
    expect(document.activeElement).toBe(hostPaths()[0]);
  });

  it("shows the rows it is given, edits each field (the Type among the four), and removes a row by its number, the focus then on Add volume", async () => {
    const { user, edits } = renderEditor([{ ...VAR_LOG_APP }, { ...SOCKET }]);
    expect(hostPaths().map((each) => each.value)).toEqual(["/var/log/app", "/run/app.sock"]);
    expect(mountPaths().map((each) => each.value)).toEqual(["/var/log/app", "/run/app.sock"]);
    expect(types().map((each) => each.textContent)).toEqual(["Directory", "Socket"]);
    expect(readOnlies().map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    await user.type(mountPaths()[1]!, "-x");
    expect(edits).toHaveBeenLastCalledWith(1, "mountPath", "/run/app.sock-x");
    await user.click(types()[0]!);
    expect((await screen.findAllByRole("option")).map((each) => each.textContent)).toEqual(["Directory", "DirectoryOrCreate", "File", "Socket"]);
    await user.click(screen.getByRole("option", { name: "DirectoryOrCreate" }));
    expect(edits).toHaveBeenLastCalledWith(0, "hostPathType", "DirectoryOrCreate");
    expect(types()[0]).toHaveTextContent("DirectoryOrCreate");
    await user.click(readOnlies()[0]!);
    expect(edits).toHaveBeenLastCalledWith(0, "readOnly", false);

    await user.click(screen.getByRole("button", { name: "Remove volume 1" }));
    expect(hostPaths().map((each) => each.value)).toEqual(["/run/app.sock"]);
    expect(screen.queryByRole("button", { name: "Remove volume 2" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add volume" }));
  });

  it("offers no Add volume and no recipe past 32 volumes, with its reason beside it and describing it", async () => {
    const full = Array.from({ length: KUBERNETES_VOLUMES_MAXIMUM }, (_, index) => ({ ...VAR_LOG_APP, hostPath: `/h${index}`, mountPath: `/m${index}` }));
    const { user } = renderEditor(full);
    expect(screen.getByRole("button", { name: "Add volume" })).toBeDisabled();
    expect(KUBERNETES_VOLUMES_MAXIMUM_MESSAGE).toBe("A group holds at most 32 volumes.");
    expect(screen.getByRole("button", { name: "Add volume" })).toHaveAccessibleDescription(KUBERNETES_VOLUMES_MAXIMUM_MESSAGE);
    openRecipes();
    for (const each of recipes()) expect(each).toBeDisabled();
    await user.click(screen.getByRole("button", { name: `Remove volume ${KUBERNETES_VOLUMES_MAXIMUM}` }));
    expect(screen.getByRole("button", { name: "Add volume" })).toBeEnabled();
    expect(screen.queryByText(KUBERNETES_VOLUMES_MAXIMUM_MESSAGE)).toBeNull();
  });

  it("shows each field's problem under it, describing it, and the list's under the rows", () => {
    renderEditor([{ ...VAR_LOG_APP, hostPath: "" }, { ...SOCKET }], {
      problems: {
        fields: {
          "0.hostPath": "Type a path.",
          "0.mountPath": "Each mount path once.",
          "1.hostPathType": "Choose Directory, DirectoryOrCreate, File or Socket.",
          "1.readOnly": "Expected boolean.",
        },
        list: "A group holds at most 32 volumes.",
      },
    });
    expect(hostPaths()[0]).toHaveAttribute("aria-invalid", "true");
    expect(hostPaths()[0]).toHaveAccessibleDescription("Type a path.");
    expect(mountPaths()[0]).toHaveAccessibleDescription("Each mount path once.");
    expect(types()[1]).toHaveAccessibleDescription("Choose Directory, DirectoryOrCreate, File or Socket.");
    expect(readOnlies()[1]).toHaveAccessibleDescription("Expected boolean.");
    expect(hostPaths()[1]).not.toHaveAttribute("aria-invalid");
    expect(hostPaths()[1]).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("A group holds at most 32 volumes.")).toBeInTheDocument();
  });

  it("disables every field and button while saving, the recipes' disclosure and every recipe too", () => {
    const { setSaving } = renderEditor([{ ...VAR_LOG_APP }]);
    // Opened before the save (closed, its recipes aren't shown, and a disabled toggle can't open it): the recipes enabled.
    openRecipes();
    expect(recipes().length).toBeGreaterThan(1);
    expect(recipes().filter((each) => !(each as HTMLButtonElement).disabled).length).toBeGreaterThan(0);
    setSaving(true);
    for (const control of [...hostPaths(), ...mountPaths(), ...types(), ...readOnlies(), recipesToggle()]) expect(control).toBeDisabled();
    for (const each of recipes()) expect(each).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove volume 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add volume" })).toBeDisabled();
  });
});

// The recipes and their prefill, as one-click rows.
describe("VolumesEditor's recipes", () => {
  // GroupDialog's Mounts disclosure pattern.
  it('keeps the recipes in a disclosure "Common Volume Paths", closed by default, opened and closed by its button', async () => {
    const { user } = renderEditor();
    expect(VOLUME_RECIPES_LABEL).toBe("Common Volume Paths");
    const toggle = recipesToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeVisible();
    expect(screen.queryByRole("group", { name: VOLUME_RECIPES_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: /^\/var\/log\/journal / })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(screen.getByRole("group", { name: VOLUME_RECIPES_LABEL })).toBe(panel);
    expect(recipe("/var/log/journal")).toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeVisible();
  });

  it("offers the recipes without the harness example; the Agent's without /var/log/pods, which its chart mounts", () => {
    renderEditor();
    openRecipes();
    expect(recipes().map((each) => each.querySelector("span")?.textContent)).toEqual([
      "/var/log/pods",
      "/var/log/containers",
      "/var/log",
      "/var/log/journal",
      "/run/log/journal",
    ]);
    expect(screen.getByRole("group", { name: VOLUME_RECIPES_LABEL })).not.toHaveTextContent("starfeuds");
  });

  it.each(["node", "cluster", "gateway"] as const)("on the %s role", (role) => {
    renderEditor([], { role });
    openRecipes();
    const paths = recipes().map((each) => each.querySelector("span")?.textContent);
    expect(paths.includes("/var/log/pods")).toBe(role !== "node");
    expect(paths).toContain("/var/log/journal");
  });

  // The mount no row lists, said where the Agent's volumes are.
  it.each(["node", "cluster", "gateway"] as const)("says the Agent's chart mounts the node's /var/log/pods itself on the Agent only: the %s role", (role) => {
    renderEditor([{ ...VAR_LOG_APP }], { role });
    const volumes = screen.getByRole("group", { name: "Volumes" });
    if (role === "node") {
      expect(AGENT_LOG_MOUNT_HINT).toBe(
        "The Agent always mounts the node's /var/log/pods read-only at /var/log/pods, for pod logs: no volume needed for them.",
      );
      expect(within(volumes).getByText(AGENT_LOG_MOUNT_HINT)).toBeInTheDocument();
      expect(volumes).toHaveAccessibleDescription(AGENT_LOG_MOUNT_HINT);
    } else {
      expect(screen.queryByText(AGENT_LOG_MOUNT_HINT)).toBeNull();
      expect(volumes).not.toHaveAttribute("aria-describedby");
    }
  });

  it("adds a recipe's row in one click (its path at the same path, a directory, read-only), the focus on its Host path; a recipe mounted is disabled", async () => {
    const { user } = renderEditor([{ ...VAR_LOG_APP }]);
    await user.click(recipesToggle());
    await user.click(recipe("/var/log/journal"));
    expect(hostPaths().map((each) => each.value)).toEqual(["/var/log/app", "/var/log/journal"]);
    expect(mountPaths().map((each) => each.value)).toEqual(["/var/log/app", "/var/log/journal"]);
    expect(types()[1]).toHaveTextContent("Directory");
    expect(readOnlies()[1]).toBeChecked();
    expect(document.activeElement).toBe(hostPaths()[1]);
    expect(recipe("/var/log/journal")).toBeDisabled();
    expect(recipe("/var/log")).toBeEnabled();
    // Its mount path changed: the recipe is offered again.
    await user.type(mountPaths()[1]!, "-2");
    expect(recipe("/var/log/journal")).toBeEnabled();
  });

  it("disables a recipe whose path a row mounts as read: a trailing slash, a doubled slash, spaces at the ends", () => {
    renderEditor([
      { ...VAR_LOG_APP, hostPath: "/var/log", mountPath: "/var/log/" },
      { ...VAR_LOG_APP, hostPath: "/run/log/journal", mountPath: " /run//log/journal " },
    ]);
    openRecipes();
    expect(recipe("/var/log")).toBeDisabled();
    expect(recipe("/run/log/journal")).toBeDisabled();
    expect(recipe("/var/log/journal")).toBeEnabled();
  });
});

// The warnings (`isRiskyHostPath`, the read-write banner): never blocks.
describe("VolumesEditor's warnings", () => {
  it.each(["/", "/etc", "/etc/ssh", "/root", "/var/lib/kubelet", "/var/lib/kubelet/pods", "/var/run/docker.sock", "/run/containerd/containerd.sock", "//etc/"])(
    "warns of the sensitive host path %s, the path in the words",
    (path) => {
      renderEditor([{ ...VAR_LOG_APP, hostPath: path }]);
      const row = screen.getByRole("group", { name: "Volume 1" });
      expect(row).toHaveTextContent(`${path.trim()}${RISKY_PATH_AFTER}`);
      expect(RISKY_PATH_AFTER).toBe(" is a sensitive host path: mounting it can give the collector broad access to the node. Only proceed if you mean to.");
    },
  );

  it.each(["/var/log", "/etcetera", "/var/lib/kubelets", "/srv/data", ""])("says nothing of the host path %j", (path) => {
    renderEditor([{ ...VAR_LOG_APP, hostPath: path }]);
    expect(screen.getByRole("group", { name: "Volume 1" })).not.toHaveTextContent(RISKY_PATH_AFTER.trim());
  });

  it("warns of a read-write mount, and stops when it is made read-only again", async () => {
    const { user } = renderEditor([{ ...VAR_LOG_APP }]);
    expect(screen.queryByText(READ_WRITE_WARNING)).toBeNull();
    await user.click(readOnlies()[0]!);
    expect(screen.getByText(READ_WRITE_WARNING)).toBeInTheDocument();
    expect(READ_WRITE_WARNING).toBe("Read-write host mount: the collector can change files on the node. Prefer read-only for log collection.");
    await user.click(readOnlies()[0]!);
    expect(screen.queryByText(READ_WRITE_WARNING)).toBeNull();
  });
});

// A volume's paths are configuration text.
describe("VolumesEditor's privacy", () => {
  it("keeps the paths inside ph-no-capture, in no attribute but their inputs' value, the risky-path warning too", async () => {
    const host = "/etc/canary-host-6a1e";
    const mount = "/canary-mount-b47d";
    const { user } = renderEditor([{ hostPath: host, hostPathType: "File", mountPath: mount, readOnly: false }], {
      problems: { fields: { "0.mountPath": "Each mount path once." }, list: null },
    });
    await user.click(screen.getByRole("button", { name: "Add volume" }));
    await user.type(hostPaths()[1]!, `${host}-typed`);
    await user.click(types()[0]!);
    await screen.findAllByRole("option");
    for (const path of [host, mount]) {
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
    // The warning repeats the host path: inside ph-no-capture, as every text node holding a path.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let shown = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node.textContent ?? "").includes(host)) continue;
      shown += 1;
      expect(node.parentElement?.closest(".ph-no-capture")).not.toBeNull();
    }
    expect(shown).toBeGreaterThan(0);
    for (const input of document.querySelectorAll("input, button[role='checkbox'], button[role='combobox']")) {
      expect(input.closest(".ph-no-capture")).not.toBeNull();
    }
  });
});
