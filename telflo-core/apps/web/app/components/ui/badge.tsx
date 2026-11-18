import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "~/lib/utils.js"

const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border px-1.5 py-px font-mono text-[11px] font-medium uppercase tracking-[0.07em] transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-fail/25 bg-fail-soft text-fail",
        outline: "border-border text-muted-foreground",
        success: "border-ok/25 bg-ok-soft text-ok",
        warning: "border-warn/25 bg-warn-soft text-warn",
        info: "border-brand/25 bg-brand-soft text-brand",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
