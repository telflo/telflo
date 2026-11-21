import { DEFAULT_USER_PREFERENCES, type Theme } from "@telflo/contracts";
import { useRevalidator } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { useSavePreference } from "~/lib/preferences.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * Settings › Appearance. A choice is saved on its own: the user store takes
 * it at once, so `<html>`'s class, the Toaster and every Monaco follow
 * before the API answers, and the signed-in layout remembers it for the
 * auth screens. Once the answer is taken, the signed-in layout is
 * revalidated. A failure restores the previous theme and toasts "Failed to
 * update preferences".
 */

/* The three supported app themes. Swatch colors mirror each theme's app
 * background token (navy = html.navy --color-background in app.css). Every
 * swatch keeps a border so it stays visible on dark card surfaces. */
const THEME_OPTIONS: Array<{ value: Theme; label: string; swatchClass: string }> = [
  { value: "light", label: "Light", swatchClass: "bg-[#f5f6f8]" },
  { value: "dark", label: "Dark", swatchClass: "bg-[#101317]" },
  { value: "navy", label: "Navy", swatchClass: "bg-[#0c1524]" },
];

export function AppearanceSection() {
  const theme = useCurrentUser()?.preferences.theme ?? DEFAULT_USER_PREFERENCES.theme;
  const save = useSavePreference();
  const { revalidate } = useRevalidator();

  const choose = async (value: Theme) => {
    if (value === theme) return;
    if (await save("theme", value)) void revalidate();
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Choose between the light, dark, and navy themes</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, swatchClass }) => (
            <button
              key={value}
              type="button"
              onClick={() => void choose(value)}
              aria-pressed={theme === value}
              className={`h-16 rounded-md border flex flex-col items-center justify-center gap-1.5 ${
                theme === value
                  ? "border-brand ring-2 ring-brand/25"
                  : "border-border hover:border-gray-300 dark:hover:border-gray-600"
              }`}
            >
              <div className={`w-6 h-3.5 rounded-[4px] border border-black/15 dark:border-white/15 ${swatchClass}`} />
              <span className="text-[13px]">{label}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
