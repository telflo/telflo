import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";

import type { SortableItemProps } from "./types.js";

export function SortableItem({ id, children, className, disabled = false }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // Keep the element in the layout flow but make it semi-transparent when dragging
    // The DragOverlay will show the actual dragged item
  };

  return (
    <div ref={setNodeRef} style={style} className={className}>
      {children({
        isDragging,
        dragHandleProps: {
          attributes,
          listeners,
        },
      })}
    </div>
  );
}
