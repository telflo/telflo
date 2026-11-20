import { useId, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { ORGANIZATION_CREATION_RESTRICTED_MESSAGE, type ActiveOrganization } from "@telflo/contracts";
import { OrganizationLogo, organizationInitials } from "~/components/org/OrganizationLogo.js";
import { Avatar, AvatarFallback } from "~/components/ui/avatar.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardHeader, CardTitle } from "~/components/ui/card.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { CreateOrganizationDialog } from "./CreateOrganizationDialog.js";
import { DeleteOrganizationDialog } from "./DeleteOrganizationDialog.js";

/*
 * The organization section: "Edit" only on the current organization, since
 * renaming acts on the active one. A group organization's Edit dialog also
 * offers "Delete Organization". The logo is an `<img alt="">` inside
 * `ph-no-capture`, so no alt holds the organization's name.
 */

// Section in Settings → Organization. Lists every organization the user
// belongs to, each in its own card. The standalone "+ Create Organization"
// button creates a new group organization and switches the user into it;
// it is disabled, with the reason beside it, while the site lets only
// product admins create organizations and the user isn't one.
export function EditOrganization() {
  const current = useCurrentUser();
  const [editTarget, setEditTarget] = useState<ActiveOrganization | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ActiveOrganization | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const organizations = current?.organizations ?? [];
  const currentOrganizationId = current?.organization.id ?? null;
  // The product admins' switch, as `/me` read it: the button stays, disabled,
  // with the reason in fixed words. The API checks again.
  const mayCreate = current?.mayCreateOrganizations !== false;
  const restrictedId = useId();

  // Personal organizations first (the user's own workspace), then group
  // organizations alphabetically.
  const ordered = [...organizations].sort((a, b) => {
    if (a.type !== b.type) return a.type === "personal" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <div className="mt-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Organizations</h2>
          <p className="text-[13px] text-muted-foreground">
            Your personal workspace plus any group organizations you belong to.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={!mayCreate}
          aria-describedby={mayCreate ? undefined : restrictedId}
        >
          <Plus className="h-3.5 w-3.5" />
          Create Organization
        </Button>
      </div>
      {!mayCreate && (
        <p id={restrictedId} className="mt-2 text-right text-xs text-muted-foreground">
          {ORGANIZATION_CREATION_RESTRICTED_MESSAGE}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {ordered.map((organization) => {
          const isCurrent = organization.id === currentOrganizationId;
          return (
            <Card key={organization.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="h-9 w-9 shrink-0">
                      <OrganizationLogo
                        organization={organization}
                        fallback={
                          <AvatarFallback className="bg-muted font-mono text-xs">
                            {organizationInitials(organization.name)}
                          </AvatarFallback>
                        }
                      />
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <CardTitle className="min-w-0 truncate">
                          {organization.name}
                        </CardTitle>
                        {organization.type === "personal" && (
                          <Badge variant="secondary">
                            Personal
                          </Badge>
                        )}
                        {isCurrent && (
                          <Badge variant="info">
                            Current
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  {isCurrent && organization.role === "admin" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditTarget(organization)}
                      className="shrink-0"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>
          );
        })}
      </div>

      <CreateOrganizationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        organization={null}
      />
      <CreateOrganizationDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        organization={editTarget}
        onDelete={
          editTarget?.type === "group"
            ? () => {
                setDeleteTarget(editTarget);
                setEditTarget(null);
              }
            : undefined
        }
      />
      <DeleteOrganizationDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        organization={deleteTarget}
      />
    </>
  );
}
