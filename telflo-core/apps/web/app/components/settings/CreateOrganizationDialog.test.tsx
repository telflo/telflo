import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type ActiveOrganization } from "@telflo/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  CreateOrganizationDialog,
  LOGO_TOO_LARGE_MESSAGE,
  LOGO_TYPE_UNSUPPORTED_MESSAGE,
} from "./CreateOrganizationDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import * as blobBytesModule from "~/lib/blob-bytes.js";
import { useUserStore } from "~/lib/stores/user-store.js";

const PERSONAL: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000002", name: "person", type: "personal", logoId: null, role: "admin" };
const GROUP: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000003", name: "Group", type: "group", logoId: null, role: "admin" };

function renderDialog(props: { organization?: ActiveOrganization | null; onDelete?: () => void } = {}) {
  const onOpenChange = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/settings/organization",
      Component: () => (
        <CreateOrganizationDialog open onOpenChange={onOpenChange} organization={props.organization ?? null} onDelete={props.onDelete} />
      ),
    },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/settings/organization"]} />);
  return { onOpenChange, user: userEvent.setup() };
}

describe("CreateOrganizationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().setCurrent({
      user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
      organization: PERSONAL,
      organizations: [PERSONAL],
      isProductAdmin: false,
      mayCreateOrganizations: true,
      preferences: DEFAULT_USER_PREFERENCES,
    });
    useUserStore.setState({ isSwitchingOrganization: false });
  });

  it("creates with its copy and its Company Logo block", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Create Organization" });

    expect(dialog).toHaveTextContent("Set up your organization with a name and optional logo.");
    expect(screen.getByLabelText("Organization Name")).toHaveAttribute("placeholder", "e.g., Acme Corp");
    expect(screen.getByText("0/100")).toBeInTheDocument();
    expect(screen.getByText("Company Logo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Image" })).toBeInTheDocument();
    expect(screen.getByText("PNG, JPG or WebP. Max 2 MB.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Organization" })).not.toBeInTheDocument();
  });

  it("edits with its copy, starting from the current name", async () => {
    renderDialog({ organization: GROUP });
    const dialog = await screen.findByRole("dialog", { name: "Edit Organization" });

    expect(dialog).toHaveTextContent("Update your organization name or logo.");
    expect(screen.getByLabelText("Organization Name")).toHaveValue("Group");
    expect(screen.getByText("5/100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("requires a name: Create stays disabled while it is empty or blank", async () => {
    const { user } = renderDialog();
    const create = await screen.findByRole("button", { name: "Create" });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Organization Name"), "   ");
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Organization Name"), "A");
    expect(create).toBeEnabled();
  });

  it("stops at 100 characters and counts them", async () => {
    const { user } = renderDialog();
    const input = await screen.findByLabelText("Organization Name");

    await user.type(input, "x".repeat(99));
    expect(screen.getByText("99/100")).toBeInTheDocument();
    await user.type(input, "yz");

    expect(input).toHaveValue("x".repeat(99) + "y");
    expect(screen.getByText("100/100")).toBeInTheDocument();
  });

  it("shows the API's refusal for a taken name, and stays open", async () => {
    vi.spyOn(apiClient, "createOrganization").mockRejectedValue(
      new ApiError("organization_name_taken", "That name is invalid or already exists"),
    );
    const switchOrganization = vi.spyOn(apiClient, "switchOrganization");
    const { user, onOpenChange } = renderDialog();

    await user.type(await screen.findByLabelText("Organization Name"), "Taken");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That name is invalid or already exists");
    expect(switchOrganization).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("shows the fallback when creating fails unexpectedly", async () => {
    vi.spyOn(apiClient, "createOrganization").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const { user } = renderDialog();

    await user.type(await screen.findByLabelText("Organization Name"), "Team");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to create organization");
  });

  it.each([
    { code: "organization_not_found", message: "Organization not found", why: "deleted or switched away from in another tab" },
    { code: "organization_admin_required", message: "Only an admin of this organization can do that", why: "demoted" },
  ])(
    "when a rename is refused with $code ($why), closes, toasts the API's message and goes to /app",
    async ({ code, message }) => {
      vi.spyOn(apiClient, "renameOrganization").mockRejectedValue(new ApiError(code, message));
      const error = vi.spyOn(toast, "error");
      const { user, onOpenChange } = renderDialog({ organization: GROUP });

      await user.click(await screen.findByRole("button", { name: "Save" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(error).toHaveBeenCalledWith(message);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(useUserStore.getState().current?.organizations).toEqual([PERSONAL]);
    },
  );

  it("shows the fallback when saving fails unexpectedly", async () => {
    vi.spyOn(apiClient, "renameOrganization").mockRejectedValue(
      new ApiError("unexpected_response", "The server returned an unexpected response."),
    );
    const { user } = renderDialog({ organization: GROUP });

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to update organization");
  });

  it("creates, lists the organization, then switches to it and goes to /app, saying Creating... meanwhile", async () => {
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "Team", type: "group", logoId: null } as const;
    vi.spyOn(apiClient, "createOrganization").mockResolvedValue({ organization: created });
    let finish!: () => void;
    const switchOrganization = vi.spyOn(apiClient, "switchOrganization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ organization: { ...created, role: "admin" } });
        }),
    );
    const { user, onOpenChange } = renderDialog();

    await user.type(await screen.findByLabelText("Organization Name"), "Team");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(switchOrganization).toHaveBeenCalledWith({ organizationId: created.id }));
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(useUserStore.getState().current?.organizations).toEqual([PERSONAL, { ...created, role: "admin" }]);
    expect(useUserStore.getState().isSwitchingOrganization).toBe(true);

    finish();
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renames with Save, trimmed, saying Saving... meanwhile, and closes", async () => {
    let finish!: () => void;
    const renameOrganization = vi.spyOn(apiClient, "renameOrganization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ organization: { id: GROUP.id, name: "Renamed", type: "group", logoId: null } });
        }),
    );
    const switchOrganization = vi.spyOn(apiClient, "switchOrganization");
    const { user, onOpenChange } = renderDialog({ organization: GROUP });
    const input = await screen.findByLabelText("Organization Name");

    await user.clear(input);
    await user.type(input, " Renamed ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(renameOrganization).toHaveBeenCalledWith(GROUP.id, { name: "Renamed" });
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(switchOrganization).not.toHaveBeenCalled();
  });

  it("calls onDelete from Delete Organization when it is given", async () => {
    const onDelete = vi.fn();
    const { user } = renderDialog({ organization: GROUP, onDelete });

    await user.click(await screen.findByRole("button", { name: "Delete Organization" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The logo.
// ---------------------------------------------------------------------------

const LOGO_ID = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const NEW_LOGO_ID = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
const GROUP_WITH_LOGO: ActiveOrganization = { ...GROUP, logoId: LOGO_ID };
const CURRENT_LOGO_SRC = `/api/v1/organization-logos/${GROUP.id}/${LOGO_ID}`;

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

/** A file of `size` bytes starting with `head`. */
function fileOf(name: string, head: readonly number[], size = 64, type = "image/png"): File {
  const bytes = new Uint8Array(size);
  bytes.set(head.slice(0, size));
  return new File([bytes], name, { type });
}

function png(name = "acme-logo.png", size = 64): File {
  return fileOf(name, PNG_HEAD, size);
}

function svg(name = "acme-logo.svg"): File {
  return new File([SVG_TEXT], name, { type: "image/svg+xml" });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("No file input");
  return input;
}

/** Picks `file` as a person does, past the input's accept list (the dialog's own checks are under test). */
async function pick(file: File): Promise<void> {
  await userEvent.setup({ applyAccept: false }).upload(fileInput(), file);
}

/** The preview's image, or null while it shows the initials or the icon. */
function previewImage(): HTMLImageElement | null {
  return screen.getByRole("dialog").querySelector("img");
}

/** Every attribute value in the document (the dialog's portal included). */
function attributeValues(): string[] {
  return [...document.querySelectorAll("*")].flatMap((element) => [...element.attributes].map((attribute) => attribute.value));
}

/**
 * The dialog opened on `initial`, its `organization` prop changeable while it
 * stays open (as a parent's reload would change it).
 */
function renderChangeable(initial: ActiveOrganization) {
  const onOpenChange = vi.fn();
  let change!: (organization: ActiveOrganization) => void;
  function Host() {
    const [organization, setOrganization] = useState(initial);
    change = setOrganization;
    return <CreateOrganizationDialog open onOpenChange={onOpenChange} organization={organization} />;
  }
  const Stub = createRoutesStub([
    { path: "/settings/organization", Component: Host },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/settings/organization"]} />);
  return { onOpenChange, change: (organization: ActiveOrganization) => act(() => change(organization)) };
}

describe("CreateOrganizationDialog's logo", () => {
  let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };

  beforeEach(() => {
    vi.restoreAllMocks();
    let made = 0;
    createObjectURL = vi.fn((_blob: Blob) => `blob:stub-${(made += 1)}`);
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    useUserStore.getState().setCurrent({
      user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
      organization: GROUP_WITH_LOGO,
      organizations: [PERSONAL, GROUP_WITH_LOGO],
      isProductAdmin: false,
      mayCreateOrganizations: true,
      preferences: DEFAULT_USER_PREFERENCES,
    });
    useUserStore.setState({ isSwitchingOrganization: false });
  });

  afterEach(() => {
    // Unmounted first: unmounting revokes, through the stub.
    cleanup();
    Object.assign(URL, original);
  });

  it("offers PNG, JPEG and WebP in a hidden input blocked from replay, and shows the icon until a name is typed, then the initials", async () => {
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    expect(fileInput()).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
    expect(fileInput()).toHaveClass("hidden", "ph-no-capture");
    expect(previewImage()).toBeNull();
    expect(screen.getByRole("dialog").querySelector(".lucide-image-plus")).not.toBeNull();

    await user.type(screen.getByLabelText("Organization Name"), "Acme Corp");

    expect(within(screen.getByRole("dialog")).getByText("AC")).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector(".lucide-image-plus")).toBeNull();
  });

  it("previews a picked PNG from an object URL inside ph-no-capture with alt \"\", names it as text inside ph-no-capture, and says Change Image", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    const file = png("acme-private-logo.png");

    await pick(file);

    const image = await waitFor(() => {
      const found = previewImage();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(image).toHaveAttribute("src", "blob:stub-1");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("ph-no-capture");
    expect(screen.getByRole("presentation")).toBe(image);
    const name = screen.getByText("acme-private-logo.png");
    expect(name.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Change Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove logo" })).toBeInTheDocument();
    // The file's name is text, never an attribute.
    expect(attributeValues().some((value) => value.includes("acme-private-logo"))).toBe(false);
  });

  it.each([
    { kind: "JPEG", file: () => fileOf("photo.jpg", JPEG_HEAD, 64, "image/jpeg") },
    { kind: "WebP", file: () => fileOf("photo.webp", WEBP_HEAD, 64, "image/webp") },
    { kind: "PNG of exactly 2 MB", file: () => png("big.png", 2_097_152) },
  ])("accepts a $kind", async ({ file }) => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(file());

    await waitFor(() => expect(previewImage()).not.toBeNull());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses a file over 2 MB before sending, in the error Alert, keeping the preview as it was", async () => {
    const create = vi.spyOn(apiClient, "createOrganizationWithLogo");
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), "Team");

    await pick(png("huge.png", 2_097_153));

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TOO_LARGE_MESSAGE);
    expect(LOGO_TOO_LARGE_MESSAGE).toBe("Logo must be less than 2 MB");
    expect(previewImage()).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose Image" })).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "an SVG", file: () => svg() },
    { kind: "an SVG named .png (typed from its bytes, never its name or the browser's type)", file: () => new File([SVG_TEXT], "logo.png", { type: "image/png" }) },
    { kind: "a GIF", file: () => fileOf("anim.gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 64, "image/gif") },
    { kind: "an empty file", file: () => new File([], "empty.png", { type: "image/png" }) },
  ])("refuses $kind before sending, in the error Alert", async ({ file }) => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(file());

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TYPE_UNSUPPORTED_MESSAGE);
    expect(LOGO_TYPE_UNSUPPORTED_MESSAGE).toBe("Logo must be a PNG, JPG or WebP image.");
    expect(previewImage()).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("clears a refusal when a good file is picked next", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(svg());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await pick(png());

    await waitFor(() => expect(previewImage()).not.toBeNull());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("revokes the replaced object URL when another file is picked, and shows the new one", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(png("first.png"));
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    await pick(png("second.png"));

    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-2"));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-1");
    expect(screen.getByText("second.png")).toBeInTheDocument();
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
  });

  it("lets the latest pick win when an earlier pick's check finishes after it", async () => {
    const real = blobBytesModule.blobBytes;
    let finishFirst!: () => void;
    vi.spyOn(blobBytesModule, "blobBytes")
      .mockImplementationOnce(
        (blob) =>
          new Promise((resolve) => {
            finishFirst = () => resolve(real(blob));
          }),
      )
      .mockImplementation(real);
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(png("first.png"));
    await pick(png("second.png"));
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    expect(screen.getByText("second.png")).toBeInTheDocument();

    finishFirst();
    // The first pick's check, finished late, changes nothing.
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ name: "second.png" }));
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
  });

  it("lets a later refused pick win over an earlier one still being checked, and keeps Create disabled while a check runs", async () => {
    const real = blobBytesModule.blobBytes;
    let finishFirst!: () => void;
    vi.spyOn(blobBytesModule, "blobBytes")
      .mockImplementationOnce(
        (blob) =>
          new Promise((resolve) => {
            finishFirst = () => resolve(real(blob));
          }),
      )
      .mockImplementation(real);
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), "Team");

    await pick(png("first.png"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await pick(svg());
    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TYPE_UNSUPPORTED_MESSAGE);
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

    finishFirst();
    await act(async () => {
      await Promise.resolve();
    });
    expect(previewImage()).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("drops a picked file with Remove logo on create: the URL revoked, the initials back, and Create sends JSON", async () => {
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "Team", type: "group", logoId: null } as const;
    const createOrganization = vi.spyOn(apiClient, "createOrganization").mockResolvedValue({ organization: created });
    const createWithLogo = vi.spyOn(apiClient, "createOrganizationWithLogo");
    vi.spyOn(apiClient, "switchOrganization").mockResolvedValue({ organization: { ...created, role: "admin" } });
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), "Team");
    await pick(png());
    await waitFor(() => expect(previewImage()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-1");
    expect(previewImage()).toBeNull();
    expect(within(screen.getByRole("dialog")).getByText("T")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Image" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(createOrganization).toHaveBeenCalledWith({ name: "Team" });
    expect(createWithLogo).not.toHaveBeenCalled();
  });

  it("creates with the picked logo in ONE multipart request, lists the organization with its logo id, then switches", async () => {
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "Team", type: "group", logoId: NEW_LOGO_ID } as const;
    const createWithLogo = vi.spyOn(apiClient, "createOrganizationWithLogo").mockResolvedValue({ organization: created });
    const createOrganization = vi.spyOn(apiClient, "createOrganization");
    const switchOrganization = vi
      .spyOn(apiClient, "switchOrganization")
      .mockResolvedValue({ organization: { ...created, role: "admin" } });
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), " Team ");
    const file = png();
    await pick(file);
    await waitFor(() => expect(previewImage()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(createWithLogo).toHaveBeenCalledTimes(1);
    expect(createWithLogo).toHaveBeenCalledWith("Team", file);
    expect(createOrganization).not.toHaveBeenCalled();
    expect(switchOrganization).toHaveBeenCalledWith({ organizationId: created.id });
    expect(useUserStore.getState().current?.organizations).toContainEqual({ ...created, role: "admin" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-1");
  });

  it("shows the API's refusal of a logo on create and stays open, creating nothing (all or nothing)", async () => {
    vi.spyOn(apiClient, "createOrganizationWithLogo").mockRejectedValue(
      new ApiError("organization_logo_type_unsupported", "The logo must be a PNG, JPEG or WebP image."),
    );
    const switchOrganization = vi.spyOn(apiClient, "switchOrganization");
    const before = useUserStore.getState().current?.organizations;
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), "Team");
    await pick(png());
    await waitFor(() => expect(previewImage()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The logo must be a PNG, JPEG or WebP image.");
    expect(switchOrganization).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(useUserStore.getState().current?.organizations).toEqual(before);
    // The pick stays, to Save again or change.
    expect(previewImage()).toHaveAttribute("src", "blob:stub-1");
  });

  it("shows the current logo in Edit inside ph-no-capture with alt \"\", with Remove logo", async () => {
    renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });

    await waitFor(() => expect(previewImage()).toHaveAttribute("src", CURRENT_LOGO_SRC));
    expect(previewImage()).toHaveAttribute("alt", "");
    expect(previewImage()).toHaveClass("ph-no-capture");
    expect(screen.getByRole("button", { name: "Choose Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove logo" })).toBeInTheDocument();
  });

  it("offers no Remove logo in Edit when there is no logo", async () => {
    renderDialog({ organization: GROUP });
    await screen.findByRole("dialog", { name: "Edit Organization" });

    expect(previewImage()).toBeNull();
    expect(within(screen.getByRole("dialog")).getByText("G")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
  });

  it("marks the current logo removed with Remove logo: the initials show, and Save sends removeLogo in one JSON request", async () => {
    const renameOrganization = vi
      .spyOn(apiClient, "renameOrganization")
      .mockResolvedValue({ organization: { id: GROUP.id, name: "Group", type: "group", logoId: null } });
    const changeWithLogo = vi.spyOn(apiClient, "changeOrganizationWithLogo");
    const { user, onOpenChange } = renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await waitFor(() => expect(previewImage()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    expect(previewImage()).toBeNull();
    expect(within(screen.getByRole("dialog")).getByText("G")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    expect(renameOrganization).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(renameOrganization).toHaveBeenCalledTimes(1);
    expect(renameOrganization).toHaveBeenCalledWith(GROUP.id, { name: "Group", removeLogo: true });
    expect(changeWithLogo).not.toHaveBeenCalled();
    expect(useUserStore.getState().current?.organization.logoId).toBeNull();
    expect(useUserStore.getState().current?.organizations[1]?.logoId).toBeNull();
  });

  it("after Remove logo, previews a picked file and Save sends that file in one multipart request (no removeLogo JSON)", async () => {
    const changeWithLogo = vi
      .spyOn(apiClient, "changeOrganizationWithLogo")
      .mockResolvedValue({ organization: { id: GROUP.id, name: "Renamed", type: "group", logoId: NEW_LOGO_ID } });
    const renameOrganization = vi.spyOn(apiClient, "renameOrganization");
    const { user, onOpenChange } = renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await waitFor(() => expect(previewImage()).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    const input = screen.getByLabelText("Organization Name");
    await user.clear(input);
    await user.type(input, "Renamed");
    const file = png();

    await pick(file);
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(changeWithLogo).toHaveBeenCalledTimes(1);
    expect(changeWithLogo).toHaveBeenCalledWith(GROUP.id, "Renamed", file);
    expect(renameOrganization).not.toHaveBeenCalled();
    const stored = useUserStore.getState().current;
    expect(stored?.organization).toEqual({ ...GROUP, name: "Renamed", logoId: NEW_LOGO_ID });
    expect(stored?.organizations[1]).toEqual({ ...GROUP, name: "Renamed", logoId: NEW_LOGO_ID });
  });

  it("removes a picked file in Edit back to the current logo, which Remove logo then marks removed", async () => {
    const { user } = renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await pick(png());
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));

    // Remove logo clears the pick and, with a current logo, marks it removed.
    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-1");
    expect(previewImage()).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
  });

  it("shows the API's refusal of a logo on Save and stays open, changing nothing in the store", async () => {
    vi.spyOn(apiClient, "changeOrganizationWithLogo").mockRejectedValue(
      new ApiError("organization_logo_too_large", "The logo must be 2 MB or smaller."),
    );
    const { user, onOpenChange } = renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await pick(png());
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The logo must be 2 MB or smaller.");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(useUserStore.getState().current?.organization).toEqual(GROUP_WITH_LOGO);
  });

  it("keeps the baseline taken at opening when the organization prop changes while open", async () => {
    const renameOrganization = vi
      .spyOn(apiClient, "renameOrganization")
      .mockResolvedValue({ organization: { id: GROUP.id, name: "Group", type: "group", logoId: null } });
    const { change, onOpenChange } = renderChangeable(GROUP_WITH_LOGO);
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", CURRENT_LOGO_SRC));

    change({ ...GROUP, name: "Reloaded Name", logoId: NEW_LOGO_ID });

    expect(screen.getByLabelText("Organization Name")).toHaveValue("Group");
    expect(previewImage()).toHaveAttribute("src", CURRENT_LOGO_SRC);
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove logo" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(renameOrganization).toHaveBeenCalledWith(GROUP.id, { name: "Group", removeLogo: true });
  });

  it("refuses a pick whose first bytes can't be read, with the type Alert and no preview", async () => {
    vi.spyOn(blobBytesModule, "blobBytes").mockRejectedValue(new Error("unreadable"));
    renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });

    await pick(png());

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TYPE_UNSUPPORTED_MESSAGE);
    expect(previewImage()).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("shows the same file again when it is picked again after Remove logo (the input is emptied after each pick)", async () => {
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    const file = png("same.png");

    await pick(file);
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    expect(fileInput().value).toBe("");
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(previewImage()).toBeNull();

    await pick(file);

    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-2"));
    expect(screen.getByText("same.png")).toBeInTheDocument();
  });

  it("keeps an accepted PNG when a later SVG is refused: the Alert shows, the PNG stays previewed, and Save sends it", async () => {
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "Team", type: "group", logoId: NEW_LOGO_ID } as const;
    const createWithLogo = vi.spyOn(apiClient, "createOrganizationWithLogo").mockResolvedValue({ organization: created });
    vi.spyOn(apiClient, "switchOrganization").mockResolvedValue({ organization: { ...created, role: "admin" } });
    const { user } = renderDialog();
    await screen.findByRole("dialog", { name: "Create Organization" });
    await user.type(screen.getByLabelText("Organization Name"), "Team");
    const file = png("kept.png");
    await pick(file);
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));

    await pick(svg());

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TYPE_UNSUPPORTED_MESSAGE);
    expect(previewImage()).toHaveAttribute("src", "blob:stub-1");
    expect(screen.getByText("kept.png")).toBeInTheDocument();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(createWithLogo).toHaveBeenCalledTimes(1);
    expect(createWithLogo).toHaveBeenCalledWith("Team", file);
  });

  it("clears the Alert when Remove logo is clicked", async () => {
    const { user } = renderDialog({ organization: GROUP_WITH_LOGO });
    await screen.findByRole("dialog", { name: "Edit Organization" });
    await pick(svg());
    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TYPE_UNSUPPORTED_MESSAGE);

    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(previewImage()).toBeNull();
  });

  it("makes no object URL for a head read that finishes after the dialog unmounted", async () => {
    let finish!: () => void;
    vi.spyOn(blobBytesModule, "blobBytes").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // A PNG's head: the check would accept it.
          finish = () => resolve(new Uint8Array(PNG_HEAD));
        }),
    );
    const Stub = createRoutesStub([
      { path: "/settings/organization", Component: () => <CreateOrganizationDialog open onOpenChange={vi.fn()} organization={null} /> },
    ]);
    const { unmount } = render(<Stub initialEntries={["/settings/organization"]} />);
    await screen.findByRole("dialog", { name: "Create Organization" });
    await pick(png());
    await waitFor(() => expect(finish).toBeTypeOf("function"));

    unmount();
    finish();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes the picked file's object URL on Cancel and on unmount, and Cancel undoes Remove logo", async () => {
    const onOpenChange = vi.fn();
    let setOpen!: (open: boolean) => void;
    function Host() {
      const [open, set] = useState(true);
      setOpen = set;
      return (
        <CreateOrganizationDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            set(next);
          }}
          organization={GROUP_WITH_LOGO}
        />
      );
    }
    const Stub = createRoutesStub([{ path: "/settings/organization", Component: Host }]);
    const { unmount } = render(<Stub initialEntries={["/settings/organization"]} />);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Edit Organization" });

    await pick(png());
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-1"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-1");

    // Opened again: the current logo, nothing picked, nothing marked.
    act(() => setOpen(true));
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", CURRENT_LOGO_SRC));
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(previewImage()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => setOpen(true));
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", CURRENT_LOGO_SRC));

    await pick(png());
    await waitFor(() => expect(previewImage()).toHaveAttribute("src", "blob:stub-2"));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub-2");
  });
});
