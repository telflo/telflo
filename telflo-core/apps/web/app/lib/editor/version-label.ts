/**
 * A version's name as the picker and its dialogs show it: its label, or
 * "Version N" for an unnamed version. "main" is no default label here: it
 * shows as itself. The result is the user's text: shown as text only, never
 * in an attribute.
 */
export function versionLabelText(versionNumber: number, label: string | null): string {
  const named = label?.trim();
  return named ? named : `Version ${versionNumber}`;
}
