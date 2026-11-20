/*
 * A heuristic guard against assertion rules that can never fail.
 *
 * Seen live: an agent saved `resource.attributes["k8s.cluster.name"] == nil
 * or resource.attributes["k8s.cluster.name"] != nil` (quantifier `any`)
 * under the name "resource remains present": a condition that only fails
 * on an empty output, dressed up as a metadata check. A rule that can't
 * fail asserts nothing, so it biases a suite toward green.
 *
 * The guard is an assertion's (an inline test-run rule's), NOT the general
 * OTTL lint's: `true` is legitimate in transform and filter statements and
 * in a count rule (the total-count control).
 *
 * A condition over TAUTOLOGY_MAXIMUM_LENGTH characters, as written, isn't
 * checked at all (null). The shape patterns' lazy groups and
 * back-references backtrack, about half a second on 8,192 characters of
 * `a == b or …`, and the normalizing strips nested parentheses in quadratic
 * time (the cap comes before both); either would hold the API's one thread.
 * A tautology is a short condition.
 */

/** The longest condition, as written, the check looks at. */
export const TAUTOLOGY_MAXIMUM_LENGTH = 1_024;

const WHITESPACE = /\s+/g;

/** `X == Y or X != Y`: complementary operators over the same operands are true for every record. */
const COMPLEMENT = /^(?<lhs>.+?)\s*(?<op1>==|!=)\s*(?<rhs>.+?)\s+or\s+\k<lhs>\s*(?<op2>==|!=)\s*\k<rhs>$/;

/** `X == X` is always true; `X != X` always false. */
const SELF_COMPARE = /^(?<x>.+?)\s*(?<op>==|!=)\s*\k<x>$/;

const alwaysTrue = (shape: string) =>
  `condition of the form ${shape} is always true — the rule asserts nothing ` +
  "about the data, whatever its name claims. Assert the actual expected " +
  "state; if you only mean 'records are present', use condition 'true' " +
  "with quantifier 'count' (gte 1) and name the rule as a smoke check";

const neverFails = (shape: string, quantifier: string) =>
  `condition ${shape} with quantifier '${quantifier}' can never fail — ` +
  "assert the actual expected state, or use quantifier 'count' for a " +
  "record-count control";

const neverPasses = (shape: string, quantifier: string) =>
  `condition ${shape} is always false with quantifier '${quantifier}' — the ` +
  "rule can never pass; assert the actual expected state";

/** Collapses whitespace and strips fully enclosing parentheses. */
function normalize(condition: string): string {
  let text = condition.trim().replace(WHITESPACE, " ");
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let enclosing = true;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index !== text.length - 1) {
          enclosing = false;
          break;
        }
      }
    }
    if (!enclosing) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Why the (condition, quantifier) pair makes a rule that can't fail (or
 * can't pass), in words for the person or agent that wrote it, or null.
 */
export function findTautology(condition: string, quantifier: string): string | null {
  if (condition.length > TAUTOLOGY_MAXIMUM_LENGTH) return null;
  const text = normalize(condition);

  if (text === "true") {
    // Legitimate as the total-count control (count) and as an explicit
    // emptiness (none) or non-emptiness (any) check: both can fail.
    return quantifier === "all" ? neverFails("'true'", "all") : null;
  }

  if (text === "false") {
    return quantifier === "none" ? neverFails("'false'", "none") : neverPasses("'false'", quantifier);
  }

  const complement = COMPLEMENT.exec(text)?.groups;
  if (complement !== undefined && complement.op1 !== complement.op2) {
    return alwaysTrue(`'X ${complement.op1} Y or X ${complement.op2} Y'`);
  }

  const self = SELF_COMPARE.exec(text)?.groups;
  if (self !== undefined) {
    if (self.op === "==") return alwaysTrue("'X == X'");
    if (quantifier === "none") return neverFails("of the form 'X != X'", "none");
    return neverPasses("of the form 'X != X'", quantifier);
  }

  return null;
}
