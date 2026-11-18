import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  keyIdOf,
  openValues,
  quickDeployKeyRing,
  sealValues,
  SEALED_HEADER_BYTES,
  SealedValuesError,
  type QuickDeployKeyRing,
} from "./sealed-values.js";

const keyText = () => randomBytes(32).toString("base64");
const ringOf = (current: string, ...previous: string[]): QuickDeployKeyRing =>
  quickDeployKeyRing({ TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: previous.join(",") });
const forLink = { organizationId: "0192a6b0-0000-7000-8000-0000000000a1", linkId: "0192a6b0-0000-7000-8000-0000000000b1" };
const values = [
  { name: "NGINX_ENV", value: "prod" },
  { name: "QUOTED", value: "it's $(echo EXPANDED) — ünïcode" },
];
const names = values.map(({ name }) => name);

/** The error `work` throws: a SealedValuesError, whose reason the caller checks. */
function sealedErrorOf(work: () => unknown): SealedValuesError {
  try {
    work();
  } catch (error) {
    if (error instanceof SealedValuesError) return error;
    throw error;
  }
  throw new Error("nothing was thrown");
}

describe("sealed values (AES-256-GCM, Preflight ruling 6)", () => {
  it("round-trips the values in order, under the current key's id, never in the clear", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    expect(sealed.keyId).toBe(ring.current.id);
    expect(sealed.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(sealed.ciphertext[0]).toBe(0x01);
    expect(sealed.ciphertext.length).toBeGreaterThan(SEALED_HEADER_BYTES);
    for (const { name, value } of values) {
      expect(sealed.ciphertext.toString("latin1")).not.toContain(name);
      expect(sealed.ciphertext.toString("utf8")).not.toContain(value);
    }
    expect(openValues(ring, sealed, forLink, names)).toEqual(values);
  });

  it("seals the same values differently each time (a fresh nonce)", () => {
    const ring = ringOf(keyText());
    expect(sealValues(ring, values, forLink).ciphertext.equals(sealValues(ring, values, forLink).ciphertext)).toBe(false);
  });

  it("refuses a tampered nonce, tag or ciphertext as not authentic", () => {
    const ring = ringOf(keyText());
    for (const at of [1, 1 + 12, SEALED_HEADER_BYTES + 2]) {
      const sealed = sealValues(ring, values, forLink);
      sealed.ciphertext[at]! ^= 0x01;
      expect({ at, reason: sealedErrorOf(() => openValues(ring, sealed, forLink, names)).reason }).toEqual({ at, reason: "not_authentic" });
    }
  });

  it("refuses a truncated ciphertext as not authentic", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    expect(sealedErrorOf(() => openValues(ring, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, -1) }, forLink, names)).reason).toBe(
      "not_authentic",
    );
  });

  it("refuses a wrong key under the right id as not authentic, and a key id the ring doesn't hold as unknown", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    const impostor: QuickDeployKeyRing = { current: { id: ring.current.id, key: randomBytes(32) }, previous: [] };
    expect(sealedErrorOf(() => openValues(impostor, sealed, forLink, names)).reason).toBe("not_authentic");
    expect(sealedErrorOf(() => openValues(ringOf(keyText()), sealed, forLink, names)).reason).toBe("unknown_key");
  });

  it("opens with a previous key after a rotation, and seals with the new one", () => {
    const old = keyText();
    const sealedBefore = sealValues(ringOf(old), values, forLink);
    const rotated = ringOf(keyText(), old);
    expect(openValues(rotated, sealedBefore, forLink, names)).toEqual(values);
    const sealedAfter = sealValues(rotated, values, forLink);
    expect(sealedAfter.keyId).toBe(rotated.current.id);
    expect(sealedAfter.keyId).not.toBe(sealedBefore.keyId);
    // Once the old key is dropped from the ring, what it sealed no longer opens.
    expect(sealedErrorOf(() => openValues(ringOf(keyText()), sealedBefore, forLink, names)).reason).toBe("unknown_key");
  });

  it("binds a ciphertext to its link and organization (the associated data): moved to another link or organization, it fails", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    expect(sealedErrorOf(() => openValues(ring, sealed, { ...forLink, linkId: "0192a6b0-0000-7000-8000-0000000000b2" }, names)).reason).toBe(
      "not_authentic",
    );
    expect(
      sealedErrorOf(() => openValues(ring, sealed, { ...forLink, organizationId: "0192a6b0-0000-7000-8000-0000000000a2" }, names)).reason,
    ).toBe("not_authentic");
    // The ids' case doesn't matter: a uuid is one value.
    expect(openValues(ring, sealed, { organizationId: forLink.organizationId.toUpperCase(), linkId: forLink.linkId.toUpperCase() }, names)).toEqual(
      values,
    );
  });

  it("refuses a short or unversioned ciphertext as malformed", () => {
    const ring = ringOf(keyText());
    expect(
      sealedErrorOf(() => openValues(ring, { ciphertext: Buffer.alloc(SEALED_HEADER_BYTES - 1), keyId: ring.current.id }, forLink, names)).reason,
    ).toBe("malformed");
    const sealed = sealValues(ring, values, forLink);
    sealed.ciphertext[0] = 0x02;
    expect(sealedErrorOf(() => openValues(ring, sealed, forLink, names)).reason).toBe("malformed");
  });

  it("refuses values whose names aren't the link's, in its order, as malformed", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    for (const expected of [[], ["NGINX_ENV"], ["QUOTED", "NGINX_ENV"], [...names, "MORE"], ["NGINX_ENV", "OTHER"]]) {
      expect({ expected, reason: sealedErrorOf(() => openValues(ring, sealed, forLink, expected)).reason }).toEqual({ expected, reason: "malformed" });
    }
  });

  it("names the reason in its message, never a value, a name or the key", () => {
    const ring = ringOf(keyText());
    const sealed = sealValues(ring, values, forLink);
    const error = sealedErrorOf(() => openValues(ring, sealed, forLink, ["OTHER"]));
    expect(error.message).toBe("the link's sealed values can't be opened: malformed");
    expect(error.name).toBe("SealedValuesError");
  });

  it("derives a key's id from the key alone: the same key, the same id; another key, another id", () => {
    const key = randomBytes(32);
    expect(keyIdOf(key)).toBe(keyIdOf(Buffer.from(key)));
    expect(keyIdOf(key)).not.toBe(keyIdOf(randomBytes(32)));
    expect(keyIdOf(key)).not.toBe(key.toString("hex").slice(0, 16));
  });
});

