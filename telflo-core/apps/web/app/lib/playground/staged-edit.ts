import { CreateConfigurationRequestSchema } from "@telflo/contracts";
import { createRequestFor, type ConfigurationContent } from "~/lib/flows/instantiate-flow.js";
import type { StoredGraph } from "~/lib/graph/stored-graph.js";
import { STAGED_EDIT_KEY, clearStagedEdit } from "./staged-edit-key.js";

/*
 * The playground's staged edit (D31-1 decisions 4 and 36, Preflight ruling
 * 4): what Save in the playground editor (and the blank public editor)
 * keeps for after the visitor signs in or registers, in this browser's
 * localStorage (registration's email link may open another tab). One key,
 * written only by Save (`stagePlaygroundEdit`), replaced by the next Save,
 * read only by the signed-in configurations page's handoff dialog (D31-1's
 * Task 5; `readStagedEdit`), removed by its Save or Discard
 * (`clearStagedEdit`) and by every sign-out (`lib/signed-out.ts`, Q211),
 * and ignored and removed when older than 7 days,
 * unreadable, or refused by the create's own schema
 * (`CreateConfigurationRequestSchema`). It never leaves the browser until
 * the person presses Save in that dialog.
 *
 * It holds the visitor's text (configuration text, ADR 0024): it is the one
 * storage entry the spec names for it, and nothing here logs it, puts it in
 * an error's message, or prints it.
 */

// The one key and its removal live in staged-edit-key.ts (the sign-out clean-up needs only them).
export { STAGED_EDIT_KEY, clearStagedEdit };

/** How long a staged edit is kept: older, it is ignored and removed. */
export const STAGED_EDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The stored value: format 1, when it was saved, and the configuration's name, text, graph and pin. */
export interface StagedEdit {
  version: 1;
  /** When Save staged it (an ISO date). */
  savedAt: string;
  name: string;
  yamlContent: string;
  /** The graph as the editor's save stores it (`toStored`). */
  nodes: StoredGraph["nodes"];
  edges: StoredGraph["edges"];
  pipelines: StoredGraph["pipelines"];
  collectorDistribution: string;
  collectorVersion: string;
}

/** What Save stages: the edit without its format and date. */
export type StagedContent = Omit<StagedEdit, "version" | "savedAt">;

/** Staged; refused, since the create's schema would refuse it (too large, or a character a configuration can't hold); or not kept, since storage can't be written. */
export type StageResult = "staged" | "refused" | "unavailable";

/** The create's content for a staged edit: no description, no flow's slug. */
function contentOf(edit: StagedContent): ConfigurationContent {
  return {
    name: edit.name,
    description: "",
    yamlContent: edit.yamlContent,
    graph: { nodes: edit.nodes, edges: edit.edges, pipelines: edit.pipelines },
    collectorDistribution: edit.collectorDistribution,
    collectorVersion: edit.collectorVersion,
  };
}

/** Whether the create's schema takes `edit` as it is. */
function isCreatable(edit: StagedContent): boolean {
  return CreateConfigurationRequestSchema.safeParse(createRequestFor(contentOf(edit))).success;
}

/**
 * Stages `content`, replacing any edit staged before, saved now. Refused,
 * with nothing written, when the create's schema wouldn't take it, so the
 * visitor hears of it before signing in, never after.
 */
export function stagePlaygroundEdit(content: StagedContent, now: number = Date.now()): StageResult {
  if (!isCreatable(content)) return "refused";
  const edit: StagedEdit = { version: 1, savedAt: new Date(now).toISOString(), ...content };
  try {
    window.localStorage.setItem(STAGED_EDIT_KEY, JSON.stringify(edit));
    return "staged";
  } catch {
    return "unavailable";
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** `value` as a staged edit when it has the stored format's shape, else null. */
function asStagedEdit(value: unknown): StagedEdit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const edit = value as Record<string, unknown>;
  const keys = Object.keys(edit).sort().join(",");
  const expected = "collectorDistribution,collectorVersion,edges,name,nodes,pipelines,savedAt,version,yamlContent";
  if (keys !== expected || edit["version"] !== 1) return null;
  if (![edit["savedAt"], edit["name"], edit["yamlContent"], edit["collectorDistribution"], edit["collectorVersion"]].every(isString)) return null;
  if (![edit["nodes"], edit["edges"], edit["pipelines"]].every(Array.isArray)) return null;
  return edit as unknown as StagedEdit;
}

/** A staged edit as the handoff reads it: the edit, and the create's content it gives. */
export interface ReadStagedEdit {
  edit: StagedEdit;
  /** The create's content: the name (the dialog may change it), the text, the graph and the pin. */
  content: ConfigurationContent;
}

/**
 * The staged edit, or null when there is none. One older than 7 days (or
 * dated in the future, or undated), one that can't be read, one not in the
 * stored format, and one the create's schema refuses are each ignored and
 * removed.
 */
export function readStagedEdit(now: number = Date.now()): ReadStagedEdit | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STAGED_EDIT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearStagedEdit();
    return null;
  }
  const edit = asStagedEdit(parsed);
  const savedAt = edit === null ? Number.NaN : Date.parse(edit.savedAt);
  if (edit === null || !Number.isFinite(savedAt) || savedAt > now || now - savedAt > STAGED_EDIT_MAX_AGE_MS || !isCreatable(edit)) {
    clearStagedEdit();
    return null;
  }
  return { edit, content: contentOf(edit) };
}

/** Whether an edit is staged and still readable, without reading it out (a boolean, for tests and the dialog's opening). */
export function hasStagedEdit(now: number = Date.now()): boolean {
  return readStagedEdit(now) !== null;
}
