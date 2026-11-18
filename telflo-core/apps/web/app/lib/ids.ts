/**
 * A UUID in its canonical, hyphenated form, in either case: the only ids the
 * API can find (D8 decision 4). A page whose address holds anything else
 * answers "not found" with no request, which also keeps a decoded `..` off
 * the API's paths (the editor's; the fleet's page, D17a Preflight ruling 9).
 */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID in its canonical form (`CANONICAL_UUID`). */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

/**
 * A new random (version 4) UUID, in its canonical form: a new fleet's id,
 * made by its create dialog so a retry is safe (D17a decision 24, Preflight
 * ruling 13). `crypto.randomUUID` where the browser has it; an insecure
 * `http` origin has none in any browser (it needs a secure context), so
 * otherwise one is made from `crypto.getRandomValues`, which every context
 * has: 122 random bits, the version and variant set as RFC 9562 says.
 */
export function randomUuid(): string {
  const { crypto } = globalThis;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
