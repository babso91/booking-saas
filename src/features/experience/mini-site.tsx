"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import type { NextSlotDto } from "@/features/availability/data/slots";
import { bookingLabel } from "@/features/sites/presentation";
import type { PublicCatalog } from "@/features/catalog/model";
import type { PublicBusiness } from "@/features/public-booking/client/api";
import { wallDate } from "@/features/public-booking/client/business-time";

import type { ShowcaseGroup } from "./catalog/model";
import type { Section, SiteConfig } from "./engine/config";
import {
  Detail,
  Display,
  EngineProvider,
  revealVariables,
  useEngine,
  type EngineEdit,
  type PhotoWidth,
} from "./engine/engine";
import revealStyles from "./engine/reveal.module.css";
import {
  contrast,
  cssVariables,
  ctaColors,
  inkOn,
  motions,
} from "./engine/tokens";
import { earliestOf, fromLabel, nextSlotsOf } from "./next-slot";
import { practicalItems, type UsualHours } from "./practical";
import { Intro } from "./scenes/intro";
import { PracticalInfo } from "./scenes/practical-info";
import { ReachLinks } from "./scenes/reach-links";
import { SiteIndex, SiteIndexButton } from "./site-index";
import { sitePages, shownSections } from "./sections";
import { Opening } from "./scenes/opening";
import { Portrait } from "./scenes/portrait";
import { Services } from "./scenes/services";
import { Work } from "./scenes/work";
import { SiteBooking } from "./site-booking";

// Her public mini-site: the engine composing her scenes, in her order, from
// a configuration already seen through her plan's rights and made readable
// (the server page does both: renderedFor, then ensureReadable). Her
// catalogue is the server's public projection; booking is the real one.
// The same view, with `edit`, will be her studio's preview.

