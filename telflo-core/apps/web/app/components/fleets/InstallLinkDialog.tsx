import { useState } from "react";
import type { QuickDeployLink } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { groupWords, installWords } from "./InstallLinksSection.js";

/*
 * View: the link's options as what the link installs: the group, the install
 * (method, arch, " · systemd"), the root path, the executable path (own
 * otelcol-contrib only), "Systemd service: yes/no" and the variables the link
 * holds values for, each by its name and "set". Never a value, the secret or
 * the command (the platform keeps the values sealed and the secret only as
 * its hash: the command is shown once, at its making). It makes no request:
 * the link is the row's, as the opening found it (a snapshot: a reload behind
 * the dialog changes nothing in it). The body is configuration text: inside
 * `ph-no-capture`, never in an attribute. A fixed title, "Install link";
 * "Close". A Helm values link's: Group (by its role), Install ("Helm
 * values"), Release and Namespace (as at the link's making), Variables.
 */

export const INSTALL_LINK_DESCRIPTION = "What this link installs. The values typed for its variables are kept with it and not shown.";

export interface InstallLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row's link, as the opening found it. */
  link: QuickDeployLink | null;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session, its link a snapshot taken at the opening. */
export function InstallLinkDialog(props: InstallLinkDialogProps) {
  const opening = useOpeningKey(props.open);
  return <InstallLinkSession key={opening} {...props} />;
}

function InstallLinkSession({ open, onOpenChange, link: opened, onCloseAutoFocus }: InstallLinkDialogProps) {
  const [link] = useState(opened);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Install link</DialogTitle>
          <DialogDescription>{INSTALL_LINK_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {link !== null && (
          <div className="ph-no-capture grid gap-3 text-[13px]">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Group</dt>
              <dd className="text-foreground">{groupWords(link)}</dd>
              <dt className="text-muted-foreground">Install</dt>
              <dd className="text-foreground">{installWords(link.choices)}</dd>
              {link.choices.kind === "helm" ? (
                <>
                  <dt className="text-muted-foreground">Release</dt>
                  <dd className="break-all font-mono text-xs text-foreground">{link.choices.release}</dd>
                  <dt className="text-muted-foreground">Namespace</dt>
                  <dd className="break-all font-mono text-xs text-foreground">{link.choices.namespace}</dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">Root path</dt>
                  <dd className="break-all font-mono text-xs text-foreground">{link.choices.rootPath}</dd>
                  {link.choices.executablePath !== null && (
                    <>
                      <dt className="text-muted-foreground">Executable path</dt>
                      <dd className="break-all font-mono text-xs text-foreground">{link.choices.executablePath}</dd>
                    </>
                  )}
                </>
              )}
            </dl>
            {link.choices.kind !== "helm" && <p className="text-foreground">Systemd service: {link.choices.systemd ? "yes" : "no"}</p>}
            <div className="grid gap-1.5">
              <p className="font-medium text-foreground">Variables</p>
              {link.choices.envNames.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="grid gap-1">
                  {link.choices.envNames.map((name) => (
                    <li key={name} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5">
                      <span className="break-all font-mono text-xs text-foreground">{name}</span>
                      <span className="text-xs text-muted-foreground">set</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
