import {
  Activity,
  ArrowRightLeft,
  Box,
  Bug,
  ChartBar,
  Cloud,
  CloudCog,
  CloudDownload,
  CloudUpload,
  Combine,
  Container,
  CopyMinus,
  Database,
  FileOutput,
  FileText,
  Filter,
  Forward,
  Gauge,
  GitBranch,
  Globe,
  Group,
  HardDrive,
  HeartPulse,
  KeyRound,
  LifeBuoy,
  Network,
  Package,
  PanelTop,
  PenLine,
  Percent,
  Radar,
  RadioTower,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  Split,
  Tag,
  Tags,
  Terminal,
  TrendingUp,
  Wand2,
  Zap,
} from "lucide-react";
import type { ComponentType as ReactComponentType } from "react";

import { ClickStackIcon } from "./icons/ClickStackIcon.js";
import { DatadogIcon } from "./icons/DatadogIcon.js";
import { KubernetesIcon } from "./icons/KubernetesIcon.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import type { ComponentType } from "~/lib/graph/types.js";

/*
 * The one icon map: the canvas's nodes, the toolbox and the Configuration
 * tab all take a component's icon from here, so a component shows the same
 * icon everywhere (never another icon on the canvas).
 *
 * A few ecosystem components keep a vendor mark (Kubernetes, Datadog,
 * ClickStack; their provenance is beside their paths and in
 * docs/third-party-assets.md); everything else is the palette entry's lucide
 * icon, imported by name. All render monochrome, tinted in the component
 * type's color.
 */

/** Lucide icons take a stroke width; the vendor marks ignore it. */
export type ComponentIcon = ReactComponentType<{ className?: string; strokeWidth?: number }>;

/** The vendor marks, by the palette's subtype. */
export const VENDOR_MARKS: Readonly<Record<string, ComponentIcon>> = {
  k8s_cluster: KubernetesIcon,
  k8s_events: KubernetesIcon,
  k8sobjects: KubernetesIcon,
  kubeletstats: KubernetesIcon,
  k8sattributes: KubernetesIcon,
  datadog: DatadogIcon,
  clickhouse: ClickStackIcon,
};

/**
 * The palette's lucide icons, by the names its entries give
 * (`lib/graph/palette.ts`); the entries a vendor mark replaces (`Dog`,
 * `Hexagon`) are left out.
 */
export const LUCIDE_ICONS: Readonly<Record<string, ComponentIcon>> = {
  Activity,
  ArrowRightLeft,
  Bug,
  ChartBar,
  Cloud,
  CloudCog,
  CloudDownload,
  CloudUpload,
  Combine,
  Container,
  CopyMinus,
  Database,
  FileOutput,
  FileText,
  Filter,
  Forward,
  Gauge,
  GitBranch,
  Globe,
  Group,
  HardDrive,
  HeartPulse,
  KeyRound,
  LifeBuoy,
  Network,
  Package,
  PanelTop,
  PenLine,
  Percent,
  Radar,
  RadioTower,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  Split,
  Tag,
  Tags,
  Terminal,
  TrendingUp,
  Wand2,
  Zap,
};

/**
 * A component outside the palette (one the text names that the palette
 * doesn't have, such as `count`): the canvas fallback for its type.
 */
const TYPE_FALLBACKS: Readonly<Record<ComponentType, ComponentIcon>> = {
  receiver: Database,
  processor: Package,
  exporter: Send,
  extension: HeartPulse,
  connector: ArrowRightLeft,
};

function isComponentType(type: string): type is ComponentType {
  return Object.hasOwn(TYPE_FALLBACKS, type);
}

/** A component's icon: its vendor mark, else its palette entry's icon, else its type's. */
export function componentIcon(type: string, subType: string): ComponentIcon {
  const mark = Object.hasOwn(VENDOR_MARKS, subType) ? VENDOR_MARKS[subType] : undefined;
  if (mark) return mark;
  if (!isComponentType(type)) return Box;
  const name = findPaletteEntry(type, subType)?.icon;
  const icon = name !== undefined && Object.hasOwn(LUCIDE_ICONS, name) ? LUCIDE_ICONS[name] : undefined;
  return icon ?? TYPE_FALLBACKS[type];
}

/** The type accent used by canvas rails, palette chips and the Configuration tab. */
export const nodeAccentVar: Readonly<Record<ComponentType, string>> = {
  receiver: "var(--color-node-receiver)",
  processor: "var(--color-node-processor)",
  exporter: "var(--color-node-exporter)",
  extension: "var(--color-node-extension)",
  connector: "var(--color-node-connector)",
};