export function MiniSite({
  config,
  catalog,
  photoBase,
  photoSource,
  booking: bookable,
  previewSlug,
  openBookingPreviewRef,
  fontClasses,
  edit,
  hours = null,
  reviews,
  nextSlots = null,
}: {
  reviews?: ReactNode;
  config: SiteConfig;
  catalog: ShowcaseGroup[];
  /**
   * Where her photos are served: `${photoBase}/<asset>/<width>` (the public
   * proxy for her clients; the members' preview in her studio).
   */
  photoBase: string;
  /** Her studio's own resolver (demo photos of its preview included). */
  photoSource?: (id: string, width: PhotoWidth) => string;
  /** In her studio: the preview is the editor (a photo opens it). */
  edit?: EngineEdit;
  /**
   * For the real booking (its flow reads these); null in a design preview,
   * where no booking is ever taken.
   */
  booking: { business: PublicBusiness; catalog: PublicCatalog } | null;
  previewSlug?: string;
  openBookingPreviewRef?: Ref<() => void>;
  /** The faces of the universes (fonts.ts), declared on the site's root. */
  fontClasses: string;
  /** Her usual weekly hours (get_public_business_hours), for her infos. */
  hours?: UsualHours[] | null;
  /** Her next slot by service (get_public_next_slots), read with the page. */
  nextSlots?: NextSlotDto[] | null;
}) {
  const [booking, setBooking] = useState<{
    serviceId?: string;
    date?: string;
  } | null>(null);
  const next = nextSlotsOf(nextSlots);
  useImperativeHandle(openBookingPreviewRef, () => () => setBooking({}), []);
  const siteRoot = useRef<HTMLDivElement>(null);
  const armed = useRevealArming(siteRoot);
  const [index, setIndex] = useState(false);
  // Her choice of scenes (the opening and her services always show), the
  // empty ones left out of her public site (sections.ts).
  const sections = shownSections(config, { editing: Boolean(edit) });
  // Publish the practical section only when it has something to show.
  const practical = practicalItems({
    practical: config.practical,
    hours,
    cancellationPolicy: bookable?.business.cancellationPolicy ?? null,
  });
  const pages = sitePages(
    config,
    sections,
    practical.length > 0,
    Boolean(reviews),
  );
  const destinations = pages.flatMap((page) => (page.link ? [page.link] : []));
  const going = useRef<string | null>(null);

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={siteRoot}
        lang="fr"
        data-site-fonts=""
        data-reveal-kind={motions[config.tokens.motion].entrance}
        className={`min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)] ${fontClasses} ${armed ? revealStyles.armed : ""}`}
        style={{
          ...cssVariables(config.tokens),
          ...revealVariables(motions[config.tokens.motion]),
          fontFamily: "var(--t-body)",
        }}
      >
        <EngineProvider
          value={{
            config,
            catalog,
            photos:
              photoSource ??
              ((asset, width) => `${photoBase}/${asset}/${width}`),
            edit,
            book: (service) => {
              // A service with a next slot opens on that day.
              const slot = service ? next[service.id] : undefined;
              setBooking(
                service
                  ? {
                      serviceId: service.id,
                      date: slot ? wallDate(slot.localStartsAt) : undefined,
                    }
                  : {},
              );
            },
            next,
            today: bookable?.business.today,
          }}
        >
          <Header
            index={destinations.length > 1 ? () => setIndex(true) : undefined}
          />
          <main>
            {pages.map(({ kind, link }, position) => {
              const chapter = pages
                .slice(0, position + 1)
                .filter((page) => page.kind !== "opening").length;
              const section = sections.find((item) => item.kind === kind);
              const content =
                kind === "practical" ? (
                  <PracticalInfo items={practical} index={chapter} />
                ) : kind === "reviews" ? (
                  reviews
                ) : section ? (
                  renderScene(section, chapter)
                ) : null;
              return (
                <div
                  key={kind}
                  data-site-section={kind}
                  id={link?.id}
                  tabIndex={link ? -1 : undefined}
                  className="scroll-mt-16 outline-none"
                >
                  {content}
                </div>
              );
            })}
          </main>
          <Footer />
          <QuickBook />
          <AnimatePresence
            onExitComplete={() => {
              const target = going.current
                ? document.getElementById(going.current)
                : null;
              going.current = null;
              if (!target) return;
              const still = window.matchMedia(
                "(prefers-reduced-motion: reduce)",
              ).matches;
              target.scrollIntoView({
                behavior: still ? "auto" : "smooth",
                block: "start",
              });
              target.focus({ preventScroll: true });
            }}
          >
            {index ? (
              <SiteIndex
                key="index"
                destinations={destinations}
                onGo={(id) => {
                  going.current = id;
                  setIndex(false);
                }}
                onBook={() => {
                  setIndex(false);
                  setBooking({});
                }}
                onClose={() => setIndex(false)}
              />
            ) : null}
          </AnimatePresence>
          <AnimatePresence>
            {booking ? (
              <SiteBooking
                key="booking"
                booking={bookable}
                previewSlug={previewSlug}
                initialServiceId={booking.serviceId}
                initialDate={booking.date}
                onClose={() => setBooking(null)}
              />
            ) : null}
          </AnimatePresence>
        </EngineProvider>
      </div>
    </MotionConfig>
  );
}

/** One of her scenes, in its variant, numbered as a chapter. */
function renderScene(section: Section, chapter: number) {
  switch (section.kind) {
    case "opening":
      return <Opening variant={section.variant} />;
    case "intro":
      return <Intro variant={section.variant} index={chapter} />;
    case "work":
      return <Gallery variant={section.variant} chapter={chapter} />;
    case "portrait":
      return <Portrait variant={section.variant} index={chapter} />;
    case "services":
      return <Services variant={section.variant} index={chapter} />;
  }
}

function Gallery({
  variant,
  chapter,
}: {
  variant: Extract<Section, { kind: "work" }>["variant"];
  chapter: number;
}) {
  const engine = useEngine();
  const chosen = engine.config.presentation?.galleryMotion;
  const work = <Work variant={variant} index={chapter} />;
  if (!chosen) return work;
  const config = {
    ...engine.config,
    tokens: { ...engine.config.tokens, motion: chosen },
  };
  return (
    <EngineProvider value={{ ...engine, config }}>
      <div style={revealVariables(motions[chosen])}>{work}</div>
    </EngineProvider>
  );
}

