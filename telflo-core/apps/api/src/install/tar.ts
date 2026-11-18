import { gzipSync } from "node:zlib";

/*
 * A gzipped POSIX ustar archive (D17c-1 decision 37, Preflight ruling 13),
 * written here rather than by a library (Q7): regular files only, each at
 * the archive's root, owned by uid and gid 0 with empty owner names, its
 * mode given, its time the render's. A name over 100 bytes, or one holding
 * a `/`, is refused: the bundle's files are a template directory's names.
 */

export interface TarFile {
  name: string;
  content: Buffer;
  /** 0o700 or 0o644. */
  mode: number;
}

const BLOCK = 512;
const NAME_MAXIMUM_BYTES = 100;
/** The size field's 11 octal digits. */
const SIZE_MAXIMUM = 8 ** 11 - 1;

export class TarNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarNameError";
  }
}

/** `value` in `width - 1` octal digits, then NUL. */
function writeOctal(header: Buffer, value: number, offset: number, width: number): void {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function header(file: TarFile, mtimeSeconds: number): Buffer {
  const nameBytes = Buffer.byteLength(file.name, "utf8");
  if (file.name === "" || nameBytes > NAME_MAXIMUM_BYTES) throw new TarNameError("A bundle's file name must be 1 to 100 bytes.");
  if (file.name.includes("/") || file.name.includes("\0")) throw new TarNameError("A bundle's file name must name a file at its root.");
  if (file.content.length > SIZE_MAXIMUM) throw new RangeError("A bundle's file is too large for ustar.");
  const block = Buffer.alloc(BLOCK);
  block.write(file.name, 0, NAME_MAXIMUM_BYTES, "utf8");
  writeOctal(block, file.mode & 0o7777, 100, 8);
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, file.content.length, 124, 12);
  writeOctal(block, mtimeSeconds, 136, 12);
  block.fill(0x20, 148, 156); // the checksum's field, spaces while it is summed
  block.write("0", 156, 1, "ascii"); // a regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  // uname (265) and gname (297) stay empty.
  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, NUL, space.
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** The archive of `files`, in their order, gzipped. */
export function tarGz(files: readonly TarFile[], mtime: Date): Buffer {
  const mtimeSeconds = Math.floor(mtime.getTime() / 1000);
  const blocks: Buffer[] = [];
  for (const file of files) {
    blocks.push(header(file, mtimeSeconds), file.content);
    const padding = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  // Two zero blocks end the archive.
  blocks.push(Buffer.alloc(2 * BLOCK));
  return gzipSync(Buffer.concat(blocks));
}
