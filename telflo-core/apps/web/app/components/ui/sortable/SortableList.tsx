import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useId, useState } from "react";

import { sortableId, type SortableListProps } from "./types.js";

/*
 * A sortable list (ADR 0018): pointer (8 px before a drag starts) and
 * keyboard (Space, arrows, Space) reordering, with an overlay while dragging.
 * Changed (D9b decision 9; Preflight rulings 2 and 15): ids are
 * `<list>-<index>` strings (so the overlay check never reads index 0 as
 * none), and a drop calls `onReorder(from, to)`, not the list rearranged.
 * dnd-kit's live region and instructions render inline, inside the list's own
 * element (no `accessibility.container`), and name ids only.
 */
export function SortableList<T>({
  list,
  items,
  onReorder,
  children,
  renderOverlay,
  className,
  listClassName,
  contextId,
  emptyMessage,
}: SortableListProps<T>) {
  const autoContextId = useId();
  const effectiveContextId = contextId || autoContextId;
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const itemIds = items.map((_item, index) => sortableId(list, index));

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      const oldIndex = itemIds.indexOf(String(active.id));
      const newIndex = itemIds.indexOf(String(over.id));

      if (oldIndex !== -1 && newIndex !== -1) {
        onReorder(oldIndex, newIndex);
      }
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  if (items.length === 0 && emptyMessage) {
    return <div className={className}>{emptyMessage}</div>;
  }

  const activeIndex = activeId === null ? -1 : itemIds.indexOf(activeId);

  return (
    <div className={className}>
      <DndContext
        id={effectiveContextId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <div className={listClassName}>{items.map((item, index) => children(item, index, itemIds[index]!))}</div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeIndex !== -1 && renderOverlay ? (
            <div className="shadow-lg ring-2 ring-blue-400 rounded-lg bg-white dark:bg-gray-800 opacity-90">
              {renderOverlay(items[activeIndex]!, activeIndex)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
