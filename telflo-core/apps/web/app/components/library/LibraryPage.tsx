import { FileText, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { libraryFileCurlCommand, type LibraryFile } from "@telflo/contracts";
import { LibraryFilesTable, nextLibrarySort, sortLibraryFiles, type LibrarySort, type LibrarySortColumn } from "./columns.js";
import { Input } from "~/components/ui/input.js";
import { abortAfter } from "~/lib/abort-after.js";
import { createLibraryFileLink, getLibraryFileBytes, getLibraryFiles, isSessionEnded } from "~/lib/api-client.js";
import { copyTextFromPromise } from "~/lib/clipboard.js";
import { isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { downloadBlob } from "~/lib/download.js";
import { useTermsRequired } from "~/lib/fleets.js";
import { useDocsPage } from "~/lib/use-site.js";

/*
 * The members' library (`/library`, the sidebar's Learning): the header
 * "Library", "Helper files used in the Learning Telflo tutorials." (its link
 * a new tab, `rel=noreferrer`), the search over name and description
 * (client-side, case-insensitive; the page's state only, never the URL), the
 * spinner, "No files in the library yet." / "No files match your search.",
 * and the table (`columns.tsx`). Its details:
 * - the list is read from the API on each visit (never cached), once the
 *   layout says the current terms are accepted; a read that never answers is
 *   aborted after 10 s;
 * - Download reads the file's bytes with the session (`GET …/:fileId/file`)
 *   and saves them under the list's file name on a detached anchor
 *   (`downloadBlob`);
 * - Copy curl asks the API for a library link (`POST …/:fileId/link`, valid
 *   24 hours) and puts `curl -fL '<link>' -o '<file name>'` on the
 *   clipboard, both single-quoted (`libraryFileCurlCommand`), the link
 *   under the page's own origin. The request starts inside the click and
 *   its promise goes straight to `copyTextFromPromise`, so Safari keeps the
 *   gesture. The link and the command are secrets: they exist only in that
 *   promise and on the clipboard, never in the DOM, a state, browser
 *   storage, a toast or a log;
 * - nothing is logged, and a session that has ended toasts nothing (the
 *   session-ended handler has the page).
 * Names and descriptions are Telflo's own content: text in the masked
 * shell, never an attribute or a toast. The title is fixed.
 */

/** A list read's hang guard, as the Testing tab's and the test templates' reads. */
export const LIBRARY_REQUEST_TIMEOUT_MS = 10_000;

/** What both library pages say when the files can't be read. */
export const LIBRARY_LOAD_FAILED_MESSAGE = "Failed to load library files";

/** How long "Copied" shows after Copy curl (1.5 s). */
export const CURL_COPIED_MS = 1_500;

/** Whether `libraryFile` matches the search `query` (trimmed, case aside) by its name or description. */
export function matchesLibrarySearch(libraryFile: LibraryFile, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return true;
  return `${libraryFile.name} ${libraryFile.description}`.toLowerCase().includes(wanted);
}

export function LibraryPage() {
  const termsRequired = useTermsRequired();
  const learningHref = useDocsPage("docs/learning/about");
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [copiedCurlId, setCopiedCurlId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>(null);
  const reads = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const read = ++reads.current;
    const timeout = abortAfter(LIBRARY_REQUEST_TIMEOUT_MS);
    try {
      const { libraryFiles: listed } = await getLibraryFiles({ signal: timeout.signal });
      if (read === reads.current) setLibraryFiles(listed);
    } catch (error) {
      // An ended session has the session-ended handler; terms not yet accepted, the layout's dialog.
      if (read === reads.current && !isSessionEnded(error) && !isTermsAcceptanceRequired(error)) {
        toast.error(LIBRARY_LOAD_FAILED_MESSAGE);
      }
    } finally {
      timeout.clear();
      if (read === reads.current) setLoaded(true);
    }
  }, []);

  // Nothing loads while the layout says the terms need accepting: the API would refuse.
  useEffect(() => {
    if (termsRequired) return;
    void load();
  }, [load, termsRequired]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleDownload = async (libraryFile: LibraryFile) => {
    setDownloadingId(libraryFile.id);
    try {
      const bytes = await getLibraryFileBytes(libraryFile.id);
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), libraryFile.fileName);
    } catch (error) {
      if (!isSessionEnded(error)) toast.error("Failed to download file");
    } finally {
      setDownloadingId(null);
    }
  };

  const handleCopyCurl = async (libraryFile: LibraryFile) => {
    try {
      // The link's request starts here, inside the click, and its promise
      // goes straight to the clipboard: Safari keeps the gesture
      // (copyTextFromPromise). The command lives only in that promise.
      await copyTextFromPromise(
        createLibraryFileLink(libraryFile.id).then(({ path }) =>
          libraryFileCurlCommand(window.location.origin + path, libraryFile.fileName),
        ),
      );
      setCopiedCurlId(libraryFile.id);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null;
        setCopiedCurlId(null);
      }, CURL_COPIED_MS);
    } catch (error) {
      if (!isSessionEnded(error)) toast.error("Failed to copy curl command");
    }
  };

  const shownFiles = useMemo(
    () => sortLibraryFiles(libraryFiles.filter((libraryFile) => matchesLibrarySearch(libraryFile, search)), sort),
    [libraryFiles, search, sort],
  );

  const handleSort = (column: LibrarySortColumn) => setSort((current) => nextLibrarySort(current, column));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="flex h-13 items-center justify-between border-b border-border bg-card px-5">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Library</h1>
      </div>

      <div className="max-w-7xl mx-auto px-5 py-5">
        {/* Page description */}
        <div className="mb-6">
          <p className="text-lg text-muted-foreground">
            Helper files used in the{" "}
            {/* Its page under the site's docs; the words alone without docs links. */}
            {learningHref === null ? (
              "Learning Telflo"
            ) : (
              <a
                href={learningHref}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Learning Telflo
              </a>
            )}{" "}
            tutorials.
          </p>
        </div>

        {/* Toolbar: search */}
        <div className="mb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search library by name or description..."
              aria-label="Search library by name or description"
              className="pl-8"
            />
          </div>
        </div>

        {!loaded ? (
          <div className="flex justify-center items-center py-8" role="status" aria-label="Loading library files">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-muted-foreground/25 border-t-muted-foreground" />
          </div>
        ) : libraryFiles.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-[13px] text-muted-foreground">No files in the library yet.</p>
          </div>
        ) : shownFiles.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <Search className="h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-[13px] text-muted-foreground">No files match your search.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <LibraryFilesTable
              libraryFiles={shownFiles}
              sort={sort}
              onSort={handleSort}
              onDownload={(libraryFile) => void handleDownload(libraryFile)}
              onCopyCurl={(libraryFile) => void handleCopyCurl(libraryFile)}
              downloadingId={downloadingId}
              copiedCurlId={copiedCurlId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
