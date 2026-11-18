import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findDistribution,
  resetCollectorCatalogue,
  useCollectorCatalogueStore,
  useCollectorDistributions,
} from "./collector-catalogue-store.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { ACME, CATALOGUE, CONTRIB } from "~/test/collector-distributions.js";

const NETWORK_ERROR = new ApiError("network_error", "Could not reach the server. Check your connection.");

/** Two readers of the catalogue on one page, as the list and its create dialog are. */
function Readers() {
  const first = useCollectorDistributions();
  const second = useCollectorDistributions();
  return (
    <p>
      {first.failed ? "failed" : (first.distributions?.map((d) => d.id).join(",") ?? "unread")}/
      {second.distributions?.length ?? "unread"}
    </p>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetCollectorCatalogue();
});

describe("the collector catalogue store (D13a decision 11)", () => {
  it("is read once, however many components read it, and stays read for the page", async () => {
    const read = vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });

    const { unmount } = render(<Readers />);
    expect(await screen.findByText(`${CONTRIB.id}/1`)).toBeInTheDocument();
    unmount();
    render(<Readers />);

    expect(screen.getByText(`${CONTRIB.id}/1`)).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    expect(useCollectorCatalogueStore.getState().status).toBe("loaded");
  });

  it("says a failed read failed, keeps no distributions, and the next reader asks again", async () => {
    const read = vi
      .spyOn(apiClient, "getCollectorDistributions")
      .mockRejectedValueOnce(NETWORK_ERROR)
      .mockResolvedValue({ distributions: CATALOGUE });

    const { unmount } = render(<Readers />);
    expect(await screen.findByText("failed/unread")).toBeInTheDocument();
    unmount();
    render(<Readers />);

    expect(await screen.findByText(`${CONTRIB.id}/1`)).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while its reader isn't active (a closed dialog)", async () => {
    const read = vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
    function Closed() {
      useCollectorDistributions(false);
      return null;
    }

    render(<Closed />);

    await waitFor(() => expect(useCollectorCatalogueStore.getState().status).toBe("idle"));
    expect(read).not.toHaveBeenCalled();
  });

  it("finds a distribution by id; nothing while unread, or for an id it doesn't list", () => {
    expect(findDistribution([CONTRIB, ACME], ACME.id)).toBe(ACME);
    expect(findDistribution([CONTRIB, ACME], "grafana-alloy")).toBeUndefined();
    expect(findDistribution(null, CONTRIB.id)).toBeUndefined();
    expect(findDistribution(CATALOGUE, null)).toBeUndefined();
  });
});
