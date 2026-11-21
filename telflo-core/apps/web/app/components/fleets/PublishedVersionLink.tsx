import { Link } from "react-router";
import type { PublishedVersion } from "@telflo/contracts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";

/*
 * A published version as "{configurationName} @v{n}", linked to the
 * editor's version: one component for the Groups tab's Published
 * version, the Collectors grid's Version and the details' Target Version
 * and Effective Version (and the group's details).
 *
 * - The name is a span of its own, then a real " " and `@v{n}`, so the
 *   link's text and accessible name are "{configurationName} @v{n}" in every
 *   browser; `@v{n}` is never cut.
 * - In a table (`variant="table"`) the name is an inline-block `truncate`
 *   span at most 16rem wide, and the link is a tooltip's trigger always
 *   (hover and keyboard focus): the full "{configurationName} @v{n}", then
 *   `meaning` as its second line when given (one tooltip per cell). In a
 *   dialog (`variant="dialog"`) the whole name shows, wrapping, with no
 *   tooltip.
 * - Text only: no `title`, no `aria-label`, no attribute holds the name.
 *   The tooltip's portal is in the signed-in shell's body, ph-mask.
 */

export interface PublishedVersionLinkProps {
  version: Pick<PublishedVersion, "configurationId" | "configurationName" | "versionId" | "versionNumber">;
  /** "table": truncated at 16rem, its full text in a tooltip; "dialog": the whole name, no tooltip. */
  variant?: "table" | "dialog";
  /** A table's tooltip's second line, after the full text: fixed words, never a name. */
  meaning?: string | undefined;
}

const LINK_CLASS =
  "text-[13px] text-brand hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/** The editor's route for a version, its ids encoded. */
export function editorPathOf(version: Pick<PublishedVersion, "configurationId" | "versionId">): string {
  return `/editor/${encodeURIComponent(version.configurationId)}/${encodeURIComponent(version.versionId)}`;
}

export function PublishedVersionLink({ version, variant = "table", meaning }: PublishedVersionLinkProps) {
  if (variant === "dialog") {
    return (
      <Link to={editorPathOf(version)} className={`${LINK_CLASS} [overflow-wrap:anywhere]`}>
        <span>{version.configurationName}</span> @v{version.versionNumber}
      </Link>
    );
  }
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to={editorPathOf(version)} className={`${LINK_CLASS} whitespace-nowrap`}>
            <span className="inline-block max-w-64 truncate align-bottom">{version.configurationName}</span> @v{version.versionNumber}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-96 [overflow-wrap:anywhere]">
          <p>
            {version.configurationName} @v{version.versionNumber}
          </p>
          {meaning !== undefined && <p>{meaning}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
