import {
  isBlankRuleText,
  OTTL_CONTEXTS_BY_SIGNAL,
  ruleTextTooLongMessage,
  trimRuleText,
  utf8ByteLength,
  VALIDATION_RULE_COUNT_MAXIMUM,
  VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH,
  VALIDATION_RULE_NAME_MAXIMUM_LENGTH,
  VALIDATION_RULE_TEXT_MAXIMUM_BYTES,
  type CreateValidationRuleRequest,
  type OttlContext,
  type OttlCountOperator,
  type OttlQuantifier,
  type ValidationPipeline,
  type ValidationRule,
  type ValidationRuleCount,
  type ValidationRuleKind,
  type ValidationRuleOttl,
  type ValidationRuleTarget,
} from "@telflo/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import { ApiError } from "~/lib/api-client.js";
import { issuePathOf } from "~/lib/issue-path.js";
import type { RunTarget } from "~/lib/stores/testing-store.js";
import { isAlreadyGone, useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import {
  buildAttributeCondition,
  escapeOttlString,
  recognizeBuilderRule,
  recordContextForSignal,
  type AttributeOperator,
  type AttributeScope,
} from "./rule-builder-shapes.js";

interface RuleEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the rule is (or will be) on. */
  target: RunTarget;
  /** The rule's validation pipeline: its signal chooses the OTTL contexts and the builders' record context. */
  validationPipeline: ValidationPipeline;
  /** The rule to edit; null to add one. */
  rule: ValidationRule | null;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): its opener's. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /**
   * The rule a new one starts from (Compare's "Create an OTTL rule"): OTTL
   * condition mode with this context, Require and Condition, Name and
   * Description empty; null or absent for the blank form. Ignored when editing
   * (`rule`). Made once per opening, its identity kept while the dialog is
   * open: a new one resets the form.
   */
  initial?: RulePrefill | null | undefined;
  /** The rule saved, with the API's answer: called inside the dialog's session (an answer after Escape calls nothing), just before it closes. */
  onSaved?: ((saved: ValidationRule) => void) | undefined;
}

/** A new rule's start (`RuleEditorDialog`'s `initial`): OTTL condition mode, its context, Require and Condition. */
export interface RulePrefill {
  context: OttlContext;
  quantifier: Extract<OttlQuantifier, "all" | "none">;
  condition: string;
}

// The editor switches body based on this top-level mode. "match" is a text
// or regex rule (contains or not); the builder modes save canonical OTTL;
// "ottl" covers conditions and (via the distinct quantifier) cardinality.
type EditorMode = "match" | "record_count" | "record_attribute" | "ottl";

type Negation = "contains" | "not_contains";
type MatchType = "text" | "regex";

/** Record count's operators: the count control has no "ne" (a rule with one reopens in OTTL mode). */
type RecordCountOperator = Exclude<OttlCountOperator, "ne">;

function splitMatchKind(kind: ValidationRuleKind): { negation: Negation; matchType: MatchType } {
  if (kind === "ottl") return { negation: "not_contains", matchType: "text" };
  return {
    negation: kind.startsWith("not_") ? "not_contains" : "contains",
    matchType: kind.endsWith("regex") ? "regex" : "text",
  };
}

function combineMatchKind(negation: Negation, matchType: MatchType): ValidationRuleKind {
  return `${negation}_${matchType}`;
}

// One-line "what does this rule do" shown under the rule-type picker — an
// at-a-glance summary for every mode while the field-level hints below cover
// the details.
const MODE_DESCRIPTIONS: Record<EditorMode, string> = {
  match:
    "Sweep the pipeline output — or the collector log — for text or a regex, and pass when it's present (or absent). Field-agnostic: matches anywhere in the raw output, so it catches leaks in fields you didn't anticipate.",
  record_count:
    "Assert how many records came out of the pipeline — exactly, at least, at most, or within a range. A guided builder for the canonical OTTL count control.",
  record_attribute:
    "Check an attribute across the output records — all/any/none/count matching, or cap its distinct values. A guided builder that writes the OTTL rule for you; switch to OTTL mode for nested fields or composed conditions.",
  ottl: "Write an OTTL expression — the collector's own language — evaluated per record: require all, any, none, or a count of records to match a condition, or cap the number of DISTINCT values an expression takes (the cardinality guardrail). Supports and / or / not.",
};

/**
 * A form problem, and the field it is about: shown under the mode's fields,
 * tied to that field (aria-describedby); a quiet one (Match output text's
 * empty pattern) only holds Add rule.
 */
interface FieldProblem {
  field: string;
  message: string;
  quiet?: true;
}

/**
 * One of the API's problems with the rule (400 `validation_rule_invalid`,
 * or 400 `invalid_request`): the field it names, when it names one, as a
 * dotted path ("ottl.condition"), and its words.
 */
interface RuleProblem {
  field: string | undefined;
  message: string;
}

const NO_RULE_PROBLEMS: readonly RuleProblem[] = [];

/**
 * A refusal's problems: each of `details.problems`' `{field, message}` (the
 * evaluator's), else its message alone, about no field.
 */
function ruleProblemsOf(error: ApiError): readonly RuleProblem[] {
  const { details } = error;
  const listed = typeof details === "object" && details !== null && "problems" in details ? details.problems : undefined;
  const problems = Array.isArray(listed)
    ? listed.flatMap((each: unknown): RuleProblem[] => {
        if (typeof each !== "object" || each === null || !("message" in each) || typeof each.message !== "string") return [];
        return [{ field: "field" in each && typeof each.field === "string" ? each.field : undefined, message: each.message }];
      })
    : [];
  return problems.length > 0 ? problems : [{ field: undefined, message: error.message }];
}

/**
 * An unreadable rule's problems (400 `invalid_request`): each of `details`'
 * issues (the request schema's, Zod's: a text past 8,192 bytes, a context the
 * pipeline's signal hasn't) with the field its path names, else its message
 * alone, about no field.
 */
function invalidRequestProblemsOf(error: ApiError): readonly RuleProblem[] {
  const { details } = error;
  const problems = Array.isArray(details)
    ? details.flatMap((each: unknown): RuleProblem[] => {
        if (typeof each !== "object" || each === null || !("message" in each) || typeof each.message !== "string") return [];
        return [{ field: issuePathOf(each), message: each.message }];
      })
    : [];
  return problems.length > 0 ? problems : [{ field: undefined, message: error.message }];
}

