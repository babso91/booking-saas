"use client";

import { motion, useReducedMotion } from "motion/react";
import { bookingLabel } from "@/features/sites/presentation";
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
import { FULL_INSET, insetOf } from "./engine/origin";

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
  from = null,
}: {
  /** What it was opened from: as a page, it grows out of it and back. */
  from?: HTMLElement | null;
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
  const backRef = useRef<() => boolean>(null);
  const close = useRef(onClose);
  const leaving = useRef(false);
  const [session] = useState(() => crypto.randomUUID());
  const reduced = useReducedMotion();
  const [origin] = useState(() =>
    from?.isConnected ? from.getBoundingClientRect() : null,
  );
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  function dismiss() {
    if (leaving.current) return;
    leaving.current = true;
    if (window.history.state?.higaniBooking === session) window.history.back();
    close.current();
  }
  function previous() {
    if (!backRef.current?.()) dismiss();
  }
  // One same-page entry while the panel is open. Android Back and the
  // browser arrow follow the same steps as the visible back button.
  useEffect(() => {
    const url = window.location.href;
    const arm = () =>
      window.history.pushState(
        { ...window.history.state, higaniBooking: session },
        "",
        url,
      );
    if (window.history.state?.higaniBooking !== session) arm();
    const back = () => {
      if (
        leaving.current ||
        window.location.href !== url ||
        window.history.state?.higaniBooking === session
      )
        return;
      if (backRef.current?.()) arm();
      else {
        leaving.current = true;
        close.current();
      }
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [session]);

  useModal({ root, panel: dialog, onClose: dismiss });
  const sheet = config.booking === "sheet";
  const enter = reduced ? 0 : origin && !sheet ? 0.42 : 0.28;
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
          onClick={dismiss}
        />
      ) : null}
      <motion.div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${bookingLabel(config.presentation)} chez ${config.brand.name}`}
        className={
          (themed ? styles.universe + " " : "") +
          (sheet
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden bg-paper text-ink shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)] outline-none"
            : "fixed inset-0 z-50 flex flex-col bg-paper text-ink outline-none")
        }
        style={
          {
            ...(sheet && (format === "calendar" || format === "chronological")
              ? { height: "92dvh" }
              : {}),
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
        initial={
          sheet
            ? { y: "100%" }
            : origin && !reduced
              ? { clipPath: insetOf(origin) }
              : { opacity: 0 }
        }
        animate={
          sheet
            ? { y: 0 }
            : origin && !reduced
              ? { clipPath: FULL_INSET }
              : { opacity: 1 }
        }
        exit={{
          ...(sheet
            ? { y: "100%" }
            : origin && !reduced
              ? { clipPath: insetOf(origin) }
              : { opacity: 0 }),
          // Closing is quicker than opening: it answers the tap.
          transition: { duration: enter * 0.65, ease: language.ease },
        }}
        transition={{ duration: enter, ease: language.ease }}
      >
        {/* Her site's colours on the sheet's head: still her place. */}
        <div className="flex shrink-0 items-center justify-between gap-3 bg-[var(--u-paper)] px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3 text-[var(--u-ink-on-paper)]">
          <button
            type="button"
            onClick={previous}
            className="-ml-2 min-h-11 shrink-0 cursor-pointer px-2 text-sm font-semibold"
          >
            ← Retour
          </button>
          <Display className="min-w-0 truncate text-[20px] leading-none">
            {config.brand.name}
          </Display>
          <button
            type="button"
            onClick={dismiss}
            className="-mr-2 min-h-11 shrink-0 cursor-pointer px-2"
          >
            <Detail>{previewSlug ? "Fermer l’aperçu" : "Fermer"} ✕</Detail>
          </button>
        </div>
        <div
          data-booking-scroll=""
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[max(env(safe-area-inset-bottom),24px)] sm:px-6"
        >
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
                backRef={backRef}
                embedded
                initialServiceId={initialServiceId}
                initialDate={initialDate}
                place={config.practical}
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
