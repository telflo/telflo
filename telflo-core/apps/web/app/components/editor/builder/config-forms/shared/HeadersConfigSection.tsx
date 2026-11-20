import { KeyValueMapField, type KeyValueNouns } from "./KeyValueMapField.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The headers section, over the form. Bound to the headers mapping's path
 * under the form.
 *
 * It is `KeyValueMapField`'s `"staging"` layout with the headers' nouns: the
 * mechanics are that field's.
 *
 * Written by key: a row's value is held as typing and written to its
 * header; the staging row adds a header (trimmed) on Enter or "+"; Remove
 * removes the header's lines, and the mapping itself with its last
 * header.
 *
 * The row is never re-keyed on a keystroke of a name (the input would
 * remount, losing focus), and a name another header has never overwrites it.
 * A name is held while typed and renamed in place, where it stands and with
 * its comment, on blur or Enter (as the instance name is); a name another
 * header has is refused with `HEADER_EXISTS_MESSAGE` under the row, as text,
 * and the row shows its name again. The staging row refuses one the same way
 * rather than overwriting that header. An empty name isn't a rename: the row
 * shows its name again. A renamed name is trimmed, as the staging row's, and
 * checked for a clash once trimmed.
 *
 * Rows are keyed by their items, never by name or index, and no attribute
 * carries a name or a value.
 */

/** Under a header row whose new name another header has. */
export const HEADER_EXISTS_MESSAGE = "A header with this name already exists.";

/** The headers' words: their placeholders and labels. */
export const HEADER_NOUNS: KeyValueNouns = {
  key: "Header name",
  value: "Header value",
  addLabel: "Add header",
  removeLabel: "Remove header",
  exists: HEADER_EXISTS_MESSAGE,
  newKey: "e.g. Authorization",
  newValue: "e.g. Bearer token",
};

interface HeadersConfigSectionProps {
  /** The headers mapping's path under the form. */
  path: ValuePath;
  /** Pass null when the parent ConfigSection header already names this block. */
  title?: string | null;
  description?: string;
}

export function HeadersConfigSection({ path, title = "Headers", description }: HeadersConfigSectionProps) {
  return (
    <KeyValueMapField
      path={path}
      nouns={HEADER_NOUNS}
      layout="staging"
      title={title}
      {...(description !== undefined ? { description } : {})}
    />
  );
}
