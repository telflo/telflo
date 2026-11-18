import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  API_VERSION_HINT,
  API_VERSION_NUMBER_HINT,
  CONTAINER_LABEL_NOUNS,
  DockerStatsReceiverForm,
  ENV_VAR_NOUNS,
} from "./DockerStatsReceiverForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { HostmetricsReceiverForm } from "./HostmetricsReceiverForm.js";
import { formFor } from "./registry.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { parse } from "~/lib/graph/parse.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The host forms (D9c Task 4): the hostmetrics and docker_stats forms
 * over the form contract. Each field is driven as a person would
 * (typing, clicking, picking) on the host corpus text (comments, an anchor
 * and merges, flow lists, a quoted API version, a bare scraper, `0750`), LF
 * and CRLF, and writes only its key: the text changes in that key's lines
 * only, as one undo entry, and parses to the value (D9c decision 2). The
 * fixes each have a test that fails if the bug returns:
 * `match_type` with a filter's first item and include and exclude kept
 * together (decisions 3 and 9; Preflight ruling 5), `api_version` written
 * as a string (decision 2), Root Path cleared removing its key (D9b's rule),
 * the label maps renamed in place with a clash refused (D9b decision 4)
 * and their nouns (decision 4). Five docker_stats cases close the file.
 *
 * Collector claims cite contrib v0.162.0.
 */

/** The corpus as written (CRLF), and with LF line endings. */
const CORPUS_CRLF = corpusText("forms-host.yaml");
const CORPUS = CORPUS_CRLF.replace(/\r\n/g, "\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const HOST = "receivers.hostmetrics";
const DOCKER = "receivers.docker_stats";

const FORM_OF: Record<string, () => ReactNode> = {
  [HOST]: () => <HostmetricsReceiverForm />,
  [DOCKER]: () => <DockerStatsReceiverForm />,
};

function renderForm(key: string, text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{FORM_OF[key]!()}</ComponentForm>);
  return user;
}

/** Renders again, on a fresh store. */
function rerenderForm(key: string, text: string) {
  cleanup();
  useEditorStore.setState(initialState, true);
  return renderForm(key, text);
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
/** A hint line, by its whole text ("… · Default 1m" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};
const scraperOf = (written: string, name: string) => (valueOf(written, HOST).scrapers as Record<string, Value | null>)[name];

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
  /** A variant of the corpus text (LF), when the case needs one. */
  base?: string;
}

/** hostmetrics' last lines, before docker_stats: where a key the component hasn't got is added. */
const HOST_END = "        mute_process_name_error: true\n  docker_stats:\n";
const hostEnd = (added: string) => `        mute_process_name_error: true\n${added}  docker_stats:\n`;
/** docker_stats' last lines, before the processors. */
const DOCKER_END = '      - "*/redis*"\nprocessors:\n';
const dockerEnd = (added: string) => `      - "*/redis*"\n${added}processors:\n`;
/** The corpus without the load scraper: ticking it writes the default block. */
const NO_LOAD = CORPUS.replace("      load:\n        cpu_average: false\n", "");

const MUTE_BOXES = [
  ["mute-all-errors", "mute_process_all_errors"],
  ["mute-exe-error", "mute_process_exe_error"],
  ["mute-io-error", "mute_process_io_error"],
  ["mute-user-error", "mute_process_user_error"],
  ["mute-cgroup-error", "mute_process_cgroup_error"],
] as const;

const CASES: FieldCase[] = [
  // hostmetrics
  {
    name: "hostmetrics Collection Interval (from the merge) is set as the component's own key",
    key: HOST,
    edit: (user) => retypeInto(user, byId("collection-interval"), "1m"),
    from: HOST_END,
    to: hostEnd("    collection_interval: 1m\n"),
    check: (v) => expect(v.collection_interval).toBe("1m"),
  },
  {
    name: "hostmetrics Initial Delay retyped",
    key: HOST,
    edit: (user) => retypeInto(user, byId("initial-delay"), "5s"),
    from: "    initial_delay: 1s\n",
    to: "    initial_delay: 5s\n",
    check: (v) => expect(v.initial_delay).toBe("5s"),
  },
  {
    name: "hostmetrics Initial Delay cleared removes the key",
    key: HOST,
    edit: (user) => retypeInto(user, byId("initial-delay"), ""),
    from: "    initial_delay: 1s\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("initial_delay"),
  },
  {
    name: "hostmetrics a scraper ticked writes {} under scrapers",
    key: HOST,
    edit: (user) => user.click(byId("scraper-paging")),
    from: HOST_END,
    to: hostEnd("      paging: {}\n"),
    check: (v) => expect((v.scrapers as Value).paging).toEqual({}),
  },
  {
    name: "hostmetrics a scraper unticked removes its lines",
    key: HOST,
    edit: (user) => user.click(byId("scraper-cpu")),
    from: "      cpu: {}\n",
    to: "",
    check: (v) => expect(v.scrapers).not.toHaveProperty("cpu"),
  },
  {
    name: "hostmetrics a bare scraper (on, the collector's defaults) unticked removes its line",
    key: HOST,
    edit: (user) => user.click(byId("scraper-memory")),
    from: "      memory: # the defaults\n",
    to: "",
    check: (v) => expect(v.scrapers).not.toHaveProperty("memory"),
  },
  {
    name: "hostmetrics Load ticked writes {cpu_average: false}",
    key: HOST,
    base: NO_LOAD,
    edit: (user) => user.click(byId("scraper-load")),
    from: HOST_END,
    to: hostEnd("      load:\n        cpu_average: false\n"),
    check: (v) => expect((v.scrapers as Value).load).toEqual({ cpu_average: false }),
  },
  {
    name: "hostmetrics Load unticked removes its block",
    key: HOST,
    edit: (user) => user.click(byId("scraper-load")),
    from: "      load:\n        cpu_average: false\n",
    to: "",
    check: (v) => expect(v.scrapers).not.toHaveProperty("load"),
  },
  {
    name: "hostmetrics Divide by CPU Count",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Load Scraper");
      await user.click(byId("cpu-average"));
    },
    from: "        cpu_average: false\n",
    to: "        cpu_average: true\n",
    check: (v) => expect((v.scrapers as Value).load).toEqual({ cpu_average: true }),
  },
  {
    name: "hostmetrics a disk device retyped in the flow list keeps its comment",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await retypeInto(user, byId("disk-devices-include-1"), "nvme0n1");
    },
    from: "          devices: [sda, sdb] # the data disks\n",
    to: "          devices: [sda, nvme0n1] # the data disks\n",
    check: (v) => expect((v.scrapers as Value).disk).toEqual({ include: { devices: ["sda", "nvme0n1"], match_type: "strict" } }),
  },
  {
    name: "hostmetrics Add Device holds a row; typing appends the device",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await user.click(screen.getByRole("button", { name: "Add Device" }));
      await user.type(byId("disk-devices-include-2"), "sdc");
      await user.tab();
    },
    from: "          devices: [sda, sdb] # the data disks\n",
    to: "          devices: [sda, sdb, sdc] # the data disks\n",
    check: (v) => expect(((v.scrapers as Value).disk as Value).include).toEqual({ devices: ["sda", "sdb", "sdc"], match_type: "strict" }),
  },
  {
    name: "hostmetrics a disk device removed",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await user.click(screen.getAllByRole("button", { name: "Remove device" })[0]!);
    },
    from: "          devices: [sda, sdb] # the data disks\n",
    to: "          devices: [sdb] # the data disks\n",
    check: (v) => expect(((v.scrapers as Value).disk as Value).include).toEqual({ devices: ["sdb"], match_type: "strict" }),
  },
  {
    name: "hostmetrics the disk's Match select writes its side's match_type",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await pickIn(user, byId("disk-devices-include-match"), "Regex Match");
    },
    from: "          devices: [sda, sdb] # the data disks\n          match_type: strict\n",
    to: "          devices: [sda, sdb] # the data disks\n          match_type: regexp\n",
    check: (v) => expect(((v.scrapers as Value).disk as Value).include).toEqual({ devices: ["sda", "sdb"], match_type: "regexp" }),
  },
  {
    name: "hostmetrics Exclude beside the disk's include list adds the exclude block with match_type, keeping include",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await pickIn(user, byId("disk-devices-mode"), "Exclude");
      await user.type(byId("disk-devices-exclude-0"), "loop0");
      await user.tab();
    },
    from: "          match_type: strict\n      filesystem:\n",
    to: "          match_type: strict\n        exclude:\n          devices:\n            - loop0\n          match_type: strict\n      filesystem:\n",
    check: (v) =>
      expect((v.scrapers as Value).disk).toEqual({
        include: { devices: ["sda", "sdb"], match_type: "strict" },
        exclude: { devices: ["loop0"], match_type: "strict" },
      }),
  },
  {
    name: "hostmetrics No Filter removes the disk's filter block",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Disk Scraper");
      await pickIn(user, byId("disk-devices-mode"), "No Filter");
    },
    from: "      disk:\n        include:\n          devices: [sda, sdb] # the data disks\n          match_type: strict\n",
    to: "      disk: {}\n",
    check: (v) => expect((v.scrapers as Value).disk).toEqual({}),
  },
  {
    name: "hostmetrics a filesystem device retyped",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Filesystem Scraper");
      await retypeInto(user, byId("fs-devices-include-0"), "/dev/nvme0n1p1");
    },
    from: "            - /dev/sda1\n",
    to: "            - /dev/nvme0n1p1\n",
    check: (v) =>
      expect(((v.scrapers as Value).filesystem as Value).include_devices).toEqual({ devices: ["/dev/nvme0n1p1"], match_type: "regexp" }),
  },
  {
    name: "hostmetrics Add FS Type appends to the excluded types",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Filesystem Scraper");
      await user.click(screen.getByRole("button", { name: "Add FS Type" }));
      await user.type(byId("fs-types-exclude-2"), "squashfs");
      await user.tab();
    },
    from: "          fs_types: [tmpfs, overlay]\n",
    to: "          fs_types: [tmpfs, overlay, squashfs]\n",
    check: (v) =>
      expect(((v.scrapers as Value).filesystem as Value).exclude_fs_types).toEqual({
        fs_types: ["tmpfs", "overlay", "squashfs"],
        match_type: "strict",
      }),
  },
  {
    name: "hostmetrics a mount point filter's first item is written with match_type: strict",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Filesystem Scraper");
      await pickIn(user, byId("fs-mount-points-mode"), "Include Only");
      await user.type(byId("fs-mount-points-include-0"), "/home");
      await user.tab();
    },
    from: "          fs_types: [tmpfs, overlay]\n          match_type: strict\n      network:\n",
    to: "          fs_types: [tmpfs, overlay]\n          match_type: strict\n        include_mount_points:\n          mount_points:\n            - /home\n          match_type: strict\n      network:\n",
    check: (v) =>
      expect(((v.scrapers as Value).filesystem as Value).include_mount_points).toEqual({ mount_points: ["/home"], match_type: "strict" }),
  },
  {
    name: "hostmetrics Include Virtual Filesystems (unset)",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Filesystem Scraper");
      await user.click(byId("include-virtual-fs"));
    },
    from: "          fs_types: [tmpfs, overlay]\n          match_type: strict\n      network:\n",
    to: "          fs_types: [tmpfs, overlay]\n          match_type: strict\n        include_virtual_filesystems: true\n      network:\n",
    check: (v) => expect(((v.scrapers as Value).filesystem as Value).include_virtual_filesystems).toBe(true),
  },
  {
    name: "hostmetrics an excluded interface retyped keeps its comment",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Network Scraper");
      await retypeInto(user, byId("network-interfaces-exclude-0"), "docker0");
    },
    from: "            - lo # loopback\n",
    to: "            - docker0 # loopback\n",
    check: (v) => expect(((v.scrapers as Value).network as Value).exclude).toEqual({ interfaces: ["docker0"], match_type: "strict" }),
  },
  {
    name: "hostmetrics the excluded interfaces' Match select",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Network Scraper");
      await pickIn(user, byId("network-interfaces-exclude-match"), "Regex Match");
    },
    from: "            - lo # loopback\n          match_type: strict\n",
    to: "            - lo # loopback\n          match_type: regexp\n",
    check: (v) => expect(((v.scrapers as Value).network as Value).exclude).toEqual({ interfaces: ["lo"], match_type: "regexp" }),
  },
  {
    name: "hostmetrics Add Process Name appends to the flow list",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Process Scraper");
      await user.click(screen.getByRole("button", { name: "Add Process Name" }));
      await user.type(byId("process-names-include-1"), "postgres");
      await user.tab();
    },
    from: "          names: [nginx]\n",
    to: "          names: [nginx, postgres]\n",
    check: (v) => expect(((v.scrapers as Value).process as Value).include).toEqual({ names: ["nginx", "postgres"], match_type: "strict" }),
  },
  ...MUTE_BOXES.map(
    ([id, key]): FieldCase => ({
      name: `hostmetrics ${key} (unset) ticked`,
      key: HOST,
      edit: async (user) => {
        await openSection(user, "Process Scraper");
        await user.click(byId(id));
      },
      from: HOST_END,
      to: `        mute_process_name_error: true\n        ${key}: true\n  docker_stats:\n`,
      check: (v) => expect(((v.scrapers as Value).process as Value)[key]).toBe(true),
    }),
  ),
  {
    name: "hostmetrics Mute Process Name Errors unticked writes false",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Process Scraper");
      await user.click(byId("mute-name-error"));
    },
    from: "        mute_process_name_error: true\n",
    to: "        mute_process_name_error: false\n",
    check: (v) => expect(((v.scrapers as Value).process as Value).mute_process_name_error).toBe(false),
  },
  {
    name: "hostmetrics Scrape Process Delay (unset)",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Process Scraper");
      await retypeInto(user, byId("scrape-process-delay"), "10s");
    },
    from: HOST_END,
    to: "        mute_process_name_error: true\n        scrape_process_delay: 10s\n  docker_stats:\n",
    check: (v) => expect(((v.scrapers as Value).process as Value).scrape_process_delay).toBe("10s"),
  },
  {
    name: "hostmetrics Root Path retyped keeps its comment",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("root-path"), "/host");
    },
    from: "    root_path: /hostfs # the host's mount\n",
    to: "    root_path: /host # the host's mount\n",
    check: (v) => expect(v.root_path).toBe("/host"),
  },
  {
    name: "hostmetrics Root Path cleared removes the key (never writes \"\")",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("root-path"), "");
    },
    from: "    root_path: /hostfs # the host's mount\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("root_path"),
  },
  {
    name: "hostmetrics Metadata Collection Interval (unset)",
    key: HOST,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("metadata-interval"), "0");
    },
    from: HOST_END,
    to: hostEnd('    metadata_collection_interval: "0"\n'),
    check: (v) => expect(v.metadata_collection_interval).toBe("0"),
  },
  // docker_stats
  {
    name: "docker_stats Endpoint retyped",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-endpoint"), "tcp://localhost:2375"),
    from: "    endpoint: unix:///var/run/docker.sock\n",
    to: "    endpoint: tcp://localhost:2375\n",
    check: (v) => expect(v.endpoint).toBe("tcp://localhost:2375"),
  },
  {
    name: "docker_stats Endpoint cleared removes the key",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-endpoint"), ""),
    from: "    endpoint: unix:///var/run/docker.sock\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("endpoint"),
  },
  {
    name: "docker_stats Collection Interval (from the merge) is set as the component's own key",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-interval"), "2s"),
    from: DOCKER_END,
    to: dockerEnd("    collection_interval: 2s\n"),
    check: (v) => expect(v.collection_interval).toBe("2s"),
  },
  {
    name: "docker_stats Initial Delay (unset)",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-initial-delay"), "3s"),
    from: DOCKER_END,
    to: dockerEnd("    initial_delay: 3s\n"),
    check: (v) => expect(v.initial_delay).toBe("3s"),
  },
  {
    name: "docker_stats Timeout (unset)",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-timeout"), "20s"),
    from: DOCKER_END,
    to: dockerEnd("    timeout: 20s\n"),
    check: (v) => expect(v.timeout).toBe("20s"),
  },
  {
    name: "docker_stats API Version typed 1.25 is written \"1.25\", keeping the comment",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-api-version"), "1.25"),
    from: '    api_version: "1.44" # a string to the collector\n',
    to: '    api_version: "1.25" # a string to the collector\n',
    check: (v) => expect(v.api_version).toBe("1.25"),
  },
  {
    name: "docker_stats API Version cleared removes the key (the collector then pins 1.44)",
    key: DOCKER,
    edit: (user) => retypeInto(user, byId("docker-stats-api-version"), ""),
    from: '    api_version: "1.44" # a string to the collector\n',
    to: "",
    check: (v) => expect(v).not.toHaveProperty("api_version"),
  },
  {
    name: "docker_stats an image pattern added",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Excluded Images");
      await user.type(screen.getByPlaceholderText("e.g. undesired-container or /.*undesired.*/"), "busybox{Enter}");
    },
    from: DOCKER_END,
    to: '      - "*/redis*"\n      - busybox\nprocessors:\n',
    check: (v) => expect(v.excluded_images).toEqual(["*/redis*", "busybox"]),
  },
  {
    name: "docker_stats the last image pattern removed removes the key",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Excluded Images");
      await user.click(screen.getByRole("button", { name: "Remove" }));
    },
    from: '    excluded_images:\n      - "*/redis*"\n',
    to: "",
    check: (v) => expect(v).not.toHaveProperty("excluded_images"),
  },
  {
    name: "docker_stats a container label's metric label retyped keeps its comment",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Container Labels to Metric Labels");
      await retypeInto(user, screen.getByDisplayValue("team"), "owner");
    },
    from: "      com.example.team: team # who owns it\n",
    to: "      com.example.team: owner # who owns it\n",
    check: (v) => expect(v.container_labels_to_metric_labels).toEqual({ "com.example.team": "owner" }),
  },
  {
    name: "docker_stats a container label renamed in place keeps its comment",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Container Labels to Metric Labels");
      await retypeInto(user, screen.getByDisplayValue("com.example.team"), "com.example.owner");
    },
    from: "      com.example.team: team # who owns it\n",
    to: "      com.example.owner: team # who owns it\n",
    check: (v) => expect(v.container_labels_to_metric_labels).toEqual({ "com.example.owner": "team" }),
  },
  {
    name: "docker_stats a container label added from the staging row",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Container Labels to Metric Labels");
      await user.type(screen.getByPlaceholderText(CONTAINER_LABEL_NOUNS.newKey!), "com.example.tier");
      await user.type(screen.getByPlaceholderText(CONTAINER_LABEL_NOUNS.newValue!), "tier{Enter}");
    },
    from: "      com.example.team: team # who owns it\n",
    to: "      com.example.team: team # who owns it\n      com.example.tier: tier\n",
    check: (v) => expect(v.container_labels_to_metric_labels).toEqual({ "com.example.team": "team", "com.example.tier": "tier" }),
  },
  {
    name: "docker_stats the last container label removed removes the map",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Container Labels to Metric Labels");
      await user.click(screen.getByRole("button", { name: CONTAINER_LABEL_NOUNS.removeLabel }));
    },
    from: "    container_labels_to_metric_labels:\n      com.example.team: team # who owns it\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("container_labels_to_metric_labels"),
  },
  {
    name: "docker_stats an environment variable renamed in place",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Env Vars to Metric Labels");
      await retypeInto(user, screen.getByDisplayValue("SERVICE_NAME"), "APP_NAME");
    },
    from: "      SERVICE_NAME: service\n",
    to: "      APP_NAME: service\n",
    check: (v) => expect(v.env_vars_to_metric_labels).toEqual({ APP_NAME: "service" }),
  },
  {
    name: "docker_stats an environment variable's metric label retyped",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Env Vars to Metric Labels");
      await retypeInto(user, screen.getByDisplayValue("service"), "service_name");
    },
    from: "      SERVICE_NAME: service\n",
    to: "      SERVICE_NAME: service_name\n",
    check: (v) => expect(v.env_vars_to_metric_labels).toEqual({ SERVICE_NAME: "service_name" }),
  },
  {
    name: "docker_stats an environment variable added from the staging row",
    key: DOCKER,
    edit: async (user) => {
      await openSection(user, "Env Vars to Metric Labels");
      await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newKey!), "APP_VERSION");
      await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newValue!), "version{Enter}");
    },
    from: "      SERVICE_NAME: service\n",
    to: "      SERVICE_NAME: service\n      APP_VERSION: version\n",
    check: (v) => expect(v.env_vars_to_metric_labels).toEqual({ SERVICE_NAME: "service", APP_VERSION: "version" }),
  },
];

