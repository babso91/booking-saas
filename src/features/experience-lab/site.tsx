"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState } from "react";

import { Booking } from "./booking";
import type { Service, SiteConfig } from "./engine/config";
import { Detail, Display, EngineProvider, useEngine } from "./engine/engine";
import { cssVariables } from "./engine/tokens";
import type { Plan } from "./plans";
import { Intro } from "./scenes/intro";
import { Opening } from "./scenes/opening";
import { Services } from "./scenes/services";
import { Work } from "./scenes/work";
import { Studio } from "./studio";
import { universes, type UniverseId } from "./universes";

// A professional's public mini-site, rendered from her SiteConfig: tokens
// as CSS variables, scenes composed in her order, booking always one tap
// away. The studio edits the same config live.

export function BrandSite({ id }: { id: UniverseId }) {
  const universe = universes[id];
  const [config, setConfig] = useState<SiteConfig>(universe.config);
  const [plan, setPlan] = useState<Plan>("core");
  const [replay, setReplay] = useState(0);

  return (
    <MotionConfig reducedMotion="user">
      <SiteView key={replay} config={config} />
      <Studio
        universe={universe}
        config={config}
        plan={plan}
        onPlan={setPlan}
        onChange={setConfig}
        onReplay={() => setReplay((value) => value + 1)}
      />
    </MotionConfig>
  );
}

export function SiteView({ config }: { config: SiteConfig }) {
  const [booking, setBooking] = useState<{ service: Service | null } | null>(
    null,
  );
  // Chapter numbers of the scenes after the opening: (01), (02)…
  const chapters = config.sections.map(
    (_, position) =>
      config.sections
        .slice(0, position + 1)
        .filter((item) => item.kind !== "opening").length,
  );

  return (
    <div
      className="min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)]"
      style={{ ...cssVariables(config.tokens), fontFamily: "var(--t-body)" }}
    >
      <EngineProvider
        value={{ config, book: (service) => setBooking({ service }) }}
      >
        <Header />
        {config.sections.map((section, position) => {
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
  const { config, book } = useEngine();
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 text-white mix-blend-difference">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
        <Display className="text-[18px] leading-none">
          {config.brand.name}
        </Display>
        <button
          type="button"
          onClick={() => book(null)}
          className="pointer-events-auto cursor-pointer py-2"
        >
          <Detail>Réserver</Detail>
        </button>
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
  const { config, book, motion: language } = useEngine();
  const count = config.content.services.length;
  return (
    <motion.div
      initial={{ y: 120 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.6, delay: 0.9, ease: language.ease }}
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
          className="mx-auto flex h-14 w-full max-w-[520px] cursor-pointer items-center justify-between bg-[var(--u-accent)] px-5 text-[var(--u-on-accent)]"
          style={{ borderRadius: "min(var(--s-control), 18px)" }}
        >
          <Detail>Réserver</Detail>
          <Detail>{count} soins →</Detail>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => book(null)}
          className="pointer-events-auto flex h-14 cursor-pointer items-center gap-3 rounded-full bg-[var(--u-ink)] px-7 text-[16px] text-[var(--u-bg)] shadow-[0_18px_40px_-14px_rgba(0,0,0,.55)]"
        >
          <span
            className="size-2.5 rounded-full bg-[var(--u-accent)]"
            aria-hidden="true"
          />
          Réserver
          <span aria-hidden="true">→</span>
        </button>
      )}
    </motion.div>
  );
}