/**
 * Her name over everything, in white with mix-blend-mode: difference (the
 * site's signature: it inverts whatever passes under it). A name is a
 * logotype (WCAG 1.4.3 exempts it). The "Réserver" action is not: a
 * blended colour cannot be guaranteed on mid tones, so it is a separate,
 * opaque chip in the site's night colours, its ink computed to read.
 */
function Header({ index }: { index?: () => void }) {
  const { config, catalog, book, photos } = useEngine();
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const logo =
    config.content.logo && failedLogo !== config.content.logo
      ? config.content.logo
      : null;
  const { palette } = config.tokens;
  const chip = {
    background: palette.bg,
    color: inkOn(palette.bg, palette.ink),
    borderRadius: "min(var(--s-control), 999px)",
  };
  // The name's room: clear of the chips on its right.
  const room =
    config.presentation?.bookingLabel && catalog.length
      ? index
        ? "pr-[calc(min(36vw,14rem)+5rem)]"
        : "pr-[calc(min(36vw,14rem)+2rem)]"
      : catalog.length
        ? index
          ? "pr-44"
          : "pr-32"
        : index
          ? "pr-20"
          : "pr-5";
  return (
    <header>
      <div
        data-blend-logotype=""
        className={`pointer-events-none fixed inset-x-0 top-0 z-40 text-white ${logo ? "" : "mix-blend-difference"}`}
      >
        {/* One line, clear of the "Réserver" chip: a long name ends in an
            ellipsis here (it is set whole on the opening, just below). */}
        <div
          className={`mx-auto flex max-w-[1100px] items-center pt-[max(env(safe-area-inset-top),14px)] pb-3 pl-5 ${room}`}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photos(logo, 480)}
              alt={config.brand.name}
              onError={() => setFailedLogo(logo)}
              className="block h-10 w-auto max-w-[min(31vw,10rem)] object-contain object-left"
            />
          ) : (
            <Display className="min-w-0 truncate py-2 text-[18px] leading-none">
              {config.brand.name}
            </Display>
          )}
        </div>
      </div>
      {catalog.length || index ? (
        <div
          data-header-action=""
          className="pointer-events-none fixed inset-x-0 top-0 z-40"
        >
          <div className="mx-auto flex max-w-[1100px] justify-end gap-2 px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
            {index ? <SiteIndexButton onOpen={index} style={chip} /> : null}
            {catalog.length ? (
              <button
                type="button"
                onClick={() => book(null)}
                className="pointer-events-auto -mr-1 min-h-11 max-w-[min(36vw,14rem)] cursor-pointer truncate px-3 leading-none"
                style={chip}
              >
                <Detail>{bookingLabel(config.presentation)}</Detail>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}

function Footer() {
  const { config } = useEngine();
  return (
    <footer className="bg-[var(--u-bg)] px-5 pt-20 pb-36 text-[var(--u-ink)]">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3 border-t border-[var(--u-line)] pt-6">
        <Display className="text-[40px] leading-none">
          {config.brand.name}
        </Display>
        <span className="text-[var(--u-muted)]">
          <Detail>
            {[config.brand.location, "Réservation en ligne, sans compte"]
              .filter(Boolean)
              .join(" · ")}
          </Detail>
        </span>
        <ReachLinks className="mt-2" />
      </div>
    </footer>
  );
}

/** Always one tap from booking, as a bar or a pill (mobile first). */
function QuickBook() {
  const { config, catalog, book, next, today, motion: language } = useEngine();
  const count = catalog.reduce((sum, group) => sum + group.services.length, 0);
  // Her next availability, whatever the service (Higani point 2).
  const first = next ? earliestOf(next) : null;
  const soon = first && today ? fromLabel(first.localStartsAt, today) : null;
  // Her colour, or the universe's: the accent bar, the white pill.
  const cta = ctaColors(
    config.tokens,
    config.quickBook === "bar" ? config.tokens.palette.accent : "#FFFFFF",
  );
  // A colour close to the night surface gets an outline: still a button.
  const outline =
    contrast(cta.fill, config.tokens.palette.bg) < 1.6
      ? "inset 0 0 0 1.5px currentColor"
      : undefined;
  const [scrolledAway, setScrolledAway] = useState(false);
  // Nothing to book yet: no button that leads nowhere.
  const hidden = scrolledAway || count === 0;

  // Where every service is already a way into booking, the floating
  // button steps aside instead of covering a price or a description.
  useEffect(() => {
    const scenes = document.querySelectorAll("[data-booking-scene]");
    const visible = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        setScrolledAway(visible.size > 0);
      },
      { rootMargin: "-20% 0px -20% 0px" },
    );
    scenes.forEach((scene) => observer.observe(scene));
    return () => observer.disconnect();
  }, [config.sections]);
  return (
    <motion.div
      initial={{ y: 120 }}
      animate={{ y: hidden ? 120 : 0 }}
      aria-hidden={hidden || undefined}
      inert={hidden}
      transition={{
        duration: 0.45,
        delay: hidden ? 0 : 0.2,
        ease: language.ease,
      }}
      className={
        config.quickBook === "bar"
          ? "fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(env(safe-area-inset-bottom),14px)]"
          : "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[max(env(safe-area-inset-bottom),18px)]"
      }
    >
      {config.quickBook === "bar" ? (
        <button
          type="button"
          onClick={() => book(null)}
          className="mx-auto flex h-14 w-full max-w-[520px] cursor-pointer items-center justify-between px-5"
          style={{
            borderRadius: "min(var(--s-control), 18px)",
            background: cta.fill,
            color: cta.text,
            boxShadow: outline,
          }}
        >
          <Detail className="min-w-0 [overflow-wrap:anywhere]">
            {bookingLabel(config.presentation)}
          </Detail>
          <Detail className="shrink-0">
            {soon ? `${soon} →` : count > 1 ? `${count} soins →` : "1 soin →"}
          </Detail>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => book(null)}
          className="pointer-events-auto flex min-h-14 max-w-[calc(100%-2rem)] cursor-pointer items-center gap-3 [overflow-wrap:anywhere] rounded-full px-7 text-[16px] font-semibold shadow-[0_18px_40px_-14px_rgba(0,0,0,.55)]"
          style={{ background: cta.fill, color: cta.text, boxShadow: outline }}
        >
          <span className="flex flex-col items-start leading-tight">
            {bookingLabel(config.presentation)}
            {soon ? (
              <span className="text-[12px] font-normal opacity-80">{soon}</span>
            ) : null}
          </span>
          <span aria-hidden="true">→</span>
        </button>
      )}
    </motion.div>
  );
}

/**
 * Arms the site's reveals (engine/reveal.module.css) once the page runs:
 * after hydration, with IntersectionObserver, motion not reduced. Until
 * then (no JavaScript, slow or failed hydration) everything is visible.
 */
const REDUCED = "(prefers-reduced-motion: reduce)";
function useRevealArming(root: RefObject<HTMLDivElement | null>) {
  const on = useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () =>
      typeof IntersectionObserver === "function" &&
      !window.matchMedia(REDUCED).matches,
    () => false,
  );
  // Before paint: on-screen elements must never be hidden, even a frame.
  useLayoutEffect(() => {
    const site = root.current;
    if (!on || !site) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-revealed", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    const follow = (element: Element) => {
      if (element.hasAttribute("data-revealed")) return;
      const box = element.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) {
        element.setAttribute("data-revealed", "now");
      } else {
        observer.observe(element);
      }
    };
    site.querySelectorAll("[data-reveal]").forEach(follow);
    const added = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches("[data-reveal]")) follow(node);
          node.querySelectorAll("[data-reveal]").forEach(follow);
        });
      }
    });
    added.observe(site, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      added.disconnect();
    };
  }, [on, root]);
  return on;
}
