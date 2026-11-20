import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { ReactNode } from "react";

/*
 * The sortable list's types: an item's id is a string built from its list's
 * fixed name and its index (`attr-0`), never a value, since dnd-kit writes ids
 * into attributes and its live region; the listeners' type comes from
 * dnd-kit's root export, not a deep import; and a reorder says which item
 * moved where (`onReorder(from, to)`), so a form moves the item's own lines.
 */

export interface DragHandleProps {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

export interface SortableItemRenderProps {
  isDragging: boolean;
  dragHandleProps: DragHandleProps;
}

export interface SortableListProps<T> {
  /** The list's fixed name (`attr`, `condition`): its items' ids are `<list>-<index>`. */
  list: string;
  items: readonly T[];
  /** The item at `from` was dropped at `to`. */
  onReorder: (from: number, to: number) => void;
  /** Renders an item; `id` is the one its `SortableItem` takes. */
  children: (item: T, index: number, id: string) => ReactNode;
  /** Optional render function for the drag overlay (shown while dragging) */
  renderOverlay?: (item: T, index: number) => ReactNode;
  className?: string;
  listClassName?: string;
  contextId?: string;
  emptyMessage?: ReactNode;
}

export interface SortableItemProps {
  id: string;
  children: (props: SortableItemRenderProps) => ReactNode;
  className?: string;
  disabled?: boolean;
}

export interface SortableHandleProps {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  className?: string;
  disabled?: boolean;
}

/** An item's id: its list's fixed name and its index, never its value. */
export function sortableId(list: string, index: number): string {
  return `${list}-${index}`;
}
