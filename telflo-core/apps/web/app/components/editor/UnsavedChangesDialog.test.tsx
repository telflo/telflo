import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";

function renderDialog({ isSaving = false }: { isSaving?: boolean } = {}) {
  const props = {
    onOpenChange: vi.fn(),
    onSaveAndContinue: vi.fn(async () => undefined),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
  };
  render(<UnsavedChangesDialog open {...props} isSaving={isSaving} />);
  return { ...props, user: userEvent.setup() };
}

describe("UnsavedChangesDialog", () => {
  it("has its copy and its three buttons, in order", async () => {
    renderDialog();
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });

    expect(dialog).toHaveAccessibleDescription("You have unsaved changes that will be lost. What would you like to do?");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Discard Changes",
      "Save & Continue",
    ]);
    for (const button of within(dialog).getAllByRole("button")) expect(button).toBeEnabled();
  });

  it("calls each button's handler", async () => {
    const { user, onCancel, onDiscard, onSaveAndContinue, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Save & Continue" }));
    expect(onSaveAndContinue).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says Saving... with every button disabled while saving", async () => {
    renderDialog({ isSaving: true });
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved Changes" });

    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Discard Changes" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save & Continue" })).toBeNull();
  });

  it("renders nothing while closed", () => {
    render(
      <UnsavedChangesDialog
        open={false}
        onOpenChange={vi.fn()}
        onSaveAndContinue={vi.fn(async () => undefined)}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
