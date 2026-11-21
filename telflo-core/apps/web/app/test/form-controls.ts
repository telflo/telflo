import { screen } from "@testing-library/react";

/*
 * The controls a rendered form shows, for the "opening writes nothing" tests:
 * they focus every text field, so each checks that it found the form's fields
 * and that opening its sections showed them, against a minimum per form. A
 * broken selector, a section that no longer opens or a form that renders
 * nothing then fails the test rather than passing over no fields.
 */

const OTHER_ROLES = ["checkbox", "combobox", "radio", "spinbutton"] as const;

/** The text fields shown, and the count of every control shown (text fields, boxes, selects, radios, number fields). */
export function formControls(): { textboxes: HTMLElement[]; all: number } {
  const textboxes = screen.queryAllByRole("textbox");
  const others = OTHER_ROLES.reduce((count, role) => count + screen.queryAllByRole(role).length, 0);
  return { textboxes, all: textboxes.length + others };
}
