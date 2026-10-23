"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import type { ServicesVariant } from "../engine/config";
import {
  Detail,
  Display,
  euros,
  minutes,
  useEngine,
  useReveal,
} from "../engine/engine";

// The services, each one a direct way into booking (no account). Three
// compositions: a price index, a shelf of rituals, colour tiles.

export function Services({
  variant,
  index,
}: {
  variant: ServicesVariant;
  index: number;
}) {
  if (variant === "shelf") return <Shelf />;
  if (variant === "tiles") return <Tiles />;
  return <PriceIndex index={index} />;
}

function PriceIndex({ index }: { index: number }) {
  const { config, book, motion: language } = useEngine();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]">
      <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-40">
        <div className="flex items-baseline justify-between border-t border-current pt-4">
          <Detail>({String(index).padStart(2, "0")}) Prestations</Detail>
          <Detail>Prix TTC</Detail>
        </div>
        <ol className="mt-6">
          {config.content.services.map((service, position) => {
            const expanded = open === service.id;
            return (
              <li key={service.id} className="border-b border-current/80">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : service.id)}
                  aria-expanded={expanded}
                  className="grid w-full cursor-pointer grid-cols-[2.2rem_1fr_auto] items-baseline gap-x-2 py-5 text-left"
                >
                  <Detail>{String(position + 1).padStart(2, "0")}</Detail>
                  <Display className="text-[30px] leading-[1.02] md:text-[44px]">
                    {service.name}
                  </Display>
                  <Detail>{euros(service.priceCents)}</Detail>
                </button>
                <AnimatePresence initial={false}>
                  {expanded ? (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: "auto" }}
                      exit={{ height: 0 }}
                      transition={{ duration: 0.45, ease: language.ease }}
                      className="overflow-hidden"
                    >
                      <div className="grid grid-cols-[2.2rem_1fr] gap-x-2 pb-6">
                        <span />
                        <div className="flex flex-col gap-4">
                          <p className="max-w-[40ch] text-[16px] leading-relaxed">
                            {service.blurb}
                          </p>
                          <div className="flex items-center justify-between gap-3">
                            <Detail>
                              Durée {minutes(service.durationMinutes)}
                            </Detail>
                            <button
                              type="button"
                              onClick={() => book(service)}
                              className="cursor-pointer bg-[var(--u-ink-on-paper)] px-4 py-3 text-[var(--u-paper)]"
                              style={{ borderRadius: "var(--s-control)" }}
                            >
                              <Detail>Réserver ce soin →</Detail>
                            </button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function Shelf() {
  const { config, book } = useEngine();
  const reveal = useReveal();
  return (
    <section className="bg-[var(--u-paper)] pt-20 pb-36 text-[var(--u-ink-on-paper)]">
      <div className="mx-auto max-w-[1100px] px-6">
        <motion.h2
          className="text-[44px] leading-none md:text-[64px]"
          {...reveal()}
        >
          <Display>Rituels</Display>
        </motion.h2>
        <p className="mt-3 max-w-[38ch] text-[15.5px] leading-relaxed opacity-75">
          Le temps indiqué est le vôtre : on ne le raccourcit pas.
        </p>
      </div>
      <ul className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 [scrollbar-width:none] md:mx-auto md:max-w-[1100px]">
        {config.content.services.map((service, position) => (
          <motion.li
            key={service.id}
            className="w-[78vw] max-w-[340px] shrink-0 snap-center"
            {...reveal(position)}
          >
            <article
              className="flex h-full flex-col justify-between gap-10 bg-[color-mix(in_srgb,var(--u-paper)_70%,white)] p-6"
              style={{ borderRadius: "var(--s-radius)" }}
            >
              <div>
                <span className="opacity-65">
                  <Detail>{minutes(service.durationMinutes)} pour vous</Detail>
                </span>
                <Display
                  as="h3"
                  className="mt-3 block text-[32px] leading-[1.05]"
                >
                  {service.name}
                </Display>
                <p className="mt-4 text-[15px] leading-relaxed opacity-80">
                  {service.blurb}
                </p>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[17px] tabular-nums">
                  {euros(service.priceCents)}
                </span>
                <button
                  type="button"
                  onClick={() => book(service)}
                  className="cursor-pointer bg-[var(--u-ink-on-paper)] px-5 py-3 text-[14.5px] text-[var(--u-paper)]"
                  style={{ borderRadius: "var(--s-control)" }}
                >
                  Réserver
                </button>
              </div>
            </article>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

/** Colour tiles: each service a bold block, booked in one tap. */
function Tiles() {
  const { config, book } = useEngine();
  const reveal = useReveal();
  const tones = [
    "bg-[var(--u-accent)] text-[var(--u-on-accent)]",
    "bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]",
    "bg-[var(--u-ink)] text-[var(--u-bg)]",
  ];
  return (
    <section className="bg-[var(--u-bg)] px-3 pt-16 pb-36 text-[var(--u-ink)]">
      <motion.h2
        className="mx-auto max-w-[1100px] px-2 text-[clamp(48px,15vw,140px)] leading-[0.85]"
        {...reveal()}
      >
        <Display>Le menu</Display>
      </motion.h2>
      <ul className="mx-auto mt-8 grid max-w-[1100px] gap-3 md:grid-cols-2">
        {config.content.services.map((service, position) => (
          <motion.li key={service.id} {...reveal(position)}>
            <button
              type="button"
              onClick={() => book(service)}
              className={`group relative flex min-h-[220px] w-full cursor-pointer flex-col justify-between overflow-hidden p-6 text-left ${tones[position % tones.length]}`}
              style={{ borderRadius: "var(--s-radius)" }}
            >
              <span className="flex items-start justify-between gap-4">
                <Detail>{minutes(service.durationMinutes)}</Detail>
                <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-current text-[15px] font-semibold tabular-nums transition-transform duration-300 group-hover:rotate-12">
                  {euros(service.priceCents)}
                </span>
              </span>
              <span>
                <Display className="block text-[40px] leading-[0.9]">
                  {service.name}
                </Display>
                <span className="mt-3 block max-w-[34ch] text-[15px] leading-snug opacity-80">
                  {service.blurb}
                </span>
                <span className="mt-5 inline-block">
                  <Detail>Réserver →</Detail>
                </span>
              </span>
            </button>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
