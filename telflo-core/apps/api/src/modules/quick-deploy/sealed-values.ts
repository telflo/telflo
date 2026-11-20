import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/*
 * The values typed for a link's variables, sealed at rest: AES-256-GCM from
 * node:crypto, no library.
 *
 *   sealed = version (1 byte, 0x01) ‖ nonce (12 random bytes) ‖ tag (16 bytes) ‖ ciphertext
 *
 * The associated data binds a ciphertext to its link: a fixed label, the
 * organization's id and the link's id, so a value copied into another
 * link's row (or another organization's) fails to open. The key id (16 hex
 * characters of a labelled sha-256 of the key) is stored beside it, names
 * which key of the ring opens it, and reveals nothing of the key. The
 * plaintext is the variables as JSON, [{name, value}, …], in the request's
 * order; opening checks its names are the link's `choices.envNames`, in
 * that order.
 *
 * Nothing here logs. An error names its reason only, never a value, a name
 * or a key: the values are configuration text and the keys secrets (ADR
 * 0024).
 */

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The version byte, the nonce and the tag: the shortest sealed value (the table's check). */
export const SEALED_HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const AAD_LABEL = "telflo.quick_deploy_link.env.v1";
const KEY_ID_LABEL = "telflo quick-deploy key id\0";

export interface QuickDeployKey {
  /** keyIdOf(key). */
  id: string;
  /** 32 bytes. Never log it. */
  key: Buffer;
}

/** The current key seals; the previous ones still open what they sealed (a rotation). */
export interface QuickDeployKeyRing {
  current: QuickDeployKey;
  previous: readonly QuickDeployKey[];
}

/** What the link's row holds: env_ciphertext and env_key_id. */
export interface SealedValues {
  ciphertext: Buffer;
  keyId: string;
}

/** Whose values: the associated data. */
export interface SealedFor {
  organizationId: string;
  linkId: string;
}

export interface EnvValue {
  name: string;
  value: string;
}

export type SealedValuesErrorReason = "unknown_key" | "malformed" | "not_authentic";

/**
 * Why sealed values couldn't be opened: no key of the ring has its id, it
 * isn't a sealed value of this version or its names aren't the link's, or
 * it fails authentication (tampered, another key under the id, or another
 * link's). The message is the reason only.
 */
export class SealedValuesError extends Error {
  constructor(readonly reason: SealedValuesErrorReason) {
    super(`the link's sealed values can't be opened: ${reason}`);
    this.name = "SealedValuesError";
  }
}

/** A key's id: the first 16 hex characters of sha-256("telflo quick-deploy key id\0" ‖ key). */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(KEY_ID_LABEL, "utf8").update(key).digest("hex").slice(0, 16);
}

function associatedData({ organizationId, linkId }: SealedFor): Buffer {
  return Buffer.from(`${AAD_LABEL}\0${organizationId.toLowerCase()}\0${linkId.toLowerCase()}`, "utf8");
}

/** Seals `values` (in their order) under the ring's current key, for the link `sealedFor` names. */
export function sealValues(ring: QuickDeployKeyRing, values: readonly EnvValue[], sealedFor: SealedFor): SealedValues {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ring.current.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(sealedFor));
  const plaintext = JSON.stringify(values.map(({ name, value }) => ({ name, value })));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]), keyId: ring.current.id };
}

/**
 * Opens values `sealValues` sealed for the same link, with whichever key of
 * the ring has their id, and checks their names are `expectedNames` (the
 * link's `choices.envNames`), in order. Throws SealedValuesError otherwise.
 */
export function openValues(
  ring: QuickDeployKeyRing,
  sealed: SealedValues,
  sealedFor: SealedFor,
  expectedNames: readonly string[],
): EnvValue[] {
  const key = [ring.current, ...ring.previous].find((candidate) => candidate.id === sealed.keyId);
  if (key === undefined) throw new SealedValuesError("unknown_key");
  const { ciphertext } = sealed;
  if (ciphertext.length < SEALED_HEADER_BYTES || ciphertext[0] !== VERSION) throw new SealedValuesError("malformed");
  const nonce = ciphertext.subarray(1, 1 + NONCE_BYTES);
  const tag = ciphertext.subarray(1 + NONCE_BYTES, SEALED_HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(sealedFor));
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext.subarray(SEALED_HEADER_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SealedValuesError("not_authentic");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new SealedValuesError("malformed");
  }
  if (!Array.isArray(parsed) || !parsed.every(isEnvValue)) throw new SealedValuesError("malformed");
  const values = parsed.map(({ name, value }) => ({ name, value }));
  if (values.length !== expectedNames.length || values.some(({ name }, index) => name !== expectedNames[index])) {
    throw new SealedValuesError("malformed");
  }
  return values;
}

function isEnvValue(entry: unknown): entry is EnvValue {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { name?: unknown }).name === "string" &&
    typeof (entry as { value?: unknown }).value === "string"
  );
}

export const QUICK_DEPLOY_ENCRYPTION_KEY_NAME = "TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY";
export const QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS_NAME = "TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS";
/** The most previous keys a ring keeps. */
export const QUICK_DEPLOY_PREVIOUS_KEYS_MAXIMUM = 8;

/** A key setting's value: standard base64 of exactly 32 bytes (44 characters, one `=`). */
const KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The key ring from the settings:
 * TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY (required) and
 * TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS (optional, comma separated,
 * at most 8), each 32 bytes in standard base64, none repeated, the current
 * one included, each trimmed of white space (a trailing newline from a
 * secret file loads). "" means unset. The errors name the variable, never
 * a value.
 */
export function quickDeployKeyRing(env: NodeJS.ProcessEnv): QuickDeployKeyRing {
  const parse = (text: string, name: string): QuickDeployKey => {
    if (!KEY_TEXT.test(text)) {
      throw new Error(`Environment variable ${name} must hold keys of 32 bytes in base64 (44 characters, e.g. from: openssl rand -base64 32)`);
    }
    const key = Buffer.from(text, "base64");
    return { id: keyIdOf(key), key };
  };
  // Trimmed as the previous keys are: a key read from a mounted secret file often ends in a newline.
  const currentText = (env[QUICK_DEPLOY_ENCRYPTION_KEY_NAME] ?? "").trim();
  if (currentText === "") throw new Error(`Missing required environment variable: ${QUICK_DEPLOY_ENCRYPTION_KEY_NAME}`);
  const current = parse(currentText, QUICK_DEPLOY_ENCRYPTION_KEY_NAME);
  const previousText = (env[QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS_NAME] ?? "").trim();
  const previousTexts = previousText === "" ? [] : previousText.split(",").map((part) => part.trim());
  if (previousTexts.length > QUICK_DEPLOY_PREVIOUS_KEYS_MAXIMUM) {
    throw new Error(`Environment variable ${QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS_NAME} holds at most ${QUICK_DEPLOY_PREVIOUS_KEYS_MAXIMUM} keys`);
  }
  const previous = previousTexts.map((text) => parse(text, QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS_NAME));
  const ids = [current.id, ...previous.map((key) => key.id)];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Environment variable ${QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS_NAME} repeats a key, or holds the current one`);
  }
  return { current, previous };
}
