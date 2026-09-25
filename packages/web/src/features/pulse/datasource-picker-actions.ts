// Keyboard navigation for the custom datasource option list. The picker is a
// search combobox over a div-based listbox (no native <select>), so arrow keys
// have to be wired up by hand. This pure resolver keeps that logic testable and
// out of the component: given the pressed key, the active option index, and the
// option count, it returns the action the component should apply.

export type DatasourceListKeyAction =
  | { type: 'none' }
  | { type: 'move'; index: number }
  | { type: 'select'; index: number };

export function resolveDatasourceListKey(
  key: string,
  activeIndex: number,
  count: number,
): DatasourceListKeyAction {
  if (count === 0) return { type: 'none' };
  const last = count - 1;
  const clamp = (index: number) => Math.max(0, Math.min(index, last));
  switch (key) {
    case 'ArrowDown':
      return { type: 'move', index: clamp(activeIndex + 1) };
    case 'ArrowUp':
      return { type: 'move', index: clamp(activeIndex - 1) };
    case 'Home':
      return { type: 'move', index: 0 };
    case 'End':
      return { type: 'move', index: last };
    case 'Enter':
      // Enter selects the active option only when the index is in range.
      if (activeIndex < 0 || activeIndex > last) return { type: 'none' };
      return { type: 'select', index: activeIndex };
    default:
      return { type: 'none' };
  }
}
