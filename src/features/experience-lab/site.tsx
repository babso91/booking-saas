"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import dynamic from "next/dynamic";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import { Booking } from "./booking";
import { showcase, type Catalog, type CatalogService } from "./catalog/model";
import { pros, type ProId } from "./catalog/pros";
import type { PhotoSlot, SiteConfig } from "./engine/config";
import {
  revealVariables,
  Detail,
  Display,
  EngineProvider,
  useEngine,
  type EngineEdit,
} from "./engine/engine";
import revealStyles from "./engine/reveal.module.css";
import {
  contrast,
  ctaColors,
  cssVariables,
  inkOn,
  motions,
} from "./engine/tokens";
import { useHistory } from "./history";
import { isLocal, releaseLocalPhotos } from "./photos";
import { effective, online, type Plan } from "./plans";
import { Intro } from "./scenes/intro";
import { Opening } from "./scenes/opening";
import { Portrait } from "./scenes/portrait";
import { Services } from "./scenes/services";
import { Work } from "./scenes/work";
// The studio is the professional's tool, not her customers': its code is
// a chunk of its own, mounted (so downloaded) only when "Personnaliser" is
// first used; until then a plain launcher, which warms it on hover/focus.
const loadStudio = () => import("./studio");
const Studio = dynamic(
  () => import("./studio").then((module) => module.Studio),
  {
    ssr: false,
  },
);
import { universes, type UniverseId } from "./universes";

// A professional's public mini-site, rendered from a SiteConfig (her
// design: tokens as CSS variables, scenes composed in her order) and her
// catalogue (her business: categories, services, options), booking always
// one tap away. The two are kept apart: a universe never owns a service.
// In the lab, the studio edits one draft of both live, with one undo; "En
// ligne" shows what her customers see: the published version, through her
// plan's rights and the readability safety net.

export type Published = {
  config: SiteConfig;
  catalog: Catalog;
  design: UniverseId;
  plan: Plan;
  version: number;
  at: Date;
};

/** What the studio edits: her design and her catalogue, side by side. */
type Draft = {
  site: SiteConfig;
  catalog: Catalog;
  /** The universe chosen: in the history, so "Annuler" brings it back. */
  design: UniverseId;
  /**
   * What she typed in amount fields that are not amounts, by field: the
   * catalogue holds NaN there (it blocks publishing); this keeps her text,
   * so undo and redo bring back each state's own entry. Editor state, not
   * business data: never part of the catalogue.
   */
  inputs: Record<string, string>;
};

/** The catalogue's part of the draft, with the raw entries it shows. */
export type CatalogPart = Omit<Part<Catalog>, "set"> & {
  inputs: Record<string, string>;
  /** `entry`: the field's raw text (null once it is a valid amount). */
  set: (
    value: Catalog,
    key?: string,
    entry?: { field: string; raw: string | null },
  ) => void;
};

