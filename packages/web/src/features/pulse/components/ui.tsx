import React, { useEffect, useId, useRef } from "react";

export function Modal(props: {
  title: string;
  className?: string;
  outcome?: "success" | "mixed" | "fail";
  onClose?: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => {
      const first =
        dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.setTimeout(() => previousFocus?.focus(), 0);
    };
  }, []);

  const strip =
    props.outcome === "success"
      ? "outcome-strip-success"
      : props.outcome === "mixed"
        ? "outcome-strip-mixed"
        : props.outcome === "fail"
          ? "outcome-strip-fail"
          : "";

  return (
    <div
      className={`overlay-backdrop ${props.className ?? ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && props.onClose)
          props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={`modal-header ${strip}`}>
          <span id={titleId}>{props.title}</span>
          {props.onClose && (
            <button
              className="pulse-modal-close"
              type="button"
              aria-label="Close dialog"
              onClick={props.onClose}
            >
              Close
            </button>
          )}
        </div>
        <div className="modal-body">{props.children}</div>
        {props.actions && <div className="modal-actions">{props.actions}</div>}
      </div>
    </div>
  );
}

export function ToggleSwitch(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      className="toggle-control"
      style={props.disabled ? { opacity: 0.55 } : undefined}
      title={props.title}
    >
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className={`toggle-switch ${props.checked ? "is-on" : ""}`}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function ToastHost({
  toast,
  onExpire,
}: {
  toast: { tone: string; message: string; id: number } | null;
  onExpire: () => void;
}) {
  const lastId = useRef<number | null>(null);
  useEffect(() => {
    if (!toast || lastId.current === toast.id) return;
    lastId.current = toast.id;
    const timer = window.setTimeout(onExpire, 4200);
    return () => window.clearTimeout(timer);
  }, [toast, onExpire]);
  if (!toast) return null;
  return (
    <div className="toast-host">
      <div key={toast.id} className={`toast ${toast.tone}`}>
        {toast.message}
      </div>
    </div>
  );
}
