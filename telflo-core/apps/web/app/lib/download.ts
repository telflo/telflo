/**
 * Trigger a browser download of in-memory text.
 *
 * The one place the anchor/blob/revoke dance lives, so callers don't each
 * hand-roll it.
 */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download of `blob` as `filename` (D14a Preflight ruling
 * 14): a test run's files, as their bytes, so a UTF-16 input survives.
 *
 * The anchor stays detached: it is never appended to `<body>`, where session
 * replay would record it, its `download` attribute naming the file, which
 * can be private text (ADR 0024). A detached anchor's click downloads in
 * every browser the app supports (proved in Chromium, Firefox and WebKit).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
