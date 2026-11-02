import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export function clampAssistantWidth(width: number, maximum = 520) {
  const upper = Math.max(0, Math.min(520, maximum));
  return Math.max(Math.min(280, upper), Math.min(upper, width));
}

export function ResizableAssistant({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(340);
  const [maximum, setMaximum] = useState(520);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const container = panel.current?.parentElement;
    if (!container) return;
    const resize = () => {
      const reserve = window.matchMedia("(max-width: 820px)").matches ? 16 : 360;
      const next = Math.max(0, Math.min(520, container.clientWidth - reserve));
      setMaximum(next);
      setWidth((current) => clampAssistantWidth(current, next));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);
  return (
    <aside
      ref={panel}
      id="pulse-assistant"
      className="pulse-assistant-panel"
      aria-label="Pulse metric agent"
      hidden={!open}
      style={{ "--assistant-width": `${width}px` } as CSSProperties}
    >
      <div
        className="pulse-assistant-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant"
        aria-valuemin={Math.min(280, maximum)}
        aria-valuemax={maximum}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setWidth(
              clampAssistantWidth(
                drag.current.width + drag.current.x - event.clientX,
                maximum,
              ),
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setWidth((value) =>
              clampAssistantWidth(
                value + (event.key === "ArrowLeft" ? 20 : -20),
                maximum,
              ),
            );
          }
        }}
      />
      {children}
    </aside>
  );
}