/** Whether a pattern, condition or expression, as it is sent, is past the API's 8,192 bytes of UTF-8. */
const tooLong = (text: string) => utf8ByteLength(text) > VALIDATION_RULE_TEXT_MAXIMUM_BYTES;

/** A count field's text as an integer, or why it isn't one the API keeps: undefined when it is. */
function countProblem(text: string, words: { notInteger: string; negative: string; tooLarge: string }): string | undefined {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return words.notInteger;
  if (value < 0) return words.negative;
  if (value > VALIDATION_RULE_COUNT_MAXIMUM) return words.tooLarge;
  return undefined;
}

/** Between's bounds out of order (new: never saved so). */
const UNORDERED_BETWEEN_MESSAGE = "To can't be less than From";

/**
 * Adding and editing a rule: its four modes — Match output text, Record
 * count, Record attribute, OTTL condition — their fields, words, hints and
 * checks. Record count and Record attribute are builders saving canonical
 * OTTL (`rule-builder-shapes.ts`), and such a rule reopens in its builder;
 * any other OTTL opens in OTTL mode. OTTL is typed in plain textareas and
 * checked when saved.
 *
 * Differences:
 * - the API checks every OTTL and regex rule as it is saved, through the
 *   evaluator: its refusal, "OTTL syntax error: …" or "Invalid regex: …" (400
 *   `validation_rule_invalid`), shows as it words it, each problem under the
 *   field it names (`ruleProblemField`), tied to that field and announced, and
 *   the dialog keeps the text; "Rules can't be checked right now. Try again
 *   shortly." (503) and the rate limit's words (429) are toasted, the dialog
 *   kept open. There is no OTTL lint in the browser, and no browser `RegExp`
 *   check (JavaScript's, not RE2);
 * - the OTTL contexts are always the pipeline's signal's
 *   (OTTL_CONTEXTS_BY_SIGNAL): the signal comes with the pipeline, never all
 *   seven before the pipelines load;
 * - the form resets only as the dialog opens and when its rule changes, never
 *   when the pipelines load (never mid-edit when the signal arrives late);
 * - Record count refuses a negative count and an unordered Between, every
 *   count refuses one past 2,147,483,647 (the API's bound) and an empty one
 *   (never saved as 0), and each mode's
 *   counts keep Between's bounds in order;
 * - only the five kinds: no retired rule types, and no silent rewrite of one
 *   as a text rule of its JSON;
 * - Save sends the rule whole: a change sends its kind, target and pattern or
 *   OTTL with its name and description; an empty name or description is `''`,
 *   as the API keeps it, not null;
 * - the fields' ids come from `useId`; a form problem is tied to its field
 *   (`aria-describedby`, `aria-invalid`) and announced politely (a live
 *   region); closing gives the focus back to the opener (Edit, Add
 *   Validation Rule);
 * - a builder rule reopens in its builder only on the context that builder
 *   saves (`recognizeBuilderRule`), else in OTTL mode, its context kept: a
 *   builder would rewrite a `spanevent`, `metric` or counted `resource`
 *   rule's context silently;
 * - a blank text is Go's `unicode.IsSpace` (`isBlankRuleText`), as the API's
 *   (U+0085 too, which JavaScript's `trim` keeps), and a pattern, condition
 *   or expression is trimmed of exactly that whitespace (`trimRuleText`:
 *   JavaScript's `trim` would strip a U+FEFF the API keeps, and
 *   send `''` for a text the check let through); every field is disabled
 *   while a save is under way;
 * - a pattern, condition or expression past the API's 8,192 bytes of UTF-8
 *   (as the builder writes it, for Record attribute) is a form problem under
 *   its field, Add rule held, in the API's words ("The pattern is longer
 *   than 8,192 bytes."); an unreadable request's refusal (400
 *   `invalid_request`) shows inline as a rule's does, each issue under the
 *   field its path names (`ottl.condition`, `pattern`, `name`, …), else the
 *   mode's main field, never the generic toast; a change to the name or the
 *   description clears the API's problems under it, as a change to what the
 *   rule checks clears them all; Record attribute's too-long condition is
 *   under the key when the key alone makes it so, else under the value;
 * - a save's answer acts only on the dialog's session that sent it: one
 *   arriving after Escape, once the editor has opened again, or once the
 *   dialog has gone with its host (a version or organization left), closes
 *   nothing and shows nothing (the card's list shows what the store kept); a
 *   rule or pipeline a teammate deleted (404) toasts the API's words and
 *   closes the editor, the store dropping it, as a delete does, even when the
 *   drop takes the card, and the editor, away;
 * - a new rule can start from Compare's "Create an OTTL rule" (`initial`):
 *   OTTL condition mode, the run's signal's context, the chip's Require and
 *   Condition, Name and Description empty, never through the builders'
 *   recognition; its save is the ordinary one, and `onSaved` hears of it. In
 *   the playground the editor never opens: every opener is locked at its
 *   button;
 * - the dialog's content sits in `ph-no-capture` (a portal, outside the
 *   panel's block), its inputs also masked (`maskAllInputs`): a rule's text
 *   is configuration text.
 */
