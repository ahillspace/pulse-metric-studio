import { useEffect, useId, useRef, type ReactNode } from 'react';
import { getFocusTrapTarget } from './workbench-focus';

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function WorkbenchModal({
  title,
  children,
  actions,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const activeItem = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = getFocusTrapTarget(focusable, activeItem, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className={`overlay-backdrop ${className ?? ''}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header" id={titleId}>
          {title}
          <button className="btn modal-close" type="button" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