/** A view of one part of the draft, with the draft's shared undo/redo. */
export type Part<T> = {
  value: T;
  set: (value: T, key?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export function BrandSite({ id, pro }: { id: UniverseId; pro?: ProId }) {
  // A lab demo of another trade: her identity and her catalogue, in any
  // universe (the photos stay the universe's examples).
  const base = universes[id].config;
  const start: Draft = {
    site: pro
      ? {
          ...base,
          brand: pros[pro].brand,
          content: {
            ...base.content,
            portrait: { ...base.content.portrait, ...pros[pro].portrait },
          },
        }
      : base,
    catalog: pro ? pros[pro].catalog : universes[id].catalog,
    design: id,
    inputs: {},
  };
  const history = useHistory<Draft>(start);
  const design = history.value.design;
  const part = <K extends "site" | "catalog">(key: K): Part<Draft[K]> => ({
    value: history.value[key],
    set: (value, mergeKey) =>
      history.set({ ...history.value, [key]: value }, mergeKey),
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  });
  const draft = part("site");
  const catalog: CatalogPart = {
    ...part("catalog"),
    inputs: history.value.inputs,
    set: (value, mergeKey, entry) => {
      const inputs = { ...history.value.inputs };
      if (entry) {
        if (entry.raw === null) delete inputs[entry.field];
        else inputs[entry.field] = entry.raw;
      }
      history.set({ ...history.value, catalog: value, inputs }, mergeKey);
    },
  };
  const [plan, setPlan] = useState<Plan>("core");
  const [published, setPublished] = useState<Published>({
    config: start.site,
    catalog: start.catalog,
    design: id,
    plan: "core",
    version: 1,
    at: new Date(),
  });
  const [view, setView] = useState<"draft" | "live">("draft");
  const [studio, setStudio] = useState(false);
  const [studioLoaded, setStudioLoaded] = useState(false);
  const [photoSlot, setPhotoSlot] = useState<PhotoSlot | null>(null);
  const [serviceFocus, setServiceFocus] = useState<string | null>(null);
  const [replay, setReplay] = useState(0);

  const universe = universes[design];

  // Her own photos (blob: URLs) are released once nothing can show them
  // again: not the draft, not a step of undo/redo, not the published site.
  // This site's own photos (seen in its states), released with it when it
  // goes away (a navigation): its history and publication go with it; a
  // photo of another site still on screen is never touched.
  const { reachable } = history;
  const mine = useRef(new Set<string>());
  useEffect(() => {
    const used = new Set<string>();
    for (const config of [
      ...reachable.map((state) => state.site),
      published.config,
    ]) {
      used.add(config.content.cover);
      used.add(config.content.portrait.photo);
      for (const work of config.content.works) used.add(work.photo);
    }
    for (const id of used) if (isLocal(id)) mine.current.add(id);
    releaseLocalPhotos(used, mine.current);
  }, [reachable, published]);
  useEffect(() => {
    const own = mine.current;
    return () => releaseLocalPhotos(new Set(), own);
  }, []);
  const live = online(published, plan);
  const preview =
    view === "live" ? live : effective(draft.value, plan, universe);
  const editing = studio && view === "draft";

  // The lab keeps everything in this tab's memory (no backend, nothing
  // sent): leaving or reloading after a change asks first, so a test
  // never loses her work by accident.
  const touched = history.canUndo;
  useEffect(() => {
    if (!touched) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [touched]);

  // The service being edited comes into view in the preview, above the
  // studio's sheet.
  useEffect(() => {
    if (!serviceFocus) return;
    document
      .querySelector(`[data-service="${CSS.escape(serviceFocus)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [serviceFocus]);

  return (
    <MotionConfig reducedMotion="user">
      <SiteView
        key={`${replay}-${view}`}
        config={preview}
        catalog={view === "live" ? published.catalog : catalog.value}
        edit={
          editing
            ? {
                photo: (slot) => {
                  setServiceFocus(null);
                  setPhotoSlot(slot);
                },
                selected: photoSlot,
                service: (serviceId) => {
                  setPhotoSlot(null);
                  setServiceFocus(serviceId);
                },
                selectedService: serviceFocus,
              }
            : undefined
        }
      />
      {studioLoaded ? (
        <Studio
          open={studio}
          onOpen={setStudio}
          universe={universe}
          design={design}
          draft={draft}
          catalog={catalog}
          serviceFocus={serviceFocus}
          onServiceFocus={setServiceFocus}
          plan={plan}
          onPlan={setPlan}
          onDesign={(next) => {
            // Another universe: her name, texts and photos follow; her
            // catalogue is not part of the design at all, it stays as is.
            const base = universes[next].config;
            history.set({
              ...history.value,
              site: {
                ...base,
                brand: draft.value.brand,
                content: draft.value.content,
                hidden: draft.value.hidden,
              },
              design: next,
            });
            setReplay((value) => value + 1);
          }}
          published={published}
          onPublish={(config) => {
            setPublished((value) => ({
              config,
              catalog: catalog.value,
              design,
              plan,
              version: value.version + 1,
              at: new Date(),
            }));
          }}
          view={view}
          onView={setView}
          photoSlot={photoSlot}
          onPhotoSlot={setPhotoSlot}
          onReplay={() => setReplay((value) => value + 1)}
        />
      ) : (
        <StudioLauncher
          onOpen={() => {
            setStudioLoaded(true);
            setStudio(true);
          }}
        />
      )}
    </MotionConfig>
  );
}

export function SiteView({
  config,
  catalog,
  edit,
}: {
  config: SiteConfig;
  catalog: Catalog;
  edit?: EngineEdit;
}) {
  const [booking, setBooking] = useState<{
    service: CatalogService | null;
  } | null>(null);
  const groups = showcase(catalog);
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
    <div
      ref={siteRoot}
      lang="fr"
      data-reveal-kind={motions[config.tokens.motion].entrance}
      className={`min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)] ${armed ? revealStyles.armed : ""}`}
      style={{
        ...cssVariables(config.tokens),
        ...revealVariables(motions[config.tokens.motion]),
        fontFamily: "var(--t-body)",
      }}
    >
      <EngineProvider
        value={{
          config,
          catalog: groups,
          book: (service) => setBooking({ service }),
          edit,
        }}
      >
        <Header />
        {sections.map((section, position) => {
          const chapter = chapters[position]!;
          const key = `${section.kind}-${position}`;
          switch (section.kind) {
            case "opening":
              return <Opening key={key} variant={section.variant} />;
            case "intro":
              return (
                <Intro key={key} variant={section.variant} index={chapter} />
              );
            case "work":
              return (
                <Work key={key} variant={section.variant} index={chapter} />
              );
            case "portrait":
              return (
                <Portrait key={key} variant={section.variant} index={chapter} />
              );
            case "services":
              return (
                <Services key={key} variant={section.variant} index={chapter} />
              );
          }
        })}
        <Footer />
        <QuickBook />
        <AnimatePresence>
          {booking ? (
            <Booking
              key="booking"
              initialService={booking.service}
              onClose={() => setBooking(null)}
            />
          ) : null}
        </AnimatePresence>
      </EngineProvider>
    </div>
  );
}

/**
 * Her name over everything, in white with mix-blend-mode: difference (the
 * site's signature: it inverts whatever passes under it). A name is a
 * logotype (WCAG 1.4.3 exempts it). The "Réserver" action is not: a
 * blended colour cannot be guaranteed on mid tones (grey under grey), so
 * it is a separate, opaque chip in the site's night colours, its ink
 * computed to read, readable on whatever scrolls beneath it.
 */
function Header() {
  const { config, catalog, book } = useEngine();
  const { palette } = config.tokens;
  return (
    // A plain <header> (no stacking context of its own): the name's blend
    // still reaches the page beneath it.
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
              className="pointer-events-auto -mr-1 cursor-pointer px-3 py-[7px] leading-none"
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
            {config.brand.location} · Réservation en ligne, sans compte
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
          // On white, the brand's accent unless it would not be readable.
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
 * "Personnaliser" before the studio's code is loaded: the same button, in
 * the system face (no studio font either), loading the studio on intent.
 */
function StudioLauncher({ onOpen }: { onOpen: () => void }) {
  const warm = () => void loadStudio();
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      className="fixed top-14 right-4 z-[45] flex h-11 cursor-pointer items-center gap-2 rounded-full bg-[#141414] px-4 text-[14px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(0,0,0,.6)] ring-1 ring-white/20"
      style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
    >
      <span aria-hidden="true">✎</span>
      Personnaliser
    </button>
  );
}

/**
 * Arms the site's reveals (engine/reveal.module.css) once the page runs:
 * after hydration, with IntersectionObserver, motion not reduced. Until
 * then (no JavaScript, slow or failed hydration) everything is visible.
 * Armed, what is on screen is marked revealed at once (no flash), the
 * rest is revealed as it comes into view; elements added later (her
 * edits, another scene) are followed too.
 */
const REDUCED = "(prefers-reduced-motion: reduce)";
function useRevealArming(root: RefObject<HTMLDivElement | null>) {
  // false on the server and while hydrating (the HTML stays as served),
  // then the browser's answer, following "reduce motion" if it changes.
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
