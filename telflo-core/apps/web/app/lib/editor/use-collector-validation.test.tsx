/**
 * The editor's collector validation, against a spied `validateVersion`, with
 * fake timers for the 2 s debounce and the 429's wait. The hook's basics come
 * first; the distribution is always the configuration's, so the distribution
 * cases are the pin's.
 */

import type { ConfigurationValidationResponse, ConfigurationVersion } from "@telflo/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { reloadOpenVersion } from "./publishing.js";
import {
  RATE_LIMIT_RETRY_WINDOW_MS,
  useCollectorValidation,
  VALIDATION_CONTROL_CHARACTER_MESSAGE,
  VALIDATION_DEBOUNCE_MS,
  VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE,
  VALIDATION_UNREACHABLE_MESSAGE,
} from "./use-collector-validation.js";
import { applyValidationGate } from "~/components/editor/YamlEditor.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { selectCollectorValidation, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture } from "~/test/configurations.js";

const TEXT = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\n";
const TYPED = `${TEXT}# typed\n`;
const PIN = "0.162.0";
const OTHER_PIN = "0.161.0";
const UNAVAILABLE = "Validation is unavailable. Your YAML was not checked — retry shortly.";
const RATE_LIMITED = "Too many checks in the last minute. Checking again shortly.";

const VALID: ConfigurationValidationResponse = { status: "valid", collectorVersion: PIN, errors: [], requirements: [] };
const INVALID: ConfigurationValidationResponse = {
  status: "invalid",
  collectorVersion: PIN,
  errors: [{ message: 'unknown type: "nope"', componentPath: "exporters::nope" }],
  requirements: [{ category: "env_var", title: "Set environment variable TOKEN", description: "d", componentPath: null }],
};

const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();
const status = () => selectCollectorValidation(store());

let validate: MockInstance<typeof apiClient.validateVersion>;

function open(overrides: Partial<ConfigurationVersion> = {}): ConfigurationVersion {
  const version = versionFixture({ yamlContent: TEXT, collectorVersion: PIN, ...overrides });
  act(() => store().load({ organizationId: GROUP_ID, configuration: MINE, version }));
  return version;
}

/** A request the test answers when it chooses. */
function deferred() {
  let resolve!: (value: ConfigurationValidationResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ConfigurationValidationResponse>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets the answers already given land. */
const flush = () => act(async () => {});

function mount() {
  return renderHook(() => useCollectorValidation());
}

/** The bodies sent, in order. */
const sent = () => validate.mock.calls.map((call) => call[3]);

/** The AbortSignal the `index`th check was sent with. */
const signalOf = (index: number) => validate.mock.calls[index]?.[4]?.signal;

/**
 * A request that waits until its signal aborts it, then rejects as the API
 * client does (`REQUEST_ABORTED`).
 */
function untilAborted(...[, , , , options]: Parameters<typeof apiClient.validateVersion>): Promise<ConfigurationValidationResponse> {
  return new Promise((_settle, fail) => {
    options?.signal?.addEventListener("abort", () => fail(new ApiError(apiClient.REQUEST_ABORTED, "The request was cancelled.")));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  validate = vi.spyOn(apiClient, "validateVersion").mockResolvedValue(VALID);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the basics", () => {
  it("sends the open version's text with the pin on screen, the saved one when untouched", async () => {
    mount();
    open();
    await flush();

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(
      GROUP_ID,
      MINE.id,
      store().version!.id,
      { yaml: TEXT, collectorVersion: PIN },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("sends the tab's unsaved pick as collectorVersion", async () => {
    mount();
    open();
    await flush();
    act(() => store().setCollectorVersion(OTHER_PIN));
    await flush();

    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TEXT, collectorVersion: OTHER_PIN },
    ]);
  });

  it("checks again when only the pin changes, the text unchanged", async () => {
    mount();
    open();
    await flush();
    act(() => store().setCollectorVersion(OTHER_PIN));
    await flush();
    act(() => store().setCollectorVersion(PIN));
    await flush();

    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TEXT, collectorVersion: OTHER_PIN },
      { yaml: TEXT, collectorVersion: PIN },
    ]);
  });

  it("a 503 becomes unavailable with the API's reason, not invalid", async () => {
    validate.mockRejectedValue(new ApiError("validation_unavailable", UNAVAILABLE, { status: 503 }));
    mount();
    open();
    await flush();

    expect(status()).toEqual({ status: "unavailable", message: UNAVAILABLE });
  });

  it("an unreachable API is unavailable too, saying the service couldn't be reached", async () => {
    validate.mockRejectedValue(new ApiError("network_error", "Could not reach the server. Check your connection."));
    mount();
    open();
    await flush();

    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_UNREACHABLE_MESSAGE });
    expect(VALIDATION_UNREACHABLE_MESSAGE).toBe("Couldn't reach the validation service. Your YAML was not checked.");
  });
});

