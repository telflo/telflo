/**
 * A blob's bytes, through FileReader where `arrayBuffer` is missing (jsdom's).
 * Shared by the test runs' fixture-shape check and the organization logo's
 * type check (D23-2 decision 52).
 */
export function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsArrayBuffer(blob);
  });
}
