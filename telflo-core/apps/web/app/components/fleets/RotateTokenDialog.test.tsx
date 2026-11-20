import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type EnrollmentTokenListed,
  type EnrollmentTokenRotatedResponse,
  type FleetRotateToken,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { DEFAULT_TOKEN_ID, expectTextOnlyInsideNoCapture, FLEET_ID, listedToken, REPLACED_TOKEN_ID, ROTATE_TOKEN_ID } from "~/test/fleets.js";
import {
  addLocalDays,
  defaultGraceDate,
  endOfLocalDay,
  GRACE_AFTER_EXPIRY,
  GRACE_HELP,
  GRACE_LABEL,
  GRACE_PAST,
  GRACE_REQUIRED,
  graceDetailWords,
  graceOf,
  localDateOf,
  NO_PREDECESSOR_FORM,
  NO_PREDECESSOR_RESULT,
  replacedStopsAt,
  ROTATE_DESCRIPTION,
  ROTATE_FAILED_MESSAGE,
  ROTATE_INFO,
  ROTATED_BEARER_HINT,
  ROTATED_NO_ACTION,
  RotateTokenDialog,
  soonerExpiryWords,
} from "./RotateTokenDialog.js";

/*
 * Rotate. Its date math runs in the person's time zone: every test pins
 * `process.env.TZ` and restores it after.
 */

const ORIGINAL_TZ = process.env.TZ;
function inTimeZone(zone: string) {
  process.env.TZ = zone;
}
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const DAY = 86_400_000;

