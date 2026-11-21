import type { CollectorComponentSection, CollectorSupportedComponents } from "@telflo/contracts";

import type { ComponentType } from "~/lib/graph/types.js";

/*
 * The distribution allowlist: the toolbox shows only the components a
 * distribution's version supports. A version's `supportedComponents` (the
 * catalog's) lists them by section, in the collector's names at that
 * version; null (Contrib) means every component, and the palette is
 * returned unchanged.
 *
 * Matching ignores case and underscores, so the palette's spellings match
 * the collector's renamed types (`filelog` and `file_log`, `hostmetrics` and
 * `host_metrics`: the collector keeps the old name as a `deprecated_type`;
 * the catalog's renames, `RENAMED_TYPES`). The one rename that differs by more
 * than that is the OTLP exporter's: the palette's `otlp` is the collector's
 * `otlp_grpc`. The receiver `otlp` is the collector's own name, so that
 * alias is the exporters' only. The validator (otelcol-validator's
 * `_component_supported`) applies the same rule.
 *
 * Pure logic: the caller reads the list from the catalog and passes it in.
 */

export type SupportedComponents = CollectorSupportedComponents;

const SECTION_BY_TYPE: Record<ComponentType, CollectorComponentSection> = {
  receiver: "receivers",
  processor: "processors",
  exporter: "exporters",
  connector: "connectors",
  extension: "extensions",
};

/** The comparison key: case and underscores ignored. */
function normalizeComponent(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

/** Whether `allowlist`'s `section` lists `componentId`, in any of its spellings. */
export function isComponentSupported(
  section: CollectorComponentSection,
  componentId: string,
  allowlist: SupportedComponents,
): boolean {
  const allowedSection = allowlist[section] ?? [];
  const normalizedAllowed = new Set(allowedSection.map(normalizeComponent));
  if (normalizedAllowed.has(normalizeComponent(componentId))) return true;
  // The OTLP exporter's rename: `otlp` is `otlp_grpc` (otlp -> otlpgrpc
  // differs by more than case and underscores). Exporters only.
  return section === "exporters" && componentId === "otlp" && allowedSection.includes("otlp_grpc");
}

/**
 * The palette entries `allowlist` supports, in the palette's order; the
 * palette itself (the same array) when `allowlist` is null (Contrib).
 */
export function filterPaletteByAllowlist<T extends { type: ComponentType; subType: string }>(
  palette: readonly T[],
  allowlist: SupportedComponents | null,
): readonly T[] {
  if (!allowlist) return palette;
  return palette.filter((item) => isComponentSupported(SECTION_BY_TYPE[item.type], item.subType, allowlist));
}
