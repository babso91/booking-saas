"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { Booking } from "./booking";
import { showcase, type Catalog, type CatalogService } from "./catalog/model";
import { pros, type ProId } from "./catalog/pros";
import type { PhotoSlot, SiteConfig } from "./engine/config";
import {
  Detail,
  Display,
  EngineProvider,
  useEngine,
  type EngineEdit,
} from "./engine/engine";
import { contrast, ctaColors, cssVariables } from "./engine/tokens";
import { ensureReadable } from "./engine/harmony";
import { useHistory } from "./history";
import { effective, type Plan } from "./plans";
import { Intro } from "./scenes/intro";
import { Opening } from "./scenes/opening";
import { Portrait } from "./scenes/portrait";
import { Services } from "./scenes/services";
import { Work } from "./scenes/work";
// The studio is the professional's tool, not her customers': it is loaded
// on its own, so a customer's phone never downloads the editors.
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
type Draft = { site: SiteConfig; catalog: Catalog };

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
  };
  const [design, setDesign] = useState<UniverseId>(id);
  const history = useHistory<Draft>(start);
  const part = <K extends keyof Draft>(key: K): Part<Draft[K]> => ({
    value: history.value[key],
    set: (value, mergeKey) =>
      history.set({ ...history.value, [key]: value }, mergeKey),
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  });
  const draft = part("site");
  const catalog = part("catalog");
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
  const [photoSlot, setPhotoSlot] = useState<PhotoSlot | null>(null);
  const [serviceFocus, setServiceFocus] = useState<string | null>(null);
  const [replay, setReplay] = useState(0);

  const universe = universes[design];
  const live = ensureReadable(
    effective(published.config, published.plan, universes[published.design]),
  );
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
          draft.set({
            ...base,
            brand: draft.value.brand,
            content: draft.value.content,
            hidden: draft.value.hidden,
          });
          setDesign(next);
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
      lang="fr"
      className="min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)]"
      style={{ ...cssVariables(config.tokens), fontFamily: "var(--t-body)" }}
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

function Header() {
  const { config, catalog, book } = useEngine();
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 text-white mix-blend-difference">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
        <Display className="text-[18px] leading-none">
          {config.brand.name}
        </Display>
        {catalog.length ? (
          <button
            type="button"
            onClick={() => book(null)}
            className="pointer-events-auto cursor-pointer py-2"
          >
            <Detail>Réserver</Detail>
          </button>
        ) : null}
      </div>
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
