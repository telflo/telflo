import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  isBlankRuleText,
  ruleTextTooLongMessage,
  TEST_REGEX_CATEGORY_MAXIMUM_LENGTH,
  TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_REGEX_NAME_MAXIMUM_LENGTH,
  TEST_REGEX_REGEX_MAXIMUM_BYTES,
  trimLibraryText,
  utf8ByteLength,
  type CreateTestRegexRequest,
  type TestRegex,
  type UpdateTestRegexRequest,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import { ApiError } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * A test regex's dialog: an entry's name, category, regex and description;
 * their placeholders, limits, messages (each shown on Create or Save, all at
 * once, each going as its field changes) and buttons ("Creating…",
 * "Saving…"); not closable while it saves; "Failed to create regex" / "Failed
 * to update regex". With the Test Template dialog's conventions:
 * - the API checks the regex under RE2: its refusal, 400
 *   `test_regex_invalid`, shows the evaluator's words under Regex, and a name
 *   another entry has, 409 `test_regex_name_taken`, the API's words under
 *   Name (two entries never share a name); each is an alert the field is
 *   described by (`aria-describedby`) and marked invalid by (`aria-invalid`),
 *   as the form's own messages are, and goes when its field changes; the
 *   dialog stays open with the text as typed;
 * - a regex of whitespace alone is no regex ("Please enter a regex
 *   pattern."), as the API judges a rule's pattern blank, and one past the
 *   API's 8,192 bytes is refused before it is sent, in the API's words; a
 *   name or category of whitespace alone, Go's included, is none, trimmed as
 *   the API trims (trimLibraryText), which is also the text sent
 *   and compared;
 * - any other refusal shows the API's words (429
 *   `validation_rule_rate_limited`, 503 `rules_unavailable`: the rules'
 *   check's), else "Failed to create regex" / "Failed to update
 *   regex" (`failureMessage`), in a toast blocked from replay
 *   (`ph-no-capture`: the evaluator's words can quote the regex); a 403
 *   `product_admin_required` (the flag cleared since the page opened) goes
 *   to `/app` (`onProductAdminLost`); a session that has ended says nothing;
 * - an edit sends only the fields it changed, as the templates dialog's: an
 *   unchanged regex isn't checked again;
 * - the dialog is inside `ph-no-capture`: Radix portals it out of
 *   the page's block. The fields' values sit under maskAllInputs too.
 */

/** The fields as the admin left them. */
interface Fields {
  name: string;
  category: string;
  regex: string;
  /** Null for none. */
  description: string | null;
}

/** The fields an edit changed, and only those. */
function changesOf(testRegex: TestRegex, fields: Fields): UpdateTestRegexRequest {
  const changes: UpdateTestRegexRequest = {};
  if (fields.name !== testRegex.name) changes.name = fields.name;
  if (fields.category !== testRegex.category) changes.category = fields.category;
  if (fields.description !== testRegex.description) changes.description = fields.description;
  if (fields.regex !== testRegex.regex) changes.regex = fields.regex;
  return changes;
}

/** 400 `test_regex_invalid`'s problems' words (`details.problems`, each under `regex`), else its message alone. */
function regexProblemsOf(error: ApiError): string[] {
  const { details } = error;
  const listed = typeof details === "object" && details !== null && "problems" in details ? details.problems : undefined;
  const messages = Array.isArray(listed)
    ? listed.flatMap((each: unknown): string[] =>
        typeof each === "object" && each !== null && "message" in each && typeof each.message === "string" ? [each.message] : [],
      )
    : [];
  return messages.length > 0 ? messages : [error.message];
}

/** Whether a name or a category holds nothing once trimmed as the API trims it (trimLibraryText). */
const isBlankField = (text: string) => trimLibraryText(text) === "";

/** What the Regex field says before anything is sent: none, "Please enter a regex pattern.", or the API's words for a regex too long. */
function regexFormProblem(regex: string): string | null {
  if (isBlankRuleText(regex)) return "Please enter a regex pattern.";
  if (utf8ByteLength(regex) > TEST_REGEX_REGEX_MAXIMUM_BYTES) return ruleTextTooLongMessage("regex");
  return null;
}

const NAME_ERROR_ID = "test-regex-name-error";
const CATEGORY_ERROR_ID = "test-regex-category-error";
const PATTERN_ERROR_ID = "test-regex-pattern-error";

/** A field's tie to the messages about it: described by them, invalid while there are any. */
function describedBy(ids: string[]) {
  return ids.length === 0 ? {} : { "aria-describedby": ids.join(" "), "aria-invalid": true as const };
}

interface TestRegexDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entry being edited, or null for a new one. */
  testRegex: TestRegex | null;
  /** Creates it; throws the API's refusal. */
  onCreate: (request: CreateTestRegexRequest) => Promise<void>;
  /** Sends an edit's changes; throws the API's refusal. */
  onUpdate: (testRegexId: string, changes: UpdateTestRegexRequest) => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): back to its opener unless prevented. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function TestRegexDialog({
  open,
  onOpenChange,
  testRegex,
  onCreate,
  onUpdate,
  onProductAdminLost,
  onCloseAutoFocus,
}: TestRegexDialogProps) {
  const isEdit = testRegex !== null;

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [pattern, setPattern] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [categoryError, setCategoryError] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);
  /** 409 `test_regex_name_taken`'s words, under Name until the name changes. */
  const [nameRefusal, setNameRefusal] = useState<string | null>(null);
  /** 400 `test_regex_invalid`'s words, under Regex until the regex changes. */
  const [regexProblems, setRegexProblems] = useState<string[]>([]);

  // Re-seed from the row being edited: the dialog is reused across rows.
  useEffect(() => {
    if (!open) return;
    setName(testRegex?.name ?? "");
    setCategory(testRegex?.category ?? "");
    setPattern(testRegex?.regex ?? "");
    setDescription(testRegex?.description ?? "");
    setNameError(false);
    setCategoryError(false);
    setPatternError(null);
    setNameRefusal(null);
    setRegexProblems([]);
    setSubmitting(false);
  }, [open, testRegex]);

  const handleOk = async () => {
    // Trimmed as the API trims (trimLibraryText): what it will store, so changesOf compares that.
    const trimmedName = trimLibraryText(name);
    const trimmedCategory = trimLibraryText(category);
    // A regex is never trimmed: its spaces are part of it.
    const trimmedPattern = pattern;
    const trimmedDescription = trimLibraryText(description);

    const nameValid = !isBlankField(name);
    const categoryValid = !isBlankField(category);
    const patternProblem = regexFormProblem(trimmedPattern);

    setNameError(!nameValid);
    setCategoryError(!categoryValid);
    setPatternError(patternProblem);

    if (!nameValid || !categoryValid || patternProblem !== null) return;

    const fields: Fields = {
      name: trimmedName,
      category: trimmedCategory,
      regex: trimmedPattern,
      description: trimmedDescription || null,
    };
    setSubmitting(true);
    setNameRefusal(null);
    setRegexProblems([]);
    try {
      if (testRegex !== null) await onUpdate(testRegex.id, changesOf(testRegex, fields));
      else await onCreate(fields);
      onOpenChange(false);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        onProductAdminLost();
        return;
      }
      if (error instanceof ApiError && error.code === "test_regex_name_taken") {
        setNameRefusal(error.message);
      } else if (error instanceof ApiError && error.code === "test_regex_invalid") {
        setRegexProblems(regexProblemsOf(error));
      } else {
        const message = failureMessage(error, isEdit ? "Failed to update regex" : "Failed to create regex");
        // The API's words (the evaluator's can quote the regex): blocked from replay, as the Toaster sits outside every block.
        if (message !== null) toast.error(message, { className: "ph-no-capture" });
      }
      setSubmitting(false);
    }
  };

  const nameMessageIds = [...(nameError ? [NAME_ERROR_ID] : []), ...(nameRefusal !== null ? [`${NAME_ERROR_ID}-api`] : [])];
  const patternMessageIds = [
    ...(patternError !== null ? [PATTERN_ERROR_ID] : []),
    ...regexProblems.map((_, index) => `${PATTERN_ERROR_ID}-api-${index}`),
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="ph-no-capture sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Test Regex" : "New Test Regex"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="test-regex-name" className="mb-2 block">
              Name
            </Label>
            <Input
              id="test-regex-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(false);
                if (nameRefusal !== null) setNameRefusal(null);
              }}
              placeholder="e.g., IPv4 address"
              autoFocus
              maxLength={TEST_REGEX_NAME_MAXIMUM_LENGTH}
              disabled={submitting}
              {...describedBy(nameMessageIds)}
            />
            {nameError && (
              <p id={NAME_ERROR_ID} className="text-xs text-fail" role="alert">
                Please enter a name.
              </p>
            )}
            {nameRefusal !== null && (
              <p id={`${NAME_ERROR_ID}-api`} className="text-xs text-fail" role="alert">
                {nameRefusal}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-regex-category" className="mb-2 block">
              Category
            </Label>
            <Input
              id="test-regex-category"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                if (categoryError) setCategoryError(false);
              }}
              placeholder="e.g., Network"
              maxLength={TEST_REGEX_CATEGORY_MAXIMUM_LENGTH}
              disabled={submitting}
              {...describedBy(categoryError ? [CATEGORY_ERROR_ID] : [])}
            />
            {categoryError && (
              <p id={CATEGORY_ERROR_ID} className="text-xs text-fail" role="alert">
                Please enter a category.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-regex-pattern" className="mb-2 block">
              Regex
            </Label>
            <Input
              id="test-regex-pattern"
              value={pattern}
              onChange={(event) => {
                setPattern(event.target.value);
                if (patternError !== null) setPatternError(null);
                if (regexProblems.length > 0) setRegexProblems([]);
              }}
              placeholder="e.g., \b\d{1,3}(?:\.\d{1,3}){3}\b"
              className="font-mono"
              disabled={submitting}
              {...describedBy(patternMessageIds)}
            />
            {patternError !== null && (
              <p id={PATTERN_ERROR_ID} className="text-xs text-fail" role="alert">
                {patternError}
              </p>
            )}
            {regexProblems.map((message, index) => (
              <p key={index} id={`${PATTERN_ERROR_ID}-api-${index}`} className="text-xs text-fail" role="alert">
                {message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-regex-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="test-regex-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional — describe what this pattern matches"
              rows={3}
              maxLength={TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH}
              disabled={submitting}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleOk()} disabled={submitting}>
            {submitting ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
