import { useEffect } from "react";
import type { CollectorDistribution, CollectorSupportedComponents } from "@telflo/contracts";
import { create } from "zustand";
import { getCollectorDistributions } from "~/lib/api-client.js";
import { usePlayground } from "~/lib/playground/context.js";

/** Where the catalogue's one request stands: not asked yet, under way, answered, or failed (asked again next time). */
export type CollectorCatalogueStatus = "idle" | "loading" | "loaded" | "failed";

type CollectorCatalogueState = {
  /**
   * The collector catalogue (D13a decisions 1 and 11): every distribution,
   * in the catalogue's order, each with the versions it offers, newest
   * first; null until it has been read.
   */
  distributions: CollectorDistribution[] | null;
  status: CollectorCatalogueStatus;
  /**
   * Reads the catalogue, unless it has been read or is being read: once per
   * page load (the catalogue changes only with a deploy). A failed read is
   * tried again by the next `load`.
   */
  load: () => Promise<void>;
};

const NOT_READ = { distributions: null, status: "idle" } satisfies Partial<CollectorCatalogueState>;

/**
 * The collector catalogue, as the API answers it (`GET
 * /api/v1/collector-distributions`). The editor's toolbar, the create dialog
 * and the list read it; nothing writes it but `load`. Its strings (labels,
 * descriptions, notes) are the catalogue's, public data, never anything a
 * person typed (ADR 0024).
 *
 * A module singleton, as the user store is: it is written only from effects
 * (`useCollectorDistributions`), which never run on the server, so a server
 * render never reads or writes it.
 */
export const useCollectorCatalogueStore = create<CollectorCatalogueState>()((set, get) => ({
  ...NOT_READ,
  load: async () => {
    const { status } = get();
    if (status === "loading" || status === "loaded") return;
    set({ status: "loading" });
    try {
      const { distributions } = await getCollectorDistributions();
      set({ distributions, status: "loaded" });
    } catch {
      // The pickers fall back (the pin as text; the create dialog without a
      // choice, the server's default); the next page asks again.
      set({ status: "failed" });
    }
  },
}));

/** Forgets the catalogue, for tests: the next `load` reads it again. */
export function resetCollectorCatalogue(): void {
  useCollectorCatalogueStore.setState(NOT_READ);
}

/** The catalogue as a component reads it: the distributions (null until read), and whether the read failed. */
export interface CollectorCatalogue {
  distributions: CollectorDistribution[] | null;
  failed: boolean;
}

/**
 * The collector catalogue, read when the component mounts, or when `active`
 * becomes true (the create dialog's opening, which asks again after a
 * failure). Every caller shares the one read.
 *
 * Inside the playground (D31-1 decision 11, Ruling 277) it is the catalogue
 * the web was built with (`PLAYGROUND_CATALOGUE`, from the context), and
 * nothing is read: the playground makes no catalogue request.
 */
export function useCollectorDistributions(active = true): CollectorCatalogue {
  const playground = usePlayground();
  const distributions = useCollectorCatalogueStore((state) => state.distributions);
  const failed = useCollectorCatalogueStore((state) => state.status === "failed");
  const inPlayground = playground !== null;
  useEffect(() => {
    if (active && !inPlayground) void useCollectorCatalogueStore.getState().load();
  }, [active, inPlayground]);
  if (playground !== null) return { distributions: playground.catalogue, failed: false };
  return { distributions, failed };
}

/** A distribution of the catalogue by its id; undefined while the catalogue is unread, or for one it doesn't list. */
export function findDistribution(
  distributions: readonly CollectorDistribution[] | null,
  distributionId: string | null | undefined,
): CollectorDistribution | undefined {
  if (distributions === null || distributionId == null) return undefined;
  return distributions.find((distribution) => distribution.id === distributionId);
}

/**
 * The components a distribution's version supports (D13a decision 6), for
 * the toolbox: the catalogue's `supportedComponents`, null for every
 * component. Null too whenever the catalogue can't say: unread (or its read
 * failed), a distribution it doesn't list, or a version it no longer offers
 * (a deprecated pin), so the toolbox never hides a component for want of
 * the catalogue.
 */
export function findSupportedComponents(
  distributions: readonly CollectorDistribution[] | null,
  distributionId: string | null | undefined,
  version: string | null | undefined,
): CollectorSupportedComponents | null {
  const distribution = findDistribution(distributions, distributionId);
  return distribution?.versions.find((offer) => offer.version === version)?.supportedComponents ?? null;
}
