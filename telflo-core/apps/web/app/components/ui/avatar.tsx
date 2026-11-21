import * as React from "react"
import { cn } from "~/lib/utils.js"

/*
 * The shadcn Avatar (AvatarImage adds `ph-no-capture`), without
 * @radix-ui/react-avatar: the same spans Radix renders, with no new
 * dependency. AvatarImage is a plain `<img alt="">`; it never decides on its
 * own whether to show: the caller (OrganizationLogo) renders EITHER the image
 * OR the fallback, and swaps to the fallback from `onError`.
 */

const Avatar = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
        className
      )}
      {...props}
    />
  )
)
Avatar.displayName = "Avatar"

const AvatarFallback = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-muted font-mono font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
)
AvatarFallback.displayName = "AvatarFallback"

/**
 * The image: `alt=""` always (a logo is organization content, never named in
 * an attribute), so it is presentational. `ph-no-capture` always, in its own
 * classes, so replay records nothing of it whoever renders it. And
 * `fetchPriority="low"` always: React's server rendering otherwise puts a
 * `<link rel="preload" as="image" href="…">` for a server-rendered `<img>` in
 * the `<head>`, outside `ph-no-capture`, and replay records it. `alt` and
 * `fetchPriority` come after the spread, so no caller can drop either. A
 * logo's address appears ONLY as the src of this `<img>`.
 */
const AvatarImage = React.forwardRef<
  HTMLImageElement,
  Omit<React.ImgHTMLAttributes<HTMLImageElement>, "alt" | "fetchPriority" | "loading">
>(({ className, ...props }, ref) => (
  <img
    ref={ref}
    className={cn("ph-no-capture aspect-square h-full w-full", className)}
    {...props}
    alt=""
    fetchPriority="low"
  />
))
AvatarImage.displayName = "AvatarImage"

export { Avatar, AvatarFallback, AvatarImage }