describe("the grace's date math", () => {
  // Days around each zone's daylight-saving changes in 2026 and 2027, and a few fixed ones.
  const DAYS = ["2026-03-08", "2026-03-29", "2026-04-04", "2026-04-05", "2026-09-05", "2026-09-06", "2026-09-27", "2026-10-04", "2026-10-25", "2026-11-01", "2026-12-31", "2027-02-28", "2028-02-29"];
  const ZONES = ["America/Santiago", "America/New_York", "Europe/London", "Asia/Kolkata", "Pacific/Auckland", "UTC"];

  it.each(ZONES)("ends each local day at its last millisecond, the next one the next day's first, in %s", (zone) => {
    inTimeZone(zone);
    for (const date of DAYS) {
      const end = endOfLocalDay(date)!;
      expect(localDateOf(end), `${zone} ${date}`).toBe(date);
      expect(localDateOf(end + 1), `${zone} ${date}`).toBe(addLocalDays(date, 1));
    }
  });

  it("isn't a wall-clock 23:59:59 where the clocks fall back at midnight (Santiago, 2026-04-04)", () => {
    inTimeZone("America/Santiago");
    const end = endOfLocalDay("2026-04-04")!;
    const wall = new Date(2026, 3, 4, 23, 59, 59, 999).getTime();
    // The day has 25 hours: its last millisecond is an hour after the first 23:59:59.999.
    expect(end - wall).toBe(60 * 60 * 1000);
    expect(localDateOf(wall + 1)).toBe("2026-04-04");
  });

  it.each(ZONES)("adds 30 calendar days to each day of 400, never skipping or repeating one across a change, in %s", (zone) => {
    inTimeZone(zone);
    for (let day = 0; day < 400; day += 1) {
      const date = addLocalDays("2026-01-01", day);
      const later = addLocalDays(date, 30);
      expect(Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY), date).toBe(30);
    }
  });

  it.each(ZONES)("checks a date: required, in the future (today accepted), the last allowed day accepted and capped, the day after refused, in %s", (zone) => {
    inTimeZone(zone);
    // 23:50 local: ten minutes of today are left.
    const now = new Date(2026, 9, 15, 23, 50).getTime();
    const today = localDateOf(now);
    expect(today).toBe("2026-10-15");
    expect(graceOf("", null, now)).toEqual({ problem: GRACE_REQUIRED });
    expect(graceOf("2026-02-30", null, now)).toEqual({ problem: GRACE_REQUIRED });
    expect(graceOf("not a date", null, now)).toEqual({ problem: GRACE_REQUIRED });
    expect(graceOf(addLocalDays(today, -1), null, now)).toEqual({ problem: GRACE_PAST });
    expect(graceOf(today, null, now)).toEqual({ graceEndsAt: endOfLocalDay(today) });

    // The 1 year preset: its expiry's own local date is the last day,
    // accepted though its time of day is earlier than the day's end.
    const expiresAt = now + 365 * DAY;
    const lastDay = localDateOf(expiresAt);
    expect(graceOf(lastDay, expiresAt, now)).toEqual({ graceEndsAt: expiresAt });
    expect(graceOf(addLocalDays(lastDay, -1), expiresAt, now)).toEqual({ graceEndsAt: endOfLocalDay(addLocalDays(lastDay, -1)) });
    expect(graceOf(addLocalDays(lastDay, 1), expiresAt, now)).toEqual({ problem: GRACE_AFTER_EXPIRY });
  });

  it("refuses a day that ended a moment ago, today included once it is over", () => {
    inTimeZone("Asia/Kolkata");
    const endOfToday = endOfLocalDay("2026-10-15")!;
    expect(graceOf("2026-10-15", null, endOfToday)).toEqual({ problem: GRACE_PAST });
    expect(graceOf("2026-10-15", null, endOfToday - 1)).toEqual({ graceEndsAt: endOfToday });
  });

  it("defaults to today + 30 days locally, never after the new token's expiry's date", () => {
    inTimeZone("Pacific/Auckland");
    const now = new Date(2026, 9, 15, 0, 30).getTime();
    expect(defaultGraceDate(null, now)).toBe("2026-11-14");
    expect(defaultGraceDate(now + 365 * DAY, now)).toBe("2026-11-14");
    expect(defaultGraceDate(now + 10 * DAY, now)).toBe("2026-10-25");
  });

  it("maps a graceEndsAt detail to the dialog's fixed words, never its own", () => {
    expect(graceDetailWords("Must not be after expiresAt.")).toBe(GRACE_AFTER_EXPIRY);
    expect(graceDetailWords("Must be a time in the future.")).toBe(GRACE_PAST);
    expect(graceDetailWords("anything else")).toBe(GRACE_PAST);
  });

  it("dates the replaced token's end as the earlier of the grace sent and its listed expiry, the grace when it isn't listed", () => {
    const grace = Date.parse("2026-11-15T04:59:59.999Z");
    const sooner = "2026-10-20T14:00:00.000Z";
    const later = "2027-10-15T14:00:00.000Z";
    expect(replacedStopsAt(ROTATE_TOKEN_ID, grace, [listedToken({ expiresAt: sooner })])).toBe(sooner);
    expect(replacedStopsAt(ROTATE_TOKEN_ID, grace, [listedToken({ expiresAt: later })])).toBe("2026-11-15T04:59:59.999Z");
    expect(replacedStopsAt(ROTATE_TOKEN_ID, grace, [listedToken({ expiresAt: null })])).toBe("2026-11-15T04:59:59.999Z");
    expect(replacedStopsAt(REPLACED_TOKEN_ID, grace, [listedToken({ expiresAt: sooner })])).toBe("2026-11-15T04:59:59.999Z");
    expect(replacedStopsAt(ROTATE_TOKEN_ID, grace, null)).toBe("2026-11-15T04:59:59.999Z");
  });
});

/* ---------------------------------------------------------------------------
 * The dialog, at 10:00 on 2026-10-15 in New York (EDT, UTC-4; EST, UTC-5,
 * from 2026-11-01): today + 30 days is 2026-11-14, whose end is
 * 2026-11-15T04:59:59.999Z; the 1 year preset expires 2027-10-15T14:00Z.
 */

