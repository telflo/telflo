/*
 * An organization's logo is typed from its bytes, never its name or the
 * type a browser or a client declares: the API refuses anything else
 * before a byte is written, and the web checks with the same function
 * before it sends. SVG (it can carry script), GIF, HTML and an empty file
 * are refused.
 */

/** The logo types Telflo keeps, as `imageTypeOf` names them. */
export const ORGANIZATION_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type OrganizationLogoType = (typeof ORGANIZATION_LOGO_TYPES)[number];

/** A logo's largest size: 2 MiB. */
export const ORGANIZATION_LOGO_MAXIMUM_BYTES = 2_097_152;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
/** "RIFF": a WebP file starts with it, then 4 bytes of size, then "WEBP". */
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

function startsWith(head: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (head.length < offset + signature.length) return false;
  return signature.every((byte, index) => head[offset + index] === byte);
}

/**
 * The image type a file's first bytes (its head; 12 are enough) name, or
 * undefined when they name none Telflo keeps (a head too short for any
 * signature included):
 * - PNG: `89 50 4E 47 0D 0A 1A 0A`;
 * - JPEG: `FF D8 FF`;
 * - WebP: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` (RIFF, a size, WEBP).
 */
export function imageTypeOf(head: Uint8Array): OrganizationLogoType | undefined {
  if (startsWith(head, PNG_SIGNATURE)) return "image/png";
  if (startsWith(head, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return "image/webp";
  return undefined;
}
