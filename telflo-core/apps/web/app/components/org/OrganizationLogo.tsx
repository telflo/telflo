import { useState, type ReactNode } from "react";
import { AvatarImage } from "~/components/ui/avatar.js";
import { organizationLogoPath } from "~/lib/api-client.js";

/*
 * An organization's logo: EITHER the image OR the fallback (the initials),
 * never both. The image is AvatarImage's `<img alt="">` with `ph-no-capture`
 * on the element itself (AvatarImage's own classes), so replay records
 * nothing of it, and no attribute names the organization. If the image fails
 * to load, the fallback shows instead; a new source (a new logo id, a new
 * pick) shows the image again.
 */

/** Up to `count` initials of a name, upper case: the first letter of each word. */
export function organizationInitials(name: string, count = 2): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, count);
}

/** The image's address for an organization's logo, or null for none (ids only). */
export function organizationLogoSource(organization: { id: string; logoId: string | null }): string | null {
  return organization.logoId === null ? null : organizationLogoPath(organization.id, organization.logoId);
}

interface LogoImageProps {
  /** The image's address (a logo's public path or a picked file's object URL), or null for the fallback. */
  src: string | null;
  /** The image's own classes (each place's size and shape). */
  imageClassName?: string;
  /** What shows when there is no image, or it failed to load. */
  fallback: ReactNode;
}

/** The image when there is one and it loaded, else the fallback. */
export function LogoImage({ src, imageClassName, fallback }: LogoImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src === null || failedSrc === src) return <>{fallback}</>;
  return (
    <AvatarImage
      src={src}
      {...(imageClassName === undefined ? {} : { className: imageClassName })}
      onError={() => setFailedSrc(src)}
    />
  );
}

interface OrganizationLogoProps {
  organization: { id: string; logoId: string | null };
  imageClassName?: string;
  fallback: ReactNode;
}

/** An organization's logo by its ids, else the fallback. */
export function OrganizationLogo({ organization, imageClassName, fallback }: OrganizationLogoProps) {
  return (
    <LogoImage
      src={organizationLogoSource(organization)}
      {...(imageClassName === undefined ? {} : { imageClassName })}
      fallback={fallback}
    />
  );
}
