/*
 * A stand-in `fetch` for the CLI's unit tests (D27 decision 32): every call recorded, each answered by the
 * test. Test support only: never built or packed. Recorded headers can hold
 * a token: tests check them with boolean canaries, never by printing them.
 */

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
  redirect: RequestInit["redirect"] | undefined;
  signal: AbortSignal | undefined;
}

/** A reply: JSON (`json`), text (`text`, `text/plain` unless headers say), or nothing. */
export interface Answer {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Answerer = (call: RecordedCall, index: number) => Answer | Response | Promise<Answer | Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

/** The envelope the API refuses with. */
export function envelope(code: string, message: string, details?: unknown): { error: Record<string, unknown> } {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function responseOf(answer: Answer): Response {
  const status = answer.status ?? 200;
  const nullBody = status === 204 || status === 304;
  if (answer.json !== undefined) {
    return new Response(nullBody ? null : JSON.stringify(answer.json), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...answer.headers },
    });
  }
  return new Response(nullBody ? null : (answer.text ?? ""), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...answer.headers },
  });
}

/** A fetch answering every call through `answerer`. */
export function fakeFetch(answerer: Answerer): FakeFetch {
  const calls: RecordedCall[] = [];
  const standIn = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const call: RecordedCall = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const answer = await answerer(call, calls.length - 1);
    return answer instanceof Response ? answer : responseOf(answer);
  }) as typeof globalThis.fetch;
  return { fetch: standIn, calls };
}

/** A fetch answering by `"METHOD /path"` below `/api/public/v1` (the query aside); anything else 404 in the envelope. */
export function routedFetch(routes: Readonly<Record<string, Answer | ((call: RecordedCall) => Answer | Response)>>): FakeFetch {
  return fakeFetch((call) => {
    const path = call.url.pathname.replace(/^\/api\/public\/v1/, "");
    const route = routes[`${call.method} ${path}`];
    if (route === undefined) return { status: 404, json: envelope("not_found", "Not found.") };
    return typeof route === "function" ? route(call) : route;
  });
}
