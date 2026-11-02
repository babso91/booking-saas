"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const lost = () =>
  document.activeElement === null || document.activeElement === document.body;

/**
 * A small menu opened by a button (Studio and Écrin, on a phone). Focus is
 * never lost when it closes: back on its button, unless she has moved on, and
 * on `fallback` if that button itself goes away.
 */
export function useOptionsMenu(fallback: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const press = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (lost() || root.current?.contains(document.activeElement))
        trigger.current?.focus();
      setOpen(false);
    };
    const onPointerDown = (event: Event) => {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
      // What she pressed takes the focus; if it cannot, nothing is lost. A
      // press that ends without a click (she was scrolling) moves nothing.
      const current = new AbortController();
      press.current = current;
      const { signal } = current;
      const end = () => current.abort();
      document.addEventListener(
        "click",
        () => {
          end();
          if (lost()) trigger.current?.focus({ preventScroll: true });
        },
        { signal },
      );
      document.addEventListener("pointercancel", end, {
        signal,
        capture: true,
      });
      document.addEventListener("pointerdown", end, { signal, capture: true });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // That press outlives the menu's opening, not the menu.
  useEffect(() => () => press.current?.abort(), []);

  // The menu goes away with its button (the screen widened): only a focus
  // that was inside moves, never one she has placed elsewhere.
  useLayoutEffect(() => {
    const menu = root.current;
    const destination = fallback.current;
    return () => {
      if (menu?.contains(document.activeElement))
        destination?.focus({ preventScroll: true });
    };
  }, [fallback]);

  return {
    open,
    root,
    trigger,
    toggle: () => setOpen((value) => !value),
    /** An option that opens something else: which will give focus back here. */
    leaveFor: (next: () => void) => {
      trigger.current?.focus();
      setOpen(false);
      next();
    },
  };
}
