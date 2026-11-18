import type { FileStoreSettings, IFileStore } from "./file-store.js";
import { createLocalDiskFileStore } from "./local-disk-file-store.js";
import { createS3FileStore } from "./s3-file-store.js";

/**
 * The only place that turns configuration into a FileStore (ADR 0012, ADR
 * 0020's factory): the local disk (D14a decision 2) or an S3-protocol bucket
 * (D23-1 decision 26), and no caller of IFileStore knows which. Each checks,
 * before the API listens, that it can use its place: a root that doesn't
 * exist or can't be written, or a bucket the API can't write, read or tell a
 * missing file in (D23-1 decision 23), stops the start.
 */
export async function createFileStore(settings: FileStoreSettings): Promise<IFileStore> {
  switch (settings.kind) {
    case "local":
      return createLocalDiskFileStore(settings.root);
    case "s3":
      return createS3FileStore(settings);
    default: {
      // Settings from untyped code: refused, naming no value.
      const _unknown: never = settings;
      throw new Error("The file store's kind (TELFLO_FILE_STORE) is not one the API knows.");
    }
  }
}