const NOW = Date.parse("2026-10-15T14:00:00.000Z");
const DEFAULT_GRACE_END = "2026-11-15T04:59:59.999Z";
const ONE_YEAR = new Date(NOW + 365 * DAY).toISOString();
const NEW_TOKEN_ID = "c0ffee00-0000-4000-8000-0000000000a1";
const NEW_BEARER = "tfr_rotated-canary-5b7e";
const CURRENT: FleetRotateToken = { expiresAt: null, graceEndsAt: null, validCount: 1 };
const refusal = (code: string, message: string, status: number, details?: unknown) =>
  new ApiError(code, message, details === undefined ? { status } : { status, details });

function rotatedReply(predecessorId: string | null = ROTATE_TOKEN_ID): EnrollmentTokenRotatedResponse {
  return { token: { id: NEW_TOKEN_ID, bearer: NEW_BEARER, expiresAt: ONE_YEAR, predecessorId } };
}

type Answer = EnrollmentTokenRotatedResponse | "hang" | Error;

function serveRotations(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "rotateEnrollmentToken").mockImplementation((organizationId, fleetId, _request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    signals.push(options.signal);
    const answer = answers.shift() ?? rotatedReply();
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
  return { spy, signals };
}

interface Options {
  rotateToken?: FleetRotateToken | null;
  tokens?: EnrollmentTokenListed[] | null;
}

/** The dialog open in GROUP_ID, with a Switch to another organization and a Reopen; a loader counts revalidations. */
async function renderDialog({ rotateToken = CURRENT, tokens = [listedToken(), listedToken({ id: DEFAULT_TOKEN_ID, kind: "default" })] }: Options = {}) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <RotateTokenDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          rotateToken={rotateToken}
          tokens={tokens}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "Rotate token" });
  return { user, onOpenChange, onChanged, loader };
}

const graceInput = () => screen.getByLabelText(GRACE_LABEL) as HTMLInputElement;
const rotateButton = () => screen.getByRole("button", { name: /^(Rotate token|Rotating…)$/ });
const chooseDate = (value: string) => fireEvent.change(graceInput(), { target: { value } });
/** The footer's "Close" after an unknown outcome, not the X (whose screen-reader name is "Close" too). */
const closeButton = () => screen.getAllByRole("button", { name: "Close" }).find((button) => button.textContent === "Close")!;