describe("the key settings", () => {
  const current = keyText();

  it.each([
    ["missing", {}],
    ["empty", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "" }],
    ["16 bytes", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: randomBytes(16).toString("base64") }],
    ["48 bytes", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: randomBytes(48).toString("base64") }],
    ["base64url, not base64", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "-_" + randomBytes(32).toString("base64").slice(2) }],
    ["a passphrase", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "development-only-quick-deploy-key-not-for-production" }],
    ["a previous key that isn't 32 bytes", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: "c2hvcnQ=" }],
    ["an empty previous key between commas", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: `${keyText()},,${keyText()}` }],
    ["the current key again as a previous one", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: current }],
    ["a previous key twice", (() => {
      const old = keyText();
      return { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: `${old},${old}` };
    })()],
    ["nine previous keys", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: Array.from({ length: 9 }, keyText).join(",") }],
  ])("refuses %s, naming the variable and never the value", (_label, env: Record<string, string>) => {
    let message = "";
    try {
      quickDeployKeyRing(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TELFLO_QUICK_DEPLOY_(PREVIOUS_)?ENCRYPTION_KEYS?/);
    for (const value of Object.values(env)) {
      for (const part of value.split(",")) if (part !== "") expect(message).not.toContain(part);
    }
  });

  it("takes a current key alone, the previous keys unset or empty", () => {
    for (const previous of [undefined, "", "  "]) {
      const ring = quickDeployKeyRing({
        TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current,
        ...(previous === undefined ? {} : { TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: previous }),
      });
      expect(ring.current).toEqual({ id: keyIdOf(Buffer.from(current, "base64")), key: Buffer.from(current, "base64") });
      expect(ring.previous).toEqual([]);
    }
  });

  it("takes the current key with white space around it (a secret file's trailing newline), as the previous keys", () => {
    for (const padded of [`${current}\n`, `${current}\r\n`, `  ${current}\t`]) {
      const ring = quickDeployKeyRing({ TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: padded });
      expect(ring.current).toEqual({ id: keyIdOf(Buffer.from(current, "base64")), key: Buffer.from(current, "base64") });
    }
    expect(() => quickDeployKeyRing({ TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: " \n" })).toThrow(
      "Missing required environment variable: TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY",
    );
  });

  it("takes up to eight previous keys, spaces around the commas allowed, in their order", () => {
    const previous = Array.from({ length: 8 }, keyText);
    const ring = quickDeployKeyRing({ TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: current, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: ` ${previous.join(" , ")} ` });
    expect(ring.previous.map(({ key }) => key.toString("base64"))).toEqual(previous);
  });
});
