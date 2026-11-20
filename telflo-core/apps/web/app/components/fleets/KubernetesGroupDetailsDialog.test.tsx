import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { collectorGroup, gatewaysGroup, kubernetesAnnotations } from "~/test/fleets.js";
import type { KubernetesGroupRow } from "~/lib/kubernetes-groups.js";
import { KubernetesGroupDetailsDialog } from "./KubernetesGroupDetailsDialog.js";

/*
 * A Kubernetes group's details. The rows and their words are pinned
 * through the tab (`KubernetesGroupsTab.test.tsx`'s "opens a row's More");
 * this file pins the dialog's privacy: a gateway's name, its namespace and
 * its volumes' paths are configuration text, shown inside `ph-no-capture`
 * (replay records none of it) and in no attribute. The title names the
 * gateway as the masked shell's text, as every dialog's title does.
 */

const GATEWAY = "canary-gw-61f2";
const NAMESPACE = "canary-ns-0b7e";
const HOST_PATH = "/srv/canary-host-c4a9";
const MOUNT_PATH = "/canary-mount-8d13";

function renderDetails(row: KubernetesGroupRow) {
  const Stub = createRoutesStub([
    { path: "/", Component: () => <KubernetesGroupDetailsDialog open onOpenChange={() => undefined} row={row} /> },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

/** The text nodes holding `text`: how many sit inside ph-no-capture, and how many outside it. */
function textPlaces(text: string, except: (node: Node) => boolean = () => false) {
  let inside = 0;
  let outside = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.textContent ?? "").includes(text) || except(node)) continue;
    if (node.parentElement?.closest(".ph-no-capture")) inside += 1;
    else outside += 1;
  }
  return { inside, outside };
}

/** The attributes holding `text`, anywhere in the document. */
function attributeHolders(text: string): string[] {
  const holders: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) if (attribute.value.includes(text)) holders.push(`${element.tagName} ${attribute.name}`);
  }
  return holders;
}

describe("KubernetesGroupDetailsDialog's privacy", () => {
  it("shows a gateway's name, namespace and volume paths only as text inside ph-no-capture, in no attribute", async () => {
    renderDetails({
      role: "gateway",
      group: gatewaysGroup({
        name: GATEWAY,
        annotations: kubernetesAnnotations({
          namespace: NAMESPACE,
          replicas: 2,
          volumes: [{ hostPath: HOST_PATH, hostPathType: "Directory", mountPath: MOUNT_PATH, readOnly: true }],
        }),
      }),
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(`${HOST_PATH} → ${MOUNT_PATH} (Directory, read-only)`);
    // The title is the masked shell's text, as every dialog's; the Group row's name is inside ph-no-capture.
    const inTitle = (node: Node) => node.parentElement?.closest("h2") !== null;
    expect(screen.getByRole("heading")).toHaveTextContent(GATEWAY);
    expect(textPlaces(GATEWAY, inTitle)).toEqual({ inside: 1, outside: 0 });
    for (const text of [NAMESPACE, HOST_PATH, MOUNT_PATH]) expect(textPlaces(text), text).toEqual({ inside: 1, outside: 0 });
    for (const text of [GATEWAY, NAMESPACE, HOST_PATH, MOUNT_PATH]) expect(attributeHolders(text), text).toEqual([]);
  });

  it("shows the Agent's namespace inside ph-no-capture, its Group its badge alone", async () => {
    renderDetails({ role: "node", group: collectorGroup({ annotations: kubernetesAnnotations({ role: "node", namespace: NAMESPACE, replicas: undefined }) }) });
    const dialog = await screen.findByRole("dialog", { name: "Agent" });
    expect(dialog).toHaveTextContent("GroupAgentNamespace");
    expect(dialog).not.toHaveTextContent("Role");
    expect(textPlaces(NAMESPACE)).toEqual({ inside: 1, outside: 0 });
    expect(attributeHolders(NAMESPACE)).toEqual([]);
  });
});
