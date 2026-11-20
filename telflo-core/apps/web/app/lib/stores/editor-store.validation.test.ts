import { describe, expect, it, beforeEach } from "vitest";

import {
  selectCollectorValidation,
  useEditorStore,
  VALIDATION_IDLE,
  VALIDATION_VALIDATING,
  type CollectorValidationOutcome,
} from "./editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

/*
 * The validator's answer in the store: kept with the version, text and
 * pin it is for, and shown only while exactly those are on screen.
 */

const TEXT = "receivers:\n  otlp: {}\n";
const VALID: CollectorValidationOutcome = { status: "valid", collectorVersion: "0.162.0", requirements: [] };
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

function open(id?: string) {
  store().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: versionFixture({ yamlContent: TEXT, collectorVersion: "0.162.0", ...(id ? { id } : {}) }),
  });
}

function answer(outcome: CollectorValidationOutcome = VALID) {
  const { version, text, collectorVersion } = store();
  store().setValidation({ versionId: version!.id, text, collectorVersion, outcome });
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
});

describe("selectCollectorValidation", () => {
  it("is idle with no version open, and for empty text", () => {
    expect(selectCollectorValidation(store())).toBe(VALIDATION_IDLE);
    open();
    store().setText("");
    expect(selectCollectorValidation(store())).toBe(VALIDATION_IDLE);
  });

  it("is idle for whitespace-only text, which counts as empty, whatever was kept for it", () => {
    open();
    for (const blank of [" ", "\n", "  \t\r\n  \n"]) {
      store().setText(blank);
      answer();
      expect(selectCollectorValidation(store())).toBe(VALIDATION_IDLE);
    }
    store().setText(" a: 1\n");
    expect(selectCollectorValidation(store())).toBe(VALIDATION_VALIDATING);
  });

  it("is validating until an answer for this text and pin is kept, then that answer, the same object each time", () => {
    open();
    expect(selectCollectorValidation(store())).toBe(VALIDATION_VALIDATING);
    answer();
    expect(selectCollectorValidation(store())).toBe(store().validation!.outcome);
    expect(selectCollectorValidation(store())).toBe(selectCollectorValidation(store()));
  });

  it("never shows an answer for another text, another pin or another version", () => {
    open();
    answer();
    store().setText(`${TEXT}# typed\n`);
    expect(selectCollectorValidation(store())).toBe(VALIDATION_VALIDATING);
    store().setText(TEXT);
    expect(selectCollectorValidation(store()).status).toBe("valid");

    store().setCollectorVersion("0.161.0");
    expect(selectCollectorValidation(store())).toBe(VALIDATION_VALIDATING);
    store().setCollectorVersion("0.162.0");
    expect(selectCollectorValidation(store()).status).toBe("valid");

    // Kept, but for a version no longer open.
    const kept = store().validation!;
    open("0199c000-0000-7000-8000-0000000000ff");
    store().setValidation({ ...kept });
    expect(selectCollectorValidation(store())).toBe(VALIDATION_VALIDATING);
  });

  it("a load and a reset forget the answer kept; a save keeps it", () => {
    open();
    answer();
    open();
    expect(store().validation).toBeNull();
    answer();
    store().markSaved(TEXT, store().version!);
    expect(selectCollectorValidation(store()).status).toBe("valid");
    store().reset();
    expect(store().validation).toBeNull();
  });

  it("setValidation changes nothing else: not dirty, no undo entry", () => {
    open();
    const before = store();
    answer();
    const after = store();
    expect(after.text).toBe(before.text);
    expect(after.history).toBe(before.history);
    expect(after.isYamlEditing).toBe(false);
  });
});
