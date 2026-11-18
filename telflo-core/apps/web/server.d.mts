// Types for server.mjs (plain JavaScript that node runs without a build), so
// its test is type-checked. The app is an express app; its test needs only
// what node's http server takes.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

/** The text of `error` with each of `pieces` (and its decoded form) replaced by a fixed word. */
export function withoutRequestUrl(error: unknown, pieces: readonly (string | undefined)[]): string;

/** Whether a raw request target's path and every query key and value decode. */
export function decodes(target: string): boolean;

/** Drops `console.warn` calls whose first argument starts with `The URL path "`; returns the undo. */
export function installWarnFilter(target?: Pick<Console, "warn">): () => void;

export function createApp(options: {
  build: { publicPath?: string };
  clientDir: string;
  publicDir: string;
  mode?: string;
  handler?: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
}): RequestListener;
