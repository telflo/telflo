import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * The `helm uninstall` lines (D17d-2 decision 25; Preflight ruling 31): a
 * Kubernetes fleet's collector delete, bulk delete, group delete and the
 * namespace-change warning say how to stop the pods, with the quoted
 * command (`helmUninstallCommand`) in a `SecretCopyBox`: the release and the
 * namespace are configuration text, so inside `ph-no-capture` and never in
 * an attribute, the copy button named by fixed words. The callers snapshot
 * the commands at the opening and place this outside their
 * `AlertDialogDescription` (a command isn't a description).
 */

export const COLLECTOR_UNINSTALL_WORDS = "To stop it, uninstall its group's Helm release: this removes all of the group's pods, not just this one.";
export const BULK_UNINSTALL_WORDS = "To stop them, uninstall their groups' Helm releases: this removes all of each group's pods.";

/** `bulk`: the bulk delete's box, one line a group, "Copy uninstall commands" however many. */
export function HelmUninstall({ words, commands, bulk = false }: { words?: string | undefined; commands: readonly string[]; bulk?: boolean }) {
  if (commands.length === 0) return null;
  return (
    <div className="grid gap-2 text-[13px]">
      {words !== undefined && <p className="text-muted-foreground">{words}</p>}
      <SecretCopyBox
        secret={commands.join("\n")}
        copyLabel={bulk ? "Copy uninstall commands" : "Copy uninstall command"}
        multiline={bulk}
      />
    </div>
  );
}
