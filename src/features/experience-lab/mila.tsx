"use client";

import { AnimatePresence, motion, useScroll, useTransform } from "motion/react";
import { useRef, useState } from "react";

import { Booking, type Booked } from "./booking";
import type { BrandProps } from "./lab";
import { Cover, Photo, euros, minutes } from "./parts";
import { ClientSpace } from "./space";
import type { Service, Work } from "./universes";

// Studio Mila — experimental fashion. Black and white photography, a
// Didone set enormous against the image, monospace captions like a
// lookbook, sharp cuts (no soft fades), and a paper page for the services.

const mono = { fontFamily: "var(--font-mila-mono)" } as const;
const didone = { fontFamily: "var(--font-mila-display)" } as const;
const CUT = [0.76, 0, 0.24, 1] as const;

export function MilaBrand({ universe, onLeave }: BrandProps) {
  const [work, setWork] = useState<Work | null>(null);
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
  const coverScale = useTransform(scrollYProgress, [0, 1], [1, 0.82]);
  const titleY = useTransform(scrollYProgress, [0, 1], ["0%", "-60%"]);
  const wait = universe.motion.scene;

  return (
    <div
      className="min-h-dvh bg-[var(--u-bg)] text-[var(--u-ink)]"
      style={{ fontFamily: "var(--font-mila-body)" }}
    >
      {/* Top bar: always legible over photo and paper (difference blend). */}
      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 mix-blend-difference">
        <div
          className="mx-auto flex max-w-[1100px] items-center justify-between px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3 text-[12px] tracking-[0.08em] text-white uppercase"
          style={mono}
        >
          <button
            type="button"
            onClick={onLeave}
            className="pointer-events-auto cursor-pointer py-2"
          >
            ← Mon espace
          </button>
          <span>Studio Mila</span>
          <button
            type="button"
            onClick={() => setSpace(true)}
            className="pointer-events-auto cursor-pointer py-2"
          >
            Ma carte
          </button>
        </div>
      </header>

      {/* (00) Opening: the cover arrives from the hub, the name cuts in. */}
      <section ref={opening} className="relative h-[115svh]">
        <motion.div
          className="sticky top-0 h-svh overflow-hidden"
          style={{ scale: coverScale }}
        >
          <Cover
            universe={universe}
            priority
            className="h-svh w-full"
            style={{ borderRadius: 0 }}
            imageStyle={{
              filter: "grayscale(1) contrast(1.15) brightness(.82)",
            }}
          />
          <div className="grain pointer-events-none absolute inset-0" />
          {/* Keeps the name legible on light photos. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-[linear-gradient(0deg,rgba(0,0,0,.85),transparent)]" />
          <motion.div
            style={{ y: titleY }}
            className="absolute inset-x-0 bottom-0 px-4 pb-[calc(max(env(safe-area-inset-bottom),14px)+76px)] mix-blend-difference"
          >
            <motion.p
              initial={{ clipPath: "inset(0 100% 0 0)" }}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              transition={{ duration: 0.9, delay: wait, ease: CUT }}
              className="flex justify-between text-[11.5px] tracking-[0.1em] text-white uppercase"
              style={mono}
            >
              <span>Nº 01 — {universe.kind}</span>
              <span>{universe.location}</span>
            </motion.p>
            <h1 className="overflow-hidden text-white" style={didone}>
              <motion.span
                initial={{ y: "105%" }}
                animate={{ y: "0%" }}
                transition={{ duration: 0.9, delay: wait + 0.1, ease: CUT }}
                className="block text-[34vw] leading-[0.78] tracking-[-0.05em] md:text-[26vw]"
              >
                Mila
              </motion.span>
            </h1>
          </motion.div>
        </motion.div>
      </section>

      {/* (01) Manifesto */}
      <section className="relative mx-auto max-w-[1100px] px-5 py-24 md:py-36">
        <p
          className="text-[11.5px] tracking-[0.1em] text-[var(--u-muted)] uppercase"
          style={mono}
        >
          (01) Manifeste
        </p>
        <motion.p
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-15%" }}
          transition={{ duration: 0.8, ease: CUT }}
          className="mt-6 max-w-[18ch] text-[36px] leading-[1.05] tracking-[-0.02em] md:text-[64px]"
          style={didone}
        >
          {universe.intro}
        </motion.p>
      </section>

      {/* (02) Work: an asymmetric lookbook; each photo opens full screen. */}
      <section className="mx-auto max-w-[1100px] px-5 pb-28">
        <div
          className="flex items-baseline justify-between border-t border-[var(--u-line)] pt-4 text-[11.5px] tracking-[0.1em] text-[var(--u-muted)] uppercase"
          style={mono}
        >
          <span>(02) Réalisations</span>
          <span>{String(universe.works.length).padStart(2, "0")}</span>
        </div>
        <ul className="mt-10 grid grid-cols-6 gap-x-3 gap-y-14">
          {universe.works.map((item, index) => {
            const layout = [
              "col-span-6",
              "col-span-4 col-start-3",
              "col-span-5",
              "col-span-3 col-start-4",
              "col-span-6 md:col-span-4 md:col-start-2",
            ][index % 5];
            return (
              <motion.li
                key={item.id}
                className={layout}
                initial={{ clipPath: "inset(12% 0 12% 0)", opacity: 0 }}
                whileInView={{ clipPath: "inset(0% 0 0% 0)", opacity: 1 }}
                viewport={{ once: true, margin: "-10%" }}
                transition={{ duration: 0.8, ease: CUT }}
              >
                <button
                  type="button"
                  onClick={() => setWork(item)}
                  className="block w-full cursor-zoom-in text-left"
                >
                  <motion.div
                    layoutId={`mila-work-${item.id}`}
                    className="relative aspect-[4/5] overflow-hidden"
                    transition={{ duration: 0.6, ease: CUT }}
                  >
                    <Photo
                      id={item.photo}
                      alt={item.title}
                      sizes="(min-width: 768px) 50vw, 90vw"
                      className="absolute inset-0 h-full w-full object-cover"
                      style={{ filter: "grayscale(1) contrast(1.1)" }}
                    />
                  </motion.div>
                  <div className="mt-3 flex items-baseline justify-between gap-3">
                    <span className="text-[22px] leading-none" style={didone}>
                      {item.title}
                    </span>
                    <span
                      className="text-[11px] tracking-[0.08em] text-[var(--u-muted)] uppercase"
                      style={mono}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>
                </button>
              </motion.li>
            );
          })}
        </ul>
      </section>

      {/* (03) Services: the page turns to paper, an index like a price list. */}
      <section className="bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]">
        <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-40">
          <div
            className="flex items-baseline justify-between border-t border-black pt-4 text-[11.5px] tracking-[0.1em] uppercase"
            style={mono}
          >
            <span>(03) Prestations</span>
            <span>Prix TTC</span>
          </div>
          <ServiceIndex
            services={universe.services}
            onBook={(service) => setBooking({ service })}
          />
        </div>
      </section>

      {/* Sticky booking cut, always one tap away. */}
      <motion.div
        initial={{ y: 120 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.6, delay: wait + 0.6, ease: CUT }}
        className="fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(env(safe-area-inset-bottom),14px)]"
      >
        <button
          type="button"
          onClick={() => setBooking({ service: null })}
          className="mx-auto flex h-14 w-full max-w-[520px] cursor-pointer items-center justify-between bg-[var(--u-accent)] px-5 text-[13px] tracking-[0.1em] text-black uppercase"
          style={mono}
        >
          <span>Réserver</span>
          <span>{universe.services.length} soins →</span>
        </button>
      </motion.div>

      <AnimatePresence>
        {work ? (
          <WorkView key={work.id} work={work} onClose={() => setWork(null)} />
        ) : null}
      </AnimatePresence>
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

function ServiceIndex({
  services,
  onBook,
}: {
  services: Service[];
  onBook: (service: Service) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="mt-6">
      {services.map((service, index) => {
        const expanded = open === service.id;
        return (
          <li key={service.id} className="border-b border-black/80">
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : service.id)}
              aria-expanded={expanded}
              className="grid w-full cursor-pointer grid-cols-[2.2rem_1fr_auto] items-baseline gap-x-2 py-5 text-left"
            >
              <span className="text-[11.5px]" style={mono}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="text-[30px] leading-[1.02] tracking-[-0.02em] md:text-[44px]"
                style={didone}
              >
                {service.name}
              </span>
              <span className="text-[13px] tabular-nums" style={mono}>
                {euros(service.priceCents)}
              </span>
            </button>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: "auto" }}
                  exit={{ height: 0 }}
                  transition={{ duration: 0.45, ease: CUT }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-[2.2rem_1fr] gap-x-2 pb-6">
                    <span />
                    <div className="flex flex-col gap-4">
                      <p className="max-w-[40ch] text-[16px] leading-relaxed">
                        {service.blurb}
                      </p>
                      <div
                        className="flex items-center justify-between text-[12px] tracking-[0.08em] uppercase"
                        style={mono}
                      >
                        <span>Durée {minutes(service.durationMinutes)}</span>
                        <button
                          type="button"
                          onClick={() => onBook(service)}
                          className="cursor-pointer bg-black px-4 py-3 text-white"
                        >
                          Réserver ce soin →
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
  );
}

function WorkView({ work, onClose }: { work: Work; onClose: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      initial={{ backgroundColor: "rgba(0,0,0,0)" }}
      animate={{ backgroundColor: "rgba(0,0,0,1)" }}
      exit={{ backgroundColor: "rgba(0,0,0,0)" }}
      role="dialog"
      aria-modal="true"
      aria-label={work.title}
    >
      <motion.div
        layoutId={`mila-work-${work.id}`}
        className="relative flex-1 overflow-hidden"
        transition={{ duration: 0.6, ease: CUT }}
      >
        <Photo
          id={work.photo}
          alt={work.title}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ filter: "grayscale(1) contrast(1.15)" }}
        />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.35 } }}
        exit={{ opacity: 0 }}
        className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 px-5 pb-[max(env(safe-area-inset-bottom),22px)] mix-blend-difference"
      >
        <div>
          <p
            className="text-[48px] leading-none tracking-[-0.03em]"
            style={didone}
          >
            {work.title}
          </p>
          <p
            className="mt-2 text-[12px] tracking-[0.08em] uppercase"
            style={mono}
          >
            {work.note}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer py-2 text-[12px] tracking-[0.1em] uppercase"
          style={mono}
        >
          Fermer ✕
        </button>
      </motion.div>
    </motion.div>
  );
}