export function RuleEditorDialog({
  open,
  onOpenChange,
  target,
  validationPipeline,
  rule,
  onCloseAutoFocus,
  initial = null,
  onSaved,
}: RuleEditorDialogProps) {
  const signal = validationPipeline.signal;
  const contexts = OTTL_CONTEXTS_BY_SIGNAL[signal];
  const id = useId();
  const field = (name: string) => `${id}-${name}`;

  const [mode, setMode] = useState<EditorMode>("match");

  // ---- match mode state ----
  const [negation, setNegation] = useState<Negation>("not_contains");
  const [matchType, setMatchType] = useState<MatchType>("text");
  const [matchInput, setMatchInput] = useState("");
  // Which collector stream the match-mode rule reads from. Default "output";
  // "stderr" surfaces silent processor failures (drops, OTTL errors,
  // exporter rejections) that never appear in the OTLP output. Only for
  // match-mode rules: an OTTL rule checks the output only.
  const [matchTarget, setMatchTarget] = useState<ValidationRuleTarget>("output");

  // ---- record_count state ----
  const [countOperator, setCountOperator] = useState<RecordCountOperator>("gte");
  const [countValue, setCountValue] = useState("1");
  const [countValue2, setCountValue2] = useState("5");

  // ---- record_attribute (attribute builder) state. Emits an `ottl` rule;
  // the full Require quantifier set (incl. count/distinct) is available, and
  // the count spec reuses the ottlCount* state below. ----
  const [attrQuantifier, setAttrQuantifier] = useState<OttlQuantifier>("all");
  const [attrScope, setAttrScope] = useState<AttributeScope>("resource");
  const [attrKey, setAttrKey] = useState("");
  const [attrOperator, setAttrOperator] = useState<AttributeOperator>("exists");
  const [attrValue, setAttrValue] = useState("");

  // ---- ottl state ----
  const [ottlContext, setOttlContext] = useState<OttlContext>(recordContextForSignal(signal));
  const [ottlCondition, setOttlCondition] = useState("");
  // The distinct-quantifier value expression ("" for other quantifiers).
  const [ottlExpression, setOttlExpression] = useState("");
  const [ottlQuantifier, setOttlQuantifier] = useState<OttlQuantifier>("all");
  const [ottlCountOperator, setOttlCountOperator] = useState<OttlCountOperator>("eq");
  const [ottlCountValue, setOttlCountValue] = useState("1");
  const [ottlCountValue2, setOttlCountValue2] = useState("5");

  // ---- shared form state ----
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The API's refusal of the rule's OTTL or regex (400 validation_rule_invalid): its problems, in its words; cleared on any change of what the rule checks.
  const [ruleProblems, setRuleProblems] = useState<readonly RuleProblem[]>(NO_RULE_PROBLEMS);
  /**
   * The dialog's session: counted as it opens, closes, changes rule and
   * unmounts. A save's answer acts only on the session that sent it: one that
   * arrives after Escape, once the editor is open again (on another rule, or
   * Add), or once the dialog has gone with its host (a version or organization
   * left), closes nothing, shows nothing, toasts nothing and tells `onSaved`
   * nothing. The store keeps what the API answered all the same: an abandoned
   * save that succeeded shows in the card's list, one refused leaves it as it
   * was.
   */
  const session = useRef(0);

  // Reset only as the dialog opens and when its rule or its prefill changes:
  // never on a re-render (the pipelines reloading), which would lose what
  // was typed.
  useEffect(() => {
    session.current += 1;
    if (!open) return;
    const recordContext = recordContextForSignal(signal);
    // An ottl rule whose payload matches a builder-canonical shape, on the
    // context that builder saves, reopens in the friendly builder; anything
    // else opens in raw OTTL mode, its context kept.
    const ottl = rule?.kind === "ottl" ? rule.ottl : null;
    const recognized = ottl === null ? null : recognizeBuilderRule(ottl, signal);
    // A new rule from Compare opens in OTTL condition mode as it was offered,
    // never through the builders' recognition, which would put an `!= nil` or
    // `== "info"` condition in Record attribute.
    const prefill = rule === null ? initial : null;
    const nextMode: EditorMode =
      prefill !== null ? "ottl" : (recognized?.mode ?? (rule === null ? "match" : rule.kind === "ottl" ? "ottl" : "match"));
    setMode(nextMode);
    const split = splitMatchKind(rule?.kind ?? "not_contains_text");
    setNegation(split.negation);
    setMatchType(split.matchType);
    setMatchInput(nextMode === "match" ? (rule?.pattern ?? "") : "");
    setMatchTarget(nextMode === "match" ? (rule?.target ?? "output") : "output");
    if (recognized?.mode === "record_count") {
      setCountOperator(recognized.count.operator === "ne" ? "gte" : recognized.count.operator);
      setCountValue(String(recognized.count.value));
      setCountValue2(recognized.count.value2 !== undefined ? String(recognized.count.value2) : "5");
    } else {
      setCountOperator("gte");
      setCountValue("1");
      setCountValue2("5");
    }
    if (recognized?.mode === "record_attribute") {
      setAttrQuantifier(recognized.quantifier);
      setAttrScope(recognized.scope);
      setAttrKey(recognized.key);
      setAttrOperator(recognized.operator);
      setAttrValue(recognized.value);
    } else {
      setAttrQuantifier("all");
      setAttrScope("resource");
      setAttrKey("");
      setAttrOperator("exists");
      setAttrValue("");
    }
    if (nextMode === "ottl" && ottl !== null) {
      setOttlContext(ottl.context);
      setOttlCondition(ottl.condition ?? "");
      setOttlExpression(ottl.expression ?? "");
      setOttlQuantifier(ottl.quantifier);
      setOttlCountOperator(ottl.count?.operator ?? "eq");
      setOttlCountValue(ottl.count !== undefined ? String(ottl.count.value) : "1");
      setOttlCountValue2(ottl.count?.value2 !== undefined ? String(ottl.count.value2) : "5");
    } else if (prefill !== null) {
      setOttlContext(prefill.context);
      setOttlCondition(prefill.condition);
      setOttlExpression("");
      setOttlQuantifier(prefill.quantifier);
      setOttlCountOperator("eq");
      setOttlCountValue("1");
      setOttlCountValue2("5");
    } else {
      setOttlContext(recordContext);
      setOttlCondition("");
      setOttlExpression("");
      setOttlQuantifier("all");
      // The attribute builder's count spec reuses this state — populate it
      // from the recognized rule so count/distinct thresholds round-trip.
      const count = recognized?.mode === "record_attribute" ? recognized.count : undefined;
      setOttlCountOperator(count?.operator ?? "eq");
      setOttlCountValue(count !== undefined ? String(count.value) : "1");
      setOttlCountValue2(count?.value2 !== undefined ? String(count.value2) : "5");
    }
    setName(rule?.name ?? "");
    setDescription(rule?.description ?? "");
    setRuleProblems(NO_RULE_PROBLEMS);
    setSubmitting(false);
    // Only on opening and a change of rule or prefill (the signal is the pipeline's, fixed for the card's life).
  }, [open, rule, initial]);

  // Gone (its host unmounted: a version or organization left, its card
  // dropped): a save's answer arriving after acts on nothing, in every host:
  // no toast, no onSaved, no onOpenChange. The session moves a microtask after
  // the unmount, so the answer that itself took the dialog away (a "validation
  // pipeline not found" the store drops the card for, before it rethrows)
  // still toasts: its continuation is already queued as React commits the
  // store's change.
  useEffect(
    () => () => {
      queueMicrotask(() => {
        session.current += 1;
      });
    },
    [],
  );

  /** The name or the description changed: the API's problems about that field no longer apply; the others stay. */
  const forgetProblemsAbout = (apiField: "name" | "description") =>
    setRuleProblems((problems) => {
      const kept = problems.filter((problem) => problem.field !== apiField);
      return kept.length === problems.length ? problems : kept.length === 0 ? NO_RULE_PROBLEMS : kept;
    });

  // What the rule checks changed: the API's refusal of the old one no longer applies.
  useEffect(() => {
    setRuleProblems(NO_RULE_PROBLEMS);
  }, [
    mode,
    negation,
    matchType,
    matchInput,
    matchTarget,
    countOperator,
    countValue,
    countValue2,
    attrQuantifier,
    attrScope,
    attrKey,
    attrOperator,
    attrValue,
    ottlContext,
    ottlCondition,
    ottlExpression,
    ottlQuantifier,
    ottlCountOperator,
    ottlCountValue,
    ottlCountValue2,
  ]);

  const isRegex = matchType === "regex";

  // Record-attribute operators only valid against the OTLP attribute value's
  // type. We surface this in the editor by hiding the value box for `exists`
  // and labeling the value box "Number" for numeric ops. With quantifier
  // "distinct" the operator/value pair is hidden entirely — the rule counts
  // distinct values of the attribute itself.
  const attrIsDistinct = attrQuantifier === "distinct";
  const attrValueIsNumeric = attrOperator === "gt" || attrOperator === "lt" || attrOperator === "gte" || attrOperator === "lte";
  const attrValueRequired = !attrIsDistinct && attrOperator !== "exists";
  const attrHasCountSpec = attrQuantifier === "count" || attrIsDistinct;
  const ottlHasCountSpec = ottlQuantifier === "count" || ottlQuantifier === "distinct";

  /** A count spec's problem (the attribute builder's and OTTL mode's), with Between's order and the API's bound. */
  const countSpecProblem = (prefix: string): FieldProblem | null => {
    const first = countProblem(ottlCountValue, {
      notInteger: "Count must be a non-negative integer",
      negative: "Count must be a non-negative integer",
      tooLarge: "Count can't be more than 2,147,483,647",
    });
    if (first !== undefined) return { field: `${prefix}-count-value`, message: first };
    if (ottlCountOperator !== "between") return null;
    const second = countProblem(ottlCountValue2, {
      notInteger: "Second count must be a non-negative integer",
      negative: "Second count must be a non-negative integer",
      tooLarge: "Second count can't be more than 2,147,483,647",
    });
    if (second !== undefined) return { field: `${prefix}-count-value2`, message: second };
    if (Number(ottlCountValue2) < Number(ottlCountValue)) return { field: `${prefix}-count-value2`, message: UNORDERED_BETWEEN_MESSAGE };
    return null;
  };

  /** A count spec's as the API takes it (the attribute builder's and OTTL mode's). */
  const countSpec = (): ValidationRuleCount => {
    const count: ValidationRuleCount = { operator: ottlCountOperator, value: Number(ottlCountValue) };
    if (ottlCountOperator === "between") count.value2 = Number(ottlCountValue2);
    return count;
  };

  /**
   * Record attribute's OTTL: the canonical attribute shapes (see
   * buildAttributeCondition, kept in lockstep with recognizeBuilderShapes);
   * the key and value trimmed of Go's whitespace (`trimRuleText`).
   */
  const attributeOttl = (): ValidationRuleOttl => {
    const payload: ValidationRuleOttl = {
      context: attrScope === "resource" || attrScope === "scope" ? attrScope : recordContextForSignal(signal),
      quantifier: attrQuantifier,
    };
    if (attrIsDistinct) payload.expression = `attributes["${escapeOttlString(trimRuleText(attrKey))}"]`;
    else payload.condition = buildAttributeCondition(trimRuleText(attrKey), attrOperator, trimRuleText(attrValue));
    if (attrHasCountSpec) payload.count = countSpec();
    return payload;
  };

  // Pre-flight checks live here because the save handler needs to bail
  // before we hit the API.
  const matchModeError = useMemo((): FieldProblem | null => {
    if (mode !== "match") return null;
    if (isBlankRuleText(matchInput)) return { field: "rule-input", message: "Enter a value for the rule", quiet: true };
    if (tooLong(trimRuleText(matchInput))) return { field: "rule-input", message: ruleTextTooLongMessage("pattern") };
    return null;
  }, [mode, matchInput]);

  const countModeError = useMemo((): FieldProblem | null => {
    if (mode !== "record_count") return null;
    const first = countProblem(countValue, {
      notInteger: "Value must be an integer",
      negative: "Value can't be negative",
      tooLarge: "Value can't be more than 2,147,483,647",
    });
    if (first !== undefined) return { field: "count-value", message: first };
    if (countOperator === "between") {
      const second = countProblem(countValue2, {
        notInteger: "Value 2 must be an integer",
        negative: "Value 2 can't be negative",
        tooLarge: "Value 2 can't be more than 2,147,483,647",
      });
      if (second !== undefined) return { field: "count-value2", message: second };
      if (Number(countValue2) < Number(countValue)) return { field: "count-value2", message: UNORDERED_BETWEEN_MESSAGE };
    }
    return null;
  }, [mode, countOperator, countValue, countValue2]);

  const attrModeError = useMemo((): FieldProblem | null => {
    if (mode !== "record_attribute") return null;
    if (isBlankRuleText(attrKey)) return { field: "attr-key", message: "Attribute key is required" };
    if (trimRuleText(attrKey).startsWith("$")) {
      return { field: "attr-key", message: "JSONPath keys are no longer supported — write the assertion in OTTL mode instead" };
    }
    if (attrHasCountSpec) {
      const problem = countSpecProblem("attr");
      if (problem !== null) return problem;
    }
    if (attrValueRequired) {
      if (isBlankRuleText(attrValue)) return { field: "attr-value", message: "Value is required for this operator" };
      if (attrValueIsNumeric && !Number.isFinite(Number(attrValue))) {
        return { field: "attr-value", message: "Value must be a number for this operator" };
      }
    }
    // The OTTL the builder writes is held to the API's 8,192 bytes, under the field that makes it long:
    // the key when the condition is too long with no value at all, else the value.
    const ottl = attributeOttl();
    if (tooLong(ottl.expression ?? ottl.condition ?? "")) {
      const keyTooLong = !attrValueRequired || tooLong(buildAttributeCondition(trimRuleText(attrKey), attrOperator, ""));
      return {
        field: keyTooLong ? "attr-key" : "attr-value",
        message: ruleTextTooLongMessage(attrIsDistinct ? "expression" : "condition"),
      };
    }
    return null;
  }, [
    mode,
    attrKey,
    attrHasCountSpec,
    ottlCountOperator,
    ottlCountValue,
    ottlCountValue2,
    attrValueRequired,
    attrValueIsNumeric,
    attrValue,
    attrIsDistinct,
    attrOperator,
    attrScope,
    attrQuantifier,
  ]);

  const ottlModeError = useMemo((): FieldProblem | null => {
    if (mode !== "ottl") return null;
    if (ottlQuantifier === "distinct") {
      if (isBlankRuleText(ottlExpression)) return { field: "ottl-expression", message: "OTTL value expression is required" };
      if (tooLong(trimRuleText(ottlExpression))) return { field: "ottl-expression", message: ruleTextTooLongMessage("expression") };
    } else if (isBlankRuleText(ottlCondition)) {
      return { field: "ottl-condition", message: "OTTL condition is required" };
    }
    if (tooLong(trimRuleText(ottlCondition))) return { field: "ottl-condition", message: ruleTextTooLongMessage("condition") };
    if (ottlHasCountSpec) return countSpecProblem("ottl");
    return null;
  }, [mode, ottlCondition, ottlExpression, ottlQuantifier, ottlHasCountSpec, ottlCountOperator, ottlCountValue, ottlCountValue2]);

  const formError = matchModeError ?? countModeError ?? attrModeError ?? ottlModeError;

  /** The mode's main field: a problem naming no field, or one this mode doesn't show, is about it (the pattern, the condition, else the expression, the key, the count). */
  const mainField =
    mode === "match"
      ? "rule-input"
      : mode === "record_count"
        ? "count-value"
        : mode === "record_attribute"
          ? "attr-key"
          : ottlQuantifier === "distinct" && isBlankRuleText(ottlCondition)
            ? "ottl-expression"
            : "ottl-condition";

  /**
   * The field showing a problem the API names `apiField`. OTTL mode: each its
   * own (the condition, or a distinct rule's Row filter; the value
   * expression; the count's value, Between's second value; the context;
   * Require). Record count: the count's value, Between's second value (its
   * condition is "true"). Record attribute: the condition is the operator's
   * value where it has one (an unreadable number, a regex the parser
   * compiles; the key goes in quoted), else the key; a distinct rule's
   * expression is the key; the count's fields; the context is the scope's;
   * Require. Anything else: the main field.
   */
  const ruleProblemField = (apiField: string | undefined): string => {
    const countField = (prefix: string, shown: boolean, between: boolean): string | undefined =>
      !shown
        ? undefined
        : apiField === "ottl.count.value2" && between
          ? `${prefix}-value2`
          : apiField !== undefined && (apiField === "ottl.count" || apiField.startsWith("ottl.count."))
            ? `${prefix}-value`
            : undefined;
    // An unreadable request's name or description (400 invalid_request): under its own field, in every mode.
    if (apiField === "name") return "rule-name";
    if (apiField === "description") return "rule-description";
    switch (mode) {
      case "match":
        return "rule-input";
      case "record_count":
        return countField("count", true, countOperator === "between") ?? mainField;
      case "record_attribute":
        if (apiField === "ottl.condition" && attrValueRequired) return "attr-value";
        if (apiField === "ottl.context") return "attr-scope";
        if (apiField === "ottl.quantifier") return "attr-quantifier";
        return countField("attr-count", attrHasCountSpec, ottlCountOperator === "between") ?? mainField;
      case "ottl":
        if (apiField === "ottl.condition") return "ottl-condition";
        if (apiField === "ottl.expression" && ottlQuantifier === "distinct") return "ottl-expression";
        if (apiField === "ottl.context") return "ottl-context";
        if (apiField === "ottl.quantifier") return "ottl-quantifier";
        return countField("ottl-count", ottlHasCountSpec, ottlCountOperator === "between") ?? mainField;
    }
  };

  /** The API's problems shown under each field, with their ids: none while a form problem is shown (it comes first). */
  const ruleProblemsByField = new Map<string, { id: string; message: string }[]>();
  if (formError === null) {
    ruleProblems.forEach((problem, index) => {
      const name = ruleProblemField(problem.field);
      const shown = ruleProblemsByField.get(name) ?? [];
      shown.push({ id: field(`rule-error-${index}`), message: problem.message });
      ruleProblemsByField.set(name, shown);
    });
  }

  /** A field's tie to the API's problems about it: described by them, invalid while there are any. */
  const ruleErrorProps = (name: string) => {
    const shown = ruleProblemsByField.get(name);
    return shown === undefined ? {} : { "aria-describedby": shown.map((each) => each.id).join(" "), "aria-invalid": true as const };
  };

  /**
   * The form problem shown under the mode's fields (a quiet one isn't: Match
   * output text's empty pattern holds Add rule), in a polite live region
   * kept in place across the modes, so a problem that appears is announced;
   * tied to its field by aria-describedby.
   */
  const shownFormError = formError?.quiet === true ? null : formError;

  /** A field's accessibility props: tied to the form's problem about it, else to the API's, invalid while there is one. */
  const errorProps = (name: string) =>
    shownFormError?.field === name ? { "aria-describedby": field("form-error"), "aria-invalid": true as const } : ruleErrorProps(name);

  /** The API's problems about a field, under it, each an alert in the API's words. */
  const ruleErrorsUnder = (name: string) =>
    ruleProblemsByField.get(name)?.map((each) => (
      <p key={each.id} id={each.id} role="alert" className="text-xs text-fail">
        {each.message}
      </p>
    ));

  /** What the rule checks, as the API takes it: the kind, the target, and the pattern or the OTTL. */
  const content = (): Pick<CreateValidationRuleRequest, "kind" | "target" | "pattern" | "ottl"> => {
    if (mode === "match") {
      // Trimmed of Go's whitespace, as the API judges a blank: JavaScript's trim would strip U+FEFF and keep U+0085.
      return { kind: combineMatchKind(negation, matchType), target: matchTarget, pattern: trimRuleText(matchInput) };
    }
    if (mode === "record_count") {
      // Builder: a record-count total is the canonical ottl count control.
      const count: ValidationRuleCount = { operator: countOperator, value: Number(countValue) };
      if (countOperator === "between") count.value2 = Number(countValue2);
      return { kind: "ottl", target: "output", ottl: { context: recordContextForSignal(signal), condition: "true", quantifier: "count", count } };
    }
    if (mode === "record_attribute") return { kind: "ottl", target: "output", ottl: attributeOttl() };
    const payload: ValidationRuleOttl = { context: ottlContext, quantifier: ottlQuantifier };
    // Distinct: the condition is an optional row filter — omitted when blank, never sent as "".
    if (ottlQuantifier !== "distinct" || !isBlankRuleText(ottlCondition)) payload.condition = trimRuleText(ottlCondition);
    if (ottlQuantifier === "distinct") payload.expression = trimRuleText(ottlExpression);
    if (ottlHasCountSpec) payload.count = countSpec();
    return { kind: "ottl", target: "output", ottl: payload };
  };

  const handleSave = async () => {
    if (formError !== null || submitting) return;
    const request = { ...content(), name: name.trim(), description: description.trim() };
    // This session's: an answer for it after the dialog closed or opened again is ignored.
    const sent = session.current;
    setSubmitting(true);
    setRuleProblems(NO_RULE_PROBLEMS);
    try {
      const store = useValidationPipelinesStore.getState();
      const saved =
        rule !== null
          ? await store.updateRule(target, validationPipeline.id, rule.id, request)
          : await store.createRule(target, validationPipeline.id, request);
      if (session.current !== sent) return;
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      if (session.current !== sent) return;
      if (error instanceof ApiError && error.code === "validation_rule_invalid") {
        // The evaluator's words, as the API gives them ("OTTL syntax error: …", "Invalid regex: …"), each with the field it names.
        setRuleProblems(ruleProblemsOf(error));
      } else if (error instanceof ApiError && error.code === "invalid_request") {
        // The request's own refusal (a text past 8,192 bytes, a context the signal hasn't): its words, under the fields it names.
        setRuleProblems(invalidRequestProblemsOf(error));
      } else {
        const message = failureMessage(error, "Failed to save rule");
        if (message !== null) toast.error(message);
        // A teammate deleted the rule or its pipeline: the store has dropped it; nothing is left to save.
        if (isAlreadyGone(error)) onOpenChange(false);
      }
    } finally {
      if (session.current === sent) setSubmitting(false);
    }
  };

  const isEdit = rule !== null;

  const countOperatorItems = (
    <>
      <SelectItem value="eq">Exactly</SelectItem>
      <SelectItem value="ne">Not exactly</SelectItem>
      <SelectItem value="gte">At least</SelectItem>
      <SelectItem value="lte">At most</SelectItem>
      <SelectItem value="gt">More than</SelectItem>
      <SelectItem value="lt">Fewer than</SelectItem>
      <SelectItem value="between">Between</SelectItem>
    </>
  );

  const quantifierItems = (
    <>
      <SelectItem value="all">All records match</SelectItem>
      <SelectItem value="any">At least one matches</SelectItem>
      <SelectItem value="none">No record matches</SelectItem>
      <SelectItem value="count">Matching count…</SelectItem>
      <SelectItem value="distinct">Distinct values…</SelectItem>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md ph-no-capture"
        aria-describedby={undefined}
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit validation rule" : "Add validation rule"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={field("rule-mode")}>Rule type</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as EditorMode)} disabled={submitting}>
              <SelectTrigger id={field("rule-mode")} aria-describedby={field("mode-description")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="ph-no-capture">
                <SelectItem value="match">Match output text</SelectItem>
                <SelectItem value="record_count">Record count</SelectItem>
                <SelectItem value="record_attribute">Record attribute</SelectItem>
                <SelectItem value="ottl">OTTL condition</SelectItem>
              </SelectContent>
            </Select>
            <p id={field("mode-description")} className="text-xs text-muted-foreground">
              {MODE_DESCRIPTIONS[mode]}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={field("rule-name")}>Name</Label>
            <Input
              id={field("rule-name")}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                forgetProblemsAbout("name");
              }}
              placeholder="Optional — e.g. SSN leak guard"
              maxLength={VALIDATION_RULE_NAME_MAXIMUM_LENGTH}
              disabled={submitting}
              {...errorProps("rule-name")}
            />
            {ruleErrorsUnder("rule-name")}
          </div>

          {mode === "match" && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={field("rule-target")}>Read from</Label>
                <Select value={matchTarget} onValueChange={(value) => setMatchTarget(value as ValidationRuleTarget)} disabled={submitting}>
                  <SelectTrigger id={field("rule-target")} aria-describedby={field("target-hint")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="ph-no-capture">
                    <SelectItem value="output">Output (pipeline records)</SelectItem>
                    <SelectItem value="stderr">Stderr (collector log)</SelectItem>
                  </SelectContent>
                </Select>
                <p id={field("target-hint")} className="text-[11px] text-muted-foreground">
                  {matchTarget === "stderr"
                    ? "Reads the collector's diagnostic log — catches silent processor drops, OTTL parse errors, and exporter rejections that don't surface in pipeline output."
                    : "Reads the OTLP records that flowed through your pipeline. Default for new rules."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("rule-negation")}>Match</Label>
                  <Select value={negation} onValueChange={(value) => setNegation(value as Negation)} disabled={submitting}>
                    <SelectTrigger id={field("rule-negation")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">
                      <SelectItem value="contains">Contains</SelectItem>
                      <SelectItem value="not_contains">Does Not Contain</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("rule-match-type")}>Type</Label>
                  <Select value={matchType} onValueChange={(value) => setMatchType(value as MatchType)} disabled={submitting}>
                    <SelectTrigger id={field("rule-match-type")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="regex">Regex</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={field("rule-input")}>{isRegex ? "Regex pattern" : "Text"}</Label>
                <Input
                  id={field("rule-input")}
                  value={matchInput}
                  onChange={(event) => setMatchInput(event.target.value)}
                  disabled={submitting}
                  placeholder={isRegex ? "^error:.*" : "k8s.node.cpu.time"}
                  className="font-mono"
                  autoFocus
                  {...errorProps("rule-input")}
                />
                {ruleErrorsUnder("rule-input")}
              </div>
            </>
          )}

          {mode === "record_count" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("count-op")}>Operator</Label>
                  <Select value={countOperator} onValueChange={(value) => setCountOperator(value as RecordCountOperator)} disabled={submitting}>
                    <SelectTrigger id={field("count-op")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">
                      <SelectItem value="eq">Equals</SelectItem>
                      <SelectItem value="gte">At least</SelectItem>
                      <SelectItem value="lte">At most</SelectItem>
                      <SelectItem value="gt">Greater than</SelectItem>
                      <SelectItem value="lt">Less than</SelectItem>
                      <SelectItem value="between">Between</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("count-value")}>{countOperator === "between" ? "From" : "Value"}</Label>
                  <Input
                    id={field("count-value")}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={countValue}
                    onChange={(event) => setCountValue(event.target.value)}
                    disabled={submitting}
                    className="font-mono"
                    autoFocus
                    {...errorProps("count-value")}
                  />
                  {ruleErrorsUnder("count-value")}
                </div>
              </div>
              {countOperator === "between" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("count-value2")}>To</Label>
                  <Input
                    id={field("count-value2")}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={countValue2}
                    onChange={(event) => setCountValue2(event.target.value)}
                    disabled={submitting}
                    className="font-mono"
                    {...errorProps("count-value2")}
                  />
                  {ruleErrorsUnder("count-value2")}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Counts leaf records (datapoints, spans, or log records depending on the run's signal type). Saved as an OTTL rule —
                the mandatory total-count control.
              </p>
            </>
          )}

          {mode === "record_attribute" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("attr-quantifier")}>Require</Label>
                  <Select value={attrQuantifier} onValueChange={(value) => setAttrQuantifier(value as OttlQuantifier)} disabled={submitting}>
                    <SelectTrigger id={field("attr-quantifier")} {...errorProps("attr-quantifier")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">{quantifierItems}</SelectContent>
                  </Select>
                  {ruleErrorsUnder("attr-quantifier")}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("attr-scope")}>Scope</Label>
                  <Select value={attrScope} onValueChange={(value) => setAttrScope(value as AttributeScope)} disabled={submitting}>
                    <SelectTrigger id={field("attr-scope")} {...errorProps("attr-scope")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">
                      <SelectItem value="resource">Resource</SelectItem>
                      <SelectItem value="scope">Scope</SelectItem>
                      <SelectItem value="record">Record</SelectItem>
                    </SelectContent>
                  </Select>
                  {ruleErrorsUnder("attr-scope")}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={field("attr-key")}>Attribute key</Label>
                <Input
                  id={field("attr-key")}
                  value={attrKey}
                  onChange={(event) => setAttrKey(event.target.value)}
                  disabled={submitting}
                  placeholder="k8s.pod.name"
                  className="font-mono"
                  autoFocus
                  {...errorProps("attr-key")}
                />
                {ruleErrorsUnder("attr-key")}
              </div>
              {attrHasCountSpec && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={field("attr-count-op")}>{attrIsDistinct ? "Distinct count" : "Count"}</Label>
                    <Select value={ottlCountOperator} onValueChange={(value) => setOttlCountOperator(value as OttlCountOperator)} disabled={submitting}>
                      <SelectTrigger id={field("attr-count-op")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="ph-no-capture">{countOperatorItems}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={field("attr-count-value")}>{ottlCountOperator === "between" ? "From" : "Value"}</Label>
                    <Input
                      id={field("attr-count-value")}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={ottlCountValue}
                      onChange={(event) => setOttlCountValue(event.target.value)}
                      disabled={submitting}
                      className="font-mono"
                      {...errorProps("attr-count-value")}
                    />
                    {ruleErrorsUnder("attr-count-value")}
                  </div>
                </div>
              )}
              {attrHasCountSpec && ottlCountOperator === "between" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("attr-count-value2")}>To</Label>
                  <Input
                    id={field("attr-count-value2")}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={ottlCountValue2}
                    onChange={(event) => setOttlCountValue2(event.target.value)}
                    disabled={submitting}
                    className="font-mono"
                    {...errorProps("attr-count-value2")}
                  />
                  {ruleErrorsUnder("attr-count-value2")}
                </div>
              )}
              {!attrIsDistinct && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={field("attr-op")}>Operator</Label>
                    <Select value={attrOperator} onValueChange={(value) => setAttrOperator(value as AttributeOperator)} disabled={submitting}>
                      <SelectTrigger id={field("attr-op")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="ph-no-capture">
                        <SelectItem value="exists">Exists</SelectItem>
                        <SelectItem value="equals">Equals</SelectItem>
                        <SelectItem value="contains">Contains</SelectItem>
                        <SelectItem value="matches_regex">Matches regex</SelectItem>
                        <SelectItem value="gt">Greater than</SelectItem>
                        <SelectItem value="gte">At least</SelectItem>
                        <SelectItem value="lt">Less than</SelectItem>
                        <SelectItem value="lte">At most</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {attrValueRequired && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={field("attr-value")}>{attrValueIsNumeric ? "Number" : "Value"}</Label>
                      <Input
                        id={field("attr-value")}
                        type={attrValueIsNumeric ? "number" : "text"}
                        {...(attrValueIsNumeric ? { inputMode: "numeric" as const } : {})}
                        value={attrValue}
                        onChange={(event) => setAttrValue(event.target.value)}
                        disabled={submitting}
                        placeholder={attrOperator === "matches_regex" ? "^web-pod-\\d+$" : attrValueIsNumeric ? "0" : "telflo-e2e"}
                        className="font-mono"
                        {...errorProps("attr-value")}
                      />
                      {ruleErrorsUnder("attr-value")}
                    </div>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {attrIsDistinct
                  ? `Counts the DISTINCT values this attribute takes across ${attrScope}-level elements — the cardinality guardrail. Saved as an OTTL rule.`
                  : `Walks every ${attrScope}-level element in the OTLP output and applies the operator. Saved as an OTTL rule — for nested fields or composed conditions, switch to OTTL mode.`}
              </p>
            </>
          )}

          {mode === "ottl" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("ottl-context")}>Context</Label>
                  <Select value={ottlContext} onValueChange={(value) => setOttlContext(value as OttlContext)} disabled={submitting}>
                    <SelectTrigger id={field("ottl-context")} {...errorProps("ottl-context")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">
                      {contexts.map((context) => (
                        <SelectItem key={context} value={context}>
                          {context}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {ruleErrorsUnder("ottl-context")}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("ottl-quantifier")}>Require</Label>
                  <Select value={ottlQuantifier} onValueChange={(value) => setOttlQuantifier(value as OttlQuantifier)} disabled={submitting}>
                    <SelectTrigger id={field("ottl-quantifier")} {...errorProps("ottl-quantifier")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="ph-no-capture">{quantifierItems}</SelectContent>
                  </Select>
                  {ruleErrorsUnder("ottl-quantifier")}
                </div>
              </div>
              {ottlHasCountSpec && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={field("ottl-count-op")}>Operator</Label>
                    <Select value={ottlCountOperator} onValueChange={(value) => setOttlCountOperator(value as OttlCountOperator)} disabled={submitting}>
                      <SelectTrigger id={field("ottl-count-op")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="ph-no-capture">{countOperatorItems}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={field("ottl-count-value")}>
                      {ottlCountOperator === "between" ? "From" : ottlQuantifier === "distinct" ? "Distinct values" : "Count"}
                    </Label>
                    <Input
                      id={field("ottl-count-value")}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={ottlCountValue}
                      onChange={(event) => setOttlCountValue(event.target.value)}
                      disabled={submitting}
                      className="font-mono"
                      {...errorProps("ottl-count-value")}
                    />
                    {ruleErrorsUnder("ottl-count-value")}
                  </div>
                </div>
              )}
              {ottlHasCountSpec && ottlCountOperator === "between" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("ottl-count-value2")}>To</Label>
                  <Input
                    id={field("ottl-count-value2")}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={ottlCountValue2}
                    onChange={(event) => setOttlCountValue2(event.target.value)}
                    disabled={submitting}
                    className="font-mono"
                    {...errorProps("ottl-count-value2")}
                  />
                  {ruleErrorsUnder("ottl-count-value2")}
                </div>
              )}
              {ottlQuantifier === "distinct" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={field("ottl-expression")}>Value expression</Label>
                  <Textarea
                    id={field("ottl-expression")}
                    value={ottlExpression}
                    onChange={(event) => setOttlExpression(event.target.value)}
                    disabled={submitting}
                    placeholder={'attributes["http.route"]'}
                    className="font-mono text-xs"
                    rows={2}
                    autoFocus
                    {...errorProps("ottl-expression")}
                  />
                  {ruleErrorsUnder("ottl-expression")}
                  <p className="text-xs text-muted-foreground">
                    Evaluated once per {ottlContext}; the DISTINCT non-nil values are counted and compared to the threshold. Combine
                    attributes into one key with{" "}
                    <span className="font-mono">Concat([attributes[&quot;a&quot;], attributes[&quot;b&quot;]], &quot;|&quot;)</span>.
                    Tip: <span className="font-mono">At most 0</span> asserts the value never appears — the cheapest guard against a
                    high-cardinality attribute landing on your metrics.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor={field("ottl-condition")}>{ottlQuantifier === "distinct" ? "Row filter (optional)" : "OTTL condition"}</Label>
                <Textarea
                  id={field("ottl-condition")}
                  value={ottlCondition}
                  onChange={(event) => setOttlCondition(event.target.value)}
                  disabled={submitting}
                  placeholder={
                    ottlQuantifier === "distinct"
                      ? 'metric.name == "http.server.duration"'
                      : 'attributes["http.status_code"] >= 500 and IsMatch(name, "POST.*")'
                  }
                  className="font-mono text-xs"
                  rows={ottlQuantifier === "distinct" ? 2 : 4}
                  autoFocus={ottlQuantifier !== "distinct"}
                  {...errorProps("ottl-condition")}
                />
                {ruleErrorsUnder("ottl-condition")}
                <p className="text-xs text-muted-foreground">
                  {ottlQuantifier === "distinct" ? (
                    <>
                      Only records matching this boolean condition contribute values. Leave blank to count across every {ottlContext}.
                    </>
                  ) : (
                    <>
                      A boolean expression in the collector's OTTL language, evaluated once per {ottlContext}. Combine predicates with{" "}
                      <span className="font-mono">and</span> / <span className="font-mono">or</span> /{" "}
                      <span className="font-mono">not</span> — e.g.{" "}
                      <span className="font-mono">attributes[&quot;env&quot;] == &quot;prod&quot;</span>.
                    </>
                  )}
                </p>
              </div>
            </>
          )}

          {/* Kept in place while empty (an announcement needs a live region already there):
              its -mt-4 takes back the column's gap, the problem's pt-4 gives it back. */}
          <div aria-live="polite" aria-atomic="true" className="-mt-4">
            {shownFormError !== null && (
              <p id={field("form-error")} className="pt-4 text-xs text-fail">
                {shownFormError.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={field("rule-description")}>Description</Label>
            <Textarea
              id={field("rule-description")}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                forgetProblemsAbout("description");
              }}
              placeholder="Optional — what this rule checks for"
              rows={3}
              maxLength={VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH}
              disabled={submitting}
              {...errorProps("rule-description")}
            />
            {ruleErrorsUnder("rule-description")}
          </div>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={submitting || formError !== null}
            className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
          >
            {submitting ? "Saving..." : isEdit ? "Save" : "Add rule"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
