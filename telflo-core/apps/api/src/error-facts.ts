/**
 * An error as a log line may name it: its name, code and syscall, never its
 * message, which can name a path or quote a request (D14a Rulings 25 and
 * 42). The background loops (the dispatcher, the reaper, the tester's
 * health monitor) log through it.
 */
export function errorFacts(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== "object") return { error: typeof error };
  const { name, code, syscall } = error as { name?: unknown; code?: unknown; syscall?: unknown };
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof syscall === "string" ? { syscall } : {}),
  };
}
