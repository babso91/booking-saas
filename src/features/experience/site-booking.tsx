"use client";

import { motion } from "motion/react";
import { useRef } from "react";

import type { PublicCatalog } from "@/features/catalog/model";
import type { PublicBusiness } from "@/features/public-booking/client/api";
import { PublicBooking } from "@/features/public-booking/components/public-booking";

import { Detail, Display, useEngine } from "./engine/engine";
import { SitePortal, useModal } from "./engine/modal";

/**
 * Booking from her mini-site: the real public booking (useBookingFlow, the
 * public routes; docs/PUBLIC_BOOKING_CONTRACT.md), in a sheet or a page as
 * her site enters it. No second booking engine: the lab's fictional slots
 * are not here. The steps keep the booking's own presentation for now; a
 * universe-styled one will render the same flow.
 */
export function SiteBooking({
  booking,
  initialServiceId,
  onClose,
}: {
  /** null: a design preview, where no booking is ever taken. */
  booking: { business: PublicBusiness; catalog: PublicCatalog } | null;
  initialServiceId?: string;
  onClose: () => void;
}) {
  const { config, motion: language } = useEngine();
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useModal({ root, panel: dialog, onClose });
  const sheet = config.booking === "sheet";
  return (
    <SitePortal rootRef={root}>
      {sheet ? (
        <motion.div
          className="fixed inset-0 z-50 bg-black/45"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
      ) : null}
      <motion.div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Réserver chez ${config.brand.name}`}
        className={
          sheet
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden bg-paper text-ink shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)] outline-none"
            : "fixed inset-0 z-50 flex flex-col bg-paper text-ink outline-none"
        }
        style={
          sheet
            ? {
                borderTopLeftRadius: "max(var(--s-radius), 20px)",
                borderTopRightRadius: "max(var(--s-radius), 20px)",
              }
            : undefined
        }
        initial={sheet ? { y: "100%" } : { opacity: 0 }}
        animate={sheet ? { y: 0 } : { opacity: 1 }}
        exit={sheet ? { y: "100%" } : { opacity: 0 }}
        transition={{ duration: 0.45, ease: language.ease }}
      >
        {/* Her site's colours on the sheet's head: still her place. */}
        <div className="flex items-center justify-between gap-3 bg-[var(--u-paper)] px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3 text-[var(--u-ink-on-paper)]">
          <Display className="truncate text-[20px] leading-none">
            {config.brand.name}
          </Display>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 min-h-11 shrink-0 cursor-pointer px-2"
          >
            <Detail>Fermer ✕</Detail>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pt-5 pb-[max(env(safe-area-inset-bottom),24px)] sm:px-6">
          <div className="mx-auto w-full max-w-xl">
            {booking ? (
              <PublicBooking
                business={booking.business}
                catalog={booking.catalog}
                embedded
                initialServiceId={initialServiceId}
              />
            ) : (
              <p className="text-[15px] text-ink-soft">
                Aperçu du design : la réservation n’est pas ouverte ici. Sur son
                site publié, ce bouton ouvre sa vraie réservation.
              </p>
            )}
          </div>
        </div>
      </motion.div>
    </SitePortal>
  );
}
