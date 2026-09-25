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

export function WorkbenchFrame({ topbar, sidebar, children }: { topbar: ReactNode; sidebar?: ReactNode; children: ReactNode }) {
  return (
    <div className="app-shell">
      {topbar}
      {sidebar ? (
        <div className="shell-body">
          {sidebar}
          <main className="main-col">{children}</main>
        </div>
      ) : (
        <main className="main-col">{children}</main>
      )}
    </div>
  );
}

export function WorkbenchPanel({
  section,
  id,
  kicker,
  title,
  actions,
  children,
}: {
  section: string;
  id: string;
  kicker: string;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="panel workbench-panel" id={id} data-workbench-section={section} aria-labelledby={`${id}-title`}>
      <div className="panel-header">
        <span className="panel-kicker">{kicker}</span>
        <h2 className="panel-title" id={`${id}-title`}>{title}</h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children !== undefined && <div className="panel-body">{children}</div>}
    </section>
  );
}

export function DataTableFrame({ label, children }: { label: string; children: ReactNode }) {
  return <div className="data-table-frame" role="region" aria-label={label}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-note" role="status">{children}</div>;
}

export function WorkbenchModal({
  title,
  children,
  actions,
  onClose,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
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
    <div className="overlay-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header" id={titleId}>
          {title}
          <button className="linkish modal-close" type="button" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
