import { useId } from "react";
import { ArrowUpDown, Check, Download, Terminal } from "lucide-react";
import type { LibraryFile } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";

/*
 * The members' library table (D23-2 decision 54), plain table markup (the
 * platform has no DataTable or @tanstack/react-table): Name (sortable,
 * "Untitled" for none), Description (sortable, "—" for none) and Actions
 * ("Curl", its title "Copy a curl command that downloads this file", "Copied"
 * with a check once copied; "Download", "Downloading…" while it runs). The
 * sortable headers are the fleet grids' (`CollectorsTable.tsx`): a ghost
 * button with `ArrowUpDown`, `aria-sort` only on the sorted column, ascending
 * first, then toggling, by `localeCompare`; none sorted shows the API's
 * order, newest first.
 *
 * Names and descriptions are Telflo's own content: text in the masked
 * shell, never an attribute (decision 58). Each row's buttons are
 * described by the name's text (`aria-describedby`). The link and the curl
 * command are never here: Curl only asks for them (LibraryPage).
 */

export type LibrarySortColumn = "name" | "description";

/** The sort shown, or null for the API's order. */
export type LibrarySort = { column: LibrarySortColumn; direction: "asc" | "desc" } | null;

/** The next sort after a click on `column`'s header: ascending first, then toggling. */
export function nextLibrarySort(sort: LibrarySort, column: LibrarySortColumn): LibrarySort {
  if (sort === null || sort.column !== column) return { column, direction: "asc" };
  return { column, direction: sort.direction === "asc" ? "desc" : "asc" };
}

/** `files` in `sort`'s order (a copy), or as they are when nothing is sorted. */
export function sortLibraryFiles(files: readonly LibraryFile[], sort: LibrarySort): LibraryFile[] {
  if (sort === null) return [...files];
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...files].sort((a, b) => sign * a[sort.column].localeCompare(b[sort.column]));
}

const HEAD_BASE_CLASS =
  "h-9 whitespace-nowrap px-3 align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const HEAD_CLASS = `${HEAD_BASE_CLASS} text-left`;
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

interface SortHeaderProps {
  column: LibrarySortColumn;
  label: string;
  sort: LibrarySort;
  onSort: (column: LibrarySortColumn) => void;
}

/** A sortable header: a ghost button with `ArrowUpDown`; `aria-sort` only while it is the sorted column. */
function SortHeader({ column, label, sort, onSort }: SortHeaderProps) {
  const sorted = sort?.column === column;
  return (
    <th className={HEAD_CLASS} aria-sort={sorted ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
      <Button
        variant="ghost"
        onClick={() => onSort(column)}
        className="-ml-2 h-7 px-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em]"
      >
        {label}
        <ArrowUpDown className="ml-1 h-3 w-3" aria-hidden="true" />
      </Button>
    </th>
  );
}

export interface LibraryFilesTableProps {
  libraryFiles: LibraryFile[];
  sort: LibrarySort;
  onSort: (column: LibrarySortColumn) => void;
  onDownload: (libraryFile: LibraryFile) => void;
  onCopyCurl: (libraryFile: LibraryFile) => void;
  /** The file being downloaded, by id. */
  downloadingId: string | null;
  /** The file whose curl command was just copied, by id. */
  copiedCurlId: string | null;
}

export function LibraryFilesTable({
  libraryFiles,
  sort,
  onSort,
  onDownload,
  onCopyCurl,
  downloadingId,
  copiedCurlId,
}: LibraryFilesTableProps) {
  const idPrefix = useId();
  return (
    <div className="relative w-full overflow-auto">
      <table className="w-full caption-bottom text-[13px]">
        <thead className="[&_tr]:border-b">
          <tr className={ROW_CLASS}>
            <SortHeader column="name" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="description" label="Description" sort={sort} onSort={onSort} />
            <th className={`${HEAD_BASE_CLASS} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody className="[&_tr:last-child]:border-0">
          {libraryFiles.map((libraryFile) => {
            const nameId = `${idPrefix}-name-${libraryFile.id}`;
            const isCurlCopied = copiedCurlId === libraryFile.id;
            const isDownloading = downloadingId === libraryFile.id;
            return (
              <tr key={libraryFile.id} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <div id={nameId} className="font-medium text-foreground">
                    {libraryFile.name || "Untitled"}
                  </div>
                </td>
                <td className={CELL_CLASS}>
                  {libraryFile.description === "" ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="text-muted-foreground">{libraryFile.description}</span>
                  )}
                </td>
                <td className={CELL_CLASS}>
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCopyCurl(libraryFile)}
                      title="Copy a curl command that downloads this file"
                      aria-describedby={nameId}
                    >
                      {isCurlCopied ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {/* Reserve the widest label's width so the Curl↔Copied swap
                          doesn't resize the button and reflow the row. */}
                      <span className="grid">
                        <span className="invisible col-start-1 row-start-1" aria-hidden="true">
                          Copied
                        </span>
                        <span className="col-start-1 row-start-1">{isCurlCopied ? "Copied" : "Curl"}</span>
                      </span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDownload(libraryFile)}
                      disabled={isDownloading}
                      aria-describedby={nameId}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="grid">
                        <span className="invisible col-start-1 row-start-1" aria-hidden="true">
                          Downloading…
                        </span>
                        <span className="col-start-1 row-start-1">{isDownloading ? "Downloading…" : "Download"}</span>
                      </span>
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
