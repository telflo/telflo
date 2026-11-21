/**
 * A 400 `invalid_request` detail's path ("ottl.condition", "label"), as the
 * API's envelope carries a Zod issue: its own `path`, its `params.issue`'s
 * (fastify-type-provider-zod's shape, and the fleet routes' own details,
 * `modules/fleets/errors.ts`), or its JSON pointer (`instancePath`). Undefined
 * when it names none. Lifted from `RuleEditorDialog.tsx` for the fleet
 * dialogs.
 */
export function issuePathOf(issue: object): string | undefined {
  const segments = (path: unknown): string | undefined =>
    Array.isArray(path) && path.length > 0 && path.every((each) => typeof each === "string" || typeof each === "number")
      ? path.join(".")
      : undefined;
  if ("path" in issue) return segments(issue.path);
  if ("params" in issue && typeof issue.params === "object" && issue.params !== null && "issue" in issue.params) {
    const inner = issue.params.issue;
    if (typeof inner === "object" && inner !== null && "path" in inner) return segments(inner.path);
  }
  if ("instancePath" in issue && typeof issue.instancePath === "string") {
    return segments(issue.instancePath.split("/").filter((each) => each !== ""));
  }
  return undefined;
}
