import type { CSSProperties } from "react"
import type { Theme } from "@telflo/contracts"
import { Toaster as Sonner } from "sonner"

type ToasterProps = Omit<React.ComponentProps<typeof Sonner>, "theme"> & {
  /** The app's theme (lib/theme.ts's usePageTheme). */
  theme: Theme
}

// sonner's own unlayered rules set each toast's colours from its
// `--normal-*` variables and beat the utility classes below, in every theme.
// So the toasts take the app's popover tokens through those variables, set
// on the toaster.
const APP_TOKENS = {
  "--normal-bg": "var(--color-popover)",
  "--normal-text": "var(--color-popover-foreground)",
  "--normal-border": "var(--color-border)",
} as CSSProperties

// Toasts follow the app's theme, not the OS's: Light is sonner's "light",
// Dark and Navy its "dark". sonner restyles toasts already showing when the
// theme changes.
const Toaster = ({ theme, style, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme === "light" ? "light" : "dark"}
      className="toaster group"
      style={{ ...APP_TOKENS, ...style }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
