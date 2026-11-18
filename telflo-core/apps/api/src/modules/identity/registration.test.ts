import { describe, expect, it } from "vitest";
import {
  allowsRegistration,
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_INVITE_ONLY_MESSAGE,
  registrationGate,
  registrationNotOpen,
} from "./registration.js";

describe("the registration modes (D36-1 decision 35)", () => {
  it("lets an account be made: open by either way, invite-only from an invitation only, closed by neither", () => {
    expect({
      open: [allowsRegistration("open", "self"), allowsRegistration("open", "invitation")],
      inviteOnly: [allowsRegistration("invite-only", "self"), allowsRegistration("invite-only", "invitation")],
      closed: [allowsRegistration("closed", "self"), allowsRegistration("closed", "invitation")],
    }).toEqual({ open: [true, true], inviteOnly: [false, true], closed: [false, false] });
  });

  it("refuses with 403 registration_not_open in each mode's fixed words", () => {
    expect(registrationNotOpen("invite-only")).toMatchObject({
      code: "registration_not_open",
      statusCode: 403,
      message: REGISTRATION_INVITE_ONLY_MESSAGE,
    });
    expect(registrationNotOpen("closed")).toMatchObject({
      code: "registration_not_open",
      statusCode: 403,
      message: REGISTRATION_CLOSED_MESSAGE,
    });
  });

  it("its gate lets the request through where the mode allows the kind, and throws the refusal where it doesn't", async () => {
    const run = (gate: ReturnType<typeof registrationGate>) => gate({} as never, {} as never);
    await expect(run(registrationGate("open", "self"))).resolves.toBeUndefined();
    await expect(run(registrationGate("invite-only", "invitation"))).resolves.toBeUndefined();
    await expect(run(registrationGate("invite-only", "self"))).rejects.toMatchObject({ code: "registration_not_open" });
    await expect(run(registrationGate("closed", "invitation"))).rejects.toMatchObject({
      code: "registration_not_open",
      message: REGISTRATION_CLOSED_MESSAGE,
    });
  });
});
