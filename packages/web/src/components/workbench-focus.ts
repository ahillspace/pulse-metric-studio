export type FocusBoundary<T> = {
  first: T;
  last: T;
};

export function getFocusBoundary<T>(items: readonly T[]): FocusBoundary<T> | null {
  if (items.length === 0) return null;
  return { first: items[0], last: items[items.length - 1] };
}

export function getFocusTrapTarget<T>(
  items: readonly T[],
  activeItem: T | null,
  shiftKey: boolean,
): T | null {
  const boundary = getFocusBoundary(items);
  if (!boundary) return null;
  if (shiftKey && activeItem === boundary.first) return boundary.last;
  if (!shiftKey && activeItem === boundary.last) return boundary.first;
  return null;
}
