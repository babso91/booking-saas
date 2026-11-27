"use client";

import { bookingLabel } from "@/features/sites/presentation";

import { motion } from "motion/react";
import { useRef, useState, type CSSProperties } from "react";

import { Detail, Display, useEngine } from "./engine/engine";
import { SitePortal, useModal } from "./engine/modal";
import { circleOf } from "./engine/origin";
import { ReachLinks } from "./scenes/reach-links";
import type { Destination } from "./sections";

// The site's index: from the header, straight to her services, her work,
// her portrait (those that are shown), or to booking. A full-screen sheet
// in her night colours, set like a table of contents, so it reads as part
// of her universe rather than a generic menu.

export function SiteIndexButton({
  onOpen,
  style,
}: {
  onOpen: () => void;
  style: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Sommaire"
      aria-haspopup="dialog"
      className="pointer-events-auto flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
      style={style}
    >
      <svg
        viewBox="0 0 20 20"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M3 7h14M3 13h14" />
      </svg>
    </button>
  );
}

export function SiteIndex({
  from = null,
  destinations,
  onGo,
  onBook,
  onClose,
}: {
  /** Its button: it opens out of it and closes back into it. */
  from?: HTMLElement | null;
  destinations: Destination[];
  /** To a scene, by its anchor (scrolled to once the index has closed). */
  onGo: (id: string) => void;
  onBook: () => void;
  onClose: () => void;
}) {
  const { config, catalog, motion: language } = useEngine();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useModal({ root, panel, initial: first, onClose });
  const bookable = catalog.some((group) => group.services.length > 0);
  const [origin] = useState(() =>
    from?.isConnected && !matchMedia("(prefers-reduced-motion: reduce)").matches
      ? from.getBoundingClientRect()
      : null,
  );

  return (
    <SitePortal rootRef={root}>
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Sommaire"
        tabIndex={-1}
        className="fixed inset-0 flex flex-col overflow-y-auto bg-[var(--u-bg)] text-[var(--u-ink)] outline-none"
        initial={
          origin
            ? { clipPath: circleOf(origin, false) }
            : { opacity: 0, y: -16 }
        }
        animate={
          origin ? { clipPath: circleOf(origin, true) } : { opacity: 1, y: 0 }
        }
        exit={
          origin
            ? { clipPath: circleOf(origin, false) }
            : { opacity: 0, y: -16 }
        }
        transition={{ duration: origin ? 0.42 : 0.35, ease: language.ease }}
      >
        <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3 text-[var(--u-muted)]">
          <Detail>Sommaire</Detail>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 min-h-11 cursor-pointer px-3 text-[var(--u-ink)]"
          >
            <Detail>Fermer</Detail>
          </button>
        </div>
        <nav aria-label="Sommaire" className="mx-auto w-full max-w-[1100px]">
          <ol className="flex flex-col px-5 pt-6 pb-16">
            {destinations.map((destination, position) => (
              <motion.li
                key={destination.id}
                className="border-t border-[var(--u-line)]"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.4,
                  delay: 0.06 * (position + 1),
                  ease: language.ease,
                }}
              >
                <button
                  ref={position === 0 ? first : undefined}
                  type="button"
                  onClick={() => onGo(destination.id)}
                  className="flex w-full cursor-pointer items-baseline gap-4 py-5 text-left"
                >
                  <span className="w-8 shrink-0 text-[var(--u-muted)]">
                    <Detail>{String(position + 1).padStart(2, "0")}</Detail>
                  </span>
                  <Display className="min-w-0 text-[clamp(34px,9vw,64px)] leading-none [overflow-wrap:anywhere]">
                    {destination.label}
                  </Display>
                </button>
              </motion.li>
            ))}
            {bookable ? (
              <motion.li
                className="border-t border-[var(--u-line)]"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.4,
                  delay: 0.06 * (destinations.length + 1),
                  ease: language.ease,
                }}
              >
                <button
                  type="button"
                  onClick={onBook}
                  className="flex w-full cursor-pointer items-baseline gap-4 py-5 text-left"
                >
                  <span className="w-8 shrink-0" aria-hidden="true">
                    <Detail>→</Detail>
                  </span>
                  <Display className="min-w-0 text-[clamp(34px,9vw,64px)] leading-none [overflow-wrap:anywhere]">
                    {bookingLabel(config.presentation)}
                  </Display>
                </button>
              </motion.li>
            ) : null}
          </ol>
        </nav>
        <ReachLinks className="mx-auto w-full max-w-[1100px] px-5 pb-[max(env(safe-area-inset-bottom),40px)]" />
      </motion.div>
    </SitePortal>
  );
}
