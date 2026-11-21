"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { PublicCatalog } from "@/features/catalog/model";
import {
  fetchPublicBusiness,
  type PublicBusiness,
} from "@/features/public-booking/client/api";
import { PublicBooking } from "@/features/public-booking/components/public-booking";

import { ctaColors } from "./engine/tokens";
import styles from "./site-booking.module.css";
import { Detail, Display, GradedPhoto, useEngine } from "./engine/engine";
import { SitePortal, useModal } from "./engine/modal";

/**
 * Booking from her mini-site: the real public booking (useBookingFlow, the
 * public routes; docs/PUBLIC_BOOKING_CONTRACT.md), in a sheet or a page as
 * her site enters it. Every format shares the same flow. Studio previews
 * can read the current catalogue and slots through the public API.
 */
export function SiteBooking({
  booking,
  initialServiceId,
  initialDate,
  previewSlug,
  onClose,
}: {
  /** null: a design preview, where no booking is ever taken. */
  booking: { business: PublicBusiness; catalog: PublicCatalog } | null;
  initialServiceId?: string;
  /** The day of that service's next slot, when her site showed one. */
  initialDate?: string;
  previewSlug?: string;
  onClose: () => void;
}) {
  const { config, motion: language } = useEngine();
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useModal({ root, panel: dialog, onClose });
  const sheet = config.booking === "sheet";
  const format = config.bookingFormat ?? "classic";
  const themed = format !== "classic";
  const cta = ctaColors(config.tokens, config.tokens.palette.accent);
  const [attempt, setAttempt] = useState(0);
  const [sample, setSample] = useState<{
    slug: string;
    attempt: number;
    data: typeof booking;
  } | null>(null);
  useEffect(() => {
    if (!previewSlug || booking) return;
    const controller = new AbortController();
    void fetchPublicBusiness(previewSlug, controller.signal).then((result) => {
      if (!controller.signal.aborted)
        setSample({
          slug: previewSlug,
          attempt,
          data: result.ok ? result.data : null,
        });
    });
    return () => controller.abort();
  }, [booking, previewSlug, attempt]);
  const loaded =
    sample && sample.slug === previewSlug && sample.attempt === attempt
      ? sample
      : null;
  const source = booking ?? loaded?.data;

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
          (themed ? styles.universe + " " : "") +
          (sheet
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden bg-paper text-ink shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)] outline-none"
            : "fixed inset-0 z-50 flex flex-col bg-paper text-ink outline-none")
        }
        style={
          {
            "--booking-cta": cta.fill,
            "--booking-on-cta": cta.text,
            ...(sheet
              ? {
                  borderTopLeftRadius: "max(var(--s-radius), 20px)",
                  borderTopRightRadius: "max(var(--s-radius), 20px)",
                }
              : {}),
          } as CSSProperties
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
            {previewSlug ? (
              <p className="mb-4 text-sm text-ink-muted">
                Aperçu du parcours · Réservation désactivée
              </p>
            ) : null}
            {source ? (
              <PublicBooking
                business={source.business}
                catalog={source.catalog}
                format={format}
                preview={!booking}
                gallery={
                  format === "showcase" ? <BookingShowcase /> : undefined
                }
                embedded
                initialServiceId={initialServiceId}
                initialDate={initialDate}
              />
            ) : previewSlug ? (
              loaded ? (
                <p role="alert" className="text-sm text-ink-soft">
                  Aperçu des créneaux indisponible.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Réessayer
                  </button>
                </p>
              ) : (
                <p role="status">Chargement du parcours…</p>
              )
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

function BookingShowcase() {
  const { config } = useEngine();
  const works = config.hidden?.includes("work")
    ? []
    : config.content.works.filter((work) => work.photo);
  const intro = config.hidden?.includes("intro") ? null : config.brand.intro;
  if (!works.length && !intro && !config.content.cover) return null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {intro ? (
        <p className="text-base leading-relaxed whitespace-pre-line text-ink-soft">
          {intro}
        </p>
      ) : null}
      {works.length ? (
        <div
          aria-label="Réalisations"
          className="flex snap-x gap-3 overflow-x-auto pb-2"
        >
          {works.map((work) => (
            <figure
              key={work.id}
              className="w-[68%] max-w-64 shrink-0 snap-start"
            >
              <div className="relative aspect-[4/3] overflow-hidden rounded-[var(--s-radius)]">
                <GradedPhoto id={work.photo} alt={work.title} sizes="260px" />
              </div>
              {work.title || work.note ? (
                <figcaption className="mt-2 text-sm text-ink">
                  <strong>{work.title}</strong>
                  {work.note ? (
                    <span className="block text-ink-soft">{work.note}</span>
                  ) : null}
                </figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : config.content.cover ? (
        <div className="relative aspect-[3/1] overflow-hidden rounded-[var(--s-radius)]">
          <GradedPhoto
            id={config.content.cover}
            alt={config.brand.name}
            sizes="600px"
          />
        </div>
      ) : null}
    </div>
  );
}
