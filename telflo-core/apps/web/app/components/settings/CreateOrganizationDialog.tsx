import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ImagePlus } from "lucide-react";
import {
  imageTypeOf,
  ORGANIZATION_LOGO_MAXIMUM_BYTES,
  ORGANIZATION_NAME_MAXIMUM_LENGTH,
  type ActiveOrganization,
} from "@telflo/contracts";
import { LogoImage, organizationInitials } from "~/components/org/OrganizationLogo.js";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Avatar, AvatarFallback } from "~/components/ui/avatar.js";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import {
  changeOrganizationWithLogo,
  createOrganization,
  createOrganizationWithLogo,
  organizationLogoPath,
  renameOrganization,
} from "~/lib/api-client.js";
import { blobBytes } from "~/lib/blob-bytes.js";
import { isManagementLost, refusalMessage, useLeaveManagement, useSwitchOrganization } from "~/lib/organizations.js";
import { useUserStore } from "~/lib/stores/user-store.js";

/*
 * Creating or editing an organization: no duplicate-name pre-check, since the
 * API's unique index is the check and its refusal carries the words; a group
 * organization's Edit dialog has "Delete Organization".
 *
 * The logo: PNG, JPEG or WebP, typed from its first bytes here
 * (`imageTypeOf`, as the API does again), at most 2 MB; SVG is refused. Save
 * sends ONE request, all or nothing: JSON with no picked file
 * (`removeLogo: true` when "Remove logo" was used), multipart with one.
 * "Remove logo" changes only the preview until Save. The preview is an object
 * URL, revoked when replaced, removed, on close and on unmount. The picked
 * file's name and the file input are inside `ph-no-capture`, and the image is
 * an `<img alt="">` inside it too, never named in an attribute.
 */

const MAX_NAME_LENGTH = ORGANIZATION_NAME_MAXIMUM_LENGTH;

/** The browser's own refusals, before sending ("2 MB", with the space). */
export const LOGO_TOO_LARGE_MESSAGE = "Logo must be less than 2 MB";
export const LOGO_TYPE_UNSUPPORTED_MESSAGE = "Logo must be a PNG, JPG or WebP image.";

/** What the picker offers; the bytes decide. */
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** Enough of a file's head for every signature `imageTypeOf` knows. */
const LOGO_HEAD_BYTES = 12;