describe("every field of each form writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const lf = c.base ?? CORPUS;
      const before = crlf ? CRLF(lf) : lf;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(text(), c.key));
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("the corpus as written has CRLF line endings, which the CRLF cases use", () => {
    expect(CORPUS_CRLF).toBe(CRLF(CORPUS));
  });
});

describe("merges, undo and opening (decision 2)", () => {
  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(HOST);
    await retypeInto(user, byId("initial-delay"), "2s");
    expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
    expect(entries()).toBe(1);
  });

  it("a key a merge gives shows as the text gives it; setting it leaves the anchor and the other's merge", async () => {
    const user = renderForm(HOST);
    expect(byId("collection-interval")).toHaveValue("30s");
    await retypeInto(user, byId("collection-interval"), "1m");
    expect(valueOf(text(), HOST).collection_interval).toBe("1m");
    expect(valueOf(text(), DOCKER).collection_interval).toBe("30s");
    expect(text()).toContain("x-interval: &interval\n  collection_interval: 30s\n");
  });

  /** The corpus with both sides of the process filter set, and a scraper with a bare filter block. */
  const BOTH = CORPUS.replace(
    "          names: [nginx]\n          match_type: strict\n",
    "          names: [nginx]\n          match_type: strict\n        exclude:\n          names: [bash]\n          match_type: regexp\n",
  );

  // One test per form and text, each with its own time limit (D9c Ruling 54): together they took 2-5 s.
  const OPENING_TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CORPUS_CRLF],
    ["both sides of a filter", BOTH],
    ["both components unset", "receivers:\n  hostmetrics:\n  docker_stats:\n"],
  ] as const;
  /** What each form shows once opened, at least, on the least of its texts: its text fields, every control, and a field each of its texts shows. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [HOST]: { textboxes: 4, all: 15, field: "root-path" },
    [DOCKER]: { textboxes: 10, all: 10, field: "docker-stats-endpoint" },
  };
  it.each([HOST, DOCKER].flatMap((key) => OPENING_TEXTS.map(([name, base]) => [key, name, base] as const)))(
    "opening %s on %s, every section, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      // Opened, it shows the form's fields (D9c final review M6).
      const { textboxes, all } = formControls();
      expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── The filters (decisions 3 and 9; Preflight ruling 5) ──

describe("hostmetrics' filters: match_type, both sides, held rows (decisions 3 and 9)", () => {
  // internal/filter/filterset/config.go:37-48: an unset match_type is refused
  // ("unrecognized match_type"), and the scrapers build a filter set for any list with items
  // (diskscraper/disk_scraper_others.go:51-63).
  it("a filter's first item is written with match_type: strict, in the same change", async () => {
    const user = renderForm(HOST, CORPUS.replace("      network:\n        exclude:\n          interfaces:\n            - lo # loopback\n          match_type: strict\n", "      network: {}\n"));
    await openSection(user, "Network Scraper");
    await pickIn(user, byId("network-interfaces-mode"), "Include Only");
    expect(entries()).toBe(0);
    await user.type(byId("network-interfaces-include-0"), "eth0");
    await user.tab();
    expect(scraperOf(text(), "network")).toEqual({ include: { interfaces: ["eth0"], match_type: "strict" } });
    expect(entries()).toBe(1);
  });

  it("a match chosen before the first item is written with it", async () => {
    const user = renderForm(HOST);
    await openSection(user, "Filesystem Scraper");
    await pickIn(user, byId("fs-mount-points-mode"), "Exclude");
    await pickIn(user, byId("fs-mount-points-exclude-match"), "Regex Match");
    expect(text()).toBe(CORPUS);
    await user.type(byId("fs-mount-points-exclude-0"), "^/run{Enter}");
    expect((scraperOf(text(), "filesystem") as Value).exclude_mount_points).toEqual({ mount_points: ["^/run"], match_type: "regexp" });
  });

  it("include and exclude are both kept: the collector applies both (filesystemscraper/config.go:78-117)", async () => {
    const user = renderForm(HOST);
    await openSection(user, "Filesystem Scraper");
    // Include devices, exclude fs types: each filter shows its own side.
    expect(byId("fs-devices-mode")).toHaveTextContent("Include Only");
    expect(byId("fs-types-mode")).toHaveTextContent("Exclude");
    // Include Only beside an exclude list adds the include list; neither goes.
    await pickIn(user, byId("fs-types-mode"), "Include Only");
    await user.type(byId("fs-types-include-0"), "ext4");
    await user.tab();
    expect(scraperOf(text(), "filesystem")).toMatchObject({
      include_fs_types: { fs_types: ["ext4"], match_type: "strict" },
      exclude_fs_types: { fs_types: ["tmpfs", "overlay"], match_type: "strict" },
    });
    // Editing one side leaves the other.
    await retypeInto(user, byId("fs-types-include-0"), "xfs");
    expect((scraperOf(text(), "filesystem") as Value).exclude_fs_types).toEqual({ fs_types: ["tmpfs", "overlay"], match_type: "strict" });
  });

  // Ruling 48 (a): a side with items and no match_type (or a null one) gets strict with the next item added.
  it.each([
    ["no match_type", "          names: [nginx]\n"],
    ["a null match_type", "          names: [nginx]\n          match_type:\n"],
  ])("an item added to a side with %s is written with match_type: strict", async (_name, block) => {
    const base = CORPUS.replace("          names: [nginx]\n          match_type: strict\n", block);
    const user = renderForm(HOST, base);
    await openSection(user, "Process Scraper");
    await user.click(screen.getByRole("button", { name: "Add Process Name" }));
    await user.type(byId("process-names-include-1"), "postgres");
    await user.tab();
    expect((scraperOf(text(), "process") as Value).include).toEqual({ names: ["nginx", "postgres"], match_type: "strict" });
    expect(entries()).toBe(1);
  });

  // Ruling 48 (b): with both sides shown, the mode select reads the side last picked.
  it("picking Exclude beside an include list reads Exclude, before and after its first item; Include Only reads Include Only", async () => {
    const user = renderForm(HOST);
    await openSection(user, "Disk Scraper");
    expect(byId("disk-devices-mode")).toHaveTextContent("Include Only");
    await pickIn(user, byId("disk-devices-mode"), "Exclude");
    expect(byId("disk-devices-mode")).toHaveTextContent("Exclude");
    await user.type(byId("disk-devices-exclude-0"), "loop0");
    await user.tab();
    expect(scraperOf(text(), "disk")).toMatchObject({ exclude: { devices: ["loop0"], match_type: "strict" } });
    expect(byId("disk-devices-mode")).toHaveTextContent("Exclude");
    await pickIn(user, byId("disk-devices-mode"), "Include Only");
    expect(byId("disk-devices-mode")).toHaveTextContent("Include Only");
    expect(byId("disk-devices-include-0")).toHaveValue("sda");
    expect(byId("disk-devices-exclude-0")).toHaveValue("loop0");
    // The picked side gone, the text says the mode again.
    await pickIn(user, byId("disk-devices-mode"), "Exclude");
    await user.click(screen.getAllByRole("button", { name: "Remove device" }).at(-1)!);
    expect(byId("disk-devices-mode")).toHaveTextContent("Include Only");
  });

  it("a text with both shows both lists, each with its own Match select", async () => {
    const both = CORPUS.replace(
      "          names: [nginx]\n          match_type: strict\n",
      "          names: [nginx]\n          match_type: strict\n        exclude:\n          names: [bash]\n          match_type: regexp\n",
    );
    const user = renderForm(HOST, both);
    await openSection(user, "Process Scraper");
    expect(byId("process-names-mode")).toHaveTextContent("Include Only");
    expect(byId("process-names-include-0")).toHaveValue("nginx");
    expect(byId("process-names-include-match")).toHaveTextContent("Strict Match");
    expect(byId("process-names-exclude-0")).toHaveValue("bash");
    expect(byId("process-names-exclude-match")).toHaveTextContent("Regex Match");
    // The section's count is both lists' items.
    expect(screen.getByRole("button", { name: /^Process Scraper/ })).toHaveTextContent("Process Scraper2");
    await pickIn(user, byId("process-names-exclude-match"), "Strict Match");
    expect(scraperOf(text(), "process")).toMatchObject({
      include: { names: ["nginx"], match_type: "strict" },
      exclude: { names: ["bash"], match_type: "strict" },
    });
  });

  it("Include Only holds the first row: picking writes nothing, and a row left empty writes nothing", async () => {
    const user = renderForm(HOST);
    await openSection(user, "Filesystem Scraper");
    await pickIn(user, byId("fs-mount-points-mode"), "Include Only");
    expect(byId("fs-mount-points-include-0")).toHaveValue("");
    await user.click(byId("fs-mount-points-include-0"));
    await user.tab();
    await user.click(screen.getAllByRole("button", { name: "Add Device" })[0]!);
    await user.click(byId("fs-devices-include-1"));
    await user.tab();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
    expect(text()).not.toContain('""');
  });
});

// ── hostmetrics' scrapers ──

describe("hostmetrics' scrapers (Parity: on by presence)", () => {
  it("a scraper is ticked while its key is under scrapers, a bare one included, and its section shows", async () => {
    renderForm(HOST, CORPUS.replace("      cpu: {}\n", "      cpu: {}\n      paging:\n").replace("      disk:\n        include:\n          devices: [sda, sdb] # the data disks\n          match_type: strict\n", "      disk: # bare\n"));
    for (const on of ["cpu", "memory", "paging", "load", "disk", "filesystem", "network", "process"]) {
      expect(byId(`scraper-${on}`)).toBeChecked();
    }
    for (const off of ["processes", "system", "nfs"]) expect(byId(`scraper-${off}`)).not.toBeChecked();
    // A bare disk: shows its section, with no filter.
    expect(screen.getByRole("button", { name: /^Disk Scraper/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Processes Scraper/ })).toBeNull();
  });

  it("the last scraper can be unticked; the collector's refusal is D13's to report (config.go:43-45)", async () => {
    const one = "receivers:\n  hostmetrics:\n    scrapers:\n      cpu: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    metrics:\n      receivers: [hostmetrics]\n      exporters: [debug]\n";
    const user = renderForm(HOST, one);
    await user.click(byId("scraper-cpu"));
    expect(valueOf(text(), HOST).scrapers).toEqual({});
    expect(byId("scraper-cpu")).not.toBeChecked();
    expect(entries()).toBe(1);
  });

  it("with no scrapers key, ticking one adds it", async () => {
    const none = "receivers:\n  hostmetrics:\n    collection_interval: 10s\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    metrics:\n      receivers: [hostmetrics]\n      exporters: [debug]\n";
    const user = renderForm(HOST, none);
    await user.click(byId("scraper-disk"));
    expect(text()).toBe(none.replace("    collection_interval: 10s\n", "    collection_interval: 10s\n    scrapers:\n      disk: {}\n"));
    expect(screen.getByRole("button", { name: /^Disk Scraper/ })).toBeInTheDocument();
  });

  it("a scraper whose value can't hold settings is read-only with the hint; scrapers that isn't a mapping disables them all", () => {
    renderForm(HOST, CORPUS.replace("      cpu: {}\n", "      cpu: [a]\n"));
    expect(byId("scraper-cpu")).toBeChecked();
    expect(byId("scraper-cpu")).toBeDisabled();
    expect(byId("scraper-disk")).toBeEnabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(1);

    // Ruling 46: scrapers that isn't a mapping ticks none (none can be said to be on), disables all, one hint.
    for (const odd of ["receivers:\n  hostmetrics:\n    scrapers: [cpu]\n", "receivers:\n  hostmetrics:\n    scrapers: cpu\n"]) {
      rerenderForm(HOST, odd);
      const boxes = screen.getAllByRole("checkbox");
      expect(boxes).toHaveLength(11);
      for (const box of boxes) {
        expect(box).toBeDisabled();
        expect(box).not.toBeChecked();
      }
      expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /Scraper/ })).toBeNull();
      expect(text()).toBe(odd);
    }
  });
});

// ── What the forms show (decision 3) ──

describe("what the forms show (decision 3)", () => {
  it("hostmetrics unset: the collector's defaults as placeholders and hints", async () => {
    // Core scraper/scraperhelper/internal/controller/generated_config.go:39-40 (1m, 1s); factory.go:39 (5m).
    const user = renderForm(HOST, "receivers:\n  hostmetrics:\n    scrapers:\n      process: {}\n      load: {}\n      filesystem: {}\n");
    expect(byId("collection-interval")).toHaveValue("");
    expect(byId("collection-interval")).toHaveAttribute("placeholder", "1m");
    expect(hint("How often to collect metrics. · Default 1m")).toBeInTheDocument();
    expect(byId("initial-delay")).toHaveAttribute("placeholder", "1s");
    expect(hint("Wait before the first collection. · Default 1s")).toBeInTheDocument();
    await openSection(user, "Advanced");
    expect(byId("metadata-interval")).toHaveAttribute("placeholder", "5m");
    expect(hint("How often to collect entity event metadata (experimental). · Default 5m")).toBeInTheDocument();
    expect(byId("root-path")).toHaveAttribute("placeholder", "e.g. /hostfs");
    await openSection(user, "Load Scraper");
    expect(byId("cpu-average")).not.toBeChecked();
    await openSection(user, "Process Scraper");
    for (const [id] of MUTE_BOXES) expect(byId(id)).not.toBeChecked();
    expect(byId("scrape-process-delay")).toHaveAttribute("placeholder", "e.g. 10s");
    await openSection(user, "Filesystem Scraper");
    expect(byId("include-virtual-fs")).not.toBeChecked();
    expect(byId("fs-devices-mode")).toHaveTextContent("No Filter");
  });

  it("docker_stats unset: the collector's defaults as placeholders and hints", () => {
    // internal/docker/config.go:90-95 (the socket); receiver/dockerstatsreceiver/factory.go:29-31 (10s, 5s).
    renderForm(DOCKER, "receivers:\n  docker_stats: {}\n");
    expect(byId("docker-stats-endpoint")).toHaveValue("");
    expect(byId("docker-stats-endpoint")).toHaveAttribute("placeholder", "e.g. unix:///var/run/docker.sock");
    expect(hint("Address of the Docker daemon. · Default unix:///var/run/docker.sock")).toBeInTheDocument();
    expect(byId("docker-stats-interval")).toHaveAttribute("placeholder", "10s");
    expect(hint("How often container stats are gathered. · Default 10s")).toBeInTheDocument();
    expect(byId("docker-stats-initial-delay")).toHaveAttribute("placeholder", "1s");
    expect(byId("docker-stats-timeout")).toHaveAttribute("placeholder", "5s");
    expect(hint("Per-request timeout for Docker daemon queries. · Default 5s")).toBeInTheDocument();
    expect(byId("docker-stats-api-version")).toHaveValue("");
    expect(byId("docker-stats-api-version")).toHaveAttribute("placeholder", "e.g. 1.25");
  });

  it("values as written: a quoted API version shows its characters, a plain number as written", () => {
    renderForm(DOCKER);
    expect(byId("docker-stats-api-version")).toHaveValue("1.44");
    rerenderForm(DOCKER, CORPUS.replace('    api_version: "1.44" # a string to the collector\n', "    api_version: 1.40\n"));
    expect(byId("docker-stats-api-version")).toHaveValue("1.40");
  });

  it("values the fields can't show are read-only with the hint; the rest works", async () => {
    const odd = CORPUS.replace("    root_path: /hostfs # the host's mount\n", "    root_path: [a]\n")
      .replace("        cpu_average: false\n", "        cpu_average: sometimes\n")
      .replace("          devices: [sda, sdb] # the data disks\n", "          devices: {a: b}\n");
    const user = renderForm(HOST, odd);
    await openSection(user, "Advanced");
    expect(byId("root-path")).toBeDisabled();
    await openSection(user, "Load Scraper");
    expect(byId("cpu-average")).toBeDisabled();
    await openSection(user, "Disk Scraper");
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(3);
    await retypeInto(user, byId("initial-delay"), "2s");
    expect(valueOf(text(), HOST).initial_delay).toBe("2s");

    const again = rerenderForm(DOCKER, CORPUS.replace("      SERVICE_NAME: service\n", "      SERVICE_NAME: [a]\n"));
    await openSection(again, "Env Vars to Metric Labels");
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

// ── docker_stats: api_version, the label maps, the copy ──

describe("docker_stats' API version is a string (decision 2)", () => {
  // internal/docker/config.go:34 (`DockerAPIVersion string`), 47-61: a float there is refused, with a hint
  // to quote it; receiver/dockerstatsreceiver/config.go:41-47 checks it as a version string.
  it("the collector reads a string: 1.25 typed where none is set is written \"1.25\" and parses as a string", async () => {
    const unset = CORPUS.replace('    api_version: "1.44" # a string to the collector\n', "");
    const user = renderForm(DOCKER, unset);
    await retypeInto(user, byId("docker-stats-api-version"), "1.25");
    expect(text()).toContain('\n    api_version: "1.25"\n');
    expect(valueOf(text(), DOCKER).api_version).toBe("1.25");
    expect(typeof valueOf(text(), DOCKER).api_version).toBe("string");
    // Typed again over a plain number, it is still written as a string.
    rerenderForm(DOCKER, CORPUS.replace('    api_version: "1.44" # a string to the collector\n', "    api_version: 1.40 # a float\n"));
    await retypeInto(userEvent.setup(), byId("docker-stats-api-version"), "1.41");
    expect(text()).toContain('    api_version: "1.41" # a float\n');
    expect(valueOf(text(), DOCKER).api_version).toBe("1.41");
  });

  // Ruling 47 (decision 4): internal/docker/config.go:47-61 refuses a float there ("wrap the 'api_version' value in
  // quotes"); a number in the text is said so, and typing quotes it, the same characters included.
  const NUMBER = CORPUS.replace('    api_version: "1.44" # a string to the collector\n', "    api_version: 1.40 # a float\n");

  it("a number in the text shows as written with the hint; focusing and leaving writes nothing", async () => {
    const user = renderForm(DOCKER, NUMBER);
    expect(byId("docker-stats-api-version")).toHaveValue("1.40");
    expect(screen.getByText(API_VERSION_NUMBER_HINT)).toBeInTheDocument();
    expect(API_VERSION_NUMBER_HINT).toBe("Written as a number; the collector needs a quoted string. Retype it to quote it.");
    await user.click(byId("docker-stats-api-version"));
    await user.tab();
    expect(text()).toBe(NUMBER);
    expect(entries()).toBe(0);
    // A string, quoted or plain, has no such hint.
    rerenderForm(DOCKER, CORPUS);
    expect(screen.queryByText(API_VERSION_NUMBER_HINT)).toBeNull();
    rerenderForm(DOCKER, CORPUS.replace('    api_version: "1.44" # a string to the collector\n', "    api_version: v1.44\n"));
    expect(screen.queryByText(API_VERSION_NUMBER_HINT)).toBeNull();
  });

  it.each([
    ["LF", false],
    ["CRLF", true],
  ] as const)("retyping a number's same characters writes them as a string, one undo entry, %s", async (_name, crlf) => {
    const before = crlf ? CRLF(NUMBER) : NUMBER;
    const user = renderForm(DOCKER, before);
    await retypeInto(user, byId("docker-stats-api-version"), "1.40");
    const eol = crlf ? "\r\n" : "\n";
    expect(text()).toBe(before.replace(`    api_version: 1.40 # a float${eol}`, `    api_version: "1.40" # a float${eol}`));
    expect(valueOf(text(), DOCKER).api_version).toBe("1.40");
    expect(entries()).toBe(1);
    expect(screen.queryByText(API_VERSION_NUMBER_HINT)).toBeNull();
    // Now a string: retyping the same characters again writes nothing.
    await retypeInto(user, byId("docker-stats-api-version"), "1.40");
    expect(entries()).toBe(1);
  });

  it("its hint says unset pins 1.44 (factory.go:32-33; receiver.go:28), not that the client negotiates", () => {
    renderForm(DOCKER);
    expect(hint(API_VERSION_HINT)).toBeInTheDocument();
    expect(API_VERSION_HINT).toBe("Docker client API version to pin (1.25+). Default 1.44. Always a quoted string in YAML.");
    expect(screen.queryByText(/auto-negotiates/)).toBeNull();
  });
});

describe("docker_stats' label maps (D9b decision 4; D9c decision 4)", () => {
  const TWO_LABELS = CORPUS.replace(
    "      com.example.team: team # who owns it\n",
    "      com.example.team: team # who owns it\n      com.example.tier: tier\n",
  );

  it("a label renamed to another row's name is refused under the row; the row shows its name again", async () => {
    const user = renderForm(DOCKER, TWO_LABELS);
    await openSection(user, "Container Labels to Metric Labels");
    await retypeInto(user, screen.getByDisplayValue("com.example.tier"), "com.example.team");
    expect(screen.getByText("A label with this name already exists.")).toBeInTheDocument();
    expect(text()).toBe(TWO_LABELS);
    expect(entries()).toBe(0);
    expect(screen.getByDisplayValue("com.example.tier")).toBeInTheDocument();
  });

  it("the staging row refuses a variable another row has, rather than overwriting it", async () => {
    const user = renderForm(DOCKER);
    await openSection(user, "Env Vars to Metric Labels");
    await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newKey!), "SERVICE_NAME");
    await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newValue!), "other{Enter}");
    expect(screen.getByText("A variable with this name already exists.")).toBeInTheDocument();
    expect(text()).toBe(CORPUS);
  });

  it("a rename is in place: the key keeps its position, its value and its comment", async () => {
    const user = renderForm(DOCKER, TWO_LABELS);
    await openSection(user, "Container Labels to Metric Labels");
    await retypeInto(user, screen.getByDisplayValue("com.example.team"), "com.example.owner");
    expect(text()).toContain("      com.example.owner: team # who owns it\n      com.example.tier: tier\n");
    expect(Object.keys(valueOf(text(), DOCKER).container_labels_to_metric_labels as Value)).toEqual(["com.example.owner", "com.example.tier"]);
  });

  it("each map has its own nouns in D9b's staging markup: rows, the staging row, Press Enter to add.", async () => {
    const user = renderForm(DOCKER);
    await openSection(user, "Container Labels to Metric Labels");
    await openSection(user, "Env Vars to Metric Labels");
    expect(screen.getByPlaceholderText("Container label")).toHaveValue("com.example.team");
    expect(screen.getByPlaceholderText("Environment variable")).toHaveValue("SERVICE_NAME");
    expect(screen.getAllByPlaceholderText("Metric label")).toHaveLength(2);
    expect(screen.getByPlaceholderText("e.g. io.kubernetes.container.name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. container_spec_name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. APP_VERSION")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. version")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add container label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add environment variable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove container label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove environment variable" })).toBeInTheDocument();
    expect(screen.getAllByText("Press Enter to add.")).toHaveLength(2);
    expect(screen.queryByPlaceholderText(/Header|Authorization|Bearer/)).toBeNull();
    expect(hint("Docker container label name → metric label key.")).toBeInTheDocument();
    expect(hint("Container environment variable → metric label key.")).toBeInTheDocument();
  });
});

describe("the copy (Appearance)", () => {
  it("hostmetrics: the scrapers with their OS tags, and the per-scraper intervals alert", async () => {
    const user = renderForm(HOST);
    expect(hint("Select which metrics to collect.")).toBeInTheDocument();
    expect(screen.getByText("Per-process metrics")).toHaveTextContent("Per-process metrics[Linux/Win/Mac/BSD]");
    expect(screen.getByText("Process count by state")).toHaveTextContent("[Linux/Mac/BSD]");
    expect(screen.getByText("Miscellaneous system metrics")).toHaveTextContent("[Linux/Win/Mac]");
    expect(screen.getByText("NFS server/client metrics")).toHaveTextContent("[Linux only]");
    expect(screen.getByText("CPU utilization metrics").textContent).toBe("CPU utilization metrics");
    await openSection(user, "Advanced");
    expect(screen.getByText("Per-scraper intervals").nextElementSibling).toHaveTextContent(
      "To scrape at different intervals, add multiple hostmetrics receiver instances (e.g. hostmetrics/disk) with different collection_interval values.",
    );
    await openSection(user, "Process Scraper");
    expect(screen.getByText("Mute Process Cgroup Errors (Linux only)")).toBeInTheDocument();
  });

  it("docker_stats: the socket alert, the sections and the footer", () => {
    renderForm(DOCKER);
    expect(screen.getByText(/read access to the Docker socket/)).toHaveTextContent(
      "The collector needs read access to the Docker socket (mount /var/run/docker.sock into the container, and make sure the collector user can read it). Linux only; requires Docker API 1.25+.",
    );
    expect(screen.getByText("Per-metric enable/disable toggles (metrics:) are available in the YAML editor.")).toBeInTheDocument();
  });
});

describe("markup (Ruling 38)", () => {
  it("hostmetrics' rows: scraper and described rows items-start space-x-3, error rows items-center", async () => {
    const user = renderForm(HOST);
    const cpuRow = byId("scraper-cpu").parentElement!;
    expect(cpuRow).toHaveClass("flex", "items-start", "space-x-3");
    expect(screen.getByText("CPU", { selector: "label" }).parentElement).toHaveClass("flex-1", "grid", "gap-1", "leading-none");
    await openSection(user, "Filesystem Scraper");
    const described = screen.getByText("Include Virtual Filesystems", { selector: "label" });
    expect(described).toHaveClass("text-sm", "font-medium", "cursor-pointer");
    expect(described.parentElement).toHaveClass("grid", "gap-1", "leading-none");
    expect(described.parentElement!.parentElement).toHaveClass("flex", "items-start", "space-x-3");
    expect(screen.getByText("Include pseudo filesystems like /proc and /sys.")).toHaveClass("text-xs", "text-muted-foreground");
    await openSection(user, "Process Scraper");
    expect(byId("mute-all-errors").parentElement).toHaveClass("flex", "items-center", "space-x-3");
  });

  // Ruling 85, measured in Chromium, WebKit and Firefox: these boxes sat 2 px above their label's line.
  it("a scraper's box and a described box are moved down 2 px beside their label; an error box is left as it was (Ruling 85)", async () => {
    const user = renderForm(HOST);
    expect(byId("scraper-cpu")).toHaveClass("mt-0.5");
    await openSection(user, "Filesystem Scraper");
    expect(byId("include-virtual-fs")).toHaveClass("mt-0.5");
    await openSection(user, "Process Scraper");
    expect(byId("mute-all-errors")).not.toHaveClass("mt-0.5");
  });
});

// ── Privacy (decision 10) ──

describe("privacy (decision 10)", () => {
  // Its own time limit (D9c Rulings 54 and 80).
  it("puts no config value in any attribute: every section open, the menus open", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  hostmetrics:",
      `    collection_interval: ${MARK}-ci`,
      `    initial_delay: ${MARK}-delay`,
      `    root_path: ${MARK}-root`,
      `    metadata_collection_interval: ${MARK}-mci`,
      "    scrapers:",
      "      cpu: {}",
      "      disk:",
      "        include:",
      `          devices: [${MARK}-dev]`,
      `          match_type: ${MARK}-match`,
      "        exclude:",
      `          devices: [${MARK}-xdev]`,
      "      filesystem:",
      "        include_devices:",
      `          devices: [${MARK}-fsdev]`,
      "        exclude_fs_types:",
      `          fs_types: [${MARK}-fstype]`,
      "        include_mount_points:",
      `          mount_points: [${MARK}-mount]`,
      `        include_virtual_filesystems: ${MARK}-ivf`,
      "      load:",
      `        cpu_average: ${MARK}-avg`,
      "      network:",
      "        exclude:",
      `          interfaces: [${MARK}-if]`,
      "      process:",
      "        include:",
      `          names: [${MARK}-proc]`,
      `        mute_process_all_errors: ${MARK}-mute`,
      `        scrape_process_delay: ${MARK}-spd`,
      "  docker_stats:",
      `    endpoint: ${MARK}-endpoint`,
      `    collection_interval: ${MARK}-dci`,
      `    initial_delay: ${MARK}-ddelay`,
      `    timeout: ${MARK}-timeout`,
      `    api_version: ${MARK}-api`,
      `    excluded_images: [${MARK}-image]`,
      "    container_labels_to_metric_labels:",
      `      ${MARK}-clabel: ${MARK}-cmetric`,
      "    env_vars_to_metric_labels:",
      `      ${MARK}-env: ${MARK}-emetric`,
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    metrics:",
      "      receivers: [hostmetrics, docker_stats]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
        }
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const runs: [string, readonly string[]][] = [
      [HOST, ["disk-devices-include-match"]],
      [DOCKER, []],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      expect(shown()).toContain(`${MARK}-`);
      scan(key);
      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }
      // A held first row (Include Only on a filter with none), and a staging row typed into.
      if (key === HOST) {
        await pickIn(user, byId("fs-types-mode"), "Include Only");
        await user.type(byId("fs-types-include-0"), `${MARK}-held`);
        scan(`${key} (held row)`);
      } else {
        await user.type(screen.getByPlaceholderText(CONTAINER_LABEL_NOUNS.newKey!), `${MARK}-staged`);
        scan(`${key} (staging row)`);
      }
      expect(document.querySelector("form")).toBeNull();
    }
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── Dispatch ──

describe("dispatch (decision 2)", () => {
  it("the collector's host_metrics gets the Hostmetrics form (a deprecated_type at v0.162.0: metadata.yaml:2-3)", () => {
    expect(formFor("receiver", "host_metrics")).toBe(HostmetricsReceiverForm);
    expect(formFor("receiver", "docker_stats")).toBe(DockerStatsReceiverForm);
    const renamed = CORPUS.replace("  hostmetrics:\n", "  host_metrics:\n").replace("receivers: [hostmetrics, docker_stats]", "receivers: [host_metrics, docker_stats]");
    openText(renamed);
    const node = componentNamed("receivers.host_metrics");
    const Form = formFor("receiver", node.data.componentSubType)!;
    render(
      <ComponentForm nodeId={node.id}>
        <Form />
      </ComponentForm>,
    );
    expect(byId("scraper-cpu")).toBeChecked();
    expect(text()).toBe(renamed);
  });
});

// ── DockerStatsReceiverForm cases ──

describe("DockerStatsReceiverForm cases", () => {
  /** The palette's docker_stats, as a generator writes it (strings single-quoted). */
  const PALETTE = [
    "receivers:",
    "  docker_stats:",
    "    endpoint: 'unix:///var/run/docker.sock'",
    "    collection_interval: '10s'",
    "    timeout: '5s'",
    "exporters:",
    "  otlp:",
    "    endpoint: 'localhost:4317'",
    "service:",
    "  pipelines:",
    "    metrics:",
    "      receivers: [docker_stats]",
    "      exporters: [otlp]",
    "",
  ].join("\n");
  const input = (value: string) => [...document.querySelectorAll("input")].find((i) => i.value === value);

  it("the palette text is the palette's defaults", () => {
    expect(valueOf(PALETTE, DOCKER)).toEqual({ endpoint: "unix:///var/run/docker.sock", collection_interval: "10s", timeout: "5s" });
  });

  it("renders endpoint value from config", () => {
    renderForm(DOCKER, PALETTE);
    expect(input("unix:///var/run/docker.sock")).toBeInTheDocument();
  });

  it("renders the socket-access guidance", () => {
    renderForm(DOCKER, PALETTE);
    expect(screen.getByText(/read access to the Docker socket/)).toBeInTheDocument();
  });

  it("renders collapsible section headers", () => {
    renderForm(DOCKER, PALETTE);
    expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excluded Images" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Container Labels to Metric Labels" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Env Vars to Metric Labels" })).toBeInTheDocument();
  });

  it("generates valid YAML: a field's edit changes only its line, and the text parses", async () => {
    const user = renderForm(DOCKER, PALETTE);
    await retypeInto(user, byId("docker-stats-timeout"), "20s");
    expect(text()).toBe(PALETTE.replace("    timeout: '5s'\n", "    timeout: '20s'\n"));
    expect(parse(text()).ok).toBe(true);
    expect(text()).toContain("receivers:\n  docker_stats:\n");
    expect(text()).toContain("    endpoint: 'unix:///var/run/docker.sock'\n");
  });

  it("survives a round trip with labels, exclusions, and api_version", async () => {
    const user = renderForm(DOCKER, PALETTE);
    await retypeInto(user, byId("docker-stats-interval"), "2s");
    await retypeInto(user, byId("docker-stats-timeout"), "20s");
    await retypeInto(user, byId("docker-stats-api-version"), "1.25");
    await openSection(user, "Excluded Images");
    const pattern = screen.getByPlaceholderText("e.g. undesired-container or /.*undesired.*/");
    await user.type(pattern, "undesired-container{Enter}");
    await user.type(pattern, "/.*undesired.*/{Enter}");
    await openSection(user, "Container Labels to Metric Labels");
    await user.type(screen.getByPlaceholderText(CONTAINER_LABEL_NOUNS.newKey!), "my.container.label");
    await user.type(screen.getByPlaceholderText(CONTAINER_LABEL_NOUNS.newValue!), "my-metric-label{Enter}");
    await openSection(user, "Env Vars to Metric Labels");
    await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newKey!), "MY_ENVIRONMENT_VARIABLE");
    await user.type(screen.getByPlaceholderText(ENV_VAR_NOUNS.newValue!), "my-metric-label{Enter}");
    const written = text();

    expect(parse(written).ok).toBe(true);
    const roundTripped = valueOf(written, DOCKER);
    expect(roundTripped.collection_interval).toBe("2s");
    expect(roundTripped.timeout).toBe("20s");
    expect(roundTripped.api_version).toBe("1.25");
    expect(roundTripped.container_labels_to_metric_labels).toEqual({ "my.container.label": "my-metric-label" });
    expect(roundTripped.env_vars_to_metric_labels).toEqual({ MY_ENVIRONMENT_VARIABLE: "my-metric-label" });
    expect(roundTripped.excluded_images).toEqual(["undesired-container", "/.*undesired.*/"]);

    rerenderForm(DOCKER, written);
    expect(input("1.25")).toBeInTheDocument();
    expect(text()).toBe(written);
  });
});
