import type { IFileStore } from "../file-store/file-store.js";

/** A rejection naming what this test server lacks: the test reached the file store unasked. */
function uncalled(): Promise<never> {
  return Promise.reject(
    new Error("This test server has no file store: pass a fileStore of its own to test what keeps files."),
  );
}

/**
 * buildServer's `fileStore` (D23-2 decision 31) for every test server that
 * keeps no file: any call rejects, so the request fails with a 500 and the
 * test with it, rather than reach a store nobody set up. A test about test
 * files, runs, templates, definitions' inputs, logos or library files passes
 * a store of its own (createFileStore on a temporary directory).
 */
export const UNCALLED_FILE_STORE: IFileStore = {
  write: () => uncalled(),
  read: () => uncalled(),
  copy: () => uncalled(),
  remove: () => uncalled(),
};
