/**
 * A version's name as the picker and its dialogs show it (D10 decision 3):
 * its label, or "Version N" for an unnamed version. "main" is no default
 * label here: it shows as itself (the Parity Notes). The result
 * is the user's text: shown as text only, never in an attribute (ADR 0024).
 */
export function versionLabelText(versionNumber: number, label: string | null): string {
  const named = label?.trim();
  return named ? named : `Version ${versionNumber}`;
}
