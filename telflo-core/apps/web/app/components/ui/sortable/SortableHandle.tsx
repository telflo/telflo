import { GripVertical } from "lucide-react";

import type { SortableHandleProps } from "./types.js";
import { cn } from "~/lib/utils.js";

/* A drag handle, its `gray-*`/`blue-*` classes kept. */
export function SortableHandle({ attributes, listeners, className, disabled = false }: SortableHandleProps) {
  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      disabled={disabled}
      className={cn(
        "cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 dark:hover:text-gray-300",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      aria-label="Drag to reorder"
    >
      <GripVertical className="w-4 h-4" />
    </button>
  );
}
