import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar.js";
import { LogoImage, OrganizationLogo, organizationInitials, organizationLogoSource } from "./OrganizationLogo.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
const LOGO_ID = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const NEW_LOGO_ID = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";

function renderLogo(logoId: string | null) {
  return render(
    <Avatar className="h-9 w-9 shrink-0">
      <OrganizationLogo
        organization={{ id: ORGANIZATION_ID, logoId }}
        fallback={<AvatarFallback>AC</AvatarFallback>}
      />
    </Avatar>,
  );
}

describe("AvatarImage", () => {
  it("is a plain <img alt=\"\"> (presentational), aspect-square and full size, taking onError", () => {
    let failed = 0;
    render(<AvatarImage src="/x.png" className="extra" onError={() => (failed += 1)} />);
    const image = screen.getByRole("presentation");

    expect(image.tagName).toBe("IMG");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("aspect-square", "h-full", "w-full", "extra");
    fireEvent.error(image);
    expect(failed).toBe(1);
  });

  it("owns ph-no-capture, alt \"\" and fetchpriority low, whatever a caller passes", () => {
    // A caller that slips past the props' type (a cast, a spread object) still cannot drop them.
    const sneaky = { alt: "Acme", fetchPriority: "high" } as unknown as Record<string, never>;
    render(<AvatarImage src="/x.png" className="extra" {...sneaky} />);
    const image = screen.getByRole("presentation");

    expect(image).toHaveClass("ph-no-capture", "extra");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("fetchpriority", "low");
  });
});

describe("OrganizationLogo", () => {
  it("shows the initials alone when there is no logo", () => {
    const { container } = renderLogo(null);

    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the image alone, by ids, alt \"\" and ph-no-capture on the <img> itself", () => {
    renderLogo(LOGO_ID);
    const image = screen.getByRole("presentation");

    expect(image).toHaveAttribute("src", `/api/v1/organization-logos/${ORGANIZATION_ID}/${LOGO_ID}`);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("ph-no-capture");
    expect(screen.queryByText("AC")).not.toBeInTheDocument();
  });

  it("falls back to the initials when the image fails to load, and shows a new logo id's image again", () => {
    const { rerender } = renderLogo(LOGO_ID);

    fireEvent.error(screen.getByRole("presentation"));

    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
    expect(screen.getByText("AC")).toBeInTheDocument();

    rerender(
      <Avatar className="h-9 w-9 shrink-0">
        <OrganizationLogo
          organization={{ id: ORGANIZATION_ID, logoId: NEW_LOGO_ID }}
          fallback={<AvatarFallback>AC</AvatarFallback>}
        />
      </Avatar>,
    );

    expect(screen.getByRole("presentation")).toHaveAttribute(
      "src",
      `/api/v1/organization-logos/${ORGANIZATION_ID}/${NEW_LOGO_ID}`,
    );
    expect(screen.queryByText("AC")).not.toBeInTheDocument();
  });

  it("takes the place's own image classes", () => {
    render(<LogoImage src="/logo" imageClassName="h-5 w-5 rounded-[4px] object-contain shrink-0" fallback={null} />);

    expect(screen.getByRole("presentation")).toHaveClass("h-5", "w-5", "rounded-[4px]", "object-contain", "shrink-0", "ph-no-capture");
  });

  it("builds the address from ids only, and none without a logo id", () => {
    expect(organizationLogoSource({ id: ORGANIZATION_ID, logoId: LOGO_ID })).toBe(
      `/api/v1/organization-logos/${ORGANIZATION_ID}/${LOGO_ID}`,
    );
    expect(organizationLogoSource({ id: ORGANIZATION_ID, logoId: null })).toBeNull();
  });

  it("takes the first letter of each of the first two words, upper case", () => {
    expect(organizationInitials("Beta Team")).toBe("BT");
    expect(organizationInitials("acme corp holdings")).toBe("AC");
    expect(organizationInitials("person", 1)).toBe("P");
  });
});