describe("when it checks", () => {
  it("checks a version at once when it opens, and a published one too", async () => {
    mount();
    open(PUBLISHED_FIELDS);
    expect(validate).toHaveBeenCalledTimes(1);
    await flush();
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("checks a text change 2 s after the last change, typed or from the canvas: the debounce", async () => {
    mount();
    open();
    await flush();
    validate.mockClear();

    act(() => store().setText(`${TEXT}# a\n`));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS - 1);
    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS - 1);
    expect(validate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([{ yaml: TYPED, collectorVersion: PIN }]);
    expect(VALIDATION_DEBOUNCE_MS).toBe(2000);
  });

  it("shows validating for the text on screen during the debounce, then its answer", async () => {
    mount();
    open();
    await flush();
    expect(status().status).toBe("valid");

    act(() => store().setText(TYPED));
    expect(status()).toEqual({ status: "validating" });

    validate.mockResolvedValue(INVALID);
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(status()).toEqual({
      status: "invalid",
      collectorVersion: PIN,
      errors: INVALID.errors,
      requirements: INVALID.requirements,
    });
  });

  it("checks a pin change at once, without the debounce", async () => {
    mount();
    open();
    await flush();
    validate.mockClear();

    act(() => store().setCollectorVersion(OTHER_PIN));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(status()).toEqual({ status: "validating" });
  });

  it("an undo inside the debounce, back to the checked text, shows its answer at once and never sticks at validating", async () => {
    mount();
    open();
    await flush();
    validate.mockClear();

    act(() => store().setText(TYPED));
    expect(status().status).toBe("validating");
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS / 2);
    act(() => store().setText(TEXT));

    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 2);
    expect(validate).not.toHaveBeenCalled();
    expect(status().status).toBe("valid");
  });

  it("sends nothing for empty text: idle", async () => {
    mount();
    open({ yamlContent: "" });
    act(() => store().setText(""));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 2);

    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "idle" });
  });

  it("sends nothing for text that doesn't parse: idle once it is read", async () => {
    mount();
    open({ yamlContent: "receivers: [a]\n" });
    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "idle" });

    act(() => store().setText("receivers:\n  otlp: *nowhere\n"));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "idle" });
  });

  it("sends nothing for text that parses but holds a C0 control character the API refuses: unavailable, so Apply applies it unchecked", async () => {
    mount();
    open({ yamlContent: 'receivers:\n  otlp: {}\n# bell "\u0007"\n' });
    await flush();

    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_CONTROL_CHARACTER_MESSAGE });
    expect(VALIDATION_CONTROL_CHARACTER_MESSAGE).toBe("Your YAML holds a control character, so it was not checked.");
    expect(applyValidationGate(status())).toEqual({
      allowed: true,
      tooltip: "Validation unavailable — applying unchecked YAML",
    });

    // Typed in, too: still nothing sent.
    act(() => store().setText(`${TEXT}# \u001b\n`));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_CONTROL_CHARACTER_MESSAGE });
  });

  it("sends nothing for whitespace-only text, which counts as empty: idle", async () => {
    mount();
    open({ yamlContent: "  \n\t\n\r\n" });
    await flush();
    expect(validate).not.toHaveBeenCalled();
    expect(status()).toEqual({ status: "idle" });

    open();
    await flush();
    validate.mockClear();
    act(() => store().setText("   \n"));
    expect(status()).toEqual({ status: "idle" });
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 2);
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("every load is an opening", () => {
  it("a load of the same version, with the same text and pin, checks at once and never sticks at validating", async () => {
    mount();
    open();
    await flush();
    expect(status().status).toBe("valid");

    open();
    expect(validate).toHaveBeenCalledTimes(2);
    await flush();
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("reloadOpenVersion (after a refused publish) opening the same content checks it at once", async () => {
    mount();
    open();
    await flush();
    const { configuration, version } = store();
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue({
      configuration: configuration!,
      version: version!,
      versions: store().versions,
    });

    await act(async () => reloadOpenVersion(GROUP_ID, MINE.id, version!.id, () => true));
    await flush();

    expect(store().loadCount).toBeGreaterThan(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("drops an answer asked for before the load, the same subject as after it", async () => {
    mount();
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    open();
    open();
    await act(async () => pending.resolve(INVALID));
    await flush();

    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });
});

describe("the pin on screen is always the one checked", () => {
  /** The API: its own saved pin when none is sent, and an answer per pin (OTHER_PIN refuses the text). */
  function serverWithPin(saved: () => string) {
    validate.mockImplementation(async (_organizationId, _configurationId, _versionId, request) => {
      const pin = request.collectorVersion ?? saved();
      return pin === OTHER_PIN ? { ...INVALID, collectorVersion: OTHER_PIN } : { ...VALID, collectorVersion: pin };
    });
  }

  it("a pin picked back during a save is checked as the pin on screen, not the server's saved one", async () => {
    let serverPin = PIN;
    serverWithPin(() => serverPin);
    mount();
    const version = open();
    await flush();
    act(() => store().setCollectorVersion(OTHER_PIN));
    await flush();
    // The save sends OTHER_PIN and lands; meanwhile the person picks PIN back.
    const picks = store().collectorVersionPicks;
    serverPin = OTHER_PIN;
    act(() => store().setCollectorVersion(PIN));
    await flush();
    act(() => store().markSaved(TEXT, { ...version, collectorVersion: OTHER_PIN }, undefined, picks));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(store().collectorVersion).toBe(PIN);
    expect(sent().at(-1)).toEqual({ yaml: TEXT, collectorVersion: PIN });
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("another tab's saved pin never answers for the pin on screen", async () => {
    // A teammate saved OTHER_PIN; this tab still shows PIN, untouched.
    serverWithPin(() => OTHER_PIN);
    mount();
    open();
    await flush();

    expect(sent()).toEqual([{ yaml: TEXT, collectorVersion: PIN }]);
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("a published version still sends its pin", async () => {
    mount();
    open(PUBLISHED_FIELDS);
    await flush();

    expect(sent()).toEqual([{ yaml: TEXT, collectorVersion: PIN }]);
  });

  it("an answer about another collector version than the one asked is unexpected: unavailable", async () => {
    validate.mockResolvedValue({ ...VALID, collectorVersion: OTHER_PIN });
    mount();
    open();
    await flush();

    expect(status()).toEqual({ status: "unavailable", message: "The server returned an unexpected response." });
  });
});

describe("only the newest answer", () => {
  it("drops an older text's answer that arrives after a newer one", async () => {
    mount();
    open();
    await flush();
    const older = deferred();
    const newer = deferred();
    validate.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    act(() => store().setText(`${TEXT}# older\n`));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(sent().slice(-2)).toEqual([
      { yaml: `${TEXT}# older\n`, collectorVersion: PIN },
      { yaml: TYPED, collectorVersion: PIN },
    ]);

    await act(async () => newer.resolve(VALID));
    await act(async () => older.resolve(INVALID));

    expect(store().validation).toMatchObject({ text: TYPED, outcome: { status: "valid" } });
    expect(status().status).toBe("valid");
  });

  it("drops an older pin's answer that arrives after a newer one", async () => {
    mount();
    open();
    await flush();
    const older = deferred();
    const newer = deferred();
    validate.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    act(() => store().setCollectorVersion(OTHER_PIN));
    act(() => store().setCollectorVersion("0.160.0"));
    await act(async () => newer.resolve({ ...VALID, collectorVersion: "0.160.0" }));
    await act(async () => older.resolve({ ...INVALID, collectorVersion: OTHER_PIN }));

    expect(status()).toEqual({ status: "valid", collectorVersion: "0.160.0", requirements: [] });
  });

  it("drops an answer for the text before a change, even with nothing newer sent yet", async () => {
    mount();
    open();
    await flush();
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    act(() => store().setText(`${TEXT}# first\n`));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);

    act(() => store().setText(TYPED));
    await act(async () => pending.resolve(INVALID));

    expect(status()).toEqual({ status: "validating" });
  });

  it("an invalid answer with no errors shows as unavailable, never 0 errors", async () => {
    validate.mockResolvedValue({ status: "invalid", collectorVersion: PIN, errors: [], requirements: [] });
    mount();
    open();
    await flush();

    expect(status().status).toBe("unavailable");
  });
});

describe("a superseded check is aborted", () => {
  it("a re-pick aborts the check still in flight, so only the newest waits", async () => {
    mount();
    open();
    await flush();
    validate.mockImplementation(untilAborted);

    act(() => store().setCollectorVersion(OTHER_PIN));
    act(() => store().setCollectorVersion("0.160.0"));
    await flush();

    expect(sent().slice(1)).toEqual([
      { yaml: TEXT, collectorVersion: OTHER_PIN },
      { yaml: TEXT, collectorVersion: "0.160.0" },
    ]);
    expect(signalOf(1)?.aborted).toBe(true);
    expect(signalOf(2)?.aborted).toBe(false);
  });

  it("a text change aborts the check in flight at once, before the debounce sends the next", async () => {
    mount();
    validate.mockImplementation(untilAborted);
    open();
    await flush();
    expect(signalOf(0)?.aborted).toBe(false);

    act(() => store().setText(TYPED));

    expect(signalOf(0)?.aborted).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TYPED, collectorVersion: PIN },
    ]);
    expect(signalOf(1)?.aborted).toBe(false);
  });

  it("stopping aborts the check in flight", async () => {
    validate.mockImplementation(untilAborted);
    const { unmount } = mount();
    open();
    await flush();
    expect(signalOf(0)?.aborted).toBe(false);

    unmount();

    expect(signalOf(0)?.aborted).toBe(true);
  });

  it("an aborted check shows nothing (no unavailable) and is never asked again", async () => {
    mount();
    validate.mockImplementation(untilAborted);
    open();
    await flush();
    const kept: string[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (state.validation !== null) kept.push(state.validation.outcome.status);
    });

    act(() => store().setText(TYPED));
    await flush();

    expect(signalOf(0)?.aborted).toBe(true);
    expect(store().validation).toBeNull();
    expect(status()).toEqual({ status: "validating" });
    validate.mockResolvedValue(VALID);
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 10);
    unsubscribe();

    // One check for the typed text, after the debounce: the aborted one was never sent again.
    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TYPED, collectorVersion: PIN },
    ]);
    expect(kept).toEqual(["valid"]);
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });
});

describe("the answers", () => {
  it("retired: the pin is deprecated, not checked", async () => {
    validate.mockResolvedValue({ status: "retired", collectorVersion: "0.155.0", errors: [], requirements: [] });
    mount();
    open({ collectorVersion: "0.155.0" });
    await flush();

    expect(status()).toEqual({ status: "retired", collectorVersion: "0.155.0" });
  });

  it("any other refusal: unavailable with the API's message", async () => {
    validate.mockRejectedValue(new ApiError("configuration_not_found", "Configuration not found", { status: 404 }));
    mount();
    open();
    await flush();

    expect(status()).toEqual({ status: "unavailable", message: "Configuration not found" });
  });

  it("a 429 shows unavailable with the API's message, and is asked again after its Retry-After", async () => {
    validate.mockRejectedValueOnce(
      new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 7 }),
    );
    mount();
    open();
    await flush();
    expect(status()).toEqual({ status: "unavailable", message: RATE_LIMITED });

    await vi.advanceTimersByTimeAsync(6_999);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TEXT, collectorVersion: PIN },
    ]);
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("an in-flight 429 (Retry-After 1) is asked again every second for 60 s after the first refusal, then gives up", async () => {
    const IN_FLIGHT = "Too many checks at once. Checking again shortly.";
    validate.mockRejectedValue(new ApiError("validation_rate_limited", IN_FLIGHT, { status: 429, retryAfterSeconds: 1 }));
    mount();
    open();
    await flush();
    expect(validate).toHaveBeenCalledTimes(1);

    // Asks at 1 s, 2 s, … 60 s after the first refusal: never fewer than a slot's 20 s.
    for (let second = 1; second <= 60; second += 1) {
      await vi.advanceTimersByTimeAsync(999);
      expect(validate).toHaveBeenCalledTimes(second);
      await vi.advanceTimersByTimeAsync(1);
      expect(validate).toHaveBeenCalledTimes(second + 1);
      if (second < 60) expect(status()).toEqual({ status: "unavailable", message: IN_FLIGHT });
    }
    expect(RATE_LIMIT_RETRY_WINDOW_MS).toBe(60_000);
    // The ask at 60 s was refused too: the next would fall outside the window.
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(validate).toHaveBeenCalledTimes(61);
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
  });

  it("a per-minute 429 (Retry-After 45) is asked again once inside the window, then gives up", async () => {
    validate.mockRejectedValue(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 45 }));
    mount();
    open();
    await flush();
    expect(status()).toEqual({ status: "unavailable", message: RATE_LIMITED });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(2);
    // Refused again at 45 s: another 45 s would end 90 s after the first refusal.
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("a retry landing exactly 60 s after the first refusal is still sent", async () => {
    validate
      .mockRejectedValueOnce(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 45 }))
      .mockRejectedValueOnce(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 15 }));
    mount();
    open();
    await flush();

    await vi.advanceTimersByTimeAsync(45_000);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(status()).toEqual({ status: "unavailable", message: RATE_LIMITED });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(validate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(status()).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });
  });

  it("gives up at once when the first refusal's Retry-After falls outside the window", async () => {
    validate.mockRejectedValue(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 61 }));
    mount();
    open();
    await flush();

    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("a Retry-After of 0 still waits a second, never asking in a tight loop", async () => {
    validate.mockRejectedValue(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 0 }));
    mount();
    open();
    await flush();

    await vi.advanceTimersByTimeAsync(999);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(validate).toHaveBeenCalledTimes(61);
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
  });

  it("after giving up, a change asks again with a fresh minute", async () => {
    validate.mockRejectedValue(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 45 }));
    mount();
    open();
    await flush();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });

    // The change is refused too, and is asked about again 45 s later: its own window.
    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(status()).toEqual({ status: "unavailable", message: RATE_LIMITED });
    validate.mockResolvedValue(VALID);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(validate).toHaveBeenCalledTimes(4);
    expect(sent().at(-1)).toEqual({ yaml: TYPED, collectorVersion: PIN });
    expect(status().status).toBe("valid");
  });

  it("a change while retrying starts a fresh minute: an earlier refusal doesn't count against it", async () => {
    validate.mockRejectedValue(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 30 }));
    mount();
    open();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(status()).toEqual({ status: "unavailable", message: RATE_LIMITED });

    // 40 s after the first text's first refusal, the new text's first refusal opens its own window.
    await vi.advanceTimersByTimeAsync(8_000);
    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(validate).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(validate).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(validate).toHaveBeenCalledTimes(5);
    expect(status()).toEqual({ status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
  });

  it("waits 1 s after a 429 when no Retry-After could be read", async () => {
    validate.mockRejectedValueOnce(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429 }));
    mount();
    open();
    await flush();

    await vi.advanceTimersByTimeAsync(999);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(status().status).toBe("valid");
  });

  it("a change while a 429 waits cancels the retry: the change checks on its own", async () => {
    validate.mockRejectedValueOnce(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 5 }));
    mount();
    open();
    await flush();

    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent()).toEqual([
      { yaml: TEXT, collectorVersion: PIN },
      { yaml: TYPED, collectorVersion: PIN },
    ]);
  });
});

describe("unmounting", () => {
  it("cancels the debounce", async () => {
    const { unmount } = mount();
    open();
    await flush();
    act(() => store().setText(TYPED));

    unmount();
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 2);
    act(() => store().setText(`${TEXT}# after\n`));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS * 2);

    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("drops an answer still to come", async () => {
    const { unmount } = mount();
    open();
    await flush();
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    act(() => store().setText(TYPED));
    await vi.advanceTimersByTimeAsync(VALIDATION_DEBOUNCE_MS);
    expect(validate).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => pending.resolve(INVALID));

    expect(store().validation?.text).toBe(TEXT);
    expect(status()).toEqual({ status: "validating" });
  });

  it("cancels a 429's retry", async () => {
    validate.mockRejectedValueOnce(new ApiError("validation_rate_limited", RATE_LIMITED, { status: 429, retryAfterSeconds: 3 }));
    const { unmount } = mount();
    open();
    await flush();

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
