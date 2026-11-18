import type { VariableGroupInUseDetails, VariableInUseDetails } from "@telflo/contracts";
import {
  describeGroupUse,
  describeVersionUse,
  groupsLeftOut,
  moreGroupsText,
  moreVersionsText,
  pinnedCollectorsLine,
  versionGroupsLeftOut,
  versionsLeftOut,
} from "~/lib/variables.js";

/*
 * What a refused delete or rename lists (D20 decision 6, default 21; Q102;
 * Ruling 50): the opamp-server's 409 details, with the platform's names
 * beside its ids, at most 100 uses, then "… and M more collector groups"
 * when a version's groups were cut short (every version listed) or "… and N
 * more published versions" (some left out), from the exact totals, never
 * both. A name the API couldn't look up came back null and
 * reads in fixed words ("a published version of a deleted configuration",
 * "another fleet", "a group"). Names are configuration text: the lists sit
 * inside `ph-no-capture` (replay records nothing of them), as text only,
 * never in an attribute; the keys are ids.
 */

const BOX_CLASS = "ph-no-capture rounded-md border border-fail/25 bg-fail-soft p-3 text-[13px] text-fail";

/** A variable's uses: the published versions a collector group or a collector uses that reference it. */
export function VariableInUseList({ details }: { details: VariableInUseDetails }) {
  const more = versionsLeftOut(details);
  // A version's groups cut short by the 100 entries (they count group rows): the rest said from the exact total, only
  // while every version is listed. With versions left out, the total also counts their groups, which "… and N more
  // published versions" already covers: one "more" line then, never two counting the same uses (Task 13's review).
  const moreGroups = more > 0 ? 0 : versionGroupsLeftOut(details);
  return (
    <div className={BOX_CLASS}>
      <p className="mb-1 font-medium">Used by these published versions:</p>
      <ul className="list-inside list-disc space-y-0.5 text-fail/90">
        {details.usedBy.map((use) => (
          <li key={use.publishedVersionId}>{describeVersionUse(use)}</li>
        ))}
      </ul>
      {moreGroups > 0 && <p className="mt-1 text-fail/90">{moreGroupsText(moreGroups)}</p>}
      {more > 0 && <p className="mt-1 text-fail/90">{moreVersionsText(more)}</p>}
    </div>
  );
}

/** A variable group's uses: the collector groups bound to it, and how many collectors have it pinned. */
export function VariableGroupInUseList({ details }: { details: VariableGroupInUseDetails }) {
  const more = groupsLeftOut(details);
  return (
    <div className={BOX_CLASS}>
      <p className="mb-1 font-medium">Used by:</p>
      <ul className="list-inside list-disc space-y-0.5 text-fail/90">
        {details.collectorGroups.map((group) => (
          <li key={`${group.fleetId}/${group.groupId}`}>{describeGroupUse(group)}</li>
        ))}
        {details.pinnedCollectors > 0 && <li>{pinnedCollectorsLine(details.pinnedCollectors)}</li>}
      </ul>
      {more > 0 && <p className="mt-1 text-fail/90">{moreGroupsText(more)}</p>}
    </div>
  );
}