/** The organization as it was when the dialog opened. */
interface Baseline {
  id: string;
  name: string;
  logoId: string | null;
}

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organization to rename; null to create one. */
  organization?: ActiveOrganization | null;
  /** Given for a group organization: opens the delete confirmation. */
  onDelete?: (() => void) | undefined;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  organization,
  onDelete,
}: CreateOrganizationDialogProps) {
  const switchTo = useSwitchOrganization();
  const leaveManagement = useLeaveManagement();
  const addOrganization = useUserStore((state) => state.addOrganization);
  const updateInStore = useUserStore((state) => state.updateOrganization);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /** The picked file's object URL, revoked when it is replaced or dropped. */
  const previewUrlRef = useRef<string | null>(null);
  /** Counts picks: a check that finishes after a later pick is dropped (the latest pick wins). */
  const pickSequenceRef = useRef(0);
  const wasOpenRef = useRef(false);

  const isEditMode = !!organization;

  /** Puts `file` in the preview, or nothing, revoking the URL it replaces. */
  const replacePick = (file: File | null) => {
    if (previewUrlRef.current !== null) URL.revokeObjectURL(previewUrlRef.current);
    const url = file === null ? null : URL.createObjectURL(file);
    previewUrlRef.current = url;
    setLogoFile(file);
    setLogoPreview(url);
  };

  const resetForm = () => {
    pickSequenceRef.current += 1;
    replacePick(null);
    setRemoveLogo(false);
    setIsChecking(false);
    setName("");
    setError(null);
  };

  // The baseline is taken when the dialog opens, never re-read from a prop a
  // parent's reload may change meanwhile. Closing, however it closes, drops
  // the pick and its object URL.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setBaseline(organization ? { id: organization.id, name: organization.name, logoId: organization.logoId } : null);
      if (organization) setName(organization.name);
    } else if (!open && wasOpenRef.current) {
      resetForm();
    }
    wasOpenRef.current = open;
    // Only the transitions of `open` matter; `organization` is read at them.
  }, [open]);

  // Unmounting revokes the picked file's object URL, and drops any check
  // still running, so a head read that finishes later makes no object URL.
  useEffect(
    () => () => {
      pickSequenceRef.current += 1;
      if (previewUrlRef.current !== null) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    },
    [],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so picking the same file again (after Remove logo) is a change.
    event.target.value = "";
    if (!file) return;
    const sequence = (pickSequenceRef.current += 1);

    if (file.size > ORGANIZATION_LOGO_MAXIMUM_BYTES) {
      setIsChecking(false);
      setError(LOGO_TOO_LARGE_MESSAGE);
      return;
    }

    setIsChecking(true);
    void blobBytes(file.slice(0, LOGO_HEAD_BYTES)).then(
      (head) => accept(sequence, file, imageTypeOf(head) !== undefined),
      () => accept(sequence, file, false),
    );
  };

  /** A pick's check, finished: kept only if no later pick came (or the dialog closed). */
  const accept = (sequence: number, file: File, isImage: boolean) => {
    if (sequence !== pickSequenceRef.current) return;
    setIsChecking(false);
    if (!isImage) {
      setError(LOGO_TYPE_UNSUPPORTED_MESSAGE);
      return;
    }
    setError(null);
    setRemoveLogo(false);
    replacePick(file);
  };

  const handleRemoveLogo = () => {
    pickSequenceRef.current += 1;
    setIsChecking(false);
    setError(null);
    replacePick(null);
    if (baseline?.logoId != null) setRemoveLogo(true);
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Organization name is required");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      if (organization) {
        const target = baseline ?? organization;
        const { organization: changed } =
          logoFile !== null
            ? await changeOrganizationWithLogo(target.id, trimmedName, logoFile)
            : await renameOrganization(target.id, removeLogo ? { name: trimmedName, removeLogo: true } : { name: trimmedName });
        updateInStore(changed.id, { name: changed.name, logoId: changed.logoId });
      } else {
        const { organization: created } =
          logoFile !== null
            ? await createOrganizationWithLogo(trimmedName, logoFile)
            : await createOrganization({ name: trimmedName });
        // Listed at once, so it stays listed if the switch below fails.
        addOrganization({ ...created, role: "admin" });
        // Auto-switch into the freshly-created organization, then land on
        // /app. A failed switch toasts; the organization exists either way,
        // so the dialog closes.
        await switchTo(created.id);
      }
      onOpenChange(false);
      resetForm();
    } catch (err) {
      // The organization was deleted, or switched away from, in another tab,
      // or the viewer is no longer its admin: this dialog can't go on.
      if (organization && isManagementLost(err)) {
        handleOpenChange(false);
        leaveManagement(err);
        return;
      }
      setError(refusalMessage(err, `Failed to ${isEditMode ? "update" : "create"} organization`));
    } finally {
      setIsLoading(false);
    }
  };

  // The preview: the picked file, else the current logo (unless marked
  // removed), else the initials, else the icon while the name is empty.
  const currentLogoSrc =
    baseline?.logoId != null && !removeLogo ? organizationLogoPath(baseline.id, baseline.logoId) : null;
  const previewSrc = logoPreview ?? currentLogoSrc;
  const showsLogo = logoFile !== null || currentLogoSrc !== null;

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Organization" : "Create Organization"}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update your organization name or logo."
              : "Set up your organization with a name and optional logo."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="organization-name">Organization Name</Label>
            <Input
              id="organization-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Corp"
              maxLength={MAX_NAME_LENGTH}
              autoFocus
              disabled={isLoading}
            />
            <p className="font-mono tabular-nums text-xs text-muted-foreground text-right">
              {name.length}/{MAX_NAME_LENGTH}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Company Logo</Label>
            <div className="flex items-center gap-4">
              <Avatar className="h-14 w-14">
                <LogoImage
                  src={previewSrc}
                  fallback={
                    <AvatarFallback className="bg-muted font-mono text-sm">
                      {name.trim() ? organizationInitials(name) : <ImagePlus className="h-5 w-5 text-muted-foreground" />}
                    </AvatarFallback>
                  }
                />
              </Avatar>
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                >
                  {logoFile ? "Change Image" : "Choose Image"}
                </Button>
                {logoFile && (
                  // The name as text, blocked from replay.
                  <p className="ph-no-capture text-xs text-muted-foreground">{logoFile.name}</p>
                )}
                {showsLogo && (
                  <Button type="button" variant="ghost" size="sm" onClick={handleRemoveLogo} disabled={isLoading}>
                    Remove logo
                  </Button>
                )}
                {/* Blocked from replay (`ph-no-capture`): rrweb records a file
                    input's value, "C:\fakepath\<the file's name>", as it
                    changes, whatever maskAllInputs says. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={LOGO_ACCEPT}
                  onChange={handleFileChange}
                  disabled={isLoading}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="hidden ph-no-capture"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">PNG, JPG or WebP. Max 2 MB.</p>
          </div>
        </div>

        <DialogFooter>
          {onDelete && (
            <Button
              type="button"
              variant="destructive"
              className="sm:mr-auto"
              onClick={() => {
                resetForm();
                onDelete();
              }}
              disabled={isLoading}
            >
              Delete Organization
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={isLoading || isChecking || !name.trim()}
          >
            {isLoading
              ? isEditMode ? "Saving..." : "Creating..."
              : isEditMode ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
