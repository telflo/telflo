import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type KeyboardEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type OrganizationVariable } from "@telflo/contracts";

import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";
import { ORG_VARIABLES_UNREAD_MESSAGE, VaultAwareInput } from "./vault-aware-input.js";

afterEach(() => {
  vi.useRealTimers();
});

function Controlled({
  onKeyDown,
  onBlur,
  inputRef,
}: {
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  inputRef?: (node: HTMLInputElement | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <VaultAwareInput
        aria-label="Endpoint"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        {...(onKeyDown ? { onKeyDown } : {})}
        {...(onBlur ? { onBlur } : {})}
        {...(inputRef ? { ref: inputRef } : {})}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const input = () => screen.getByRole("textbox", { name: "Endpoint" }) as HTMLInputElement;

describe("VaultAwareInput's $ picker", () => {
  it('opens on $ with "No matching variables" and the env row, which inserts ${env:} with the cursor inside', async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(input(), "http://$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();
    expect(screen.getByText("Environment variable")).toBeInTheDocument();
    expect(screen.getByText("${env:}")).toHaveClass("font-mono");
    // The picker renders in <body>, outside the input's own tree (the signed-in layout masks it).
    expect(screen.getByText("No matching variables").closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(
      document.body,
    );

    await user.click(screen.getByRole("button", { name: /Environment variable/ }));

    expect(screen.getByTestId("value")).toHaveTextContent("http://${env:}");
    expect(input()).toHaveValue("http://${env:}");
    expect(screen.queryByText("No matching variables")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(input().selectionStart).toBe("http://${env:".length);
    expect(input().selectionEnd).toBe("http://${env:".length);
    expect(document.activeElement).toBe(input());
  });

  it("Enter picks the highlighted env row, and a caller's onKeyDown doesn't stop the picker's keys", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    render(<Controlled onKeyDown={(e) => keys.push(`${e.metaKey ? "Meta+" : ""}${e.key}`)} />);

    await user.type(input(), "a$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();
    // With no variables the env row is the only row: the arrows wrap onto it.
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(screen.getByRole("button", { name: /Environment variable/ })).toHaveClass("bg-accent");
    await user.keyboard("{Enter}");

    expect(input()).toHaveValue("a${env:}");
    // The keys the picker consumed never reached the caller; the typing did.
    expect(keys).toEqual(["a", "$"]);

    // Closed, every key reaches the caller, Cmd/Ctrl+S among them.
    await user.keyboard("{Enter}{Meta>}s{/Meta}");
    expect(keys).toEqual(["a", "$", "Enter", "Meta+Meta", "Meta+s"]);
  });

  it("Escape closes the picker without reaching the caller; Tab closes it and reaches the caller", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    render(<Controlled onKeyDown={(e) => keys.push(e.key)} />);

    await user.type(input(), "$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("No matching variables")).toBeNull();
    expect(keys).toEqual(["$"]);

    await user.type(input(), "{ArrowLeft}$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(screen.queryByText("No matching variables")).toBeNull();
    expect(keys).toEqual(["$", "ArrowLeft", "$", "Tab"]);
  });

  it("composes the caller's onBlur, and closes the picker 150 ms after the input loses focus", () => {
    vi.useFakeTimers();
    const onBlur = vi.fn();
    render(<Controlled onBlur={onBlur} />);

    act(() => input().focus());
    fireEvent.change(input(), { target: { value: "$" } });
    expect(screen.getByText("No matching variables")).toBeInTheDocument();

    // Focus moving into the picker (a row being clicked) isn't a blur of the field.
    const envRow = screen.getByRole("button", { name: /Environment variable/ });
    fireEvent.blur(input(), { relatedTarget: envRow });
    expect(onBlur).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText("No matching variables")).toBeInTheDocument();

    fireEvent.blur(input(), { relatedTarget: document.body });
    expect(onBlur).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(149));
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("No matching variables")).toBeNull();
  });

  it("an unmount clears the delayed close: no timer outlives the input", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Controlled />);
    act(() => input().focus());
    const before = vi.getTimerCount();
    fireEvent.blur(input(), { relatedTarget: document.body });
    expect(vi.getTimerCount()).toBe(before + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });

  it("stays open while focus is inside the picker when the delayed close runs", () => {
    vi.useFakeTimers();
    render(<Controlled />);
    fireEvent.change(input(), { target: { value: "$" } });
    const envRow = screen.getByRole("button", { name: /Environment variable/ });
    fireEvent.blur(input());
    act(() => envRow.focus());
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByText("No matching variables")).toBeInTheDocument();
  });

  it("forwards a callback ref, and places the cursor through it", async () => {
    const user = userEvent.setup();
    const nodes: Array<HTMLInputElement | null> = [];
    render(<Controlled inputRef={(node) => nodes.push(node)} />);
    expect(nodes[0]).toBe(input());

    await user.type(input(), "$");
    await user.click(await screen.findByRole("button", { name: /Environment variable/ }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(input().selectionStart).toBe("${env:".length);
  });

  it("forwards an object ref, follows its value from outside, and never opens on a value it's given", () => {
    const ref = { current: null as HTMLInputElement | null };
    const { rerender } = render(<VaultAwareInput aria-label="Endpoint" ref={ref} value="a$" onChange={() => {}} />);
    expect(ref.current).toBe(input());
    expect(input()).toHaveValue("a$");
    expect(screen.queryByText("No matching variables")).toBeNull();

    rerender(<VaultAwareInput aria-label="Endpoint" ref={ref} value={5} onChange={() => {}} />);
    expect(input()).toHaveValue("5");
    rerender(<VaultAwareInput aria-label="Endpoint" ref={ref} value={undefined} />);
    expect(input()).toHaveValue("");
  });
});

describe("VaultAwareInput's $ picker fed by the organization's variables", () => {
  const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
  const VALUE_CANARY = "value-canary-91d2";

  function variable(id: string, name: string, description: string | null): OrganizationVariable {
    return { id, name, description, value: `${VALUE_CANARY}-${name}`, changedBy: null, changedAt: "2026-10-20T10:00:00.000Z" };
  }

  const VARIABLES = [
    variable("00000000-0000-4000-8000-000000000001", "OTLP_EP", "Collector gateway"),
    variable("00000000-0000-4000-8000-000000000002", "REGION", null),
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    forgetOrgVariableNames();
    useUserStore.getState().setCurrent({
      user: { id: "00000000-0000-4000-8000-0000000000c3", email: "member@example.com" },
      organization: { id: ORGANIZATION_ID, name: "Acme", type: "group", logoId: null, role: "contributor" },
      organizations: [],
      isProductAdmin: false,
      mayCreateOrganizations: true,
      preferences: DEFAULT_USER_PREFERENCES,
    });
  });
  afterEach(() => {
    // The inputs go first: the stores' resets would otherwise re-render them outside act.
    cleanup();
    useUserStore.getState().clear();
    forgetOrgVariableNames();
  });

  it("lists each name over its description, and a pick inserts ${org:NAME}; no value reaches the page", async () => {
    vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue(VARIABLES);
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(input(), "endpoint: $");
    expect(await screen.findByText("${org:OTLP_EP}")).toBeInTheDocument();
    expect(screen.getByText("Collector gateway")).toBeInTheDocument();
    expect(screen.getByText("${org:REGION}")).toBeInTheDocument();
    expect(screen.getByText("Environment variable")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(VALUE_CANARY);
    expectNoAttributeHolds("OTLP_EP");
    expectNoAttributeHolds("Collector gateway");
    // The rows are configuration text: replay records nothing of the picker.
    expect(screen.getByText("${org:OTLP_EP}").closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText("Collector gateway").closest(".ph-no-capture")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /\$\{org:OTLP_EP\}/ }));
    expect(input()).toHaveValue("endpoint: ${org:OTLP_EP}");

    await user.type(input(), " $reg");
    await user.keyboard("{Enter}");
    expect(input()).toHaveValue("endpoint: ${org:OTLP_EP} ${org:REGION}");
  });

  it('says "Loading organization variables..." until the read answers, the env row below it', async () => {
    let answer: (variables: OrganizationVariable[]) => void = () => undefined;
    vi.spyOn(apiClient, "getOrganizationVariables").mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(input(), "$");
    expect(await screen.findByText("Loading organization variables...")).toBeInTheDocument();
    expect(screen.getByText("Environment variable")).toBeInTheDocument();
    await act(async () => answer(VARIABLES));
    expect(screen.queryByText("Loading organization variables...")).toBeNull();
    expect(screen.getByText("${org:OTLP_EP}")).toBeInTheDocument();
  });

  it("says so when the read failed, and reads again as the picker opens next", async () => {
    let refuse: (error: unknown) => void = () => undefined;
    const read = vi
      .spyOn(apiClient, "getOrganizationVariables")
      .mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)))
      .mockResolvedValue(VARIABLES);
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(input(), "$");
    expect(await screen.findByText("Loading organization variables...")).toBeInTheDocument();
    await act(async () => refuse(new ApiError("variables_unavailable", "unavailable", { status: 503 })));
    // The family's words, as the variables routes and Validate say them.
    expect(ORG_VARIABLES_UNREAD_MESSAGE).toBe("The organization's variables couldn't be reached. Try again.");
    expect(await screen.findByText(ORG_VARIABLES_UNREAD_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("Environment variable")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await user.type(input(), "$");
    expect(await screen.findByText("${org:OTLP_EP}")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ten inputs on one page read the names once", async () => {
    const read = vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue(VARIABLES);
    const user = userEvent.setup();
    render(
      <>
        {Array.from({ length: 10 }, (_, index) => (
          <VaultAwareInput key={index} aria-label={`Field ${index}`} defaultValue="" />
        ))}
      </>,
    );
    for (const index of [0, 9]) {
      await user.type(screen.getByRole("textbox", { name: `Field ${index}` }), "$");
      expect(await screen.findByText("${org:OTLP_EP}")).toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
    expect(read).toHaveBeenCalledTimes(1);
  });
});
