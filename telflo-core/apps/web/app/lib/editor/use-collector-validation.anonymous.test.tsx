import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { checkingPausedText, retiredText, UNAVAILABLE_TEXT, ValidationStatus } from "~/components/editor/ValidationStatus.js";
import { selectCollectorValidation, useEditorStore } from "~/lib/stores/editor-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { MINE, versionFixture } from "~/test/configurations.js";
import {
  ANONYMOUS_VALIDATION,
  ANONYMOUS_VALIDATION_DEBOUNCE_MS,
  SIGNED_IN_VALIDATION,
  startCollectorValidation,
  VALIDATION_DEBOUNCE_MS,
  VALIDATION_TOO_LARGE_MESSAGE,
} from "./use-collector-validation.js";

/*
 * The playground's validation source: the anonymous validate, 1.5 s after
 * an opening or a change, its 429 counted down ("Checking paused — try
 * again in N s") and asked again then; a retired pin shown as the signed-in
 * editor shows it; a 413 as too large. The signed-in source is the default
 * (its own tests are use-collector-validation.test.tsx).
 */

const TEXT = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n";
const PIN = "0.162.0";
const initial = useEditorStore.getState();
const store = () => useEditorStore.getState();
const flush = () => act(async () => {});

let stop: () => void = () => undefined;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  useEditorStore.setState(initial, true);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

function open() {
  act(() =>
    store().load({
      organizationId: SAMPLE_ORGANIZATION_ID,
      configuration: MINE,
      version: versionFixture({ yamlContent: TEXT, collectorVersion: PIN }),
    }),
  );
}

describe("the sources", () => {
  it("are the signed-in editor's by default (2 s, an opening checked at once), the playground's 1.5 s after an opening too", () => {
    expect(SIGNED_IN_VALIDATION).toMatchObject({ debounceMs: VALIDATION_DEBOUNCE_MS, checkOpenedAtOnce: true, rateLimitedCode: "validation_rate_limited", showsCountdown: false });
    expect(ANONYMOUS_VALIDATION).toMatchObject({ debounceMs: 1500, checkOpenedAtOnce: false, rateLimitedCode: "rate_limited", showsCountdown: true });
    expect(ANONYMOUS_VALIDATION_DEBOUNCE_MS).toBe(1500);
  });
});

describe("the anonymous source", () => {
  it("waits 1.5 s after an opening and after a change, and asks the anonymous route only, with the text, the distribution and the pin", async () => {
    const anonymous = vi.spyOn(apiClient, "validateAnonymously").mockResolvedValue({ valid: true, collectorVersion: PIN, errors: [] });
    const signedIn = vi.spyOn(apiClient, "validateVersion");
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    await act(() => vi.advanceTimersByTimeAsync(1499));
    expect(anonymous).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(anonymous).toHaveBeenCalledTimes(1);
    const [request, options] = anonymous.mock.calls[0]!;
    expect(Object.keys(request).sort()).toEqual(["collectorVersion", "distribution", "yaml"]);
    expect(request.yaml === TEXT).toBe(true);
    expect(request.distribution).toBe(MINE.collectorDistribution);
    expect(request.collectorVersion).toBe(PIN);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    await flush();
    expect(selectCollectorValidation(store())).toEqual({ status: "valid", collectorVersion: PIN, requirements: [] });

    act(() => store().setText(`${TEXT}# typed\n`));
    await act(() => vi.advanceTimersByTimeAsync(1499));
    expect(anonymous).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("an unchanged text is not asked again", async () => {
    const anonymous = vi.spyOn(apiClient, "validateAnonymously").mockResolvedValue({ valid: true, collectorVersion: PIN, errors: [] });
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    act(() => store().setText(`${TEXT}# typed\n`));
    act(() => store().setText(TEXT));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(anonymous).toHaveBeenCalledTimes(1);
  });

  it("reads an invalid answer's errors, with no requirements", async () => {
    vi.spyOn(apiClient, "validateAnonymously").mockResolvedValue({
      valid: false,
      collectorVersion: PIN,
      errors: [{ message: "unknown type", componentPath: "receivers.otlp" }],
    });
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    expect(selectCollectorValidation(store())).toMatchObject({ status: "invalid", requirements: [] });
  });

  it("counts a 429 rate_limited down from its Retry-After, and asks again then", async () => {
    const anonymous = vi
      .spyOn(apiClient, "validateAnonymously")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many attempts. Please wait and try again.", { status: 429, retryAfterSeconds: 7 }))
      .mockResolvedValue({ valid: true, collectorVersion: PIN, errors: [] });
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    render(<ValidationStatus onJump={() => undefined} />);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    const outcome = selectCollectorValidation(store());
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && typeof outcome.retryAt).toBe("number");
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.getByText(checkingPausedText(7))).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText(checkingPausedText(4))).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3999));
    expect(anonymous).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(anonymous).toHaveBeenCalledTimes(2);
    await flush();
    expect(selectCollectorValidation(store())).toMatchObject({ status: "valid" });
    expect(screen.queryByText(/Checking paused/)).toBeNull();
  });

  it("shows a retired pin as the signed-in editor does", async () => {
    vi.spyOn(apiClient, "validateAnonymously").mockRejectedValue(
      new ApiError("collector_version_retired", "That collector version is retired.", { status: 400 }),
    );
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    render(<ValidationStatus onJump={() => undefined} />);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    expect(selectCollectorValidation(store())).toEqual({ status: "retired", collectorVersion: PIN });
    expect(screen.getByText(retiredText(PIN))).toBeInTheDocument();
  });

  it("says a 413 is too large to check, not that checking is unavailable for another reason", async () => {
    vi.spyOn(apiClient, "validateAnonymously").mockRejectedValue(
      new ApiError("payload_too_large", "The request body is too large.", { status: 413 }),
    );
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    render(<ValidationStatus onJump={() => undefined} />);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    expect(selectCollectorValidation(store())).toEqual({ status: "unavailable", message: VALIDATION_TOO_LARGE_MESSAGE });
    expect(screen.getByText(VALIDATION_TOO_LARGE_MESSAGE)).toBeInTheDocument();
  });

  it("says the gateway's own 413 (an HTML page, read as unexpected_response) is too large to check too", async () => {
    vi.spyOn(apiClient, "validateAnonymously").mockRejectedValue(
      new ApiError("unexpected_response", "The server returned an unexpected error.", { status: 413 }),
    );
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    expect(selectCollectorValidation(store())).toEqual({ status: "unavailable", message: VALIDATION_TOO_LARGE_MESSAGE });
  });

  it("shows an unknown pin's refusal in the API's words, as the signed-in editor shows a refusal", async () => {
    vi.spyOn(apiClient, "validateAnonymously").mockRejectedValue(
      new ApiError("collector_version_unknown", "That collector version isn't offered.", { status: 400 }),
    );
    open();
    stop = startCollectorValidation(ANONYMOUS_VALIDATION);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await flush();
    expect(selectCollectorValidation(store())).toEqual({ status: "unavailable", message: "That collector version isn't offered." });
  });
});
