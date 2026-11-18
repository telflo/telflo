import {
  DEFAULT_USER_PREFERENCES,
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  type EditorFontSize,
  type EditorTabSize,
} from "@telflo/contracts";
import { useId } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Switch } from "~/components/ui/switch.js";
import { useSavePreference } from "~/lib/preferences.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * Settings › Editor (ADR 0018; D21 decision 31). Each control saves its
 * own key (decision 33): the user store takes it at once, so every open
 * Monaco follows (`use-editor-preferences.ts`), and a failure restores that
 * key alone and toasts "Failed to update preferences".
 *
 * The Selects' item values are the numbers, fixed sentinels: no text the
 * person typed is ever a value (`security.md`'s rule for Select values).
 */

/** The "YAML Indentation" Select's items: contracts' tab sizes, valued by the number. */
export const TAB_SIZE_ITEMS = EDITOR_TAB_SIZES.map((size) => ({ value: String(size), label: `${size} spaces` }));

/** The "Font Size" Select's items: contracts' font sizes (12px to 20px, no 17 or 19), valued by the number. */
export const FONT_SIZE_ITEMS = EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` }));

/** The number a Select's item value names, if it is one of `allowed`. */
function chosenNumber<Allowed extends number>(value: string, allowed: readonly Allowed[]): Allowed | undefined {
  return allowed.find((size) => String(size) === value);
}

export function EditorPreferencesSection() {
  const editor = useCurrentUser()?.preferences.editor ?? DEFAULT_USER_PREFERENCES.editor;
  const save = useSavePreference();
  const id = useId();
  const tabSizeId = `${id}-tab-size`;
  const fontSizeId = `${id}-font-size`;
  const lineNumbersId = `${id}-line-numbers`;
  const minimapId = `${id}-minimap`;

  const chooseTabSize = (value: string) => {
    const size: EditorTabSize | undefined = chosenNumber(value, EDITOR_TAB_SIZES);
    if (size !== undefined && size !== editor.tabSize) void save("editor.tabSize", size);
  };
  const chooseFontSize = (value: string) => {
    const size: EditorFontSize | undefined = chosenNumber(value, EDITOR_FONT_SIZES);
    if (size !== undefined && size !== editor.fontSize) void save("editor.fontSize", size);
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Editor Preferences</CardTitle>
        <CardDescription>Customize the editor experience</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* YAML Indentation */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label id={`${tabSizeId}-label`}>YAML Indentation</Label>
            <p id={`${tabSizeId}-description`} className="text-[13px] text-muted-foreground">
              Number of spaces for indentation
            </p>
          </div>
          <Select value={String(editor.tabSize)} onValueChange={chooseTabSize}>
            <SelectTrigger
              className="w-[120px]"
              aria-labelledby={`${tabSizeId}-label`}
              aria-describedby={`${tabSizeId}-description`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TAB_SIZE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Font Size */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label id={`${fontSizeId}-label`}>Font Size</Label>
            <p id={`${fontSizeId}-description`} className="text-[13px] text-muted-foreground">
              Text size in the YAML editor
            </p>
          </div>
          <Select value={String(editor.fontSize)} onValueChange={chooseFontSize}>
            <SelectTrigger
              className="w-[120px]"
              aria-labelledby={`${fontSizeId}-label`}
              aria-describedby={`${fontSizeId}-description`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_SIZE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Line Numbers */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor={lineNumbersId}>Show Line Numbers</Label>
            <p id={`${lineNumbersId}-description`} className="text-[13px] text-muted-foreground">
              Display line numbers in the editor
            </p>
          </div>
          <Switch
            id={lineNumbersId}
            aria-describedby={`${lineNumbersId}-description`}
            checked={editor.lineNumbers}
            onCheckedChange={(checked) => void save("editor.lineNumbers", checked)}
          />
        </div>

        {/* Minimap */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor={minimapId}>Show Minimap</Label>
            <p id={`${minimapId}-description`} className="text-[13px] text-muted-foreground">
              Display a minimap preview on the right side
            </p>
          </div>
          <Switch
            id={minimapId}
            aria-describedby={`${minimapId}-description`}
            checked={editor.minimap}
            onCheckedChange={(checked) => void save("editor.minimap", checked)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
