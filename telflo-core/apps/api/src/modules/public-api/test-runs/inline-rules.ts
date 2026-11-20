import { randomUUID } from "node:crypto";
import type { TestRunSignal, ValidationRuleSnapshot } from "@telflo/contracts";
import type { Actor } from "../../organizations/service.js";
import type { CreateRuleInput, IValidationRuleCheck } from "../../validation-pipelines/service.js";

/*
 * A public test run's inline rules: checked as the public surface checks a
 * batch of new rules (`checkNewRules`: every OTTL context, then every OTTL
 * condition that can't fail or pass, both before anything is spent; then
 * one `validationRuleChecksPerUser` admission per regex or OTTL rule,
 * reserved all at once; then the OTTL evaluator for each in order), then
 * given fresh ids and positions as the run's snapshot, used once, never
 * saved.
 *
 * Nothing here logs: the rule check logs ids, a rule's kind and the
 * outcome only. A rule's text reaches the reply's body alone.
 */

/**
 * The run's rules, checked, as the snapshot its row takes: fresh ids,
 * positions from 1 in the request's order, the content as stored (an OTTL
 * rule's OTTL and no pattern, or a pattern and no OTTL), the name and
 * description as parsed.
 */
export async function checkedInlineRules(
  check: IValidationRuleCheck,
  actor: Actor,
  signal: TestRunSignal,
  rules: readonly CreateRuleInput[],
  ids: Record<string, string>,
): Promise<ValidationRuleSnapshot[]> {
  const contents = await check.checkNewRules(actor, signal, rules, ids);
  return rules.map((rule, index) => {
    const content = contents[index]!;
    return {
      id: randomUUID(),
      position: index + 1,
      kind: content.kind,
      target: content.target,
      pattern: content.pattern,
      ottl: content.ottl,
      name: rule.name,
      description: rule.description,
    };
  });
}