describe("RotateTokenDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    inTimeZone("America/New_York");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("its form", () => {
    it("has the title, description and info box in their fixed words, no fleet label", async () => {
      await renderDialog();
      const dialog = screen.getByRole("dialog", { name: "Rotate token" });
      expect(dialog).toHaveTextContent(ROTATE_DESCRIPTION);
      expect(ROTATE_DESCRIPTION).toBe(
        "Issues a new rotate token. Collectors holding the current one keep working until the grace period ends, or until it expires if that is sooner; those that accept connection settings are handed the new one on one of their next polls. The default token doesn't change.",
      );
      expect(dialog).toHaveTextContent(ROTATE_INFO);
      expect(ROTATE_INFO).toBe(
        "Running collectors are handed the new token on one of their next polls. A collector still holding the current token when it stops working (offline then, or one that doesn't accept connection settings) is refused until its supervisor restarts; it then comes back through the default token.",
      );
      expect(dialog).not.toHaveTextContent(/redeploy|grace period end\)|revoked on|a rotate\b|Mints/i);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(rotateButton()).toBeEnabled();
    });

    it("says a collector can't come back through the default token while the fleet has none valid", async () => {
      await renderDialog({ tokens: [listedToken(), listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", revokedAt: new Date(NOW - DAY).toISOString() })] });
      const dialog = screen.getByRole("dialog", { name: "Rotate token" });
      expect(dialog).toHaveTextContent(
        "Running collectors are handed the new token on one of their next polls. A collector still holding the current token when it stops working (offline then, or one that doesn't accept connection settings) is refused until its supervisor restarts; it then comes back through the default token (the fleet has no valid default token now: issue a new default token and re-install it).",
      );
    });

    it("says it in words true either way before the tokens are read", async () => {
      await renderDialog({ tokens: null });
      expect(screen.getByRole("dialog", { name: "Rotate token" })).toHaveTextContent(
        "is refused until its supervisor restarts; it then comes back through the default token, while the fleet has a valid one.",
      );
      expect(screen.getByRole("dialog", { name: "Rotate token" })).not.toHaveTextContent(ROTATE_INFO);
    });

    it("offers the presets as native radios, 1 year the default, and says when the new token expires", async () => {
      const { user } = await renderDialog();
      const radios = screen.getAllByRole("radio");
      expect(radios.map((radio) => (radio.closest("label") as HTMLElement).textContent)).toEqual(["Never", "180 days", "1 year", "2 years"]);
      expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(["never", "180d", "1y", "2y"]);
      expect(screen.getByRole("radio", { name: "1 year" })).toBeChecked();
      expect(screen.getByRole("group", { name: "New token expires" })).toBeInTheDocument();
      expect(screen.getByText(`New token expires ${formatDateTime(ONE_YEAR)}.`)).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "180 days" }));
      expect(screen.getByText(`New token expires ${formatDateTime(new Date(NOW + 180 * DAY).toISOString())}.`)).toBeInTheDocument();
      await user.click(screen.getByRole("radio", { name: "Never" }));
      expect(screen.getByText("The new token never expires.")).toBeInTheDocument();
    });

    it("defaults the grace to today + 30 days, from today to the new expiry's date, with its help", async () => {
      const { user } = await renderDialog();
      expect(graceInput()).toHaveValue("2026-11-14");
      expect(graceInput()).toHaveAttribute("type", "date");
      expect(graceInput()).toHaveAttribute("min", "2026-10-15");
      expect(graceInput()).toHaveAttribute("max", "2027-10-15");
      expect(screen.getByText(GRACE_HELP)).toBeInTheDocument();
      expect(GRACE_HELP).toBe(
        "Defaults to 30 days from today, and at most the new token's expiry. The current token stops working at the end of the chosen day, or earlier if it expires first.",
      );

      await user.click(screen.getByRole("radio", { name: "180 days" }));
      expect(graceInput()).toHaveAttribute("max", "2027-04-13");
      await user.click(screen.getByRole("radio", { name: "Never" }));
      expect(graceInput()).not.toHaveAttribute("max");
    });

    it("sends the new expiry and the end of the default grace's day, both from one now", async () => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(
        GROUP_ID,
        FLEET_ID,
        { expiresAt: ONE_YEAR, graceEndsAt: DEFAULT_GRACE_END },
        { signal: expect.any(AbortSignal) },
      );
    });

    it.each([
      ["Never", "never", null],
      ["180 days", "180d", new Date(NOW + 180 * DAY).toISOString()],
      ["2 years", "2y", new Date(NOW + 730 * DAY).toISOString()],
    ])("sends the %s preset's expiry", async (label, _value, expiresAt) => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      await user.click(screen.getByRole("radio", { name: label }));
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt, graceEndsAt: DEFAULT_GRACE_END }, expect.anything());
    });

    it("accepts the last day the picker allows, the grace capped at the new expiry, and refuses the day after", async () => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      chooseDate("2027-10-16");
      expect(screen.getByRole("alert")).toHaveTextContent(GRACE_AFTER_EXPIRY);
      expect(graceInput()).toHaveAttribute("aria-invalid", "true");
      expect(rotateButton()).toBeDisabled();

      chooseDate("2027-10-15");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(rotateButton()).toBeEnabled();
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt: ONE_YEAR, graceEndsAt: ONE_YEAR }, expect.anything());
    });

    it("sends the end of the chosen local day", async () => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      chooseDate("2026-10-20");
      await user.click(rotateButton());
      // The end of 2026-10-20 in New York (EDT, UTC-4).
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt: ONE_YEAR, graceEndsAt: "2026-10-21T03:59:59.999Z" }, expect.anything());
    });

    it.each([
      ["no date", "", GRACE_REQUIRED],
      ["yesterday", "2026-10-14", GRACE_PAST],
      ["after the new expiry", "2028-01-01", GRACE_AFTER_EXPIRY],
    ])("says the fixed message for %s under the field, Rotate token disabled, nothing sent", async (_why, value, words) => {
      const rotations = serveRotations();
      await renderDialog();
      chooseDate(value);
      const problem = screen.getByRole("alert");
      expect(problem).toHaveTextContent(words);
      expect(graceInput()).toHaveAttribute("aria-describedby", expect.stringContaining(problem.id));
      expect(rotateButton()).toBeDisabled();
      fireEvent.submit(rotateButton().closest("form")!);
      expect(rotations.spy).not.toHaveBeenCalled();
    });

    it("accepts today, ending at the end of today", async () => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      chooseDate("2026-10-15");
      expect(screen.queryByRole("alert")).toBeNull();
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt: ONE_YEAR, graceEndsAt: "2026-10-16T03:59:59.999Z" }, expect.anything());
    });

    // The form drew before midnight; today and the field's min are reckoned again at submit.
    it("says a date that was today is in the past when submitted after midnight, nothing sent, the min now the new today", async () => {
      const rotations = serveRotations();
      // 23:59:30 in New York.
      vi.setSystemTime(Date.parse("2026-10-16T03:59:30.000Z"));
      const { user } = await renderDialog();
      chooseDate("2026-10-15");
      expect(graceInput()).toHaveAttribute("min", "2026-10-15");
      expect(screen.queryByRole("alert")).toBeNull();
      // Past midnight, with nothing drawn since.
      vi.setSystemTime(Date.parse("2026-10-16T04:00:30.000Z"));
      await user.click(rotateButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(GRACE_PAST);
      expect(graceInput()).toHaveAttribute("min", "2026-10-16");
      expect(graceInput()).toHaveAttribute("aria-invalid", "true");
      expect(rotations.spy).not.toHaveBeenCalled();
      // A date from the new today on clears it and sends.
      chooseDate("2026-10-16");
      expect(screen.queryByRole("alert")).toBeNull();
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.objectContaining({ graceEndsAt: "2026-10-17T03:59:59.999Z" }), expect.anything());
    });

    // The midnight problem joins an expiry's refusal still shown.
    it("keeps an expiry's refusal under the presets when a date that was today is submitted after midnight", async () => {
      const rotations = serveRotations(
        refusal("invalid_request", "expiresAt is invalid.", 400, [{ path: ["expiresAt"], message: "Must be a time in the future." }]),
      );
      // 23:59:30 in New York.
      vi.setSystemTime(Date.parse("2026-10-16T03:59:30.000Z"));
      const { user } = await renderDialog();
      chooseDate("2026-10-15");
      await user.click(rotateButton());
      const expiryProblem = await screen.findByRole("alert");
      expect(expiryProblem).toHaveTextContent("Must be a time in the future.");
      expect(rotations.spy).toHaveBeenCalledTimes(1);
      // Past midnight, with nothing drawn since: sent again, the grace's problem shows beside the expiry's.
      vi.setSystemTime(Date.parse("2026-10-16T04:00:30.000Z"));
      await user.click(rotateButton());
      await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((each) => each.textContent?.includes("Must be a time in the future."))).toBe(true);
      expect(within(screen.getByRole("group", { name: "New token expires" })).getByRole("alert")).toHaveTextContent("Must be a time in the future.");
      expect(alerts.some((each) => each.textContent?.includes(GRACE_PAST))).toBe(true);
      expect(rotations.spy).toHaveBeenCalledTimes(1);
    });

    it("accepts any future date with Never", async () => {
      const rotations = serveRotations();
      const { user } = await renderDialog();
      await user.click(screen.getByRole("radio", { name: "Never" }));
      chooseDate("2030-01-01");
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt: null, graceEndsAt: "2030-01-02T04:59:59.999Z" }, expect.anything());
    });

    it("says beside the field when the current token expires before the end of the chosen day", async () => {
      const expiresAt = new Date(NOW + 5 * DAY).toISOString();
      await renderDialog({ rotateToken: { expiresAt, graceEndsAt: null, validCount: 1 } });
      const words = soonerExpiryWords(expiresAt);
      expect(words).toBe(`The current token expires ${formatDateTime(expiresAt)} on its own: a later date doesn't keep it working past then.`);
      expect(screen.getByText(words)).toBeInTheDocument();
      // Today ends before it: nothing to say.
      chooseDate("2026-10-15");
      expect(screen.queryByText(words)).toBeNull();
      // Its own day ends after it.
      chooseDate("2026-10-20");
      expect(screen.getByText(words)).toBeInTheDocument();
    });

    it("says nothing of the current token's expiry when it is later than the chosen day, or never", async () => {
      await renderDialog({ rotateToken: { expiresAt: new Date(NOW + 200 * DAY).toISOString(), graceEndsAt: null, validCount: 1 } });
      expect(screen.queryByText(/on its own/)).toBeNull();
    });

    it("hides the field with no valid rotate token, sending the default grace", async () => {
      const rotations = serveRotations(rotatedReply(null));
      const { user } = await renderDialog({ rotateToken: null });
      expect(screen.queryByLabelText(GRACE_LABEL)).toBeNull();
      expect(screen.getByText(NO_PREDECESSOR_FORM)).toBeInTheDocument();
      expect(NO_PREDECESSOR_FORM).toBe("The fleet has no valid rotate token: the new one is current at once.");
      await user.click(rotateButton());
      expect(rotations.spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { expiresAt: ONE_YEAR, graceEndsAt: DEFAULT_GRACE_END }, expect.anything());
    });
  });

  describe("its result", () => {
    it("shows the new bearer once, only inside ph-no-capture, with the words, and reloads the tab", async () => {
      serveRotations();
      const { onChanged } = await renderDialog();
      fireEvent.click(rotateButton());
      const dialog = await screen.findByRole("dialog", { name: "Token rotated" });
      expect(within(dialog).getByText(NEW_BEARER)).toBeInTheDocument();
      expectTextOnlyInsideNoCapture(NEW_BEARER);
      expect(within(dialog).getByRole("button", { name: "Copy rotate token" })).toBeInTheDocument();
      expect(dialog).toHaveTextContent(ROTATED_NO_ACTION);
      expect(ROTATED_NO_ACTION).toBe(
        "No action required: running collectors are handed the new token on one of their next polls, and the default token is unchanged.",
      );
      expect(dialog).toHaveTextContent(ROTATED_BEARER_HINT);
      expect(ROTATED_BEARER_HINT).toBe(
        "You don't need to copy it: running collectors are handed it on one of their next polls. It is shown now only; Reveal gives a new one for it.",
      );
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
    });

    it("says the replaced token stops working at the grace sent, when its own expiry is later", async () => {
      serveRotations();
      await renderDialog({ tokens: [listedToken({ expiresAt: new Date(NOW + 200 * DAY).toISOString() })] });
      fireEvent.click(rotateButton());
      const dialog = await screen.findByRole("dialog", { name: "Token rotated" });
      expect(dialog).toHaveTextContent(`The token it replaces stops working on ${formatDateTime(DEFAULT_GRACE_END)}.`);
    });

    it("says the replaced token stops working at its own expiry, when that is sooner than the grace sent", async () => {
      const sooner = new Date(NOW + 5 * DAY).toISOString();
      serveRotations();
      await renderDialog({
        rotateToken: { expiresAt: sooner, graceEndsAt: null, validCount: 1 },
        tokens: [listedToken({ expiresAt: sooner })],
      });
      fireEvent.click(rotateButton());
      const dialog = await screen.findByRole("dialog", { name: "Token rotated" });
      expect(dialog).toHaveTextContent(`The token it replaces stops working on ${formatDateTime(sooner)}.`);
      expect(dialog).not.toHaveTextContent(formatDateTime(DEFAULT_GRACE_END));
    });

    it("says the grace sent when the tokens read doesn't hold the replaced token (another member rotated meanwhile)", async () => {
      serveRotations(rotatedReply(REPLACED_TOKEN_ID));
      await renderDialog({ tokens: [listedToken({ expiresAt: new Date(NOW + 5 * DAY).toISOString() })] });
      fireEvent.click(rotateButton());
      const dialog = await screen.findByRole("dialog", { name: "Token rotated" });
      expect(dialog).toHaveTextContent(`The token it replaces stops working on ${formatDateTime(DEFAULT_GRACE_END)}.`);
    });

    it('says the new one is current at once for a null predecessorId', async () => {
      serveRotations(rotatedReply(null));
      await renderDialog();
      fireEvent.click(rotateButton());
      const dialog = await screen.findByRole("dialog", { name: "Token rotated" });
      expect(dialog).toHaveTextContent(NO_PREDECESSOR_RESULT);
      expect(NO_PREDECESSOR_RESULT).toBe("The fleet had no valid rotate token: the new one is current at once.");
      expect(dialog).not.toHaveTextContent("The token it replaces");
    });

    it("drops the bearer on Done, and the next opening is a fresh form", async () => {
      serveRotations();
      const { user, onOpenChange, onChanged } = await renderDialog();
      await user.click(rotateButton());
      await screen.findByRole("dialog", { name: "Token rotated" });
      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.body).not.toHaveTextContent(NEW_BEARER);
      expect(onChanged).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Reopen" }));
      expect(await screen.findByRole("dialog", { name: "Rotate token" })).toBeInTheDocument();
      expect(graceInput()).toHaveValue("2026-11-14");
      expect(screen.getByRole("radio", { name: "1 year" })).toBeChecked();
    });
  });

  describe("its refusals", () => {
    it("shows fleet_archived's words inline and stays open", async () => {
      serveRotations(refusal("fleet_archived", "The fleet is archived.", 409));
      const { user, onOpenChange, onChanged } = await renderDialog();
      await user.click(rotateButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("The fleet is archived.");
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
      expect(rotateButton()).toBeEnabled();
    });

    it.each([
      ["Must not be after expiresAt.", GRACE_AFTER_EXPIRY],
      ["Must be a time in the future.", GRACE_PAST],
    ])("shows an invalid_request on graceEndsAt (%j) under the field in the dialog's fixed words", async (detail, words) => {
      serveRotations(refusal("invalid_request", "graceEndsAt is invalid.", 400, [{ path: ["graceEndsAt"], message: detail }]));
      const { user } = await renderDialog();
      await user.click(rotateButton());
      const problem = await screen.findByRole("alert");
      expect(problem).toHaveTextContent(words);
      expect(problem).not.toHaveTextContent(detail);
      expect(graceInput()).toHaveAttribute("aria-invalid", "true");
      // A new date clears it.
      chooseDate("2026-11-20");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    // With no valid rotate token there is no field to show it under.
    it.each([
      ["Must not be after expiresAt.", GRACE_AFTER_EXPIRY],
      ["Must be a time in the future.", GRACE_PAST],
    ])("shows an invalid_request on graceEndsAt (%j) in the dialog's alert when the field is hidden", async (detail, words) => {
      serveRotations(refusal("invalid_request", "graceEndsAt is invalid.", 400, [{ path: ["graceEndsAt"], message: detail }]));
      const { user } = await renderDialog({ rotateToken: null });
      expect(screen.queryByLabelText(GRACE_LABEL)).toBeNull();
      await user.click(rotateButton());
      const problem = await screen.findByRole("alert");
      expect(problem).toHaveTextContent(words);
      expect(problem).not.toHaveTextContent(detail);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(rotateButton()).toBeEnabled();
    });

    it("shows an invalid_request on expiresAt under the presets", async () => {
      serveRotations(refusal("invalid_request", "expiresAt is invalid.", 400, [{ path: ["expiresAt"], message: "Must be a time in the future." }]));
      const { user } = await renderDialog();
      await user.click(rotateButton());
      const problem = await screen.findByRole("alert");
      expect(problem).toHaveTextContent("Must be a time in the future.");
      expect(screen.getByRole("group", { name: "New token expires" })).toContainElement(problem);
    });

    it.each([
      ["a 429, its own words", () => refusal("rate_limited", "Too many requests. Try again in 30 seconds.", 429), "Too many requests. Try again in 30 seconds."],
      ["a 400 with no field, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), ROTATE_FAILED_MESSAGE],
    ])("shows %s inline, Rotate token enabled again", async (_why, failure, words) => {
      serveRotations(failure());
      const { user } = await renderDialog();
      await user.click(rotateButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      expect(rotateButton()).toBeEnabled();
    });

    it('on an unknown outcome shows the 503\'s words and "Close" in place of Rotate token; closing reloads the tab', async () => {
      const rotations = serveRotations(refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503));
      const { user, onOpenChange, onChanged } = await renderDialog();
      await user.click(rotateButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
      expect(screen.queryByRole("button", { name: "Rotate token" })).toBeNull();
      expect(graceInput()).toBeDisabled();
      expect(screen.getByRole("radio", { name: "1 year" })).toBeDisabled();
      expect(onChanged).not.toHaveBeenCalled();

      await user.click(closeButton());
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(rotations.spy).toHaveBeenCalledTimes(1);
    });

    it("ends a rotation that never answers at 30 s as an unknown outcome", async () => {
      const rotations = serveRotations("hang");
      await renderDialog();
      // The hang guard's timer too, the clock still at NOW.
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(NOW);
      fireEvent.click(rotateButton());
      await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
      expect(rotations.signals[0]!.aborted).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(rotations.signals[0]!.aborted).toBe(true);
      vi.useRealTimers();
      expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
      expect(closeButton()).toBeInTheDocument();
    });

    it('on a 404 fleet_not_found toasts its words, closes and reloads ("Fleet not found")', async () => {
      serveRotations(refusal("fleet_not_found", "Fleet not found.", 404));
      const toastError = vi.spyOn(toast, "error");
      const { user, onOpenChange, onChanged } = await renderDialog();
      await user.click(rotateButton());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(toastError).toHaveBeenCalledWith("Fleet not found.");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it.each([
      ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
      ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
    ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
      serveRotations(failure());
      const toastError = vi.spyOn(toast, "error");
      const { user, onOpenChange, onChanged, loader } = await renderDialog();
      const loads = loader.mock.calls.length;
      await user.click(rotateButton());
      await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onChanged).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });
  });

  describe("while rotating", () => {
    it('says "Rotating…", and can\'t be closed: Cancel disabled, no X, Escape does nothing; every field disabled', async () => {
      serveRotations("hang");
      const { user, onOpenChange } = await renderDialog();
      await user.click(rotateButton());
      expect(screen.getByRole("button", { name: "Rotating…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      // No X (named "Close"), and no footer Close.
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      expect(graceInput()).toBeDisabled();
      expect(screen.getByRole("radio", { name: "Never" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("sends once on a double Enter", async () => {
      const rotations = serveRotations("hang");
      await renderDialog();
      const form = rotateButton().closest("form")!;
      fireEvent.submit(form);
      fireEvent.submit(form);
      expect(rotations.spy).toHaveBeenCalledTimes(1);
    });

    it("drops a rotation answered after the organization changed: no bearer, no reload", async () => {
      let finish!: () => void;
      vi.spyOn(apiClient, "rotateEnrollmentToken").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(rotatedReply());
          }),
      );
      const { user, onChanged } = await renderDialog();
      await user.click(rotateButton());
      fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
      await act(async () => finish());
      expect(document.body).not.toHaveTextContent(NEW_BEARER);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });
});
