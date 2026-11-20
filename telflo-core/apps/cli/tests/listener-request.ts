/*
 * Real loopback requests to the login listener, through node:http so a
 * test sets `Host` and `Origin` as a browser (or any local process) would.
 * Test support only: never built or packed. A body may hold a token: tests
 * check what they send with boolean canaries only.
 */

import { request } from "node:http";

export interface ListenerReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ListenerRequest {
  method?: string;
  path?: string;
  /** Headers sent; `host` defaults to `127.0.0.1:<port>`. */
  headers?: Record<string, string>;
  body?: string;
}

/** One request to `127.0.0.1:<port>`; rejects when the connection is refused or dropped. */
export function sendToListener(port: number, options: ListenerRequest = {}): Promise<ListenerReply> {
  return new Promise<ListenerReply>((resolve, reject) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/callback",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
        agent: false,
      },
      (reply) => {
        let body = "";
        reply.setEncoding("utf8");
        reply.on("data", (chunk: string) => (body += chunk));
        reply.on("end", () => resolve({ status: reply.statusCode ?? 0, headers: reply.headers, body }));
        reply.on("error", reject);
      },
    );
    sent.on("error", reject);
    sent.end(options.body);
  });
}

/** The page's handoff: `POST /callback` with the server's `Origin` and a JSON body. */
export function handOff(port: number, origin: string, body: unknown, headers: Record<string, string> = {}): Promise<ListenerReply> {
  return sendToListener(port, {
    headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The listener's parameters from the page's address printed by the CLI. */
export function parametersOf(url: string): { state: string; port: number; host: string } {
  const fragment = new URLSearchParams(new URL(url).hash.slice(1));
  return { state: fragment.get("state") ?? "", port: Number(fragment.get("port")), host: fragment.get("host") ?? "" };
}
