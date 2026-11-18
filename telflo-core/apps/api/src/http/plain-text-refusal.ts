import type { FastifyReply } from "fastify";

/*
 * A public route's plain-text refusal (D17c-2 decision 26, Preflight ruling
 * 10), on its own so the API's error handling (errors.ts) answers a
 * framework error on a path that may hold a quick-deploy link's secret as
 * the public route does, without importing the public routes' machinery
 * (public-download.ts, which imports errors.ts' AppError).
 */

/**
 * Every reply of a public route, the download and each refusal (the 429s
 * and the cap's 503 included), says `Referrer-Policy: no-referrer` (D17c-2
 * Ruling 31): a browser that opens a link never sends the link, secret and
 * all, as the Referer of anything the reply leads it to.
 */
export const PUBLIC_DOWNLOAD_REFERRER_POLICY = "no-referrer";

/**
 * Answers a refusal as a short plain-text body (D17c-2 decision 26: curl
 * shows it with `--fail-with-body`), `no-store`, `nosniff` and
 * `no-referrer`. `text` is the platform's own fixed words: never a secret,
 * a label or a name.
 */
export function sendPlainTextRefusal(
  reply: FastifyReply,
  statusCode: number,
  text: string,
  headers?: Readonly<Record<string, string | number>>,
): FastifyReply {
  if (headers) void reply.headers(headers);
  return reply
    .status(statusCode)
    .header("content-type", "text/plain; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", PUBLIC_DOWNLOAD_REFERRER_POLICY)
    .send(`${text}\n`);
}
