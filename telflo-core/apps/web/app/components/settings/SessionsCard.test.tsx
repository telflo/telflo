import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSessionsResponse } from "@telflo/contracts";
import { SessionsCard, signOutName } from "./SessionsCard.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { SESSION_SIGNED_OUT_MESSAGE, SESSIONS_LOAD_FAILED_MESSAGE, sessionTitle } from "~/lib/account.js";
import { formatDateTime, formatDateTimeToTheSecond } from "~/lib/format.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { OTHER_SESSION_ID, held, renderUnderLayout, sessions } from "~/test/account.js";

/*
 * Sessions: the rows, "This browser" with no Sign out, a row's Sign out
 * with no confirm and the list read again, each named by fixed words and
 * its sign-in time.
 */

function page(items = sessions()): AccountSessionsResponse {
  return { items, total: items.length };
}

const rows = () => within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("listitem");

describe("SessionsCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("words the families, with Unknown browser and unknown system for other", () => {
    expect(sessionTitle({ browser: "firefox", os: "macos" })).toBe("Firefox on macOS");
    expect(sessionTitle({ browser: "edge", os: "windows" })).toBe("Edge on Windows");
    expect(sessionTitle({ browser: "safari", os: "ios" })).toBe("Safari on iOS");
    expect(sessionTitle({ browser: "opera", os: "chromeos" })).toBe("Opera on ChromeOS");
    expect(sessionTitle({ browser: "chrome", os: "android" })).toBe("Chrome on Android");
    expect(sessionTitle({ browser: "other", os: "linux" })).toBe("Unknown browser on Linux");
    expect(sessionTitle({ browser: "other", os: "other" })).toBe("Unknown browser on unknown system");
  });

  it("lists the rows with This browser on the current one and no Sign out on it", async () => {
    vi.spyOn(apiClient, "listSessions").mockResolvedValue(page());
    renderUnderLayout(SessionsCard);

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Browsers signed in to your account")).toBeInTheDocument();
    await screen.findByRole("list", { name: "Sessions" });
    const [current, other] = rows();
    const [mine, theirs] = sessions();

    expect(current).toHaveTextContent("Firefox on macOS");
    expect(current).toHaveTextContent("This browser");
    expect(current).toHaveTextContent(`Signed in ${formatDateTime(mine!.signedInAt)}`);
    expect(current).toHaveTextContent(`Last active ${formatDateTime(mine!.lastActiveAt)}`);
    expect(current).toHaveTextContent(`IP address ${mine!.ipAddress}`);
    expect(within(current!).queryByRole("button")).not.toBeInTheDocument();

    expect(other).toHaveTextContent("Chrome on Windows");
    expect(other).not.toHaveTextContent("This browser");
    expect(other).toHaveTextContent(`IP address ${theirs!.ipAddress}`);
    const signOut = within(other!).getByRole("button");
    expect(signOut).toHaveTextContent("Sign out");
    expect(signOut).toHaveAccessibleName(`Sign out the session signed in ${formatDateTimeToTheSecond(theirs!.signedInAt)}`);
    expect(signOut).not.toHaveAttribute("aria-label");
    expect(signOutName(theirs!)).toBe(`Sign out the session signed in ${formatDateTimeToTheSecond(theirs!.signedInAt)}`);
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeInTheDocument();
  });

  it("an IP the API didn't record reads unknown", async () => {
    const [mine] = sessions();
    vi.spyOn(apiClient, "listSessions").mockResolvedValue(page([{ ...mine!, ipAddress: null }]));
    renderUnderLayout(SessionsCard);
    await screen.findByRole("list", { name: "Sessions" });
    expect(rows()[0]).toHaveTextContent("IP address unknown");
  });

  it("Sign out on a row signs it out and reads the list again", async () => {
    const [mine] = sessions();
    const listSessions = vi.spyOn(apiClient, "listSessions").mockResolvedValueOnce(page()).mockResolvedValueOnce(page([mine!]));
    const answer = held<undefined>();
    const deleteSession = vi.spyOn(apiClient, "deleteSession").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const user = renderUnderLayout(SessionsCard);
    await screen.findByRole("list", { name: "Sessions" });

    const signOut = within(rows()[1]!).getByRole("button");
    await user.click(signOut);
    // No confirm: the request goes at once.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteSession).toHaveBeenCalledWith(OTHER_SESSION_ID);
    expect(signOut).toBeDisabled();

    answer.resolve(undefined);
    await waitFor(() => expect(success).toHaveBeenCalledWith(SESSION_SIGNED_OUT_MESSAGE));
    expect(SESSION_SIGNED_OUT_MESSAGE).toBe("Session signed out.");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(rows()[0]).toHaveTextContent("This browser");
    // The row and its button went: the card's heading holds the focus, not the body.
    expect(signOut).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sessions" })).toHaveFocus();
  });

  it("a Sign out's answer leaves a focus moved elsewhere meanwhile where it is", async () => {
    const [mine] = sessions();
    vi.spyOn(apiClient, "listSessions").mockResolvedValueOnce(page()).mockResolvedValueOnce(page([mine!]));
    const answer = held<undefined>();
    vi.spyOn(apiClient, "deleteSession").mockReturnValue(answer.promise);
    const user = renderUnderLayout(SessionsCard);
    await screen.findByRole("list", { name: "Sessions" });

    await user.click(within(rows()[1]!).getByRole("button"));
    const everywhere = screen.getByRole("button", { name: "Sign out everywhere" });
    everywhere.focus();
    answer.resolve(undefined);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(everywhere).toHaveFocus();
  });

  it("puts the This browser badge in no paragraph (a div can't sit in a p)", async () => {
    vi.spyOn(apiClient, "listSessions").mockResolvedValue(page());
    const consoleError = vi.spyOn(console, "error");
    renderUnderLayout(SessionsCard);
    await screen.findByRole("list", { name: "Sessions" });
    expect(screen.getByText("This browser").closest("p")).toBeNull();
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/descendant of <p>|validateDOMNesting/);
  });

  it("a session already gone toasts the API's words and reads the list again", async () => {
    const listSessions = vi.spyOn(apiClient, "listSessions").mockResolvedValue(page());
    vi.spyOn(apiClient, "deleteSession").mockRejectedValue(new ApiError("session_not_found", "Session not found", { status: 404 }));
    const error = vi.spyOn(toast, "error");
    const user = renderUnderLayout(SessionsCard);
    await screen.findByRole("list", { name: "Sessions" });

    await user.click(within(rows()[1]!).getByRole("button"));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Session not found"));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
  });

  it("a failed read says so, and Try again reads again", async () => {
    vi.spyOn(apiClient, "listSessions")
      .mockRejectedValueOnce(new ApiError("internal_error", "Something went wrong.", { status: 500 }))
      .mockResolvedValueOnce(page());
    const user = renderUnderLayout(SessionsCard);

    expect(await screen.findByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Sessions" })).toBeInTheDocument();
  });
});
