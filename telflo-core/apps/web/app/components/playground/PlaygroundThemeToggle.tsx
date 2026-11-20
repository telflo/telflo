import { THEMES, type Theme } from "@telflo/contracts";
import { cn } from "~/lib/utils.js";
import { usePlaygroundVisitor } from "~/lib/playground/context.js";
import { choosePlaygroundTheme } from "~/lib/playground/theme.js";

/** Each theme's word on its button. */
const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", navy: "Navy" };

/*
 * The playground's theme toggle, in the sidebar (Settings is locked here):
 * Light, Dark and Navy, Navy shown as Navy. A choice shows at once and is kept
 * as one word in the playground's own key (`choosePlaygroundTheme`); it never
 * writes the `telflo_theme` cookie. The pressed button is the theme on screen
 * (the visitor's).
 */
export function PlaygroundThemeToggle({ className }: { className?: string }) {
  const theme = usePlaygroundVisitor()?.preferences.theme ?? "dark";
  return (
    <div role="group" aria-label="Theme" className={cn("flex items-center rounded-md border border-border p-0.5", className)}>
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === theme}
          onClick={() => choosePlaygroundTheme(option)}
          className={cn(
            "h-7 flex-1 rounded-[4px] px-2 text-[12px] font-medium transition-colors",
            option === theme ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
