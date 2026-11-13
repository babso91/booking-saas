"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import type { PublicCatalog } from "@/features/catalog/model";
import type { PublicBusiness } from "@/features/public-booking/client/api";

import type { ShowcaseGroup } from "./catalog/model";
import type { SiteConfig } from "./engine/config";
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
import { Intro } from "./scenes/intro";
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
  fontClasses,
  edit,
  arrival,
}: {
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
  /** The faces of the universes (fonts.ts), declared on the site's root. */
  fontClasses: string;
  /**
   * She arrived by a link to one service (/b/[slug]?prestation=…): the
   * booking opens on it, or on her catalogue if it is no longer bookable.
   */
  arrival?: { serviceId?: string; serviceGone?: boolean };
}) {
  const [booking, setBooking] = useState<{
    serviceId?: string;
    serviceGone?: boolean;
  } | null>(null);
  // Once, after the page is hers to use: the booking is a client-only
  // sheet (it never opens in the server's HTML).
  const arrived = useRef(arrival);
  useEffect(() => {
    const asked = arrived.current;
    arrived.current = undefined;
    if (asked) setBooking((current) => current ?? asked);
  }, []);
  const siteRoot = useRef<HTMLDivElement>(null);
  const armed = useRevealArming(siteRoot);
  // Her choice of scenes (the opening and her services always show).
  const sections = config.sections.filter(
    (section) => !config.hidden?.includes(section.kind),
  );
  // Chapter numbers of the scenes after the opening: (01), (02)…
  const chapters = sections.map(
    (_, position) =>
      sections.slice(0, position + 1).filter((item) => item.kind !== "opening")
        .length,
  );

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
            book: (service) =>
              setBooking(service ? { serviceId: service.id } : {}),
          }}
        >
          <Header />
          <main>
            {sections.map((section, position) => {
              const chapter = chapters[position]!;
              const key = `${section.kind}-${position}`;
              switch (section.kind) {
                case "opening":
                  return <Opening key={key} variant={section.variant} />;
                case "intro":
                  return (
                    <Intro
                      key={key}
                      variant={section.variant}
                      index={chapter}
                    />
                  );
                case "work":
                  return (
                    <Work key={key} variant={section.variant} index={chapter} />
                  );
                case "portrait":
                  return (
                    <Portrait
                      key={key}
                      variant={section.variant}
                      index={chapter}
                    />
                  );
                case "services":
                  return (
                    <Services
                      key={key}
                      variant={section.variant}
                      index={chapter}
                    />
                  );
              }
            })}
          </main>
          <Footer />
          <QuickBook />
          <AnimatePresence>
            {booking ? (
              <SiteBooking
                key="booking"
                booking={bookable}
                initialServiceId={booking.serviceId}
                linkedServiceGone={booking.serviceGone}
                onClose={() => setBooking(null)}
              />
            ) : null}
          </AnimatePresence>
        </EngineProvider>
      </div>
    </MotionConfig>
  );
}

/**
 * Her name over everything, in white with mix-blend-mode: difference (the
 * site's signature: it inverts whatever passes under it). A name is a
 * logotype (WCAG 1.4.3 exempts it). The "Réserver" action is not: a
 * blended colour cannot be guaranteed on mid tones, so it is a separate,
 * opaque chip in the site's night colours, its ink computed to read.
 */
function Header() {
  const { config, catalog, book } = useEngine();
  const { palette } = config.tokens;
  return (
    <header>
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 text-white mix-blend-difference">
        <div className="mx-auto flex max-w-[1100px] items-center px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
          <Display className="py-2 text-[18px] leading-none">
            {config.brand.name}
          </Display>
        </div>
      </div>
      {catalog.length ? (
        <div
          data-header-action=""
          className="pointer-events-none fixed inset-x-0 top-0 z-40"
        >
          <div className="mx-auto flex max-w-[1100px] justify-end px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
            <button
              type="button"
              onClick={() => book(null)}
              className="pointer-events-auto -mr-1 min-h-11 cursor-pointer px-3 leading-none"
              style={{
                background: palette.bg,
                color: inkOn(palette.bg, palette.ink),
                borderRadius: "min(var(--s-control), 999px)",
              }}
            >
              <Detail>Réserver</Detail>
            </button>
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
      </div>
    </footer>
  );
}

/** Always one tap from booking, as a bar or a pill (mobile first). */
function QuickBook() {
  const { config, catalog, book, motion: language } = useEngine();
  const count = catalog.reduce((sum, group) => sum + group.services.length, 0);
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
          <Detail>Réserver</Detail>
          <Detail>{count > 1 ? `${count} soins →` : "1 soin →"}</Detail>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => book(null)}
          className="pointer-events-auto flex h-14 cursor-pointer items-center gap-3 rounded-full px-7 text-[16px] font-semibold shadow-[0_18px_40px_-14px_rgba(0,0,0,.55)]"
          style={{ background: cta.fill, color: cta.text, boxShadow: outline }}
        >
          Réserver
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
