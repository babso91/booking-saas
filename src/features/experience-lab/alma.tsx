"use client";

import { AnimatePresence, motion, useScroll, useTransform } from "motion/react";
import { useRef, useState } from "react";

import { Booking, type Booked } from "./booking";
import type { BrandProps } from "./lab";
import { Cover, Photo, euros, minutes } from "./parts";
import { ClientSpace } from "./space";
import type { Service, Work } from "./universes";

// Maison Alma — sensory. Macro textures, arch-shaped frames, images that
// drift slower than the page, words that surface one at a time, a deep
// olive night and a pale sage day. Nothing cuts: everything settles.

const serif = { fontFamily: "var(--font-alma-display)" } as const;
const SETTLE = [0.22, 1, 0.36, 1] as const;
/** The universe's photo grade: soft, warm, a little dim. */
const ALMA_GRADE = "saturate(.55) sepia(.28) contrast(.92) brightness(.88)";

export function AlmaBrand({ universe, onLeave }: BrandProps) {
  const [booking, setBooking] = useState<{ service: Service | null } | null>(
    null,
  );
  const [space, setSpace] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  const opening = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: opening,
    offset: ["start start", "end start"],
  });
  const veil = useTransform(scrollYProgress, [0, 0.8], [0.15, 0.75]);
  const titleY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const wait = universe.motion.scene;
  const words = universe.name.split(" ");

  return (
    <div
      className="min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)]"
      style={{ fontFamily: "var(--font-alma-body)" }}
    >
      <header className="fixed inset-x-0 top-0 z-40">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3 text-[14px] text-[var(--u-ink)]">
          <button
            type="button"
            onClick={onLeave}
            className="cursor-pointer rounded-full bg-[var(--u-bg)]/40 px-3 py-2 backdrop-blur-md"
          >
            ← Mon espace
          </button>
          <button
            type="button"
            onClick={() => setSpace(true)}
            className="cursor-pointer rounded-full bg-[var(--u-bg)]/40 px-3 py-2 backdrop-blur-md"
          >
            Ma carte
          </button>
        </div>
      </header>

      {/* Opening: the cover settles, light slowly blooms, the name surfaces. */}
      <section ref={opening} className="relative h-[120svh]">
        <div className="sticky top-0 h-svh overflow-hidden">
          <Cover
            universe={universe}
            priority
            className="h-svh w-full"
            style={{ borderRadius: 0 }}
            imageStyle={{ filter: "saturate(.8) sepia(.12)" }}
          />
          <motion.div
            className="absolute inset-0 bg-[var(--u-bg)]"
            style={{ opacity: veil }}
          />
          <motion.div
            aria-hidden="true"
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 2.4, delay: wait * 0.6 }}
            style={{
              background:
                "radial-gradient(120% 70% at 50% 110%, rgba(30,38,32,.95) 20%, transparent 70%)",
            }}
          />
          <motion.div
            style={{ y: titleY }}
            className="absolute inset-x-0 bottom-[14svh] px-6 text-center"
          >
            <h1
              className="text-[64px] leading-[0.95] font-light tracking-[-0.02em] md:text-[110px]"
              style={serif}
            >
              {words.map((word, index) => (
                <motion.span
                  key={word}
                  className="inline-block"
                  initial={{ opacity: 0, y: 24, filter: "blur(8px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{
                    duration: 1.6,
                    delay: wait + index * 0.35,
                    ease: SETTLE,
                  }}
                >
                  {word}
                  {index < words.length - 1 ? " " : ""}
                </motion.span>
              ))}
            </h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.4, delay: wait + 1 }}
              className="mt-4 text-[15px] text-[var(--u-ink)]/80"
            >
              {universe.kind} · {universe.location}
            </motion.p>
            <motion.span
              aria-hidden="true"
              className="mx-auto mt-10 block h-12 w-px origin-top bg-[var(--u-ink)]/50"
              initial={{ scaleY: 0 }}
              animate={{ scaleY: [0, 1, 0] }}
              transition={{
                duration: 3,
                delay: wait + 1.6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          </motion.div>
        </div>
      </section>

      {/* Words, line by line. */}
      <section className="mx-auto max-w-[760px] px-6 py-28 md:py-40">
        <p
          className="text-[30px] leading-[1.25] font-light md:text-[44px]"
          style={serif}
        >
          {universe.intro.split(/(?<=[.,])\s/).map((line, index) => (
            <motion.span
              key={index}
              className="block"
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-12%" }}
              transition={{ duration: 1.4, delay: index * 0.25, ease: SETTLE }}
            >
              {line}
            </motion.span>
          ))}
        </p>
      </section>

      {/* Work: arches and windows, each image drifting inside its frame. */}
      <section className="mx-auto max-w-[1100px] px-6 pb-32">
        <p className="text-center text-[15px] text-[var(--u-muted)]">
          Ce que nous faisons
        </p>
        <ul className="mt-12 flex flex-col gap-20 md:grid md:grid-cols-2 md:gap-x-10 md:gap-y-28">
          {universe.works.map((work, index) => (
            <DriftFrame
              key={work.id}
              work={work}
              arch={index % 2 === 0}
              offset={index % 2 === 1}
            />
          ))}
        </ul>
      </section>

      {/* Rituals: the day comes up, a slow horizontal shelf. */}
      <section className="bg-[var(--u-paper)] py-20 text-[var(--u-ink-on-paper)]">
        <div className="mx-auto max-w-[1100px] px-6">
          <h2
            className="text-[40px] leading-none font-light md:text-[64px]"
            style={serif}
          >
            Rituels
          </h2>
          <p className="mt-3 max-w-[38ch] text-[15.5px] leading-relaxed opacity-75">
            Le temps indiqué est le vôtre : on ne le raccourcit pas.
          </p>
        </div>
        <ul className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 [scrollbar-width:none] md:mx-auto md:max-w-[1100px]">
          {universe.services.map((service) => (
            <li
              key={service.id}
              className="w-[78vw] max-w-[340px] shrink-0 snap-center"
            >
              <article className="flex h-full flex-col justify-between gap-10 rounded-[32px] bg-[#F1F3EC] p-6">
                <div>
                  <p className="text-[14px] opacity-65">
                    {minutes(service.durationMinutes)} pour vous
                  </p>
                  <h3
                    className="mt-3 text-[32px] leading-[1.05] font-light"
                    style={serif}
                  >
                    {service.name}
                  </h3>
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
                    onClick={() => setBooking({ service })}
                    className="cursor-pointer rounded-full bg-[var(--u-ink-on-paper)] px-5 py-3 text-[14.5px] text-[var(--u-paper)]"
                  >
                    Réserver
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
        <div className="mx-auto mt-16 max-w-[1100px] px-6 pb-[max(env(safe-area-inset-bottom),12px)] text-center">
          <button
            type="button"
            onClick={() => setBooking({ service: null })}
            className="cursor-pointer rounded-full bg-[var(--u-accent)] px-8 py-4 text-[16px] text-white"
          >
            Choisir un moment
          </button>
        </div>
      </section>

      <AnimatePresence>
        {booking ? (
          <Booking
            key="booking"
            universe={universe}
            initialService={booking.service}
            onClose={() => setBooking(null)}
            onBooked={(value) => setBooked(value)}
            onOpenSpace={() => {
              setBooking(null);
              setSpace(true);
            }}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {space ? (
          <ClientSpace
            key="space"
            universe={universe}
            booked={booked}
            onClose={() => setSpace(false)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** A framed photo whose image drifts slower than the page (depth). */
function DriftFrame({
  work,
  arch,
  offset,
}: {
  work: Work;
  arch: boolean;
  offset: boolean;
}) {
  const frame = useRef<HTMLLIElement>(null);
  const { scrollYProgress } = useScroll({
    target: frame,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], ["-9%", "9%"]);
  return (
    <motion.li
      ref={frame}
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-10%" }}
      transition={{ duration: 1.4, ease: SETTLE }}
      className={offset ? "md:mt-40" : ""}
    >
      <div
        className="relative mx-auto aspect-[3/4] w-[86%] overflow-hidden"
        style={{ borderRadius: arch ? "999px 999px 28px 28px" : 28 }}
      >
        <motion.div className="absolute inset-[-10%]" style={{ y }}>
          <Photo
            id={work.photo}
            alt={work.title}
            sizes="(min-width: 768px) 45vw, 86vw"
            className="h-full w-full object-cover"
            style={{ filter: ALMA_GRADE }}
          />
        </motion.div>
        {/* One grade for every photo, good or ordinary: the brand's light. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[var(--u-accent)] opacity-30 mix-blend-soft-light"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,rgba(30,38,32,.45))]"
        />
      </div>
      <div className="mx-auto mt-5 w-[86%] text-center">
        <p className="text-[24px] font-light" style={serif}>
          {work.title}
        </p>
        <p className="mt-1 text-[14px] text-[var(--u-muted)]">{work.note}</p>
      </div>
    </motion.li>
  );
}
