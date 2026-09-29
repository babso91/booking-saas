"use client";

import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

import { CloseIcon } from "./icons";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal surface: a bottom sheet on phones, a side panel from `lg` (or a
 * centred dialog with `placement="center"`). Accessible dialog semantics:
 * labelled, focus moved inside and trapped, Escape closes, focus restored to
 * the element that opened it, background scroll locked.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  placement = "side",
  initialFocus,
  closeLabel = "Fermer",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  placement?: "side" | "center";
  initialFocus?: RefObject<HTMLElement | null>;
  closeLabel?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const target =
      initialFocus?.current ??
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel;
    target?.focus({ preventScroll: true });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      // Only the top-most sheet reacts (a confirmation opened over a panel).
      const sheets = document.querySelectorAll("[data-sheet]");
      if (sheets[sheets.length - 1] !== panel) return;

      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocus]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        className="absolute inset-0 animate-fade bg-ink/30 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        data-sheet=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "absolute flex max-h-[92dvh] flex-col bg-paper-raised shadow-[0_-20px_60px_-30px_rgba(35,28,24,0.45)] outline-none",
          placement === "side"
            ? "inset-x-0 bottom-0 animate-sheet-up rounded-t-[28px] lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-[460px] lg:animate-sheet-left lg:rounded-none lg:rounded-l-[28px]"
            : "inset-x-0 bottom-0 animate-sheet-up rounded-t-[28px] sm:inset-0 sm:m-auto sm:h-fit sm:w-[440px] sm:animate-pop sm:rounded-[28px]",
        )}
      >
        <div
          className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong/60 lg:hidden"
          aria-hidden="true"
        />
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 sm:px-6 lg:pt-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id={titleId}
              className="font-display text-[28px] leading-tight text-ink"
            >
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-[14px] text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label={closeLabel}
            className="-mr-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-sand hover:text-ink"
          >
            <CloseIcon size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-6">
          {children}
        </div>
        {footer ? (
          <footer className="border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),0.9rem)] sm:px-6">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
