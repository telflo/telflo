/**
 * A refusal the API (or something in front of it) answered (D27 decision
 * 18). `message` is fixed words only: the envelope's own `message` (the
 * API's fixed words, D25 decision 20), or the CLI's words for the status
 * when the reply isn't the envelope (the gateway's HTML 413, 502, 504).
 * Never the reply's body. `details` are kept for the commands that read
 * them (`configuration_invalid`'s errors, a rule's index,
 * `collector_group_required`'s group ids); nothing prints them whole.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The envelope's code, or null when the reply wasn't the envelope. */
    readonly code: string | null,
    message: string,
    readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
