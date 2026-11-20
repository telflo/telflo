import type { ValidationRule, ValidationRuleCount, ValidationRuleKind, ValidationRuleTarget } from "@telflo/contracts";

/*
 * Shared display helpers for validation rules, used by the rule list (the
 * Validation subtab's cards) and by the run's results grid, so the two
 * views stay consistent. Each map is typed
 * `Record<ValidationRuleKind, string>`, so a new kind is flagged wherever
 * it is missed.
 *
 * Differences: only the five kinds: the nine retired ones (the JSON match,
 * record count, record attribute, cardinality and the diff kinds), and
 * their summaries, aren't ported. A rule's OTTL is the contracts'
 * structured `ottl`, not a JSON string, so an unreadable payload can't
 * happen; and one display name serves a rule and a run's frozen copy of it
 * (`ValidationRuleSnapshot` has the same fields). The texts these return
 * are configuration text: shown as text inside `ph-no-capture`, never put
 * in an attribute outside it.
 */

/** What these helpers read of a rule, or of a run's copy of one. */
export type DisplayedRule = Pick<ValidationRule, "kind" | "target" | "pattern" | "ottl" | "name">;

/** Verb-style label used as a prefix in compact one-liners ("Contains: <input>", "OTTL: <input>"). */
export const CONDITION_LABELS: Record<ValidationRuleKind, string> = {
  contains_text: "Contains",
  not_contains_text: "Does not contain",
  contains_regex: "Contains",
  not_contains_regex: "Does not contain",
  ottl: "OTTL",
};

/**
 * Long-form label used in the rule details dialog. The stream the rule reads
 * from is folded into the label so users see "Stderr contains text" rather
 * than "Output contains text" for rules with target=stderr.
 */
const RULE_TYPE_LABELS_OUTPUT: Record<ValidationRuleKind, string> = {
  contains_text: "Output contains text",
  not_contains_text: "Output does not contain text",
  contains_regex: "Output contains regex",
  not_contains_regex: "Output does not contain regex",
  ottl: "OTTL condition assertion",
};

const RULE_TYPE_LABELS_STDERR: Partial<Record<ValidationRuleKind, string>> = {
  contains_text: "Stderr contains text",
  not_contains_text: "Stderr does not contain text",
  contains_regex: "Stderr contains regex",
  not_contains_regex: "Stderr does not contain regex",
};

/** The long-form label for a rule, taking its target into account; an OTTL rule (output only) keeps the output label. */
export function ruleTypeLabel(kind: ValidationRuleKind, target?: ValidationRuleTarget | null): string {
  if (target === "stderr") {
    return RULE_TYPE_LABELS_STDERR[kind] ?? RULE_TYPE_LABELS_OUTPUT[kind];
  }
  return RULE_TYPE_LABELS_OUTPUT[kind];
}

/** Label for the "Input" / "Regex" / "Condition" row in the details dialog: what the rule's input holds for each kind. */
export const INPUT_LABELS: Record<ValidationRuleKind, string> = {
  contains_text: "Input",
  not_contains_text: "Input",
  contains_regex: "Regex",
  not_contains_regex: "Regex",
  ottl: "Condition",
};

const COUNT_OPERATOR_VERBS: Record<ValidationRuleCount["operator"], string> = {
  eq: "exactly",
  ne: "not exactly",
  gt: "more than",
  lt: "fewer than",
  gte: "at least",
  lte: "at most",
  between: "between",
};

/** A count's bound: "5", or "1 and 5" for between. */
function countBound(count: ValidationRuleCount): string {
  return count.operator === "between" ? `${count.value} and ${count.value2 ?? "?"}` : `${count.value}`;
}

/**
 * A rule's input as a short human string: a text or regex rule's pattern as
 * it is; an OTTL rule's quantifier, context and condition ("all log:
 * attributes["env"] == "prod""), its count ("at least 1 log(s) where …"), or
 * its distinct values ("at most 50 distinct attributes["route"]").
 */
export function summarizeRule(rule: Pick<DisplayedRule, "kind" | "pattern" | "ottl">): string {
  if (rule.kind !== "ottl" || rule.ottl === null) return rule.pattern ?? "";
  const ottl = rule.ottl;
  if (ottl.quantifier === "distinct" && ottl.count) {
    const where = ottl.condition ? ` where ${ottl.condition}` : "";
    return `${COUNT_OPERATOR_VERBS[ottl.count.operator]} ${countBound(ottl.count)} distinct ${ottl.expression ?? ""}${where}`;
  }
  if (ottl.quantifier === "count" && ottl.count) {
    return `${COUNT_OPERATOR_VERBS[ottl.count.operator]} ${countBound(ottl.count)} ${ottl.context}(s) where ${ottl.condition ?? ""}`;
  }
  return `${ottl.quantifier} ${ottl.context}: ${ottl.condition ?? ""}`;
}

/** The rule's name when it has one, else its summary: what each row's hidden button names say ("Edit rule 2: <this>"). */
export function ruleNameOrSummary(rule: DisplayedRule): string {
  const trimmed = rule.name.trim();
  return trimmed !== "" ? trimmed : summarizeRule(rule);
}

/** Display name used in the rule list, and for a run's copy of a rule in its results: "Does not contain: SSN guard". */
export function ruleDisplayName(rule: DisplayedRule): string {
  return `${CONDITION_LABELS[rule.kind]}: ${ruleNameOrSummary(rule)}`;
}
